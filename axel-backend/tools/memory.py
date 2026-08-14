from db import conn


def save_memory(key: str, value: str, category: str = "general") -> dict:
    with conn() as c:
        c.execute(
            "INSERT INTO memory (key, value, category) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, category=excluded.category, updated_at=CURRENT_TIMESTAMP",
            (key, value, category),
        )
    return {"success": True, "key": key}


def get_memory(key: str) -> dict:
    with conn() as c:
        row = c.execute("SELECT key, value, category, updated_at FROM memory WHERE key=?", (key,)).fetchone()
    if not row:
        return {"error": f"Memory key '{key}' not found"}
    return dict(row)


def search_memory(query: str) -> dict:
    with conn() as c:
        rows = c.execute(
            "SELECT key, value, category, updated_at FROM memory WHERE key LIKE ? OR value LIKE ? OR category LIKE ? ORDER BY updated_at DESC LIMIT 20",
            (f"%{query}%", f"%{query}%", f"%{query}%"),
        ).fetchall()
    return {"results": [dict(r) for r in rows], "count": len(rows)}


def list_memory(category: str = "") -> dict:
    with conn() as c:
        if category:
            rows = c.execute("SELECT key, value, category, updated_at FROM memory WHERE category=? ORDER BY key", (category,)).fetchall()
        else:
            rows = c.execute("SELECT key, value, category, updated_at FROM memory ORDER BY category, key").fetchall()
    return {"memories": [dict(r) for r in rows], "count": len(rows)}


def delete_memory(key: str) -> dict:
    with conn() as c:
        c.execute("DELETE FROM memory WHERE key=?", (key,))
    return {"success": True, "key": key}
