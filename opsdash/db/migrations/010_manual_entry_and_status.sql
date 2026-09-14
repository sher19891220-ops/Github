-- =====================================================================
-- Migration 010 — Four ways in, one standard of proof
--
-- The operator's requirement: every figure this system needs must be
-- enterable four ways — dropped as a document, typed by a person, pulled
-- from a Google Sheet, or pulled from an API (Samsara / Motive / ELD) —
-- and every one of them editable afterwards.
--
-- Three of those four already work. The second does not, and not for a
-- UI reason: `provenance_matches_kind` requires a document id, a
-- connector pull id, or a calc run id, and a person typing a number into
-- a form has none of them. A manual entry is currently *uninsertable*.
--
-- There were three ways to fix that and two of them were wrong:
--
--   Reuse 'adjustment'. It requires `reverses_entry_id`, so a first-time
--   manual figure has nothing to reverse. It would also file a fresh
--   assertion under "correction", which is a different thing.
--
--   Fabricate a placeholder source_document. This is the tempting one and
--   the worst one: it makes a typed number indistinguishable from a
--   parsed invoice, in the exact table whose whole job is telling those
--   apart.
--
--   Say what it actually is. A manual figure traces to a named person who
--   asserted it, on a stated basis, at a stated time. That is real
--   provenance — weaker than a document, and the system must render it as
--   weaker rather than letting it pass as the same thing.
--
-- So: `manual` becomes a first-class source_kind, and it is the only one
-- that requires an *attestation* rather than a pointer at a file.
-- =====================================================================

ALTER TYPE accounting.source_kind ADD VALUE IF NOT EXISTS 'manual';

-- Sheet purposes the operator named that the 002 list does not cover.
-- `maintenance_cost` already exists; these are the genuinely new ones.
ALTER TABLE accounting.sheet_source DROP CONSTRAINT sheet_source_purpose_check;
ALTER TABLE accounting.sheet_source ADD CONSTRAINT sheet_source_purpose_check
  CHECK (purpose IN (
    'revenue','fuel','fuel_summary','maintenance_cost','maintenance_log',
    'toll','truck_roster','driver_roster','driver_pay','lease','odometer',
    'factoring','truck_status','ifta_mileage','intercompany'));

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Attestation — the provenance of a number nobody has a document for
-- ---------------------------------------------------------------------

CREATE TABLE accounting.manual_attestation (
  attestation_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who is standing behind this figure. Not "the system", not a service
  -- account: a person who can be asked about it later.
  asserted_by     text NOT NULL,
  asserted_at     timestamptz NOT NULL DEFAULT now(),

  -- What they are going on. "Shop quoted this over the phone", "driver
  -- texted the odometer", "Samsara UI showed this, export not available
  -- yet". Required, because a figure with no stated basis is a guess with
  -- a name attached, and next quarter nobody can tell the difference.
  basis           text NOT NULL,

  -- Set when a real document later turns up for the same fact. The
  -- attestation is not deleted: the history of "we believed X on a phone
  -- call, then the invoice said Y" is exactly what a reconciliation needs.
  superseded_by_document_id uuid REFERENCES accounting.source_document(document_id),
  superseded_at   timestamptz,

  CONSTRAINT basis_is_not_blank CHECK (length(trim(basis)) > 0),
  CONSTRAINT asserter_is_named  CHECK (length(trim(asserted_by)) > 0),

  -- Superseding is one event: the document and the moment travel together.
  CONSTRAINT superseded_is_complete CHECK (
    (superseded_by_document_id IS NULL) = (superseded_at IS NULL)
  )
);

CREATE INDEX ix_attestation_open
  ON accounting.manual_attestation (asserted_at DESC)
  WHERE superseded_by_document_id IS NULL;

COMMENT ON TABLE accounting.manual_attestation IS
  'Provenance for a figure a person typed rather than a document proved. '
  'Weaker evidence than an invoice, deliberately stored as a different '
  'thing so a screen can render it as weaker instead of letting it pass '
  'for a parsed number.';

ALTER TABLE accounting.ledger_entry
  ADD COLUMN attestation_id uuid REFERENCES accounting.manual_attestation(attestation_id);

ALTER TABLE accounting.staging_row
  ADD COLUMN attestation_id uuid REFERENCES accounting.manual_attestation(attestation_id);

-- The load-bearing constraint, extended rather than loosened. A manual
-- entry names its attestation and nothing else; every other kind keeps
-- exactly the rule it had, and no kind may borrow another's evidence.
ALTER TABLE accounting.ledger_entry DROP CONSTRAINT provenance_matches_kind;
ALTER TABLE accounting.ledger_entry
  ADD CONSTRAINT provenance_matches_kind CHECK (
    CASE source_kind
      WHEN 'document'   THEN source_document_id IS NOT NULL
                         AND connector_pull_id  IS NULL
                         AND calc_run_id        IS NULL
                         AND attestation_id     IS NULL
      WHEN 'connector'  THEN connector_pull_id  IS NOT NULL
                         AND source_document_id IS NULL
                         AND calc_run_id        IS NULL
                         AND attestation_id     IS NULL
      WHEN 'derived'    THEN calc_run_id        IS NOT NULL
                         AND source_document_id IS NULL
                         AND connector_pull_id  IS NULL
                         AND attestation_id     IS NULL
      WHEN 'manual'     THEN attestation_id     IS NOT NULL
                         AND source_document_id IS NULL
                         AND connector_pull_id  IS NULL
                         AND calc_run_id        IS NULL
      WHEN 'adjustment' THEN reverses_entry_id  IS NOT NULL
    END
  );

CREATE INDEX ix_ledger_manual
  ON accounting.ledger_entry (accrual_date)
  WHERE source_kind = 'manual';

-- ---------------------------------------------------------------------
-- 2. Truck status — the fleet board's missing source
--
-- The board renders assigned / open / shop / broken-down and the ready
-- and home timers. Nothing in this schema held them, so those panels
-- rendered as "no data" rather than being inferred from dispatch lane
-- text — an inference this project already made once, measured, and
-- found wrong (28 cells carrying a keyword also carried real revenue).
--
-- Status is effective-dated for the same reason truck-to-entity is: "the
-- truck is in the shop" is a fact about a span of days, and a screen
-- showing last Tuesday must show last Tuesday's status, not today's.
-- ---------------------------------------------------------------------

CREATE TYPE accounting.truck_status AS ENUM (
  'assigned',      -- has a driver and is running
  'open',          -- available, no driver
  'shop',          -- in for maintenance
  'broken_down',   -- out of service, not yet in a shop
  'home',          -- driver at home
  'out_of_service' -- OOS: compliance, impound, accident
);

CREATE TYPE accounting.status_source AS ENUM ('samsara', 'motive', 'manual', 'sheet');

CREATE TABLE accounting.truck_status_history (
  status_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  truck_id        uuid NOT NULL REFERENCES accounting.truck(truck_id),
  status          accounting.truck_status NOT NULL,

  effective_from  timestamptz NOT NULL,
  effective_to    timestamptz,          -- null = still in force

  source          accounting.status_source NOT NULL,
  -- A telematics pull names the pull; a manual mark names the person who
  -- made it. Same rule as the ledger: no status without a provenance.
  connector_pull_id uuid REFERENCES accounting.connector_pull(pull_id),
  attestation_id  uuid REFERENCES accounting.manual_attestation(attestation_id),
  note            text,
  recorded_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT status_period_is_ordered CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),

  CONSTRAINT status_names_its_source CHECK (
    CASE source
      WHEN 'manual' THEN attestation_id IS NOT NULL
      WHEN 'sheet'  THEN connector_pull_id IS NOT NULL
      ELSE connector_pull_id IS NOT NULL
    END
  )
);

-- A truck is in one state at a time. Overlapping spans would let the
-- board show a truck simultaneously assigned and in the shop, and a
-- utilisation figure built on that is meaningless.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE accounting.truck_status_history
  ADD CONSTRAINT one_status_per_truck_at_a_time
  EXCLUDE USING gist (
    truck_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  );

CREATE INDEX ix_truck_status_current
  ON accounting.truck_status_history (truck_id, effective_from DESC)
  WHERE effective_to IS NULL;

-- Current status per truck. A truck with no row at all is absent rather
-- than defaulted to 'open': "nobody has told us" and "available" are
-- different facts, and the board says so.
CREATE VIEW accounting.v_truck_status_current AS
SELECT DISTINCT ON (h.truck_id)
  h.truck_id,
  h.status,
  h.effective_from,
  h.source,
  h.note,
  -- What the board's "Ready 24+" / "Home 48+" timers are built from: how
  -- long this truck has been in the state it is in.
  EXTRACT(EPOCH FROM (now() - h.effective_from)) / 3600.0 AS hours_in_status
FROM accounting.truck_status_history h
WHERE h.effective_to IS NULL
ORDER BY h.truck_id, h.effective_from DESC;

COMMENT ON VIEW accounting.v_truck_status_current IS
  'Current status per truck, with hours in that status for the ready/home '
  'timers. A truck absent from this view has no status on file — which is '
  'not the same as being available, and must not render as such.';

COMMIT;
