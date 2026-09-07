"""QuickManage: odometer and repair-order data, straight from the API.

CLAUDE.md has listed QuickManage as a *measured* mileage/repair-order source
(ranked above hand-keyed Google Sheets, below only Samsara telematics) since
before this pipeline's first commit -- and until 2026-09-07 no QuickManage
export or credential existed anywhere in the corpus. The operator supplied
working client_credentials OAuth pairs for all three operating companies that
same day, confirmed reachable and functioning.

THE FLOW. POST {client_id, client_secret} to /auth/token, get back
data.access_token, use it as a Bearer token against /x/trips/search and
/x/trucks/search. One token pair per company -- QuickManage has no group-wide
key, so a truck that moved companies (see analysis/truck_maintenance.py) may
need querying under more than one company's token to find its full history.

CREDENTIALS LIVE IN AN ENVIRONMENT VARIABLE, NOT ON DISK -- same reasoning as
ingest/pull_sheets.py: this container is ephemeral, and a key written to a
tracked or even gitignored file has to be re-supplied by hand after every
reclaim, while an environment variable set on the remote environment survives
restarts.

    QUICKMANAGE_CREDENTIALS   JSON: {"ZONE_OH": {"client_id": "...",
                               "client_secret": "..."}, "XTRACK": {...},
                               "AFG": {...}}

NO ERROR MESSAGE, LOG LINE, OR SAVED FILE MAY CONTAIN A CLIENT SECRET OR
ACCESS TOKEN. Only company names and record counts are ever printed. Raw API
responses are saved to disk (data/raw/quickmanage/) because that is the actual
data being fetched, not the credential that fetched it.

Setup, once (config/quickmanage_credentials.example.json shows the shape):
    export QUICKMANAGE_CREDENTIALS='{"ZONE_OH": {...}, ...}'
    python3 ingest/pull_quickmanage.py --whoami   # proves each token exchange works
    python3 ingest/pull_quickmanage.py            # pulls trucks + trips for all three
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
ENV_VAR = "QUICKMANAGE_CREDENTIALS"
CREDS_FILE = ROOT / "config/quickmanage_credentials.json"
BASE = "https://api.quickmanage.com"
OUT_DIR = ROOT / "data/raw/quickmanage"
COMPANIES = ("ZONE_OH", "XTRACK", "AFG")


def read_credentials():
    """One client_id/client_secret pair per company. Never returns the raw
    env var text in an error -- only company names, which are not secrets."""
    raw = os.environ.get(ENV_VAR, "").strip()
    where = f"${ENV_VAR}"
    if not raw:
        if not CREDS_FILE.exists():
            raise SystemExit(
                f"No QuickManage credentials: ${ENV_VAR} is unset and there is "
                f"no file at config/quickmanage_credentials.json. See this "
                f"module's docstring for the JSON shape.")
        raw, where = CREDS_FILE.read_text(), str(CREDS_FILE)
    try:
        creds = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{where} is not valid JSON: {exc}")
    missing_co = [c for c in COMPANIES if c not in creds]
    if missing_co:
        raise SystemExit(f"{where} is missing credentials for: "
                         f"{', '.join(missing_co)}")
    for co, pair in creds.items():
        if not pair.get("client_id") or not pair.get("client_secret"):
            raise SystemExit(f"{where}[{co}] is missing client_id or "
                             "client_secret.")
    return creds


def get_token(client_id, client_secret):
    """A client_secret in the request body never appears in a traceback --
    requests raises on the response, not the request, so nothing here needs
    to catch and re-raise around the POST itself."""
    r = requests.post(f"{BASE}/auth/token",
                      json={"client_id": client_id, "client_secret": client_secret},
                      timeout=30)
    r.raise_for_status()
    token = r.json().get("data", {}).get("access_token")
    if not token:
        raise RuntimeError("token endpoint returned 200 but no access_token "
                           "-- response shape changed")
    return token


def search(token, endpoint, body=None):
    r = requests.post(f"{BASE}{endpoint}", json=body or {},
                      headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    return r.json()


def pull_company(co, client_id, client_secret, save=True):
    token = get_token(client_id, client_secret)
    trucks = search(token, "/x/trucks/search")
    trips = search(token, "/x/trips/search")
    if save:
        d = OUT_DIR / co
        d.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        (d / f"trucks-{stamp}.json").write_text(json.dumps(trucks, indent=2))
        (d / f"trips-{stamp}.json").write_text(json.dumps(trips, indent=2))
    return trucks, trips


def _count(payload):
    """QuickManage's actual pagination/envelope shape is not yet confirmed --
    report what was found rather than assuming a key name."""
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return len(payload["data"])
    if isinstance(payload, list):
        return len(payload)
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--whoami", action="store_true",
                    help="prove each company's token exchange works; fetch nothing")
    ap.add_argument("--only", help="one company from " + ", ".join(COMPANIES))
    a = ap.parse_args()

    creds = read_credentials()
    companies = [a.only] if a.only else list(COMPANIES)

    if a.whoami:
        for co in companies:
            pair = creds[co]
            try:
                get_token(pair["client_id"], pair["client_secret"])
                print(f"  CAN AUTH   {co}")
            except Exception as exc:
                print(f"  NO AUTH    {co}  [{type(exc).__name__}] {exc}")
        return

    for co in companies:
        pair = creds[co]
        trucks, trips = pull_company(co, pair["client_id"], pair["client_secret"])
        nt, ntr = _count(trucks), _count(trips)
        print(f"  {co:<8}trucks: {nt if nt is not None else '(shape unknown)'}  "
              f"trips: {ntr if ntr is not None else '(shape unknown)'}")
    print(f"\n  Saved under {OUT_DIR.relative_to(ROOT)}/<company>/")


if __name__ == "__main__":
    main()
