from datetime import datetime, timedelta, timezone
from hashlib import sha256

import jwt
from fastapi import HTTPException, Request, status
from jwt import InvalidTokenError

from .config import AppConfig, load_config
from .schemas import AuthUser, LoginResponse


JWT_ALGORITHM = "HS256"


def jwt_secret(config: AppConfig) -> str:
    if config.server.jwt_secret:
        return config.server.jwt_secret

    material = "\n".join(config.server.access_keys)
    return sha256(f"chat-api-jwt:{material}".encode()).hexdigest()


def user_id_for_key(access_key: str) -> str:
    return sha256(access_key.encode()).hexdigest()[:16]


def create_jwt(access_key: str) -> LoginResponse:
    config = load_config()
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=config.server.jwt_expires_minutes)
    user_id = user_id_for_key(access_key)
    payload = {"sub": user_id, "iat": now, "exp": expires_at}
    token = jwt.encode(payload, jwt_secret(config), algorithm=JWT_ALGORITHM)
    return LoginResponse(token=token, expires_at=expires_at.isoformat(), user_id=user_id)


def require_user(request: Request) -> AuthUser:
    config = load_config()
    auth_header = request.headers.get("authorization", "")
    scheme, _, token = auth_header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
        )

    try:
        payload = jwt.decode(token, jwt_secret(config), algorithms=[JWT_ALGORITHM])
        subject = payload.get("sub")
        if isinstance(subject, str) and subject:
            return AuthUser(user_id=subject, auth_type="jwt")
    except InvalidTokenError:
        pass

    # Backward compatibility for direct Bearer access key clients.
    if token in config.server.access_keys:
        return AuthUser(user_id=user_id_for_key(token), auth_type="access_key")

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Invalid or expired token",
    )


def validate_access_key(access_key: str) -> str:
    token = access_key.strip()
    if not token or token not in load_config().server.access_keys:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid access key",
        )
    return token
