from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from . import storage
from .auth import create_jwt, require_user, validate_access_key
from .chat import available_models, build_history, persistent_stream, providers_for_model
from .config import load_config
from .schemas import AuthUser, ChatStreamRequest, LoginRequest, LoginResponse, SessionUpdateRequest


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


@app.get("/api/sessions/{session_id}")
async def session_detail(session_id: str, user: AuthUser = Depends(require_user)) -> dict[str, Any]:
    session = storage.get_session(user.user_id, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session": session, "messages": storage.list_messages(user.user_id, session_id)}


@app.patch("/api/sessions/{session_id}")
async def rename_session(
    session_id: str,
    update: SessionUpdateRequest,
    user: AuthUser = Depends(require_user),
) -> dict[str, Any]:
    session = storage.update_session_title(user.user_id, session_id, update.title.strip())
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session": session}


@app.delete("/api/sessions/{session_id}")
async def remove_session(session_id: str, user: AuthUser = Depends(require_user)) -> dict[str, str]:
    storage.delete_session(user.user_id, session_id)
    return {"status": "ok"}


@app.post("/api/chat/stream")
async def chat_stream(chat: ChatStreamRequest, user: AuthUser = Depends(require_user)) -> StreamingResponse:
    providers = providers_for_model(chat.model, chat.provider)
    messages = build_history(chat, user)
    return StreamingResponse(
        persistent_stream(chat, user, providers, messages),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
