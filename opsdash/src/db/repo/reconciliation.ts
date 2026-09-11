/**
 * Reconciliation persistence — `accounting.reconciliation_run` and
 * `accounting.reconciliation_match` (migrations 006 and 008).
 *
 * Four things the UI workstream correctly declined to decide on its own,
 * decided here because the schema settles them:
 *
 *  - **The ledger side is posted `ledger_entry` rows** for the run's period.
 *    `reconciliation_match` references a staging row and a ledger entry and
 *    nothing else, so that is what can actually be stored. Reconciling a
 *    document against an unposted sheet is a real future case; it is not
 *    this one, and pretending otherwise would mean writing matches that
 *    point at nothing.
 *
 *  - **`near_match` is derived, never stored.** It is `auto_matched` with a
 *    non-zero variance. The database enum says what the matcher did; the
 *    variance column says whether a person needs to look.
 *
 *  - **Opening is idempotent.** The first read of a document opens a run;
 *    every later read reuses it. Migration 008's partial unique index makes
 *    that true under concurrency rather than by hoping, which matters
 *    because two accountants opening the same statement would otherwise get
 *    half the matches each and both screens would look complete.
 *
 *  - **Rejecting frees both lines.** The rejected pairing stays as the audit
 *    trail and two fresh singletons take its place, so each side can carry
 *    its own later decision.
 *
 * Amounts are read back as strings (src/db/pool.ts pins the NUMERIC parser)
 * and every subtraction goes through integer cents. Nothing here calls
 * `Number()` on a money value.
 */
import type {
  Decimal,
  ReconDecisionStatus,
  ReconLine,
  ReconMatch,
  ReconMatchStatus,
  ReconSummary,
  ReconciliationSet,
} from '@/contract/types';
import { query } from '@/db/pool';
import { centsFromDecimal, decimalFromCents } from '@/engines/registration/money';
import { type MatchCandidate, normalizeUnitKey, proposeMatches } from './reconciliationMatcher';

export class DocumentNotReconcilableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentNotReconcilableError';
  }
}

export class MatchNotFoundError extends Error {
  constructor(matchId: string) {
    super(`reconciliation match ${matchId} not found`);
    this.name = 'MatchNotFoundError';
  }
}

/* --------------------------------------------------------------------- */
/* Reading                                                                */
/* --------------------------------------------------------------------- */

interface DocumentSideRow {
  staging_row_id: string;
  truck_id: string | null;
  driver_id: string | null;
  accrual_date: string | null;
  amount: string | null;
  quantity: string | null;
  unit_number: string | null;
  description: string | null;
}

interface LedgerSideRow {
  entry_id: string;
  truck_id: string | null;
  driver_id: string | null;
  accrual_date: string;
  amount: string;
  quantity: string | null;
  unit_number: string | null;
  memo: string | null;
  category_id: string;
}

interface MatchDbRow {
  match_id: string;
  staging_row_id: string | null;
  ledger_entry_id: string | null;
  status: string;
  document_amount: string | null;
  ledger_amount: string | null;
  variance: string | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}

async function loadDocumentSide(documentId: string): Promise<DocumentSideRow[]> {
  return (await query(
    `SELECT staging_row_id,
            truck_id,
            driver_id,
            to_char(accrual_date, 'YYYY-MM-DD') AS accrual_date,
            amount,
            quantity,
            unit_number,
            COALESCE(
              reviewed_payload ->> 'description',
              parsed_payload   ->> 'description',
              parsed_payload   ->> 'vendor'
            ) AS description
       FROM accounting.staging_row
      WHERE document_id = $1
        AND amount IS NOT NULL
        AND status <> 'rejected'
      ORDER BY row_index`,
    [documentId],
  )) as unknown as DocumentSideRow[];
}

/**
 * The ledger side: entries in the run's period, for the run's entity where
 * one could be established, excluding anything this very document posted.
 * Without that exclusion a committed document reconciles perfectly against
 * itself, which is the most convincing wrong answer this screen could give.
 */
async function loadLedgerSide(
  documentId: string,
  entityId: string | null,
  periodStart: string,
  periodEnd: string,
): Promise<LedgerSideRow[]> {
  const params: unknown[] = [documentId, periodStart, periodEnd];
  let entityClause = '';
  if (entityId !== null) {
    params.push(entityId);
    entityClause = `AND le.entity_id = $${params.length}`;
  }

  return (await query(
    `SELECT le.entry_id,
            le.truck_id,
            le.driver_id,
            to_char(le.accrual_date, 'YYYY-MM-DD') AS accrual_date,
            le.amount,
            le.quantity,
            le.unit_number,
            le.memo,
            le.category_id
       FROM accounting.ledger_entry le
       LEFT JOIN accounting.staging_row sr ON sr.staging_row_id = le.staging_row_id
      WHERE le.accrual_date BETWEEN $2::date AND $3::date
        AND (sr.document_id IS NULL OR sr.document_id <> $1)
        AND le.source_document_id IS DISTINCT FROM $1
        ${entityClause}
      ORDER BY le.accrual_date, le.entry_id`,
    params,
  )) as unknown as LedgerSideRow[];
}

function documentLine(r: DocumentSideRow, documentId: string): ReconLine {
  return {
    lineId: r.staging_row_id,
    side: 'document',
    sourceRef: {
      kind: 'document',
      documentId,
      stagingRowId: r.staging_row_id,
      label: r.unit_number !== null ? `Unit ${r.unit_number}` : 'Document line',
    },
    truckId: r.truck_id,
    driverId: r.driver_id,
    accrualDate: r.accrual_date,
    amount: r.amount ?? '0.00',
    quantity: r.quantity,
    description: r.description,
  };
}

function ledgerLine(r: LedgerSideRow): ReconLine {
  return {
    lineId: r.entry_id,
    side: 'ledger',
    sourceRef: {
      kind: 'ledger',
      entryId: r.entry_id,
      label: r.unit_number !== null ? `Unit ${r.unit_number} · ${r.category_id}` : r.category_id,
    },
    truckId: r.truck_id,
    driverId: r.driver_id,
    accrualDate: r.accrual_date,
    amount: r.amount,
    quantity: r.quantity,
    description: r.memo,
  };
}

/** `auto_matched` with a variance is the case a person has to look at; the
 *  database has no separate value for it and does not need one. */
function wireStatus(dbStatus: string, variance: string | null): ReconMatchStatus {
  if (dbStatus === 'auto_matched' && variance !== null && centsFromDecimal(variance) !== 0) {
    return 'near_match';
  }
  return dbStatus as ReconMatchStatus;
}

export interface ReconciliationResult {
  set: ReconciliationSet;
  summary: ReconSummary;
}

/**
 * Reads the reconciliation for a document, opening and populating one on
 * first read. Safe to call repeatedly: the run is unique per open document
 * and matches are only proposed for lines that do not already have a row.
 */
export async function getReconciliation(
  documentId: string,
  openedBy = 'system',
): Promise<ReconciliationResult | null> {
  const docRows = (await query(
    `SELECT file_name, parse_status FROM accounting.source_document WHERE document_id = $1`,
    [documentId],
  )) as unknown as { file_name: string; parse_status: string }[];
  const doc = docRows[0];
  if (!doc) return null;

  const documentSide = await loadDocumentSide(documentId);
  const run = await ensureRun(documentId, documentSide, openedBy);
  if (run === null) {
    throw new DocumentNotReconcilableError(
      `document ${documentId} has no parsed rows carrying both an amount and a date, so there is nothing to reconcile`,
    );
  }

  const ledgerSide = await loadLedgerSide(documentId, run.entityId, run.periodStart, run.periodEnd);
  await proposeMissingMatches(run.runId, documentSide, ledgerSide);

  const matchRows = (await query(
    `SELECT match_id, staging_row_id, ledger_entry_id, status,
            document_amount, ledger_amount, variance, decided_by,
            to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at,
            note
       FROM accounting.reconciliation_match
      WHERE run_id = $1
      ORDER BY created_at, match_id`,
    [run.runId],
  )) as unknown as MatchDbRow[];

  const docById = new Map(documentSide.map((r) => [r.staging_row_id, r]));
  const ledgerById = new Map(ledgerSide.map((r) => [r.entry_id, r]));

  const matches: ReconMatch[] = matchRows.map((m) => {
    const d = m.staging_row_id !== null ? docById.get(m.staging_row_id) : undefined;
    const l = m.ledger_entry_id !== null ? ledgerById.get(m.ledger_entry_id) : undefined;
    return {
      matchId: m.match_id,
      status: wireStatus(m.status, m.variance),
      documentLine: d ? documentLine(d, documentId) : null,
      ledgerLine: l ? ledgerLine(l) : null,
      amountVariance: m.variance,
      note: m.note,
      decidedBy: m.decided_by,
      decidedAt: m.decided_at,
    };
  });

  return {
    set: {
      reconciliationId: run.runId,
      documentId,
      documentLabel: doc.file_name,
      ledgerLabel: `Ledger · ${run.periodStart} to ${run.periodEnd}`,
      matches,
    },
    summary: summarize(matches),
  };
}

/* --------------------------------------------------------------------- */
/* Opening and proposing                                                  */
/* --------------------------------------------------------------------- */

interface RunInfo {
  runId: string;
  entityId: string | null;
  periodStart: string;
  periodEnd: string;
}

async function ensureRun(
  documentId: string,
  documentSide: readonly DocumentSideRow[],
  openedBy: string,
): Promise<RunInfo | null> {
  const existing = (await query(
    `SELECT run_id, entity_id,
            to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end,   'YYYY-MM-DD') AS period_end
       FROM accounting.reconciliation_run
      WHERE source_document_id = $1 AND closed_at IS NULL`,
    [documentId],
  )) as unknown as { run_id: string; entity_id: string | null; period_start: string; period_end: string }[];

  if (existing[0]) {
    const r = existing[0];
    return { runId: r.run_id, entityId: r.entity_id, periodStart: r.period_start, periodEnd: r.period_end };
  }

  const dates = documentSide.map((r) => r.accrual_date).filter((d): d is string => d !== null).sort();
  if (dates.length === 0) return null;

  // One entity, or none. A document spanning two carriers is reconciled
  // against every entity rather than being silently attributed to whichever
  // one happened to appear first.
  const entityRows = (await query(
    `SELECT DISTINCT entity_id FROM accounting.staging_row
      WHERE document_id = $1 AND entity_id IS NOT NULL`,
    [documentId],
  )) as unknown as { entity_id: string }[];
  const entityId = entityRows.length === 1 ? entityRows[0]!.entity_id : null;

  const inserted = (await query(
    `INSERT INTO accounting.reconciliation_run
       (source_document_id, entity_id, period_start, period_end, opened_by)
     VALUES ($1, $2, $3::date, $4::date, $5)
     ON CONFLICT (source_document_id) WHERE closed_at IS NULL DO NOTHING
     RETURNING run_id`,
    [documentId, entityId, dates[0], dates[dates.length - 1], openedBy],
  )) as unknown as { run_id: string }[];

  if (inserted[0]) {
    return { runId: inserted[0].run_id, entityId, periodStart: dates[0]!, periodEnd: dates[dates.length - 1]! };
  }
  // Lost the race; the other writer's run is the one that stands.
  return ensureRun(documentId, documentSide, openedBy);
}

function toCandidate(lineId: string, unit: string | null, date: string | null, amount: string): MatchCandidate {
  return {
    lineId,
    unitKey: normalizeUnitKey(unit),
    accrualDate: date,
    amountCents: centsFromDecimal(amount),
  };
}

/**
 * Proposes matches for lines that do not already have a row in this run.
 * A line a person has already decided on is never re-proposed, which is
 * what makes a second read of the screen show the same thing as the first.
 */
async function proposeMissingMatches(
  runId: string,
  documentSide: readonly DocumentSideRow[],
  ledgerSide: readonly LedgerSideRow[],
): Promise<void> {
  const taken = (await query(
    `SELECT staging_row_id, ledger_entry_id
       FROM accounting.reconciliation_match
      WHERE run_id = $1 AND status <> 'rejected'`,
    [runId],
  )) as unknown as { staging_row_id: string | null; ledger_entry_id: string | null }[];

  const takenDoc = new Set(taken.map((t) => t.staging_row_id).filter((v): v is string => v !== null));
  const takenLedger = new Set(taken.map((t) => t.ledger_entry_id).filter((v): v is string => v !== null));

  const freeDoc = documentSide.filter((r) => !takenDoc.has(r.staging_row_id));
  const freeLedger = ledgerSide.filter((r) => !takenLedger.has(r.entry_id));
  if (freeDoc.length === 0 && freeLedger.length === 0) return;

  const docAmount = new Map(freeDoc.map((r) => [r.staging_row_id, r.amount ?? '0.00']));
  const ledgerAmount = new Map(freeLedger.map((r) => [r.entry_id, r.amount]));

  const proposals = proposeMatches(
    freeDoc.map((r) => toCandidate(r.staging_row_id, r.unit_number, r.accrual_date, r.amount ?? '0.00')),
    freeLedger.map((r) => toCandidate(r.entry_id, r.unit_number, r.accrual_date, r.amount)),
  );

  for (const p of proposals) {
    const dAmt = p.documentLineId !== null ? (docAmount.get(p.documentLineId) ?? null) : null;
    const lAmt = p.ledgerLineId !== null ? (ledgerAmount.get(p.ledgerLineId) ?? null) : null;
    const isPair = p.documentLineId !== null && p.ledgerLineId !== null;

    // The CHECK insists the stored variance IS the difference, so it is
    // computed from the same two numbers being written, never typed.
    const variance = isPair
      ? decimalFromCents(centsFromDecimal(dAmt ?? '0.00') - centsFromDecimal(lAmt ?? '0.00'))
      : null;

    await query(
      `INSERT INTO accounting.reconciliation_match
         (run_id, staging_row_id, ledger_entry_id, status,
          document_amount, ledger_amount, variance)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [runId, p.documentLineId, p.ledgerLineId, isPair ? 'auto_matched' : 'unmatched', dAmt, lAmt, variance],
    );
  }
}

/* --------------------------------------------------------------------- */
/* Deciding                                                               */
/* --------------------------------------------------------------------- */

export type ReconDecisionAction =
  | { type: 'confirm' }
  | { type: 'reject' }
  | { type: 'expected_missing'; note: string };

const ACTION_STATUS: Record<ReconDecisionAction['type'], ReconDecisionStatus> = {
  confirm: 'confirmed',
  reject: 'rejected',
  expected_missing: 'expected_missing',
};

/**
 * Records one person's decision about one match row and returns the whole
 * set, because rejecting changes the row count and a partial response would
 * leave the screen disagreeing with the database.
 */
export async function recordReconDecision(
  documentId: string,
  matchId: string,
  action: ReconDecisionAction,
  decidedBy: string,
): Promise<ReconciliationResult> {
  const rows = (await query(
    `SELECT m.match_id, m.run_id, m.staging_row_id, m.ledger_entry_id,
            m.document_amount, m.ledger_amount, m.status
       FROM accounting.reconciliation_match m
       JOIN accounting.reconciliation_run r ON r.run_id = m.run_id
      WHERE m.match_id = $1 AND r.source_document_id = $2`,
    [matchId, documentId],
  )) as unknown as {
    match_id: string;
    run_id: string;
    staging_row_id: string | null;
    ledger_entry_id: string | null;
    document_amount: string | null;
    ledger_amount: string | null;
    status: string;
  }[];

  const row = rows[0];
  if (!row) throw new MatchNotFoundError(matchId);

  const status = ACTION_STATUS[action.type];
  const note = action.type === 'expected_missing' ? action.note : null;

  await query(
    `UPDATE accounting.reconciliation_match
        SET status = $2, decided_by = $3, decided_at = now(),
            note = COALESCE($4, note)
      WHERE match_id = $1`,
    [matchId, status, decidedBy, note],
  );

  // A rejected pairing keeps its row as the audit trail and stops holding
  // either side's slot, so each line gets a fresh row of its own to carry
  // whatever is decided about it next.
  if (action.type === 'reject') {
    if (row.staging_row_id !== null) {
      await query(
        `INSERT INTO accounting.reconciliation_match
           (run_id, staging_row_id, status, document_amount)
         VALUES ($1, $2, 'unmatched', $3)`,
        [row.run_id, row.staging_row_id, row.document_amount],
      );
    }
    if (row.ledger_entry_id !== null) {
      await query(
        `INSERT INTO accounting.reconciliation_match
           (run_id, ledger_entry_id, status, ledger_amount)
         VALUES ($1, $2, 'unmatched', $3)`,
        [row.run_id, row.ledger_entry_id, row.ledger_amount],
      );
    }
  }

  const result = await getReconciliation(documentId, decidedBy);
  if (result === null) throw new MatchNotFoundError(matchId);
  return result;
}

/* --------------------------------------------------------------------- */
/* Summary                                                                */
/* --------------------------------------------------------------------- */

/**
 * `netVariance` is what somebody still has to account for: the variance on
 * every open pairing, plus the full amount of every unmatched line on either
 * side. Confirmed pairings and expected-missing lines are settled and drop
 * out — counting them would make a finished reconciliation look unfinished.
 */
export function summarize(matches: readonly ReconMatch[]): ReconSummary {
  const summary: ReconSummary = {
    autoMatched: 0,
    nearMatch: 0,
    confirmed: 0,
    unmatchedDocument: 0,
    unmatchedLedger: 0,
    expectedMissing: 0,
    rejected: 0,
    netVariance: '0.00',
  };

  let outstandingCents = 0;

  for (const m of matches) {
    switch (m.status) {
      case 'auto_matched':
        summary.autoMatched += 1;
        break;
      case 'near_match':
        summary.nearMatch += 1;
        outstandingCents += m.amountVariance !== null ? centsFromDecimal(m.amountVariance) : 0;
        break;
      case 'confirmed':
        summary.confirmed += 1;
        break;
      case 'expected_missing':
        summary.expectedMissing += 1;
        break;
      case 'rejected':
        summary.rejected += 1;
        break;
      case 'unmatched':
        if (m.documentLine !== null) {
          summary.unmatchedDocument += 1;
          outstandingCents += centsFromDecimal(m.documentLine.amount);
        } else if (m.ledgerLine !== null) {
          summary.unmatchedLedger += 1;
          outstandingCents -= centsFromDecimal(m.ledgerLine.amount);
        }
        break;
    }
  }

  summary.netVariance = decimalFromCents(outstandingCents) as Decimal;
  return summary;
}
