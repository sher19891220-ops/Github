import os
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
ALLOWED_USER_IDS = set(
    int(uid.strip())
    for uid in os.environ.get("ALLOWED_USER_IDS", "").split(",")
    if uid.strip()
)

# Mac mini backend
BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8000")
BACKEND_API_KEY = os.environ.get("BACKEND_API_KEY", "")
BACKEND_TIMEOUT = int(os.environ.get("BACKEND_TIMEOUT", "120"))  # seconds — JARVIS may use multiple tools
