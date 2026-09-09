-- Proves the schema ENFORCES the CLAUDE.md §8 acceptance criteria, rather
-- than merely leaving room for them. Run against a scratch database.
\set ON_ERROR_STOP on
\pset pager off

INSERT INTO accounting.entity (entity_id, code, legal_name)
VALUES ('11111111-1111-1111-1111-111111111111','ZONE','Zone Logistics LLC');
INSERT INTO accounting.category (category_id, category_group, display_name, sign)
VALUES ('fuel.diesel','fuel','Diesel',-1), ('revenue.linehaul','revenue','Linehaul',1);
INSERT INTO accounting.source_document
  (document_id, doc_type, file_name, mime_type, byte_size, sha256, storage_key, uploaded_by)
VALUES ('22222222-2222-2222-2222-222222222222','fuel','efs_2026_q1.csv','text/csv',
        1024, repeat('a',64), 'docs/efs_2026_q1.csv','ceo@fleet');
INSERT INTO accounting.connector_pull
  (pull_id, source_system, source_table, source_pk, snapshot, payload_hash)
VALUES ('33333333-3333-3333-3333-333333333333','dispatch','load_pipeline','L-9001',
        '{"load_id":"L-9001","revenue":2400.00}'::jsonb, repeat('b',64));

\echo '--- ASSERT 1: an untraceable number cannot be posted -----------------'
DO $$
BEGIN
  INSERT INTO accounting.ledger_entry
    (entity_id, accrual_date, category_id, amount, source_kind, posted_by)
  VALUES ('11111111-1111-1111-1111-111111111111','2026-01-15','fuel.diesel',
          -812.44,'document','ceo@fleet');   -- claims 'document', names none
  RAISE EXCEPTION 'FAIL: untraceable entry was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: untraceable entry rejected by provenance_matches_kind';
END $$;

\echo '--- ASSERT 2: a document-traced number posts fine --------------------'
INSERT INTO accounting.ledger_entry
  (entry_id, entity_id, accrual_date, category_id, amount, quantity, jurisdiction,
   source_kind, source_document_id, posted_by)
VALUES ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111',
        '2026-01-15','fuel.diesel',-812.44, 214.3300,'TX',
        'document','22222222-2222-2222-2222-222222222222','ceo@fleet');
\echo 'PASS: traced entry accepted'

\echo '--- ASSERT 3: the ledger is append-only ------------------------------'
DO $$
BEGIN
  UPDATE accounting.ledger_entry SET amount = -1.00
   WHERE entry_id = '44444444-4444-4444-4444-444444444444';
  RAISE EXCEPTION 'FAIL: ledger UPDATE was allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS: UPDATE blocked -- %', SQLERRM;
END $$;

DO $$
BEGIN
  DELETE FROM accounting.ledger_entry
   WHERE entry_id = '44444444-4444-4444-4444-444444444444';
  RAISE EXCEPTION 'FAIL: ledger DELETE was allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS: DELETE blocked -- %', SQLERRM;
END $$;

\echo '--- ASSERT 4: re-running a connector pull cannot double-post revenue --'
INSERT INTO accounting.ledger_entry
  (entity_id, accrual_date, category_id, amount, source_kind, connector_pull_id, posted_by)
VALUES ('11111111-1111-1111-1111-111111111111','2026-01-15','revenue.linehaul',
        2400.00,'connector','33333333-3333-3333-3333-333333333333','ingest-job');
DO $$
BEGIN
  INSERT INTO accounting.ledger_entry
    (entity_id, accrual_date, category_id, amount, source_kind, connector_pull_id, posted_by)
  VALUES ('11111111-1111-1111-1111-111111111111','2026-01-15','revenue.linehaul',
          2400.00,'connector','33333333-3333-3333-3333-333333333333','ingest-job');
  RAISE EXCEPTION 'FAIL: revenue double-posted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: duplicate connector post rejected';
END $$;

\echo '--- ASSERT 5: a correction reverses, it does not overwrite -----------'
INSERT INTO accounting.ledger_entry
  (entity_id, accrual_date, category_id, amount, source_kind,
   reverses_entry_id, memo, posted_by)
VALUES ('11111111-1111-1111-1111-111111111111','2026-01-16','fuel.diesel',
        812.44,'adjustment','44444444-4444-4444-4444-444444444444',
        'EFS restated gallons','controller@fleet');
\echo 'PASS: reversing entry accepted; original still on the books'

\echo '--- ASSERT 6: money arithmetic is exact, not floating point ----------'
SELECT CASE WHEN SUM(amount) = 2400.00
            THEN 'PASS: net = ' || SUM(amount)::text
            ELSE 'FAIL: net = ' || SUM(amount)::text END AS result
FROM accounting.ledger_entry;

\echo '--- ASSERT 7: a forecast cannot be stored without a confidence band --'
DO $$
DECLARE r uuid;
BEGIN
  INSERT INTO accounting.calc_run (engine, engine_version, period_start, period_end, inputs_hash)
  VALUES ('forecast','0.1.0','2026-01-19','2026-01-25', repeat('c',64))
  RETURNING calc_run_id INTO r;
  INSERT INTO accounting.forecast_run
    (calc_run_id, horizon_start, horizon_end, metric,
     point_estimate, lower_bound, upper_bound, method, basis)
  VALUES (r,'2026-01-19','2026-01-25','revenue', 50000, 60000, 40000,  -- inverted
          'moving_average','{}'::jsonb);
  RAISE EXCEPTION 'FAIL: inverted confidence band accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: inverted confidence band rejected';
END $$;
