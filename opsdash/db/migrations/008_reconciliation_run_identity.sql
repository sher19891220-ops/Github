-- =====================================================================
-- Migration 008 — One open reconciliation per document
--
-- Migration 006 gave a run a document, a period and an opener, but
-- nothing stopping two runs existing for the same document at once.
-- That matters now that the endpoint opens a run on first read: without
-- this index, two accountants opening the same statement get two runs,
-- each with its own half of the matches, and both look complete.
--
-- Closed runs are exempt: reconciling the same document again next
-- quarter after closing the first run is a legitimate second run, and
-- the history of the first must stay readable.
-- =====================================================================

BEGIN;

CREATE UNIQUE INDEX ux_recon_run_open_per_document
  ON accounting.reconciliation_run (source_document_id)
  WHERE closed_at IS NULL;

COMMENT ON INDEX accounting.ux_recon_run_open_per_document IS
  'A document has at most one reconciliation open at a time. Two open '
  'runs would split the matches between them and both would look done.';

-- ---------------------------------------------------------------------
-- Rejecting a pairing must free both lines again
--
-- Migration 006's uniqueness ("within one run a document line pairs at
-- most once") was right about pairings and wrong about rejections. When a
-- person breaks a pairing apart, both lines go back to being unmatched
-- and each needs a row of its own to carry its own later decision -- but
-- the old index counted the rejected pairing as still occupying both
-- sides, so the singletons could not be written and the lines became
-- undecidable.
--
-- The rejected row stays, because who rejected what and when is the
-- audit trail. It simply stops holding the slot.
-- ---------------------------------------------------------------------

DROP INDEX accounting.ux_recon_staging_once;
DROP INDEX accounting.ux_recon_ledger_once;

CREATE UNIQUE INDEX ux_recon_staging_once
  ON accounting.reconciliation_match (run_id, staging_row_id)
  WHERE staging_row_id IS NOT NULL AND status <> 'rejected';

CREATE UNIQUE INDEX ux_recon_ledger_once
  ON accounting.reconciliation_match (run_id, ledger_entry_id)
  WHERE ledger_entry_id IS NOT NULL AND status <> 'rejected';

COMMIT;
