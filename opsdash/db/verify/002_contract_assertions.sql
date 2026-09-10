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

\echo '--- ASSERT 8: a truck-attributed cost must actually name a truck ------'
DO $$
BEGIN
  INSERT INTO accounting.ledger_entry
    (entity_id, accrual_date, category_id, amount, source_kind,
     source_document_id, unit_type, posted_by)
  VALUES ('11111111-1111-1111-1111-111111111111','2026-01-20','fuel.diesel',
          -100.00,'document','22222222-2222-2222-2222-222222222222',
          'truck','ceo@fleet');   -- claims 'truck', names none
  RAISE EXCEPTION 'FAIL: unattributed truck cost accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: truck cost without a truck rejected';
END $$;

\echo '--- ASSERT 9: a trailer cost cannot masquerade as a truck cost -------'
DO $$
BEGIN
  INSERT INTO accounting.ledger_entry
    (entity_id, truck_id, accrual_date, category_id, amount, source_kind,
     source_document_id, unit_type, unit_number, posted_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
          NULL,'2026-01-20','fuel.diesel',-100.00,'document',
          '22222222-2222-2222-2222-222222222222','trailer','50272','ceo@fleet');
  -- A trailer cost with no truck_id is correct and must be accepted.
  RAISE NOTICE 'PASS: trailer cost accepted without a truck attribution';
END $$;

\echo '--- ASSERT 10: an unattributed cost defaults to unknown, not truck ---'
INSERT INTO accounting.ledger_entry
  (entry_id, entity_id, accrual_date, category_id, amount, source_kind,
   source_document_id, posted_by)
VALUES ('55555555-5555-5555-5555-555555555555',
        '11111111-1111-1111-1111-111111111111','2026-01-21','fuel.diesel',
        -55.00,'document','22222222-2222-2222-2222-222222222222','ceo@fleet');
SELECT CASE WHEN unit_type = 'unknown'
            THEN 'PASS: unattributed cost defaulted to unknown'
            ELSE 'FAIL: defaulted to ' || unit_type::text END AS result
FROM accounting.ledger_entry WHERE entry_id = '55555555-5555-5555-5555-555555555555';

\echo '--- ASSERT 11: driver-charged cost is separable from company cost ----'
INSERT INTO accounting.ledger_entry
  (entity_id, accrual_date, category_id, amount, source_kind,
   source_document_id, charged_to, memo, posted_by)
VALUES ('11111111-1111-1111-1111-111111111111','2026-01-22','fuel.diesel',
        -420.00,'document','22222222-2222-2222-2222-222222222222',
        'driver','radiator, charged back to LO driver','controller@fleet');
SELECT CASE WHEN COUNT(*) FILTER (WHERE charged_to = 'driver') = 1
             AND COUNT(*) FILTER (WHERE charged_to = 'company') >= 1
            THEN 'PASS: company and driver costs are distinguishable'
            ELSE 'FAIL: chargeback not separable' END AS result
FROM accounting.ledger_entry;

\echo '--- ASSERT 12: intercompany recharge keeps both sides straight --------'
INSERT INTO accounting.entity (entity_id, code, legal_name)
VALUES ('66666666-6666-6666-6666-666666666666','XTRACK','Xtrack LLC');
INSERT INTO accounting.category (category_id, category_group, display_name, sign)
VALUES ('permit.test','permit','Permit test',-1) ON CONFLICT DO NOTHING;

-- Zone pays; the cost belongs to Xtrack, who operates the truck.
INSERT INTO accounting.ledger_entry
  (entity_id, paid_by_entity_id, accrual_date, category_id, amount,
   source_kind, source_document_id, posted_by)
VALUES ('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111',
        '2026-09-30','permit.test',-1879.98,'document',
        '22222222-2222-2222-2222-222222222222','engine');
-- Zone's matching receivable from Xtrack.
INSERT INTO accounting.ledger_entry
  (entity_id, counterparty_entity_id, accrual_date, category_id, amount,
   source_kind, source_document_id, posted_by)
VALUES ('11111111-1111-1111-1111-111111111111','66666666-6666-6666-6666-666666666666',
        '2026-09-30','receivable.intercompany',1879.98,'document',
        '22222222-2222-2222-2222-222222222222','engine');
\echo 'PASS: recharge and its receivable both accepted'

\echo '--- ASSERT 13: an intercompany balance must name a counterparty ------'
DO $$
BEGIN
  INSERT INTO accounting.ledger_entry
    (entity_id, accrual_date, category_id, amount, source_kind,
     source_document_id, posted_by)
  VALUES ('11111111-1111-1111-1111-111111111111','2026-09-30',
          'receivable.intercompany',100.00,'document',
          '22222222-2222-2222-2222-222222222222','engine');
  RAISE EXCEPTION 'FAIL: unmatched intercompany balance accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: intercompany without a counterparty rejected';
END $$;

\echo '--- ASSERT 14: a company cannot owe itself ---------------------------'
DO $$
BEGIN
  INSERT INTO accounting.ledger_entry
    (entity_id, counterparty_entity_id, accrual_date, category_id, amount,
     source_kind, source_document_id, posted_by)
  VALUES ('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
          '2026-09-30','receivable.intercompany',100.00,'document',
          '22222222-2222-2222-2222-222222222222','engine');
  RAISE EXCEPTION 'FAIL: self-counterparty accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: self-counterparty rejected';
END $$;

\echo '--- ASSERT 15: group roll-up does not double-count the recharge ------'
SELECT CASE
  WHEN (SELECT COUNT(*) FROM accounting.ledger_entry
        WHERE category_id LIKE '%.intercompany') = 1
   AND (SELECT COUNT(*) FROM accounting.v_ledger_consolidated
        WHERE category_id LIKE '%.intercompany') = 0
  THEN 'PASS: intercompany legs excluded from the consolidated view'
  ELSE 'FAIL: consolidated view still carries intercompany legs' END AS result;

\echo '--- ASSERT 16: a truck transferring mid-month splits across carriers -'
INSERT INTO accounting.ledger_entry
  (entry_id, entity_id, accrual_date, category_id, amount, source_kind,
   source_document_id, posted_by)
VALUES ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111',
        '2026-09-09','permit.test',-2429.98,'document',
        '22222222-2222-2222-2222-222222222222','engine');

-- Zone holds unit 1431 for the first 14 days of Feb 2027, Xtrack the rest.
INSERT INTO accounting.amortization_schedule
  (source_document_id, prepaid_entry_id, entity_id, unit_number, category_id,
   period_month, segment_start, segment_end, days, amount)
VALUES
 ('22222222-2222-2222-2222-222222222222','99999999-9999-9999-9999-999999999999',
  '11111111-1111-1111-1111-111111111111','1431','permit.test',
  '2027-02-01','2027-02-01','2027-02-14',14,-93.20),
 ('22222222-2222-2222-2222-222222222222','99999999-9999-9999-9999-999999999999',
  '66666666-6666-6666-6666-666666666666','1431','permit.test',
  '2027-02-01','2027-02-15','2027-02-28',14,-93.20);
\echo 'PASS: both halves of a transfer month accepted'

\echo '--- ASSERT 17: the changeover day cannot be charged twice ----------'
DO $$
BEGIN
  -- Xtrack tries to claim the 14th, which Zone already holds.
  INSERT INTO accounting.amortization_schedule
    (source_document_id, prepaid_entry_id, entity_id, unit_number, category_id,
     period_month, segment_start, segment_end, days, amount)
  VALUES ('22222222-2222-2222-2222-222222222222',
          '99999999-9999-9999-9999-999999999999',
          '66666666-6666-6666-6666-666666666666','1431','permit.test',
          '2027-02-01','2027-02-14','2027-02-20',7,-46.60);
  RAISE EXCEPTION 'FAIL: overlapping segments accepted - a day was double-charged';
EXCEPTION WHEN exclusion_violation THEN
  RAISE NOTICE 'PASS: overlapping carrier segments rejected';
END $$;

\echo '--- ASSERT 18: a segment cannot escape its month -------------------'
DO $$
BEGIN
  INSERT INTO accounting.amortization_schedule
    (source_document_id, prepaid_entry_id, entity_id, unit_number, category_id,
     period_month, segment_start, segment_end, days, amount)
  VALUES ('22222222-2222-2222-2222-222222222222',
          '99999999-9999-9999-9999-999999999999',
          '11111111-1111-1111-1111-111111111111','9999','permit.test',
          '2027-03-01','2027-03-01','2027-04-05',36,-100.00);
  RAISE EXCEPTION 'FAIL: segment spilling past its month accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: segment outside its month rejected';
END $$;

\echo '--- ASSERT 19: the split reconciles to the whole month -------------'
SELECT CASE WHEN SUM(days) = 28 AND SUM(amount) = -186.40
            THEN 'PASS: Feb segments sum to 28 days and the month total'
            ELSE 'FAIL: got ' || SUM(days) || ' days, ' || SUM(amount) END AS result
FROM accounting.amortization_schedule
WHERE unit_number = '1431' AND period_month = '2027-02-01';
