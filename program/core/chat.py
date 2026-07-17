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


def build_history(chat: ChatStreamRequest, user: AuthUser) -> tuple[list[dict[str, str]], bool]:
    """Persist the incoming user message (unless regenerating), then return
    (model context from the DB, whether this is the session's first exchange)."""
    if chat.regenerate:
        if not storage.get_session(user.user_id, chat.session_id):
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        try:
            storage.ensure_session(user.user_id, chat.session_id, session_title_for(chat.content))
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail="Session id already in use") from exc
        storage.add_message(user.user_id, chat.session_id, "user", chat.content)

    limit = load_config().server.max_history_messages
    history = storage.list_messages(user.user_id, chat.session_id, limit=limit)
    if not history:
        raise HTTPException(status_code=400, detail="Session has no messages")

    user_turns = sum(1 for message in history if message["role"] == "user")
    is_first_exchange = user_turns == 1 and history[-1]["role"] == "user"
    return [{"role": message["role"], "content": message["content"]} for message in history], is_first_exchange


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
    generate_title: bool = False,
) -> AsyncIterator[bytes]:
    """Relay the upstream SSE stream while mirroring the assistant text into the DB."""
    payload = build_payload(chat, messages)
    assistant_content = ""
    buffer = ""
    persisted = False

    def persist() -> None:
        nonlocal persisted
        if not persisted and assistant_content:
            persisted = True
            storage.add_message(user.user_id, chat.session_id, "assistant", assistant_content, model=chat.model)

    try:
        async for chunk in stream_with_fallback(payload, providers):
            buffer += chunk.decode(errors="ignore")
            delta, buffer = extract_content_from_sse_buffer(buffer)
            assistant_content += delta
            yield chunk

        delta, _ = extract_content_from_sse_buffer(buffer + "\n\n")
        buffer = ""
        assistant_content += delta
        persist()

        if generate_title and assistant_content:
            title = await generate_session_title(chat, user, providers, messages[-1]["content"], assistant_content)
            if title:
                yield sse_event("title", {"title": title})
    finally:
        # Persist whatever was generated, including partial output after a
        # client disconnect or mid-stream failure.
        delta, _ = extract_content_from_sse_buffer(buffer + "\n\n")
        assistant_content += delta
        persist()


async def generate_session_title(
    chat: ChatStreamRequest,
    user: AuthUser,
    providers: list[ProviderConfig],
    question: str,
    answer: str,
) -> str | None:
    """Summarize the first exchange into a short session title. Failures are silent."""
    prompt = (
        "用不超过 10 个字概括下面这段对话的主题，直接输出标题本身，"
        "不要引号、句号或任何解释。\n\n"
        f"用户：{question[:500]}\n助手：{answer[:500]}"
    )
    payload = {
        "model": chat.model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "max_tokens": 500,
    }

    for provider in providers:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.post(
                    chat_url(provider),
                    headers={
                        "Authorization": f"Bearer {provider.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
            if response.status_code >= 400:
                continue
            content = (response.json()["choices"][0]["message"].get("content") or "").strip()
            title = content.strip("\"'“”‘’《》").splitlines()[0].strip()[:30] if content else ""
            if title:
                storage.update_session_title(user.user_id, chat.session_id, title)
                return title
        except Exception:
            continue
    return None


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


def sse_event(event: str, data: dict[str, Any]) -> bytes:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n".encode()


def sse_error(message: str) -> bytes:
    return sse_event("error", {"error": {"message": message}})
