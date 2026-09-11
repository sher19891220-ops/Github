-- =====================================================================
-- Migration 013 — Each company files its own IFTA return
--
-- The operator's clarification, verbatim: "each company filing ifta in
-- the states where it has been established. but they file all states."
--
-- Two separate facts, and the build already had one of them right:
--
--   The LICENSEE is the entity. Zone, Xtrack and AFG each hold their own
--   IFTA licence and each file their own return. `ifta_liability` already
--   requires an entity_id and `saveIftaReturn` already refuses a
--   group-wide figure, so that part stands.
--
--   The BASE JURISDICTION is where that entity is established, and it is
--   the state the return is filed WITH — not a limit on what it covers.
--   A return filed in Ohio still reports every jurisdiction the trucks
--   ran in, and the base jurisdiction collects the whole amount and
--   distributes it. This column records which office each entity files
--   with; it deliberately does NOT filter the return's contents, because
--   filtering it to the base state is the single biggest way to
--   under-report an IFTA return.
--
-- Recorded rather than inferred. It cannot be derived from the ledger —
-- a carrier's base jurisdiction is a licensing fact, not a traffic
-- pattern, and guessing it from where the trucks run most would be wrong
-- for exactly the fleets that run hardest away from home.
-- =====================================================================

BEGIN;

ALTER TABLE accounting.entity
  ADD COLUMN IF NOT EXISTS ifta_base_jurisdiction char(2),
  ADD COLUMN IF NOT EXISTS ifta_licence_number text;

COMMENT ON COLUMN accounting.entity.ifta_base_jurisdiction IS
  'The state this entity is established in and files its IFTA return with. Never a filter on what the return covers: the return reports every jurisdiction the trucks ran in, and the base jurisdiction collects and distributes.';

ALTER TABLE accounting.entity
  DROP CONSTRAINT IF EXISTS ifta_base_is_a_jurisdiction;
ALTER TABLE accounting.entity
  ADD CONSTRAINT ifta_base_is_a_jurisdiction CHECK (
    ifta_base_jurisdiction IS NULL OR ifta_base_jurisdiction ~ '^[A-Z]{2}$');

-- A saved return records the licence it was filed under, so a reprint
-- years later still says who filed it and where.
ALTER TABLE accounting.ifta_liability
  ADD COLUMN IF NOT EXISTS base_jurisdiction char(2);

COMMENT ON COLUMN accounting.ifta_liability.base_jurisdiction IS
  'The entity''s base jurisdiction at the time this return was saved, snapshotted so a later change of licence cannot rewrite a filed return.';

COMMIT;
