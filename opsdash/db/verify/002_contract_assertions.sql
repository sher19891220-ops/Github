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

\echo '--- ASSERT 20: a split without a ratio is not a decision -------------'
INSERT INTO accounting.driver (driver_id, full_name)
VALUES ('88888888-8888-8888-8888-888888888888','Test Driver') ON CONFLICT DO NOTHING;
DO $$
BEGIN
  INSERT INTO accounting.chargeback_decision
    (ledger_entry_id, charged_to, driver_id, decided_by)
  VALUES ('44444444-4444-4444-4444-444444444444','split',
          '88888888-8888-8888-8888-888888888888','controller@fleet');
  RAISE EXCEPTION 'FAIL: split with no ratio accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: split without a ratio rejected';
END $$;

\echo '--- ASSERT 21: charging a driver must name the driver ----------------'
DO $$
BEGIN
  INSERT INTO accounting.chargeback_decision
    (ledger_entry_id, charged_to, decided_by)
  VALUES ('44444444-4444-4444-4444-444444444444','driver','controller@fleet');
  RAISE EXCEPTION 'FAIL: driver charge with no driver accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: driver charge without a driver rejected';
END $$;

\echo '--- ASSERT 22: a valid split is accepted -----------------------------'
INSERT INTO accounting.chargeback_decision
  (ledger_entry_id, charged_to, split_percent, driver_id, decided_by, note)
VALUES ('44444444-4444-4444-4444-444444444444','split',60.000,
        '88888888-8888-8888-8888-888888888888','controller@fleet','driver bears 60%');
\echo 'PASS: split with a percentage accepted'

\echo '--- ASSERT 23: expected-missing must carry a reason ------------------'
INSERT INTO accounting.reconciliation_run
  (run_id, source_document_id, period_start, period_end, opened_by)
VALUES ('aaaaaaaa-0000-0000-0000-00000000aaaa',
        '22222222-2222-2222-2222-222222222222','2026-01-01','2026-01-31','controller@fleet');
DO $$
BEGIN
  INSERT INTO accounting.reconciliation_match
    (run_id, ledger_entry_id, status, decided_by, decided_at)
  VALUES ('aaaaaaaa-0000-0000-0000-00000000aaaa',
          '44444444-4444-4444-4444-444444444444','expected_missing',
          'controller@fleet', now());
  RAISE EXCEPTION 'FAIL: expected_missing with no note accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: expected_missing without a reason rejected';
END $$;

\echo '--- ASSERT 24: a stated variance must be the real difference ---------'
DO $$
BEGIN
  INSERT INTO accounting.reconciliation_match
    (run_id, ledger_entry_id, status, document_amount, ledger_amount, variance)
  VALUES ('aaaaaaaa-0000-0000-0000-00000000aaaa',
          '55555555-5555-5555-5555-555555555555','auto_matched',
          100.00, 90.00, 5.00);   -- claims 5.00; the real difference is 10.00
  RAISE EXCEPTION 'FAIL: a fabricated variance was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: variance that is not the difference rejected';
END $$;

\echo '--- ASSERT 25: one document line cannot match twice in a run ---------'
INSERT INTO accounting.reconciliation_match
  (run_id, ledger_entry_id, status, document_amount, ledger_amount, variance)
VALUES ('aaaaaaaa-0000-0000-0000-00000000aaaa',
        '55555555-5555-5555-5555-555555555555','auto_matched', 100.00, 90.00, 10.00);
DO $$
BEGIN
  INSERT INTO accounting.reconciliation_match
    (run_id, ledger_entry_id, status, document_amount, ledger_amount, variance)
  VALUES ('aaaaaaaa-0000-0000-0000-00000000aaaa',
          '55555555-5555-5555-5555-555555555555','auto_matched', 50.00, 50.00, 0.00);
  RAISE EXCEPTION 'FAIL: the same ledger entry matched twice in one run';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: double-matching the same entry rejected';
END $$;

-- =====================================================================
-- Migration 007 — arrangement, collection status, cost shape, rate pair
-- =====================================================================

INSERT INTO accounting.connector_pull
  (pull_id, source_system, source_table, source_pk, snapshot, payload_hash)
VALUES ('bbbbbbbb-0000-0000-0000-0000000000b1','dispatch','load_pipeline','L-9002',
        '{"load_id":"L-9002","revenue":3100.00}'::jsonb, repeat('c',64));

INSERT INTO accounting.ledger_entry
  (entry_id, entity_id, accrual_date, category_id, amount, driver_class,
   source_kind, connector_pull_id, posted_by)
VALUES ('bbbbbbbb-0000-0000-0000-0000000000e1','11111111-1111-1111-1111-111111111111',
        '2026-02-02','revenue.linehaul', 3100.00, 'ltwa',
        'connector','bbbbbbbb-0000-0000-0000-0000000000b1','ingest-job');

\echo '--- ASSERT 26: lease-to-walk-away is a class the schema can express --'
SELECT CASE WHEN driver_class = 'ltwa'
            THEN 'PASS: ltwa accepted as a driver class'
            ELSE 'FAIL: ltwa not stored' END AS result
FROM accounting.ledger_entry
WHERE entry_id = 'bbbbbbbb-0000-0000-0000-0000000000e1';

\echo '--- ASSERT 27: funded and paid are different states, never a sum -----'
INSERT INTO accounting.collection_event
  (ledger_entry_id, status, effective_date, settled_amount, fee_amount,
   factor_name, recorded_by)
VALUES ('bbbbbbbb-0000-0000-0000-0000000000e1','submitted','2026-02-03',
        NULL, NULL, 'Triumph','controller@fleet'),
       ('bbbbbbbb-0000-0000-0000-0000000000e1','funded','2026-02-05',
        NULL, -93.00, 'Triumph','controller@fleet'),
       ('bbbbbbbb-0000-0000-0000-0000000000e1','paid','2026-02-27',
        3100.00, NULL, 'Triumph','controller@fleet');
SELECT CASE WHEN count(*) = 1 AND max(status::text) = 'paid'
            THEN 'PASS: current status is the latest event, not the total'
            ELSE 'FAIL: got ' || count(*)::text || ' current rows' END AS result
FROM accounting.v_collection_current
WHERE ledger_entry_id = 'bbbbbbbb-0000-0000-0000-0000000000e1';

\echo '--- ASSERT 28: a factoring fee is money out --------------------------'
DO $$
BEGIN
  INSERT INTO accounting.collection_event
    (ledger_entry_id, status, effective_date, fee_amount, recorded_by)
  VALUES ('bbbbbbbb-0000-0000-0000-0000000000e1','funded','2026-03-01',
          93.00,'controller@fleet');   -- a fee booked as an inflow
  RAISE EXCEPTION 'FAIL: a positive factoring fee was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: factoring fee booked as an inflow rejected';
END $$;

\echo '--- ASSERT 29: short-paid must say what actually arrived -------------'
DO $$
BEGIN
  INSERT INTO accounting.collection_event
    (ledger_entry_id, status, effective_date, recorded_by)
  VALUES ('bbbbbbbb-0000-0000-0000-0000000000e1','short_paid','2026-03-02',
          'controller@fleet');
  RAISE EXCEPTION 'FAIL: short_paid with no amount accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: short_paid without a settled amount rejected';
END $$;

\echo '--- ASSERT 30: revenue has no cost shape -----------------------------'
DO $$
BEGIN
  UPDATE accounting.category
     SET cost_shape = 'variable_pct_of_gross', cost_basis = 'per_gross_dollar'
   WHERE category_id = 'revenue.linehaul';
  RAISE EXCEPTION 'FAIL: a revenue category took a cost shape';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: cost shape on a revenue category rejected';
END $$;

\echo '--- ASSERT 31: shape and basis cannot disagree -----------------------'
DO $$
BEGIN
  UPDATE accounting.category
     SET cost_shape = 'fixed', cost_basis = 'per_mile'
   WHERE category_id = 'fuel.diesel';
  RAISE EXCEPTION 'FAIL: a fixed cost measured per mile was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: contradictory cost shape and basis rejected';
END $$;

UPDATE accounting.category
   SET cost_shape = 'variable_per_mile', cost_basis = 'per_mile'
 WHERE category_id = 'fuel.diesel';
\echo 'PASS: fuel classified as variable-per-mile'

\echo '--- ASSERT 32: a stated rate must name the document stating it -------'
DO $$
BEGIN
  INSERT INTO accounting.rate_fact
    (rate_key, kind, amount, basis, effective_from, recorded_by)
  VALUES ('registration.per_unit_year','stated', 1879.98,'per_unit',
          '2026-01-01','controller@fleet');   -- no source document
  RAISE EXCEPTION 'FAIL: an unsourced stated rate was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: stated rate with no source document rejected';
END $$;

\echo '--- ASSERT 33: stated and measured coexist, and the gap is visible ---'
INSERT INTO accounting.calc_run
  (calc_run_id, engine, engine_version, period_start, period_end, inputs_hash, status)
VALUES ('cccccccc-0000-0000-0000-0000000000c1','registration','1.0.0',
        '2026-01-01','2026-12-31', repeat('d',64), 'succeeded');
INSERT INTO accounting.rate_fact
  (rate_key, kind, amount, basis, effective_from, source_document_id, recorded_by)
VALUES ('admin.per_driver_week','stated', 50.0000,'per_enrollee','2026-01-01',
        '22222222-2222-2222-2222-222222222222','controller@fleet');
INSERT INTO accounting.rate_fact
  (rate_key, kind, amount, basis, effective_from, calc_run_id, recorded_by)
VALUES ('admin.per_driver_week','measured', 173.4200,'per_enrollee','2026-01-01',
        'cccccccc-0000-0000-0000-0000000000c1','controller@fleet');
SELECT CASE WHEN gap = 123.4200
            THEN 'PASS: the real cost exceeds the stated fee by ' || gap::text
            ELSE 'FAIL: gap = ' || gap::text END AS result
FROM accounting.v_rate_gap
WHERE rate_key = 'admin.per_driver_week';

\echo '--- ASSERT 34: a document cannot have two reconciliations open -------'
DO $$
BEGIN
  INSERT INTO accounting.reconciliation_run
    (source_document_id, period_start, period_end, opened_by)
  VALUES ('22222222-2222-2222-2222-222222222222','2026-02-01','2026-02-28','other@fleet');
  RAISE EXCEPTION 'FAIL: a second open run on the same document accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: second open reconciliation on one document rejected';
END $$;

\echo '--- ASSERT 35: closing the first lets a later one open ---------------'
UPDATE accounting.reconciliation_run
   SET closed_at = now()
 WHERE run_id = 'aaaaaaaa-0000-0000-0000-00000000aaaa';
INSERT INTO accounting.reconciliation_run
  (source_document_id, period_start, period_end, opened_by)
VALUES ('22222222-2222-2222-2222-222222222222','2026-02-01','2026-02-28','other@fleet');
\echo 'PASS: a second run opens once the first is closed'

\echo '--- ASSERT 36: a rejected pairing frees both lines to stand alone ----'
UPDATE accounting.reconciliation_match
   SET status = 'rejected', decided_by = 'controller@fleet', decided_at = now()
 WHERE run_id = 'aaaaaaaa-0000-0000-0000-00000000aaaa'
   AND ledger_entry_id = '55555555-5555-5555-5555-555555555555';
INSERT INTO accounting.reconciliation_match
  (run_id, ledger_entry_id, status, ledger_amount)
VALUES ('aaaaaaaa-0000-0000-0000-00000000aaaa',
        '55555555-5555-5555-5555-555555555555','unmatched', 90.00);
\echo 'PASS: the freed line takes a standalone row'

\echo '--- ASSERT 37: but two live pairings on one line are still refused ---'
DO $$
BEGIN
  INSERT INTO accounting.reconciliation_match
    (run_id, ledger_entry_id, status, ledger_amount)
  VALUES ('aaaaaaaa-0000-0000-0000-00000000aaaa',
          '55555555-5555-5555-5555-555555555555','auto_matched', 90.00);
  RAISE EXCEPTION 'FAIL: a second live row on the same line accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: a second live row on the same line still rejected';
END $$;

-- =====================================================================
-- Migration 009 — account nature
-- =====================================================================

\echo '--- ASSERT 38: a principal repayment cannot claim to be a P&L line --'
DO $$
BEGIN
  INSERT INTO accounting.category (category_id, category_group, display_name, sign)
  VALUES ('lease.principal', 'lease', 'Equipment loan principal', -1);
  RAISE EXCEPTION 'FAIL: a principal category defaulted onto the P&L';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: principal category rejected as a P&L line';
END $$;

\echo '--- ASSERT 39: the same category is accepted once it says what it is -'
INSERT INTO accounting.category
  (category_id, category_group, display_name, sign, account_nature)
VALUES ('lease.principal', 'lease', 'Equipment loan principal', -1, 'balance_sheet');
\echo 'PASS: principal category accepted as a balance-sheet movement'

\echo '--- ASSERT 40: interest IS a cost, and stays on the P&L --------------'
INSERT INTO accounting.category (category_id, category_group, display_name, sign)
VALUES ('lease.interest', 'lease', 'Equipment loan interest', -1);
SELECT CASE WHEN account_nature = 'pnl'
            THEN 'PASS: interest is a P&L line'
            ELSE 'FAIL: interest classified as ' || account_nature::text END AS result
FROM accounting.category WHERE category_id = 'lease.interest';

\echo '--- ASSERT 41: a prepaid or receivable id cannot be a P&L line -------'
DO $$
BEGIN
  INSERT INTO accounting.category (category_id, category_group, display_name, sign)
  VALUES ('prepaid.insurance', 'insurance', 'Prepaid insurance', -1);
  RAISE EXCEPTION 'FAIL: a prepaid asset defaulted onto the P&L';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: prepaid category rejected as a P&L line';
END $$;

\echo '--- ASSERT 42: revenue can never be a balance-sheet movement ---------'
DO $$
BEGIN
  UPDATE accounting.category
     SET account_nature = 'balance_sheet'
   WHERE category_id = 'revenue.linehaul';
  RAISE EXCEPTION 'FAIL: revenue was reclassified off the P&L';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: revenue cannot be moved off the P&L';
END $$;

\echo '--- ASSERT 43: the categories that shipped wrong were corrected ------'
SELECT CASE WHEN count(*) = 0
            THEN 'PASS: every seeded non-P&L category is classified'
            ELSE 'FAIL: ' || count(*)::text || ' still marked pnl' END AS result
FROM accounting.category
WHERE account_nature = 'pnl'
  AND category_id IN ('prepaid.registration', 'receivable.driver',
                      'receivable.intercompany', 'payable.intercompany');
