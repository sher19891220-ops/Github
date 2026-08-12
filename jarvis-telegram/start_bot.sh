#!/bin/bash
# Axel Telegram bot startup wrapper — sourced by launchd
DIR="$(cd "$(dirname "$0")" && pwd)"

# Load environment variables from .env
if [ -f "$DIR/.env" ]; then
    set -a
    source "$DIR/.env"
    set +a
fi

# Activate virtualenv if present (checks backend venv too, for shared installs)
if [ -f "$DIR/venv/bin/activate" ]; then
    source "$DIR/venv/bin/activate"
elif [ -f "$(dirname "$DIR")/jarvis-backend/venv/bin/activate" ]; then
    source "$(dirname "$DIR")/jarvis-backend/venv/bin/activate"
fi

cd "$DIR"
exec python main.py >> "$DIR/logs/bot.log" 2>&1
