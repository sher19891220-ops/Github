"""Parse a Samsara Integration alert message back into structured fields.

The relay reads messages the existing bot has already rendered, so this is the
inverse of that formatting step. It is inherently coupled to the message
layout: if the sending bot's template changes, this must change with it. That
fragility is the cost of relaying rather than routing at the source.

Target format (video caption in the Samsara Events group):

    ⚠️ Harsh Event

    🚗 Vehicle: 5269 (GZP5W69Z75) 281474991641331
    📅 Time: 2026-08-13 22:08:20
    🗺 Location: I 99;US 220, Allegheny Township, PA, 16648
    📍 Coordinates: 40.449877, -78.421974
    🏃 Speed: 61.0 Mph
    🔗 Incident URL: View Incident
    🆔 36757615-df83-4f8d-8ebb-31a45a92d5be
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# "🚗 Vehicle: ..." — the emoji is optional so the parser survives losing it.
_FIELD = re.compile(
    r"^\s*(?:[^\w\s:]+\s*)?(?P<key>[A-Za-z][A-Za-z ]*?)\s*:\s*(?P<value>.+?)\s*$"
)

# "5269 (GZP5W69Z75) 281474991641331" -> unit, plate, Samsara vehicle ID.
_VEHICLE = re.compile(
    r"^(?P<unit>\S+)"
    r"(?:\s*\((?P<plate>[^)]*)\))?"
    r"(?:\s+(?P<samsara_id>\d{6,}))?\s*$"
)

_COORDS = re.compile(r"^\s*(?P<lat>-?\d+(?:\.\d+)?)\s*,\s*(?P<lon>-?\d+(?:\.\d+)?)\s*$")
_SPEED = re.compile(r"(-?\d+(?:\.\d+)?)")
_URL = re.compile(r"https?://[^\s<>()\[\]]+")
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# Leading emoji/pictographs on the title line.
_LEADING_SYMBOLS = re.compile(r"^[^\w(]+")


@dataclass
class ParsedAlert:
    title: str | None = None
    vehicle_label: str | None = None
    unit: str | None = None
    plate: str | None = None
    samsara_vehicle_id: str | None = None
    time: str | None = None
    location: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    speed_mph: float | None = None
    incident_url: str | None = None
    event_id: str | None = None
    fields: dict[str, str] = field(default_factory=dict)

    @property
    def is_samsara_alert(self) -> bool:
        """True when enough was recognised to route on."""
        return bool(self.vehicle_label and (self.event_id or self.time))


def _split_vehicle(value: str) -> tuple[str | None, str | None, str | None]:
    match = _VEHICLE.match(value.strip())
    if not match:
        return None, None, None
    return match.group("unit"), match.group("plate"), match.group("samsara_id")


def parse_alert(text: str | None, urls: list[str] | None = None) -> ParsedAlert:
    """Parse message text or caption.

    `urls` carries hyperlink targets pulled from Telegram message entities —
    "View Incident" is a link, so its URL is not in the visible text at all.
    """
    alert = ParsedAlert()
    if not text:
        return alert

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        match = _FIELD.match(line)
        if not match:
            # The first unlabelled line is the headline; a bare UUID is the ID.
            if _UUID.search(line):
                alert.event_id = _UUID.search(line).group(0)
            elif alert.title is None:
                alert.title = _LEADING_SYMBOLS.sub("", line).strip() or None
            continue

        key = match.group("key").strip().lower()
        value = match.group("value").strip()
        alert.fields[key] = value

        if key == "vehicle":
            alert.vehicle_label = value
            alert.unit, alert.plate, alert.samsara_vehicle_id = _split_vehicle(value)
        elif key == "time":
            alert.time = value
        elif key == "location":
            alert.location = value
        elif key == "coordinates":
            coords = _COORDS.match(value)
            if coords:
                alert.latitude = float(coords.group("lat"))
                alert.longitude = float(coords.group("lon"))
        elif key == "speed":
            speed = _SPEED.search(value)
            if speed:
                alert.speed_mph = float(speed.group(1))
        elif key in {"incident url", "url"}:
            found = _URL.search(value)
            if found:
                alert.incident_url = found.group(0)

    if alert.event_id is None:
        found = _UUID.search(text)
        if found:
            alert.event_id = found.group(0)

    if alert.incident_url is None and urls:
        samsara = [url for url in urls if "samsara.com" in url]
        alert.incident_url = samsara[0] if samsara else urls[0]

    return alert
