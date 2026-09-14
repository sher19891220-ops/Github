-- =====================================================================
-- Migration 012 — A fuel-card statement is its own kind of document
--
-- `doc_type = 'fuel'` has meant the operator's Fuel *Google Sheet* since
-- migration 001. The upload screen has been offering it under the label
-- "Fuel (EFS/Relay statement)" the whole time, which is a promise the
-- routing did not keep: a real EFS or Relay statement dropped on that
-- screen was handed to the sheet parser and failed.
--
-- They are genuinely different documents. The sheet is a hand-kept log
-- that knows WHERE fuel was bought and — on 97.5% of its rows, measured
-- against the real file — not HOW MUCH. The card statement is the
-- vendor's own record and is the only source of IFTA gallons this build
-- has. Giving it its own type lets the right parser run, lets the review
-- screen say which it is looking at, and keeps the two from being mixed
-- in one reconciliation.
-- =====================================================================

ALTER TYPE accounting.doc_type ADD VALUE IF NOT EXISTS 'fuel_card';

BEGIN;

-- Sheet purposes gain the same distinction: a fuel-card export pulled
-- from a Google Sheet is the card statement's data, not the log's.
ALTER TABLE accounting.sheet_source DROP CONSTRAINT sheet_source_purpose_check;
ALTER TABLE accounting.sheet_source ADD CONSTRAINT sheet_source_purpose_check
  CHECK (purpose IN (
    'revenue','fuel','fuel_card','fuel_summary','maintenance_cost','maintenance_log',
    'toll','truck_roster','driver_roster','driver_pay','lease','odometer',
    'factoring','truck_status','ifta_mileage','intercompany'));

COMMIT;
