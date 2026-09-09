#!/usr/bin/env bash
# One-shot bootstrap: generate DEPLOY_SECRET, update .env, pull latest, restart Axel.
# Run once on the Mac mini: bash ~/Github/scripts/setup_deploy.sh

set -e

REPO="$HOME/Github"
ENV_FILE="$REPO/axel-backend/.env"
BRANCH="claude/security-and-cost-guardrails"

echo "=== Axel Deploy Bootstrap ==="

# 1. Generate DEPLOY_SECRET if not already set
if grep -q "^DEPLOY_SECRET=" "$ENV_FILE" 2>/dev/null; then
  echo "✓ DEPLOY_SECRET already set"
else
  SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  echo "DEPLOY_SECRET=$SECRET" >> "$ENV_FILE"
  echo "✓ DEPLOY_SECRET generated and added to .env"
  echo "  Secret: $SECRET"
fi

# 2. Add AXEL_URL if not already set
if grep -q "^AXEL_URL=" "$ENV_FILE" 2>/dev/null; then
  echo "✓ AXEL_URL already set"
else
  # Try to detect local IP
  LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ip route get 1 2>/dev/null | awk '{print $7; exit}' || echo "")
  if [ -n "$LOCAL_IP" ]; then
    echo "AXEL_URL=http://$LOCAL_IP:8000" >> "$ENV_FILE"
    echo "✓ AXEL_URL set to http://$LOCAL_IP:8000"
    echo "  Update to Tailscale or public URL if needed"
  else
    echo "AXEL_URL=http://localhost:8000" >> "$ENV_FILE"
    echo "⚠ Could not detect IP — AXEL_URL set to localhost. Update manually."
  fi
fi

# 3. Pull latest code
echo ""
echo "=== Pulling latest code ==="
git -C "$REPO" fetch origin "$BRANCH"
git -C "$REPO" pull origin "$BRANCH"

# 4. Install any new Python deps
echo ""
echo "=== Installing dependencies ==="
"$REPO/axel-backend/venv/bin/pip" install -q composio-core openai-whisper 2>&1 | tail -5

# 5. Restart both services
echo ""
echo "=== Restarting services ==="
launchctl unload ~/Library/LaunchAgents/com.axel.telegram.plist 2>/dev/null || true
launchctl load   ~/Library/LaunchAgents/com.axel.telegram.plist
launchctl unload ~/Library/LaunchAgents/com.axel.backend.plist 2>/dev/null || true
launchctl load   ~/Library/LaunchAgents/com.axel.backend.plist

sleep 3

# 6. Health check
echo ""
echo "=== Health check ==="
curl -sf http://localhost:8000/health && echo "" || echo "⚠ Backend not responding yet — check logs"

echo ""
echo "=== Done ==="
echo "Deploy webhook: POST http://localhost:8000/deploy"
echo "  Header: X-Deploy-Secret: $(grep '^DEPLOY_SECRET=' "$ENV_FILE" | cut -d= -f2)"
echo ""
echo "Logs:"
echo "  tail -f $REPO/axel-backend/logs/backend.log"
echo "  tail -f $REPO/axel-telegram/logs/bot.log"
