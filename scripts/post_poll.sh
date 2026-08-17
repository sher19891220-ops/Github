#!/usr/bin/env bash
# Send a Telegram poll to a chat.
# Usage: post_poll.sh "question text" "is_anonymous(true|false)" "allows_multiple_answers(true|false)" "option1" "option2" ...
set -euo pipefail

QUESTION="${1:?question required}"
IS_ANON="${2:?is_anonymous required}"
ALLOWS_MULTI="${3:?allows_multiple_answers required}"
shift 3

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID is not set}"

if [ "$#" -lt 2 ] || [ "$#" -gt 10 ]; then
    echo "ERROR: need between 2 and 10 options, got $#" >&2
    exit 1
fi

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

options_json=$(python3 -c '
import json, sys
print(json.dumps(sys.argv[1:]))
' "$@")

response=$(curl -sS -X POST "${API}/sendPoll" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "question=${QUESTION}" \
    --data-urlencode "options=${options_json}" \
    --data-urlencode "is_anonymous=${IS_ANON}" \
    --data-urlencode "allows_multiple_answers=${ALLOWS_MULTI}")

ok=$(echo "${response}" | grep -o '"ok":[a-z]*' | head -1 | cut -d: -f2)
if [ "${ok}" != "true" ]; then
    echo "ERROR: sendPoll failed: ${response}" >&2
    exit 1
fi
msg_id=$(echo "${response}" | grep -o '"message_id":[0-9]*' | head -1 | cut -d: -f2)
echo "Poll posted. message_id=${msg_id}"
