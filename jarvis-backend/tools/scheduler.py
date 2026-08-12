from datetime import datetime
from db import conn
from tools.notifications import send_telegram


def schedule_message(chat_id: int, message: str, fire_at: str) -> dict:
    """Schedule a message to be sent at a specific datetime (ISO format: 2024-01-15 14:30:00)."""
    try:
        datetime.fromisoformat(fire_at)  # validate
    except ValueError:
        return {"error": f"Invalid datetime format: '{fire_at}'. Use ISO format: YYYY-MM-DD HH:MM:SS"}
    with conn() as c:
        cur = c.execute(
            "INSERT INTO scheduled_messages (chat_id, message, fire_at) VALUES (?, ?, ?)",
            (chat_id, message, fire_at),
        )
    return {"success": True, "scheduled_id": cur.lastrowid, "fire_at": fire_at}


def list_scheduled(chat_id: int) -> dict:
    with conn() as c:
        rows = c.execute(
            "SELECT id, message, fire_at, sent FROM scheduled_messages WHERE chat_id=? AND sent=0 ORDER BY fire_at",
            (chat_id,),
        ).fetchall()
    return {"scheduled": [dict(r) for r in rows], "count": len(rows)}


def cancel_scheduled(scheduled_id: int) -> dict:
    with conn() as c:
        c.execute("DELETE FROM scheduled_messages WHERE id=?", (scheduled_id,))
    return {"success": True, "cancelled_id": scheduled_id}


def check_and_send_due(now: datetime = None) -> int:
    """Called by the scheduler loop. Returns count of messages sent."""
    now = now or datetime.now()
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    with conn() as c:
        due = c.execute(
            "SELECT id, chat_id, message FROM scheduled_messages WHERE fire_at <= ? AND sent=0",
            (now_str,),
        ).fetchall()
        for row in due:
            send_telegram(row["chat_id"], row["message"])
            c.execute("UPDATE scheduled_messages SET sent=1 WHERE id=?", (row["id"],))
    return len(due)
