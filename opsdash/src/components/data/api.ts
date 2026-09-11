/**
 * The single import point every screen/component uses to talk to the API.
 *
 * Toggle between the real API (`httpApi.ts`) and the in-memory mock
 * (`mockApi.ts`) with `NEXT_PUBLIC_USE_MOCK_API=true` — worth keeping for
 * local development when no database is running. It defaults OFF: the
 * routes in `docs/DATA-CONTRACT.md` §6 are live now (documents, staging,
 * commit, reference, registration/overhead), so talking to them is the
 * default from here on, not an opt-in.
 *
 * Reconciliation and chargeback have **no live endpoint yet** (no
 * `GET/POST /api/reconciliation*` or `/api/chargeback*` route exists —
 * `data/types.ts` notes 6 and 7 explain why). Those two functions stay on
 * the mock unconditionally, independent of `NEXT_PUBLIC_USE_MOCK_API`.
 * `dataSource` below says so explicitly so the two screens that use them can
 * render a visible "sample data" notice instead of ever letting an operator
 * mistake a fixture for their real numbers.
 *
 * That is landing next, on these confirmed shapes (per the API workstream,
 * not invented here):
 *   `GET  /api/reconciliation/:documentId -> { set: ReconciliationSet, summary: ReconSummary }`
 *   `POST /api/reconciliation/:documentId/matches/:matchId` body
 *        `{ status, note?, decidedBy } -> { match: ReconMatch }`
 *   `GET  /api/chargeback ?status&entityId&from&to -> { rows: ChargebackRow[] }`
 *   `POST /api/chargeback` body `{ costRowIds: string[], decision: ChargebackDecision }
 *        -> { rows: ChargebackRow[] }`
 * `ReconLine`/`ReconMatch`/`ReconMatchStatus`/`ReconSummary`/`ReconciliationSet`/
 * `ChargedTo`/`SplitRatio`/`ChargebackDecision`/`ChargebackRow` are being promoted
 * into `@/contract/types` unchanged in shape, so `data/types.ts` will re-export
 * them the way it already does for `ParseStatus`/`DocumentSummary` rather than
 * this workstream redefining `src/contract/types.ts` itself. `near_match` has no
 * DB enum value (it's derived: `auto_matched` with a non-zero variance) but the
 * route still returns the string `'near_match'`, so nothing on this side changes
 * once wired. Not switched on yet — wiring `getReconciliation`/`postReconDecision`/
 * `getChargebackQueue`/`postChargebackDecision`/`postBulkChargebackDecision` to
 * `http.ts` equivalents is the one-line-per-function change this seam exists for,
 * done once those routes are in and passing.
 */
import * as http from './httpApi';
import * as mock from './mockApi';

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK_API === 'true';

export type DataSourceKind = 'live' | 'mock';

/** What each screen is actually reading from right now. Read this rather
 *  than re-deriving it, so a screen's "sample data" banner and the actual
 *  wiring can never drift apart. */
export const dataSource: {
  documents: DataSourceKind;
  reconciliation: DataSourceKind;
  chargeback: DataSourceKind;
} = {
  documents: USE_MOCK ? 'mock' : 'live',
  reconciliation: 'mock',
  chargeback: 'mock',
};

export const listDocuments = USE_MOCK ? mock.listDocuments : http.listDocuments;
export const getDocument = USE_MOCK ? mock.getDocument : http.getDocument;
export const getStagingRows = USE_MOCK ? mock.getStagingRows : http.getStagingRows;
export const patchStagingRow = USE_MOCK ? mock.patchStagingRow : http.patchStagingRow;
export const commitDocument = USE_MOCK ? mock.commitDocument : http.commitDocument;
export const uploadDocument = USE_MOCK ? mock.uploadDocument : http.uploadDocument;
export const getReferenceData = USE_MOCK ? mock.getReferenceData : http.getReferenceData;
export const getOverheadRates = USE_MOCK ? mock.getOverheadRates : http.getOverheadRates;

// Always the mock — see the file doc comment above and `dataSource`.
export const getReconciliation = mock.getReconciliation;
export const postReconDecision = mock.postReconDecision;
export const getChargebackQueue = mock.getChargebackQueue;
export const postChargebackDecision = mock.postChargebackDecision;
export const postBulkChargebackDecision = mock.postBulkChargebackDecision;
export type { ReconDecisionAction } from './mockApi';

export { ApiError } from './httpApi';
export type { Decimal } from './types';
