from pydantic import BaseModel, Field


class ChatStreamRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    content: str = Field(min_length=1, max_length=100_000)
    model: str = Field(min_length=1)
    provider: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, gt=0, le=128_000)


class SessionUpdateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=100)


class LoginRequest(BaseModel):
    access_key: str


class LoginResponse(BaseModel):
    token: str
    token_type: str = "bearer"
    expires_at: str
    user_id: str


class AuthUser(BaseModel):
    user_id: str
    auth_type: str
