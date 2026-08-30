-- Run this FIRST, on the Mac Mini, before applying any migration.
-- It answers the questions the finance schema design depends on.
--   psql -h 100.77.103.37 -U aiops -d aiops -f db/postgres/000_discover_aiops.sql
--
-- Save the output. Three specific answers decide the design:
--   1. What are the real unit/asset table and column names?
--   2. Is there per-unit MILEAGE history? (decides whether cost-per-mile exists)
--   3. Does QuickManage repair-order COST reach aiops, or only Samsara fault codes?
--      (decides how much maintenance cost has to come from card statements)

\echo '=== Schemas ==='
SELECT schema_name FROM information_schema.schemata
WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
ORDER BY 1;

\echo '=== Tables, row counts, size ==='
SELECT schemaname, relname AS table_name, n_live_tup AS approx_rows,
       pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;

\echo '=== Columns of anything unit / vehicle / asset / truck shaped ==='
SELECT table_schema, table_name, ordinal_position, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog','information_schema')
  AND (table_name ~* 'unit|vehicle|asset|truck|trailer|equipment')
ORDER BY table_schema, table_name, ordinal_position;

\echo '=== Columns of anything maintenance / repair / fault / DVIR shaped ==='
SELECT table_schema, table_name, ordinal_position, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog','information_schema')
  AND (table_name ~* 'maint|repair|fault|dvir|service|work_order|defect')
ORDER BY table_schema, table_name, ordinal_position;

\echo '=== ANY column that looks like mileage/odometer — decides cost-per-mile ==='
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog','information_schema')
  AND (column_name ~* 'mile|odom|distance|hub')
ORDER BY table_schema, table_name;

\echo '=== ANY column that looks like revenue/load/settlement — decides contribution per truck ==='
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog','information_schema')
  AND (column_name ~* 'revenue|linehaul|rate|gross|settlement|payout'
       OR table_name ~* 'load|trip|order|settlement|invoice')
ORDER BY table_schema, table_name;

\echo '=== Anything already financial — do NOT duplicate what exists ==='
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog','information_schema')
  AND (table_name ~* 'transact|expense|cost|invoice|payment|ledger|account|fuel|toll')
ORDER BY 1,2;

\echo '=== Freshness: which tables are actually being written to ==='
SELECT schemaname, relname, n_tup_ins, n_tup_upd, last_autovacuum, last_analyze
FROM pg_stat_user_tables
WHERE n_tup_ins > 0
ORDER BY n_tup_ins DESC
LIMIT 40;

\echo '=== Postgres version + extensions ==='
SELECT version();
SELECT extname, extversion FROM pg_extension ORDER BY 1;
