#!/bin/bash
# Install Claude Code skills + plugins on this Mac mini.
# Run once: bash ~/Github/setup_skills.sh
#
# Installs:
#   Skills: archify, gpt-image-2-style-library, claude-obsidian (wiki/research), unlazy
#   Plugins: commit-commands, pr-review-toolkit, feature-dev, hookify, github, linear, serena
#   CLI tools: witr (process/port tracer)

set -e

echo "=== Claude Code Skills + Plugins Setup ==="

# ── Skills (via npx skills) ────────────────────────────────────────────────

echo ""
echo "Installing skills..."

# Architecture diagrams — TMS, Axel, API docs, client presentations
echo "  → archify (architecture diagrams)"
npx --yes skills add tt-a1i/archify -g

# GPT Image prompt library — marketing, social media, ads
echo "  → gpt-image-2 style library (image prompt templates)"
npx --yes skills add freestylefly/awesome-gpt-image-2 -g

# Second brain — TMS research, Axel notes, driver ops, freight data
echo "  → claude-obsidian (knowledge base / second brain)"
npx --yes skills add AgriciDaniel/claude-obsidian -g

# Anti-laziness — forces full effort on complex multi-step tasks
echo "  → unlazy (depth tree anti-laziness)"
npx --yes skills add Leonxlnx/unlazy -g

echo "  Skills installed."

# ── Plugin marketplace ─────────────────────────────────────────────────────

echo ""
echo "Configuring plugin marketplace..."
claude plugin marketplace add anthropics/claude-plugins-official 2>/dev/null || true
echo "  Marketplace: claude-plugins-official"

# ── Plugins ───────────────────────────────────────────────────────────────

echo ""
echo "Installing plugins..."

PLUGINS=(
  "commit-commands"      # streamline git workflow across all projects
  "pr-review-toolkit"    # comprehensive PR review
  "feature-dev"          # feature development workflow
  "hookify"              # set up automated hook behaviors
  "github"               # GitHub integration
  "linear"               # Linear task management (TMS, freight)
  "serena"               # semantic LSP code intelligence (IDE-level navigation for agents)
)

for p in "${PLUGINS[@]}"; do
  echo "  → $p"
  claude plugin install "$p@claude-plugins-official" 2>&1 | grep -E "(Successfully|Failed|already)" || true
done

# ── CLI tools ─────────────────────────────────────────────────────────────

echo ""
echo "Installing CLI tools..."

# witr: "Why is this running?" — trace any process, port, or container back to origin
# Useful for debugging port conflicts (Docker, n8n, Axel), Mac mini system issues
if command -v brew &>/dev/null; then
  echo "  → witr (process/port tracer)"
  brew install pranshuparmar/tap/witr 2>&1 | grep -E "(installed|already|Error)" || true
else
  echo "  ! brew not found — install witr manually: https://github.com/pranshuparmar/witr"
fi

echo ""
echo "=== Done! Restart Claude Code to activate all skills and plugins. ==="
echo ""
echo "Available skills after restart:"
echo "  /archify       → architecture + flow diagrams"
echo "  /unlazy        → enforce full effort on complex tasks"
echo "  /wiki          → knowledge base (needs vault init)"
echo "  /autoresearch  → deep web research into vault"
echo "  /wiki-ingest   → ingest sources into vault"
echo "  /wiki-query    → query vault for answers"
echo ""
echo "CLI tools:"
echo "  witr <port|pid|file>  → trace what started it"
