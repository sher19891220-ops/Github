-- =====================================================================
-- Migration 006 — Reconciliation matches and chargeback decisions
--
-- The two screens the operator named as the accounting team's worst daily
-- work have no persistence. `fuel_reconciliation` (migration 001) is a
-- per-truck, per-period gallons aggregate — useful, but not the
-- line-level pairing a person actually works through. And `charged_to`
-- records *what* a row was charged to while saying nothing about who
-- decided, when, or on what basis.
--
-- Both are decisions made by people about money. Neither can be a column
-- that quietly changes.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Reconciliation
-- ---------------------------------------------------------------------

CREATE TYPE accounting.recon_status AS ENUM (
  'auto_matched',      -- the matcher paired these; no human has looked
  'confirmed',         -- a person agreed with the pairing
  'rejected',          -- a person broke the pairing apart
  'expected_missing',  -- a person says this line legitimately has no partner
  'unmatched'          -- nothing proposed
);

CREATE TABLE accounting.reconciliation_run (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id uuid NOT NULL REFERENCES accounting.source_document(document_id),
  entity_id       uuid REFERENCES accounting.entity(entity_id),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  opened_by       text NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  notes           text,
  CHECK (period_end >= period_start)
);

CREATE TABLE accounting.reconciliation_match (
  match_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES accounting.reconciliation_run(run_id)
                    ON DELETE CASCADE,

  -- One side is a line from the document being reconciled, the other an
  -- entry already on the books. Either may be absent: that is precisely
  -- what an unmatched line is.
  staging_row_id  uuid REFERENCES accounting.staging_row(staging_row_id),
  ledger_entry_id uuid REFERENCES accounting.ledger_entry(entry_id),

  status          accounting.recon_status NOT NULL,

  -- Stored rather than recomputed, because the entries either side are
  -- append-only and a later correction must not silently rewrite what a
  -- person saw when they made this call.
  document_amount numeric(14,2),
  ledger_amount   numeric(14,2),
  variance        numeric(14,2),

  decided_by      text,
  decided_at      timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- A match with neither side is not a match.
  CONSTRAINT match_has_a_side CHECK (
    staging_row_id IS NOT NULL OR ledger_entry_id IS NOT NULL
  ),

  -- "This legitimately has no partner" is a claim about the world. It
  -- needs a reason, or next quarter nobody can tell it from an oversight.
  CONSTRAINT expected_missing_needs_a_note CHECK (
    status <> 'expected_missing'
    OR (note IS NOT NULL AND length(trim(note)) > 0)
  ),

  -- A human decision records who made it.
  CONSTRAINT human_decisions_are_attributed CHECK (
    status NOT IN ('confirmed', 'rejected', 'expected_missing')
    OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),

  -- The variance must be the difference actually shown, not a number
  -- someone typed. A reconciliation whose arithmetic is unchecked is
  -- theatre.
  CONSTRAINT variance_is_the_difference CHECK (
    variance IS NULL
    OR variance = COALESCE(document_amount, 0) - COALESCE(ledger_amount, 0)
  )
);

-- Within one run a document line pairs at most once, and so does a
-- ledger entry. Without this, the same invoice line can be reconciled
-- against two different entries and the run still looks balanced.
CREATE UNIQUE INDEX ux_recon_staging_once
  ON accounting.reconciliation_match (run_id, staging_row_id)
  WHERE staging_row_id IS NOT NULL;

CREATE UNIQUE INDEX ux_recon_ledger_once
  ON accounting.reconciliation_match (run_id, ledger_entry_id)
  WHERE ledger_entry_id IS NOT NULL;

CREATE INDEX ix_recon_open
  ON accounting.reconciliation_match (run_id, status);

-- ---------------------------------------------------------------------
-- 2. Chargeback decisions
--
-- `charged_to` says what a row was charged to. This says who decided it,
-- when, and on what split — which is what someone needs months later
-- when a driver disputes a deduction.
-- ---------------------------------------------------------------------

CREATE TABLE accounting.chargeback_decision (
  decision_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  staging_row_id  uuid REFERENCES accounting.staging_row(staging_row_id),
  ledger_entry_id uuid REFERENCES accounting.ledger_entry(entry_id),

  charged_to      accounting.charged_to NOT NULL,

  -- A split needs a ratio. Exactly one of these carries it; a split
  -- labelled "split" with no proportion is not a decision, it is a
  -- deferral wearing a decision's clothes.
  split_amount    numeric(14,2),
  split_percent   numeric(6,3),

  driver_id       uuid REFERENCES accounting.driver(driver_id),
  decided_by      text NOT NULL,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  note            text,

  -- Set when this decision replaces an earlier one, so the history of a
  -- disputed charge stays readable instead of being overwritten.
  supersedes_id   uuid REFERENCES accounting.chargeback_decision(decision_id),

  CONSTRAINT decision_has_a_subject CHECK (
    staging_row_id IS NOT NULL OR ledger_entry_id IS NOT NULL
  ),

  CONSTRAINT split_carries_exactly_one_ratio CHECK (
    CASE charged_to
      WHEN 'split' THEN (split_amount IS NULL) <> (split_percent IS NULL)
      ELSE split_amount IS NULL AND split_percent IS NULL
    END
  ),

  CONSTRAINT percent_is_a_percentage CHECK (
    split_percent IS NULL OR (split_percent > 0 AND split_percent < 100)
  ),

  -- Charging a driver requires naming the driver. Otherwise the amount
  -- is owed by nobody in particular, which is the same as not charging it.
  CONSTRAINT driver_charges_name_the_driver CHECK (
    charged_to NOT IN ('driver', 'split') OR driver_id IS NOT NULL
  )
);

CREATE INDEX ix_chargeback_subject
  ON accounting.chargeback_decision (staging_row_id, ledger_entry_id);

CREATE INDEX ix_chargeback_driver
  ON accounting.chargeback_decision (driver_id, decided_at DESC)
  WHERE driver_id IS NOT NULL;

-- Only one decision stands at a time per subject; a replacement must say
-- what it supersedes, so the chain is reconstructible.
CREATE UNIQUE INDEX ux_chargeback_current_staging
  ON accounting.chargeback_decision (staging_row_id)
  WHERE staging_row_id IS NOT NULL AND supersedes_id IS NULL;

COMMENT ON TABLE accounting.chargeback_decision IS
  'Who decided a cost was the company''s or the driver''s, when, and on '
  'what split. The column on the ledger says what; this says why and by '
  'whom, which is what a disputed deduction needs months later.';

COMMIT;
