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
import csv
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
# The carriers, which must always be present. The list of companies actually
# pulled comes from the credentials themselves (see `companies_in`) so that
# adding the shop, or a fourth carrier, is a credential change rather than a
# code change.
REQUIRED_COMPANIES = ("ZONE_OH", "XTRACK", "AFG")


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
    # The three carriers must be present; anything else in the file is
    # additional and is pulled too. The shop (TRUCKMAX) issues its own keys
    # and is expected here eventually -- as a credentials entry, not a code
    # change, because a hard-coded company list means every new company in
    # the group needs a commit before its data can be read.
    missing_co = [c for c in REQUIRED_COMPANIES if c not in creds]
    if missing_co:
        raise SystemExit(f"{where} is missing credentials for: "
                         f"{', '.join(missing_co)}")
    for co, pair in creds.items():
        if not isinstance(pair, dict):
            raise SystemExit(f"{where}[{co}] should be an object with "
                             "client_id and client_secret.")
        if not pair.get("client_id") or not pair.get("client_secret"):
            raise SystemExit(f"{where}[{co}] is missing client_id or "
                             "client_secret.")
    return creds


def companies_in(creds):
    """Every company the credentials name, required ones first so the output
    reads in a stable order however the JSON was written."""
    extra = sorted(k for k in creds if k not in REQUIRED_COMPANIES)
    return [c for c in REQUIRED_COMPANIES if c in creds] + extra


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


# ---------------------------------------------------------------- roster --
# `/x/trucks/search` is a roster: unit, vin, plate_number, plate_state, make,
# year, owner_id, status, in_service_date, drivers[] (CLAUDE.md, confirmed
# against the live API). `in_service_date` is the field that matters here: it
# is when the unit entered service under that company, which is the ownership
# start date opsdash's truck_entity_history does not have. That history's
# periods currently begin when a unit first EARNED, which is necessarily on or
# after the day it was acquired, so every cost dated in between falls outside
# every period and cannot be attributed.

NL = chr(10)
PAGE_SIZE = 100
MAX_PAGES = 500  # 50k units; a stop, not an expectation


def _records(payload):
    """The list inside whatever envelope the endpoint used."""
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    if isinstance(payload, list):
        return payload
    return []


def search_all(token, endpoint):
    """Every page, not just the first.

    The earlier probe of this API read page 0 only and reported "221 trucks"
    for ZONE_OH off a 100-record page -- a page count read as a fleet count.
    Paging stops on a short page, and also on a page that returns nothing new,
    so an endpoint that ignores `page` (and so returns page 0 forever) ends the
    loop instead of spinning against it.
    """
    out, seen = [], set()
    for page in range(MAX_PAGES):
        batch = _records(search(token, endpoint, {"page": page, "page_size": PAGE_SIZE}))
        if not batch:
            break
        fresh = [r for r in batch if id_of(r) not in seen]
        for r in fresh:
            seen.add(id_of(r))
        out.extend(fresh)
        if len(batch) < PAGE_SIZE or not fresh:
            break
    return out


def id_of(rec):
    """Whatever this record is keyed by -- used only to detect a page that
    repeats, so an id field that does not exist degrades to the whole record
    rather than collapsing every row into one."""
    for k in ("id", "truck_id", "unit", "unit_number", "vin"):
        v = rec.get(k) if isinstance(rec, dict) else None
        if v not in (None, ""):
            return f"{k}={v}"
    return json.dumps(rec, sort_keys=True)[:200]


ROSTER_COLUMNS = ("company", "unit_number", "unit_type", "owner_id", "status",
                  "in_service_date", "out_service_date", "vin", "make", "year")


def roster_rows(co, records, unit_type):
    """One CSV row per unit. Field names are read defensively: this is the
    shape the API returned when it was probed, and a roster that silently
    dropped every unit because a key was renamed would look like an empty
    fleet rather than a broken read -- so a record with no unit number at all
    is counted and reported, not skipped in silence."""
    rows, no_unit = [], 0
    for r in records:
        if not isinstance(r, dict):
            no_unit += 1
            continue
        unit = first_of(r, "unit", "unit_number", "unit_no", "number")
        if unit in (None, ""):
            no_unit += 1
            continue
        rows.append({
            "company": co,
            "unit_number": str(unit).strip(),
            "unit_type": unit_type,
            "owner_id": first_of(r, "owner_id", "owner", "company_id") or "",
            "status": first_of(r, "status", "state") or "",
            "in_service_date": first_of(r, "in_service_date", "inServiceDate",
                                        "in_service", "service_date") or "",
            "out_service_date": first_of(r, "out_service_date", "outServiceDate",
                                         "out_service", "retired_date") or "",
            "vin": first_of(r, "vin", "VIN") or "",
            "make": first_of(r, "make") or "",
            "year": first_of(r, "year") or "",
        })
    return rows, no_unit


def first_of(rec, *keys):
    for k in keys:
        v = rec.get(k)
        if v not in (None, ""):
            return v
    return None


def pull_roster(creds, companies):
    """Trucks and trailers for every company, fully paged, as one CSV.

    Trailers are pulled too because they are a roster the same way trucks are
    and cost the same one call -- but note that they do NOT close opsdash's
    trailer gap: the trailer rows there carry no trailer unit number at all,
    so there is nothing on those rows to match a trailer roster against.
    """
    all_rows, report = [], []
    for co in companies:
        pair = creds[co]
        token = get_token(pair["client_id"], pair["client_secret"])
        for endpoint, unit_type in (("/x/trucks/search", "truck"),
                                    ("/x/trailers/search", "trailer")):
            recs = search_all(token, endpoint)
            rows, no_unit = roster_rows(co, recs, unit_type)
            all_rows.extend(rows)
            dated = sum(1 for r in rows if r["in_service_date"])
            report.append((co, unit_type, len(rows), dated, no_unit))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = OUT_DIR / f"roster-{stamp}.csv"
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=ROSTER_COLUMNS)
        w.writeheader()
        w.writerows(all_rows)

    print(f"{'company':<10}{'type':<9}{'units':>7}{'with in_service_date':>22}"
          f"{'no unit number':>16}")
    for co, ut, n, dated, no_unit in report:
        print(f"  {co:<8}{ut:<9}{n:>7}{dated:>22}{no_unit:>16}")
    total = len(all_rows)
    dated = sum(1 for r in all_rows if r["in_service_date"])
    note = " -- NONE have one, so this pull cannot date a single period" if total and not dated else ""
    print(NL + f"  {total} unit(s), {dated} with an in-service date{note}")
    print(f"  Wrote {path.relative_to(ROOT)}")
    print(NL + "  Next: load it into opsdash with")
    print(f"    npx tsx scripts/load-quickmanage-roster.ts <path> <applied-by>")
    return path


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
    ap.add_argument("--roster", action="store_true",
                    help="pull the truck+trailer roster for every company, fully "
                         "paged, and write it as one CSV for opsdash to load")
    ap.add_argument("--only", help="one company named in the credentials, "
                                  "e.g. " + ", ".join(REQUIRED_COMPANIES))
    a = ap.parse_args()

    creds = read_credentials()
    if a.only and a.only not in creds:
        # Named rather than a KeyError three lines later. The shop's keys are
        # expected but not here yet, and "--only TRUCKMAX" before they arrive
        # should say so rather than raise.
        raise SystemExit(f"No credentials for {a.only}. The ones on file are: "
                         f"{', '.join(companies_in(creds))}.")
    companies = [a.only] if a.only else companies_in(creds)

    if a.roster:
        pull_roster(creds, companies)
        return

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
