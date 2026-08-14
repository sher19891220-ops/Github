import httpx

from config import TELEGRAM_TOKEN


def send_telegram(chat_id: int, message: str) -> dict:
    """Send a message to a Telegram chat. Used by AXEL for proactive updates."""
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    try:
        # Split if over 4096 chars
        chunks = _split(message, 4000)
        for chunk in chunks:
            if not chunk.strip():
                continue
            resp = httpx.post(url, json={"chat_id": chat_id, "text": chunk, "parse_mode": "Markdown"}, timeout=10)
            if not resp.is_success:
                resp = httpx.post(url, json={"chat_id": chat_id, "text": chunk}, timeout=10)
            resp.raise_for_status()
        return {"success": True, "chunks_sent": len(chunks)}
    except Exception as e:
        return {"error": str(e)}


def send_telegram_file(chat_id: int, file_path: str, caption: str = "") -> dict:
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendDocument"
    try:
        with open(file_path, "rb") as f:
            resp = httpx.post(url, data={"chat_id": chat_id, "caption": caption}, files={"document": f}, timeout=30)
            resp.raise_for_status()
        return {"success": True, "file": file_path}
    except Exception as e:
        return {"error": str(e)}


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
