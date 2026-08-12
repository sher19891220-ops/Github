#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(dirname "$DIR")/jarvis-backend"
PYTHON="$BACKEND_DIR/venv/bin/python"
LOG="$DIR/logs/bot.log"

mkdir -p "$DIR/logs"

if [ -f "$DIR/.env" ]; then
    set -a; source "$DIR/.env"; set +a
fi

exec "$PYTHON" "$DIR/main.py" >> "$LOG" 2>&1
