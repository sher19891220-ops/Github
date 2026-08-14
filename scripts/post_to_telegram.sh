#!/usr/bin/env bash
# Post the generated stat card, optionally alongside a real photo/video pulled
# from the source article, followed by the full post text, to a Telegram chat.
#
# Usage:
#   post_to_telegram.sh CARD_PATH CAPTION POST_FILE [PHOTO_URL] [VIDEO_URL]
#
# CARD_PATH   path to the generated stat-card PNG (always sent)
# CAPTION     short caption (<=1024 chars), shown under the first media item
# POST_FILE   path to the full post text
# PHOTO_URL   optional: direct URL to a real photo from the source article
# VIDEO_URL   optional: direct URL to a real, directly-fetchable video file
#             (mp4/mov) from the source article -- NOT a YouTube/embed page
#             link, Telegram must be able to download the raw file itself
#
# When PHOTO_URL and/or VIDEO_URL are given, all media (card + real photo/
# video) is sent together as one Telegram media group (album). When neither
# is given, only the generated card is sent as a single photo (original
# behavior).
set -euo pipefail

CARD_PATH="${1:?card image path required}"
CAPTION="${2:?caption required}"
POST_FILE="${3:?post text file required}"
PHOTO_URL="${4:-}"
VIDEO_URL="${5:-}"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID is not set}"

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

if [ -z "${PHOTO_URL}" ] && [ -z "${VIDEO_URL}" ]; then
    # No extra article media -- send the generated card alone, as before.
    photo_response=$(curl -sS -X POST "${API}/sendPhoto" \
        -F "chat_id=${TELEGRAM_CHAT_ID}" \
        -F "caption=${CAPTION}" \
        -F "photo=@${CARD_PATH}")

    photo_ok=$(echo "${photo_response}" | jq -r '.ok')
    if [ "${photo_ok}" != "true" ]; then
        echo "ERROR: sendPhoto failed: ${photo_response}" >&2
        exit 1
    fi
    photo_msg_id=$(echo "${photo_response}" | jq -r '.result.message_id')
    echo "Photo posted. message_id=${photo_msg_id}"
else
    # Real article media present -- send card + photo/video as one album.
    media_json=$(jq -n --arg cap "${CAPTION}" \
        '[{type: "photo", media: "attach://card", caption: $cap}]')

    if [ -n "${PHOTO_URL}" ]; then
        media_json=$(echo "${media_json}" | jq --arg url "${PHOTO_URL}" \
            '. + [{type: "photo", media: $url}]')
    fi
    if [ -n "${VIDEO_URL}" ]; then
        media_json=$(echo "${media_json}" | jq --arg url "${VIDEO_URL}" \
            '. + [{type: "video", media: $url}]')
    fi

    media_response=$(curl -sS -X POST "${API}/sendMediaGroup" \
        -F "chat_id=${TELEGRAM_CHAT_ID}" \
        -F "card=@${CARD_PATH}" \
        -F "media=${media_json}")

    media_ok=$(echo "${media_response}" | jq -r '.ok')
    if [ "${media_ok}" != "true" ]; then
        echo "ERROR: sendMediaGroup failed: ${media_response}" >&2
        exit 1
    fi
    media_msg_ids=$(echo "${media_response}" | jq -r '[.result[].message_id] | join(",")')
    echo "Media group posted. message_ids=${media_msg_ids}"
fi

post_text=$(cat "${POST_FILE}")
text_response=$(curl -sS -X POST "${API}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${post_text}" \
    --data-urlencode "disable_web_page_preview=false")

text_ok=$(echo "${text_response}" | jq -r '.ok')
if [ "${text_ok}" != "true" ]; then
    echo "ERROR: sendMessage failed: ${text_response}" >&2
    exit 1
fi
text_msg_id=$(echo "${text_response}" | jq -r '.result.message_id')
echo "Text posted. message_id=${text_msg_id}"
