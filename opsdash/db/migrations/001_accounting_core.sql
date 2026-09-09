-- =====================================================================
-- Migration 001 — Accounting core schema
--
-- Target: the EXISTING aiops PostgreSQL instance (CLAUDE.md §1).
-- Creates everything inside a dedicated `accounting` schema so that
-- nothing here can collide with, or be dropped by, the n8n workflows
-- that own `public`. Nothing in `public` is read-write to this app.
--
-- NOT YET APPLIED. Run 001_confirm_ground_truth.sql first.
-- =====================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS accounting;

-- ---------------------------------------------------------------------
-- 0. Types
-- ---------------------------------------------------------------------

-- How a number got here. Every ledger row must declare one, and the
-- CHECK on ledger_entry forces the matching provenance pointer to be set.
CREATE TYPE accounting.source_kind AS ENUM (
  'document',      -- drag-drop upload (fuel / toll / maintenance-cost)
  'connector',     -- pulled from an existing public.* table
  'derived',       -- output of a calc engine run (IFTA, permit)
  'adjustment'     -- human correction; always references the entry it reverses
);

CREATE TYPE accounting.doc_type AS ENUM ('fuel','toll','maintenance');

CREATE TYPE accounting.staging_status AS ENUM (
  'parsed', 'under_review', 'committed', 'rejected'
);

CREATE TYPE accounting.driver_class AS ENUM (
  'lease_to_own', 'company', 'owner_operator', 'unassigned'
);

-- ---------------------------------------------------------------------
-- 1. Dimensions
--
-- Canonical IDs owned by this schema. The existing tables key on Samsara
-- IDs, dispatch IDs and free-text truck numbers that do not agree with
-- each other; source_key_map is the single crosswalk. Dispatch/Fleet/COO
-- dashboards plug in here later (§4.7) rather than re-deriving identity.
-- ---------------------------------------------------------------------

CREATE TABLE accounting.entity (
  entity_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,          -- 'ZONE', 'XTRACK', 'AFG'
  legal_name    text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounting.truck (
  truck_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_number   text NOT NULL,                 -- what the office calls it
  vin           text,
  weight_class  smallint,                      -- permit engine input (§4.4)
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_number)
);

CREATE TABLE accounting.driver (
  driver_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     text NOT NULL,
  cdl_number    text,
  cdl_state     char(2),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A truck moves between companies and a driver converts from company to
-- lease-to-own mid-year. Without effective-dated history, every historical
-- P&L slice silently reclassifies when someone changes today's assignment.
CREATE TABLE accounting.truck_entity_history (
  truck_id        uuid NOT NULL REFERENCES accounting.truck(truck_id),
  entity_id       uuid NOT NULL REFERENCES accounting.entity(entity_id),
  effective_from  date NOT NULL,
  effective_to    date,                         -- NULL = current
  PRIMARY KEY (truck_id, effective_from),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE accounting.driver_class_history (
  driver_id       uuid NOT NULL REFERENCES accounting.driver(driver_id),
  class           accounting.driver_class NOT NULL,
  entity_id       uuid REFERENCES accounting.entity(entity_id),
  effective_from  date NOT NULL,
  effective_to    date,
  PRIMARY KEY (driver_id, effective_from),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Crosswalk from any upstream system's key to a canonical dimension row.
CREATE TABLE accounting.source_key_map (
  canonical_kind  text NOT NULL CHECK (canonical_kind IN ('entity','truck','driver')),
  canonical_id    uuid NOT NULL,
  source_system   text NOT NULL,   -- 'samsara' | 'motive' | 'dispatch' | 'sheets' | 'efs'
  source_table    text,            -- e.g. 'samsara_vehicles'
  source_key      text NOT NULL,   -- the upstream PK / external id, as text
  confidence      text NOT NULL DEFAULT 'confirmed'
                    CHECK (confidence IN ('confirmed','inferred')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_key, canonical_kind)
);
CREATE INDEX ix_skm_canonical ON accounting.source_key_map (canonical_kind, canonical_id);

-- ---------------------------------------------------------------------
-- 2. Category taxonomy — maintained data, not a code enum, so a new
--    cost type does not require a deploy.
-- ---------------------------------------------------------------------

CREATE TABLE accounting.category (
  category_id   text PRIMARY KEY,               -- 'fuel.diesel', 'toll.ezpass'
  category_group text NOT NULL CHECK (category_group IN (
                    'revenue','fuel','toll','maintenance','permit','ifta',
                    'insurance','driver_pay','lease','other_cost')),
  display_name  text NOT NULL,
  -- +1 = increases margin (revenue), -1 = decreases margin (cost).
  sign          smallint NOT NULL CHECK (sign IN (-1, 1)),
  is_active     boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- 3. Ingestion — drag-drop path (§4.1)
-- ---------------------------------------------------------------------

CREATE TABLE accounting.source_document (
  document_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type      accounting.doc_type NOT NULL,
  file_name     text NOT NULL,
  mime_type     text NOT NULL,
  byte_size     bigint NOT NULL,
  sha256        char(64) NOT NULL,
  storage_key   text NOT NULL,      -- object storage; bytes never live in PG
  page_count    integer,
  uploaded_by   text NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  parser_name    text,
  parser_version text,
  parse_status  text NOT NULL DEFAULT 'pending'
                  CHECK (parse_status IN ('pending','parsed','failed')),
  parse_error   text,
  -- Re-dropping the same file is a no-op rather than a double-post.
  UNIQUE (sha256)
);

-- Human-editable review table. parsed_payload is what the parser produced
-- and is never mutated; reviewed_payload holds the operator's edits. Both
-- are kept so an edited number still traces back to the document AND to
-- what the machine originally read (§2: no silent estimates).
CREATE TABLE accounting.staging_row (
  staging_row_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES accounting.source_document(document_id)
                    ON DELETE CASCADE,
  row_index       integer NOT NULL,
  source_page     integer,
  parsed_payload  jsonb NOT NULL,
  reviewed_payload jsonb,
  -- Normalized proposal, edited in the review screen before commit.
  entity_id       uuid REFERENCES accounting.entity(entity_id),
  truck_id        uuid REFERENCES accounting.truck(truck_id),
  driver_id       uuid REFERENCES accounting.driver(driver_id),
  accrual_date    date,
  category_id     text REFERENCES accounting.category(category_id),
  amount          numeric(14,2),
  quantity        numeric(14,4),        -- gallons for fuel, NULL otherwise
  jurisdiction    char(2),              -- purchase state; IFTA tax-paid input
  status          accounting.staging_status NOT NULL DEFAULT 'parsed',
  review_notes    text,
  reviewed_by     text,
  reviewed_at     timestamptz,
  committed_entry_id uuid,              -- FK added after ledger_entry exists
  UNIQUE (document_id, row_index)
);
CREATE INDEX ix_staging_status ON accounting.staging_row (status, document_id);

-- ---------------------------------------------------------------------
-- 4. Connector provenance — pull path (§1 build directive: join, do not
--    re-ingest). The jsonb snapshot is the point: n8n keeps updating
--    public.*, so "traced to a connector pull" is only meaningful if we
--    can show what the pull actually returned at posting time.
-- ---------------------------------------------------------------------

CREATE TABLE accounting.connector_pull (
  pull_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL,
  source_table  text NOT NULL,     -- 'load_pipeline', 'samsara_fuel_reports'
  source_pk     text NOT NULL,     -- upstream row identity, as text
  snapshot      jsonb NOT NULL,    -- the row as read
  payload_hash  char(64) NOT NULL, -- sha256 of snapshot, for change detection
  pulled_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, source_table, source_pk, payload_hash)
);
CREATE INDEX ix_pull_lookup ON accounting.connector_pull (source_table, source_pk, pulled_at DESC);

-- ---------------------------------------------------------------------
-- 5. Ledger — append-only. Corrections post a reversing entry; nothing
--    is UPDATEd or DELETEd. This is what makes §8's first acceptance
--    criterion enforceable rather than aspirational.
-- ---------------------------------------------------------------------

CREATE TABLE accounting.ledger_entry (
  entry_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Dimensions, snapshotted at post time from the effective-dated history
  -- tables so a later reassignment cannot rewrite a closed period.
  entity_id       uuid NOT NULL REFERENCES accounting.entity(entity_id),
  truck_id        uuid REFERENCES accounting.truck(truck_id),
  driver_id       uuid REFERENCES accounting.driver(driver_id),
  driver_class    accounting.driver_class NOT NULL DEFAULT 'unassigned',

  accrual_date    date NOT NULL,          -- the day the money belongs to
  category_id     text NOT NULL REFERENCES accounting.category(category_id),
  amount          numeric(14,2) NOT NULL, -- signed: + inflow, - outflow. Never float.
  currency        char(3) NOT NULL DEFAULT 'USD',
  quantity        numeric(14,4),          -- gallons / miles where meaningful
  jurisdiction    char(2),                -- state, where meaningful

  -- Provenance. Exactly one pointer, matching source_kind.
  source_kind        accounting.source_kind NOT NULL,
  source_document_id uuid REFERENCES accounting.source_document(document_id),
  staging_row_id     uuid REFERENCES accounting.staging_row(staging_row_id),
  connector_pull_id  uuid REFERENCES accounting.connector_pull(pull_id),
  calc_run_id        uuid,                -- FK added after calc_run exists
  reverses_entry_id  uuid REFERENCES accounting.ledger_entry(entry_id),

  memo            text,
  posted_by       text NOT NULL,
  posted_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provenance_matches_kind CHECK (
    CASE source_kind
      WHEN 'document'   THEN source_document_id IS NOT NULL
                         AND connector_pull_id  IS NULL
                         AND calc_run_id        IS NULL
      WHEN 'connector'  THEN connector_pull_id  IS NOT NULL
                         AND source_document_id IS NULL
                         AND calc_run_id        IS NULL
      WHEN 'derived'    THEN calc_run_id        IS NOT NULL
                         AND source_document_id IS NULL
                         AND connector_pull_id  IS NULL
      WHEN 'adjustment' THEN reverses_entry_id  IS NOT NULL
    END
  )
);

CREATE INDEX ix_ledger_entity_date   ON accounting.ledger_entry (entity_id, accrual_date);
CREATE INDEX ix_ledger_truck_date    ON accounting.ledger_entry (truck_id, accrual_date);
CREATE INDEX ix_ledger_driver_date   ON accounting.ledger_entry (driver_id, accrual_date);
CREATE INDEX ix_ledger_category_date ON accounting.ledger_entry (category_id, accrual_date);
CREATE INDEX ix_ledger_jurisdiction  ON accounting.ledger_entry (jurisdiction, accrual_date)
  WHERE jurisdiction IS NOT NULL;

-- One connector row posts at most one entry per category: re-running an
-- ingest job is idempotent instead of double-counting revenue.
CREATE UNIQUE INDEX ux_ledger_connector_once
  ON accounting.ledger_entry (connector_pull_id, category_id)
  WHERE connector_pull_id IS NOT NULL;

CREATE UNIQUE INDEX ux_ledger_staging_once
  ON accounting.ledger_entry (staging_row_id)
  WHERE staging_row_id IS NOT NULL;

ALTER TABLE accounting.staging_row
  ADD CONSTRAINT fk_staging_committed_entry
  FOREIGN KEY (committed_entry_id) REFERENCES accounting.ledger_entry(entry_id);

-- Append-only enforcement.
CREATE OR REPLACE FUNCTION accounting.reject_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'accounting.ledger_entry is append-only; post a reversing entry instead';
END;
$fn$;

CREATE TRIGGER trg_ledger_no_update BEFORE UPDATE OR DELETE
  ON accounting.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION accounting.reject_ledger_mutation();

-- ---------------------------------------------------------------------
-- 6. Calc engine runs and rate tables (§4.3, §4.4)
-- ---------------------------------------------------------------------

CREATE TABLE accounting.calc_run (
  calc_run_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engine        text NOT NULL CHECK (engine IN ('ifta','permit','pnl','forecast')),
  engine_version text NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  inputs_hash   char(64) NOT NULL,   -- reruns are comparable
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','failed')),
  error         text
);

ALTER TABLE accounting.ledger_entry
  ADD CONSTRAINT fk_ledger_calc_run
  FOREIGN KEY (calc_run_id) REFERENCES accounting.calc_run(calc_run_id);

-- IFTA rates change every quarter. Effective-dated, never hardcoded.
CREATE TABLE accounting.ifta_rate (
  jurisdiction    char(2) NOT NULL,
  fuel_type       text NOT NULL DEFAULT 'diesel',
  period_year     smallint NOT NULL,
  period_quarter  smallint NOT NULL CHECK (period_quarter BETWEEN 1 AND 4),
  rate_per_gallon numeric(10,5) NOT NULL,
  surcharge_per_gallon numeric(10,5) NOT NULL DEFAULT 0,
  source_note     text NOT NULL,      -- where the rate came from
  entered_by      text NOT NULL,
  entered_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (jurisdiction, fuel_type, period_year, period_quarter)
);

CREATE TABLE accounting.ifta_liability (
  ifta_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calc_run_id     uuid NOT NULL REFERENCES accounting.calc_run(calc_run_id),
  entity_id       uuid NOT NULL REFERENCES accounting.entity(entity_id),
  truck_id        uuid REFERENCES accounting.truck(truck_id), -- NULL = company roll-up
  period_year     smallint NOT NULL,
  period_quarter  smallint NOT NULL CHECK (period_quarter BETWEEN 1 AND 4),
  jurisdiction    char(2) NOT NULL,
  taxable_miles       numeric(14,2) NOT NULL,
  taxable_gallons     numeric(14,4) NOT NULL,  -- miles / fleet MPG
  tax_paid_gallons    numeric(14,4) NOT NULL,  -- purchased in-state, tax paid
  rate_per_gallon     numeric(10,5) NOT NULL,
  net_liability       numeric(14,2) NOT NULL,  -- + owed, - credit
  UNIQUE (calc_run_id, entity_id, truck_id, period_year, period_quarter, jurisdiction)
);

CREATE TABLE accounting.permit_rate (
  permit_rate_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction    char(2) NOT NULL,
  permit_type     text NOT NULL,
  weight_class_min smallint NOT NULL,
  weight_class_max smallint NOT NULL,
  basis           text NOT NULL CHECK (basis IN ('flat','per_mile','per_trip')),
  rate            numeric(12,4) NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  source_note     text NOT NULL,
  entered_by      text NOT NULL,
  entered_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (weight_class_max >= weight_class_min),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX ix_permit_rate_lookup
  ON accounting.permit_rate (jurisdiction, permit_type, effective_from DESC);

CREATE TABLE accounting.permit_cost (
  permit_cost_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calc_run_id     uuid NOT NULL REFERENCES accounting.calc_run(calc_run_id),
  entity_id       uuid NOT NULL REFERENCES accounting.entity(entity_id),
  truck_id        uuid REFERENCES accounting.truck(truck_id),
  jurisdiction    char(2) NOT NULL,
  permit_rate_id  uuid NOT NULL REFERENCES accounting.permit_rate(permit_rate_id),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  miles           numeric(14,2),
  weight_class    smallint,
  cost            numeric(14,2) NOT NULL
);

-- ---------------------------------------------------------------------
-- 7. P&L rollup cache (§4.5) — a cache, never the source of truth.
--    Must be fully rebuildable from ledger_entry alone.
-- ---------------------------------------------------------------------

CREATE TABLE accounting.pnl_period (
  pnl_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calc_run_id     uuid NOT NULL REFERENCES accounting.calc_run(calc_run_id),
  grain           text NOT NULL CHECK (grain IN ('day','week','month','quarter','year')),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  entity_id       uuid REFERENCES accounting.entity(entity_id),  -- NULL = all entities
  truck_id        uuid REFERENCES accounting.truck(truck_id),
  driver_id       uuid REFERENCES accounting.driver(driver_id),
  driver_class    accounting.driver_class,
  category_group  text NOT NULL,
  amount          numeric(14,2) NOT NULL,
  entry_count     integer NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_pnl_lookup ON accounting.pnl_period (grain, period_start, entity_id);

-- ---------------------------------------------------------------------
-- 8. Forecast (§4.6) — reserved now so Phase 5 needs no schema change.
-- ---------------------------------------------------------------------

CREATE TABLE accounting.forecast_run (
  forecast_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calc_run_id     uuid NOT NULL REFERENCES accounting.calc_run(calc_run_id),
  entity_id       uuid REFERENCES accounting.entity(entity_id),
  horizon_start   date NOT NULL,
  horizon_end     date NOT NULL,
  metric          text NOT NULL CHECK (metric IN ('revenue','cost','margin')),
  point_estimate  numeric(14,2) NOT NULL,
  lower_bound     numeric(14,2) NOT NULL,
  upper_bound     numeric(14,2) NOT NULL,
  confidence_level numeric(4,3) NOT NULL DEFAULT 0.800,
  method          text NOT NULL,
  -- What the estimate was built from, for the "no silent estimates" rule.
  basis           jsonb NOT NULL,
  -- Filled in after the week closes; drives the §8 back-test.
  actual          numeric(14,2),
  CHECK (upper_bound >= point_estimate AND point_estimate >= lower_bound)
);

-- ---------------------------------------------------------------------
-- 9. Fuel reconciliation (§8: reconciled against Samsara, not re-ingested)
-- ---------------------------------------------------------------------

CREATE TABLE accounting.fuel_reconciliation (
  recon_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calc_run_id     uuid REFERENCES accounting.calc_run(calc_run_id),
  truck_id        uuid NOT NULL REFERENCES accounting.truck(truck_id),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  document_gallons  numeric(14,4) NOT NULL,  -- from EFS/Relay upload
  connector_gallons numeric(14,4) NOT NULL,  -- from samsara_fuel_reports
  variance_gallons  numeric(14,4) NOT NULL,
  variance_pct      numeric(8,4),
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','accepted','disputed','resolved')),
  resolved_by     text,
  resolved_at     timestamptz,
  notes           text
);

-- ---------------------------------------------------------------------
-- 10. Audit
-- ---------------------------------------------------------------------

CREATE TABLE accounting.audit_event (
  audit_id      bigserial PRIMARY KEY,
  actor         text NOT NULL,
  action        text NOT NULL,
  object_type   text NOT NULL,
  object_id     text,
  detail        jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_object ON accounting.audit_event (object_type, object_id, occurred_at DESC);

COMMIT;
