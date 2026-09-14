-- =====================================================================
-- Migration 002 — Google Sheets sources, expense chargeback, unit type
--
-- Driven by reading the actual production sheets rather than by design
-- guesswork. See docs/SOURCE-DISCOVERY.md for the evidence behind each
-- change. aiops is out of scope as of this migration; Sheets and
-- drag-drop documents are the only inputs.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. New document types.
--
-- 'ifta_mileage' is the Samsara IFTA report export, dropped per quarter.
-- No sheet carries miles by state, so this is the ONLY source for the
-- mileage half of the IFTA engine.
-- 'revenue' covers settlements and rate confirmations, which arrive after
-- the dispatch sheet in the build order but use the same staging path.
-- ---------------------------------------------------------------------

ALTER TYPE accounting.doc_type ADD VALUE IF NOT EXISTS 'ifta_mileage';
ALTER TYPE accounting.doc_type ADD VALUE IF NOT EXISTS 'revenue';

COMMIT;

-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that
-- references the new value, so the rest runs separately.
BEGIN;

-- ---------------------------------------------------------------------
-- 2. Registry of Google Sheets acting as sources of record.
--
-- The sheets are live documents that people edit daily. Recording which
-- file and tab feeds which part of the ledger is what makes a figure
-- explainable six months later, and what lets a sync run incrementally
-- instead of re-reading a 4,000-row sheet every time.
-- ---------------------------------------------------------------------

CREATE TABLE accounting.sheet_source (
  sheet_source_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_file_id   text NOT NULL,
  tab_name        text,
  title           text NOT NULL,
  purpose         text NOT NULL CHECK (purpose IN (
                    'revenue','fuel','fuel_summary','maintenance_cost',
                    'toll','truck_roster','driver_roster','driver_pay',
                    'lease','odometer')),
  -- Sheets change shape without warning: a column gets inserted, a tab is
  -- renamed. Storing the header row we last parsed against lets a sync
  -- fail loudly on a layout change instead of silently reading the wrong
  -- column as an amount.
  expected_header jsonb,
  header_checksum char(64),
  is_active       boolean NOT NULL DEFAULT true,
  last_synced_at  timestamptz,
  last_sync_status text CHECK (last_sync_status IN ('ok','layout_changed','failed')),
  last_sync_error text,
  notes           text,
  UNIQUE (drive_file_id, tab_name)
);

-- ---------------------------------------------------------------------
-- 3. Expense chargeback.
--
-- The maintenance sheet carries an "Expense side" column marking each
-- cost as company or driver. A repair charged back to a lease-to-own
-- driver is not a company cost, and counting it as one overstates cost
-- per truck and understates lease-to-own margin — the exact numbers this
-- dashboard exists to get right.
-- ---------------------------------------------------------------------

CREATE TYPE accounting.charged_to AS ENUM ('company', 'driver', 'split', 'unknown');

ALTER TABLE accounting.ledger_entry
  ADD COLUMN charged_to accounting.charged_to NOT NULL DEFAULT 'company';

ALTER TABLE accounting.staging_row
  ADD COLUMN charged_to accounting.charged_to;

COMMENT ON COLUMN accounting.ledger_entry.charged_to IS
  'Who bears this cost. Driver-charged expenses are excluded from company '
  'P&L and appear instead against the driver, which is what makes '
  'lease-to-own economics readable.';

-- ---------------------------------------------------------------------
-- 4. Unit type.
--
-- Costs land on trailers as often as trucks in the expense sheet
-- ("trl 50272 towing and storage"). Attributing a trailer repair to a
-- truck would corrupt per-truck profitability, so the unit is recorded
-- as it was written and trailer-level rollup is left for later rather
-- than faked now.
-- ---------------------------------------------------------------------

CREATE TYPE accounting.unit_type AS ENUM ('truck', 'trailer', 'other', 'unknown');

-- Defaults to 'unknown', not 'truck'. Defaulting to 'truck' would assert a
-- fact we do not have: a fuel purchase or an office cost legitimately names
-- no unit at all, and claiming it was a truck's is how per-truck cost
-- silently drifts from reality.
ALTER TABLE accounting.ledger_entry
  ADD COLUMN unit_type   accounting.unit_type NOT NULL DEFAULT 'unknown',
  ADD COLUMN unit_number text;

ALTER TABLE accounting.staging_row
  ADD COLUMN unit_type   accounting.unit_type,
  ADD COLUMN unit_number text;

-- A truck-attributed entry must actually name a truck; a trailer cost
-- must not silently masquerade as one.
ALTER TABLE accounting.ledger_entry
  ADD CONSTRAINT unit_type_matches_reference CHECK (
    CASE unit_type
      WHEN 'truck'   THEN truck_id IS NOT NULL OR unit_number IS NOT NULL
      WHEN 'trailer' THEN truck_id IS NULL
      ELSE true
    END
  );

CREATE INDEX ix_ledger_charged_to ON accounting.ledger_entry (charged_to, accrual_date);
CREATE INDEX ix_ledger_unit ON accounting.ledger_entry (unit_type, unit_number)
  WHERE unit_number IS NOT NULL;

COMMIT;
