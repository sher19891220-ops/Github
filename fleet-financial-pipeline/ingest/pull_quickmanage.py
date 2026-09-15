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
    python3 ingest/pull_quickmanage.py            # pulls the FIRST PAGE of trucks + trips only
    python3 ingest/pull_quickmanage.py --full     # pages through ALL of them (search_all())

--full DID NOT EXIST until 2026-09-15, and has not been run against the real
API -- the original single-page pull was confirmed working 2026-09-07 (docs/
FINDINGS.md: "ZONE_OH alone returned 221 trucks and 23,510 trips ... not yet
driven past page 0 here"), but that session's credentials were session-only
by design and did not survive; --full was written without live credentials
available to test it. Run --whoami first against real credentials, then
--full on one company (--only ZONE_OH) before trusting it at scale --
search_all() pages until a response comes back with fewer than page_size
records, which is the standard exhaustion signal but not yet confirmed
against QuickManage's own exact envelope.
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


PAGE_SIZE = 100
MAX_PAGES = 500  # 50,000 records at PAGE_SIZE=100 -- a safety cap, not an
                 # expected real total; ZONE_OH's own 23,510 trips (docs/
                 # FINDINGS.md, confirmed 2026-09-07 against page 0 only)
                 # needs 236 pages at this size, comfortably under the cap.


def search_all(token, endpoint, body=None, page_size=PAGE_SIZE, max_pages=MAX_PAGES):
    """Follow QuickManage's page/page_size pagination (docs/FINDINGS.md:
    "paginated 100 at a time via page/page_size in the request body") until a
    page comes back with fewer than page_size records -- the standard
    exhaustion signal, since QuickManage's own response envelope carries no
    total-count field this pipeline has confirmed. Stops at max_pages rather
    than looping forever if that assumption turns out wrong for some
    endpoint; the caller finds out because the returned list's length will
    be an exact multiple of page_size, which the caller can check.

    NOT YET RUN AGAINST THE REAL API -- pull_quickmanage.py's original
    single-page search() was confirmed working 2026-09-07, but this
    pagination loop was written without live credentials available (see
    this module's --whoami requirement) and needs a real run to prove it
    against QuickManage's actual page-1-vs-page-0 indexing and its exact
    empty-page shape before being trusted the way the rest of this
    pipeline's confirmed findings are."""
    page = 1
    all_records = []
    for _ in range(max_pages):
        body_page = dict(body or {})
        body_page["page"] = page
        body_page["page_size"] = page_size
        payload = search(token, endpoint, body_page)
        records = payload.get("data") if isinstance(payload, dict) else payload
        if not isinstance(records, list):
            # Unknown shape -- return what we have plus this raw payload
            # rather than guess at a key name that might not exist.
            return all_records, payload
        all_records.extend(records)
        if len(records) < page_size:
            return all_records, None
        page += 1
    return all_records, {"warning": f"stopped at max_pages={max_pages} -- "
                                    f"more records may remain"}


def pull_company(co, client_id, client_secret, save=True, full=False):
    """full=False (default): the original single-page behavior, unchanged,
    so anything already relying on it keeps working. full=True: page
    through every truck and every trip via search_all() instead of
    stopping after the first 100 of each."""
    token = get_token(client_id, client_secret)
    if full:
        trucks, trucks_warning = search_all(token, "/x/trucks/search")
        trips, trips_warning = search_all(token, "/x/trips/search")
        for label, w in (("trucks", trucks_warning), ("trips", trips_warning)):
            if w:
                print(f"  {co} {label}: {w}")
    else:
        trucks = search(token, "/x/trucks/search")
        trips = search(token, "/x/trips/search")
    if save:
        d = OUT_DIR / co
        d.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        tag = "-full" if full else ""
        (d / f"trucks{tag}-{stamp}.json").write_text(json.dumps(trucks, indent=2))
        (d / f"trips{tag}-{stamp}.json").write_text(json.dumps(trips, indent=2))
    return trucks, trips


def _count(payload):
    """QuickManage's actual single-page envelope shape is not yet confirmed
    beyond {"data": [...]} -- report what was found rather than assuming a
    key name. A plain list (already-paginated full=True results) counts
    directly."""
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
    ap.add_argument("--full", action="store_true",
                    help="page through ALL trucks and trips instead of just the first "
                         f"{PAGE_SIZE} of each (e.g. ZONE_OH's full 23,510 trips, not "
                         "just page 0 -- confirmed 2026-09-07 that page 0 alone is what "
                         "existed in this corpus until now)")
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
        trucks, trips = pull_company(co, pair["client_id"], pair["client_secret"], full=a.full)
        nt, ntr = _count(trucks), _count(trips)
        print(f"  {co:<8}trucks: {nt if nt is not None else '(shape unknown)'}  "
              f"trips: {ntr if ntr is not None else '(shape unknown)'}")
    print(f"\n  Saved under {OUT_DIR.relative_to(ROOT)}/<company>/")


if __name__ == "__main__":
    main()
