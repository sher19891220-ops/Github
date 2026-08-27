# Samsara → Telegram fleet alerting — project brief

I run a US trucking company. We use **Samsara** for telematics and dashcams, and
**Telegram** for team communication. I need you to build and improve the system
described below. Everything here is established fact from prior analysis —
treat it as the specification, not as guesses to re-verify.

---

## 1. Current state

A Django + Celery service (repo: `firdavsDev/samsara_telegram_integration`)
receives Samsara webhooks and posts safety alerts, with the dashcam clip, into a
Telegram group called **Samsara Events** (chat ID `-1002922384236`, a forum-style
supergroup with topics, 8 members). The posting bot is named "Samsara
Integration".

Stack: Django, Celery worker + beat, Redis, PostgreSQL, Docker Compose, Nginx.

### The exact message it posts today

A video message whose caption is:

```
⚠️ Harsh Event

🚗 Vehicle: 5269 (GZP5W69Z75) 281474991641331
📅 Time: 2026-08-13 22:08:20
🗺 Location: I 99;US 220, Allegheny Township, PA, 16648
📍 Coordinates: 40.449877, -78.421974
🏃 Speed: 61.0 Mph
🔗 Incident URL: View Incident
🆔 36757615-df83-4f8d-8ebb-31a45a92d5be
```

The vehicle field is **composite**: `5269` is our unit number, `GZP5W69Z75` the
plate, `281474991641331` the Samsara vehicle ID. Our team refers to trucks by
unit number.

Incident URLs look like:
`https://cloud.samsara.com/o/7002595/fleet/workflows/incidents/<uuid>/1/<vehicleId>/<epochMs>`
(org ID `7002595`).

### Known defects, measured not assumed

1. **Every alert is titled "Harsh Event"** regardless of what happened —
   including clips that plainly show a driver on his phone, with Samsara's own
   red detection box around the phone. The message never says what occurred, so
   a human must open the video to find out. This is the single highest-value
   fix.
2. **Media retrieval is asynchronous.** Across four consecutive production
   events, the gap between the event timestamp and the message appearing in
   Telegram was 0.8, 1.3, 1.5 and 1.7 minutes (mean 1.3). Any design must
   tolerate a 1–2 minute wait for the clip. This rules out finishing the work
   inside a single short-lived serverless invocation.
3. **The webhook endpoint does not verify signatures.** The project's own setup
   guide lists it under "Security Considerations" as *"consider webhook
   signature verification"* — i.e. unimplemented. The endpoint currently accepts
   unauthenticated POSTs from anyone who learns the URL, meaning fabricated
   crash alerts can be injected.
4. **The documented file-size limit is wrong.** The guide claims 2 GB. The
   hosted Telegram Bot API upload limit is **50 MB** (20 MB when Telegram
   fetches a URL itself); 2000 MB requires a self-hosted Local Bot API server.
   Observed clips are 2–6 seconds, so this has probably not bitten yet, but any
   code sized against 2 GB is a latent bug.
5. **Subscribed event types are incomplete.** Per the setup guide these are:
   `harsh_acceleration, harsh_braking, harsh_turning, speeding, drowsiness,
   distraction, following_distance, seatbelt`. Absent: **crash, mobile/phone
   usage, unassigned ("unattended") driving, rollover, panic button** — several
   of which are exactly what we need.
6. No idempotency is documented. Samsara retries on non-2xx, so a retry likely
   double-posts.

---

## 2. What I want built

### 2.1 Correct event identification (highest priority)
Alerts must name the actual behaviour — "Mobile Phone Usage", "Crash", "Seat
Belt Not Worn", "Severe Speeding", "Unassigned Driving" — not a generic "Harsh
Event". Severity should differ too: a crash is not a harsh turn.

First determine whether Samsara's payload already carries behaviour labels that
the code discards, or whether the webhook subscription itself must change. If
Samsara's own Incidents view shows a specific behaviour for an event that our
Telegram message called "Harsh Event", the data is arriving and being dropped.

Events to cover: crash/accident, rollover, mobile phone usage, seat belt
violations, speeding and severe speeding, distracted driving, drowsy driving,
unassigned/unattended driving, harsh braking/acceleration/turning, tailgating,
rolling stops, engine faults, panic button.

### 2.2 Per-unit fan-out (the main new feature)
Every alert must go to **two** places:
1. the central Samsara Events group, exactly as today, and
2. **that unit's own driver group**, identified from the event.

Routing must key on the unit number (`5269`) since that is what dispatch uses,
while also accepting plate and Samsara vehicle ID. An unmapped unit must still
reach the central group and log a warning naming the truck — never silently
drop. Support forum topics (`message_thread_id`) as destinations, since our
group already uses topics.

The video must reach both groups. Telegram returns a `file_id` on first upload;
re-sending that ID to the second chat is instant and re-uploads nothing, so
Samsara is never asked for the clip twice.

### 2.3 Security
Implement HMAC signature verification on the Samsara webhook with a replay
window, and idempotency so a Samsara retry cannot double-post.

### 2.4 Additional capabilities
- **PTI / DVIR compliance**: daily report of pre-trip inspections submitted,
  vehicles missing one, and DVIRs returned unsafe or with open defects.
- **On-demand Telegram commands**: fleet status, vehicle location, vehicle
  detail, driver HOS clocks, drivers near running out of hours, recent safety
  events, today's PTI status.
- **Daily digest**: yesterday's events by behaviour and by driver, inspection
  counts, HOS violations, utilisation.

---

## 3. Architecture guidance

Keep the Django + Celery stack. It already handles the asynchronous media
retrieval correctly, and it provides the admin, retry and history tooling. A
serverless rewrite was evaluated and rejected specifically because a
short-lived function cannot wait out the measured 1–2 minute clip delay.

Route at the source. The bot already holds the vehicle in structured form at the
moment it sends, so fanning out is one extra send in that function.

**Do not build a relay bot.** Adding a second bot to the events group to read and
forward the alerts cannot work: Telegram never delivers one bot's messages to
another bot, regardless of privacy mode or admin status. Only a user account
(MTProto/userbot) can read them, which carries account-ban risk under Telegram's
terms — a last resort, not a design.

Also note the bot cannot both long-poll for commands and use a webhook; those
conflict with HTTP 409.

---

## 4. Reference implementation available

A complete TypeScript implementation of the alert taxonomy, per-unit routing,
message formatting, signature verification, PTI/DVIR reports and command
handlers already exists, with 109 passing tests, plus a Python port of the
routing logic with 14 tests. It is public at:

`https://github.com/sher19891220-ops/Github`, branch
`claude/samsara-bot-rebuild-a98v12`, under `samsara-bot/`.

Relevant files: `src/samsara/events.ts` (behaviour taxonomy and payload
normalisation), `src/routing.ts` and `port/unit_routing.py` (per-unit routing),
`src/telegram/format.ts` (message layout), `src/security.ts` (HMAC), and
`scripts/discover-samsara.mjs` (probes 29 Samsara endpoints to report what a
token can actually reach). Reuse the logic rather than re-deriving it.

---

## 5. First tasks

1. Read the existing Django repo and report: does the webhook verify signatures;
   are behaviour labels received and discarded or never sent; where exactly is
   `send_video` called; what event types are actually subscribed; is any secret
   committed to git history.
2. Confirm from the Samsara dashboard or API which behaviour labels are
   available for a real event that our bot titled "Harsh Event".
3. Then implement, in order: correct event labelling → webhook signature
   verification → per-unit fan-out → idempotency → PTI/DVIR → commands → digest.

Quote real code with file:line. Where something is missing, say so plainly —
absence is a finding. Ask me before making irreversible changes to the running
production service.

---

## 6. Notes

- A Samsara webhook signing secret was previously exposed and must be treated as
  compromised; assume it needs rotating.
- Never hardcode tokens. Never log tokens, driver PII, or raw payloads.
- The fleet operates in US Eastern time; event timestamps are local, and the
  Samsara incident URL carries the UTC epoch in milliseconds.
