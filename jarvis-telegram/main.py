import logging
import asyncio
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from telegram.constants import ChatAction

from config import TELEGRAM_TOKEN, ALLOWED_USER_IDS
from db import init_db, add_message, get_history, clear_history
import jarvis

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)


def is_allowed(user_id: int) -> bool:
    return not ALLOWED_USER_IDS or user_id in ALLOWED_USER_IDS


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    await update.message.reply_text(
        "JARVIS online. How can I help you, Sher?\n\n"
        "Commands:\n"
        "/clear — Reset conversation\n"
        "/status — System status\n"
        "/id — Your Telegram user ID"
    )


async def cmd_clear(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    clear_history(update.effective_chat.id)
    await update.message.reply_text("Conversation cleared. Starting fresh.")


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    history = get_history(update.effective_chat.id)
    await update.message.reply_text(
        f"JARVIS operational.\n"
        f"Model: {jarvis.MODEL}\n"
        f"Messages in context: {len(history)}"
    )


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

    add_message(chat_id, "user", text)
    history = get_history(chat_id)

    await ctx.bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)

    try:
        reply = await asyncio.get_event_loop().run_in_executor(
            None, jarvis.chat, history
        )
    except Exception as e:
        log.error("Claude API error: %s", e)
        await update.message.reply_text(f"Error: {e}")
        return

    add_message(chat_id, "assistant", reply)

    # Split if over Telegram's 4096 char limit
    for chunk in _split(reply, 4000):
        await update.message.reply_text(chunk, parse_mode="Markdown")


def _split(text: str, size: int) -> list[str]:
    if len(text) <= size:
        return [text]
    chunks, start = [], 0
    while start < len(text):
        end = start + size
        if end < len(text):
            # break at last newline within chunk
            nl = text.rfind("\n", start, end)
            if nl > start:
                end = nl + 1
        chunks.append(text[start:end])
        start = end
    return chunks


def main():
    init_db()
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("clear", cmd_clear))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("id", cmd_id))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    log.info("JARVIS Telegram bot starting...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
