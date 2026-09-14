-- Confirms CLAUDE.md §1 against the live aiops database before Phase 2 begins.
--
-- Read-only: SELECTs against information_schema only. Safe to run against
-- production. Run with:
--   psql "$AIOPS_DATABASE_URL" -f db/verify/001_confirm_ground_truth.sql
--
-- Three questions, in order of how much they can hurt the build:
--   A. Do the §1 tables still exist?
--   B. Does per-jurisdiction mileage exist anywhere? (blocks the IFTA engine)
--   C. Do the join-critical tables carry the columns the contract assumes?

\pset pager off
\timing off

\echo '=== A. CLAUDE.md §1 table list vs. live schema ==='

WITH expected(relname, why) AS (VALUES
  ('samsara_fuel_reports',     'fuel: reconciliation target + IFTA tax-paid gallons'),
  ('truck_fuel_history',       'fuel: reconciliation target'),
  ('live_trucks',              'dimension: canonical truck list'),
  ('live_trips',               'mileage + possible per-jurisdiction source'),
  ('load_pipeline',            'revenue: actuals + open pipeline for prediction'),
  ('dispatch_weekly_summary',  'revenue: weekly actuals'),
  ('weekly_company_summary',   'entity dimension + cross-check for P&L rollup'),
  ('driver_performance',       'driver dimension'),
  ('driver_risk_scores',       'driver dimension'),
  ('driver_risk_summary',      'driver dimension'),
  ('samsara_vehicles',         'dimension: truck crosswalk'),
  ('samsara_drivers',          'dimension: driver crosswalk'),
  ('samsara_vehicle_stats',    'mileage source'),
  ('samsara_dvirs',            'context only'),
  ('samsara_faults',           'context only'),
  ('samsara_safety_events',    'context only'),
  ('truck_inspections',        'context only (NOT maintenance cost)'),
  ('inspection_reports',       'context only (NOT maintenance cost)'),
  ('pti_inspections',          'context only (NOT maintenance cost)'),
  ('debt_balances',            'lease-to-own balances'),
  ('debt_collections',         'lease-to-own collections'),
  ('recruiting_pipeline',      'out of scope for accounting'),
  ('v_fuel_efficiency_truck',  'pre-built view'),
  ('v_truck_scorecard',        'pre-built view'),
  ('v_fleet_health',           'pre-built view'),
  ('v_truck_miles_30d',        'mileage view -- TOTAL miles, not per-state')
)
SELECT
  e.relname                                   AS expected_object,
  COALESCE(c.relkind::text, '-')              AS kind,   -- r=table, v=view, m=matview
  CASE WHEN c.relname IS NULL
       THEN '*** MISSING ***' ELSE 'present' END AS status,
  e.why                                       AS matters_because
FROM expected e
LEFT JOIN pg_class c
       ON c.relname = e.relname
      AND c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r','v','m','p','f')
ORDER BY (c.relname IS NOT NULL), e.relname;

\echo ''
\echo '=== A2. Objects in public NOT named in §1 (new since the ground-truth pass) ==='

SELECT c.relname, c.relkind
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relkind IN ('r','v','m','p','f')
  AND c.relname NOT IN (
    'samsara_fuel_reports','truck_fuel_history','live_trucks','live_trips',
    'load_pipeline','dispatch_weekly_summary','weekly_company_summary',
    'driver_performance','driver_risk_scores','driver_risk_summary',
    'samsara_vehicles','samsara_drivers','samsara_vehicle_stats','samsara_dvirs',
    'samsara_faults','samsara_safety_events','truck_inspections',
    'inspection_reports','pti_inspections','debt_balances','debt_collections',
    'recruiting_pipeline','v_fuel_efficiency_truck','v_truck_scorecard',
    'v_fleet_health','v_truck_miles_30d')
ORDER BY c.relname;

\echo ''
\echo '=== B. BLOCKER CHECK: per-jurisdiction mileage/fuel anywhere in the DB ==='
\echo '    IFTA needs miles BY STATE and gallons purchased BY STATE.'
\echo '    If this returns nothing, the Phase 3 IFTA engine has no input.'

SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (column_name ~* '(^|_)(state|jurisdiction|province|region)(_|$)'
       OR column_name ~* 'ifta')
ORDER BY table_name, column_name;

\echo ''
\echo '=== C. Columns of the join-critical tables ==='

SELECT table_name, ordinal_position AS pos, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'samsara_fuel_reports','truck_fuel_history','load_pipeline',
    'dispatch_weekly_summary','weekly_company_summary','live_trucks',
    'live_trips','samsara_vehicles','samsara_drivers','samsara_vehicle_stats',
    'debt_balances')
ORDER BY table_name, ordinal_position;

\echo ''
\echo '=== C2. Row counts and freshness (is ingestion actually still running?) ==='

SELECT relname AS table_name,
       n_live_tup AS approx_rows,
       last_autoanalyze,
       last_analyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_live_tup DESC
LIMIT 30;

\echo ''
\echo '=== D. Does the accounting schema already exist? (must be empty before migration 001) ==='

SELECT nspname FROM pg_namespace WHERE nspname = 'accounting';
