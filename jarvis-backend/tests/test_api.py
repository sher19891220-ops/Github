"""
Integration tests for the FastAPI backend.
Run: pytest tests/test_api.py -v
"""

import os
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("ANTHROPIC_API_KEY", "test")
os.environ.setdefault("TELEGRAM_TOKEN", "test")
os.environ.setdefault("TELEGRAM_CHAT_ID", "123456")
os.environ.setdefault("BACKEND_API_KEY", "")


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("db")
    os.environ["DB_PATH"] = str(tmp / "test.db")
    from db import init_db
    init_db()
    from main import app
    with TestClient(app) as c:
        yield c


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "online"


def test_status(client):
    resp = client.get("/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "open_tasks" in data
    assert "memories" in data


def test_clear(client):
    resp = client.post("/clear", json={"chat_id": 1})
    assert resp.status_code == 200
    assert resp.json()["success"] is True


def test_chat_requires_key():
    os.environ["BACKEND_API_KEY"] = "secret123"
    from main import app
    with TestClient(app) as c:
        resp = c.post("/chat", json={"chat_id": 1, "message": "hi"})
        assert resp.status_code == 401
    os.environ["BACKEND_API_KEY"] = ""
