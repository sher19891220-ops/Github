#!/bin/bash
# Install Claude Code skills + plugins on this Mac mini.
# Run once: bash ~/Github/setup_skills.sh
#
# Installs:
#   Skills: archify, gpt-image-2-style-library, claude-obsidian (wiki/research)
#   Plugins: commit-commands, pr-review-toolkit, feature-dev, hookify, github, linear

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

echo ""
echo "=== Done! Restart Claude Code to activate all skills and plugins. ==="
echo ""
echo "Available skills after restart:"
echo "  /archify       → architecture + flow diagrams"
echo "  /wiki          → knowledge base (needs vault init)"
echo "  /autoresearch  → deep web research into vault"
echo "  /wiki-ingest   → ingest sources into vault"
echo "  /wiki-query    → query vault for answers"
