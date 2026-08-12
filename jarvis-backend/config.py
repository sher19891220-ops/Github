import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = int(os.environ["TELEGRAM_CHAT_ID"])  # Sher's chat ID for proactive messages

MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5")
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "8192"))
MAX_TOOL_ITERATIONS = int(os.environ.get("MAX_TOOL_ITERATIONS", "25"))

DB_PATH = os.environ.get("DB_PATH", "jarvis.db")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))

# API key for securing the backend endpoint
BACKEND_API_KEY = os.environ.get("BACKEND_API_KEY", "")

# Shell: restrict execution to these base paths (empty = unrestricted)
ALLOWED_SHELL_PATHS = [p for p in os.environ.get("ALLOWED_SHELL_PATHS", "").split(",") if p.strip()]

# Whether to allow arbitrary shell commands (set False for stricter safety)
ALLOW_SHELL = os.environ.get("ALLOW_SHELL", "true").lower() == "true"
