#!/usr/bin/env bash
# Post a photo (with short caption) followed by the full post text to a Telegram chat.
# Usage: post_to_telegram.sh /path/to/photo.png "caption text" /path/to/full_post.txt
set -euo pipefail

PHOTO_PATH="${1:?photo path required}"
CAPTION="${2:?caption required}"
POST_FILE="${3:?post text file required}"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID is not set}"

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

photo_response=$(curl -sS -X POST "${API}/sendPhoto" \
    -F "chat_id=${TELEGRAM_CHAT_ID}" \
    -F "caption=${CAPTION}" \
    -F "photo=@${PHOTO_PATH}")

photo_ok=$(echo "${photo_response}" | grep -o '"ok":[a-z]*' | head -1 | cut -d: -f2)
if [ "${photo_ok}" != "true" ]; then
    echo "ERROR: sendPhoto failed: ${photo_response}" >&2
    exit 1
fi
photo_msg_id=$(echo "${photo_response}" | grep -o '"message_id":[0-9]*' | head -1 | cut -d: -f2)
echo "Photo posted. message_id=${photo_msg_id}"

post_text=$(cat "${POST_FILE}")
text_response=$(curl -sS -X POST "${API}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${post_text}" \
    --data-urlencode "disable_web_page_preview=false")

text_ok=$(echo "${text_response}" | grep -o '"ok":[a-z]*' | head -1 | cut -d: -f2)
if [ "${text_ok}" != "true" ]; then
    echo "ERROR: sendMessage failed: ${text_response}" >&2
    exit 1
fi
text_msg_id=$(echo "${text_response}" | grep -o '"message_id":[0-9]*' | head -1 | cut -d: -f2)
echo "Text posted. message_id=${text_msg_id}"
