"""Conversation history per chat_id, stored in SQLite."""

from db import conn

MAX_HISTORY = 40  # messages kept per chat (user+assistant pairs)


def add(chat_id: int, role: str, content):
    """content can be str or list (for tool content blocks — store as-is via repr)."""
    if not isinstance(content, str):
        import json
        content = json.dumps(content)
    with conn() as c:
        c.execute(
            "INSERT INTO conversations (chat_id, role, content) VALUES (?, ?, ?)",
            (chat_id, role, content),
        )


def get(chat_id: int) -> list[dict]:
    import json
    with conn() as c:
        rows = c.execute(
            "SELECT role, content FROM conversations WHERE chat_id=? ORDER BY id DESC LIMIT ?",
            (chat_id, MAX_HISTORY),
        ).fetchall()
    history = []
    for r in reversed(rows):
        content = r["content"]
        try:
            parsed = json.loads(content)
            if isinstance(parsed, (list, dict)):
                content = parsed
        except (json.JSONDecodeError, TypeError):
            pass
        history.append({"role": r["role"], "content": content})
    return history


def clear(chat_id: int):
    with conn() as c:
        c.execute("DELETE FROM conversations WHERE chat_id=?", (chat_id,))
