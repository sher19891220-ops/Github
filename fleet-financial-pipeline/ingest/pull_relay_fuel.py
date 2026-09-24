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
    real date range and reports the raw response -- 403 most likely means
    the credential's `Bearer ` prefix needs to be cleared (see above); 200
    means it's fully working.
  - `parse_transaction()` is STILL not implemented, and for a real structural
    reason now visible in the spec, not just an unseen-response gap: one
    Transaction can carry MULTIPLE `fuel_items`, `products`, and `fees`
    (each its own array), while `ROW_FIELDS` below (matched to
    `ingest_rails.load_relay()`) has singular `fuel_item`/`gallons`/
    `fee`/`product` fields -- one value each, not a list. The historical
    .xlsx export apparently flattened a multi-item transaction into that
    shape somehow (one row per fuel item, most likely), but exactly how it
    split `amount` and `fee` across those rows when a transaction also has
    fees or non-fuel products is NOT visible from the schema alone, and
    guessing that split would silently misallocate real dollars -- exactly
    the failure mode this project's discipline exists to catch (see
    CLAUDE.md's sign-convention and taxonomy sections). It still raises
    NotImplementedError with the raw payload attached, but the docstring
    there now names the specific open question rather than "no shape at
    all."
  - The Transaction schema also confirms two things the operator's original
    message asked about, independently of any guess: there is NO odometer
    field anywhere on a transaction, and there is NO truck/unit number
    either -- only `driver.integration_id`, which matches exactly what the
    operator described as "the Relay Driver ID which acts like a card # in
    TMS." Mapping that id to this fleet's own unit numbers still needs to
    come from Relay's dashboard or the fleet's own driver roster -- it is
    not in this API's response at all, confirmed rather than assumed.

THE TMS INTEGRATION_ID QUESTION IS STILL OPEN. The operator's own message
describes "TMS Fuel API Integration_ID" as "the Relay Driver ID which acts
like a card # in TMS" -- i.e. fetching a transaction may need a per-driver or
per-card identifier from Relay's TMS integration, not just the account-level
API key. No mapping of that ID to this fleet's own driver/unit numbers exists
anywhere in this corpus yet. Do not invent one; if the real API requires it,
that mapping needs to come from Relay's dashboard or docs.

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
           # NOT YET FUNCTIONAL past whoami -- raises NotImplementedError at
           # parse_transaction() until a real response shape is observed.
"""
import argparse
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
    settings. Never raises: returns (status_or_None, body_bytes)."""
    import urllib.error
    import urllib.request
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = key
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read(2000)
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000)
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
        print(f"  HTTP 200: the credential works. Response (first 2000 bytes):\n{text}")
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


def parse_transaction(payload):
    """Map ONE transaction object from Relay's API response into
    ingest_rails.load_relay()'s row shape (ROW_FIELDS above).

    The Transaction schema itself is now CONFIRMED (Relay's own OpenAPI spec,
    docs.relaypayments.com/tmsfuel.yaml) -- this is not a blind-payload gap
    anymore. What's still genuinely open: a Transaction carries `fuel_items`,
    `products`, and `fees` as ARRAYS (one transaction can have several fuel
    line items, e.g. a partial DEF + diesel fill), while ROW_FIELDS has
    singular `fuel_item`/`gallons`/`fee`/`product` fields. The historical
    .xlsx export this shape was matched to apparently flattened a
    multi-item transaction to one row per fuel item, but exactly how it
    split the transaction-level `total_amount_paid` and `fees` array across
    those rows when a transaction ALSO carries fees or non-fuel products is
    not recoverable from the schema alone -- guessing that split would
    silently misallocate real dollars across rows, exactly the failure mode
    this project's discipline exists to catch (see CLAUDE.md's sign-
    convention and taxonomy sections). Confirm the real split from an ACTUAL
    multi-item transaction payload (or Relay support) before writing this.

    Two things the operator asked about are now answered by the schema,
    not guessed: there is no odometer field anywhere on a transaction, and
    the only per-driver identifier is `driver.integration_id` -- matching
    "the Relay Driver ID which acts like a card # in TMS" from the
    operator's original message. Mapping that id to this fleet's own unit
    numbers still has to come from outside this API (Relay's dashboard or
    the fleet's own driver roster).
    """
    raise NotImplementedError(
        "parse_transaction() needs to see a real multi-item transaction payload "
        "(or Relay's confirmation of the fuel_items/fees split) before it can be "
        "written safely -- see this function's docstring. Payload received:\n"
        + json.dumps(payload, indent=2, default=str))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--whoami", action="store_true",
                    help="call the real transactions endpoint and report what comes back")
    ap.add_argument("--pull", action="store_true",
                    help="fetch transactions (NOT YET FUNCTIONAL -- see docstring)")
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
        print("--pull is not yet functional: parse_transaction() is intentionally "
              "unimplemented until a real Relay API response has been observed. "
              "Run --whoami first to confirm the key and find the real base URL, "
              "then fill in BASE_URL_* and parse_transaction() from what comes back.")
        sys.exit(1)

    ap.print_help()


if __name__ == "__main__":
    main()
