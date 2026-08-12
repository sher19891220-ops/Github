import logging
import httpx
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from telegram.constants import ChatAction

from config import TELEGRAM_TOKEN, ALLOWED_USER_IDS, BACKEND_URL, BACKEND_API_KEY, BACKEND_TIMEOUT

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)

_headers = {"x-api-key": BACKEND_API_KEY} if BACKEND_API_KEY else {}


def is_allowed(user_id: int) -> bool:
    return not ALLOWED_USER_IDS or user_id in ALLOWED_USER_IDS


async def _backend(method: str, path: str, **kwargs):
    async with httpx.AsyncClient(base_url=BACKEND_URL, headers=_headers, timeout=BACKEND_TIMEOUT) as client:
        resp = await getattr(client, method)(path, **kwargs)
        resp.raise_for_status()
        return resp.json()


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    await update.message.reply_text(
        "Axel online. Ready, Sher.\n\n"
        "/clear — Reset conversation\n"
        "/status — System status\n"
        "/id — Your Telegram user ID"
    )


async def cmd_clear(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    try:
        await _backend("post", "/clear", json={"chat_id": update.effective_chat.id})
        await update.message.reply_text("Conversation cleared.")
    except Exception as e:
        await update.message.reply_text(f"❌ Could not reach backend: {e}")


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    try:
        data = await _backend("get", "/status")
        await update.message.reply_text(
            f"Axel operational ✅\n"
            f"Open tasks: {data.get('open_tasks', '?')}\n"
            f"Memories: {data.get('memories', '?')}\n"
            f"Scheduler: {data.get('scheduler', '?')}"
        )
    except Exception as e:
        await update.message.reply_text(f"❌ Backend unreachable: {e}")


async def cmd_id(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    await update.message.reply_text(f"Your Telegram user ID: `{uid}`", parse_mode="Markdown")


async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if not is_allowed(user_id):
        log.warning("Blocked user %s", user_id)
        return

    chat_id = update.effective_chat.id
    text = update.message.text or update.message.caption or ""
    if not text.strip():
        return

    await ctx.bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)

    try:
        data = await _backend("post", "/chat", json={"chat_id": chat_id, "message": text})
        reply = data.get("reply", "")
    except httpx.TimeoutException:
        await update.message.reply_text("⏱ Axel is still working on it... (backend timeout — check Mac mini)")
        return
    except httpx.ConnectError:
        await update.message.reply_text("❌ Cannot reach Mac mini backend. Is it running?")
        return
    except Exception as e:
        log.error("Backend error: %s", e)
        await update.message.reply_text(f"❌ Error: {e}")
        return

    for chunk in _split(reply, 4000):
        await update.message.reply_text(chunk, parse_mode="Markdown")


def _split(text: str, size: int) -> list[str]:
    if len(text) <= size:
        return [text]
    chunks, start = [], 0
    while start < len(text):
        end = start + size
        if end < len(text):
            nl = text.rfind("\n", start, end)
            if nl > start:
                end = nl + 1
        chunks.append(text[start:end])
        start = end
    return chunks


def main():
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("clear", cmd_clear))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("id", cmd_id))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    log.info("Axel Telegram bot starting — backend: %s", BACKEND_URL)
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
