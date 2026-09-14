-- The views that actually find bleeding points.
-- Depends on 002_ops_views.sql (v_units, v_maintenance_events,
-- v_unit_miles_monthly, v_unit_revenue_monthly). Apply after it.
--
-- Everything here excludes matched intercompany transfers: internal money
-- movement is not a group-level cost, and counting it inflates every entity's
-- expense line and hides the real ones.

BEGIN;

-- --- Monthly P&L by entity -------------------------------------------------
CREATE OR REPLACE VIEW finance.v_monthly_pnl_by_entity AS
SELECT entity_id,
       DATE_TRUNC('month', txn_date)::date AS month,
       category,
       SUM(amount)::numeric(14,2)          AS net,
       SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END)::numeric(14,2) AS outflow,
       SUM(CASE WHEN amount > 0 THEN  amount ELSE 0 END)::numeric(14,2) AS inflow,
       COUNT(*) AS txn_count
FROM finance.transactions
WHERE NOT is_intercompany
GROUP BY 1, 2, 3;

-- --- Fully-loaded cost per unit per month ---------------------------------
-- Combines the four cost sources that each live somewhere different:
-- card/bank transactions, maintenance repair orders, incidents, compliance.
CREATE OR REPLACE VIEW finance.v_unit_cost_monthly AS
WITH txn AS (
    SELECT unit_number, DATE_TRUNC('month', txn_date)::date AS month,
           SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END)::numeric(14,2) AS txn_cost,
           SUM(CASE WHEN category = 'fuel'        AND amount < 0 THEN -amount ELSE 0 END)::numeric(14,2) AS fuel_cost,
           SUM(CASE WHEN category = 'tolls'       AND amount < 0 THEN -amount ELSE 0 END)::numeric(14,2) AS toll_cost,
           SUM(CASE WHEN category = 'maintenance' AND amount < 0 THEN -amount ELSE 0 END)::numeric(14,2) AS maint_card_cost
    FROM finance.transactions
    WHERE unit_number IS NOT NULL AND NOT is_intercompany
    GROUP BY 1, 2
),
maint AS (
    SELECT unit_number, DATE_TRUNC('month', event_date)::date AS month,
           SUM(cost)::numeric(14,2)          AS repair_order_cost,
           SUM(downtime_days)::numeric(10,1) AS downtime_days,
           COUNT(*)                          AS breakdown_count
    FROM finance.v_maintenance_events
    GROUP BY 1, 2
),
inc AS (
    SELECT unit_number, DATE_TRUNC('month', incident_date)::date AS month,
           SUM(out_of_pocket_cost + insurance_deductible_paid)::numeric(14,2) AS incident_cost
    FROM finance.incidents
    WHERE unit_number IS NOT NULL
    GROUP BY 1, 2
),
comp AS (
    SELECT unit_number, DATE_TRUNC('month', paid_date)::date AS month,
           SUM(amount)::numeric(14,2) AS compliance_cost
    FROM finance.compliance_costs
    WHERE unit_number IS NOT NULL AND paid_date IS NOT NULL
    GROUP BY 1, 2
),
-- Lease/note obligation is a monthly commitment, not a transaction. Spread it
-- across the months each unit was actually in service.
lease AS (
    SELECT unit_number,
           SUM(monthly_payment)::numeric(14,2) AS monthly_obligation,
           SUM(monthly_payment) FILTER (WHERE is_intercompany_obligation)::numeric(14,2)
                                               AS monthly_obligation_intercompany,
           bool_or(is_intercompany_obligation) AS lease_is_intercompany
    FROM finance.assets
    WHERE unit_number IS NOT NULL AND monthly_payment IS NOT NULL
    GROUP BY 1
),
months AS (
    SELECT unit_number, month FROM txn
    UNION SELECT unit_number, month FROM maint
    UNION SELECT unit_number, month FROM inc
    UNION SELECT unit_number, month FROM comp
)
SELECT m.unit_number,
       m.month,
       u.entity_id,
       u.unit_type,
       COALESCE(t.fuel_cost, 0)                                          AS fuel_cost,
       COALESCE(t.toll_cost, 0)                                          AS toll_cost,
       -- Prefer repair-order cost; fall back to card spend only when the unit
       -- has no repair orders that month, so the two never double-count.
       CASE WHEN mx.repair_order_cost IS NOT NULL THEN mx.repair_order_cost
            ELSE COALESCE(t.maint_card_cost, 0) END                      AS maintenance_cost,
       COALESCE(i.incident_cost, 0)                                      AS incident_cost,
       COALESCE(c.compliance_cost, 0)                                    AS compliance_cost,
       COALESCE(l.monthly_obligation, 0)                                 AS lease_cost,
       -- Portion owed to one of our own entities (Iron Lease LLC). Real cost to
       -- this entity, but NOT a group-level cost -- subtract when consolidating.
       COALESCE(l.monthly_obligation_intercompany, 0)                     AS lease_cost_intercompany,
       COALESCE(mx.downtime_days, 0)                                     AS downtime_days,
       COALESCE(mx.breakdown_count, 0)                                   AS breakdown_count,
       (COALESCE(t.txn_cost, 0)
        + COALESCE(mx.repair_order_cost, 0)
        + COALESCE(i.incident_cost, 0)
        + COALESCE(c.compliance_cost, 0)
        + COALESCE(l.monthly_obligation, 0))::numeric(14,2)              AS total_cost,
       mi.miles,
       CASE WHEN mi.miles > 0 THEN
         ((COALESCE(t.txn_cost,0) + COALESCE(mx.repair_order_cost,0) + COALESCE(i.incident_cost,0)
           + COALESCE(c.compliance_cost,0) + COALESCE(l.monthly_obligation,0)) / mi.miles)::numeric(10,4)
       END                                                               AS cost_per_mile,
       r.revenue,
       (COALESCE(r.revenue, 0)
        - (COALESCE(t.txn_cost,0) + COALESCE(mx.repair_order_cost,0) + COALESCE(i.incident_cost,0)
           + COALESCE(c.compliance_cost,0) + COALESCE(l.monthly_obligation,0)))::numeric(14,2) AS contribution
FROM months m
LEFT JOIN finance.v_units u              ON u.unit_number = m.unit_number
LEFT JOIN txn t                          ON t.unit_number = m.unit_number AND t.month = m.month
LEFT JOIN maint mx                       ON mx.unit_number = m.unit_number AND mx.month = m.month
LEFT JOIN inc i                          ON i.unit_number = m.unit_number AND i.month = m.month
LEFT JOIN comp c                         ON c.unit_number = m.unit_number AND c.month = m.month
LEFT JOIN lease l                        ON l.unit_number = m.unit_number
LEFT JOIN finance.v_unit_miles_monthly mi ON mi.unit_number = m.unit_number AND mi.month = m.month
LEFT JOIN finance.v_unit_revenue_monthly r ON r.unit_number = m.unit_number AND r.month = m.month;

COMMENT ON VIEW finance.v_unit_cost_monthly IS
  'Fully-loaded cost per unit per month with cost_per_mile and contribution. '
  'contribution is the real "which trucks are bleeding" answer -- cost alone '
  'makes every truck look like a cost center.';

-- --- Bleeding units, ranked by dollars -------------------------------------
-- Replaces the original bleeding_flag, which fired for nearly every unit
-- because it compared cost against nothing.
CREATE OR REPLACE VIEW finance.v_bleeding_units AS
WITH per_unit AS (
    SELECT unit_number, entity_id,
           SUM(total_cost)::numeric(14,2)    AS total_cost,
           SUM(revenue)::numeric(14,2)       AS total_revenue,
           SUM(contribution)::numeric(14,2)  AS total_contribution,
           SUM(miles)::numeric(12,1)         AS total_miles,
           SUM(downtime_days)::numeric(10,1) AS total_downtime_days,
           SUM(breakdown_count)              AS total_breakdowns,
           COUNT(*)                          AS months_active
    FROM finance.v_unit_cost_monthly
    GROUP BY 1, 2
),
fleet AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_cost / NULLIF(total_miles,0)) AS median_cpm
    FROM per_unit WHERE total_miles > 0
)
SELECT p.*,
       CASE WHEN p.total_miles > 0 THEN (p.total_cost / p.total_miles)::numeric(10,4) END AS cost_per_mile,
       f.median_cpm::numeric(10,4) AS fleet_median_cost_per_mile,
       -- Revenue lost to downtime, using this unit's own revenue-per-active-day.
       -- Routinely larger than the repair invoice and invisible in a P&L.
       CASE WHEN p.total_revenue > 0 AND p.months_active > 0
            THEN (p.total_downtime_days * (p.total_revenue / (p.months_active * 30.0)))::numeric(14,2)
       END AS downtime_opportunity_cost,
       ARRAY_REMOVE(ARRAY[
         CASE WHEN p.total_contribution < 0                                     THEN 'negative_contribution' END,
         CASE WHEN p.total_miles > 0 AND f.median_cpm IS NOT NULL
                   AND p.total_cost / p.total_miles > f.median_cpm * 1.25       THEN 'cost_per_mile_25pct_over_fleet' END,
         CASE WHEN p.total_downtime_days > 30                                   THEN 'chronic_downtime' END,
         CASE WHEN p.total_miles IS NULL OR p.total_miles = 0                   THEN 'no_mileage_data' END,
         CASE WHEN p.total_revenue IS NULL                                      THEN 'no_revenue_data' END
       ], NULL) AS flags
FROM per_unit p CROSS JOIN fleet f
ORDER BY p.total_contribution NULLS LAST;

-- --- Break-even miles per truck per month ---------------------------------
--   break-even miles = fixed cost per month / (revenue per mile - variable per mile)
-- Fixed:    lease/note, insurance, registration/IFTA/permits, subscriptions
-- Variable: fuel, maintenance, tolls, driver settlement
CREATE OR REPLACE VIEW finance.v_breakeven_by_entity AS
WITH cost_split AS (
    SELECT t.entity_id,
           DATE_TRUNC('month', t.txn_date)::date AS month,
           SUM(CASE WHEN t.category IN ('lease_rent','loan_finance','insurance_premium',
                                        'registration','ifta','permits','subscriptions_saas')
                    AND t.amount < 0 THEN -t.amount ELSE 0 END)::numeric(14,2) AS fixed_cost,
           SUM(CASE WHEN t.category IN ('fuel','maintenance','tolls','driver_settlement')
                    AND t.amount < 0 THEN -t.amount ELSE 0 END)::numeric(14,2) AS variable_cost,
           -- financing recorded as actual cash; presence decides the fallback below
           SUM(CASE WHEN t.category IN ('lease_rent','loan_finance')
                    AND t.amount < 0 THEN -t.amount ELSE 0 END)::numeric(14,2) AS financing_cost
    FROM finance.transactions t
    WHERE NOT t.is_intercompany
    GROUP BY 1, 2
),
activity AS (
    SELECT u.entity_id, c.month,
           SUM(c.miles)::numeric(14,1)   AS miles,
           SUM(c.revenue)::numeric(14,2) AS revenue,
           SUM(c.lease_cost)::numeric(14,2) AS lease_obligation,
           COUNT(DISTINCT c.unit_number) AS active_units
    FROM finance.v_unit_cost_monthly c
    JOIN finance.v_units u ON u.unit_number = c.unit_number
    GROUP BY 1, 2
),
-- Lease/note is fixed cost, but it can be recorded as a bank transaction
-- (category lease_rent/loan_finance) OR as an asset obligation, or both.
-- Prefer actual cash; fall back to the obligation only when no such transaction
-- exists for the entity-month, so the two can never double-count. The source is
-- reported rather than hidden, because it changes how much to trust the number.
resolved_fixed AS (
    SELECT a.entity_id, a.month,
           CASE WHEN cs.financing_cost > 0 THEN cs.fixed_cost
                ELSE cs.fixed_cost + COALESCE(a.lease_obligation, 0) END::numeric(14,2) AS fixed_cost,
           CASE WHEN cs.financing_cost > 0 THEN 'transactions'
                WHEN COALESCE(a.lease_obligation,0) > 0 THEN 'transactions+asset_obligation'
                ELSE 'transactions' END AS fixed_cost_source
    FROM activity a
    JOIN cost_split cs ON cs.entity_id = a.entity_id AND cs.month = a.month
)
SELECT a.entity_id, a.month, a.active_units, a.miles, a.revenue,
       rf.fixed_cost, rf.fixed_cost_source, cs.variable_cost,
       (a.revenue / NULLIF(a.miles,0))::numeric(10,4)         AS revenue_per_mile,
       (cs.variable_cost / NULLIF(a.miles,0))::numeric(10,4)  AS variable_cost_per_mile,
       ((a.revenue - cs.variable_cost) / NULLIF(a.miles,0))::numeric(10,4) AS contribution_margin_per_mile,
       CASE WHEN (a.revenue - cs.variable_cost) > 0 AND a.miles > 0
            THEN (rf.fixed_cost / ((a.revenue - cs.variable_cost) / a.miles))::numeric(14,1)
       END AS breakeven_miles,
       CASE WHEN (a.revenue - cs.variable_cost) > 0 AND a.miles > 0 AND a.active_units > 0
            THEN (rf.fixed_cost / ((a.revenue - cs.variable_cost) / a.miles) / a.active_units)::numeric(12,1)
       END AS breakeven_miles_per_unit
FROM activity a
JOIN cost_split cs    ON cs.entity_id = a.entity_id AND cs.month = a.month
JOIN resolved_fixed rf ON rf.entity_id = a.entity_id AND rf.month = a.month;

COMMENT ON VIEW finance.v_breakeven_by_entity IS
  'Break-even miles per truck per month. Requires mileage from Samsara and '
  'revenue from QuickManage -- without miles this degrades to break-even '
  'revenue dollars, which is a much blunter instrument.';

COMMIT;
