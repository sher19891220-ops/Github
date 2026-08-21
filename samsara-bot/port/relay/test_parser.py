"""Tests for parser.py, built from real Samsara Events messages.

Run: python3 test_parser.py   (no dependencies)
"""

from parser import parse_alert

# Verbatim from the production group (video caption).
REAL = """⚠️ Harsh Event

🚗 Vehicle: 5269 (GZP5W69Z75) 281474991641331
📅 Time: 2026-08-13 22:08:20
🗺 Location: I 99;US 220, Allegheny Township, PA, 16648
📍 Coordinates: 40.449877, -78.421974
🏃 Speed: 61.0 Mph
🔗 Incident URL: View Incident

🆔 36757615-df83-4f8d-8ebb-31a45a92d5be"""

INCIDENT_URL = (
    "https://cloud.samsara.com/o/7002595/fleet/workflows/incidents/"
    "fc6b8c6b-5ecb-42fb-b527-428fdaace4ed/1/281474991641331/1786673300850"
)


def test_parses_every_field():
    a = parse_alert(REAL, urls=[INCIDENT_URL])
    assert a.title == "Harsh Event"
    assert a.vehicle_label == "5269 (GZP5W69Z75) 281474991641331"
    assert a.time == "2026-08-13 22:08:20"
    assert a.location == "I 99;US 220, Allegheny Township, PA, 16648"
    assert a.latitude == 40.449877
    assert a.longitude == -78.421974
    assert a.speed_mph == 61.0
    assert a.event_id == "36757615-df83-4f8d-8ebb-31a45a92d5be"
    assert a.incident_url == INCIDENT_URL


def test_splits_the_composite_vehicle_label():
    a = parse_alert(REAL)
    assert a.unit == "5269"
    assert a.plate == "GZP5W69Z75"
    assert a.samsara_vehicle_id == "281474991641331"


def test_other_real_units():
    a = parse_alert("🚗 Vehicle: 1645 (GCJDZ5Y8AR) 281475003958989")
    assert (a.unit, a.plate, a.samsara_vehicle_id) == ("1645", "GCJDZ5Y8AR", "281475003958989")
    b = parse_alert("🚗 Vehicle: 12878 (GPM5KEDZJ2) 281474992211480")
    assert (b.unit, b.plate, b.samsara_vehicle_id) == ("12878", "GPM5KEDZJ2", "281474992211480")


def test_url_recovered_from_inline_text_form():
    # Telegram's plain-text export renders links as "Label (url)".
    a = parse_alert(f"🔗 Incident URL: View Incident ({INCIDENT_URL})")
    assert a.incident_url == INCIDENT_URL


def test_entity_urls_prefer_samsara():
    a = parse_alert(REAL, urls=["https://example.com/x", INCIDENT_URL])
    assert a.incident_url == INCIDENT_URL


def test_survives_missing_emoji():
    a = parse_alert("Vehicle: 5269 (GZP5W69Z75) 281474991641331\nSpeed: 61.0 Mph")
    assert a.unit == "5269"
    assert a.speed_mph == 61.0


def test_vehicle_without_plate_or_id():
    a = parse_alert("🚗 Vehicle: 5269")
    assert a.unit == "5269"
    assert a.plate is None
    assert a.samsara_vehicle_id is None


def test_is_samsara_alert_gate():
    assert parse_alert(REAL).is_samsara_alert is True
    # Chatter in the group must not be treated as an alert.
    assert parse_alert("Talked to him and instructed him to use a headphone").is_samsara_alert is False
    assert parse_alert("").is_samsara_alert is False
    assert parse_alert(None).is_samsara_alert is False


def test_negative_coordinates_both_signs():
    a = parse_alert("📍 Coordinates: -35.171704, 111.332302")
    assert a.latitude == -35.171704
    assert a.longitude == 111.332302


if __name__ == "__main__":
    import sys

    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  ok   {name}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL {name}: {exc!r}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
