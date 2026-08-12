"""
Tests for individual tool functions.
Run: pytest tests/ -v
"""

import os
import json
import pytest

os.environ.setdefault("ANTHROPIC_API_KEY", "test")
os.environ.setdefault("TELEGRAM_TOKEN", "test")
os.environ.setdefault("TELEGRAM_CHAT_ID", "123456")
os.environ.setdefault("BACKEND_API_KEY", "test")


# ── System tools ───────────────────────────────────────────────────────────────

def test_run_shell_basic():
    from tools.system import run_shell
    result = run_shell("echo hello")
    assert result["exit_code"] == 0
    assert result["stdout"] == "hello"


def test_run_shell_timeout():
    from tools.system import run_shell
    result = run_shell("sleep 10", timeout=1)
    assert "timed out" in result.get("error", "").lower()


def test_read_file_missing():
    from tools.system import read_file
    result = read_file("/nonexistent/file.txt")
    assert "error" in result


def test_write_then_read(tmp_path):
    from tools.system import write_file, read_file
    path = str(tmp_path / "test.txt")
    write_file(path, "hello world")
    result = read_file(path)
    assert result["content"] == "hello world"


def test_write_file_unicode(tmp_path):
    from tools.system import write_file, read_file
    path = str(tmp_path / "unicode.txt")
    write_file(path, "Axel ✅ ready")
    result = read_file(path)
    assert "✅" in result["content"]


def test_list_directory(tmp_path):
    from tools.system import list_directory
    (tmp_path / "a.txt").write_text("x")
    (tmp_path / "b.txt").write_text("y")
    result = list_directory(str(tmp_path))
    names = [e["name"] for e in result["entries"]]
    assert "a.txt" in names and "b.txt" in names


# ── Memory tools ───────────────────────────────────────────────────────────────

def test_save_and_get_memory(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from db import init_db
    init_db()
    from tools.memory import save_memory, get_memory
    save_memory("test.key", "hello", "profile")
    result = get_memory("test.key")
    assert result["value"] == "hello"


def test_search_memory(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from db import init_db
    init_db()
    from tools.memory import save_memory, search_memory
    save_memory("sher.car", "Tesla Model 3", "profile")
    result = search_memory("Tesla")
    assert result["count"] > 0


# ── Task tools ─────────────────────────────────────────────────────────────────

def test_create_and_list_task(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from db import init_db
    init_db()
    from tools.tasks import create_task, list_tasks
    create_task("Buy groceries", "Milk and eggs", "medium", "")
    result = list_tasks("open")
    assert result["count"] >= 1
    titles = [t["title"] for t in result["tasks"]]
    assert "Buy groceries" in titles


def test_complete_task(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from db import init_db
    init_db()
    from tools.tasks import create_task, complete_task, list_tasks
    create_task("Test task", "", "low", "")
    open_tasks = list_tasks("open")
    task_id = open_tasks["tasks"][0]["id"]
    complete_task(task_id)
    done = list_tasks("done")
    assert any(t["id"] == task_id for t in done["tasks"])


# ── Tool registry ──────────────────────────────────────────────────────────────

def test_tool_registry_loads():
    from tool_registry import TOOLS, dispatch
    assert len(TOOLS) > 0
    for t in TOOLS:
        assert "name" in t
        assert "input_schema" in t


def test_dispatch_unknown_tool():
    from tool_registry import dispatch
    result = json.loads(dispatch("nonexistent_tool", {}, {}))
    assert "error" in result


def test_dispatch_run_shell():
    from tool_registry import dispatch
    result = json.loads(dispatch("run_shell", {"command": "echo axel"}, {}))
    assert result["stdout"] == "axel"


def test_dispatch_save_memory(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from db import init_db
    init_db()
    from tool_registry import dispatch
    result = json.loads(dispatch("save_memory", {"key": "x", "value": "y"}, {}))
    assert "saved" in str(result).lower() or "success" in str(result).lower() or result


# ── Finance tools (no credentials) ────────────────────────────────────────────

def test_bank_accounts_unconfigured():
    from tools.finance_tools import bank_accounts
    result = bank_accounts()
    assert "not configured" in result.lower() or "setup" in result.lower()


def test_qb_check_unconfigured():
    from tools.finance_tools import qb_invoices
    result = qb_invoices()
    assert "not configured" in result.lower() or "quickbooks" in result.lower()


# ── Google tools (no credentials) ─────────────────────────────────────────────

def test_gmail_list_unconfigured():
    from tools.google_tools import gmail_list
    result = gmail_list()
    assert "not authorized" in result.lower() or "setup" in result.lower() or "error" in result.lower()


# ── Conversation ───────────────────────────────────────────────────────────────

def test_conversation_add_get(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from db import init_db
    init_db()
    import conversation
    conversation.add(999, "user", "hello")
    conversation.add(999, "assistant", "hi there")
    history = conversation.get(999)
    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[1]["role"] == "assistant"


def test_conversation_clear(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from db import init_db
    init_db()
    import conversation
    conversation.add(888, "user", "test")
    conversation.clear(888)
    assert conversation.get(888) == []
