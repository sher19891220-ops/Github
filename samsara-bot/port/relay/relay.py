#!/usr/bin/env python3
"""Relay Samsara alerts from the events group to each unit's driver group.

Runs as a *userbot*: a Telegram user account driven over MTProto (Telethon).
That is a deliberate and load-bearing choice — Telegram never delivers one
bot's messages to another bot, so a bot account placed in the events group
would receive none of the alerts. Only a user account can see them.

Read RELAY_README.md before running this. It uses a real account's credentials
and carries a real account-ban risk under Telegram's terms.

    python3 relay.py --login     # one-time interactive sign-in
    python3 relay.py             # run the relay
    python3 relay.py --dry-run   # log routing decisions, send nothing
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

try:
    from telethon import TelegramClient, events
except ImportError:  # pragma: no cover - dependency guidance
    print("Telethon is required:  pip install telethon", file=sys.stderr)
    raise SystemExit(2)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from unit_routing import Router  # noqa: E402  (path set above)

from parser import parse_alert  # noqa: E402

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(message)s",
)
logger = logging.getLogger("relay")

SESSION = os.environ.get("RELAY_SESSION", "relay.session")


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is not set (see RELAY_README.md)")
    return value


def _entity_urls(message) -> list[str]:
    """Hyperlink targets from message entities.

    "View Incident" is a link, so its URL never appears in the visible text.
    """
    urls: list[str] = []
    for _, entity in (message.get_entities_text() or []):
        url = getattr(entity, "url", None)
        if url:
            urls.append(url)
    return urls


async def build_client() -> TelegramClient:
    return TelegramClient(SESSION, int(_require("TELEGRAM_API_ID")), _require("TELEGRAM_API_HASH"))


async def run(dry_run: bool = False) -> None:
    source_chat = int(_require("SOURCE_CHAT_ID"))
    router = Router.from_env()
    if not router.unit_map:
        logger.warning("UNIT_CHAT_MAP is empty — nothing will be relayed to unit groups")

    client = await build_client()
    await client.start()
    me = await client.get_me()
    logger.info(
        "Relay live as %s (id=%s), watching chat %s%s",
        me.username or me.first_name,
        me.id,
        source_chat,
        " [DRY RUN]" if dry_run else "",
    )

    @client.on(events.NewMessage(chats=source_chat))
    async def on_message(event) -> None:  # pragma: no cover - needs a live account
        message = event.message
        text = message.text or message.message or ""
        alert = parse_alert(text, urls=_entity_urls(message))

        if not alert.is_samsara_alert:
            logger.debug("Ignoring non-alert message %s", message.id)
            return

        routes = [r for r in router.resolve(alert.vehicle_label, alert.samsara_vehicle_id)
                  if r.kind == "unit"]
        if not routes:
            logger.info(
                "Unit %s has no mapped group; leaving alert %s in the events group",
                alert.unit,
                message.id,
            )
            return

        for route in routes:
            if dry_run:
                logger.info(
                    "[dry-run] would relay msg %s (unit %s) -> %s%s",
                    message.id, alert.unit, route.chat_id,
                    f" topic {route.thread_id}" if route.thread_id else "",
                )
                continue
            try:
                # Forwarding re-uses the already-uploaded media: no download,
                # no re-upload, and no second Samsara media retrieval.
                await client.forward_messages(
                    int(route.chat_id),
                    message,
                    **({"top_msg_id": route.thread_id} if route.thread_id else {}),
                )
                logger.info(
                    "Relayed alert %s (unit %s) -> %s", message.id, alert.unit, route.chat_id
                )
            except Exception:
                logger.exception(
                    "Failed relaying alert %s (unit %s) -> %s",
                    message.id, alert.unit, route.chat_id,
                )

    await client.run_until_disconnected()


async def login() -> None:
    client = await build_client()
    await client.start()
    me = await client.get_me()
    print(f"Signed in as {me.username or me.first_name} (id={me.id})")
    print(f"Session saved to {SESSION} — treat this file as a password.\n")
    print("Dialogs this account can see (find your group's ID here):")
    async for dialog in client.iter_dialogs():
        if dialog.is_group or dialog.is_channel:
            print(f"  {dialog.id:>16}  {dialog.name}")
    await client.disconnect()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--login", action="store_true", help="interactive sign-in, then list chat IDs")
    ap.add_argument("--dry-run", action="store_true", help="log decisions without sending")
    args = ap.parse_args()
    asyncio.run(login() if args.login else run(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
