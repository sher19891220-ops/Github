"""Pull the weekly P&L workbooks straight from Google Sheets, no manual export.

WHY THIS SHAPE AND NOT AN API-CELL-BY-CELL READER. The whole pipeline already
reads .xlsx and depends on one thing the Sheets API makes awkward: THE WEEK IS
ONLY IN THE TAB NAME. So this uses Drive's EXPORT endpoint to fetch each sheet
as a real .xlsx, writes it to the path the pipeline already reads, and stops.
Nothing downstream changes, the parser controls still apply, and the parser cache
invalidates itself because the file's mtime moved.

It also means the manual step this replaces -- open the sheet, File > Download >
.xlsx, upload it here -- disappears without anything else having to know.

WHAT IT DOES NOT DO. It does not write to your sheets. The scope requested is
`drive.readonly`, and a service account that can only read cannot damage the
book the business runs on, however wrong this code might be.

ONLY REWRITE WHEN THE SOURCE MOVED. Drive reports `modifiedTime`; if it is not
newer than the local copy, the download is skipped. A pointless rewrite would
bump the file's mtime, invalidate every cached parse, and cost twenty minutes of
OCR and workbook reading to arrive at the same numbers.

SETUP, ONCE (about five minutes, and it is the part only you can do):

 1. console.cloud.google.com -> create or pick a project
 2. APIs & Services > Library -> enable "Google Drive API" and "Google Sheets API"
 3. APIs & Services > Credentials > Create credentials > SERVICE ACCOUNT
 4. On the new service account > Keys > Add key > JSON. Download it.
 5. Save that JSON as config/gsheets_service_account.json  (already gitignored)
 6. Open each P&L sheet in Google Sheets, press Share, and share it as VIEWER
    with the service account's email (it looks like
    something@your-project.iam.gserviceaccount.com and is inside the JSON).

Then:  python3 ingest/pull_sheets.py            # fetch anything that changed
       python3 ingest/pull_sheets.py --check    # what changed, download nothing
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CREDS = ROOT / "config/gsheets_service_account.json"
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# The sheets, and the local path each one must land on. These paths are the ones
# ingest/ingest_weekly_pnl.py and analysis/truck_breakeven.py already read, so
# nothing downstream needs to know where the file came from.
SHEETS = {
    "ZONE_3YR": {
        "id": "16kM262ojCO15Oxq0lHES2McFF4E-57L-U3M_6DXUp7I",
        "title": "ZONE Profit & Loss 2024 and 2025 and 2026",
        "path": "data/raw/pnl/5f79f0b0-ZONE_Profit__Loss_2024_and_2025_and_2026.xlsx",
    },
    "XTRACK": {
        "id": "1tntDRbgEEGQi_43MnxcK2SpOrO7nB5qYaMjIKm7cIjs",
        "title": "Xtrack LLC Profit and Loss Weekly",
        "path": "data/raw/pnl/1efc7de0-Xtrack_LLC_Profit_and_Loss_Weekly.xlsx",
    },
    "AFG": {
        "id": "1ZLkSoZnuWa9ZAqIISvTRt02OOuvo1Dppap4IrRa6Vg4",
        "title": "AFG Profit and Loss Weekly",
        "path": "data/raw/pnl/b479b596-AFG__download.xlsx",
    },
    # Never yet read by this pipeline. 6.2 MB, last touched 2026-08-31, and the
    # only candidate for the pre-2026 ZONE history that the current workbook's
    # panel layout will not parse.
    "ZONE_OLD": {
        "id": "1HI8HQbNQf5caLmd8oKa6yAxHCzl2UyorP7XLho7k52k",
        "title": "OLD Zone LLC Profit and Loss Weekly",
        "path": "data/raw/pnl/gs-OLD_Zone_LLC_Profit_and_Loss_Weekly.xlsx",
    },
}


def service():
    if not CREDS.exists():
        # relative_to() RAISES when the path is not under ROOT, so building this
        # message the obvious way makes the ERROR MESSAGE crash and hides the
        # real problem behind a ValueError from pathlib. The whole point of this
        # branch is to tell somebody what to do.
        try:
            where = CREDS.relative_to(ROOT)
        except ValueError:
            where = CREDS
        raise SystemExit(
            f"No service account key at {where}.\n"
            f"{__doc__.split('SETUP, ONCE')[1].split('Then:')[0].strip()}")
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    creds = service_account.Credentials.from_service_account_file(
        str(CREDS), scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def remote_mtime(svc, file_id):
    meta = svc.files().get(fileId=file_id,
                           fields="modifiedTime,name,size").execute()
    return (datetime.fromisoformat(meta["modifiedTime"].replace("Z", "+00:00")),
            meta.get("name"))


def local_mtime(path):
    p = ROOT / path
    if not p.exists():
        return None
    return datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)


def fetch(svc, file_id, dest):
    """Export a Google Sheet as .xlsx and write it atomically.

    Atomically because a half-written workbook is not a corrupt file that
    openpyxl rejects loudly -- it is a workbook with FEWER TABS, which parses
    cleanly and silently drops weeks.
    """
    import io
    from googleapiclient.http import MediaIoBaseDownload
    req = svc.files().export_media(fileId=file_id, mimeType=XLSX)
    buf = io.BytesIO()
    dl = MediaIoBaseDownload(buf, req)
    done = False
    while not done:
        _, done = dl.next_chunk()
    out = ROOT / dest
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_bytes(buf.getvalue())
    tmp.replace(out)
    return out.stat().st_size


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="report what changed; download nothing")
    ap.add_argument("--force", action="store_true",
                    help="download even if the local copy is not older")
    ap.add_argument("--only", help="one key from SHEETS")
    a = ap.parse_args()

    svc = service()
    keys = [a.only] if a.only else list(SHEETS)
    changed = 0
    for k in keys:
        s = SHEETS[k]
        rt, name = remote_mtime(svc, s["id"])
        lt = local_mtime(s["path"])
        stale = lt is None or rt > lt
        state = ("NEW" if lt is None else "CHANGED" if stale else "current")
        print(f"  {k:<10}{state:<9}sheet {rt:%Y-%m-%d %H:%M}  "
              f"local {lt:%Y-%m-%d %H:%M}" if lt else
              f"  {k:<10}{state:<9}sheet {rt:%Y-%m-%d %H:%M}  local (absent)")
        if a.check or not (stale or a.force):
            continue
        size = fetch(svc, s["id"], s["path"])
        print(f"             -> {s['path']}  {size / 1e6:.1f} MB")
        changed += 1

    if a.check:
        print("\n  --check only. Run without it to download.")
    elif changed:
        print(f"\n  {changed} workbook(s) refreshed. The parser cache invalidates")
        print("  itself on the new mtime, so the next question re-reads them once.")
        print("  Then: python3 ingest/catalog.py && python3 analysis/facts.py --build")
    else:
        print("\n  Nothing changed; nothing downloaded, and no cache invalidated.")


if __name__ == "__main__":
    main()
