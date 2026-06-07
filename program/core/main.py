from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from . import storage
from .auth import create_jwt, require_user, validate_access_key
from .chat import (
    available_models,
    create_session_id,
    persist_completion,
    persist_user_message,
    persistent_stream,
    providers_for_chat,
    request_completion_with_fallback,
)
from .config import load_config
from .schemas import AuthUser, ChatRequest, LoginRequest, LoginResponse, SessionCreateRequest


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    storage.init_db()
    yield


def create_app() -> FastAPI:
    config = load_config()
    app = FastAPI(title="AI Chat API", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.server.cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    return app


app = create_app()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
async def login(login_request: LoginRequest) -> LoginResponse:
    access_key = validate_access_key(login_request.access_key)
    return create_jwt(access_key)


@app.get("/api/auth/me")
async def me(user: AuthUser = Depends(require_user)) -> dict[str, str]:
    return {"user_id": user.user_id, "auth_type": user.auth_type}


@app.get("/api/providers", dependencies=[Depends(require_user)])
async def providers() -> dict[str, Any]:
    config = load_config()
    return {
        "models": available_models(),
        "providers": [
            {
                "id": provider.id,
                "name": provider.name,
                "models": provider.models,
                "default_model": provider.default_model or provider.models[0],
            }
            for provider in config.providers
        ],
    }


@app.get("/api/sessions")
async def sessions(user: AuthUser = Depends(require_user)) -> dict[str, Any]:
    return {"sessions": storage.list_sessions(user.user_id)}


@app.post("/api/sessions")
async def create_chat_session(
    session_request: SessionCreateRequest,
    user: AuthUser = Depends(require_user),
) -> dict[str, Any]:
    session_id = session_request.id or create_session_id(user.user_id)
    session = storage.create_session(user.user_id, session_id, session_request.title.strip() or "新对话")
    return {"session": session}


@app.get("/api/sessions/{session_id}")
async def session_detail(session_id: str, user: AuthUser = Depends(require_user)) -> dict[str, Any]:
    session = storage.get_session(user.user_id, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session": session, "messages": storage.list_messages(user.user_id, session_id)}


@app.delete("/api/sessions/{session_id}")
async def remove_session(session_id: str, user: AuthUser = Depends(require_user)) -> dict[str, str]:
    storage.delete_session(user.user_id, session_id)
    return {"status": "ok"}


@app.post("/api/chat/completions")
async def chat_completion(chat: ChatRequest, user: AuthUser = Depends(require_user)) -> dict[str, Any]:
    providers = providers_for_chat(chat)
    data = await request_completion_with_fallback(chat, providers)
    persist_completion(chat, user, data)
    return data


@app.post("/api/chat/stream")
async def chat_stream(chat: ChatRequest, user: AuthUser = Depends(require_user)) -> StreamingResponse:
    providers = providers_for_chat(chat)
    persist_user_message(chat, user)
    return StreamingResponse(persistent_stream(chat, user, providers), media_type="text/event-stream")
