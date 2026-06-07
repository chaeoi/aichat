import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, HttpUrl, ValidationError, field_validator, model_validator


class ServerConfig(BaseModel):
    access_keys: list[str] = Field(default_factory=list)
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])
    jwt_secret: str | None = None
    jwt_expires_minutes: int = Field(default=60 * 24 * 30, gt=0)
    data_path: str = "data/chat.db"

    @field_validator("access_keys")
    @classmethod
    def validate_access_keys(cls, value: list[str]) -> list[str]:
        keys = [item.strip() for item in value if item and item.strip()]
        if not keys:
            raise ValueError("server.access_keys must contain at least one key")
        return keys


class ProviderConfig(BaseModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]+$")
    name: str
    base_url: HttpUrl
    api_key: str
    models: list[str]
    default_model: str | None = None

    @field_validator("api_key")
    @classmethod
    def validate_api_key(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("provider api_key cannot be empty")
        return value.strip()

    @field_validator("models")
    @classmethod
    def validate_models(cls, value: list[str]) -> list[str]:
        models = [item.strip() for item in value if item and item.strip()]
        if not models:
            raise ValueError("provider models must contain at least one model")
        return models

    @model_validator(mode="after")
    def validate_default_model(self) -> "ProviderConfig":
        if self.default_model and self.default_model not in self.models:
            raise ValueError("provider default_model must be listed in models")
        return self


class AppConfig(BaseModel):
    server: ServerConfig
    providers: list[ProviderConfig]

    @field_validator("providers")
    @classmethod
    def validate_providers(cls, value: list[ProviderConfig]) -> list[ProviderConfig]:
        if not value:
            raise ValueError("providers must contain at least one provider")
        ids = [provider.id for provider in value]
        if len(ids) != len(set(ids)):
            raise ValueError("provider ids must be unique")
        return value


def _apply_env_overrides(raw: dict[str, Any]) -> dict[str, Any]:
    access_keys = os.getenv("ACCESS_KEYS")
    if access_keys:
        raw.setdefault("server", {})["access_keys"] = [
            item.strip() for item in access_keys.split(",") if item.strip()
        ]

    cors_origins = os.getenv("CORS_ORIGINS")
    if cors_origins:
        raw.setdefault("server", {})["cors_origins"] = [
            item.strip() for item in cors_origins.split(",") if item.strip()
        ]

    jwt_secret = os.getenv("JWT_SECRET")
    if jwt_secret:
        raw.setdefault("server", {})["jwt_secret"] = jwt_secret.strip()

    jwt_expires_minutes = os.getenv("JWT_EXPIRES_MINUTES")
    if jwt_expires_minutes:
        raw.setdefault("server", {})["jwt_expires_minutes"] = int(jwt_expires_minutes)

    data_path = os.getenv("DATA_PATH")
    if data_path:
        raw.setdefault("server", {})["data_path"] = data_path.strip()

    return raw


@lru_cache
def load_config() -> AppConfig:
    config_path = Path(os.getenv("CONFIG_PATH", "config.yaml"))
    if not config_path.exists():
        raise RuntimeError(f"Config file not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as file:
        raw = yaml.safe_load(file) or {}

    try:
        return AppConfig.model_validate(_apply_env_overrides(raw))
    except ValidationError as exc:
        raise RuntimeError(f"Invalid config file {config_path}: {exc}") from exc


def get_provider(provider_id: str) -> ProviderConfig | None:
    for provider in load_config().providers:
        if provider.id == provider_id:
            return provider
    return None
