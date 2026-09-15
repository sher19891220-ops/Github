"""Samsara: live per-truck odometer readings and IFTA state-mileage reports,
straight from the API.

CLAUDE.md's own mileage-source hierarchy has ranked Samsara above QuickManage
and Google Sheets since before this pipeline's first commit ("Mileage before
money ... Source preference: Samsara (telematics) > QuickManage > Google
Sheets") -- but until 2026-09-15 Samsara only ever appeared in this corpus as
a BILLING line item (an invoice cost), never as a connected data source. The
operator supplied a working API token that day, confirmed reachable and
returning this fleet's own 91 vehicles -- unit numbers (449248, 8092, 15862,
8671, 9859, 15852, ...) matching this project's own known fleet exactly, not
a demo account.

ONE TOKEN COVERS THE WHOLE GROUP. Unlike QuickManage (a separate client_id/
client_secret pair per operating company, because QuickManage has no
group-wide key), Samsara bills to one account across ZONE/XTRACK/AFG --
consistent with CLAUDE.md's own telematics-cost finding ("A vendor 'billed to
ZONE-OH' does not mean ZONE's fleet alone"). So there is exactly one
credential here, not three, and no --only <company> flag the way
pull_quickmanage.py has one.

TWO PULLS:
  --vehicles   GET /fleet/vehicles/stats?types=obdOdometerMeters,gpsOdometerMeters
               Current odometer per vehicle -- confirmed working 2026-09-15.
  --ifta       GET /fleet/reports/ifta/vehicle?year=Y&quarter=Qn (or &month=)
               Per-vehicle, per-jurisdiction (state) mileage -- exactly the
               shape needed to close the Oregon mileage gap and the ZONE/
               XTRACK mpg reconciliation this project has so far done by
               OCR-ing scanned state filings (see docs/FINDINGS.md's Oregon
               and pnl_accuracy sections). NOT YET CROSS-CHECKED against
               those filings -- this script only pulls and shapes the data;
               the reconciliation itself is separate, undone follow-up work.

DISTANCES COME BACK IN METERS; THIS MODULE CONVERTS TO MILES ON THE WAY OUT
(1 mile = 1609.344 m) so nothing downstream has to remember to, the same
reasoning analysis/tire_cost.py and others apply to any unit conversion.

CREDENTIALS LIVE IN AN ENVIRONMENT VARIABLE, NOT ON DISK -- same reasoning as
ingest/pull_sheets.py and ingest/pull_quickmanage.py: this container is
ephemeral, and a key written to a tracked or even gitignored file has to be
re-supplied by hand after every reclaim, while an environment variable set on
the remote environment survives restarts.

    SAMSARA_API_TOKEN   the bearer token, e.g. samsara_api_...

NO ERROR MESSAGE, LOG LINE, OR SAVED FILE MAY CONTAIN THE TOKEN. Only vehicle
counts and unit numbers (not secrets) are ever printed. Raw, shaped API
responses ARE saved to disk (data/raw/samsara/) because that is the actual
data being fetched, not the credential that fetched it.

Setup, once (config/samsara_credentials.example.json shows the shape):
    export SAMSARA_API_TOKEN='samsara_api_...'
    python3 ingest/pull_samsara.py --whoami              # proves the token works, fetches nothing
    python3 ingest/pull_samsara.py --vehicles            # current odometer, all vehicles
    python3 ingest/pull_samsara.py --ifta --year 2026 --quarter Q2
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
ENV_VAR = "SAMSARA_API_TOKEN"
CREDS_FILE = ROOT / "config/samsara_credentials.json"
BASE = "https://api.samsara.com"
OUT_DIR = ROOT / "data/raw/samsara"
METERS_PER_MILE = 1609.344


def read_token():
    """Never returns or logs the raw token value in an error message --
    only where it came from (an env var name, or a file path, neither of
    which is a secret)."""
    token = os.environ.get(ENV_VAR, "").strip()
    where = f"${ENV_VAR}"
    if not token:
        if not CREDS_FILE.exists():
            raise SystemExit(
                f"No Samsara token: ${ENV_VAR} is unset and there is no file "
                f"at config/samsara_credentials.json. See this module's "
                f"docstring, or config/samsara_credentials.example.json for "
                f"the file's shape.")
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
                     headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    return r.json()


def _paginate_list(token, path, params=None):
    """Samsara's list endpoints page via pagination.endCursor/hasNextPage,
    passed back in as the `after` query param -- confirmed against
    /fleet/vehicles/stats, which returned hasNextPage=false in one page for
    this fleet's 91 vehicles, so the loop below is exercised only if the
    fleet grows past whatever page size Samsara applies."""
    params = dict(params or {})
    rows = []
    while True:
        payload = _get(token, path, params)
        rows.extend(payload.get("data", []))
        pg = payload.get("pagination", {})
        if not pg.get("hasNextPage"):
            return rows
        params["after"] = pg["endCursor"]


def m_to_mi(meters):
    return round(meters / METERS_PER_MILE, 1) if meters is not None else None


def pull_vehicles(token, save=True):
    raw = _paginate_list(token, "/fleet/vehicles/stats",
                         {"types": "obdOdometerMeters,gpsOdometerMeters"})
    rows = []
    for v in raw:
        obd = v.get("obdOdometerMeters") or {}
        gps = v.get("gpsOdometerMeters") or {}
        rows.append({
            "samsara_id": v["id"],
            "unit_number": v.get("name"),
            "vin": (v.get("externalIds") or {}).get("samsara.vin"),
            "obd_odometer_miles": m_to_mi(obd.get("value")),
            "obd_odometer_time": obd.get("time"),
            "gps_odometer_miles": m_to_mi(gps.get("value")),
            "gps_odometer_time": gps.get("time"),
        })
    if save:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        (OUT_DIR / f"vehicles-{stamp}.json").write_text(json.dumps(rows, indent=2))
    return rows


def pull_ifta(token, year, quarter=None, month=None, save=True):
    """Confirmed 2026-09-15: this account's token returns 403 'No access to
    required licenses' on this endpoint -- IFTA Reporting is a separate,
    licensed Samsara add-on, not a token-scope problem the same fix that
    works for vehicles/stats would solve. Surfaced as a clear SystemExit
    rather than a raw traceback, since this needs the account owner to
    enable the feature in Samsara, not a code change here."""
    params = {"year": year}
    if quarter:
        params["quarter"] = quarter
    if month:
        params["month"] = month
    try:
        payload = _get(token, "/fleet/reports/ifta/vehicle", params)
    except requests.exceptions.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 403:
            raise SystemExit(
                "Samsara returned 403 on the IFTA endpoint: "
                f"{exc.response.json().get('message', '(no message)')}. "
                "This is an account-level licensing gap, not a token or code "
                "problem -- IFTA Reporting is a separate paid Samsara "
                "feature. --vehicles (odometer) is unaffected and works on "
                "this token.")
        raise
    d = payload.get("data", {})
    rows = []
    for vr in d.get("vehicleReports", []):
        veh = vr.get("vehicle", {})
        for j in vr.get("jurisdictions", []):
            rows.append({
                "unit_number": veh.get("name"),
                "samsara_id": veh.get("id"),
                "jurisdiction": j.get("jurisdiction"),
                "taxable_miles": m_to_mi(j.get("taxableMeters")),
                "total_miles": m_to_mi(j.get("totalMeters")),
                "tax_paid_liters": j.get("taxPaidLiters"),
            })
    if save:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        period_label = quarter or month or "annual"
        (OUT_DIR / f"ifta-{year}-{period_label}.json").write_text(json.dumps(rows, indent=2))
    return rows, d.get("troubleshooting", {})


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--whoami", action="store_true",
                    help="prove the token works; fetch nothing")
    ap.add_argument("--vehicles", action="store_true",
                    help="pull current odometer for every vehicle")
    ap.add_argument("--ifta", action="store_true",
                    help="pull the IFTA per-vehicle jurisdiction report")
    ap.add_argument("--year", type=int, help="IFTA report year, e.g. 2026")
    ap.add_argument("--quarter", help="Q1/Q2/Q3/Q4 -- cannot combine with --month")
    ap.add_argument("--month", help="January..December -- cannot combine with --quarter")
    a = ap.parse_args()

    token = read_token()

    if a.whoami:
        try:
            payload = _get(token, "/fleet/vehicles/stats", {"types": "obdOdometerMeters"})
            print(f"  CAN AUTH   {len(payload.get('data', []))} vehicle(s) visible")
        except Exception as exc:
            print(f"  NO AUTH    [{type(exc).__name__}] {exc}")
        return

    if not (a.vehicles or a.ifta):
        raise SystemExit("Nothing to do -- pass --vehicles and/or --ifta (see --help)")

    if a.vehicles:
        rows = pull_vehicles(token)
        with_odo = sum(1 for r in rows if r["obd_odometer_miles"] is not None)
        print(f"  vehicles: {len(rows)}  ({with_odo} with an OBD odometer reading)")

    if a.ifta:
        if not a.year:
            raise SystemExit("--ifta requires --year")
        if a.quarter and a.month:
            raise SystemExit("--quarter and --month cannot both be set")
        rows, trouble = pull_ifta(token, a.year, a.quarter, a.month)
        states = sorted({r["jurisdiction"] for r in rows if r["jurisdiction"]})
        print(f"  ifta {a.year} {a.quarter or a.month or '(annual)'}: "
              f"{len(rows)} vehicle-jurisdiction rows, {len(states)} jurisdictions "
              f"({', '.join(states)})")
        if trouble.get("noPurchasesFound"):
            print("  WARNING: Samsara reports no fuel purchases found for this period")

    print(f"\n  Saved under {OUT_DIR.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
