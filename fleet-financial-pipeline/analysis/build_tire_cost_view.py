"""
Builds the dashboard payload for measured tire cost, per company and fleet-
wide. Reads ONLY analysis/tire_cost.py's own already-tested functions --
nothing here recomputes a number, it only shapes tire_cost.py's output into
the JSON the dashboard template wants.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import tire_cost as TC  # noqa: E402


def main():
    figures = TC.company_figures()
    fleet = TC.fleet_figure(figures)
    out = {
        "companies": figures,
        "fleet": fleet,
        "window": list(TC.WINDOW),
        "note": "Truck and trailer tire changes, company-borne only (driver-billed and "
                "Iron-Lease-reversal rows excluded), measured from the maintenance ledger "
                "already in this corpus -- not an industry benchmark. Per loaded mile, "
                "matching every other variable-cost line here. This draws on the primary "
                "maintenance ledger only, not the separate Truck Max invoice log, so treat "
                "it as a measured floor.",
    }
    out_path = ROOT / "data" / "processed" / "tire_cost_view.json"
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
