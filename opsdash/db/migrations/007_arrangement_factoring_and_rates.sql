-- =====================================================================
-- Migration 007 — Arrangement types, collection status, cost shape,
--                 and the stated-vs-measured rate pair
--
-- Source: the operator's Fleet Accounting Domain Reference. Four things
-- in it the schema as built cannot express, each of which produces a
-- wrong number rather than a missing one:
--
--   §3  A fourth arrangement, LTWA, exists. `driver_class` has three.
--   §2  "Booked gross <> collected cash", and factoring status is not
--       binary. The ledger records the gross and nothing about whether
--       it was ever collected.
--   §4  Every cost is fixed, variable-per-mile, or variable-%-of-gross,
--       and conflating them is "the single most common source of a
--       wrong break-even number". `category` has a group and a sign.
--   §10 "A stated/contractual rate and a measured/actual rate are
--       different facts and both are worth keeping." We keep one.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. The fourth arrangement (§3)
--
-- Lease-to-walk-away: a fixed weekly rate plus a per-mile charge, and
-- the driver never acquires the truck. Economically it is neither
-- lease-to-own (no equity accrues) nor owner-operator (the group still
-- holds title and carries the equipment). Folding it into either one
-- misstates both populations.
--
-- Outside the transaction below: a new enum value cannot be used in the
-- same transaction that adds it.
-- ---------------------------------------------------------------------

ALTER TYPE accounting.driver_class ADD VALUE IF NOT EXISTS 'ltwa';

-- ---------------------------------------------------------------------
-- 0b. Document families the drag-drop path already has parsers for
--
-- Found by the upload workstream, not by reading: `accounting.doc_type`
-- is {fuel, toll, maintenance, ifta_mileage, revenue}, so an IRP
-- registration PDF cannot be stored at all -- the enum rejects the
-- INSERT before the registration parser, which exists and works, is ever
-- reached. The agent that found it declined to mislabel a registration
-- document as `maintenance` to force a green path, which was right: that
-- would have put a false provenance on every row it produced.
--
-- `factoring` is added alongside it because collection_event below needs
-- a document to point at, and `loan_schedule` because two amortization
-- schedules are already booked against equipment financing.
--
-- Insurance is deliberately NOT added. No insurance document has been
-- dropped and no parser reads one; an enum value for it would be a claim
-- about coverage we cannot yet substantiate.
-- ---------------------------------------------------------------------

ALTER TYPE accounting.doc_type ADD VALUE IF NOT EXISTS 'registration';
ALTER TYPE accounting.doc_type ADD VALUE IF NOT EXISTS 'factoring';
ALTER TYPE accounting.doc_type ADD VALUE IF NOT EXISTS 'loan_schedule';

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Collection status is a history, not a column (§2, §12)
--
-- An invoice moves: submitted -> funded -> paid, or funded -> recoursed,
-- or straight to denied. The ledger is append-only by design, so this
-- cannot be a mutable field on the revenue entry. It is an event stream,
-- and the current status is the latest event.
--
-- The reference is explicit about the failure this prevents: "Do not add
-- `Funded` and `Paid` together as if both were settled." A dashboard
-- that shows one "revenue" number has already made that mistake.
-- ---------------------------------------------------------------------

CREATE TYPE accounting.collection_status AS ENUM (
  'unsubmitted',  -- booked, never sent to the factor (billed direct is legitimate)
  'submitted',    -- with the factor, no decision yet
  'funded',       -- the factor advanced; the debtor has NOT paid
  'paid',         -- the debtor settled
  'short_paid',   -- settled for less than face
  'denied',       -- credit-denied; the company must collect it itself
  'recoursed',    -- the factor took the advance back
  'rejected'      -- refused or held
);

CREATE TABLE accounting.collection_event (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The revenue this is the collection story of. Not every revenue entry
  -- has one yet, and a non-revenue entry must never have one.
  ledger_entry_id uuid NOT NULL REFERENCES accounting.ledger_entry(entry_id),

  status          accounting.collection_status NOT NULL,
  effective_date  date NOT NULL,

  -- What actually arrived, where it is known. Null is not zero: an
  -- invoice with no settlement figure on file is unmeasured, not free
  -- (§10). `funded` in particular carries an advance, not a settlement.
  settled_amount  numeric(14,2),
  fee_amount      numeric(14,2),   -- factoring fee, as a negative number
  invoice_number  text,
  factor_name     text,

  -- Provenance, same rule as the ledger: a status nobody can trace is a
  -- claim, not a fact.
  source_document_id uuid REFERENCES accounting.source_document(document_id),
  connector_pull_id  uuid REFERENCES accounting.connector_pull(pull_id),

  recorded_by     text NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  note            text,

  -- A fee is money out. Booking it positive silently inflates revenue.
  CONSTRAINT fee_is_an_outflow CHECK (fee_amount IS NULL OR fee_amount <= 0),

  -- "Short paid" means less than face was received, so the amount is the
  -- point of the status and cannot be left blank.
  CONSTRAINT short_paid_states_what_arrived CHECK (
    status <> 'short_paid' OR settled_amount IS NOT NULL
  ),

  -- A settled amount that is negative is a reversal wearing the wrong
  -- status; recourse is the status for that.
  CONSTRAINT settled_is_an_inflow CHECK (
    settled_amount IS NULL OR settled_amount >= 0
  )
);

-- One status per entry per day per stream: re-reading the same factoring
-- report is idempotent rather than a duplicated history.
CREATE UNIQUE INDEX ux_collection_event_once
  ON accounting.collection_event (ledger_entry_id, status, effective_date);

CREATE INDEX ix_collection_event_entry
  ON accounting.collection_event (ledger_entry_id, effective_date DESC);

CREATE INDEX ix_collection_event_status
  ON accounting.collection_event (status, effective_date);

-- The current status of each revenue entry: the latest event, ties broken
-- by recording time. Entries with no event at all are absent from this
-- view rather than defaulted to anything -- an unrecorded collection
-- status is unknown, and §10 forbids rendering unknown as a value.
CREATE VIEW accounting.v_collection_current AS
SELECT DISTINCT ON (ce.ledger_entry_id)
  ce.ledger_entry_id,
  ce.status,
  ce.effective_date,
  ce.settled_amount,
  ce.fee_amount,
  ce.invoice_number,
  ce.factor_name
FROM accounting.collection_event ce
ORDER BY ce.ledger_entry_id, ce.effective_date DESC, ce.recorded_at DESC;

COMMENT ON VIEW accounting.v_collection_current IS
  'Latest collection status per revenue entry. Absence means unknown, '
  'never "paid" and never "zero". Funded and paid are different states '
  'carried by different parties and must never be summed together.';

-- ---------------------------------------------------------------------
-- 2. Cost shape and basis (§4, §7, §12)
--
-- Shape drives break-even: a fixed cost is charged whether the truck
-- moves or not, a per-mile cost scales with miles, a %-of-gross cost
-- scales with revenue. Basis is finer and matters most for insurance,
-- which the reference prices five different ways in the same policy set
-- -- so a single blended "insurance per truck" is wrong for exactly the
-- trucks it matters most for, the idle ones.
--
-- Nullable on purpose: a category whose shape nobody has established is
-- unknown, and inventing 'fixed' as a default would assert a fact we do
-- not have. (The same reasoning that made unit_type default to
-- 'unknown' in migration 002.)
-- ---------------------------------------------------------------------

CREATE TYPE accounting.cost_shape AS ENUM (
  'fixed',                  -- charged whether the truck moves or not
  'variable_per_mile',      -- scales with miles
  'variable_pct_of_gross'   -- scales with revenue
);

CREATE TYPE accounting.cost_basis AS ENUM (
  'per_unit',        -- flat $ per scheduled unit (auto liability, cargo)
  'per_value',       -- % of the unit's insured value (physical damage)
  'per_gross_dollar',-- % of gross revenue (primary cargo, commission, factoring)
  'per_mile',        -- $ per mile, or per 100 miles (secondary cargo layer)
  'per_enrollee',    -- flat $ per enrolled driver per month (occ/acc)
  'per_period'       -- a flat weekly/annual charge with no other driver
);

ALTER TABLE accounting.category
  ADD COLUMN cost_shape accounting.cost_shape,
  ADD COLUMN cost_basis accounting.cost_basis;

-- Revenue has no cost shape, and a cost shape on a revenue category would
-- be read by a break-even calculation as a cost.
ALTER TABLE accounting.category
  ADD CONSTRAINT revenue_has_no_cost_shape CHECK (
    category_group <> 'revenue' OR (cost_shape IS NULL AND cost_basis IS NULL)
  );

-- A %-of-gross cost is measured per gross dollar; a per-mile cost per
-- mile. Letting these disagree makes the pair meaningless.
ALTER TABLE accounting.category
  ADD CONSTRAINT shape_and_basis_agree CHECK (
    cost_shape IS NULL OR cost_basis IS NULL
    OR CASE cost_shape
         WHEN 'variable_pct_of_gross' THEN cost_basis = 'per_gross_dollar'
         WHEN 'variable_per_mile'     THEN cost_basis = 'per_mile'
         ELSE cost_basis <> 'per_gross_dollar' AND cost_basis <> 'per_mile'
       END
  );

COMMENT ON COLUMN accounting.category.cost_shape IS
  'Fixed / per-mile / %-of-gross. Null means nobody has established it. '
  'Conflating the three is the most common source of a wrong break-even.';

-- ---------------------------------------------------------------------
-- 3. Stated and measured rates are two facts (§10)
--
-- "A stated/contractual rate and a measured/actual rate are different
-- facts and both are worth keeping... Neither should silently overwrite
-- the other."
--
-- This is the table the registration engine's $1,879.98-per-unit stated
-- charge and its actual per-unit cost both belong in, and the one a
-- per-driver admin fee gets checked against (§9) instead of being
-- assumed to break even.
-- ---------------------------------------------------------------------

CREATE TYPE accounting.rate_kind AS ENUM ('stated', 'measured');

CREATE TABLE accounting.rate_fact (
  rate_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  rate_key        text NOT NULL,          -- 'registration.per_unit_year', 'admin.per_driver_week'
  kind            accounting.rate_kind NOT NULL,

  -- What the rate applies to. All optional: a rate can be group-wide, or
  -- specific to one entity, one unit, or one arrangement.
  entity_id       uuid REFERENCES accounting.entity(entity_id),
  unit_number     text,
  driver_class    accounting.driver_class,
  category_id     text REFERENCES accounting.category(category_id),

  amount          numeric(14,4) NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'USD',
  basis           accounting.cost_basis NOT NULL,

  effective_from  date NOT NULL,
  effective_to    date,                   -- null = still in force

  -- A stated rate comes from a rate card, contract or invoice; a measured
  -- rate comes from a calculation over real postings. Both name their
  -- origin or neither can be defended.
  source_document_id uuid REFERENCES accounting.source_document(document_id),
  calc_run_id     uuid,
  note            text,
  recorded_by     text NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rate_period_is_ordered CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),

  -- A stated rate is only as good as the document stating it; a measured
  -- rate is only as good as the run that measured it.
  CONSTRAINT rate_names_its_origin CHECK (
    CASE kind
      WHEN 'stated'   THEN source_document_id IS NOT NULL
      WHEN 'measured' THEN calc_run_id IS NOT NULL
    END
  )
);

CREATE INDEX ix_rate_lookup
  ON accounting.rate_fact (rate_key, kind, effective_from DESC);

CREATE INDEX ix_rate_unit
  ON accounting.rate_fact (unit_number, rate_key)
  WHERE unit_number IS NOT NULL;

-- The pair, side by side, with the gap named. This is the query §9 asks
-- for: is the flat fee we charge drivers anywhere near what the services
-- it covers actually cost?
CREATE VIEW accounting.v_rate_gap AS
SELECT
  s.rate_key,
  s.entity_id,
  s.unit_number,
  s.amount              AS stated_amount,
  m.amount              AS measured_amount,
  m.amount - s.amount   AS gap,
  s.basis,
  s.effective_from      AS stated_from,
  m.effective_from      AS measured_from
FROM accounting.rate_fact s
JOIN accounting.rate_fact m
  ON  m.rate_key = s.rate_key
  AND m.kind     = 'measured'
  AND m.entity_id IS NOT DISTINCT FROM s.entity_id
  AND m.unit_number IS NOT DISTINCT FROM s.unit_number
  AND m.basis    = s.basis
WHERE s.kind = 'stated';

COMMENT ON VIEW accounting.v_rate_gap IS
  'Stated rate against measured rate for the same key and scope. A '
  'positive gap means the real cost exceeds what is charged for it. '
  'Neither side overwrites the other; this view only shows the distance.';

-- ---------------------------------------------------------------------
-- 4. The engine list was already out of date
--
-- `calc_run.engine` allows ifta / permit / pnl / forecast. The
-- registration engine has been running for weeks and the P&L summary
-- engine is being built now; neither can record a run, which means
-- neither can post a `derived` ledger entry at all -- the
-- provenance_matches_kind CHECK requires a calc_run_id and there is no
-- legal row to point at. Found while writing the rate assertions below.
-- ---------------------------------------------------------------------

ALTER TABLE accounting.calc_run DROP CONSTRAINT calc_run_engine_check;
ALTER TABLE accounting.calc_run ADD CONSTRAINT calc_run_engine_check
  CHECK (engine IN ('ifta','permit','pnl','forecast','registration','summary'));

COMMIT;
