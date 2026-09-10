/**
 * Pure review-queue logic, kept separate from any React/DOM code so it can
 * be unit-tested directly (this repo's vitest config runs under `node`,
 * with no DOM available) and so the review table, the commit-gate banner
 * and the mock API can all share one definition of "blocked" and one
 * definition of "edit".
 */

import type { Decimal, StagingRow } from '@/contract/types';
import type { StagingRowEdit } from '../data/types';

/** The four fields commit requires, per the task brief. Note `truckId` and
 *  `driverId` are deliberately excluded — an entity-level cost (e.g. an IRP
 *  fee) can be real with no truck or driver attached. */
export const REQUIRED_FIELDS = ['entityId', 'accrualDate', 'categoryId', 'amount'] as const;
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

export const REQUIRED_FIELD_LABEL: Record<RequiredField, string> = {
  entityId: 'entity',
  accrualDate: 'date',
  categoryId: 'category',
  amount: 'amount',
};

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Every required field this row is currently missing. Reads the row's
 *  live (possibly human-edited) normalized columns — not `parsedPayload`,
 *  which never changes and is not the commit gate. */
export function missingFields(row: Pick<StagingRow, RequiredField>): RequiredField[] {
  return REQUIRED_FIELDS.filter((f) => isEmpty(row[f]));
}

/** A one-line, field-specific reason a row cannot commit — "Missing
 *  category", not a red border with no explanation. Empty when the row has
 *  everything commit requires. */
export function blockedReason(row: Pick<StagingRow, RequiredField>): string | null {
  const missing = missingFields(row);
  if (missing.length === 0) return null;
  return `Missing ${missing.map((f) => REQUIRED_FIELD_LABEL[f]).join(', ')}`;
}

export function isBlocked(row: Pick<StagingRow, RequiredField>): boolean {
  return missingFields(row).length > 0;
}

export interface CommitSummary {
  /** Rows that will post if commit is pressed now. */
  willCommit: number;
  /** Rows missing a required field — commit is blocked until these clear. */
  blocked: number;
  /** Rows the operator excluded from this document (status 'rejected'). */
  excluded: number;
  /** Rows already posted by a previous commit. */
  alreadyCommitted: number;
  total: number;
}

/** What pressing Commit would do right now, and whether it's even allowed.
 *  `canCommit` is false whenever any row is blocked — the task requires
 *  commit to stay disabled until every blocking row is resolved, not merely
 *  to skip the offending rows. */
export function summarizeCommit(rows: readonly StagingRow[]): CommitSummary & { canCommit: boolean } {
  let willCommit = 0;
  let blocked = 0;
  let excluded = 0;
  let alreadyCommitted = 0;
  for (const row of rows) {
    if (row.status === 'committed') {
      alreadyCommitted += 1;
      continue;
    }
    if (row.status === 'rejected') {
      excluded += 1;
      continue;
    }
    if (isBlocked(row)) {
      blocked += 1;
      continue;
    }
    willCommit += 1;
  }
  return {
    willCommit,
    blocked,
    excluded,
    alreadyCommitted,
    total: rows.length,
    canCommit: blocked === 0 && willCommit > 0,
  };
}

/**
 * Applies a human edit to a staging row. This is the one and only place an
 * edit is allowed to touch a row, and the contract it upholds is the one
 * CLAUDE.md calls the audit trail:
 *
 *  - `parsedPayload` is never touched — same object reference back out.
 *  - `reviewedPayload` accumulates the edited *fields only* (a sparse
 *    overlay), so it always answers "what did a human actually change" —
 *    a full re-snapshot would blur that back into "what does the row say
 *    now", which `parsedPayload` + the normalized columns already answer.
 *  - The normalized columns (`entityId`, `amount`, ...) update immediately,
 *    because those are what `missingFields`/commit read.
 *  - `status` moves off `'parsed'` to `'under_review'` the first time a row
 *    is touched, unless it's already past review (`committed`/`rejected`),
 *    which an edit must never silently reopen.
 */
export function applyEdit(row: StagingRow, edit: Partial<StagingRowEdit>): StagingRow {
  const nextStatus =
    row.status === 'committed' || row.status === 'rejected' ? row.status : 'under_review';
  return {
    ...row,
    ...edit,
    parsedPayload: row.parsedPayload, // explicit: never overwritten by an edit
    reviewedPayload: { ...(row.reviewedPayload ?? {}), ...edit },
    status: nextStatus,
  };
}

/** Formats a raw parsed value (from `parsedPayload`) for the "machine read"
 *  column — payload values are `unknown`, so this never assumes a shape,
 *  it just renders whatever is there or a placeholder if the parser never
 *  captured that field at all. */
export function formatParsedValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(not captured)';
  return String(value);
}

/** True when a field's live value differs from what the parser originally
 *  read for it — the visible marker that a human corrected this cell. */
export function wasEdited(row: StagingRow, field: keyof StagingRowEdit): boolean {
  return row.reviewedPayload != null && Object.prototype.hasOwnProperty.call(row.reviewedPayload, field);
}

export type { Decimal };
