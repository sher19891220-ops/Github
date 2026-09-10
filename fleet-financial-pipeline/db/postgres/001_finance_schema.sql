-- finance schema in the aiops database.
--
-- Design: financial forensics lives in its own schema alongside operations,
-- NOT inside the operational tables. The forensic schema churns hard while the
-- taxonomy converges, and that churn must not touch the system of record.
-- Operational data (units, maintenance, miles, revenue) is READ through views
-- in 002_ops_views.sql — never copied, never synced.
--
-- Apply:  psql -h 100.77.103.37 -U aiops -d aiops -f db/postgres/001_finance_schema.sql
-- Safe to re-run.

BEGIN;

CREATE SCHEMA IF NOT EXISTS finance;
COMMENT ON SCHEMA finance IS
  'Financial forensics: bank/card ingestion, QuickBooks GL mirror, reconciliation. '
  'Reads units/maintenance/miles/revenue from the operational schema via views.';

-- ---------------------------------------------------------------------------
-- Reference
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS finance.entities (
    entity_id       text PRIMARY KEY,
    legal_name      text NOT NULL,
    dot_number      text,
    is_operating    boolean NOT NULL DEFAULT true,   -- false for leasing/brokerage entities
    notes           text
);

CREATE TABLE IF NOT EXISTS finance.accounts (
    account_id      text PRIMARY KEY,                -- <ENTITY>_<BANK>_<LAST4>
    entity_id       text NOT NULL REFERENCES finance.entities(entity_id),
    account_type    text NOT NULL
        CHECK (account_type IN ('checking','savings','credit_card','factoring','line_of_credit')),
    institution     text,
    last4           text,
    -- Card exports list a CHARGE as positive. Ingest multiplies by this to reach
    -- our cash-flow convention (negative = money out). Per-account, never per-file.
    amount_sign_multiplier smallint NOT NULL DEFAULT 1
        CHECK (amount_sign_multiplier IN (1, -1)),
    active          boolean NOT NULL DEFAULT true
);
COMMENT ON COLUMN finance.accounts.amount_sign_multiplier IS
  'Set -1 for credit cards whose exports report charges as positive. Applied at ingest.';

-- ---------------------------------------------------------------------------
-- Statements — the unit of ingestion, and the basis of the totals control
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS finance.statements (
    statement_id      bigserial PRIMARY KEY,
    account_id        text NOT NULL REFERENCES finance.accounts(account_id),
    period_start      date NOT NULL,
    period_end        date NOT NULL,
    beginning_balance numeric(14,2),
    ending_balance    numeric(14,2),
    source_file       text NOT NULL,
    source_file_hash  text NOT NULL,          -- sha256 of the file; identity for idempotency
    ingested_at       timestamptz NOT NULL DEFAULT now(),
    -- expected net movement for the period, straight from the statement itself
    balance_delta     numeric(14,2)
        GENERATED ALWAYS AS (ending_balance - beginning_balance) STORED,
    notes             text,
    CONSTRAINT statements_file_uniq UNIQUE (source_file_hash),
    CONSTRAINT statements_period_sane CHECK (period_end >= period_start)
);
COMMENT ON TABLE finance.statements IS
  'One row per ingested statement file. beginning/ending balance drive the '
  'statement-total control: parsed transactions must sum to balance_delta.';

-- ---------------------------------------------------------------------------
-- Transactions — independent cash-movement source
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS finance.transactions (
    txn_id          bigserial PRIMARY KEY,
    statement_id    bigint REFERENCES finance.statements(statement_id) ON DELETE CASCADE,
    source_file_hash text NOT NULL,
    file_line_no    integer NOT NULL,        -- position within the source file
    account_id      text NOT NULL REFERENCES finance.accounts(account_id),
    entity_id       text NOT NULL REFERENCES finance.entities(entity_id),
    txn_date        date NOT NULL,           -- real date type: no more year-less '03/14'
    amount          numeric(14,2) NOT NULL,  -- cash-flow signed: negative = money out
    raw_memo        text,
    counterparty    text,
    unit_number     text,                    -- FK deferred to ops roster; see v_units
    category        text,
    is_intercompany boolean NOT NULL DEFAULT false,
    intercompany_pair_id bigint,
    review_flag     text CHECK (review_flag IN ('duplicate','uncategorized','anomaly','sign_suspect')),
    ingested_at     timestamptz NOT NULL DEFAULT now(),
    -- Idempotency: re-ingesting a file updates rows in place instead of doubling them.
    -- Genuine same-day same-amount duplicates stay distinct (different line numbers).
    CONSTRAINT transactions_file_line_uniq UNIQUE (source_file_hash, file_line_no)
);

CREATE INDEX IF NOT EXISTS idx_txn_date     ON finance.transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_entity   ON finance.transactions(entity_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_unit     ON finance.transactions(unit_number) WHERE unit_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_txn_category ON finance.transactions(category);
CREATE INDEX IF NOT EXISTS idx_txn_amount   ON finance.transactions(amount);
CREATE INDEX IF NOT EXISTS idx_txn_pair     ON finance.transactions(intercompany_pair_id)
    WHERE intercompany_pair_id IS NOT NULL;

-- Intercompany pair ids come from a sequence, so re-runs never collide with
-- pairs from an earlier run (the SQLite version restarted at 1 every time).
CREATE SEQUENCE IF NOT EXISTS finance.intercompany_pair_seq AS bigint START 1;

-- ---------------------------------------------------------------------------
-- Records that cannot come from bank memos — manual or structured entry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS finance.incidents (
    incident_id     bigserial PRIMARY KEY,
    unit_number     text,
    entity_id       text REFERENCES finance.entities(entity_id),
    incident_date   date NOT NULL,
    driver_name     text,
    description     text,
    out_of_pocket_cost        numeric(14,2) NOT NULL DEFAULT 0,
    insurance_deductible_paid numeric(14,2) NOT NULL DEFAULT 0,
    claim_filed     boolean NOT NULL DEFAULT false,
    source_file     text,
    CONSTRAINT incidents_has_cost
        CHECK (out_of_pocket_cost <> 0 OR insurance_deductible_paid <> 0 OR claim_filed)
);
COMMENT ON TABLE finance.incidents IS
  'Liability-driven, kept separate from maintenance. out_of_pocket vs deductible '
  'stay in separate columns: deductibles show claims behavior, out-of-pocket shows '
  'what insurance never covered.';

CREATE TABLE IF NOT EXISTS finance.assets (
    asset_id        bigserial PRIMARY KEY,
    unit_number     text,
    entity_id       text REFERENCES finance.entities(entity_id),
    acquisition_type text NOT NULL CHECK (acquisition_type IN ('purchase','lease','rent')),
    acquisition_date date,
    purchase_price  numeric(14,2),
    monthly_payment numeric(14,2),
    term_months     integer,
    lienholder_or_lessor text,
    -- true when the lessor is one of our own entities (Iron Lease LLC).
    -- Those payments are intercompany and must not count as a group-level expense.
    is_intercompany_obligation boolean NOT NULL DEFAULT false,
    source_file     text
);

CREATE TABLE IF NOT EXISTS finance.compliance_costs (
    compliance_id   bigserial PRIMARY KEY,
    unit_number     text,                    -- NULL when entity-level (IFTA usually is)
    entity_id       text NOT NULL REFERENCES finance.entities(entity_id),
    cost_type       text NOT NULL CHECK (cost_type IN ('registration','ifta','permit','other')),
    period          text NOT NULL,           -- '2026-Q1' or '2026'
    amount          numeric(14,2) NOT NULL,
    paid_date       date,
    source_file     text
);

-- ---------------------------------------------------------------------------
-- QuickBooks mirror
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS finance.qb_accounts (
    qb_account_id   text PRIMARY KEY,
    realm_id        text NOT NULL,
    name            text,
    fully_qualified_name text,
    account_type    text,
    account_subtype text,
    active          boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS finance.qb_account_category_map (
    qb_account_id   text PRIMARY KEY REFERENCES finance.qb_accounts(qb_account_id),
    category        text NOT NULL,
    mapped_by       text CHECK (mapped_by IN ('manual','auto_subtype','auto_name')),
    mapped_date     date NOT NULL DEFAULT current_date
);

CREATE TABLE IF NOT EXISTS finance.qb_transactions (
    qb_txn_id       text NOT NULL,
    qb_line_id      text NOT NULL,
    realm_id        text NOT NULL,
    txn_type        text,
    txn_date        date,
    amount          numeric(14,2) NOT NULL,   -- cash-flow signed; see normalize_amount()
    qb_account_id   text REFERENCES finance.qb_accounts(qb_account_id),
    qb_account_name text,
    entity_id       text REFERENCES finance.entities(entity_id),
    class_name      text,
    location_name   text,
    unit_number     text,
    vendor_name     text,
    memo            text,
    category        text,                     -- NULL on cash legs: movement, not a spend category
    bank_account_ref text,
    source_report   text,
    ingested_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (qb_txn_id, qb_line_id)
);

CREATE INDEX IF NOT EXISTS idx_qbtxn_date   ON finance.qb_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_qbtxn_entity ON finance.qb_transactions(entity_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_qbtxn_amount ON finance.qb_transactions(amount);
CREATE INDEX IF NOT EXISTS idx_qbtxn_unit   ON finance.qb_transactions(unit_number)
    WHERE unit_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Reconciliation output
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS finance.reconciliation_results (
    recon_id        bigserial PRIMARY KEY,
    run_id          text NOT NULL,
    run_date        timestamptz NOT NULL DEFAULT now(),
    period_start    date,
    period_end      date,
    mismatch_type   text NOT NULL
        CHECK (mismatch_type IN ('missing_in_qb','missing_in_bank','category_mismatch')),
    entity_id       text,
    amount          numeric(14,2),
    txn_id          bigint REFERENCES finance.transactions(txn_id) ON DELETE CASCADE,
    qb_txn_id       text,
    qb_line_id      text,
    bank_date       date,
    qb_date         date,
    date_delta_days integer,
    bank_category   text,
    qb_category     text,
    bank_memo       text,
    qb_memo         text,
    resolved        boolean NOT NULL DEFAULT false,
    notes           text
);

CREATE INDEX IF NOT EXISTS idx_recon_run  ON finance.reconciliation_results(run_id);
CREATE INDEX IF NOT EXISTS idx_recon_open ON finance.reconciliation_results(mismatch_type)
    WHERE NOT resolved;

-- ---------------------------------------------------------------------------
-- Controls, as views. Query these after every ingest batch.
-- ---------------------------------------------------------------------------

-- THE statement-total control. A statement whose parsed transactions do not sum
-- to (ending - beginning) is a bad parse. This catches double-inserted rows,
-- dropped pages, and sign errors on the first file rather than after 36 months.
CREATE OR REPLACE VIEW finance.v_statement_totals AS
SELECT s.statement_id,
       s.account_id,
       a.entity_id,
       s.period_start,
       s.period_end,
       s.source_file,
       s.beginning_balance,
       s.ending_balance,
       s.balance_delta                                   AS expected_net,
       COALESCE(SUM(t.amount), 0)::numeric(14,2)         AS parsed_net,
       (COALESCE(SUM(t.amount), 0) - s.balance_delta)::numeric(14,2) AS variance,
       COUNT(t.txn_id)                                   AS parsed_rows,
       CASE
         WHEN s.beginning_balance IS NULL OR s.ending_balance IS NULL THEN 'no_balances'
         WHEN ABS(COALESCE(SUM(t.amount), 0) - s.balance_delta) <= 0.01 THEN 'ok'
         -- parsed exactly double the expected movement: the classic double-insert
         WHEN s.balance_delta <> 0
              AND ABS(COALESCE(SUM(t.amount), 0) - 2 * s.balance_delta) <= 0.01 THEN 'double_counted'
         -- parsed the exact negative: whole-file sign inversion, usually a card
         WHEN s.balance_delta <> 0
              AND ABS(COALESCE(SUM(t.amount), 0) + s.balance_delta) <= 0.01 THEN 'sign_inverted'
         ELSE 'variance'
       END AS status
FROM finance.statements s
JOIN finance.accounts a ON a.account_id = s.account_id
LEFT JOIN finance.transactions t ON t.statement_id = s.statement_id
GROUP BY s.statement_id, s.account_id, a.entity_id, s.period_start, s.period_end,
         s.source_file, s.beginning_balance, s.ending_balance, s.balance_delta;

COMMENT ON VIEW finance.v_statement_totals IS
  'Statement-total control. status must be ok. double_counted and sign_inverted '
  'name the two failure modes that are otherwise silent and self-consistent.';

-- Cross-file duplicates: the same transaction appearing under two source files
-- (a monthly and a quarterly export overlapping). Flagged, never auto-deleted --
-- two identical fuel charges on the same day are also legitimately common.
CREATE OR REPLACE VIEW finance.v_suspected_duplicate_transactions AS
SELECT account_id, txn_date, amount, raw_memo,
       COUNT(*)                              AS occurrences,
       COUNT(DISTINCT source_file_hash)      AS distinct_files,
       ARRAY_AGG(txn_id ORDER BY txn_id)     AS txn_ids
FROM finance.transactions
GROUP BY account_id, txn_date, amount, raw_memo
HAVING COUNT(DISTINCT source_file_hash) > 1;

-- Uncategorized exposure in ABSOLUTE dollars. A signed sum lets a -9,500 debit
-- and a +9,500 credit cancel to zero and hide a 19,000 taxonomy gap.
CREATE OR REPLACE VIEW finance.v_uncategorized_by_entity AS
SELECT entity_id,
       DATE_TRUNC('month', txn_date)::date        AS month,
       SUM(ABS(amount))::numeric(14,2)            AS uncategorized_dollars,
       COUNT(*)                                   AS rows,
       SUM(amount)::numeric(14,2)                 AS net_signed
FROM finance.transactions
WHERE category IS NULL OR category = 'uncategorized'
GROUP BY entity_id, DATE_TRUNC('month', txn_date)
ORDER BY uncategorized_dollars DESC;

-- Intercompany money that left one entity and never came back. In multi-entity
-- operations this is where real losses hide.
CREATE OR REPLACE VIEW finance.v_unmatched_intercompany AS
SELECT entity_id, txn_id, txn_date, amount, raw_memo, counterparty
FROM finance.transactions
WHERE category = 'intercompany'
  AND intercompany_pair_id IS NULL
ORDER BY ABS(amount) DESC;

COMMIT;
