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
 * Every screen is live. Reconciliation and chargeback were the last two on
 * the mock; their routes (`/api/reconciliation/:documentId`, its
 * `matches/:matchId` POST, and `/api/chargeback`) landed with the pairing
 * rule under unit test and the persistence under integration test, so the
 * seam this file exists for did its job: one line per function, no
 * component changed.
 *
 * Two shapes worth knowing when reading the screens: `near_match` is a
 * status the server returns but never stores — it is `auto_matched` with a
 * non-zero variance — and a reconciliation decision returns the whole match
 * list rather than one row, because rejecting a pairing splits it into two
 * singletons.
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
  reconciliation: USE_MOCK ? 'mock' : 'live',
  chargeback: USE_MOCK ? 'mock' : 'live',
};

export const listDocuments = USE_MOCK ? mock.listDocuments : http.listDocuments;
export const getDocument = USE_MOCK ? mock.getDocument : http.getDocument;
export const getStagingRows = USE_MOCK ? mock.getStagingRows : http.getStagingRows;
export const patchStagingRow = USE_MOCK ? mock.patchStagingRow : http.patchStagingRow;
export const commitDocument = USE_MOCK ? mock.commitDocument : http.commitDocument;
export const uploadDocument = USE_MOCK ? mock.uploadDocument : http.uploadDocument;
export const getReferenceData = USE_MOCK ? mock.getReferenceData : http.getReferenceData;
export const getOverheadRates = USE_MOCK ? mock.getOverheadRates : http.getOverheadRates;

// Live only: there is no mock P&L, and inventing one would put a plausible
// margin on screen that traces to nothing.
export const getPnl = http.getPnl;

// Live only. There is no mock for these: a fabricated manual entry or a
// fabricated truck status would be exactly the invented data the rest of
// this build refuses to render.
export const postManualEntry = http.postManualEntry;
export const postCorrection = http.postCorrection;
export const getTruckStatus = http.getTruckStatus;
export const postTruckStatus = http.postTruckStatus;
// The landing screen. Live only: a fabricated headline figure is the
// worst possible thing to put on the first screen read every morning.
export const getDashboard = http.getDashboard;

// The CEO roll-up. Live only, and its forecast is a separate field from
// its actuals all the way to the screen.
export const getCeoView = http.getCeoView;

// Live only. An IFTA figure that traces to nothing is the exact thing
// this engine was built to refuse; a mock one would be that, on screen.
export const getIftaReturn = http.getIftaReturn;
export const saveIftaReturn = http.saveIftaReturn;
export const getIftaRates = http.getIftaRates;
export const postIftaRate = http.postIftaRate;

export const getSheetSources = http.getSheetSources;
export const postSheetSource = http.postSheetSource;
export const postSheetSync = http.postSheetSync;
export const postRebaseline = http.postRebaseline;
export type { PnlQuery } from './httpApi';

export const getReconciliation = USE_MOCK ? mock.getReconciliation : http.getReconciliation;
export const postReconDecision = USE_MOCK ? mock.postReconDecision : http.postReconDecision;
export const getChargebackQueue = USE_MOCK ? mock.getChargebackQueue : http.getChargebackQueue;
export const postChargebackDecision = USE_MOCK ? mock.postChargebackDecision : http.postChargebackDecision;
export const postBulkChargebackDecision = USE_MOCK
  ? mock.postBulkChargebackDecision
  : http.postBulkChargebackDecision;
export type { ReconDecisionAction } from './mockApi';

export { ApiError } from './httpApi';
export type { Decimal } from './types';
