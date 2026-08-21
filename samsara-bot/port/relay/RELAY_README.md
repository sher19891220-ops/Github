# Relay: Samsara Events group → per-unit driver groups

Watches the Samsara Events group, parses each alert, works out which unit it
belongs to, and forwards it to that unit's driver group.

## Read this first

**This runs as a userbot — a real Telegram user account, not a bot.** That is
forced, not a preference: Telegram never delivers one bot's messages to another
bot, so a bot placed in the events group receives none of the alerts. Only a
user account can see them.

Consequences you are accepting:

- **Account ban risk.** Automating a user account is against Telegram's terms.
  Enforcement is inconsistent, but the risk is real and the loss is the whole
  account. Use a **dedicated account on a spare number**, never a personal one
  and never the account that administers your groups.
- **The session file is a full account credential.** `relay.session` grants
  complete access to that account — no password prompt, no 2FA. Treat it like a
  private key: `chmod 600`, never commit it, never put it in an image layer.
- **Always-on host required.** MTProto holds a long-lived connection, so this
  cannot run on Vercel or any serverless platform. A small VPS or container.
- **Coupled to message formatting.** It parses text the other bot rendered. The
  day someone reorders a field in the sending bot, this breaks.

The alternative — adding routing where the alert is *sent*, in the Django bot —
avoids every one of these. See `../README.md`. This exists because you asked for
the relay path specifically.

## What it can and cannot do

**Can:** identify the unit (`5269`), the plate, the Samsara vehicle ID,
timestamp, location, coordinates, speed, incident URL and event ID — and forward
the message, video included, to the right group.

**Cannot: identify what actually happened.** Every alert your integration sends
is titled `Harsh Event`, whether the clip shows phone use, a seat-belt
violation or hard braking. That information is not in the message, so no parser
can recover it. Relaying faithfully reproduces that blind spot.

To get real event types you must either fix the sending bot, or have the relay
call the Samsara API with the incident ID to look up the behaviour labels —
which means an API token, at which point routing at the source is simpler.

Forwarding re-uses the already-uploaded video. Nothing is downloaded or
re-uploaded, and Samsara is never asked for the clip a second time — so the
~1.3 minute media-retrieval delay is paid once, by the original bot.

## Setup

### 1. Telegram application credentials

Sign in at [my.telegram.org](https://my.telegram.org) → **API development
tools** → create an application. Note the `api_id` and `api_hash`. This is an
*application* credential, unrelated to BotFather.

### 2. Account

Use a dedicated Telegram account, and add it as a **member** of:

- the Samsara Events group (read), and
- every driver group it will forward into (write).

### 3. Install

```bash
pip install -r requirements.txt
```

### 4. Sign in once

```bash
export TELEGRAM_API_ID=...
export TELEGRAM_API_HASH=...
python3 relay.py --login
```

It prompts for the phone number and the login code, writes `relay.session`,
then prints every group that account can see **with its chat ID** — which is how
you fill in the next step.

```bash
chmod 600 relay.session
```

### 5. Configure

```bash
export SOURCE_CHAT_ID=-1002922384236          # the Samsara Events group
export UNIT_CHAT_MAP='{"5269":"-1001111111111","1645":"-1002922384236:42"}'
```

Keys may be the unit number, plate, vehicle name or Samsara vehicle ID — for
`5269 (GZP5W69Z75) 281474991641331` all three match, so key by the unit number
dispatch actually uses. A value is a chat ID, or `chatId:topicId` for a forum
topic.

`TELEGRAM_CHAT_ID` is not needed here: the alert is already in the events group,
so the relay only sends to *unit* destinations.

### 6. Verify before going live

```bash
python3 relay.py --dry-run
```

Trigger a real event (or wait for one) and confirm the log shows the right unit
resolving to the right group. Then drop `--dry-run`.

### 7. Run it

```bash
python3 relay.py
```

Under systemd or Docker with a restart policy — a dropped MTProto connection
must come back on its own.

## Test

```bash
python3 test_parser.py     # 9 tests against real captured messages
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No messages at all | The account is not in the source group, or `SOURCE_CHAT_ID` is wrong. `--login` lists the real IDs. |
| "Ignoring non-alert message" for real alerts | The sending bot's format changed. Capture the new text and update `parser.py` and its tests. |
| "no mapped group" | That unit is missing from `UNIT_CHAT_MAP`. The log names the unit. |
| Forward fails with permissions error | The account is not a member of the destination group, or lacks send rights. |
| Account logged out unexpectedly | Telegram may have flagged the automation. This is the risk named above. |
