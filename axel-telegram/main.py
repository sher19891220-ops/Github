import asyncio
import logging
import httpx
import tempfile
import subprocess
from pathlib import Path
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from telegram.constants import ChatAction

from config import TELEGRAM_TOKEN, ALLOWED_USER_IDS, BACKEND_URL, BACKEND_API_KEY, BACKEND_TIMEOUT

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.INFO,
)
# httpx logs every request URL at INFO, and the Telegram API embeds the bot
# token in the path — so this writes the token to disk on every poll (~4x/min).
# Silence it; python-telegram-bot still reports real failures through its own
# loggers, and errors here are handled explicitly below.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

log = logging.getLogger(__name__)

_headers = {"x-api-key": BACKEND_API_KEY} if BACKEND_API_KEY else {}


def is_allowed(user_id: int) -> bool:
    return not ALLOWED_USER_IDS or user_id in ALLOWED_USER_IDS


async def _backend(method: str, path: str, **kwargs):
    async with httpx.AsyncClient(base_url=BACKEND_URL, headers=_headers, timeout=BACKEND_TIMEOUT) as client:
        resp = await getattr(client, method)(path, **kwargs)
        resp.raise_for_status()
        return resp.json()


async def transcribe_voice(voice_file_path: str) -> str:
    """Transcribe voice message using Whisper"""
    try:
        log.info(f"Transcribing voice message: {voice_file_path}")
        result = subprocess.run(
            ["whisper", voice_file_path, "--model", "base", "--output_format", "txt", "--output_dir", "/tmp"],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            log.error(f"Whisper error: {result.stderr}")
            return ""
        
        # Whisper outputs to filename.txt
        txt_file = Path(voice_file_path).stem + ".txt"
        txt_path = Path("/tmp") / txt_file
        
        if txt_path.exists():
            transcription = txt_path.read_text().strip()
            txt_path.unlink()  # Clean up
            log.info(f"Transcription: {transcription}")
            return transcription
        else:
            log.error(f"Transcription file not found: {txt_path}")
            return ""
            
    except Exception as e:
        log.error(f"Transcription failed: {e}")
        return ""


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update.effective_user.id):
        return
    await update.message.reply_text(
        "Axel online. Ready, Sher.\n\n"
        "/clear — Reset conversation\n"
        "/status — System status\n"
        "/id — Your Telegram user ID\n\n"
        "🎤 Voice messages supported"
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


async def handle_voice(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Handle voice messages"""
    user_id = update.effective_user.id
    if not is_allowed(user_id):
        log.warning("Blocked user %s", user_id)
        return

    chat_id = update.effective_chat.id
    await ctx.bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)
    
    try:
        # Download voice file
        voice = update.message.voice
        file = await ctx.bot.get_file(voice.file_id)
        
        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tmp:
            tmp_path = tmp.name
            await file.download_to_drive(tmp_path)
        
        # Transcribe
        transcription = await transcribe_voice(tmp_path)
        
        # Clean up temp file
        Path(tmp_path).unlink(missing_ok=True)
        
        if not transcription:
            await update.message.reply_text("❌ Could not transcribe voice message")
            return
        
        log.info(f"Voice transcribed: {transcription}")
        
        # Send transcription to backend
        try:
            data = await _backend("post", "/chat", json={"chat_id": chat_id, "message": transcription})
            reply = data.get("reply", "")
        except httpx.TimeoutException:
            await update.message.reply_text("⏱ Axel is still working on it... (backend timeout — check Mac mini)")
            return
        except httpx.ConnectError:
            await update.message.reply_text("❌ Cannot reach Mac mini backend. Is it running?")
            return
        except httpx.HTTPStatusError as e:
            detail = ""
            try:
                detail = e.response.json().get("detail", "")
            except Exception:
                detail = e.response.text[:500]
            log.error("Backend HTTP %s: %s", e.response.status_code, detail)
            await update.message.reply_text(f"❌ Backend error {e.response.status_code}: {detail}")
            return
        except Exception as e:
            log.error("Backend error: %s", e)
            await update.message.reply_text(f"❌ Error: {e}")
            return

        for chunk in _split(reply, 4000):
            if not chunk.strip():
                continue
            try:
                await update.message.reply_text(chunk, parse_mode="Markdown")
            except Exception:
                await update.message.reply_text(chunk)
                
    except Exception as e:
        log.error(f"Voice handling error: {e}")
        await update.message.reply_text(f"❌ Error processing voice: {e}")


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
    except httpx.HTTPStatusError as e:
        detail = ""
        try:
            detail = e.response.json().get("detail", "")
        except Exception:
            detail = e.response.text[:500]
        log.error("Backend HTTP %s: %s", e.response.status_code, detail)
        await update.message.reply_text(f"❌ Backend error {e.response.status_code}: {detail}")
        return
    except Exception as e:
        log.error("Backend error: %s", e)
        await update.message.reply_text(f"❌ Error: {e}")
        return

    for chunk in _split(reply, 4000):
        if not chunk.strip():
            continue
        try:
            await update.message.reply_text(chunk, parse_mode="Markdown")
        except Exception:
            await update.message.reply_text(chunk)


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
    asyncio.set_event_loop(asyncio.new_event_loop())
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("clear", cmd_clear))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("id", cmd_id))
    app.add_handler(MessageHandler(filters.VOICE, handle_voice))  # Voice handler
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    log.info("Axel Telegram bot starting — backend: %s", BACKEND_URL)
    log.info("Voice transcription enabled via Whisper")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
