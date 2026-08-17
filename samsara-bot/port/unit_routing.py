"""Per-unit Telegram routing for the Samsara integration.

Drop-in for the existing Django bot. It answers one question — "given this
event, which chats should it go to?" — and leaves sending to the caller, so it
needs no Telegram library and no knowledge of how messages are formatted.

Route at the source rather than relaying: the bot already holds the vehicle
label in structured form, so fanning out here costs one extra send. Parsing a
rendered Telegram message back into fields would be strictly more fragile, and
a second bot could not read those messages anyway — Telegram never delivers a
bot's messages to another bot.

Usage inside the existing send path:

    from unit_routing import Router

    router = Router.from_env()                      # reads UNIT_CHAT_MAP
    for route in router.resolve(vehicle_label, vehicle_id):
        bot.send_video(
            chat_id=route.chat_id,
            message_thread_id=route.thread_id,      # None unless a topic
            video=video_file_or_id,
            caption=caption,
        )

Reusing the same `file_id` across sends means the clip uploads once and is
re-sent instantly to every other destination.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Iterable, Iterator

logger = logging.getLogger(__name__)

# Splits "5269 (GZP5W69Z75) 281474991641331" into its three identifiers.
_SEPARATORS = re.compile(r"[\s()\[\],]+")


def routing_key(value: str) -> str:
    """Normalise an identifier so 'Truck 12', 'truck12' and '#12' all match."""
    return re.sub(r"\s+", "", value).lower().lstrip("#")


def candidate_keys(vehicle_label: str | None, vehicle_id: str | None = None) -> list[str]:
    """Every identifier an event carries, most reliable first.

    Samsara vehicle labels are composite — unit number, plate, then Samsara
    vehicle ID — and dispatch maps units by the number they say out loud, so
    all three become routable.
    """
    keys: list[str] = []
    if vehicle_id:
        keys.append(str(vehicle_id))
    if vehicle_label:
        keys.append(vehicle_label)
        keys.extend(token for token in _SEPARATORS.split(vehicle_label) if token)

    seen: set[str] = set()
    ordered: list[str] = []
    for key in map(routing_key, keys):
        if key and key not in seen:
            seen.add(key)
            ordered.append(key)
    return ordered


@dataclass(frozen=True)
class Destination:
    chat_id: str
    thread_id: int | None = None


@dataclass(frozen=True)
class Route:
    chat_id: str
    thread_id: int | None
    label: str
    kind: str  # "central" | "unit"


def parse_destination(raw: str) -> Destination | None:
    """Accept a bare chat ID, or 'chatId:topicId' for a forum topic."""
    value = str(raw).strip()
    if not value:
        return None

    # A '-100…' chat ID contains no colon, so the last one separates the topic.
    chat_part, separator, thread_part = value.rpartition(":")
    if not separator:
        return Destination(chat_id=value)

    chat_part = chat_part.strip()
    try:
        thread_id = int(thread_part.strip())
    except ValueError:
        logger.warning("Ignoring malformed UNIT_CHAT_MAP destination: %r", value)
        return None
    if not chat_part or thread_id <= 0:
        logger.warning("Ignoring malformed UNIT_CHAT_MAP destination: %r", value)
        return None
    return Destination(chat_id=chat_part, thread_id=thread_id)


def parse_unit_chat_map(raw: str | None) -> dict[str, Destination]:
    """Parse UNIT_CHAT_MAP: {"5269": "-1001111", "1645": "-1002922384236:42"}."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("UNIT_CHAT_MAP is not valid JSON; per-unit routing disabled")
        return {}
    if not isinstance(parsed, dict):
        logger.error("UNIT_CHAT_MAP must be a JSON object of {unit: chat_id}")
        return {}

    table: dict[str, Destination] = {}
    for unit, value in parsed.items():
        if not isinstance(value, (str, int)):
            logger.warning("Ignoring UNIT_CHAT_MAP entry %r: destination is not a scalar", unit)
            continue
        destination = parse_destination(str(value))
        if destination:
            table[routing_key(str(unit))] = destination
    return table


class Router:
    """Resolves an event to the central chat plus, when known, its unit chat."""

    def __init__(
        self,
        central_chat_id: str,
        unit_map: dict[str, Destination] | None = None,
        central_thread_id: int | None = None,
    ) -> None:
        self.central = Destination(str(central_chat_id), central_thread_id)
        self.unit_map = unit_map or {}

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Router":
        source = env if env is not None else os.environ
        topic = source.get("TELEGRAM_TOPIC_ID") or ""
        return cls(
            central_chat_id=source.get("TELEGRAM_CHAT_ID", ""),
            unit_map=parse_unit_chat_map(source.get("UNIT_CHAT_MAP")),
            central_thread_id=int(topic) if topic.strip().isdigit() else None,
        )

    def resolve(self, vehicle_label: str | None, vehicle_id: str | None = None) -> list[Route]:
        routes = [
            Route(self.central.chat_id, self.central.thread_id, "central", "central")
        ]

        keys = candidate_keys(vehicle_label, vehicle_id)
        for key in keys:
            destination = self.unit_map.get(key)
            if destination is None:
                continue
            # Collapse when the unit chat *is* the central one, so the group
            # does not get the same alert twice.
            if destination != self.central:
                routes.append(Route(destination.chat_id, destination.thread_id, key, "unit"))
            return routes

        if self.unit_map and keys:
            logger.warning(
                "No unit destination mapped for vehicle %r (tried %s); central chat only",
                vehicle_label,
                ", ".join(keys),
            )
        return routes
