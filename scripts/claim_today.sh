#!/usr/bin/env bash
# Claims today's Founder Hub posting slot before any research or Telegram call is made.
# This must run FIRST and must succeed before the routine proceeds. It exists to stop
# duplicate/retried runs from posting the same content to Telegram more than once: the
# claim commit is pushed immediately (before the expensive/user-visible Telegram post),
# so even a run that crashes right after claiming still leaves a record a retry will see.
#
# Usage: claim_today.sh
# Exit 0: slot claimed, safe to proceed.
# Exit 1: already claimed/posted today (or the claim race was lost) - DO NOT post again.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
TODAY="$(date -u +%F)"
POSTS_DIR="posts/${TODAY}"
LOCK_FILE="${POSTS_DIR}/.claimed"

git fetch origin "${BRANCH}" --quiet
git merge --ff-only "origin/${BRANCH}" --quiet 2>/dev/null || true

if [ -d "${POSTS_DIR}" ] && [ -n "$(ls -A "${POSTS_DIR}" 2>/dev/null)" ]; then
    echo "ALREADY POSTED: ${POSTS_DIR} already has content (this run's date is already covered). Refusing to post again today." >&2
    exit 1
fi

mkdir -p "${POSTS_DIR}"
{
    echo "claimed_at_utc=$(date -u +%FT%TZ)"
    echo "branch=${BRANCH}"
} > "${LOCK_FILE}"

git add "${LOCK_FILE}"
git commit -m "Claim Founder Hub posting slot for ${TODAY}" --quiet

if ! git push -u origin "${BRANCH}" --quiet 2>/dev/null; then
    echo "RACE LOST: could not push claim for ${TODAY} (another run likely claimed it first). Pull and check before posting." >&2
    git reset --hard "origin/${BRANCH}" --quiet 2>/dev/null || true
    exit 1
fi

echo "Claimed ${TODAY}. Safe to proceed with research and posting."
