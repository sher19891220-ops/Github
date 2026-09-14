-- =====================================================================
-- Migration 011 — Give the IFTA return somewhere honest to land
--
-- `ifta_liability` was laid down in 001 before the engine existed, and it
-- cannot hold what the engine actually computes. Three gaps, one of them
-- serious:
--
--   No surcharge columns. Indiana, Kentucky and Virginia levy a second
--   per-gallon charge on TAXABLE gallons with no pump credit. The engine
--   keeps it apart from the base tax because netting it is the single
--   most common way a hand-built IFTA return under-reports — on the
--   worked Indiana example, netting turns $550 owed into a $275 credit.
--   Persisting only `net_liability` would collapse that distinction back
--   into one number the moment a return was saved, which is the same
--   error committed one step later.
--
--   No total miles. `taxable_miles` is total less exempt. With only the
--   taxable figure stored, an exemption claimed in error is invisible
--   afterwards — the row reads as if those miles were never driven.
--
--   No fleet MPG. Every gallon figure on every line scales off one
--   number. A saved return that does not record which MPG produced it
--   cannot be re-derived, and a return you cannot re-derive is a number
--   you are trusting rather than checking.
--
-- Also here: `period_quarter` is NOT NULL, and that is deliberately left
-- alone. IFTA files quarterly. The engine will compute a daily or weekly
-- figure — the operator asked for exactly that — but such a figure is an
-- ACCRUAL, not a return, and this table is the returns table. The schema
-- refusing to store an accrual is the constraint doing its job, not a
-- limitation to work around.
-- =====================================================================

BEGIN;

ALTER TABLE accounting.ifta_liability
  ADD COLUMN IF NOT EXISTS total_miles          numeric(14,2),
  ADD COLUMN IF NOT EXISTS surcharge_per_gallon numeric(10,5) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surcharge_due        numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_due              numeric(14,2),
  ADD COLUMN IF NOT EXISTS fleet_mpg            numeric(10,4);

COMMENT ON COLUMN accounting.ifta_liability.total_miles IS
  'Miles run in the jurisdiction before any exemption. taxable_miles is this less exempt miles.';
COMMENT ON COLUMN accounting.ifta_liability.tax_due IS
  'Base tax: (taxable_gallons - tax_paid_gallons) x rate. Negative is a credit.';
COMMENT ON COLUMN accounting.ifta_liability.surcharge_due IS
  'taxable_gallons x surcharge. Never netted against tax-paid gallons and never negative: a surcharge cannot be pre-paid at the pump.';
COMMENT ON COLUMN accounting.ifta_liability.net_liability IS
  'tax_due + surcharge_due. Positive is owed, negative is a net credit.';
COMMENT ON COLUMN accounting.ifta_liability.fleet_mpg IS
  'The fleet-wide MPG this line was computed from. Fleet-wide, never per jurisdiction — that is the mechanism by which a credit in one state offsets tax in another.';

-- The surcharge can never be a credit. This is the engine's rule written
-- where it cannot be bypassed by a future writer that skips the engine.
ALTER TABLE accounting.ifta_liability
  DROP CONSTRAINT IF EXISTS surcharge_is_never_a_credit;
ALTER TABLE accounting.ifta_liability
  ADD CONSTRAINT surcharge_is_never_a_credit CHECK (surcharge_due >= 0);

-- Taxable miles cannot exceed total miles where total is recorded.
ALTER TABLE accounting.ifta_liability
  DROP CONSTRAINT IF EXISTS taxable_miles_within_total;
ALTER TABLE accounting.ifta_liability
  ADD CONSTRAINT taxable_miles_within_total CHECK (
    total_miles IS NULL OR (taxable_miles <= total_miles AND taxable_miles >= 0));

-- ---------------------------------------------------------------------
-- A saved return needs to name which mileage documents fed it, or
-- "traced to a source document" is a claim rather than a link.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounting.ifta_run_source (
  calc_run_id  uuid NOT NULL REFERENCES accounting.calc_run(calc_run_id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES accounting.source_document(document_id),
  role         text NOT NULL CHECK (role IN ('mileage','fuel')),
  PRIMARY KEY (calc_run_id, document_id, role)
);

COMMENT ON TABLE accounting.ifta_run_source IS
  'Which documents a saved IFTA return was computed from. Without this a calc_run records that a number was produced but not from what.';

COMMIT;
