/**
 * The P&L service: one load, one set of rollups, one work-queue summary.
 *
 * The rollup engine is pure and does no I/O; `loadSummaryEntries` is the
 * query that feeds it. This is the thin layer between them, and it exists
 * mostly to hold one decision: **the same loaded rows produce the answer
 * and the caveats.**
 *
 * A P&L screen that shows a margin without showing how many cost rows
 * nobody has assigned to company or driver yet is not showing a margin, it
 * is showing a lower bound wearing a margin's clothes. `workQueue` comes
 * off the identical row set, in the identical period, so the two can never
 * describe different data.
 */
import type { Grain, IsoDate } from '@/contract/types';
import { query } from '@/db/pool';
import {
  type EntityPnlResult,
  type GroupPnlResult,
  type SummaryLedgerEntry,
  type TruckPnlResult,
  type WorkQueueSummary,
  buildWorkQueueSummary,
  periodsCovering,
  summarizeEntity,
  summarizeGroup,
  summarizeTruck,
} from '@/engines/summary';
import { loadSummaryEntries } from './summaryEntries';

export class PnlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PnlRequestError';
  }
}

export type PnlScope = 'group' | 'entity' | 'truck';

export interface PnlRequest {
  from: IsoDate;
  to: IsoDate;
  /** Omitted means one bucket covering the whole range. Given, it means a
   *  series — and `periodsCovering` clamps every bucket to the range, so a
   *  weekly series for a calendar year cannot reach into the neighbouring
   *  years and the parts still sum to the whole. */
  grain?: Grain;
  scope: PnlScope;
  entityId?: string;
  truckId?: string;
}

export interface PnlResponse {
  scope: PnlScope;
  from: IsoDate;
  to: IsoDate;
  grain: Grain | null;
  entityId: string | null;
  truckId: string | null;
  results: (GroupPnlResult | EntityPnlResult | TruckPnlResult)[];
  /** Computed over the same rows, in the same period, as `results` — what
   *  the totals above are still missing and why. */
  workQueue: WorkQueueSummary;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertRequest(req: PnlRequest): void {
  if (!ISO_DATE.test(req.from) || !ISO_DATE.test(req.to)) {
    throw new PnlRequestError('from and to must both be YYYY-MM-DD dates');
  }
  if (req.to < req.from) {
    throw new PnlRequestError(`to (${req.to}) is before from (${req.from})`);
  }
  if (req.scope === 'entity' && !req.entityId) {
    throw new PnlRequestError('an entity P&L needs an entityId');
  }
  if (req.scope === 'truck' && !req.truckId) {
    throw new PnlRequestError('a truck P&L needs a truckId');
  }
}

async function listEntityIds(): Promise<string[]> {
  const rows = (await query(
    `SELECT entity_id FROM accounting.entity ORDER BY code`,
  )) as unknown as { entity_id: string }[];
  return rows.map((r) => r.entity_id);
}

export async function getPnl(req: PnlRequest): Promise<PnlResponse> {
  assertRequest(req);

  // A group roll-up must see every entity's rows, because eliminating the
  // intercompany legs requires both halves. Narrowing the load to one
  // entity would leave a receivable with no matching payable and the
  // elimination would silently under-count.
  const entries = await loadSummaryEntries({
    from: req.from,
    to: req.to,
    ...(req.scope === 'group' ? {} : { entityId: req.entityId, truckId: req.truckId }),
  });

  const periods =
    req.grain === undefined
      ? [{ periodStart: req.from, periodEnd: req.to }]
      : periodsCovering(req.grain, req.from, req.to);

  let results: PnlResponse['results'];
  if (req.scope === 'truck') {
    results = periods.map((p) => summarizeTruck(entries, req.truckId!, p));
  } else if (req.scope === 'entity') {
    results = periods.map((p) => summarizeEntity(entries, req.entityId!, p));
  } else {
    const entityIds = await listEntityIds();
    results = periods.map((p) => summarizeGroup(entries, entityIds, p));
  }

  return {
    scope: req.scope,
    from: req.from,
    to: req.to,
    grain: req.grain ?? null,
    entityId: req.entityId ?? null,
    truckId: req.truckId ?? null,
    results,
    workQueue: buildWorkQueueSummary(entries as SummaryLedgerEntry[]),
  };
}
