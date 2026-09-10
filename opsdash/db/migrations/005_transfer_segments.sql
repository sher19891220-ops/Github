-- =====================================================================
-- Migration 005 — Mid-period transfers
--
-- Trucks move between carriers mid-month. The schedule could not express
-- that: its unique key was (document, category, month, unit), so one unit
-- could hold exactly one carrier per month. A truck transferring on the
-- 15th had no way to give half the month to each.
--
-- Proven before writing this: inserting Zone's half and Xtrack's half of
-- the same February for the same unit failed on
-- amortization_schedule_source_document_id_category_id_period_key.
--
-- A schedule row becomes a SEGMENT: a unit, a carrier, and the span of
-- days that carrier held it. A normal month is one segment covering the
-- whole month; a transfer month is two.
-- =====================================================================

BEGIN;

-- Needed for the exclusion constraint below: it mixes an equality test on
-- unit_number with an overlap test on a date range.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE accounting.amortization_schedule
  DROP CONSTRAINT amortization_schedule_source_document_id_category_id_period_key;

-- The span this row covers. Defaults to the whole month so existing
-- single-segment rows keep their meaning.
ALTER TABLE accounting.amortization_schedule
  ADD COLUMN segment_start date,
  ADD COLUMN segment_end   date,
  ADD COLUMN days          integer;

UPDATE accounting.amortization_schedule
SET segment_start = period_month,
    segment_end   = (period_month + interval '1 month - 1 day')::date,
    days          = EXTRACT(DAY FROM (period_month + interval '1 month - 1 day'))::int
WHERE segment_start IS NULL;

ALTER TABLE accounting.amortization_schedule
  ALTER COLUMN segment_start SET NOT NULL,
  ALTER COLUMN segment_end   SET NOT NULL,
  ALTER COLUMN days          SET NOT NULL;

-- A segment must sit inside the month it claims, and must run forwards.
ALTER TABLE accounting.amortization_schedule
  ADD CONSTRAINT segment_within_its_month CHECK (
    segment_start >= period_month
    AND segment_end <= (period_month + interval '1 month - 1 day')::date
    AND segment_end >= segment_start
  );

-- `days` must match the span it claims, or a per-day allocation silently
-- stops reconciling.
ALTER TABLE accounting.amortization_schedule
  ADD CONSTRAINT days_matches_segment CHECK (
    days = (segment_end - segment_start) + 1
  );

-- One carrier per unit per day. Two carriers cannot both be charged for
-- the same truck on the same date, which is the failure mode a
-- mid-month transfer invites: an off-by-one at the boundary that
-- double-charges the changeover day and nobody notices, because both
-- halves look reasonable on their own.
ALTER TABLE accounting.amortization_schedule
  ADD CONSTRAINT one_carrier_per_unit_per_day
  EXCLUDE USING gist (
    unit_number WITH =,
    category_id WITH =,
    source_document_id WITH =,
    daterange(segment_start, segment_end, '[]') WITH &&
  );

CREATE INDEX ix_amort_segment
  ON accounting.amortization_schedule (unit_number, segment_start);

COMMENT ON COLUMN accounting.amortization_schedule.days IS
  'Days this carrier held the unit within period_month. A whole month is '
  'one segment; a transfer splits it. Amount is days x the daily rate, so '
  'the segments of a month always sum back to the month.';

COMMENT ON CONSTRAINT one_carrier_per_unit_per_day
  ON accounting.amortization_schedule IS
  'Prevents two carriers being charged for the same truck on the same day. '
  'The boundary day of a transfer is the easy thing to get wrong and the '
  'hard thing to notice.';

COMMIT;
