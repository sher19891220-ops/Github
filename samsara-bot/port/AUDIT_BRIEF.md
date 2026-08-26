# Audit brief — `samsara_telegram_integration`

Paste this to whichever agent can read the repo (Claude Desktop with the GitHub
connector, or `claude` inside a local clone). It asks for exactly what this
project needs and nothing else.

---

You are auditing a Django + Celery service that receives Samsara fleet webhooks
and posts safety alerts, with dashcam video, to a Telegram group.

Answer **every** question below. Quote real code with `file:line`. Where
something is absent, say "not present" — absence is a finding, not a gap in the
report. Do not summarise the README; read the source.

## 1. Inventory
- Full file tree, excluding `.venv`, migrations and static assets.
- Entry points: Django apps, Celery tasks, management commands.
- Roughly how many lines of real code, and which files hold the logic.
- Is it complete and runnable, or scaffolded/half-finished? Name anything
  stubbed, `pass`-bodied, or obviously never executed.

## 2. Webhook receiver
- Which view receives Samsara webhooks? Quote it.
- **Is the signature verified?** Any HMAC, shared secret, or IP allow-list? If
  the endpoint accepts unauthenticated POSTs, say so explicitly.
- Is it idempotent? Samsara retries on non-2xx — quote the de-duplication, or
  confirm a retry would post the alert twice.
- What HTTP status does it return, and when?

## 3. Event types
- Exact list of Samsara event types subscribed to (check the webhook-setup
  management command and any config/DB table).
- How is the alert **title** chosen? Every message observed in production reads
  `⚠️ Harsh Event`, including clips that plainly show phone use. Find the code
  that produces that string and explain why it doesn't distinguish behaviours.
- Is `behaviorLabels` (or equivalent) present in the payload and discarded, or
  never received? This decides whether correct labelling is a formatting fix or
  needs a webhook-config change.

## 4. Samsara API client
- Every endpoint called, with full path and API version (`/fleet/...`,
  `/v1/fleet/...`).
- How pagination, retries and rate limits are handled.
- Where the API token is read from.

## 5. Video pipeline — the important one
- Trace the full path from webhook arrival to the clip appearing in Telegram.
- Is media retrieval **asynchronous**? Does it poll or retry until the clip is
  ready? Quote the retry/backoff. Production timings show a 0.8–1.7 minute gap
  between event time and the message landing — find what accounts for it.
- Are clips downloaded to disk then uploaded, or handed to Telegram as a URL?
- **What file-size limit does the code assume?** The docs claim 2 GB. The real
  hosted Bot API limit is 50 MB. Flag any buffer, chunking or validation sized
  against the wrong number.
- What happens when retrieval fails or times out — retry, drop, or silent pass?

## 6. Telegram send path
- Quote the exact `send_video` / `send_message` call and its enclosing function.
- How is the destination chat chosen? Hardcoded, settings, or DB?
- Is the returned `file_id` stored anywhere? (Re-using it makes sending the same
  clip to a second chat instant and free.)
- Does anything support forum topics (`message_thread_id`)?
- Is the bot long-polling for commands, or using a webhook? Both cannot run at
  once — they conflict with HTTP 409.

## 7. Insertion point for per-unit routing
The goal is: each alert goes to the central events group **and** to that unit's
own driver group.
- Name the single function where a per-destination loop should wrap the send.
- Is the vehicle available there in structured form, or only as the rendered
  string `5269 (GZP5W69Z75) 281474991641331`?
- Would adding the loop require changing the video path, or does the same
  `file_id` re-send work?

## 8. Security
- `DEBUG` in production settings.
- **Any secret committed to git history** — run `git log -p -- .env` and grep
  the history for tokens. Report what you find; those need rotating.
- Auth on the Django admin and any management endpoint.
- Anything logging a token, driver PII, or a raw payload.

## 9. Verdict
- Three most valuable changes, most valuable first, each with a rough size.
- Is this codebase a sound base to build on, or is a rewrite warranted? Give a
  straight answer with reasons.

## 10. Paste back verbatim
Return the complete contents of:
1. the Samsara webhook receiver view
2. the Samsara API client
3. the Telegram service (whatever calls `send_video`)
4. the Celery task handling video download/retry
5. `models.py`
6. the webhook-setup management command

**Redact every secret before pasting.** Replace tokens, passwords and keys with
`<REDACTED>`. Do not paste `.env`.
