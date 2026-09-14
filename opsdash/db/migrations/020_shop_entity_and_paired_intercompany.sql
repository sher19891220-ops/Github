-- The shop is an entity, and an intercompany transaction has two legs.
--
-- Two gaps, and the second is the one that costs money.
--
-- 1. WHAT AN ENTITY IS. `entity` held a code and a legal name and nothing
--    else, so a shop, an asset holder and a trucking company were the same
--    kind of thing. They are not. A fixed cost per truck per week is a
--    carrier's fact; charging it to a repair shop would be nonsense. And
--    TruckMax was not in the table at all — the group is three carriers, an
--    asset holder and a shop, and this system knew about four of the five.
--
-- 2. A SHOP INVOICE IS TWO FACTS, NOT ONE. When TruckMax repairs an XTRACK
--    truck, the group has not spent what TruckMax charged; it has spent
--    what the parts and labour cost. The charge is a cost to the carrier AND
--    revenue to the shop, and those cancel on consolidation, leaving the
--    real cost behind.
--
--    Posting only the carrier's side — which is what happens today — is
--    wrong three times over: the shop's margin is invisible, so nobody can
--    say whether running a shop beats sending trucks out; the group's cost
--    is overstated by the shop's markup; and TruckMax has no P&L at all.
--
--    A ledger cannot enforce "the other leg exists" with a row constraint,
--    because it is a fact about two rows. So the legs carry a shared
--    `intercompany_pair_id`, and a view reports every pair that does not
--    balance. What cannot be a constraint becomes something that can be
--    looked at and asserted.
BEGIN;

-- ---------------------------------------------------------------------
-- 1. What kind of company this is
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE accounting.entity_kind AS ENUM ('carrier', 'shop', 'asset_holder');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE accounting.entity
  ADD COLUMN IF NOT EXISTS kind accounting.entity_kind NOT NULL DEFAULT 'carrier';

COMMENT ON COLUMN accounting.entity.kind IS
  'carrier / shop / asset_holder. Decides what applies: a per-truck-week '
  'fixed cost and an IFTA return belong to a carrier, not to a shop, and an '
  'asset holder owns trucks it never operates.';

UPDATE accounting.entity SET kind = 'asset_holder' WHERE code = 'IRONLEASE';
UPDATE accounting.entity SET kind = 'shop'         WHERE code = 'TRUCKMAX';

-- ---------------------------------------------------------------------
-- 2. Both legs of an intercompany transaction
-- ---------------------------------------------------------------------
ALTER TABLE accounting.ledger_entry
  ADD COLUMN IF NOT EXISTS intercompany_pair_id uuid;

CREATE INDEX IF NOT EXISTS ix_ledger_intercompany_pair
  ON accounting.ledger_entry (intercompany_pair_id)
  WHERE intercompany_pair_id IS NOT NULL;

COMMENT ON COLUMN accounting.ledger_entry.intercompany_pair_id IS
  'Shared by the two legs of one intercompany transaction. Whether the '
  'other leg exists is a fact about two rows, so it cannot be a CHECK; '
  'v_intercompany_unbalanced is where it is checkable instead.';

-- A company cannot trade with itself. This one IS a single-row fact, so it
-- is a constraint rather than a report.
ALTER TABLE accounting.ledger_entry
  DROP CONSTRAINT IF EXISTS counterparty_is_another_entity;
ALTER TABLE accounting.ledger_entry
  ADD CONSTRAINT counterparty_is_another_entity
  CHECK (counterparty_entity_id IS NULL OR counterparty_entity_id <> entity_id);

-- ---------------------------------------------------------------------
-- 3. Where a missing leg shows up
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW accounting.v_intercompany_unbalanced AS
SELECT
  intercompany_pair_id,
  count(*)                          AS legs,
  sum(amount)                       AS net,
  min(accrual_date)                 AS first_date,
  array_agg(DISTINCT entity_id)     AS entities,
  CASE
    WHEN count(*) < 2  THEN 'only one leg posted — the other company has no record of this'
    WHEN count(*) > 2  THEN 'more than two legs share this pair id'
    WHEN sum(amount) <> 0 THEN 'two legs that do not cancel — one side is the wrong amount'
  END                               AS problem
FROM accounting.ledger_entry
WHERE intercompany_pair_id IS NOT NULL
GROUP BY intercompany_pair_id
HAVING count(*) <> 2 OR sum(amount) <> 0;

COMMENT ON VIEW accounting.v_intercompany_unbalanced IS
  'Intercompany transactions missing a leg or failing to cancel. Empty is '
  'the only acceptable state: a one-legged transaction overstates the '
  'group''s cost by the other company''s markup and leaves that company '
  'with no revenue for work it really did.';

-- ---------------------------------------------------------------------
-- 4. What the shop earns
-- ---------------------------------------------------------------------
INSERT INTO accounting.category (category_id, category_group, display_name, sign) VALUES
  ('revenue.shop_work', 'revenue', 'Shop work billed to a group company', 1)
ON CONFLICT (category_id) DO NOTHING;

COMMIT;
