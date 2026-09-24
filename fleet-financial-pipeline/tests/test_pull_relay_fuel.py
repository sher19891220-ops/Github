"""Controls on the Relay Payments live-API scaffold.

No network and no real key here: this only exercises read_credentials()'s
env-over-file precedence and its error messages -- the two things that are
knowable without Relay's own (unreachable) API docs. whoami()/parse_transaction()
hit the network or raise NotImplementedError by design and are not covered here.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))

import pull_relay_fuel as RF   # noqa: E402


def test_the_local_fallback_file_can_never_be_committed():
    """A Relay API key in git history is a real leak, and the file is
    created by hand later -- so the ignore rule has to already be right."""
    key = ROOT / "config/relay_payments_credentials.json"
    r = subprocess.run(["git", "check-ignore", str(key)],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, "config/relay_payments_credentials.json is NOT gitignored"


def test_row_fields_match_ingest_rails_load_relay_shape():
    """parse_transaction() must return exactly the same keys load_relay()
    already produces from Relay's .xlsx exports -- a live-pulled row and a
    file-exported row have to be interchangeable downstream."""
    sys.path.insert(0, str(ROOT / "ingest"))
    import inspect
    import ingest_rails as IR
    src = inspect.getsource(IR.load_relay)
    for field in RF.ROW_FIELDS:
        assert f'"{field}"' in src, f"{field!r} missing from ingest_rails.load_relay()"


def test_missing_credentials_fail_with_setup_instructions(monkeypatch, tmp_path):
    """The failure a new container hits first. It must say what to do, not
    raise a raw exception from inside urllib."""
    monkeypatch.setattr(RF, "CREDS", tmp_path / "absent.json")
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials()
    msg = str(e.value)
    assert RF.ENV_VAR_PROD in msg
    assert "relay_payments_credentials" in msg


def test_missing_staging_credentials_name_the_staging_env_var(monkeypatch, tmp_path):
    monkeypatch.setattr(RF, "CREDS", tmp_path / "absent.json")
    monkeypatch.delenv(RF.ENV_VAR_STAGING, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials(use_staging=True)
    assert RF.ENV_VAR_STAGING in str(e.value)


def _env(monkeypatch, value, use_staging=False):
    var = RF.ENV_VAR_STAGING if use_staging else RF.ENV_VAR_PROD
    monkeypatch.setenv(var, value)
    monkeypatch.setattr(RF, "CREDS", Path("/nonexistent/relay_payments_credentials.json"))


def test_the_environment_key_loads(monkeypatch):
    _env(monkeypatch, "iak_fake_test_key_not_real")
    key, where = RF.read_credentials()
    assert key == "iak_fake_test_key_not_real"
    assert where == f"${RF.ENV_VAR_PROD}"


def test_the_staging_environment_key_loads_separately(monkeypatch):
    _env(monkeypatch, "iak_fake_staging_key_not_real", use_staging=True)
    key, where = RF.read_credentials(use_staging=True)
    assert key == "iak_fake_staging_key_not_real"
    assert where == f"${RF.ENV_VAR_STAGING}"


def test_the_environment_beats_the_file(monkeypatch, tmp_path):
    """The container is ephemeral; the env var is the durable one. A stale
    file left over from an older setup must not silently win."""
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text(json.dumps({"api_key": "iak_stale_file_key_not_real"}))
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.setenv(RF.ENV_VAR_PROD, "iak_fresh_env_key_not_real")
    key, where = RF.read_credentials()
    assert key == "iak_fresh_env_key_not_real"
    assert where == f"${RF.ENV_VAR_PROD}"


def test_the_file_is_used_when_the_env_var_is_unset(monkeypatch, tmp_path):
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text(json.dumps({"api_key": "iak_file_only_key_not_real"}))
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    key, where = RF.read_credentials()
    assert key == "iak_file_only_key_not_real"
    assert where == str(f)


def test_malformed_json_file_is_named_as_invalid(monkeypatch, tmp_path):
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text("this is neither json nor a key")
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials()
    assert "not valid JSON" in str(e.value)


def test_file_missing_the_field_is_named_by_field(monkeypatch, tmp_path):
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text(json.dumps({"staging_api_key": "iak_only_staging_not_real"}))
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials()
    assert "api_key" in str(e.value)


def test_no_error_message_ever_contains_key_material(monkeypatch, tmp_path):
    """A stack trace or error string carrying the real key would leak it into
    logs, transcripts and terminal scrollback."""
    secret = "iak_super_secret_value_should_never_leak_ABCDEF123456"
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text(json.dumps({"api_key": secret, "_junk": "not json"})[:-1])
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials()
    assert secret not in str(e.value)

    empty_field_file = tmp_path / "empty_field.json"
    empty_field_file.write_text(json.dumps({"api_key": "  "}))
    monkeypatch.setattr(RF, "CREDS", empty_field_file)
    with pytest.raises(SystemExit) as e2:
        RF.read_credentials()
    assert secret not in str(e2.value)


# ---------------------------------------------------------------------------
# parse_transaction() -- fixtures below mirror the REAL structures observed
# in a systematic 933-transaction, 14-day live batch (2026-09-24), with all
# driver/id/location values replaced by fabricated ones. Real finding that
# shape this: 565/933 had exactly 2 fuel_items (diesel + DEF, every time),
# 358 had 1, 6 had 3, 4 had 0 with a product instead; total_amount_paid
# equaled sum(fuel_items total_discounted_price) + sum(products
# purchase_price_total) for 933/933, with fees/fee never additive.

def _fuel_item(fuel_type, description, retail_pu, disc_pu, volume, fee_amount=None):
    total_retail = round(retail_pu * volume, 2)
    total_disc = round(disc_pu * volume, 2)
    item = {"fuel_type": fuel_type, "fuel_type_description": description,
            "fuel_product_code": "020", "retail_price_per_unit": str(retail_pu),
            "discounted_price_per_unit": str(disc_pu), "volume": str(volume),
            "volume_uom": "gallons", "total_retail_price": str(total_retail),
            "total_discounted_price": str(total_disc)}
    if fee_amount is not None:
        item["fee"] = {"type": "sender_fee", "amount": str(fee_amount)}
    return item


def _txn(fuel_items=(), products=(), fees=(), truck="4713"):
    prompts = [{"label": "Truck #", "value": truck}] if truck else []
    return {
        "transaction_id": "txn_FAKE001", "created_at": "2026-09-24T03:13:13Z",
        "total_amount_paid": str(round(
            sum(float(fi["total_discounted_price"]) for fi in fuel_items)
            + sum(float(p["purchase_price_total"]) for p in products), 2)),
        "total_retail_price": "0", "total_amount_saved": "0",
        "is_direct_bill": False, "currency_code": "USD", "cash_advance": "0.00",
        "merchant": {"id": "org_x", "name": "Pilot", "number": "1"},
        "location": {"id": "loc_x", "name": "Pilot #1", "city": "Lost Hills", "state": "CA"},
        "prompts": prompts,
        "fuel_items": list(fuel_items), "products": list(products), "fees": list(fees),
        "driver": {"id": "dr_x", "first_name": "Test", "last_name": "Driver",
                   "integration_id": "1234567890"},
        "linked_org": {"id": "org_y", "name": "ZONE-OH LLC", "number": "2"},
    }


def test_parse_transaction_single_fuel_item_reconciles():
    txn = _txn(fuel_items=[_fuel_item("diesel", "Diesel", 7.199, 6.137, 99.022, fee_amount="2.00")],
                fees=[{"type": "sender_fee", "amount": "2.00"}])
    rows = RF.parse_transaction(txn, "src")
    assert len(rows) == 1
    assert rows[0]["amount"] == pytest.approx(-float(txn["total_amount_paid"]), abs=0.01)
    assert rows[0]["fee"] == pytest.approx(2.00)


def test_parse_transaction_two_fuel_items_returns_two_rows_summing_to_paid():
    """The majority real case: diesel + DEF on one fill, fee only on diesel."""
    diesel = _fuel_item("diesel", "Diesel", 8.259, 7.812, 94.080, fee_amount="2.00")
    de_f = _fuel_item("def", "Def", 4.899, 4.899, 4.761)
    txn = _txn(fuel_items=[diesel, de_f], fees=[{"type": "sender_fee", "amount": "2.00"}])
    rows = RF.parse_transaction(txn, "src")
    assert len(rows) == 2
    assert sum(r["amount"] for r in rows) == pytest.approx(-float(txn["total_amount_paid"]), abs=0.01)
    # fee is attached only to the item that actually carried it
    fees = sorted((r["fuel_item"], r["fee"]) for r in rows)
    assert ("Def", None) in fees
    assert ("Diesel", 2.00) in fees


def test_parse_transaction_fee_is_never_added_to_amount():
    """Settled from the real batch: fees/fee are informational, never
    additive -- confirmed 933/933, zero exceptions."""
    txn = _txn(fuel_items=[_fuel_item("diesel", "Diesel", 7.199, 6.137, 99.022, fee_amount="2.00")],
                fees=[{"type": "sender_fee", "amount": "2.00"}])
    rows = RF.parse_transaction(txn, "src")
    fuel_item = txn["fuel_items"][0]
    assert rows[0]["amount"] == pytest.approx(-float(fuel_item["total_discounted_price"]), abs=0.01)


def test_parse_transaction_product_only_transaction():
    """Real case: a CAT Scale weigh charge with zero fuel_items."""
    product = {"product_type": "scales", "product_type_description": "CAT Scales",
               "price_per_unit": "5.250", "quantity": "1.000",
               "purchase_price_total": "5.25", "fee": {"type": "sender_fee", "amount": "1.50"}}
    txn = _txn(products=[product], fees=[{"type": "sender_fee", "amount": "1.50"}])
    rows = RF.parse_transaction(txn, "src")
    assert len(rows) == 1
    assert rows[0]["type"] == "Product"
    assert rows[0]["product"] == "CAT Scales"
    assert rows[0]["fuel_item"] is None
    assert rows[0]["amount"] == pytest.approx(-5.25)


def test_parse_transaction_extracts_truck_from_prompts():
    txn = _txn(fuel_items=[_fuel_item("diesel", "Diesel", 7.0, 6.5, 50)], truck="9001")
    rows = RF.parse_transaction(txn, "src")
    assert rows[0]["truck"] == "9001"


def test_parse_transaction_missing_truck_prompt_is_none_not_guessed():
    txn = _txn(fuel_items=[_fuel_item("diesel", "Diesel", 7.0, 6.5, 50)], truck=None)
    rows = RF.parse_transaction(txn, "src")
    assert rows[0]["truck"] is None


def test_parse_transaction_odometer_is_always_none():
    """Confirmed absent from Relay's schema entirely -- never guessed."""
    txn = _txn(fuel_items=[_fuel_item("diesel", "Diesel", 7.0, 6.5, 50)])
    rows = RF.parse_transaction(txn, "src")
    assert rows[0]["odometer"] is None


def test_parse_transaction_rows_match_row_fields_exactly():
    txn = _txn(fuel_items=[_fuel_item("diesel", "Diesel", 7.0, 6.5, 50)])
    rows = RF.parse_transaction(txn, "src")
    assert set(rows[0].keys()) == set(RF.ROW_FIELDS)


def test_pull_transactions_raises_on_non_200(monkeypatch):
    """Never returns partial or fabricated rows on a bad response."""
    monkeypatch.setattr(RF, "_probe", lambda url, key=None: (403, b'{"message":"Access denied"}'))
    with pytest.raises(SystemExit) as e:
        RF.pull_transactions("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z")
    assert "403" in str(e.value)
