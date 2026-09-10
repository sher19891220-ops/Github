-- Fleet Financial Forensic Pipeline — Schema
-- One transaction table feeds every downstream view (P&L, per-unit, bleeding points)

CREATE TABLE IF NOT EXISTS entities (
    entity_id       TEXT PRIMARY KEY,   -- e.g. 'ZONE', 'XTRACK', 'AFG', 'IRON_LEASE', 'TRUCKMAX', 'SHAEFFER', 'RUNSTAR'
    legal_name      TEXT,
    dot_number      TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
    account_id      TEXT PRIMARY KEY,   -- your own internal label, e.g. 'ZONE_CHASE_OP', 'XTRACK_AMEX_4417'
    entity_id       TEXT REFERENCES entities(entity_id),
    account_type    TEXT,               -- 'checking' | 'credit_card' | 'savings' | 'factoring'
    institution     TEXT,
    last4           TEXT
);

CREATE TABLE IF NOT EXISTS units (
    unit_number     TEXT PRIMARY KEY,   -- truck/trailer unit number as it appears in memos
    unit_type       TEXT,               -- 'truck' | 'trailer'
    entity_id       TEXT REFERENCES entities(entity_id),
    vin             TEXT,
    in_service_date TEXT,
    out_service_date TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
    txn_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file     TEXT,               -- which uploaded statement this came from (audit trail)
    account_id      TEXT REFERENCES accounts(account_id),
    entity_id       TEXT REFERENCES entities(entity_id),
    txn_date        TEXT,
    amount          REAL,               -- negative = outflow, positive = inflow
    raw_memo        TEXT,
    counterparty    TEXT,               -- cleaned/normalized payee name
    unit_number     TEXT REFERENCES units(unit_number),  -- NULL if not unit-attributable
    category        TEXT,               -- filled by categorize.py
    is_intercompany BOOLEAN DEFAULT 0,
    intercompany_pair_id INTEGER,        -- links matched intercompany transfer pairs
    review_flag     TEXT                 -- 'duplicate' | 'uncategorized' | 'anomaly' | NULL
);

CREATE TABLE IF NOT EXISTS maintenance_events (
    event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_number     TEXT REFERENCES units(unit_number),
    event_date      TEXT,
    cost            REAL,
    downtime_days   REAL,
    breakdown_type  TEXT,               -- 'engine' | 'trans' | 'tire' | 'electrical' | 'PM' | 'other'
    source_file     TEXT
);

-- Incidents: accidents/crashes with out-of-pocket cost and deductibles.
-- Kept separate from maintenance_events because these are liability-driven,
-- not wear-and-tear, and need their own reporting (claims ratio, driver-linked risk).
CREATE TABLE IF NOT EXISTS incidents (
    incident_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_number       TEXT REFERENCES units(unit_number),
    entity_id         TEXT REFERENCES entities(entity_id),
    incident_date      TEXT,
    driver_name         TEXT,
    description         TEXT,
    out_of_pocket_cost   REAL,             -- repairs/costs paid directly, not through insurance
    insurance_deductible_paid REAL,        -- deductible paid on a claim
    claim_filed         BOOLEAN DEFAULT 0,
    source_file          TEXT
);

-- Capital assets: truck/trailer purchases and the lease/rent obligations tied to them.
-- Distinct from routine transactions because these need amortization/term tracking,
-- not just monthly cash-out categorization.
CREATE TABLE IF NOT EXISTS assets (
    asset_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_number         TEXT REFERENCES units(unit_number),
    entity_id           TEXT REFERENCES entities(entity_id),
    acquisition_type      TEXT,            -- 'purchase' | 'lease' | 'rent'
    acquisition_date       TEXT,
    purchase_price          REAL,
    monthly_payment          REAL,
    term_months               INTEGER,
    lienholder_or_lessor       TEXT,
    source_file                 TEXT
);

-- Compliance/fixed costs: registration, IFTA, permits — recurring or annual,
-- worth tracking separately so they don't get lost inside generic "fees" categorization.
CREATE TABLE IF NOT EXISTS compliance_costs (
    compliance_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_number           TEXT REFERENCES units(unit_number),
    entity_id             TEXT REFERENCES entities(entity_id),
    cost_type               TEXT,          -- 'registration' | 'ifta' | 'permit' | 'other'
    period                    TEXT,        -- e.g. '2026-Q1' or '2026'
    amount                     REAL,
    paid_date                   TEXT,
    source_file                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_unit ON transactions(unit_number);
CREATE INDEX IF NOT EXISTS idx_txn_entity ON transactions(entity_id);
CREATE INDEX IF NOT EXISTS idx_maint_unit ON maintenance_events(unit_number);
CREATE INDEX IF NOT EXISTS idx_incident_unit ON incidents(unit_number);
CREATE INDEX IF NOT EXISTS idx_asset_unit ON assets(unit_number);
CREATE INDEX IF NOT EXISTS idx_compliance_unit ON compliance_costs(unit_number);

-- ---------------------------------------------------------------------------
-- QuickBooks Online mirror + reconciliation (dual-source model, PROMPT.md)
-- QuickBooks is the categorized P&L source of truth; `transactions` above stays
-- as the permanent independent cash-movement source. Neither replaces the other.
-- ---------------------------------------------------------------------------

-- Chart of accounts pulled from QBO. Used to map GL accounts -> our taxonomy.
CREATE TABLE IF NOT EXISTS qb_accounts (
    qb_account_id     TEXT PRIMARY KEY,   -- QBO Account.Id
    realm_id          TEXT,               -- QBO company file this account belongs to
    name              TEXT,
    fully_qualified_name TEXT,
    account_type      TEXT,               -- QBO AccountType, e.g. 'Expense', 'Bank'
    account_subtype   TEXT,               -- QBO AccountSubType, e.g. 'FuelExpense'
    active            BOOLEAN DEFAULT 1
);

-- Maps a QBO GL account to our taxonomy category (taxonomy/categorize.py names).
-- Populated once per company file; overrides keyword guessing for QB-sourced rows.
CREATE TABLE IF NOT EXISTS qb_account_category_map (
    qb_account_id     TEXT PRIMARY KEY REFERENCES qb_accounts(qb_account_id),
    category          TEXT NOT NULL,      -- must match a category in CATEGORY_RULES
    mapped_by         TEXT,               -- 'manual' | 'auto_subtype' | 'auto_name'
    mapped_date       TEXT
);

-- GL detail lines from QBO. One row per report line, NOT per transaction:
-- a single QBO transaction splits into several GL lines, each hitting one account.
CREATE TABLE IF NOT EXISTS qb_transactions (
    qb_txn_id         TEXT NOT NULL,      -- QBO transaction Id
    qb_line_id        TEXT NOT NULL,      -- line index/Id within that transaction
    realm_id          TEXT,               -- QBO company file (one per entity if books are separate)
    txn_type          TEXT,               -- 'Purchase' | 'Bill' | 'Deposit' | 'JournalEntry' | ...
    txn_date          TEXT,               -- ISO YYYY-MM-DD
    amount            REAL,               -- SIGNED, same convention as transactions: negative = outflow
    qb_account_id     TEXT REFERENCES qb_accounts(qb_account_id),
    qb_account_name   TEXT,
    entity_id         TEXT REFERENCES entities(entity_id),   -- from realm/class/location mapping
    class_name        TEXT,               -- QBO Class  -> usually entity or unit
    location_name     TEXT,               -- QBO Location -> usually entity
    unit_number       TEXT REFERENCES units(unit_number),
    vendor_name       TEXT,               -- QBO Name column (vendor/customer)
    memo              TEXT,
    category          TEXT,               -- normalized to our taxonomy
    bank_account_ref  TEXT,               -- QB bank/card account the entry cleared through
    source_report     TEXT,               -- audit trail: which report pull produced this row
    ingested_at       TEXT,
    PRIMARY KEY (qb_txn_id, qb_line_id)
);

-- Output of reconcile_quickbooks_vs_bank.py. One row per finding, per run.
CREATE TABLE IF NOT EXISTS reconciliation_results (
    recon_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            TEXT,               -- groups all findings from one run
    run_date          TEXT,
    period_start      TEXT,
    period_end        TEXT,
    mismatch_type     TEXT,               -- 'missing_in_qb' | 'missing_in_bank' | 'category_mismatch'
    entity_id         TEXT,
    amount            REAL,
    txn_id            INTEGER REFERENCES transactions(txn_id),   -- bank side, NULL for missing_in_bank
    qb_txn_id         TEXT,               -- QB side, NULL for missing_in_qb
    qb_line_id        TEXT,
    bank_date         TEXT,
    qb_date           TEXT,
    date_delta_days   INTEGER,
    bank_category     TEXT,
    qb_category       TEXT,
    bank_memo         TEXT,
    qb_memo           TEXT,
    resolved          BOOLEAN DEFAULT 0,  -- set once you've investigated; survives re-runs
    notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_qbtxn_date ON qb_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_qbtxn_entity ON qb_transactions(entity_id);
CREATE INDEX IF NOT EXISTS idx_qbtxn_amount ON qb_transactions(amount);
CREATE INDEX IF NOT EXISTS idx_recon_run ON reconciliation_results(run_id);
CREATE INDEX IF NOT EXISTS idx_recon_type ON reconciliation_results(mismatch_type);

-- ---------------------------------------------------------------------------
-- Statements — the basis of the statement-total control.
-- Every ingested file must satisfy: sum(transactions) == ending - beginning.
-- A statement that fails is a bad parse. Fix the parser; do not ingest.
-- (SQLite joins transactions on source_file; the Postgres schema uses statement_id.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS statements (
    statement_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id        TEXT REFERENCES accounts(account_id),
    period_start      TEXT,
    period_end        TEXT,
    beginning_balance REAL,
    ending_balance    REAL,
    source_file       TEXT UNIQUE,
    source_file_hash  TEXT,
    ingested_at       TEXT,
    notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_statements_account ON statements(account_id);

-- ---------------------------------------------------------------------------
-- Multi-source reconciliation (SQLite mirror of db/postgres/004_multi_source.sql).
-- Every P&L source normalizes into one observation table with a `source` column.
-- Four sources would otherwise mean six pairwise reconcilers that disagree with
-- each other -- worse than no reconciliation at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_category_map (
    source          TEXT NOT NULL,
    source_category TEXT NOT NULL,
    category        TEXT NOT NULL,
    mapped_by       TEXT,
    mapped_date     TEXT,
    PRIMARY KEY (source, source_category)
);

CREATE TABLE IF NOT EXISTS pnl_observations (
    obs_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL,   -- 'gsheets' | 'quickbooks' | 'bank' | 'quickmanage'
    source_detail   TEXT,
    entity_id       TEXT REFERENCES entities(entity_id),
    month           TEXT NOT NULL,   -- ISO first-of-month
    category        TEXT NOT NULL,
    amount          REAL NOT NULL,
    is_stated       INTEGER NOT NULL DEFAULT 1,  -- 0 = derived from cash movement
    raw_category    TEXT,
    loaded_at       TEXT,
    UNIQUE (source, source_detail, entity_id, month, category)
);

CREATE TABLE IF NOT EXISTS odometer_readings (
    reading_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL,   -- 'gsheets' | 'quickmanage' | 'samsara'
    unit_number     TEXT NOT NULL,
    reading_date    TEXT NOT NULL,
    odometer        REAL NOT NULL,
    source_detail   TEXT,
    loaded_at       TEXT,
    UNIQUE (source, unit_number, reading_date)
);

CREATE INDEX IF NOT EXISTS idx_pnl_obs_key ON pnl_observations(entity_id, month, category);
CREATE INDEX IF NOT EXISTS idx_odo_unit ON odometer_readings(unit_number, reading_date);

-- ---------------------------------------------------------------------------
-- Per-unit revenue and utilization from the dispatch board.
-- Revenue is weekly and per truck; the finance side is monthly and per entity,
-- so both grains are kept rather than collapsing early.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unit_revenue (
    rev_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL,          -- 'dispatch'
    unit_number      TEXT NOT NULL,
    entity_id        TEXT,
    week_start       TEXT NOT NULL,          -- Monday of the dispatch week
    month            TEXT,                   -- as the board itself assigns it
    driver_id        TEXT,
    driver_name      TEXT,
    pay_type         TEXT,                   -- CPM | % | LO | OO | Flat
    -- Gross on the load. For OO/LO this is NOT the company's revenue: most of
    -- it belongs to the operator. Stored gross, split applied downstream.
    gross            REAL NOT NULL DEFAULT 0,
    miles            REAL NOT NULL DEFAULT 0,
    load_days        INTEGER NOT NULL DEFAULT 0,
    nonrevenue_days  INTEGER NOT NULL DEFAULT 0,
    transit_days     INTEGER NOT NULL DEFAULT 0,
    is_sub_truck     INTEGER NOT NULL DEFAULT 0,  -- revenue moved off the driver's usual unit
    loaded_at        TEXT,
    UNIQUE (source, unit_number, week_start, driver_id)
);
CREATE INDEX IF NOT EXISTS idx_unit_rev_unit ON unit_revenue(unit_number, week_start);
CREATE INDEX IF NOT EXISTS idx_unit_rev_entity ON unit_revenue(entity_id, month);

-- Utilization is per UNIT-DAY, not per driver. A truck can have two drivers in
-- one week (handoff, team, mid-week swap); summing day counts across drivers
-- reports more days than the calendar holds. Kept in its own table at the grain
-- where a day is a day.
CREATE TABLE IF NOT EXISTS unit_utilization (
    util_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,
    unit_number   TEXT NOT NULL,
    entity_id     TEXT,
    week_start    TEXT NOT NULL,
    month         TEXT,
    load_days     INTEGER NOT NULL DEFAULT 0,
    nonrevenue_days INTEGER NOT NULL DEFAULT 0,
    transit_days  INTEGER NOT NULL DEFAULT 0,
    covered_days  INTEGER NOT NULL DEFAULT 0,   -- distinct days with any entry
    driver_count  INTEGER NOT NULL DEFAULT 0,
    loaded_at     TEXT,
    UNIQUE (source, unit_number, week_start)
);
CREATE INDEX IF NOT EXISTS idx_unit_util ON unit_utilization(unit_number, week_start);
