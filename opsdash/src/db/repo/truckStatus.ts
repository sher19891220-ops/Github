/**
 * Truck status — the fleet board's missing source.
 *
 * `FLEET-BOARD-SPEC.md` §6 asked where status lives and rendered those
 * panels as *no data* rather than inferring them from dispatch lane text.
 * That restraint was right: 28 cells carrying `SHOP`, `HOME` or `OOS` also
 * carry real revenue, measured against the real sheet. Status comes from a
 * maintained source or it is unknown.
 *
 * The one thing this module has to get right is that **marking a new status
 * ends the previous one.** The exclusion constraint will reject an
 * overlapping span outright, so a naive insert fails the moment a truck has
 * any history at all — and the failure a person would see is a Postgres
 * constraint name rather than "this truck is already marked in the shop".
 * Closing the open span and opening the new one is one act, in one
 * transaction.
 */
import type { IsoDate, StatusSource, TruckStatus, TruckStatusNow } from '@/contract/types';
import { query, withTransaction } from '@/db/pool';

export class TruckStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TruckStatusError';
  }
}

export interface SetStatusInput {
  truckId: string;
  status: TruckStatus;
  /** When this state began. Defaults to now; back-dating is allowed
   *  because a person often marks a truck after the fact. */
  effectiveFrom?: string;
  source: StatusSource;
  /** Required for `manual`: who says so, and on what basis. */
  assertedBy?: string;
  basis?: string;
  /** Required for `samsara` / `motive` / `sheet`: the pull this came from. */
  connectorPullId?: string;
  note?: string | null;
}

const VALID: readonly TruckStatus[] = [
  'assigned', 'open', 'shop', 'broken_down', 'home', 'out_of_service',
];

/**
 * Records what a truck is doing now, ending whatever it was doing before.
 *
 * Returns the closed span's status where there was one, so a caller can say
 * "shop → assigned" rather than just "assigned" — which is what makes a
 * status change readable on a board.
 */
export async function setTruckStatus(
  input: SetStatusInput,
): Promise<{ previous: TruckStatus | null; current: TruckStatus; effectiveFrom: string }> {
  if (!VALID.includes(input.status)) {
    throw new TruckStatusError(`Unknown status ${JSON.stringify(input.status)}.`);
  }
  if (input.source === 'manual') {
    if (!input.assertedBy?.trim()) {
      throw new TruckStatusError('Marking a status by hand names who marked it.');
    }
    if (!input.basis?.trim()) {
      throw new TruckStatusError(
        'Say what this is based on — "driver called in", "shop confirmed". A status with no stated basis is a guess with a name attached.',
      );
    }
  } else if (!input.connectorPullId) {
    throw new TruckStatusError(
      `A ${input.source} status names the pull it came from, the same way a ledger entry names its document.`,
    );
  }

  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();

  return withTransaction(async (q) => {
    const openRows = (await q(
      `SELECT status_id, status, effective_from
         FROM accounting.truck_status_history
        WHERE truck_id = $1 AND effective_to IS NULL
        ORDER BY effective_from DESC
        LIMIT 1`,
      [input.truckId],
    )) as unknown as { status_id: string; status: TruckStatus; effective_from: string }[];

    const open = openRows[0];
    if (open) {
      // Back-dating before the state it would end is not a correction, it
      // is a contradiction — and the exclusion constraint would reject it
      // with a constraint name rather than a sentence.
      if (new Date(effectiveFrom) <= new Date(open.effective_from)) {
        throw new TruckStatusError(
          `This truck has been ${open.status} since ${open.effective_from}. A new status has to start after that, not before it.`,
        );
      }
      await q(
        `UPDATE accounting.truck_status_history
            SET effective_to = $2::timestamptz
          WHERE status_id = $1`,
        [open.status_id, effectiveFrom],
      );
    }

    let attestationId: string | null = null;
    if (input.source === 'manual') {
      const att = (await q(
        `INSERT INTO accounting.manual_attestation (asserted_by, basis)
         VALUES ($1, $2) RETURNING attestation_id`,
        [input.assertedBy!.trim(), input.basis!.trim()],
      )) as unknown as { attestation_id: string }[];
      attestationId = att[0]!.attestation_id;
    }

    await q(
      `INSERT INTO accounting.truck_status_history
         (truck_id, status, effective_from, source, connector_pull_id, attestation_id, note)
       VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7)`,
      [
        input.truckId,
        input.status,
        effectiveFrom,
        input.source,
        input.connectorPullId ?? null,
        attestationId,
        input.note ?? null,
      ],
    );

    return { previous: open?.status ?? null, current: input.status, effectiveFrom };
  });
}

/**
 * Current status for every truck that has one.
 *
 * Trucks with no status on file are simply absent. "Nobody has told us" and
 * "available" are different facts, and a board that renders the first as
 * the second is inventing fleet capacity.
 */
export async function listCurrentStatus(): Promise<TruckStatusNow[]> {
  const rows = (await query(
    `SELECT v.truck_id, v.status,
            to_char(v.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS effective_from,
            v.source, v.note, v.hours_in_status
       FROM accounting.v_truck_status_current v
       JOIN accounting.truck t ON t.truck_id = v.truck_id
      ORDER BY t.unit_number`,
  )) as unknown as {
    truck_id: string;
    status: TruckStatus;
    effective_from: string;
    source: StatusSource;
    note: string | null;
    hours_in_status: string;
  }[];

  return rows.map((r) => ({
    truckId: r.truck_id,
    status: r.status,
    effectiveFrom: r.effective_from,
    source: r.source,
    note: r.note,
    // An elapsed-hours figure, not money: a float is correct here.
    hoursInStatus: Number(r.hours_in_status),
  }));
}

/**
 * What a truck was doing on a given day — the effective-dated read.
 *
 * A screen showing last Tuesday must show last Tuesday's status. Reading
 * the current one instead is how a utilisation report quietly restates
 * history every time somebody moves a truck.
 */
export async function statusOn(truckId: string, date: IsoDate): Promise<TruckStatus | null> {
  const rows = (await query(
    `SELECT status FROM accounting.truck_status_history
      WHERE truck_id = $1
        AND effective_from <= ($2::date + interval '1 day' - interval '1 second')
        AND (effective_to IS NULL OR effective_to > $2::date)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [truckId, date],
  )) as unknown as { status: TruckStatus }[];
  return rows[0]?.status ?? null;
}

/** The board's headline counts. Trucks with no status are counted
 *  separately as `unknown` rather than folded into any real state. */
export async function statusCounts(): Promise<Record<string, number>> {
  const rows = (await query(
    `SELECT COALESCE(v.status::text, 'unknown') AS status, count(*)::int AS n
       FROM accounting.truck t
       LEFT JOIN accounting.v_truck_status_current v ON v.truck_id = t.truck_id
      WHERE t.is_active
      GROUP BY 1`,
  )) as unknown as { status: string; n: number }[];

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}
