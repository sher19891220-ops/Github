-- =====================================================================
-- Migration 003 — Registration costs and prepaid amortization
--
-- Driven by a real IRP renewal: one fleet-level invoice covering 42
-- units for a registration year, plus a flat federal road-tax charge per
-- unit, part of which lease-to-purchase drivers reimburse.
--
-- Two things had no home in the schema before this:
--   1. Annual costs that must be spread across the months they cover.
--   2. A cost the company pays now and recovers from a driver later.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Categories these costs post to.
--
-- Seeded here rather than left to hand-entry because the posting code
-- references them by id, and a missing category would fail a foreign key
-- at post time rather than at deploy time.
-- ---------------------------------------------------------------------

INSERT INTO accounting.category (category_id, category_group, display_name, sign) VALUES
  ('permit.irp',            'permit', 'IRP apportioned registration', -1),
  ('permit.irp_foreign',    'permit', 'IRP foreign jurisdiction fees', -1),
  ('permit.bmv',            'permit', 'BMV and filing fees',          -1),
  ('tax.hvut',              'permit', 'Heavy vehicle use tax (2290)', -1),
  ('prepaid.registration',  'other_cost', 'Prepaid registration (asset)', -1),
  ('receivable.driver',     'other_cost', 'Receivable from driver',    1)
ON CONFLICT (category_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. Amortization schedule.
--
-- An annual cost posted in full on its payment date makes a truck
-- catastrophically unprofitable for one day and free for the rest of the
-- year, which would make "profitable vs negative trucks" on the CEO
-- dashboard meaningless. The payment posts once as a prepaid balance;
-- this table then drives one expense entry per covered month.
--
-- Rows are generated when the invoice is booked, but each is only
-- POSTED once its month has closed — a future month is a commitment,
-- not an incurred cost, and must not appear in an actual.
-- ---------------------------------------------------------------------

CREATE TABLE accounting.amortization_schedule (
  schedule_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What is being spread, and what paid for it.
  source_document_id uuid NOT NULL REFERENCES accounting.source_document(document_id),
  prepaid_entry_id   uuid NOT NULL REFERENCES accounting.ledger_entry(entry_id),

  entity_id        uuid NOT NULL REFERENCES accounting.entity(entity_id),
  truck_id         uuid REFERENCES accounting.truck(truck_id),
  unit_number      text,
  vin              text,

  category_id      text NOT NULL REFERENCES accounting.category(category_id),

  -- The month this row covers, and its share.
  period_month     date NOT NULL,           -- always the first of the month
  amount           numeric(14,2) NOT NULL,  -- signed, same convention as the ledger

  -- Who ultimately bears it. Driver-borne amounts are a receivable, not a
  -- company cost, and must not reduce company margin.
  charged_to       accounting.charged_to NOT NULL DEFAULT 'company',

  -- Set once the month closes and the expense entry is posted.
  posted_entry_id  uuid REFERENCES accounting.ledger_entry(entry_id),
  posted_at        timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CHECK (period_month = date_trunc('month', period_month)::date),
  -- One row per unit per category per month per source document.
  UNIQUE (source_document_id, category_id, period_month, unit_number)
);

CREATE INDEX ix_amort_due
  ON accounting.amortization_schedule (period_month)
  WHERE posted_entry_id IS NULL;

CREATE INDEX ix_amort_unit
  ON accounting.amortization_schedule (unit_number, period_month);

COMMENT ON TABLE accounting.amortization_schedule IS
  'Spreads an annual cost across the months it covers. The invoice posts '
  'once as prepaid; each month closes by posting its own row. Unposted '
  'future rows are commitments and never appear in actuals.';

-- ---------------------------------------------------------------------
-- 3. Allocation honesty.
--
-- A fleet-level invoice carries no per-unit breakdown, so a per-unit
-- figure is an allocation. Recording the basis makes that visible on the
-- entry itself rather than depending on a memo nobody reads.
-- ---------------------------------------------------------------------

CREATE TYPE accounting.allocation_basis AS ENUM (
  'actual',          -- the source document stated this exact per-unit amount
  'even_split',      -- fleet total / unit count; honest only for a uniform fleet
  'by_weight',
  'by_miles',
  'manual'
);

ALTER TABLE accounting.ledger_entry
  ADD COLUMN allocation_basis accounting.allocation_basis NOT NULL DEFAULT 'actual',
  ADD COLUMN allocation_note  text;

COMMENT ON COLUMN accounting.ledger_entry.allocation_basis IS
  'How a per-unit figure was derived. Anything other than ''actual'' is an '
  'allocation and must be presented as one, never as a measured per-truck cost.';

ALTER TABLE accounting.amortization_schedule
  ADD COLUMN allocation_basis accounting.allocation_basis NOT NULL DEFAULT 'actual';

COMMIT;
