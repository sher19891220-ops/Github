-- =====================================================================
-- Migration 004 — Intercompany: who paid vs. who bears the cost
--
-- The IRP invoice is billed to one carrier but 24 of its 42 units are
-- operated by the other two. The operator's decision is that the cost
-- follows the truck, with the payer holding a receivable.
--
-- Until now the ledger had one entity per row and could not express
-- that. An earlier note claimed otherwise; this migration makes the
-- claim true.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Separate the payer from the bearer.
--
-- `entity_id` keeps its meaning: the entity whose P&L carries this cost.
-- `paid_by_entity_id` records who actually sent the money. For the
-- ordinary case they are the same, which is why the column defaults to
-- NULL and is read as "same as entity_id".
-- ---------------------------------------------------------------------

ALTER TABLE accounting.ledger_entry
  ADD COLUMN paid_by_entity_id      uuid REFERENCES accounting.entity(entity_id),
  ADD COLUMN counterparty_entity_id uuid REFERENCES accounting.entity(entity_id);

COMMENT ON COLUMN accounting.ledger_entry.paid_by_entity_id IS
  'The entity that actually paid. NULL means the same as entity_id. When it '
  'differs, this cost was funded by another group company and a matching '
  'intercompany entry must exist.';

COMMENT ON COLUMN accounting.ledger_entry.counterparty_entity_id IS
  'The other side of an intercompany balance. Set on receivable/payable '
  'entries so the two halves can be matched and eliminated on consolidation.';

-- An intercompany balance that names no counterparty cannot be matched,
-- reconciled, or eliminated — so it is not allowed to exist.
ALTER TABLE accounting.ledger_entry
  ADD CONSTRAINT intercompany_names_counterparty CHECK (
    category_id NOT IN ('receivable.intercompany', 'payable.intercompany')
    OR counterparty_entity_id IS NOT NULL
  );

-- A counterparty must be a different entity; a company cannot owe itself.
ALTER TABLE accounting.ledger_entry
  ADD CONSTRAINT counterparty_is_another_entity CHECK (
    counterparty_entity_id IS NULL OR counterparty_entity_id <> entity_id
  );

CREATE INDEX ix_ledger_paid_by ON accounting.ledger_entry (paid_by_entity_id)
  WHERE paid_by_entity_id IS NOT NULL;

CREATE INDEX ix_ledger_counterparty
  ON accounting.ledger_entry (counterparty_entity_id, accrual_date)
  WHERE counterparty_entity_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Intercompany categories.
--
-- Sign convention follows the ledger: a receivable is an inflow to the
-- entity holding it, a payable an outflow for the entity owing it.
-- ---------------------------------------------------------------------

INSERT INTO accounting.category (category_id, category_group, display_name, sign) VALUES
  ('receivable.intercompany', 'other_cost', 'Intercompany receivable',  1),
  ('payable.intercompany',    'other_cost', 'Intercompany payable',    -1)
ON CONFLICT (category_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. The same distinction on the amortization schedule, so a recharge
--    spread across twelve months keeps both sides for every month.
-- ---------------------------------------------------------------------

ALTER TABLE accounting.amortization_schedule
  ADD COLUMN paid_by_entity_id uuid REFERENCES accounting.entity(entity_id);

-- ---------------------------------------------------------------------
-- 4. Group view.
--
-- Per-entity P&L uses entity_id and is unaffected. A GROUP roll-up must
-- drop the intercompany legs, or the same dollar is counted twice — once
-- as one company's cost and again as another's receivable.
-- ---------------------------------------------------------------------

CREATE VIEW accounting.v_ledger_consolidated AS
SELECT *
FROM accounting.ledger_entry
WHERE category_id NOT IN ('receivable.intercompany', 'payable.intercompany');

COMMENT ON VIEW accounting.v_ledger_consolidated IS
  'Ledger with intercompany legs removed. Use for the group roll-up; use '
  'the base table for a single entity. Mixing them double-counts.';

COMMIT;
