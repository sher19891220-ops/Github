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
project's other credential-handling modules (see `pull_sheets.py`). What is
NOT yet confirmed is Relay's own API shape: `docs.relaypayments.com` (and the
mirrors `relaypayments.readme.io`, `www.relaypayments.com/developers`) all
return 401/404 without the docs-portal login the operator was given
separately -- and that login was intentionally never used or stored here (see
docs/FINDINGS.md, 2026-09-22, "Live API credentials pasted into chat"). So:

  - BASE_URL below is a PLACEHOLDER, not a confirmed host. Do not trust it.
  - `whoami()` calls one guessed low-cost endpoint to prove the key works --
    it is explicit that the path is unconfirmed, and it fails with a clear,
    actionable message (never a silent wrong success) if that guess is wrong.
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

# UNCONFIRMED -- a placeholder host, not a value read from Relay's own docs
# (which this session could not reach without the login it declined to use).
# Replace with the real base URL once docs.relaypayments.com is reachable, or
# once a real call under --whoami reveals the working host.
BASE_URL_PROD = "https://api.relaypayments.com"      # UNCONFIRMED
BASE_URL_STAGING = "https://api.staging.relaypayments.com"  # UNCONFIRMED

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


def whoami():
    """Proves whichever key is available loads and is accepted by SOME Relay
    endpoint, before anything else runs. Tries the production key first, then
    staging -- prints ONLY which key source was used and whether the call
    succeeded, never the key itself.

    THE ENDPOINT PATH BELOW IS A GUESS ("/v1/account" or similar convention),
    NOT A CONFIRMED RELAY ENDPOINT. A 404 here most likely means the path is
    wrong, not that the key is bad -- this function says so explicitly rather
    than reporting a bad key when the real problem is an unconfirmed URL.
    """
    import urllib.error
    import urllib.request

    for use_staging, label in ((False, "production"), (True, "staging")):
        try:
            key, where = read_credentials(use_staging=use_staging)
        except SystemExit:
            continue
        base = BASE_URL_STAGING if use_staging else BASE_URL_PROD
        guessed_endpoint = f"{base}/v1/account"  # UNCONFIRMED
        req = urllib.request.Request(
            guessed_endpoint,
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                print(f"  key source: {where} ({label})")
                print(f"  {guessed_endpoint} -> HTTP {resp.status}: reachable and accepted")
                return True
        except urllib.error.HTTPError as e:
            print(f"  key source: {where} ({label})")
            if e.code in (401, 403):
                print(f"  {guessed_endpoint} -> HTTP {e.code}: endpoint reachable, "
                      f"key REJECTED -- confirm the key is active for this host")
            else:
                print(f"  {guessed_endpoint} -> HTTP {e.code}: endpoint path is most likely "
                      f"wrong (this URL was never confirmed against Relay's real docs) -- "
                      f"the key itself may be fine")
            return False
        except urllib.error.URLError as e:
            print(f"  key source: {where} ({label})")
            print(f"  {guessed_endpoint} -> could not connect ({e.reason}) -- "
                  f"BASE_URL_{'STAGING' if use_staging else 'PROD'} is a placeholder, "
                  f"most likely wrong")
            return False

    print(f"  Neither ${ENV_VAR_PROD} nor ${ENV_VAR_STAGING} is set, and no local "
          f"fallback file exists at {CREDS}.")
    return False


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
