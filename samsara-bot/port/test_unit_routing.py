"""Tests for unit_routing. No dependencies: run `python3 test_unit_routing.py`.

Also runs under pytest if the project already uses it.
"""

from unit_routing import (
    Destination,
    Router,
    candidate_keys,
    parse_destination,
    parse_unit_chat_map,
    routing_key,
)

# The exact label format seen in the live Samsara Events group.
REAL = "5269 (GZP5W69Z75) 281474991641331"
CENTRAL = "-1002922384236"


def test_routing_key_normalises():
    assert routing_key("Truck 12") == "truck12"
    assert routing_key("  TRUCK  12 ") == "truck12"
    assert routing_key("#281") == "281"


def test_candidate_keys_splits_composite_label():
    keys = candidate_keys(REAL, "281474991641331")
    assert "5269" in keys
    assert "gzp5w69z75" in keys
    assert "281474991641331" in keys
    # Samsara vehicle ID is the most stable identifier, so it is tried first.
    assert keys[0] == "281474991641331"


def test_candidate_keys_deduplicates_and_handles_empty():
    assert candidate_keys("5269", "5269") == ["5269"]
    assert candidate_keys(None, None) == []
    assert "truck12" in candidate_keys("Truck 12")


def test_parse_destination_reads_topics():
    assert parse_destination("-1001234567890") == Destination("-1001234567890")
    assert parse_destination("-1002922384236:42") == Destination("-1002922384236", 42)


def test_parse_destination_rejects_malformed():
    assert parse_destination("-100123:abc") is None
    assert parse_destination("-100123:0") is None
    assert parse_destination("  ") is None


def test_parse_unit_chat_map():
    table = parse_unit_chat_map('{"5269":"-1001","1645":"-1002922384236:42"}')
    assert table["5269"] == Destination("-1001")
    assert table["1645"] == Destination("-1002922384236", 42)
    assert parse_unit_chat_map(None) == {}
    assert parse_unit_chat_map("not json") == {}
    assert parse_unit_chat_map('["a"]') == {}


def test_parse_unit_chat_map_skips_bad_entries():
    table = parse_unit_chat_map('{"5269":{"chat":"-1001"},"1645":"-1002"}')
    assert "5269" not in table
    assert table["1645"] == Destination("-1002")


def test_resolve_always_includes_central():
    routes = Router(CENTRAL).resolve(REAL)
    assert len(routes) == 1
    assert routes[0].kind == "central"


def test_resolve_routes_by_unit_number():
    router = Router(CENTRAL, parse_unit_chat_map('{"5269":"-1001"}'))
    routes = router.resolve(REAL)
    assert [r.chat_id for r in routes] == [CENTRAL, "-1001"]
    assert routes[1].kind == "unit"
    assert routes[1].label == "5269"


def test_resolve_routes_to_a_forum_topic():
    router = Router(CENTRAL, parse_unit_chat_map('{"1645":"-1002922384236:42"}'))
    routes = router.resolve("1645 (GCJDZ5Y8AR) 281475003958989")
    assert routes[1].chat_id == "-1002922384236"
    assert routes[1].thread_id == 42


def test_resolve_prefers_samsara_id_when_mapped():
    router = Router(CENTRAL, parse_unit_chat_map('{"281474992211480":"-1003","12878":"-1004"}'))
    routes = router.resolve("12878 (GPM5KEDZJ2) 281474992211480", "281474992211480")
    assert routes[1].chat_id == "-1003"


def test_resolve_does_not_double_send():
    router = Router("-1001", parse_unit_chat_map('{"5269":"-1001"}'))
    assert len(router.resolve(REAL)) == 1


def test_resolve_central_only_for_unmapped_unit():
    router = Router(CENTRAL, parse_unit_chat_map('{"5269":"-1001"}'))
    assert len(router.resolve("9999 (ABC1234) 281474000000000")) == 1


def test_from_env():
    router = Router.from_env(
        {"TELEGRAM_CHAT_ID": CENTRAL, "UNIT_CHAT_MAP": '{"5269":"-1001"}', "TELEGRAM_TOPIC_ID": "7"}
    )
    routes = router.resolve(REAL)
    assert routes[0].thread_id == 7
    assert routes[1].chat_id == "-1001"


if __name__ == "__main__":
    import sys

    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    failures = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  ok   {name}")
        except AssertionError as exc:
            failures += 1
            print(f"  FAIL {name}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
