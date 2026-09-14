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

# --- a populated secret in a config file ------------------------------------
#
# Every pattern above matches a VENDOR'S distinctive key shape. Most secrets
# have no such shape: a QuickManage client_secret is thirty-two characters of
# nothing in particular, and this scanner read straight past one. Found by
# planting a real-shaped credentials file and watching the check pass it.
#
# So this rule matches the FIELD NAME rather than the value: a key named like
# a secret, holding a quoted literal that is not a placeholder.
#
# Two things this got wrong first, both worth keeping written down.
#
#   The value must be a QUOTED LITERAL. Without that it fired on
#   `json={"client_secret": client_secret}` and on `const password =
#   generatePassword()` -- code passing a secret around, which is the right
#   way to handle one and exactly what must not be flagged.
#
#   The placeholder filter must apply to the VALUE, not to the grep line.
#   Filtering the whole line meant the path counted too, so any file with
#   "test" or "example" in its name was exempt -- which silently excused the
#   entire tests/ tree. Caught by planting a leak in a file called
#   qm-leak-test.json and watching it pass.
SECRETISH='(client_secret|api_?key|secret_?key|auth_?token|refresh_token|access_token|password|passwd)'
secret_hits="$(git grep -nIE "\"?${SECRETISH}\"?[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9._/+=-]{8,}[\"']" \
                 -- $(git ls-files | grep -vE '(^|/)scripts/check-repo-hygiene\.sh$') 2>/dev/null \
               | awk -F: '{ v = $0; sub(/^[^:]*:[^:]*:/, "", v); v = tolower(v);
                            if (v ~ /x{4,}|\.\.\.|<[^>]*>|your[-_ ]|example|placeholder|changeme|redacted|\$\{/) next;
                            print }' || true)"
if [[ -n "$secret_hits" ]]; then
  while read -r line; do
    [[ -z "$line" ]] && continue
    report "a secret-named field holds a real value: $(echo "$line" | cut -d: -f1,2)"
  done <<<"$secret_hits"
fi

if [[ $fail -eq 0 ]]; then
  echo "  ✓ nothing tracked that should not be"
else
  echo
  echo "This repository is public. Remove these before pushing — and remember that" >&2
  echo "deleting a file in a later commit does not remove it from the history." >&2
fi
exit $fail
