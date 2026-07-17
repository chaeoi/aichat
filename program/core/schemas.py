from pydantic import BaseModel, Field, model_validator


class ChatStreamRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    content: str | None = Field(default=None, max_length=100_000)
    model: str = Field(min_length=1)
    provider: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, gt=0, le=128_000)
    # regenerate=True 时不追加新用户消息，直接基于现有历史重新生成回复。
    regenerate: bool = False

    @model_validator(mode="after")
    def validate_content(self) -> "ChatStreamRequest":
        if not self.regenerate and not (self.content and self.content.strip()):
            raise ValueError("content is required unless regenerate is true")
        return self


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
