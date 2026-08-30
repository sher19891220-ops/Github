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
