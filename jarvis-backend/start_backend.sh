#!/bin/bash
# Axel backend startup wrapper — sourced by launchd
DIR="$(cd "$(dirname "$0")" && pwd)"

# Load environment variables from .env
if [ -f "$DIR/.env" ]; then
    set -a
    source "$DIR/.env"
    set +a
fi

# Activate virtualenv if present
if [ -f "$DIR/venv/bin/activate" ]; then
    source "$DIR/venv/bin/activate"
fi

cd "$DIR"
exec python -m uvicorn main:app --host 0.0.0.0 --port 8000 \
    >> "$DIR/logs/backend.log" 2>&1
