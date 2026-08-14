"""
AXEL Backend — FastAPI server running on Mac mini.
The Telegram bot calls /chat to get AXEL responses.
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

import axel_engine
import conversation
from config import BACKEND_API_KEY, HOST, PORT
from db import init_db
from tools.scheduler import check_and_send_due

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("axel")


# ── Scheduler ─────────────────────────────────────────────────────────────────

scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Check scheduled messages every minute
    scheduler.add_job(check_and_send_due, "interval", minutes=1, id="scheduled_msgs")
    scheduler.start()
    log.info("AXEL backend online.")
    yield
    scheduler.shutdown()
    log.info("AXEL backend shutting down.")


app = FastAPI(title="AXEL Backend", lifespan=lifespan)


# ── Auth ───────────────────────────────────────────────────────────────────────

def check_api_key(x_api_key: str = Header(default="")):
    if BACKEND_API_KEY and x_api_key != BACKEND_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Models ─────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    chat_id: int
    message: str


class ClearRequest(BaseModel):
    chat_id: int


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "online", "service": "AXEL"}


@app.post("/chat", dependencies=[Depends(check_api_key)])
async def chat(req: ChatRequest):
    log.info("Chat from %s: %s", req.chat_id, req.message[:80])

    # Load history, append user message
    history = conversation.get(req.chat_id)
    history.append({"role": "user", "content": req.message})

    # Run agentic loop in thread pool (blocking Claude calls)
    context = {"chat_id": req.chat_id}
    try:
        reply = await asyncio.get_running_loop().run_in_executor(
            None, axel_engine.run, history, context
        )
    except Exception as e:
        log.error("Engine error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

    # Persist both turns
    conversation.add(req.chat_id, "user", req.message)
    conversation.add(req.chat_id, "assistant", reply)

    return {"reply": reply, "chat_id": req.chat_id}


@app.post("/clear", dependencies=[Depends(check_api_key)])
def clear(req: ClearRequest):
    conversation.clear(req.chat_id)
    return {"success": True, "chat_id": req.chat_id}


@app.get("/tasks", dependencies=[Depends(check_api_key)])
def get_tasks(status: str = "open"):
    from tools.tasks import list_tasks
    return list_tasks(status)


@app.get("/memory", dependencies=[Depends(check_api_key)])
def get_memory(category: str = ""):
    from tools.memory import list_memory
    return list_memory(category)


@app.get("/status", dependencies=[Depends(check_api_key)])
def status():
    from tools.memory import list_memory
    from tools.tasks import list_tasks
    open_tasks = list_tasks("open")
    memories = list_memory()
    return {
        "status": "online",
        "open_tasks": open_tasks["count"],
        "memories": memories["count"],
        "scheduler": "running" if scheduler.running else "stopped",
    }


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
