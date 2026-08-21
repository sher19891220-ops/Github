#!/bin/bash
# One-shot: wire Axel MCP server into Claude Code globally on this Mac mini.
# Run once: bash ~/Github/setup_claude_mcp.sh
#
# After this, every Claude Code session on the Mac mini has all 40+ Axel tools:
# shell, memory, tasks, gmail, drive, sheets, calendar, bank, quickbooks, docker, etc.

set -e

BACKEND="$HOME/Github/axel-backend"
PYTHON="$BACKEND/venv/bin/python"
GLOBAL="$HOME/.claude/settings.json"

echo "=== Axel MCP Setup ==="

# Ensure venv exists
if [ ! -f "$PYTHON" ]; then
  echo "Creating virtualenv..."
  python3 -m venv "$BACKEND/venv"
  "$BACKEND/venv/bin/pip" install -q -r "$BACKEND/requirements.txt"
fi

chmod +x "$BACKEND/mcp_server.py"

# Merge MCP config into global Claude settings using Python
mkdir -p "$HOME/.claude"
[ -f "$GLOBAL" ] || echo "{}" > "$GLOBAL"

"$PYTHON" - <<PYEOF
import json, os

path = os.path.expanduser("~/.claude/settings.json")
with open(path) as f:
    cfg = json.load(f)

cfg.setdefault("mcpServers", {})["axel"] = {
    "command": "$PYTHON",
    "args": ["$BACKEND/mcp_server.py"],
    "cwd": "$BACKEND",
}

perms = cfg.setdefault("permissions", {}).setdefault("allow", [])
for p in ["mcp__axel__*", "Bash(brew *)", "Bash(docker *)", "Bash(npm *)", "Bash(node *)"]:
    if p not in perms:
        perms.append(p)

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)

print("✅ Axel MCP server registered in ~/.claude/settings.json")
PYEOF

echo ""
echo "=== Done ==="
echo "Open a new Claude Code session to load the Axel tools."
echo "Type 'check setup' in Axel (Telegram) to verify all integrations."
echo ""
echo "Optional — expose Mac mini to cloud sessions:"
echo "  brew install cloudflared"
echo "  cloudflared tunnel --url http://localhost:8000"
echo "  (Share the public URL to let this cloud session call Axel remotely)"
