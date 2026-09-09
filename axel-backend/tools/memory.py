from db import conn


# ── Key-value memory (legacy, keep for compatibility) ──────────────────────

def save_memory(key: str, value: str, category: str = "general") -> dict:
    with conn() as c:
        c.execute(
            "INSERT INTO memory (key, value, category) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, category=excluded.category, updated_at=CURRENT_TIMESTAMP",
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
        kv_rows = c.execute(
            "SELECT key, value, category, updated_at FROM memory "
            "WHERE key LIKE ? OR value LIKE ? OR category LIKE ? ORDER BY updated_at DESC LIMIT 10",
            (f"%{query}%", f"%{query}%", f"%{query}%"),
        ).fetchall()
        am_rows = c.execute(
            "SELECT id, content, category, tags, importance, created_at FROM agent_memories "
            "WHERE content LIKE ? OR category LIKE ? OR tags LIKE ? ORDER BY importance DESC, created_at DESC LIMIT 15",
            (f"%{query}%", f"%{query}%", f"%{query}%"),
        ).fetchall()
    return {
        "query": query,
        "key_value_memories": [dict(r) for r in kv_rows],
        "rich_memories": [dict(r) for r in am_rows],
        "total": len(kv_rows) + len(am_rows),
    }


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


# ── Rich agent memory (Mem0-style) ─────────────────────────────────────────

def remember_this(
    content: str,
    category: str = "general",
    tags: str = "",
    source: str = "axel",
    importance: int = 3,
) -> dict:
    """Save a rich memory with category, tags, and importance (1=low, 5=critical)."""
    importance = max(1, min(5, importance))
    with conn() as c:
        cur = c.execute(
            "INSERT INTO agent_memories (content, category, tags, source, importance) VALUES (?, ?, ?, ?, ?)",
            (content, category, tags, source, importance),
        )
        mem_id = cur.lastrowid
    return {"success": True, "id": mem_id, "category": category, "importance": importance}


def recall(query: str, category: str = "", limit: int = 20) -> dict:
    """Search all memories (both key-value and rich) by keyword."""
    with conn() as c:
        if category:
            rows = c.execute(
                "SELECT id, content, category, tags, importance, created_at FROM agent_memories "
                "WHERE category=? AND (content LIKE ? OR tags LIKE ?) "
                "ORDER BY importance DESC, created_at DESC LIMIT ?",
                (category, f"%{query}%", f"%{query}%", limit),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT id, content, category, tags, importance, created_at FROM agent_memories "
                "WHERE content LIKE ? OR category LIKE ? OR tags LIKE ? "
                "ORDER BY importance DESC, created_at DESC LIMIT ?",
                (f"%{query}%", f"%{query}%", f"%{query}%", limit),
            ).fetchall()
    return {"query": query, "results": [dict(r) for r in rows], "count": len(rows)}


def list_rich_memories(category: str = "", limit: int = 50) -> dict:
    """List rich memories, optionally filtered by category."""
    with conn() as c:
        if category:
            rows = c.execute(
                "SELECT id, content, category, tags, importance, created_at FROM agent_memories "
                "WHERE category=? ORDER BY importance DESC, created_at DESC LIMIT ?",
                (category, limit),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT id, content, category, tags, importance, created_at FROM agent_memories "
                "ORDER BY importance DESC, created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
    return {"memories": [dict(r) for r in rows], "count": len(rows)}


def forget_memory(memory_id: int) -> dict:
    """Delete a rich memory by ID."""
    with conn() as c:
        c.execute("DELETE FROM agent_memories WHERE id=?", (memory_id,))
    return {"success": True, "deleted_id": memory_id}


def get_memory_categories() -> dict:
    """List all memory categories and their counts."""
    with conn() as c:
        rows = c.execute(
            "SELECT category, COUNT(*) as count, MAX(created_at) as last_updated "
            "FROM agent_memories GROUP BY category ORDER BY count DESC"
        ).fetchall()
    return {"categories": [dict(r) for r in rows]}
