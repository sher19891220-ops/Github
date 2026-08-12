#!/bin/bash
# Start JARVIS backend on Mac mini
# Add to launchd or run manually: ./start.sh

set -e
cd "$(dirname "$0")"

# Activate venv if present
if [ -d ".venv" ]; then
    source .venv/bin/activate
fi

echo "Starting JARVIS backend..."
python main.py
