#!/usr/bin/env bash
# Things that must never be committed to this repository.
#
# It is PUBLIC, and it is the repository for a financial system whose source
# documents carry unit numbers, driver names, home addresses, licence
# numbers and social security numbers. The gitignore is the fence; this is
# the check that the fence held. Both are needed, because a `git add -f` or
# a path the ignore rules do not cover leaves no trace until someone looks.
#
# This has already earned its place once: an aggregate revenue figure was
# committed into a tracked document and had to be taken back out.
#
# Runs against what git actually TRACKS, not the working tree, because an
# ignored file sitting on disk is fine and a committed one is not.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail=0
report() { echo "  ✗ $1"; fail=1; }

echo "checking what this repository tracks..."

# --- real source documents ------------------------------------------------
# Everything under a real/ fixtures directory is an operator's own file.
hits="$(git ls-files | grep -E '(^|/)tests/fixtures/real/' || true)"
[[ -n "$hits" ]] && while read -r f; do report "real source document is tracked: $f"; done <<<"$hits"

# --- database dumps -------------------------------------------------------
# A dump is the entire ledger: every amount, every unit, every driver named
# in a staging row.
hits="$(git ls-files | grep -E '\.(dump|sql\.gz|bak)$|(^|/)backups/' || true)"
[[ -n "$hits" ]] && while read -r f; do report "database dump is tracked: $f"; done <<<"$hits"

# --- environment files ----------------------------------------------------
hits="$(git ls-files | grep -E '(^|/)\.env(\..*)?$' | grep -vE '\.example$|\.sample$' || true)"
[[ -n "$hits" ]] && while read -r f; do report "environment file is tracked: $f"; done <<<"$hits"

# --- credentials in file CONTENT -----------------------------------------
# Value shapes, never variable names — `AWS_ACCESS_KEY_ID` appearing in a
# runbook is correct and must not trip this.
scan() {
  local label="$1" pattern="$2"
  local found
  found="$(git grep -nIE "$pattern" -- $(git ls-files | grep -vE '(^|/)scripts/check-repo-hygiene\.sh$') 2>/dev/null || true)"
  if [[ -n "$found" ]]; then
    while read -r line; do report "$label: ${line%%:*}:$(echo "$line" | cut -d: -f2)"; done <<<"$found"
  fi
}

scan "AWS access key id"     'AKIA[0-9A-Z]{16}'
scan "private key block"     'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY'
scan "connection string with an inline password" \
                             '(postgres|postgresql|mysql|mongodb|redis)://[A-Za-z0-9_.-]+:[^@/[:space:]]{3,}@'
scan "GitHub token"          'gh[pousr]_[A-Za-z0-9]{30,}'
scan "Slack token"           'xox[baprs]-[A-Za-z0-9-]{10,}'

if [[ $fail -eq 0 ]]; then
  echo "  ✓ nothing tracked that should not be"
else
  echo
  echo "This repository is public. Remove these before pushing — and remember that" >&2
  echo "deleting a file in a later commit does not remove it from the history." >&2
fi
exit $fail
