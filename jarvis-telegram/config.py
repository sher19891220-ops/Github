import os
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
ALLOWED_USER_IDS = set(
    int(uid.strip())
    for uid in os.environ.get("ALLOWED_USER_IDS", "").split(",")
    if uid.strip()
)
MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5")
MAX_HISTORY = int(os.environ.get("MAX_HISTORY", "40"))  # messages kept per chat
DB_PATH = os.environ.get("DB_PATH", "jarvis.db")
