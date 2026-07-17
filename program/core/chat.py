import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import HTTPException

from . import storage
from .config import ProviderConfig, load_config
from .schemas import AuthUser, ChatStreamRequest

DEFAULT_TITLE = "新对话"


def available_models() -> list[str]:
    models: list[str] = []
    for provider in load_config().providers:
        for model in provider.models:
            if model not in models:
                models.append(model)
    return models


def providers_for_model(model: str, provider_id: str | None) -> list[ProviderConfig]:
    providers = load_config().providers

    if provider_id:
        matches = [provider for provider in providers if provider.id == provider_id]
        if not matches:
            raise HTTPException(status_code=404, detail="Provider not found")
        if model not in matches[0].models:
            raise HTTPException(status_code=400, detail="Model is not allowed for provider")
        return matches

    matches = [provider for provider in providers if model in provider.models]
    if not matches:
        raise HTTPException(status_code=404, detail="No provider serves this model")
    return matches


def session_title_for(content: str) -> str:
    title = content.strip().splitlines()[0][:30].strip()
    return title or DEFAULT_TITLE


def build_history(chat: ChatStreamRequest, user: AuthUser) -> list[dict[str, str]]:
    """Persist the incoming user message, then return the model context from the DB."""
    try:
        storage.ensure_session(user.user_id, chat.session_id, session_title_for(chat.content))
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail="Session id already in use") from exc

    storage.add_message(user.user_id, chat.session_id, "user", chat.content)

    limit = load_config().server.max_history_messages
    history = storage.list_messages(user.user_id, chat.session_id, limit=limit)
    return [{"role": message["role"], "content": message["content"]} for message in history]


def build_payload(chat: ChatStreamRequest, messages: list[dict[str, str]]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": chat.model,
        "messages": messages,
        "stream": True,
    }
    if chat.temperature is not None:
        payload["temperature"] = chat.temperature
    if chat.max_tokens:
        payload["max_tokens"] = chat.max_tokens
    return payload


def chat_url(provider: ProviderConfig) -> str:
    return str(provider.base_url).rstrip("/") + "/chat/completions"


def provider_error(provider: ProviderConfig, exc: Exception) -> str:
    return f"{provider.name}: {exc}"


async def stream_provider(payload: dict[str, Any], provider: ProviderConfig) -> AsyncIterator[bytes]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=15)) as client:
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
                message = body.decode(errors="replace").replace("\n", " ")[:500]
                raise RuntimeError(f"HTTP {response.status_code}: {message}")

            async for chunk in response.aiter_bytes():
                yield chunk


async def stream_with_fallback(
    payload: dict[str, Any],
    providers: list[ProviderConfig],
) -> AsyncIterator[bytes]:
    errors: list[str] = []

    for provider in providers:
        yielded = False
        try:
            async for chunk in stream_provider(payload, provider):
                yielded = True
                yield chunk
            return
        except Exception as exc:
            if yielded:
                # The stream broke mid-response; a fallback would restart the answer.
                yield sse_error(f"{provider.name}: 上游流中断: {exc}")
                return
            errors.append(provider_error(provider, exc))

    yield sse_error(f"所有 provider 均失败: {'; '.join(errors)}")


async def persistent_stream(
    chat: ChatStreamRequest,
    user: AuthUser,
    providers: list[ProviderConfig],
    messages: list[dict[str, str]],
) -> AsyncIterator[bytes]:
    """Relay the upstream SSE stream while mirroring the assistant text into the DB."""
    payload = build_payload(chat, messages)
    assistant_content = ""
    buffer = ""

    try:
        async for chunk in stream_with_fallback(payload, providers):
            buffer += chunk.decode(errors="ignore")
            delta, buffer = extract_content_from_sse_buffer(buffer)
            assistant_content += delta
            yield chunk
    finally:
        # Persist whatever was generated, including partial output after a
        # client disconnect or mid-stream failure.
        delta, _ = extract_content_from_sse_buffer(buffer + "\n\n")
        assistant_content += delta
        if assistant_content:
            storage.add_message(user.user_id, chat.session_id, "assistant", assistant_content, model=chat.model)


def extract_content_from_sse_buffer(buffer: str) -> tuple[str, str]:
    events = buffer.replace("\r\n", "\n").split("\n\n")
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

    choices = parsed.get("choices") or [{}]
    choice = choices[0] if choices else {}
    delta = (choice.get("delta") or {}).get("content") or ""
    message = (choice.get("message") or {}).get("content") or ""
    return delta + message


def sse_error(message: str) -> bytes:
    payload = json.dumps({"error": {"message": message}}, ensure_ascii=False)
    return f"event: error\ndata: {payload}\n\n".encode()
