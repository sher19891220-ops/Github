# Python port — per-unit routing for the existing Django bot

Adds per-unit fan-out to the Django/Celery integration **without** replacing it.
One module, no dependencies, no Telegram library.

## Why here and not a relay bot

The obvious-looking alternative is to add a second bot to the Samsara Events
group, have it read the alerts and forward them onward. That cannot work:
**Telegram never delivers one bot's messages to another bot.** It is a
deliberate platform rule ("bots talking to each other could get stuck in
unwelcome loops"), not a privacy-mode setting, so a relay bot sitting in that
group receives none of the alerts.

Routing at the source is better anyway. The bot already holds the vehicle label
in structured form at the moment it sends, so fanning out costs one extra send —
where a relay would render data to text and regex it back out, breaking whenever
the message format changes.

It also removes the video problem. Telegram returns a `file_id` for the first
upload; re-sending that `file_id` to another chat is instant and re-uploads
nothing. No second retrieval, no waiting on Samsara media, no upload limits.

## Install

Copy `unit_routing.py` next to the module that sends Telegram messages.

## Integrate

At the point that currently sends one message, resolve routes and loop:

```python
from unit_routing import Router

router = Router.from_env()          # reads TELEGRAM_CHAT_ID, UNIT_CHAT_MAP

sent_file_id = None
for route in router.resolve(vehicle_label, vehicle_id):
    message = bot.send_video(
        chat_id=route.chat_id,
        message_thread_id=route.thread_id,   # None unless the chat uses topics
        video=sent_file_id or video_file,    # reuse the file_id after the first send
        caption=caption,
    )
    sent_file_id = sent_file_id or message.video.file_id
```

`vehicle_label` is whatever produces `5269 (GZP5W69Z75) 281474991641331`;
`vehicle_id` is the Samsara ID if you hold it separately.

## Configure

```
TELEGRAM_CHAT_ID=-1002922384236
UNIT_CHAT_MAP={"5269":"-1001111111111","1645":"-1002922384236:42"}
TELEGRAM_TOPIC_ID=            # optional topic in the central group
```

Keys may be the unit number, plate, vehicle name or Samsara vehicle ID — for
`5269 (GZP5W69Z75) 281474991641331`, all three match. Matching ignores case and
spacing. A value is either a chat ID or `chatId:topicId` for a forum topic.

Behaviour:

- An unmapped unit still reaches the central chat, and logs a warning naming the
  vehicle and every key it tried — so gaps surface in the logs instead of
  silently dropping alerts.
- If a unit's destination *is* the central chat, the alert is sent once.
- The Samsara vehicle ID is matched first: names get edited in the dashboard,
  IDs do not.

## Test

```bash
python3 test_unit_routing.py     # 14 tests, no dependencies
pytest test_unit_routing.py      # also works if the project uses pytest
```
