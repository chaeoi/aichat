import json
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any

import httpx
from fastapi import HTTPException

from . import storage
from .config import ProviderConfig, load_config
from .schemas import AuthUser, ChatRequest


def available_models() -> list[str]:
    models: list[str] = []
    for provider in load_config().providers:
        for model in provider.models:
            if model not in models:
                models.append(model)
    return models


def providers_for_chat(chat: ChatRequest) -> list[ProviderConfig]:
    providers = load_config().providers

    if chat.provider:
        matches = [provider for provider in providers if provider.id == chat.provider]
        if not matches:
            raise HTTPException(status_code=404, detail="Provider not found")
        if chat.model not in matches[0].models:
            raise HTTPException(status_code=400, detail="Model is not allowed for provider")
        return matches

    matches = [provider for provider in providers if chat.model in provider.models]
    if not matches:
        raise HTTPException(status_code=404, detail="Provider not found")
    return matches


def build_payload(chat: ChatRequest, model: str, stream: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": [message.model_dump() for message in chat.messages],
        "stream": stream,
    }
    if chat.temperature is not None:
        payload["temperature"] = chat.temperature
    if chat.max_tokens:
        payload["max_tokens"] = chat.max_tokens
    return payload


def chat_url(provider: ProviderConfig) -> str:
    return str(provider.base_url).rstrip("/") + "/chat/completions"


def provider_error(provider: ProviderConfig, exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        detail = exc.detail
    else:
        detail = str(exc)
    return f"{provider.name}: {detail}"


async def request_completion(chat: ChatRequest, provider: ProviderConfig) -> dict[str, Any]:
    payload = build_payload(chat, chat.model, stream=False)

    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            chat_url(provider),
            headers={
                "Authorization": f"Bearer {provider.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    return response.json()


async def request_completion_with_fallback(
    chat: ChatRequest,
    providers: list[ProviderConfig],
) -> dict[str, Any]:
    errors: list[str] = []

    for provider in providers:
        try:
            return await request_completion(chat, provider)
        except (HTTPException, httpx.HTTPError) as exc:
            errors.append(provider_error(provider, exc))

    raise HTTPException(status_code=502, detail=f"All providers failed: {'; '.join(errors)}")


async def stream_provider(chat: ChatRequest, provider: ProviderConfig) -> AsyncIterator[bytes]:
    payload = build_payload(chat, chat.model, stream=True)

    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            chat_url(provider),
            headers={
                "Authorization": f"Bearer {provider.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        ) as response:
            if response.status_code >= 400:
                body = await response.aread()
                message = body.decode(errors="replace").replace("\n", " ")
                raise RuntimeError(message)

            async for chunk in response.aiter_bytes():
                yield chunk


async def stream_with_fallback(
    chat: ChatRequest,
    providers: list[ProviderConfig],
) -> AsyncIterator[bytes]:
    errors: list[str] = []

    for provider in providers:
        yielded = False
        try:
            async for chunk in stream_provider(chat, provider):
                yielded = True
                yield chunk
            return
        except (RuntimeError, httpx.HTTPError) as exc:
            if yielded:
                message = f"{provider.name}: upstream stream interrupted: {exc}"
                yield sse_error(message)
                return
            errors.append(provider_error(provider, exc))

    yield sse_error(f"All providers failed: {'; '.join(errors)}")


async def persistent_stream(
    chat: ChatRequest,
    user: AuthUser,
    providers: list[ProviderConfig],
) -> AsyncIterator[bytes]:
    assistant_content = ""
    buffer = ""

    async for chunk in stream_with_fallback(chat, providers):
        text = chunk.decode(errors="ignore")
        buffer += text
        delta, buffer = extract_content_from_sse_buffer(buffer)
        assistant_content += delta
        yield chunk

    delta, _ = extract_content_from_sse_buffer(buffer + "\n\n")
    assistant_content += delta

    if chat.session_id and assistant_content:
        storage.add_message(user.user_id, chat.session_id, "assistant", assistant_content)


def persist_user_message(chat: ChatRequest, user: AuthUser) -> None:
    if not chat.session_id or not chat.messages:
        return

    title = "新对话"
    first_user_message = next((message.content for message in chat.messages if message.role == "user"), "")
    if first_user_message:
        title = first_user_message[:28]

    session = storage.ensure_session(user.user_id, chat.session_id, title)
    latest_user_message = next((message for message in reversed(chat.messages) if message.role == "user"), None)
    if latest_user_message:
        storage.add_message(user.user_id, chat.session_id, "user", latest_user_message.content)
        if session["title"] == "新对话":
            storage.update_session_title(user.user_id, chat.session_id, latest_user_message.content[:28])


def persist_completion(chat: ChatRequest, user: AuthUser, data: dict[str, Any]) -> None:
    if not chat.session_id:
        return
    persist_user_message(chat, user)
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if content:
        storage.add_message(user.user_id, chat.session_id, "assistant", content)


def create_session_id(user_id: str) -> str:
    return sha256(f"{user_id}:{datetime.now(timezone.utc)}".encode()).hexdigest()


def extract_content_from_sse_buffer(buffer: str) -> tuple[str, str]:
    events = buffer.split("\n\n")
    remainder = events.pop() or ""
    content = ""

    for event_text in events:
        for line in event_text.splitlines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            content += extract_content_from_sse_data(data)

    return content, remainder


def extract_content_from_sse_data(data: str) -> str:
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        return ""

    choice = parsed.get("choices", [{}])[0]
    delta = choice.get("delta", {}).get("content", "")
    message = choice.get("message", {}).get("content", "")
    return delta + message


def sse_error(message: str) -> bytes:
    payload = json.dumps({"error": {"message": message}}, ensure_ascii=False)
    return f"event: error\ndata: {payload}\n\n".encode()
