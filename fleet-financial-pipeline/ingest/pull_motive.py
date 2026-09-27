"""Motive (formerly KeepTruckin): live per-vehicle, per-jurisdiction mileage,
straight from the API -- the live-pull alternative to a weekly Motive CSV
upload, mirroring what ingest/pull_samsara.py already does for Samsara.

ENDPOINT, CONFIRMED AGAINST MOTIVE'S OWN PUBLISHED API REFERENCE (2026-09-27):
    GET https://api.gomotive.com/v1/ifta/summary
documented at developer-docs.gomotive.com/reference/fetch-a-list-of-the-
company-vehicles-mileage-summary -- NOT YET CONFIRMED AGAINST A REAL RESPONSE
from this fleet's own account, the way pull_samsara.py's /fleet/vehicles/
stats was confirmed against 91 real vehicles. Said plainly rather than
hidden, same as pull_relay_fuel.py's own "THIS IS A SCAFFOLD" disclosure:
this module is built correctly against the documented contract, and
`--whoami` is the first real call to make once a token is actually set, to
prove the shape below matches what this account's API actually returns
before trusting any number out of it.

REQUEST SHAPE (per that reference page):
    query params: start_date, end_date (date range, MAX 3 MONTHS per Motive's
    own stated constraint -- a caller asking for more must page by quarter,
    not send one wide request), optional jurisdictions[], vehicle_ids[],
    fuel_type, and per_page/page_no pagination (default per_page=25).
    auth header: X-API-KEY: <token> (Motive's docs also mention an OAuth
    Bearer alternative for the 2.0 API; this module uses the plain API-key
    header since that is the credential type actually supplied).

RESPONSE SHAPE:
    {"ifta_trips": [{"ifta_trip": {"jurisdiction": "CA", "vehicle": {"id":
    4, "number": "...", "metric_units": false, ...}, "distance": 0.68,
    "time_zone": "..."}}], "pagination": {"per_page", "page_no", "total"}}
    `distance` is in the VEHICLE'S OWN UNITS (`metric_units` says which) --
    converted to miles here on the way out, same reasoning as
    pull_samsara.py's m_to_mi(), so nothing downstream has to remember to.

CREDENTIALS LIVE IN AN ENVIRONMENT VARIABLE, NOT ON DISK, NOT IN CHAT. Same
discipline as every other live pull in this pipeline (pull_sheets.py,
pull_samsara.py, pull_relay_fuel.py): this container is ephemeral, and a key
typed into a conversation or written to a tracked (or even gitignored) file
has to be re-supplied by hand after every reclaim, while an environment
variable set on the remote environment survives restarts and is never
echoed. The operator confirmed 2026-09-27 that the value already shared in
chat IS a live API token -- it is deliberately NOT used or stored anywhere
in this repo; only the environment-variable NAME below is referenced.

    MOTIVE_API_TOKEN   set on this environment's own settings, never pasted
                       into a session

NO ERROR MESSAGE, LOG LINE, OR SAVED FILE MAY CONTAIN THE TOKEN. Only vehicle
counts and jurisdiction codes (not secrets) are ever printed. Raw, shaped API
responses ARE saved to disk (data/raw/motive/) because that is the actual
data being fetched, not the credential that fetched it.

Setup, once (config/motive_credentials.example.json shows the shape):
    export MOTIVE_API_TOKEN='...'
    python3 ingest/pull_motive.py --whoami                          # proves the token works
    python3 ingest/pull_motive.py --ifta --start-date 2026-09-14 --end-date 2026-09-21
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
ENV_VAR = "MOTIVE_API_TOKEN"
CREDS_FILE = ROOT / "config/motive_credentials.json"
BASE = "https://api.gomotive.com"
OUT_DIR = ROOT / "data/raw/motive"
KM_PER_MILE = 1.609344


def read_token():
    """Never returns or logs the raw token value in an error message --
    only where it came from (an env var name, or a file path, neither of
    which is a secret). Same pattern as pull_samsara.read_token()."""
    token = os.environ.get(ENV_VAR, "").strip()
    where = f"${ENV_VAR}"
    if not token:
        if not CREDS_FILE.exists():
            raise SystemExit(
                f"No Motive token: ${ENV_VAR} is unset and there is no file "
                f"at {CREDS_FILE}. Set ${ENV_VAR} on this environment's own "
                f"settings -- see this module's docstring -- never paste a "
                f"token into a chat session.")
        try:
            token = json.loads(CREDS_FILE.read_text()).get("token", "").strip()
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{CREDS_FILE} is not valid JSON: {exc}")
        where = str(CREDS_FILE)
    if not token:
        raise SystemExit(f"{where} has no token set.")
    return token


def _get(token, path, params=None):
    r = requests.get(f"{BASE}{path}", params=params or {},
                     headers={"X-Api-Key": token}, timeout=60)
    r.raise_for_status()
    return r.json()


def dist_to_miles(distance, metric_units):
    if distance is None:
        return None
    return round(distance / KM_PER_MILE, 2) if metric_units else round(distance, 2)


def pull_ifta_summary(token, start_date, end_date, vehicle_ids=None, jurisdictions=None):
    """Every (vehicle, jurisdiction) row in [start_date, end_date] -- paged by
    page_no/per_page, the pagination shape documented for this endpoint (NOT
    the endCursor style pull_samsara.py's Samsara endpoints use; the two
    vendors page differently and this must not assume Samsara's shape).

    Motive states this endpoint's own date range cannot exceed 3 months --
    surfaced as a clear SystemExit rather than a confusing API error, since a
    caller asking for a whole year needs to loop by quarter, not hit this
    once.
    """
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    if (end - start).days > 92:
        raise SystemExit(
            f"{start_date}..{end_date} is more than ~3 months -- Motive's own "
            f"/v1/ifta/summary endpoint caps the range. Call this once per "
            f"quarter instead of once for a wide span.")
    params = {"start_date": start_date, "end_date": end_date, "per_page": 100, "page_no": 1}
    if vehicle_ids:
        params["vehicle_ids[]"] = list(vehicle_ids)
    if jurisdictions:
        params["jurisdictions[]"] = list(jurisdictions)

    rows = []
    while True:
        payload = _get(token, "/v1/ifta/summary", params)
        for item in payload.get("ifta_trips", []):
            t = item.get("ifta_trip", item)
            veh = t.get("vehicle") or {}
            rows.append({
                "unit_number": veh.get("number"),
                "motive_vehicle_id": veh.get("id"),
                "jurisdiction": t.get("jurisdiction"),
                "miles": dist_to_miles(t.get("distance"), veh.get("metric_units")),
            })
        pg = payload.get("pagination", {})
        total = pg.get("total", len(rows))
        # Compare against ROWS ACTUALLY RECEIVED so far, never against the
        # per_page this call requested -- the server's own pagination block
        # is the source of truth for its real page size, which need not
        # match what was asked for.
        if len(rows) >= total or not payload.get("ifta_trips"):
            break
        params["page_no"] += 1
    return rows


def to_mileage_rows(rows, company, period):
    """-> analysis.state_tax_engine's mileage_rows shape. `period` is
    supplied by the caller (e.g. the week's Monday), never guessed from the
    date range requested -- a date range is not automatically one P&L week."""
    out = []
    for r in rows:
        if not r.get("unit_number") or not r.get("jurisdiction") or r.get("miles") is None:
            continue
        out.append({"company": company, "period": period, "unit": str(r["unit_number"]),
                    "state": r["jurisdiction"], "miles": r["miles"]})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--whoami", action="store_true",
                    help="prove the token works with one small real call; fetch nothing else")
    ap.add_argument("--ifta", action="store_true", help="pull the per-vehicle jurisdiction summary")
    ap.add_argument("--start-date", help="YYYY-MM-DD")
    ap.add_argument("--end-date", help="YYYY-MM-DD")
    ap.add_argument("--company", help="required to also write mileage_rows JSON for state_tax_engine")
    ap.add_argument("--period", help="the week/period label to stamp on mileage_rows (with --company)")
    a = ap.parse_args()
    token = read_token()

    if a.whoami:
        try:
            payload = _get(token, "/v1/ifta/summary", {"per_page": 1, "page_no": 1})
            n = (payload.get("pagination") or {}).get("total", len(payload.get("ifta_trips", [])))
            print(f"  CAN AUTH   {n} ifta_trip row(s) visible in the default 7-day window")
        except requests.exceptions.HTTPError as exc:
            print(f"  NO AUTH    [{exc.response.status_code}] "
                  f"{(exc.response.json() or {}).get('message', exc.response.text[:200])}")
        except Exception as exc:
            print(f"  NO AUTH    [{type(exc).__name__}] {exc}")

    if not a.ifta:
        if not a.whoami:
            raise SystemExit("Nothing to do -- pass --whoami and/or --ifta (see --help)")
        return

    if not (a.start_date and a.end_date):
        raise SystemExit("--ifta needs --start-date and --end-date")
    rows = pull_ifta_summary(token, a.start_date, a.end_date)
    states = sorted({r["jurisdiction"] for r in rows if r["jurisdiction"]})
    print(f"  {len(rows)} (vehicle, jurisdiction) row(s), {len(states)} jurisdiction(s): "
          f"{', '.join(states)}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"ifta-{a.start_date}-to-{a.end_date}.json").write_text(json.dumps(rows, indent=2))

    if a.company:
        mileage_rows = to_mileage_rows(rows, a.company, a.period or a.start_date)
        (OUT_DIR / f"mileage_rows-{a.company}-{a.period or a.start_date}.json").write_text(
            json.dumps(mileage_rows, indent=2))
        print(f"  wrote {len(mileage_rows)} mileage_rows for state_tax_engine "
              f"(company={a.company}, period={a.period or a.start_date})")


if __name__ == "__main__":
    main()
