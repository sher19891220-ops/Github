-- The analysis pipeline becomes a source of rates, and a rate says whether
-- it is a CHARGE or a COST.
--
-- Two changes, both small, both needed before `load-facts.ts` can write a
-- single row.
--
-- 1. `calc_run.engine` allowed four values, all of them engines inside this
--    application. The fleet-financial-pipeline is a fifth: it reads the
--    invoices, policies, statements and returns this system never sees, and
--    publishes measured rates with the fingerprint of the documents behind
--    them. A measured `rate_fact` must name the run that measured it, so
--    without this the pipeline's findings cannot be recorded at all.
--
-- 2. `rate_fact.rate_key` gets a stated convention rather than a free text
--    field, because the distinction it has to carry is the one that decides
--    whether this company makes money.
--
--    What we CHARGE a lease or owner-operator driver for insurance is not
--    what that insurance COSTS us. The operator was explicit: the
--    arrangement figures on the driver sheet are the charge side, and the
--    real costs are different. Netting them, or filing them under one name,
--    hides the only number that matters in a lease-to-own business — the
--    spread. A charge that is below its cost is a truck that loses money
--    every week it runs, and it would look identical to a profitable one.
--
--    So every rate_key begins `charge.` or `cost.`, and the check below
--    makes that a rule rather than a habit.
BEGIN;

-- The full set, not just the new one. Migration 007 had already widened
-- this beyond 001's four to include 'registration' and 'summary', and a
-- DROP-then-ADD that lists only what this migration cares about silently
-- removes them. Caught by the contract assertions rather than in review:
-- they insert a 'registration' run and it started failing.
ALTER TABLE accounting.calc_run DROP CONSTRAINT IF EXISTS calc_run_engine_check;
ALTER TABLE accounting.calc_run
  ADD CONSTRAINT calc_run_engine_check
  CHECK (engine IN ('ifta','permit','pnl','forecast','registration','summary','pipeline'));

ALTER TABLE accounting.rate_fact DROP CONSTRAINT IF EXISTS rate_key_says_charge_or_cost;
ALTER TABLE accounting.rate_fact
  ADD CONSTRAINT rate_key_says_charge_or_cost
  CHECK (rate_key LIKE 'charge.%' OR rate_key LIKE 'cost.%');

COMMENT ON COLUMN accounting.rate_fact.rate_key IS
  'Begins charge. or cost. — what we bill versus what we bear. The spread '
  'between a matched pair is the margin on a lease arrangement, and it is '
  'invisible the moment the two are filed under one name.';

COMMENT ON TABLE accounting.rate_fact IS
  'Rates, stated or measured, from a rate card, a contract, an invoice or a '
  'calculation over real postings. Written by load-facts.ts from the '
  'analysis pipeline and by the operator''s own arrangement sheets. Not a '
  'ledger: nothing here is money that moved, only the rate at which money '
  'is expected to move.';

COMMIT;
