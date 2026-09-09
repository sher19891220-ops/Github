#!/usr/bin/env bash
# PostToolUse gate (CLAUDE.md §0, §6.2): typecheck + tests run here, after every
# edit, so nothing with a broken build ever reaches the orchestrator.
#
# Exit 0 = pass through. Exit 2 = block, and stderr goes back to the agent that
# made the edit so it fixes its own mess without spending orchestrator context.
set -uo pipefail

INPUT="$(cat)"
FILE="$(jq -r '.tool_input.file_path // empty' <<<"$INPUT" 2>/dev/null)"
[[ -z "$FILE" ]] && exit 0

# Resolve the project from the EDITED FILE, never from a fixed path. Subagents
# run with `isolation: worktree`, so their edits land in a different checkout;
# a hardcoded path would cheerfully verify the wrong tree and report green.
DIR="$(cd "$(dirname "$FILE")" 2>/dev/null && pwd)" || exit 0
PROJ=""
while [[ "$DIR" != "/" && -n "$DIR" ]]; do
  if [[ -f "$DIR/package.json" ]] && grep -q '"name": *"opsdash"' "$DIR/package.json" 2>/dev/null; then
    PROJ="$DIR"; break
  fi
  DIR="$(dirname "$DIR")"
done
[[ -z "$PROJ" ]] && exit 0   # edit outside opsdash: not this gate's business

case "$FILE" in
  *.ts|*.tsx)   MODE="code" ;;
  *.sql)        MODE="sql"  ;;
  *)            exit 0 ;;
esac

cd "$PROJ" || exit 0

# A fresh worktree has no node_modules; without this the gate would fail for a
# reason that has nothing to do with the edit.
if [[ ! -d node_modules ]]; then
  npm install --silent --no-audit --no-fund >/dev/null 2>&1 || {
    echo "post-edit-check: npm install failed in $PROJ" >&2; exit 2; }
fi

if [[ "$MODE" == "code" ]]; then
  if ! OUT="$(npm run --silent check 2>&1)"; then
    {
      echo "BLOCKED: typecheck or unit tests failed after editing $FILE"
      echo "Fix this before continuing; the orchestrator only reviews green diffs."
      echo "---"
      echo "$OUT" | tail -40
    } >&2
    exit 2
  fi
  exit 0
fi

# SQL: prove the migration still applies and still enforces the contract.
# Parallel worktrees must not fight over one cluster, so port and data
# directory are derived from the project path.
HASH="$(printf '%s' "$PROJ" | cksum | cut -d' ' -f1)"
export OPSDASH_PGPORT=$(( 5440 + HASH % 400 ))
export OPSDASH_PGTMP="/var/lib/opsdash-pgverify-$(( HASH % 100000 ))"

if ! OUT="$(npm run --silent db:verify 2>&1)"; then
  {
    echo "BLOCKED: the schema no longer enforces the data contract after editing $FILE"
    echo "---"
    echo "$OUT" | tail -40
  } >&2
  exit 2
fi
exit 0
