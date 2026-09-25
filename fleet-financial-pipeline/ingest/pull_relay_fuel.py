"""Pull fuel transactions straight from Relay Payments' API, no manual export.

WHY THIS SHAPE. `ingest/ingest_rails.py`'s `load_relay()` already reads Relay's
own .xlsx exports and produces one row per transaction: source_file, txn_id,
txn_date, merchant, state, city, driver, truck, odometer, type, sub_type,
product, fuel_item, amount, fee, gallons, retail_price, discounted_price,
discount_per_gal, discount. This module's job is to produce THE SAME SHAPE
from the live API instead of a manually-downloaded file -- so a caller that
already handles one Relay row shape can handle both, and nothing downstream
has to know whether a transaction arrived by upload or by API call.

THIS FILE IS A SCAFFOLD, NOT A FINISHED INTEGRATION -- SAID PLAINLY RATHER
THAN HIDDEN. `read_credentials()`, the env-var-over-file pattern, and the
never-print-key-material discipline below are complete and match this
project's other credential-handling modules (see `pull_sheets.py`) -- kept as
a fallback for running this pipeline somewhere without the mechanism below.

THIS WAS ALL UNCONFIRMED UNTIL 2026-09-24, when a second environment
credential (Basic auth, docs-portal login) unlocked the real docs portal at
docs.relaypayments.com. It renders Relay's own OpenAPI spec (tmsfuel.yaml) via
Redoc, and that spec is now the source of truth for everything below -- not a
guess. Key facts pulled directly from it:

  - Real servers: `https://app.relaypayments.com` (production) and
    `https://staging.relaypayments.com` (QA), NOT `api.relaypayments.com`,
    which this module guessed earlier and confirmed live-but-wrong (real
    HTTP responses, including the Relay-branded `X-Relay-Requestid` header,
    but 404 on every path tried -- see docs/FINDINGS.md, 2026-09-23).
  - Real transactions endpoint: `GET /api/fuel/transactions/` with two
    REQUIRED query params, `dtstart` and `dtend`, both RFC3339 timestamps.
    Confirmed reachable: a live call returned HTTP 403 `{"message": "Access
    denied"}` -- a real auth decision from Relay's backend, not a routing
    404, which is what "the path is right, something about the credential
    isn't" looks like from outside.
  - Real auth scheme: `securitySchemes.ApiKeyAuth` is `type: apiKey, in:
    header, name: Authorization` -- NOT an HTTP Bearer scheme. That means
    Relay most likely wants the raw key as the ENTIRE header value
    (`Authorization: <key>`), not `Authorization: Bearer <key>`. The 403
    above is most likely explained by exactly that mismatch: this
    environment's API-credential setup currently sends a `Bearer ` prefix.

THE CREDENTIAL MECHANISM is still this Claude Code environment's own "API
credentials" feature (environment settings -> API credentials): the operator
registered RELAY_PAYMENTS_API_KEY there, with a proxy-injected `Authorization`
header on every request to the allowed host. A session run in that
environment NEVER holds or sees the raw key in this mode -- `whoami()` below
sends no auth header of its own, and the proxy attaches the real one in
transit. This is a stronger guarantee than an env var (which code can still
read directly), so it is tried first; the env-var/file path below only
matters if RELAY_PAYMENTS_API_KEY happens to also be set as an ordinary
variable somewhere else this runs.

  - `whoami()` below calls the now-CONFIRMED transactions endpoint with a
    real date range. CONFIRMED WORKING as of 2026-09-24: HTTP 200 with real
    transaction rows, once the environment credential's `Authorization`
    header was sent with NO `Bearer ` prefix (raw key value only) -- proving
    the apiKey-scheme read above was correct, not just a plausible guess.
  - Two more things the operator's original message asked about are now
    answered from a REAL observed transaction, not the schema alone:
      * Truck number: NOT a dedicated field, but present -- Relay's fuel
        code flow has the driver enter it at the pump, and it comes back
        under `prompts`: `{"label": "Truck #", "value": "5007"}` (label text
        confirmed exact; do not match on a different label without seeing
        another sample first, in case Relay's UI wording varies by fuel
        policy).
      * Company/entity: `linked_org.name` on the transaction itself (e.g.
        `"ZONE-OH LLC"`) -- matches this fleet's own entity table (ZONE-OH
        LLC is ZONE's alternate name in CLAUDE.md) directly, no mapping step
        needed.
  - `parse_transaction()` is now IMPLEMENTED, as of 2026-09-24, backed by a
    real 933-transaction, 14-day batch pulled and checked systematically
    (not eyeballed from one example): 565 had exactly 2 `fuel_items`
    (diesel + DEF, every time), 358 had 1, 6 had 3, and 4 had 0 with a
    `products` entry instead (e.g. a CAT Scale weigh fee). The fee question
    is SETTLED: for all 933/933, `total_amount_paid` equals exactly
    `sum(fuel_items[].total_discounted_price) + sum(products[].
    purchase_price_total)` -- zero exceptions, zero unexplained mismatches.
    `fees`/the per-item nested `fee` are informational and never additive.
    Because `ROW_FIELDS` has singular `fuel_item`/`gallons`/`fee`/`product`
    fields against what the live schema confirms are arrays,
    `parse_transaction()` returns a LIST of rows per transaction (one per
    fuel item, one per product) rather than a single dict -- each row's
    `amount` is that specific item's own total, so the rows for one
    transaction sum to exactly `total_amount_paid`, and the per-item nested
    `fee` (when present) is carried informationally on that row without
    changing `amount`, matching how `ingest_rails.load_relay()` already
    treats `fee` as a separate column from `amount`.
  - Also confirmed, not guessed: there is no odometer field anywhere on a
    transaction. The only per-driver identifier is `driver.integration_id`,
    matching what the operator described as "the Relay Driver ID which acts
    like a card # in TMS" -- still needs a mapping to this fleet's own
    driver roster from outside this API if that id is ever needed directly
    (the `prompts`-based Truck # above may make it unnecessary for costing).

THE KEY LIVES IN AN ENVIRONMENT VARIABLE, NOT A FILE, same reasoning as
pull_sheets.py: this container is ephemeral, and a key on disk has to be
re-uploaded every time it is reclaimed.

    RELAY_PAYMENTS_API_KEY            production key
    RELAY_PAYMENTS_STAGING_API_KEY    staging/sandbox key (lower risk to test with)

A file at config/relay_payments_credentials.json still works as a local
fallback (gitignored, matches config/*_credentials.json) -- see
config/relay_payments_credentials.example.json for its shape.

NO ERROR MESSAGE MAY EVER CONTAIN KEY MATERIAL. Every error below names only
the env var, the file path, or the field that was missing -- never a value.

Then:  python3 ingest/pull_relay_fuel.py --whoami
           # proves whichever key is set loads, makes ONE cheap call, prints
           # nothing but confirmation or a named failure -- no key material.
       python3 ingest/pull_relay_fuel.py --pull --since 2026-09-01 --until 2026-09-07 \\
           --outdir data/processed
           # Fetches, flattens (see parse_transaction() above), and writes
           # data/processed/relay_txns_api.csv -- a DELIBERATELY separate
           # filename from ingest_rails.py's relay_txns.csv (the manual
           # .xlsx-export path), so a live pull can never silently overwrite
           # or get overwritten by that one; merging the two is a decision
           # for whoever writes the downstream loader, not guessed here.
"""
import argparse
import csv
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CREDS = ROOT / "config" / "relay_payments_credentials.json"
ENV_VAR_PROD = "RELAY_PAYMENTS_API_KEY"
ENV_VAR_STAGING = "RELAY_PAYMENTS_STAGING_API_KEY"

# CONFIRMED from Relay's own OpenAPI spec (docs.relaypayments.com/tmsfuel.yaml,
# fetched 2026-09-24) -- not a guess. api.relaypayments.com (this module's
# earlier guess) is a real, live Relay host but not this one; every path
# tried against it 404'd.
BASE_URL_PROD = "https://app.relaypayments.com"
BASE_URL_STAGING = "https://staging.relaypayments.com"

# CONFIRMED: GET /api/fuel/transactions/ with two REQUIRED RFC3339 query
# params, dtstart and dtend. A live call returned HTTP 403 {"message":
# "Access denied"} -- the path is real; see the module docstring for why
# that's most likely the credential's Bearer prefix, not a wrong path.
TRANSACTIONS_ENDPOINT = "/api/fuel/transactions/"

# The row shape ingest_rails.py's load_relay() already produces from Relay's
# .xlsx exports -- parse_transaction() must return a dict with exactly these
# keys so a live-pulled row and a file-exported row are interchangeable.
ROW_FIELDS = ("source_file", "txn_id", "txn_date", "merchant", "state", "city",
              "driver", "truck", "odometer", "type", "sub_type", "product",
              "fuel_item", "amount", "fee", "gallons", "retail_price",
              "discounted_price", "discount_per_gal", "discount")


def read_credentials(use_staging=False):
    """Env var wins over the local fallback file, same order as
    pull_sheets.read_credentials(). Returns just the API key string --
    never logged, never echoed, never written back to disk by this module.
    """
    env_var = ENV_VAR_STAGING if use_staging else ENV_VAR_PROD
    key = os.environ.get(env_var, "").strip()
    where = f"${env_var}"
    if key:
        return key, where

    if not CREDS.exists():
        raise SystemExit(
            f"No Relay Payments key: ${env_var} is unset and there is no file at "
            f"{CREDS}.\n\nSet the environment variable on this environment's own "
            f"settings (see this module's docstring), or copy "
            f"config/relay_payments_credentials.example.json to "
            f"{CREDS.name} and fill it in locally.")

    try:
        info = json.loads(CREDS.read_text())
    except json.JSONDecodeError as e:
        raise SystemExit(f"{CREDS} is not valid JSON ({e}). No key material printed.")

    field = "staging_api_key" if use_staging else "api_key"
    key = (info.get(field) or "").strip()
    if not key:
        raise SystemExit(f"{CREDS} has no non-empty \"{field}\" field.")
    return key, str(CREDS)


def _probe(url, key=None):
    """One GET against a live Relay endpoint. `key`, if given, is sent as the
    RAW Authorization header value -- per the real OpenAPI spec's
    `securitySchemes.ApiKeyAuth` (`type: apiKey, in: header, name:
    Authorization`), which is NOT an HTTP Bearer scheme, so no `Bearer `
    prefix is added here. Without `key`, no auth header is set at all,
    relying entirely on this environment's own proxy to inject one for the
    allowed host -- if that proxy credential still sends a `Bearer ` prefix,
    expect HTTP 403 `{"message": "Access denied"}` (confirmed live 2026-09-24;
    see module docstring) until its Prefix field is cleared in environment
    settings. Reads the ENTIRE response body -- a transactions pull is easily
    tens of KB, and a truncated read here produced invalid JSON that
    pull_transactions() then crashed on trying to parse (caught 2026-09-25,
    once a real multi-transaction week was pulled through this path instead
    of the single-transaction whoami() preview that never exceeded a couple
    KB). Callers that only want a short preview (whoami()) truncate the
    DECODED TEXT for display, not the read itself. Never raises: returns
    (status_or_None, body_bytes)."""
    import urllib.error
    import urllib.request
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = key
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        return None, str(e.reason).encode()


def whoami(dtstart=None, dtend=None):
    """Calls the now-CONFIRMED transactions endpoint (see module docstring)
    with a real date range and reports exactly what comes back. Never prints
    key material -- in the environment-credential mode there usually isn't
    any in this process to print at all.

    Defaults to the last 7 days if dtstart/dtend aren't given -- both are
    REQUIRED RFC3339 timestamps per the spec.
    """
    import datetime
    if dtend is None:
        dtend = datetime.datetime.now(datetime.timezone.utc)
    if dtstart is None:
        dtstart = dtend - datetime.timedelta(days=7)

    def _iso(d):
        return d.strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(d, datetime.datetime) else d

    key = where = None
    try:
        key, where = read_credentials(use_staging=False)
    except SystemExit:
        pass

    if key:
        print(f"  key source: {where} (env var/file -- adding the raw Authorization header myself)")
    else:
        print(f"  no {ENV_VAR_PROD} env var or local file found -- relying on this "
              f"environment's own API-credential injection for {BASE_URL_PROD} "
              f"(this process never sees the key in that mode)")

    url = (f"{BASE_URL_PROD}{TRANSACTIONS_ENDPOINT}"
           f"?dtstart={_iso(dtstart)}&dtend={_iso(dtend)}")
    print(f"  GET {url}")
    status, body = _probe(url, key)
    text = body.decode(errors="replace") if body else ""

    if status is None:
        print(f"  could not connect ({text}) -- unexpected, this host was reachable before")
        return False
    if status == 200:
        print(f"  HTTP 200: the credential works. Response ({len(body)} bytes, "
              f"first 2000 shown):\n{text[:2000]}")
        return True
    if status == 403:
        print(f"  HTTP 403: {text}\n"
              f"  Most likely cause: the environment's API-credential for {ENV_VAR_PROD} still "
              f"sends an `Authorization: Bearer <key>` header, but Relay's spec defines this as a "
              f"plain apiKey header (no Bearer prefix). Clear the credential's Prefix field in "
              f"environment settings and re-run this.")
        return False
    print(f"  HTTP {status}: {text}")
    return False


def parse_transaction(payload, source_file):
    """Flatten ONE Relay transaction object into a LIST of rows shaped like
    ingest_rails.load_relay()'s output (ROW_FIELDS above) -- one row per
    fuel item, one row per non-fuel product. A transaction with 2 fuel items
    (diesel + DEF, the majority case per the 933-transaction check this was
    built from -- see module docstring) becomes 2 rows; their `amount`
    values sum to exactly `total_amount_paid`, confirmed with zero
    exceptions across that batch.

    `fee` is carried informationally per row (from that item's own nested
    `fee`, when present) and is NEVER added into `amount` -- confirmed: the
    per-transaction `fees` total never explained a gap between
    `total_amount_paid` and the items' own totals in any of 933 checked.

    `truck` comes from the `prompts` array entry labeled exactly "Truck #"
    (confirmed live; a differently-worded label from a different fuel policy
    would silently return None here rather than a wrong truck number).
    `odometer` is always None -- confirmed absent from the schema entirely,
    not an oversight. `driver` is the driver's name; `driver.integration_id`
    (the "Relay Driver ID which acts like a card # in TMS" from the
    operator's original message) isn't in ROW_FIELDS at all -- add a column
    for it if some future caller needs to map it to a fleet driver roster.
    """
    txn_id = payload["transaction_id"]
    txn_date = payload["created_at"][:10]
    merchant = (payload.get("merchant") or {}).get("name")
    location = payload.get("location") or {}
    state = location.get("state")
    city = location.get("city")

    d = payload.get("driver") or {}
    driver = " ".join(p for p in (d.get("first_name"), d.get("last_name")) if p) or None

    truck = None
    for p in payload.get("prompts") or []:
        if p.get("label") == "Truck #":
            truck = p.get("value")
            break

    def base(**kw):
        row = {"source_file": source_file, "txn_id": txn_id, "txn_date": txn_date,
               "merchant": merchant, "state": state, "city": city,
               "driver": driver, "truck": truck, "odometer": None,
               "type": None, "sub_type": None, "product": None, "fuel_item": None,
               "amount": None, "fee": None, "gallons": None, "retail_price": None,
               "discounted_price": None, "discount_per_gal": None, "discount": None}
        row.update(kw)
        return row

    rows = []
    for fi in payload.get("fuel_items") or []:
        retail_pu = float(fi["retail_price_per_unit"])
        disc_pu = float(fi["discounted_price_per_unit"])
        total_retail = float(fi["total_retail_price"])
        total_disc = float(fi["total_discounted_price"])
        fee = fi.get("fee")
        rows.append(base(
            type="Fuel", sub_type=fi.get("fuel_type_description"),
            fuel_item=fi.get("fuel_type_description"),
            amount=-abs(total_disc),
            fee=float(fee["amount"]) if fee else None,
            gallons=float(fi["volume"]) if fi.get("volume_uom") == "gallons" else None,
            retail_price=retail_pu, discounted_price=disc_pu,
            discount_per_gal=round(retail_pu - disc_pu, 4),
            discount=round(total_retail - total_disc, 2)))

    for p in payload.get("products") or []:
        total = float(p["purchase_price_total"])
        fee = p.get("fee")
        rows.append(base(
            type="Product", sub_type=p.get("product_type_description"),
            product=p.get("product_type_description"),
            amount=-abs(total),
            fee=float(fee["amount"]) if fee else None))

    return rows


def pull_transactions(dtstart, dtend, source_file=None):
    """Fetch every transaction in [dtstart, dtend) and flatten each one with
    parse_transaction(). Raises SystemExit with the raw HTTP status/body on
    anything but 200 -- never returns partial or fabricated rows."""
    key = None
    try:
        key, _ = read_credentials(use_staging=False)
    except SystemExit:
        pass

    def _iso(d):
        import datetime
        return d.strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(d, datetime.datetime) else d

    url = f"{BASE_URL_PROD}{TRANSACTIONS_ENDPOINT}?dtstart={_iso(dtstart)}&dtend={_iso(dtend)}"
    status, body = _probe(url, key)
    if status != 200:
        raise SystemExit(f"GET {url} -> HTTP {status}: "
                          f"{body.decode(errors='replace') if body else '(no response)'}")

    txns = json.loads(body.decode())
    sf = source_file or f"relay_api:{_iso(dtstart)}_{_iso(dtend)}"
    rows = []
    for t in txns:
        rows.extend(parse_transaction(t, sf))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--whoami", action="store_true",
                    help="call the real transactions endpoint and report what comes back")
    ap.add_argument("--pull", action="store_true",
                    help="fetch and flatten transactions, write relay_txns_api.csv")
    ap.add_argument("--since", help="YYYY-MM-DD (RFC3339 date; defaults to 7 days ago)")
    ap.add_argument("--until", help="YYYY-MM-DD (RFC3339 date; defaults to now)")
    ap.add_argument("--staging", action="store_true", help="use the staging key/host")
    ap.add_argument("--outdir", default="data/processed")
    args = ap.parse_args()

    if args.whoami:
        dtstart = f"{args.since}T00:00:00Z" if args.since else None
        dtend = f"{args.until}T00:00:00Z" if args.until else None
        ok = whoami(dtstart=dtstart, dtend=dtend)
        sys.exit(0 if ok else 1)

    if args.pull:
        import datetime
        dtend = datetime.datetime.now(datetime.timezone.utc)
        dtstart = dtend - datetime.timedelta(days=7)
        if args.until:
            dtend = f"{args.until}T00:00:00Z"
        if args.since:
            dtstart = f"{args.since}T00:00:00Z"

        rows = pull_transactions(dtstart, dtend)
        if not rows:
            print("0 rows -- no transactions in this window.")
            sys.exit(0)

        out = Path(args.outdir)
        out.mkdir(parents=True, exist_ok=True)
        outfile = out / "relay_txns_api.csv"
        with outfile.open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(ROW_FIELDS))
            w.writeheader()
            w.writerows(rows)
        print(f"  -> {len(rows):,} rows  ${sum(abs(r['amount']) for r in rows):,.2f}  "
              f"written to {outfile}")
        sys.exit(0)

    ap.print_help()


if __name__ == "__main__":
    main()
