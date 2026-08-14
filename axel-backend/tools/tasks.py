from db import conn


def create_task(title: str, description: str = "", priority: str = "medium", due_date: str = "") -> dict:
    with conn() as c:
        cur = c.execute(
            "INSERT INTO tasks (title, description, priority, due_date) VALUES (?, ?, ?, ?)",
            (title, description, priority, due_date or None),
        )
        return {"success": True, "task_id": cur.lastrowid, "title": title}


def list_tasks(status: str = "open") -> dict:
    with conn() as c:
        rows = c.execute(
            "SELECT id, title, description, priority, status, due_date, created_at FROM tasks WHERE status = ? ORDER BY priority, created_at",
            (status,),
        ).fetchall()
    tasks = [dict(r) for r in rows]
    return {"tasks": tasks, "count": len(tasks)}


def complete_task(task_id: int) -> dict:
    with conn() as c:
        c.execute(
            "UPDATE tasks SET status='done', updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (task_id,),
        )
    return {"success": True, "task_id": task_id, "status": "done"}


def update_task(task_id: int, title: str = "", description: str = "", priority: str = "", due_date: str = "", status: str = "") -> dict:
    fields, vals = [], []
    for col, val in [("title", title), ("description", description), ("priority", priority), ("due_date", due_date), ("status", status)]:
        if val:
            fields.append(f"{col}=?")
            vals.append(val)
    if not fields:
        return {"error": "No fields to update"}
    vals.extend([task_id])
    with conn() as c:
        c.execute(f"UPDATE tasks SET {', '.join(fields)}, updated_at=CURRENT_TIMESTAMP WHERE id=?", vals)
    return {"success": True, "task_id": task_id}


def get_task(task_id: int) -> dict:
    with conn() as c:
        row = c.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        return {"error": f"Task {task_id} not found"}
    return dict(row)
