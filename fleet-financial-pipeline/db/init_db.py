"""Create the database from schema.sql. Safe to re-run — uses IF NOT EXISTS."""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "fleet_financials.db"
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"

if __name__ == "__main__":
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA_PATH.read_text())
    conn.commit()
    conn.close()
    print(f"Database ready at {DB_PATH}")
