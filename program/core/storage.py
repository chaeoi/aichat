import sqlite3
import time
from pathlib import Path
from typing import Any

from .config import load_config


def db_path() -> Path:
    path = Path(load_config().server.data_path)
    if not path.is_absolute():
        path = Path.cwd() / path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(db_path())
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    with connect() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
                ON sessions(user_id, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_messages_session_id
                ON messages(session_id, id);
            """
        )


def now_ms() -> int:
    return int(time.time() * 1000)


def row_to_session(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def row_to_message(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "createdAt": row["created_at"],
    }


def list_sessions(user_id: str) -> list[dict[str, Any]]:
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT id, title, created_at, updated_at
            FROM sessions
            WHERE user_id = ?
            ORDER BY updated_at DESC
            """,
            (user_id,),
        ).fetchall()
    return [row_to_session(row) for row in rows]


def create_session(user_id: str, session_id: str, title: str = "新对话") -> dict[str, Any]:
    timestamp = now_ms()
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO sessions (id, user_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (session_id, user_id, title, timestamp, timestamp),
        )
        row = connection.execute(
            "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ? AND user_id = ?",
            (session_id, user_id),
        ).fetchone()
    return row_to_session(row)


def get_session(user_id: str, session_id: str) -> dict[str, Any] | None:
    with connect() as connection:
        row = connection.execute(
            """
            SELECT id, title, created_at, updated_at
            FROM sessions
            WHERE id = ? AND user_id = ?
            """,
            (session_id, user_id),
        ).fetchone()
    return row_to_session(row) if row else None


def ensure_session(user_id: str, session_id: str, title: str = "新对话") -> dict[str, Any]:
    session = get_session(user_id, session_id)
    if session:
        return session
    return create_session(user_id, session_id, title)


def list_messages(user_id: str, session_id: str) -> list[dict[str, Any]]:
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT messages.id, messages.role, messages.content, messages.created_at
            FROM messages
            INNER JOIN sessions ON sessions.id = messages.session_id
            WHERE sessions.id = ? AND sessions.user_id = ?
            ORDER BY messages.id ASC
            """,
            (session_id, user_id),
        ).fetchall()
    return [row_to_message(row) for row in rows]


def add_message(user_id: str, session_id: str, role: str, content: str) -> dict[str, Any]:
    timestamp = now_ms()
    with connect() as connection:
        exists = connection.execute(
            "SELECT 1 FROM sessions WHERE id = ? AND user_id = ?",
            (session_id, user_id),
        ).fetchone()
        if not exists:
            raise ValueError("Session not found")

        cursor = connection.execute(
            """
            INSERT INTO messages (session_id, role, content, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, role, content, timestamp),
        )
        connection.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ? AND user_id = ?",
            (timestamp, session_id, user_id),
        )
        row = connection.execute(
            "SELECT id, role, content, created_at FROM messages WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return row_to_message(row)


def update_session_title(user_id: str, session_id: str, title: str) -> None:
    timestamp = now_ms()
    with connect() as connection:
        connection.execute(
            """
            UPDATE sessions
            SET title = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (title, timestamp, session_id, user_id),
        )


def delete_session(user_id: str, session_id: str) -> None:
    with connect() as connection:
        connection.execute(
            "DELETE FROM sessions WHERE id = ? AND user_id = ?",
            (session_id, user_id),
        )
