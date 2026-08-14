#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Axel Mac mini service installer
# Installs launchd agents so the backend and bot auto-start on login and
# restart automatically if they crash.
#
# Run once from anywhere:
#   bash install_mac_services.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/axel-backend"
BOT_DIR="$SCRIPT_DIR/axel-telegram"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Axel"

# ── Preflight checks ──────────────────────────────────────────────────────────

echo "🔍 Checking directories..."
[ -d "$BACKEND_DIR" ] || { echo "❌ Not found: $BACKEND_DIR"; exit 1; }
[ -d "$BOT_DIR" ]     || { echo "❌ Not found: $BOT_DIR"; exit 1; }

[ -f "$BACKEND_DIR/.env" ] || { echo "❌ Missing: $BACKEND_DIR/.env  (copy .env.example and fill it in)"; exit 1; }
[ -f "$BOT_DIR/.env" ]     || { echo "❌ Missing: $BOT_DIR/.env  (copy .env.example and fill it in)"; exit 1; }

# Find Python
PYTHON=$(command -v python3 || command -v python || true)
[ -z "$PYTHON" ] && { echo "❌ Python not found. Install Python 3."; exit 1; }
echo "✅ Python: $PYTHON ($($PYTHON --version 2>&1))"

# Make start scripts executable
chmod +x "$BACKEND_DIR/start_backend.sh"
chmod +x "$BOT_DIR/start_bot.sh"

# ── Create log directories ─────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
mkdir -p "$BACKEND_DIR/logs"
mkdir -p "$BOT_DIR/logs"
echo "✅ Log dir: $LOG_DIR"

# ── Write plist: backend ──────────────────────────────────────────────────────
BACKEND_PLIST="$LAUNCH_AGENTS/com.axel.backend.plist"
mkdir -p "$LAUNCH_AGENTS"

cat > "$BACKEND_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.axel.backend</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$BACKEND_DIR/start_backend.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$BACKEND_DIR</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/backend.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/backend-error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PYTHONUTF8</key>
        <string>1</string>
        <key>PYTHONIOENCODING</key>
        <string>utf-8</string>
    </dict>
</dict>
</plist>
PLIST

echo "✅ Wrote: $BACKEND_PLIST"

# ── Write plist: bot ──────────────────────────────────────────────────────────
BOT_PLIST="$LAUNCH_AGENTS/com.axel.bot.plist"

cat > "$BOT_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.axel.bot</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$BOT_DIR/start_bot.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$BOT_DIR</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StartInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/bot.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/bot-error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PYTHONUTF8</key>
        <string>1</string>
        <key>PYTHONIOENCODING</key>
        <string>utf-8</string>
    </dict>
</dict>
</plist>
PLIST

echo "✅ Wrote: $BOT_PLIST"

# ── Unload existing (if already installed) ────────────────────────────────────
echo ""
echo "🔄 Loading services..."
launchctl unload "$BACKEND_PLIST" 2>/dev/null || true
launchctl unload "$BOT_PLIST" 2>/dev/null || true

# ── Load ──────────────────────────────────────────────────────────────────────
launchctl load "$BACKEND_PLIST"
launchctl load "$BOT_PLIST"

# ── Wait and verify ───────────────────────────────────────────────────────────
sleep 5
echo ""
echo "🔍 Verifying..."

BACKEND_PID=$(launchctl list | grep com.axel.backend | awk '{print $1}')
BOT_PID=$(launchctl list | grep com.axel.bot | awk '{print $1}')

if [ "$BACKEND_PID" != "-" ] && [ -n "$BACKEND_PID" ]; then
    echo "✅ Backend running (PID $BACKEND_PID)"
else
    echo "⚠️  Backend not running yet — check: tail -f $LOG_DIR/backend-error.log"
fi

if [ "$BOT_PID" != "-" ] && [ -n "$BOT_PID" ]; then
    echo "✅ Bot running (PID $BOT_PID)"
else
    echo "⚠️  Bot not running yet — check: tail -f $LOG_DIR/bot-error.log"
fi

# Health check
sleep 3
if curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    echo "✅ Backend health check: PASSED"
else
    echo "⚠️  Backend health check failed — may still be starting up"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ Axel services installed and running."
echo ""
echo "Both services will:"
echo "  • Start automatically on login"
echo "  • Restart automatically if they crash"
echo ""
echo "Useful commands:"
echo "  View backend logs:  tail -f $LOG_DIR/backend.log"
echo "  View bot logs:      tail -f $LOG_DIR/bot.log"
echo ""
echo "  Stop backend:  launchctl unload $BACKEND_PLIST"
echo "  Stop bot:      launchctl unload $BOT_PLIST"
echo ""
echo "  Restart both:  bash $SCRIPT_DIR/install_mac_services.sh"
echo "═══════════════════════════════════════════════════════"
