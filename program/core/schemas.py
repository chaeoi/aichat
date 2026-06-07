from pydantic import BaseModel, Field, field_validator


class Message(BaseModel):
    role: str
    content: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        if value not in {"system", "user", "assistant"}:
            raise ValueError("role must be system, user, or assistant")
        return value


class ChatRequest(BaseModel):
    provider: str | None = None
    model: str
    messages: list[Message]
    session_id: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, gt=0, le=32000)


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


class SessionCreateRequest(BaseModel):
    id: str | None = None
    title: str = "新对话"
