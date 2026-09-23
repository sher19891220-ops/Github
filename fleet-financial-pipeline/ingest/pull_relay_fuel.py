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

THE PRIMARY MECHANISM, as of 2026-09-23, is this Claude Code environment's own
"API credentials" feature (environment settings -> API credentials): the
operator registered RELAY_PAYMENTS_API_KEY there, scoped to the single allowed
host `api.relaypayments.com`, with an `Authorization: Bearer <key>` header
injected by the environment's own outbound proxy on every request to that
host. A session run in that environment NEVER holds or sees the raw key in
this mode -- `whoami()` below makes a request with no auth header of its own,
and the proxy attaches the real one in transit. This is a stronger guarantee
than an env var (which code can still read directly), so it is tried first;
the env-var/file path below only matters if RELAY_PAYMENTS_API_KEY happens to
also be set as an ordinary variable somewhere else this runs.

`api.relaypayments.com` itself is still NOT independently confirmed against
Relay's own docs -- `docs.relaypayments.com` (and the mirrors
`relaypayments.readme.io`, `www.relaypayments.com/developers`) all return
401/404 without the docs-portal login the operator was given separately, and
that login was intentionally never used or stored here (see docs/FINDINGS.md,
2026-09-22, "Live API credentials pasted into chat"). A second host, given
verbally as "the official alternative pattern used by their underlying
internal infrastructure" and written as the unparseable string
`"://relaypayments.com"`, was deliberately NOT wired in here: it is not a
valid URL, and it did not trace back to anything from Relay itself (dashboard,
docs, or support) -- treating it as a real fallback host would repeat exactly
the kind of unverified guess this module has argued against from the start.

  - `whoami()` below tries several UNCONFIRMED candidate endpoint paths
    against the one host that is actually wired up, and reports each
    response plainly -- a non-404 response is the first real signal of the
    correct path; 404 across the board most likely means the host is wrong.
  - `parse_transaction()`, which would map one API transaction object into
    the load_relay() row shape, is NOT implemented. Guessing that mapping and
    being wrong would silently put real fuel dollars in the wrong column --
    exactly the failure mode this project's whole discipline exists to catch
    (see CLAUDE.md's sign-convention and taxonomy sections). It raises
    NotImplementedError with the raw payload attached so the next session (or
    a real docs read) can fill it in from an ACTUAL observed response, never
    from a guess.

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

# api.relaypayments.com is the host wired into this environment's own
# API-credential injection (see docstring) -- not yet proven correct until a
# live whoami() call returns something other than a connection failure.
BASE_URL_PROD = "https://api.relaypayments.com"
BASE_URL_STAGING = "https://api.staging.relaypayments.com"  # UNCONFIRMED, no credential wired for this host

# UNCONFIRMED candidate paths, tried in order by whoami(). "transactions" is
# tried first because the operator said this key has "transactions API
# endpoints enabled" specifically.
CANDIDATE_ENDPOINTS = ("/v1/transactions", "/v1/account", "/v1/me")

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
    """One GET against a live Relay endpoint. `key`, if given, is added as a
    manual Authorization header (the env-var/file fallback path) -- otherwise
    no auth header is set here at all, relying entirely on this environment's
    own proxy to inject one for the allowed host. Never raises: returns
    (status_or_None, body_bytes) so whoami() can report every candidate."""
    import urllib.error
    import urllib.request
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read(500)
    except urllib.error.HTTPError as e:
        return e.code, e.read(500)
    except urllib.error.URLError as e:
        return None, str(e.reason).encode()


def whoami():
    """Proves the live host is reachable and reports what each UNCONFIRMED
    candidate endpoint actually returns. Never prints key material -- in the
    environment-credential mode there usually isn't any in this process to
    print at all (see module docstring)."""
    key = where = None
    try:
        key, where = read_credentials(use_staging=False)
    except SystemExit:
        pass

    if key:
        print(f"  key source: {where} (env var/file -- adding the Authorization header myself)")
    else:
        print(f"  no {ENV_VAR_PROD} env var or local file found -- relying on this "
              f"environment's own API-credential injection for {BASE_URL_PROD} "
              f"(this process never sees the key in that mode)")

    any_non_404 = False
    for path in CANDIDATE_ENDPOINTS:
        url = BASE_URL_PROD + path
        status, body = _probe(url, key)
        if status is None:
            print(f"  {url} -> could not connect ({body.decode(errors='replace')}) "
                  f"-- the host itself is most likely wrong")
        elif status == 404:
            print(f"  {url} -> HTTP 404 (this path is most likely wrong)")
        else:
            any_non_404 = True
            print(f"  {url} -> HTTP {status}: {body.decode(errors='replace')[:200]!r}")

    if not any_non_404:
        print(f"  every candidate path 404'd (or failed to connect) against "
              f"{BASE_URL_PROD} -- the host is probably wrong too, not just the paths")
    return any_non_404


def parse_transaction(payload):
    """Map ONE transaction object from Relay's API response into
    ingest_rails.load_relay()'s row shape (ROW_FIELDS above).

    NOT IMPLEMENTED ON PURPOSE. This project's discipline (CLAUDE.md's sign-
    convention and taxonomy sections) is that a guessed field mapping is
    worse than an explicit gap -- a wrong guess here would put real dollars,
    gallons or odometer readings in the wrong column and look correct. Fill
    this in from an ACTUAL observed response (capture one real payload from
    a working --whoami-confirmed endpoint, or from Relay's docs once
    reachable), never from an assumption about what a fuel-card API
    "probably" returns.
    """
    raise NotImplementedError(
        "parse_transaction() needs a real observed Relay API transaction payload "
        "before it can be written -- see this module's docstring. Payload received:\n"
        + json.dumps(payload, indent=2, default=str))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--whoami", action="store_true",
                    help="prove a key loads and is accepted; fetch nothing else")
    ap.add_argument("--pull", action="store_true",
                    help="fetch transactions (NOT YET FUNCTIONAL -- see docstring)")
    ap.add_argument("--since", help="YYYY-MM-DD")
    ap.add_argument("--until", help="YYYY-MM-DD")
    ap.add_argument("--staging", action="store_true", help="use the staging key/host")
    ap.add_argument("--outdir", default="data/processed")
    args = ap.parse_args()

    if args.whoami:
        ok = whoami()
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
