#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="$DIR/venv/bin/python"
LOG="$DIR/logs/backend.log"

mkdir -p "$DIR/logs"

if [ -f "$DIR/.env" ]; then
    set -a; source "$DIR/.env"; set +a
fi

export PYTHONUTF8=1
exec "$PYTHON" -m uvicorn main:app --host 0.0.0.0 --port 8000 >> "$LOG" 2>&1
