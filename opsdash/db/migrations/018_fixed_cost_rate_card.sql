-- The fixed cost the operator already tracks, per truck per week.
--
-- Until now the ledger held maintenance, tolls and trailer cost — about 2% of
-- revenue — and the dashboard reported a 97.7% margin, which is not a margin,
-- it is an artifact of an absent cost side. The operator's own "Fixed costs by
-- company" sheet has the rest: truck payments, salaries, insurance, telematics
-- subscriptions, permits and weight-distance taxes, as a rate per truck per
-- week per carrier. That is 46% of weekly revenue before a gallon of fuel.
--
-- A RATE CARD IS NOT A RECEIPT. Every amount derived from it is a modelled
-- cost, and posts with `allocation_basis = 'rate_card'` so no screen and no
-- query can mistake it for a measured one. Actual invoices, when they arrive,
-- post as 'actual' alongside and the two are told apart by that column.

ALTER TYPE accounting.allocation_basis ADD VALUE IF NOT EXISTS 'rate_card';

-- Overhead is a real cost group and the chart had nowhere to put salaries.
ALTER TABLE accounting.category DROP CONSTRAINT IF EXISTS category_category_group_check;
ALTER TABLE accounting.category
  ADD CONSTRAINT category_category_group_check
  CHECK (category_group IN (
    'revenue','fuel','toll','maintenance','permit','ifta',
    'insurance','driver_pay','lease','other_cost','trailer','overhead'));

-- Rates change: insurance renews, a truck payment schedule ends, a subscription
-- is renegotiated. Effective-dating means a past week keeps the rate that was
-- true then, exactly as truck_entity_history does for carriers (migration 015).
CREATE TABLE IF NOT EXISTS accounting.fixed_cost_rate (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL REFERENCES accounting.entity (entity_id),
  category_id           text NOT NULL REFERENCES accounting.category (category_id),

  -- The operator's own label for the line ("Samsara", "Insurance cargo liab").
  -- Kept verbatim: the sheet is the source, and a reviewer looking for a
  -- number should find the words they wrote next to it.
  line_item             text NOT NULL,

  -- Per truck, per week. Four decimal places because several lines are cents
  -- and rounding them at storage would drift over a year of weeks.
  rate_per_truck_week   numeric(14,4) NOT NULL CHECK (rate_per_truck_week >= 0),

  effective_from        date NOT NULL,
  effective_to          date,
  source                text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rate_period_is_ordered
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- One rate per line per carrier per day. Without this a reload that forgot to
-- close the old row would double every affected cost silently.
ALTER TABLE accounting.fixed_cost_rate
  DROP CONSTRAINT IF EXISTS fixed_cost_rate_never_overlaps;
ALTER TABLE accounting.fixed_cost_rate
  ADD CONSTRAINT fixed_cost_rate_never_overlaps
  EXCLUDE USING gist (
    entity_id WITH =,
    line_item WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );

CREATE INDEX IF NOT EXISTS ix_fixed_cost_rate_entity
  ON accounting.fixed_cost_rate (entity_id, effective_from);
