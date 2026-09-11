/**
 * Real `fetch()` client against the live routes in `docs/DATA-CONTRACT.md`
 * §6. This is the module `api.ts` switches to once `USE_MOCK` is off.
 *
 * Money crosses this boundary exactly as the server sent it — every
 * function here returns the parsed JSON body's decimal *strings* untouched.
 * Nothing in this file calls `Number()` or `parseFloat` on a money field;
 * `fetchJson` itself never inspects the payload beyond `JSON.parse`.
 */
import type { PnlResponse } from '@/db/repo/pnl';
import type { ManualEntryInput } from '@/db/repo/manualEntry';
import type { SetStatusInput } from '@/db/repo/truckStatus';
import type { RegisterInput, SheetSourceRecord, SyncResult } from '@/db/repo/sheetSource';
import type { IftaReturnView } from '@/db/repo/ifta';
import type { DashboardResponse } from '@/db/repo/dashboard';
import type { CeoResponse } from '@/db/repo/ceo';
import type {
  LedgerEntry,
  ManualAttestation,
  TruckStatusNow,
  ChargebackDecision,
  ChargebackRow,
  ReconMatch,
  ReconSummary,
  ReconciliationSet,
  StagingRow,
} from '@/contract/types';
import type { TruckOverheadRate } from '@/engines/registration/types';
import type {
  CommitResult,
  Decimal,
  DocumentStatus,
  DocumentSummary,
  ReferenceData,
  StagingRowEdit,
  UploadInput,
  UploadResult,
  IftaRatesResponse,
} from './types';

/**
 * Thrown for both network-level failures (the request never got a response
 * — `status` is `null`) and non-2xx responses (`status` is the HTTP code).
 * Callers that need to tell "not found" apart from "unreachable" check
 * `status`; everyone else just shows `.message`, which is always something
 * an operator can act on, never a raw stack trace.
 */
export class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch {
    // fetch() itself threw: DNS failure, connection refused, offline, CORS —
    // there is no response to read a status or body from at all.
    throw new ApiError('Could not reach the server. Check your connection and try again.', null);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No body, or not JSON. `body` stays null; handled below per status.
  }

  if (!res.ok) {
    const message =
      body != null && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Server returned ${res.status} ${res.statusText || ''}`.trim();
    throw new ApiError(message, res.status);
  }

  return body as T;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const body = await fetchJson<{ documents: DocumentSummary[] }>('/api/documents');
  return body.documents;
}

/** `null` when the document does not exist — same "not found" contract the
 *  mock upholds, so callers do not need to special-case which client they
 *  are talking to. Any other failure (network, 5xx) is thrown, not
 *  swallowed into `null`, because "unreachable" and "does not exist" are
 *  not the same fact. */
export async function getDocument(documentId: string): Promise<DocumentStatus | null> {
  try {
    return await fetchJson<DocumentStatus>(`/api/documents/${encodeURIComponent(documentId)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function getStagingRows(documentId: string): Promise<StagingRow[]> {
  const body = await fetchJson<{ rows: StagingRow[] }>(`/api/documents/${encodeURIComponent(documentId)}/rows`);
  return body.rows;
}

/** `null` when the row does not exist, mirroring the mock. A validation
 *  (422) or immutability (409) failure is a real error the review table
 *  must show inline — those are thrown, not folded into `null`. */
export async function patchStagingRow(rowId: string, edit: Partial<StagingRowEdit>): Promise<StagingRow | null> {
  try {
    const body = await fetchJson<{ row: StagingRow }>(`/api/staging/${encodeURIComponent(rowId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edit),
    });
    return body.row;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * All-or-nothing per document (server-enforced by a transaction) and
 * idempotent (server-enforced by `ux_ledger_staging_once`). A thrown
 * `ApiError` here means the transaction rolled back — nothing was written —
 * which is exactly what the review screen tells the operator, so pressing
 * Commit again after an error is always safe.
 */
export async function commitDocument(documentId: string): Promise<CommitResult> {
  return fetchJson<CommitResult>(`/api/documents/${encodeURIComponent(documentId)}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Multipart upload of the actual bytes, per DATA-CONTRACT.md §6's
 *  `POST /api/documents`. `docType` is required server-side; the upload
 *  screen collects it (defaulting to a filename guess the operator can
 *  override) rather than this module inventing one. */
export async function uploadDocument(input: UploadInput): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', input.file, input.file.name);
  form.append('docType', input.docType);
  if (input.uploadedBy) form.append('uploadedBy', input.uploadedBy);

  const body = await fetchJson<{ documentId: string; sha256: string; duplicateOf?: string }>('/api/documents', {
    method: 'POST',
    body: form,
  });
  return { documentId: body.documentId, sha256: body.sha256, duplicateOf: body.duplicateOf ?? null };
}

export async function getReferenceData(): Promise<ReferenceData> {
  return fetchJson<ReferenceData>('/api/reference');
}

export async function getOverheadRates(): Promise<TruckOverheadRate[]> {
  const body = await fetchJson<{ rates: TruckOverheadRate[] }>('/api/registration/overhead');
  return body.rates;
}

/* ------------------------------------------------------------------------
 * Reconciliation.
 *
 * A GET here opens the run if the document has none — idempotent, and the
 * server's business, not this module's. `near_match` arrives as a string
 * like any other status; it is derived server-side from a stored
 * `auto_matched` plus a non-zero variance and there is nothing to compute
 * on this side.
 * --------------------------------------------------------------------- */

export async function getReconciliation(documentId: string): Promise<ReconciliationSet | null> {
  try {
    const body = await fetchJson<{ set: ReconciliationSet; summary: ReconSummary }>(
      `/api/reconciliation/${encodeURIComponent(documentId)}`,
    );
    return body.set;
  } catch (err) {
    // 404: no such document. 422: the document exists but carries nothing
    // reconcilable yet. Both are "nothing to show", not "something broke".
    if (err instanceof ApiError && (err.status === 404 || err.status === 422)) return null;
    throw err;
  }
}

export type ReconDecisionAction =
  | { type: 'confirm' }
  | { type: 'reject' }
  | { type: 'expected_missing'; note: string };

/** Returns the whole set, because rejecting a pairing splits it into two
 *  singletons and a one-row response would leave the screen disagreeing
 *  with the database. */
export async function postReconDecision(
  documentId: string,
  matchId: string,
  action: ReconDecisionAction,
  decidedBy: string,
): Promise<ReconMatch[]> {
  const body = await fetchJson<{ set: ReconciliationSet; summary: ReconSummary }>(
    `/api/reconciliation/${encodeURIComponent(documentId)}/matches/${encodeURIComponent(matchId)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, decidedBy }),
    },
  );
  return body.set.matches;
}

/* ------------------------------------------------------------------------
 * Chargeback.
 * --------------------------------------------------------------------- */

export async function getChargebackQueue(): Promise<ChargebackRow[]> {
  const body = await fetchJson<{ rows: ChargebackRow[] }>('/api/chargeback?status=open');
  return body.rows;
}

export async function postChargebackDecision(
  costRowId: string,
  decision: ChargebackDecision,
): Promise<ChargebackRow> {
  const rows = await postBulkChargebackDecision([costRowId], decision);
  const row = rows[0];
  if (!row) throw new ApiError(`The server accepted the decision but returned no row for ${costRowId}.`, null);
  return row;
}

/** Applies one decision to exactly the named rows. The server makes that
 *  guarantee; this function's only job is not to weaken it by sending ids
 *  the caller did not pass. */
export async function postBulkChargebackDecision(
  costRowIds: string[],
  decision: ChargebackDecision,
): Promise<ChargebackRow[]> {
  const body = await fetchJson<{ rows: ChargebackRow[] }>('/api/chargeback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ costRowIds, decision }),
  });
  return body.rows;
}

/* ------------------------------------------------------------------------
 * P&L.
 *
 * Returns the rollup engine's own result shapes rather than the flat
 * `PnlLine[]` DATA-CONTRACT.md §6 originally specified — see the route's
 * doc comment for why flattening would have hidden the driver-borne
 * receivable, the allocated-vs-measured distinction and the stripped
 * balance-sheet rows. `workQueue` travels with the totals because it is
 * computed over the same rows in the same period.
 * --------------------------------------------------------------------- */

export interface PnlQuery {
  from: string;
  to: string;
  /** Omit for one bucket covering the whole range; give it for a series. */
  grain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  scope?: 'group' | 'entity' | 'truck';
  entityId?: string;
  truckId?: string;
}

export async function getPnl(q: PnlQuery): Promise<PnlResponse> {
  const params = new URLSearchParams({ from: q.from, to: q.to });
  if (q.grain) params.set('grain', q.grain);
  if (q.scope) params.set('scope', q.scope);
  if (q.entityId) params.set('entityId', q.entityId);
  if (q.truckId) params.set('truckId', q.truckId);
  return fetchJson<PnlResponse>(`/api/pnl?${params.toString()}`);
}

/* ------------------------------------------------------------------------
 * Manual entry — the second intake path.
 * --------------------------------------------------------------------- */

export async function postManualEntry(
  input: ManualEntryInput,
): Promise<{ entry: LedgerEntry; attestation: ManualAttestation }> {
  return fetchJson('/api/manual', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** Not an edit: the server posts a reversing entry plus a replacement, and
 *  all three stay on the books. */
export async function postCorrection(
  entryId: string,
  input: { amount: string; memo?: string | null; correctedBy: string; basis: string },
): Promise<{ reversal: LedgerEntry; replacement: LedgerEntry }> {
  return fetchJson(`/api/entries/${encodeURIComponent(entryId)}/correct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/* ------------------------------------------------------------------------
 * Truck status — the fleet board's source.
 * --------------------------------------------------------------------- */

export async function getTruckStatus(): Promise<{
  statuses: TruckStatusNow[];
  counts: Record<string, number>;
}> {
  return fetchJson('/api/truck-status');
}

export async function postTruckStatus(
  input: SetStatusInput,
): Promise<{ previous: string | null; current: string; effectiveFrom: string }> {
  return fetchJson('/api/truck-status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/* ------------------------------------------------------------------------
 * Sheet sources — the third intake path.
 *
 * A 409 from the sync route means the sheet's columns moved. `fetchJson`
 * turns it into an ApiError carrying the server's sentence, which names
 * what changed; the screen keys its re-baseline affordance off that.
 * --------------------------------------------------------------------- */

export async function getSheetSources(): Promise<{ sources: SheetSourceRecord[] }> {
  return fetchJson('/api/sheet-sources');
}

export async function postSheetSource(input: RegisterInput): Promise<{ source: SheetSourceRecord }> {
  return fetchJson('/api/sheet-sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function postSheetSync(
  sheetSourceId: string,
  rawText: string,
  uploadedBy?: string,
): Promise<SyncResult> {
  return fetchJson(`/api/sheet-sources/${encodeURIComponent(sheetSourceId)}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawText, uploadedBy }),
  });
}

export async function postRebaseline(
  sheetSourceId: string,
  rawText: string,
  confirmedBy: string,
): Promise<{ source: SheetSourceRecord }> {
  return fetchJson(`/api/sheet-sources/${encodeURIComponent(sheetSourceId)}/rebaseline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawText, confirmedBy }),
  });
}

/* ------------------------------------------------------------------------
 * IFTA — the fifth screen's data, and the one whose GET deliberately
 * returns 200 with a `blocked` reason rather than an error status when an
 * input has not arrived. A missing fuel file is not a failed request.
 * --------------------------------------------------------------------- */

export async function getIftaReturn(q: {
  from: string;
  to: string;
  entityId?: string;
}): Promise<IftaReturnView> {
  const params = new URLSearchParams({ from: q.from, to: q.to });
  if (q.entityId) params.set('entityId', q.entityId);
  return fetchJson<IftaReturnView>(`/api/ifta?${params.toString()}`);
}

export async function saveIftaReturn(input: {
  from: string;
  to: string;
  entityId: string;
  savedBy: string;
}): Promise<{ calcRunId: string; lineCount: number }> {
  return fetchJson('/api/ifta', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function getIftaRates(year: number, quarter: number): Promise<IftaRatesResponse> {
  return fetchJson<IftaRatesResponse>(`/api/ifta/rates?year=${year}&quarter=${quarter}`);
}

export async function postIftaRate(input: {
  jurisdiction: string;
  year: number;
  quarter: number;
  ratePerGallon: string;
  surchargePerGallon?: string;
  sourceNote: string;
  enteredBy: string;
}): Promise<IftaRatesResponse> {
  return fetchJson('/api/ifta/rates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function getDashboard(q: { from?: string; to?: string } = {}): Promise<DashboardResponse> {
  const params = new URLSearchParams();
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  const qs = params.toString();
  return fetchJson<DashboardResponse>(`/api/dashboard${qs ? `?${qs}` : ''}`);
}

export async function getCeoView(q: { from?: string; to?: string } = {}): Promise<CeoResponse> {
  const params = new URLSearchParams();
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  const qs = params.toString();
  return fetchJson<CeoResponse>(`/api/ceo${qs ? `?${qs}` : ''}`);
}

export type { Decimal };
