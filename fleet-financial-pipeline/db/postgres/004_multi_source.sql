-- Multi-source reconciliation: Google Sheets, QuickBooks, bank/card, QuickManage.
--
-- DESIGN NOTE — why this is not a fourth pairwise reconciler.
-- Two sources is one pair. Four sources is six pairs, and six pairwise scripts
-- that disagree with each other is worse than no reconciliation at all. Instead
-- every source normalizes into ONE observation table with a `source` column, and
-- a single N-way variance view compares them. Adding a fifth source is then a
-- loader, not another reconciler.
--
-- Depends on 001_finance_schema.sql. Apply after it.

BEGIN;

-- ---------------------------------------------------------------------------
-- Source category mapping
-- A hand-built Google Sheets P&L uses whatever category names someone typed.
-- QuickBooks uses GL account names. Neither matches our taxonomy. Map once,
-- explicitly, and report what is unmapped rather than silently dropping it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.source_category_map (
    source          text NOT NULL,          -- 'gsheets' | 'quickbooks' | 'quickmanage'
    source_category text NOT NULL,          -- as literally written in that source
    category        text NOT NULL,          -- our taxonomy
    mapped_by       text CHECK (mapped_by IN ('manual','auto_exact','auto_normalized')),
    mapped_date     date NOT NULL DEFAULT current_date,
    PRIMARY KEY (source, source_category)
);

-- ---------------------------------------------------------------------------
-- P&L observations — one normalized row per (source, entity, month, category)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.pnl_observations (
    obs_id          bigserial PRIMARY KEY,
    source          text NOT NULL CHECK (source IN ('gsheets','quickbooks','bank','quickmanage')),
    source_detail   text,                   -- spreadsheet id + tab, QB realm, etc.
    entity_id       text NOT NULL REFERENCES finance.entities(entity_id),
    month           date NOT NULL,          -- first of month
    category        text NOT NULL,
    amount          numeric(14,2) NOT NULL, -- cash-flow signed: negative = money out
    -- Stated vs derived matters when they disagree. A hand-keyed Sheets figure is
    -- someone's assertion; a bank-derived figure is computed from cash movement.
    -- When they conflict, which one is an assertion is the first thing to know.
    is_stated       boolean NOT NULL DEFAULT true,
    raw_category    text,                   -- pre-mapping label, for tracing back
    loaded_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, source_detail, entity_id, month, category)
);

CREATE INDEX IF NOT EXISTS idx_pnl_obs_key ON finance.pnl_observations(entity_id, month, category);
CREATE INDEX IF NOT EXISTS idx_pnl_obs_source ON finance.pnl_observations(source);

COMMENT ON TABLE finance.pnl_observations IS
  'Every P&L source normalized to one shape. The Google Sheets P&L is an '
  'observation to be tested, not a source of truth -- it is hand-maintained, '
  'which is exactly where the errors being hunted tend to live.';

-- ---------------------------------------------------------------------------
-- Odometer readings — Google Sheets (manual), QuickManage, Samsara
-- Cost-per-mile is linear in mileage: a 10% mileage error moves cost-per-mile
-- 10%, which is larger than most effects this pipeline is looking for. Mileage
-- has to be reconciled before any per-mile number is trusted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.odometer_readings (
    reading_id      bigserial PRIMARY KEY,
    source          text NOT NULL CHECK (source IN ('gsheets','quickmanage','samsara')),
    unit_number     text NOT NULL,
    reading_date    date NOT NULL,
    odometer        numeric(12,1) NOT NULL,
    source_detail   text,
    loaded_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, unit_number, reading_date)
);

CREATE INDEX IF NOT EXISTS idx_odo_unit ON finance.odometer_readings(unit_number, reading_date);

-- Consecutive readings per source, with the delta between them and a verdict
-- on whether that delta can be true.
CREATE OR REPLACE VIEW finance.v_odometer_deltas AS
WITH base AS (
    SELECT source, unit_number, reading_date, odometer,
           LAG(odometer)     OVER w AS prev_odometer,
           LAG(reading_date) OVER w AS prev_date,
           (odometer - LAG(odometer) OVER w)::numeric(12,1) AS delta_miles,
           (reading_date - LAG(reading_date) OVER w)        AS delta_days
    FROM finance.odometer_readings
    WINDOW w AS (PARTITION BY source, unit_number ORDER BY reading_date)
),
judged AS (
    SELECT *,
           CASE
             WHEN prev_odometer IS NULL                              THEN NULL
             WHEN delta_miles < 0 AND ABS(delta_miles) > 100000      THEN 'ecu_or_dash_swap'
             WHEN delta_miles < 0                                    THEN 'rollback_or_typo'
             WHEN delta_days > 0 AND delta_miles / delta_days > 1200 THEN 'implausible_rate'
             WHEN delta_days > 45                                    THEN 'reading_gap'
             WHEN delta_miles = 0 AND delta_days > 7                 THEN 'stalled_reading'
           END AS anomaly
    FROM base
)
SELECT j.*,
       -- A bad READING corrupts two deltas: the one into it and the one out of
       -- it. A transposed digit shows as a negative delta, then the correction
       -- back to reality shows as a large positive one -- which can sit under any
       -- plausibility ceiling and pass silently. Excluding only the negative
       -- leaves the inflated half in, overstating mileage and understating
       -- cost per mile on exactly the unit whose data is known bad.
       LAG(anomaly) OVER (PARTITION BY source, unit_number ORDER BY reading_date)
           AS prev_anomaly,
       -- COALESCE is load-bearing: LAG is NULL on the first reading per unit,
       -- NULL IN (...) is NULL, and `false OR NULL` is NULL -- which would make
       -- `NOT is_tainted` filter out every row and silently zero all mileage.
       ((anomaly IS NOT NULL)
        OR COALESCE(
             LAG(anomaly) OVER (PARTITION BY source, unit_number ORDER BY reading_date)
               IN ('rollback_or_typo','ecu_or_dash_swap','implausible_rate'),
             false)) AS is_tainted
FROM judged j;

-- Readings that cannot be true. Each failure mode has a different remedy, so
-- they are named rather than lumped into one "bad data" bucket.
CREATE OR REPLACE VIEW finance.v_odometer_anomalies AS
SELECT source, unit_number, reading_date, odometer, prev_odometer, prev_date,
       delta_miles, delta_days, anomaly
FROM finance.v_odometer_deltas
WHERE anomaly IS NOT NULL;

COMMENT ON VIEW finance.v_odometer_anomalies IS
  'rollback_or_typo is usually a transposed digit in manual Sheets entry and is '
  'correctable. ecu_or_dash_swap is real hardware history: clamp the delta, do '
  'not treat it as negative mileage. implausible_rate at >1200 mi/day exceeds '
  'what a legal HOS day allows even for a team.';

-- Monthly miles per unit per source. Tainted deltas are excluded and counted,
-- never silently averaged in.
CREATE OR REPLACE VIEW finance.v_unit_miles_by_source AS
SELECT source,
       unit_number,
       DATE_TRUNC('month', reading_date)::date AS month,
       SUM(delta_miles) FILTER (WHERE NOT is_tainted)::numeric(12,1) AS miles,
       COUNT(*) FILTER (WHERE is_tainted)      AS excluded_readings,
       COUNT(*)                                AS total_readings
FROM finance.v_odometer_deltas
WHERE prev_odometer IS NOT NULL
GROUP BY 1, 2, 3;

-- Mileage disagreement between sources, per unit-month.
CREATE OR REPLACE VIEW finance.v_mileage_variance AS
WITH pivoted AS (
    SELECT unit_number, month,
           MAX(miles) FILTER (WHERE source = 'gsheets')     AS gsheets_miles,
           MAX(miles) FILTER (WHERE source = 'quickmanage') AS quickmanage_miles,
           MAX(miles) FILTER (WHERE source = 'samsara')     AS samsara_miles
    FROM finance.v_unit_miles_by_source
    GROUP BY 1, 2
)
SELECT p.*,
       GREATEST(COALESCE(gsheets_miles,0), COALESCE(quickmanage_miles,0), COALESCE(samsara_miles,0))
       - LEAST(
           COALESCE(gsheets_miles,     'Infinity'::numeric),
           COALESCE(quickmanage_miles, 'Infinity'::numeric),
           COALESCE(samsara_miles,     'Infinity'::numeric)
         ) AS spread_miles,
       (SELECT COUNT(*) FROM (VALUES (gsheets_miles),(quickmanage_miles),(samsara_miles)) v(x)
        WHERE v.x IS NOT NULL) AS sources_present,
       -- Samsara is telematics-read and preferred; QuickManage next; Sheets is
       -- hand-keyed and used only when nothing else covers the month.
       COALESCE(samsara_miles, quickmanage_miles, gsheets_miles) AS preferred_miles,
       CASE WHEN samsara_miles IS NOT NULL THEN 'samsara'
            WHEN quickmanage_miles IS NOT NULL THEN 'quickmanage'
            WHEN gsheets_miles IS NOT NULL THEN 'gsheets' END AS preferred_source
FROM pivoted p;

-- ---------------------------------------------------------------------------
-- N-way P&L variance — the "match all of them" view
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW finance.v_pnl_source_variance AS
WITH pivoted AS (
    SELECT entity_id, month, category,
           MAX(amount) FILTER (WHERE source = 'gsheets')    AS gsheets,
           MAX(amount) FILTER (WHERE source = 'quickbooks') AS quickbooks,
           MAX(amount) FILTER (WHERE source = 'bank')       AS bank,
           COUNT(DISTINCT source)                           AS sources_present
    FROM finance.pnl_observations
    GROUP BY 1, 2, 3
),
scored AS (
    SELECT p.*,
           GREATEST(COALESCE(gsheets,'-Infinity'::numeric), COALESCE(quickbooks,'-Infinity'::numeric),
                    COALESCE(bank,'-Infinity'::numeric))
           - LEAST(COALESCE(gsheets,'Infinity'::numeric), COALESCE(quickbooks,'Infinity'::numeric),
                   COALESCE(bank,'Infinity'::numeric)) AS spread,
           GREATEST(ABS(COALESCE(gsheets,0)), ABS(COALESCE(quickbooks,0)), ABS(COALESCE(bank,0))) AS magnitude
    FROM pivoted p
)
SELECT entity_id, month, category, gsheets, quickbooks, bank, sources_present,
       ROUND(spread, 2) AS spread,
       CASE WHEN magnitude > 0 THEN ROUND(100 * spread / magnitude, 1) END AS spread_pct,
       CASE
         WHEN sources_present < 2 THEN 'single_source'
         -- $50 or 1% of the larger figure, whichever is bigger: a P&L line in the
         -- tens of thousands does not need to agree to the cent across a
         -- hand-built sheet, a GL, and a bank feed.
         WHEN spread <= GREATEST(50, magnitude * 0.01) THEN 'agree'
         WHEN sources_present = 3 THEN 'three_way_disagreement'
         ELSE 'disagreement'
       END AS status,
       -- Which source is the outlier, when two agree and one does not.
       CASE
         WHEN sources_present = 3 AND ABS(COALESCE(quickbooks,0) - COALESCE(bank,0)) <= GREATEST(50, magnitude*0.01)
              AND spread > GREATEST(50, magnitude*0.01) THEN 'gsheets'
         WHEN sources_present = 3 AND ABS(COALESCE(gsheets,0) - COALESCE(bank,0)) <= GREATEST(50, magnitude*0.01)
              AND spread > GREATEST(50, magnitude*0.01) THEN 'quickbooks'
         WHEN sources_present = 3 AND ABS(COALESCE(gsheets,0) - COALESCE(quickbooks,0)) <= GREATEST(50, magnitude*0.01)
              AND spread > GREATEST(50, magnitude*0.01) THEN 'bank'
       END AS outlier_source
FROM scored;

COMMENT ON VIEW finance.v_pnl_source_variance IS
  'N-way P&L comparison across Google Sheets, QuickBooks and bank-derived. '
  'outlier_source names the odd one out when the other two agree -- that is the '
  'single most actionable column here.';

COMMIT;
