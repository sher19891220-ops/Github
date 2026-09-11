/**
 * Real `fetch()` client against the live routes in `docs/DATA-CONTRACT.md`
 * §6. This is the module `api.ts` switches to once `USE_MOCK` is off.
 *
 * Money crosses this boundary exactly as the server sent it — every
 * function here returns the parsed JSON body's decimal *strings* untouched.
 * Nothing in this file calls `Number()` or `parseFloat` on a money field;
 * `fetchJson` itself never inspects the payload beyond `JSON.parse`.
 */
import type {
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

export type { Decimal };
