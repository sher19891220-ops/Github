-- Trucks move between the carriers mid-year, and trucks leave — returned to
-- the vendor, or an owner-operator who quits.
--
-- `truck_entity_history` has existed since migration 001 for exactly this, and
-- nothing was ever written to it: the truck→carrier map lived in
-- `source_key_map` under the `truck_roster` source system instead. That table's
-- primary key (source_system, source_key, canonical_kind) permits exactly one
-- entity per unit for all time. It is the right shape for an identity
-- crosswalk — "this string names that thing" does not change — and the wrong
-- shape for a fact that does. The operator's own dispatch roster lists four
-- units under two companies with two different drivers, and every unit missing
-- from that roster turns out to have stopped earning before the sheet ends.
--
-- So this wires up the table that was always meant to hold it, and adds the
-- three things it needs to be the resolver's source of truth.

-- 1. The guarantee that makes a date lookup a function rather than a race with
--    the query planner: at most one carrier per truck per day. The existing
--    primary key (truck_id, effective_from) only stops two periods STARTING on
--    the same day — it happily accepts 01-01..06-01 alongside 03-01..09-01.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE accounting.truck_entity_history
  DROP CONSTRAINT IF EXISTS truck_entity_history_never_overlaps;
ALTER TABLE accounting.truck_entity_history
  ADD CONSTRAINT truck_entity_history_never_overlaps
  EXCLUDE USING gist (
    truck_id WITH =,
    -- '[]' is inclusive at both ends, so a period ending 2026-03-29 and one
    -- starting 2026-03-30 do not overlap, while two claiming the same day do.
    daterange(effective_from, effective_to, '[]') WITH &&
  );

-- 2. A single-day assignment is legal. The original CHECK required
--    effective_to > effective_from, which forbids it; real units in the
--    operator's data ran for one week and left, and one day is the same case.
ALTER TABLE accounting.truck_entity_history
  DROP CONSTRAINT IF EXISTS truck_entity_history_check;
ALTER TABLE accounting.truck_entity_history
  DROP CONSTRAINT IF EXISTS assignment_period_is_ordered;
ALTER TABLE accounting.truck_entity_history
  ADD CONSTRAINT assignment_period_is_ordered
  CHECK (effective_to IS NULL OR effective_to >= effective_from);

-- 3. What evidence decided this, in the operator's own vocabulary, so a
--    reviewer can judge an attribution without re-deriving it. Most of these
--    rows are inferred from a dispatch roster whose column is literally named
--    `entity_CONFIRM_THIS`; a row that cannot say why it exists cannot be
--    confirmed or refuted.
ALTER TABLE accounting.truck_entity_history
  ADD COLUMN IF NOT EXISTS basis text;
ALTER TABLE accounting.truck_entity_history
  ADD COLUMN IF NOT EXISTS confidence text NOT NULL DEFAULT 'inferred';
ALTER TABLE accounting.truck_entity_history
  DROP CONSTRAINT IF EXISTS truck_entity_history_confidence_check;
ALTER TABLE accounting.truck_entity_history
  ADD CONSTRAINT truck_entity_history_confidence_check
  CHECK (confidence IN ('confirmed', 'inferred'));

CREATE INDEX IF NOT EXISTS ix_truck_entity_history_truck
  ON accounting.truck_entity_history (truck_id, effective_from);

-- The parallel table an earlier revision of this migration created. It
-- duplicated `truck_entity_history` keyed on unit_number instead of truck_id,
-- which skips the identity resolution the data contract requires.
DROP TABLE IF EXISTS accounting.truck_entity_assignment;
