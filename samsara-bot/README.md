# Samsara → Telegram fleet bot

Pushes Samsara fleet events into a Telegram channel and answers on-demand
questions about vehicles and drivers. Runs as Vercel serverless functions — no
always-on server.

## What it does

**Real-time alerts** (Samsara webhook → Telegram), covering crashes and
rollovers, mobile-phone use, seat-belt violations, speeding and severe speeding,
distracted and drowsy driving, tailgating, harsh braking/acceleration/turns,
rolling stops, unassigned ("unattended") driving, engine faults, panic button
and DVIR defects. Unrecognised event types still get delivered rather than
dropped, with a generic label.

**PTI / DVIR compliance** — a daily report of which vehicles have a submitted
pre-trip inspection, which are missing one, and which came back unsafe or with
open defects. Defect DVIRs also fire as individual alerts.

**On-demand lookups** — Telegram commands:

| Command | What it does |
| --- | --- |
| `/status` | Fleet snapshot: vehicles, active drivers, engines running, units moving |
| `/where <vehicle>` | Last known location, speed and GPS fix time |
| `/vehicle <name\|VIN\|plate>` | Full detail: engine, fuel, odometer, location |
| `/driver <name>` | That driver's HOS clocks |
| `/hos` | Drivers closest to running out of drive time |
| `/safety [hours]` | Safety events in the last N hours (default 12) |
| `/pti` / `/dvir` | Today's pre-trip inspection compliance |
| `/digest` | Yesterday's fleet roll-up |
| `/whoami` | Prints the chat ID and your user ID (useful during setup) |

**Daily digest** — yesterday's safety events by behaviour and by driver,
inspection counts, HOS violations and fleet utilisation.

## Layout

```
api/
  health.ts             GET  — readiness and configuration readout
  bot/setup.ts          GET  — register/inspect/delete the Telegram webhook
  bot/webhook.ts        POST — Telegram updates (commands)
  samsara/webhook.ts    POST — Samsara events → alerts
  cron/safety.ts        Polls safety events (webhook safety net)
  cron/pti.ts           Daily PTI/DVIR compliance report
  cron/digest.ts        Daily fleet digest
src/
  samsara/client.ts     REST client: retries, cursor pagination
  samsara/events.ts     Behaviour taxonomy + payload → FleetAlert normalisation
  telegram/api.ts       Bot API client, 4096-char message splitting
  telegram/commands.ts  Command parsing and handlers
  telegram/format.ts    HTML rendering for alerts and digests
  alerts.ts             Filtering, de-duplication, delivery
  reports.ts            PTI report and daily digest builders
  store.ts              Upstash/Vercel KV with in-memory fallback
  time.ts               Timezone-aware day boundaries
  security.ts           HMAC verification and endpoint auth
```

## Setup

### 1. Samsara

Create an API token under **Settings → Organization → API Tokens** with read
scopes for Vehicles, Drivers, Safety Events, DVIRs and Hours of Service.

### 2. Telegram

Create a bot with [@BotFather](https://t.me/BotFather), add it to your channel
or group as an **administrator**, and note the chat ID (channels look like
`-1001234567890`). If you don't know it, deploy first and send `/whoami`.

### 3. Deploy

```bash
cd samsara-bot
npm install
npx vercel --prod
```

This directory is the deployment root. If the Vercel project is linked to the
repository root instead, set **Root Directory** to `samsara-bot` in the project
settings.

Set the environment variables from [`.env.example`](./.env.example) in the
Vercel project — at minimum `SAMSARA_API_TOKEN`, `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID`.

### 4. Register the Telegram webhook

```
GET https://<your-deployment>/api/bot/setup?secret=<ADMIN_SECRET>
```

Use `&action=info` to inspect the current registration and `&action=delete` to
remove it. The target URL is derived from the request host, so preview
deployments work without extra configuration.

### 5. Point Samsara at the webhook

In Samsara, add a webhook targeting:

```
https://<your-deployment>/api/samsara/webhook
```

Set a secret on it and put the same value in `SAMSARA_WEBHOOK_SECRET`. Then
attach the alert configurations you care about (safety events, DVIR
submissions, unassigned driving, engine faults) to that webhook.

### 6. Verify

```
GET https://<your-deployment>/api/health
```

Returns `200` with a per-variable readout when the required configuration is
present, `503` otherwise.

## Scheduling

`vercel.json` registers three crons: safety polling every 5 minutes, the PTI
report at 13:00 UTC and the digest at 12:00 UTC.

Vercel's Hobby plan only runs cron jobs **once per day** and caps the number of
jobs. On Hobby, change the safety schedule to a daily one — or drop it entirely
and rely on the Samsara webhook, which is the primary path. Cron schedules are
UTC; adjust them for `FLEET_TIMEZONE`.

Vercel authenticates cron invocations with `Authorization: Bearer $CRON_SECRET`.
Set `CRON_SECRET` so the endpoints are not publicly callable. All three cron
endpoints can also be triggered by hand with `?secret=<ADMIN_SECRET>`.

## Filtering alerts

- `ALERT_BEHAVIORS` — comma-separated allow-list of behaviour keys. Empty means
  everything. Keys are listed in `.env.example` and defined in
  `src/samsara/events.ts`.
- `ALERT_MIN_SEVERITY` — `low`, `medium`, `high` or `critical`. Crash, rollover
  and panic button are `critical`; phone use, seat belts, severe speeding,
  drowsy/distracted driving and HOS violations are `high`.

Example — only the incidents that need a same-day response:

```
ALERT_BEHAVIORS=crash,rollover,panicButton,mobileUsage,noSeatbelt,severeSpeeding,unassignedDriving
```

## De-duplication

The Samsara webhook and the safety poller overlap by design: the webhook is
fast, the poller catches anything the webhook missed. Each alert carries a
fingerprint, and `src/alerts.ts` claims that fingerprint before sending.

Without Redis credentials the fingerprints live in per-instance memory, so
duplicates can slip through when Vercel spins up a new instance. Set
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or Vercel KV's
`KV_REST_API_URL` / `KV_REST_API_TOKEN`) to make it reliable. `/api/health`
reports which mode is active as `persistentStore`.

## Security

- Samsara webhooks are HMAC-verified against `SAMSARA_WEBHOOK_SECRET`, with a
  5-minute replay window. **If the variable is unset the endpoint accepts
  anything** — it logs a warning, but set the secret in production.
- Telegram updates are checked against `TELEGRAM_WEBHOOK_SECRET` via the
  `X-Telegram-Bot-Api-Secret-Token` header.
- `TELEGRAM_ALLOWED_USER_IDS` restricts who can run commands. Empty means anyone
  in the chat can.
- Cron and setup endpoints require `CRON_SECRET` or `ADMIN_SECRET`. If neither
  is set they are open, which is only appropriate locally.
- Logs pass through a redactor that masks any field whose name looks like a
  credential.

## Development

```bash
npm install
npm test          # 73 unit tests, no network
npm run typecheck
npm run dev       # vercel dev, needs a .env file
```

Tests cover the behaviour taxonomy, webhook and safety-event normalisation,
HMAC verification and endpoint auth, message rendering and escaping, message
splitting, client retry/pagination, the KV store, command parsing and
timezone/DST day boundaries.

## Verifying against your Samsara org

The endpoint paths and response field names below are written from the
documented API and have **not** been exercised against a live Samsara account.
Before trusting this in production, run the probe:

```bash
SAMSARA_API_TOKEN=... node scripts/verify-samsara.mjs
```

It calls every endpoint the bot depends on and reports, per endpoint: the HTTP
status, whether a `data` array and `pagination` object came back, the field
names on the first row, and any field the bot reads that is absent. It
distinguishes a wrong path (404) from a missing token scope (403), and exits
non-zero if a *required* endpoint fails.

It prints **field names only — never values**, no vehicle or driver names and no
coordinates, so the output is safe to paste into a chat or an issue. The token
is read from the environment rather than argv, keeping it out of shell history.

Anything it flags is a one-line fix in the `ENDPOINTS` map or the matching type
in `src/samsara/types.ts`.

## Notes on the Samsara API

Endpoint paths are collected in `ENDPOINTS` at the top of
`src/samsara/client.ts` so an API change is a one-line edit. Response models in
`src/samsara/types.ts` are deliberately partial — every consumer treats missing
fields as normal, and each digest section fails independently, reporting
`Could not load: …` in place of that section rather than losing the whole
report.

Webhook payloads are normalised defensively: `fromWebhook` flattens the
`data` / `event` / `details` containers and reads from the merged view, so a new
event shape degrades to a generically-labelled alert instead of an exception.
