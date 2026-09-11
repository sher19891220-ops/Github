/**
 * Truck cost-bearer lookup — SOURCE-DISCOVERY.md §11h.
 *
 * `ledger_entry.charged_to` says who bears a *specific* cost. Separately,
 * some units are not company-borne at all: they are owned outright by an
 * outside investor, by a lease-to-purchase driver who has paid the unit
 * off (`ltp_owner`), or by an owner-operator (`owner_operator`). That is a
 * fact about *ownership*, keyed by VIN — the one identifier the IRP data
 * and `accounting.truck` reliably share (§11b: 42/42 join on VIN vs 10/42
 * on unit number) — not by unit number and not by today's driver
 * assignment.
 *
 * The crosswalk this reads (`irp_unit_ownership.csv`) is a real, dropped
 * document — the same shape and the same env-var-configurable-path pattern
 * `registrationOverhead.ts`'s roster/status files already use. No
 * `accounting.*` table models per-truck ownership yet (that would need a
 * migration, out of this fix's scope), so this is the one legitimate way to
 * bring the fact in without inventing schema. Its absence from disk is not
 * an error — every truck is simply treated as having no ownership signal
 * (i.e. never flagged), never guessed at.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseDelimited } from '@/ingest/extract';

export type CostBearer = 'company' | 'investor' | 'ltp_owner' | 'owner_operator';

const VALID_BEARERS: ReadonlySet<string> = new Set(['company', 'investor', 'ltp_owner', 'owner_operator']);

export interface UnitOwnershipRow {
  vin: string;
  costBearer: CostBearer;
}

function ownershipCsvPath(): string {
  return process.env.OPSDASH_IRP_OWNERSHIP_PATH ?? '/home/user/opsdash-fixtures/irp_unit_ownership.csv';
}

/** Parses the real ownership crosswalk by header name, never column index
 *  (CLAUDE.md §2) — the `source` column carries free text with embedded
 *  commas, which is exactly why this goes through the quote-aware
 *  `parseDelimited` (src/ingest/extract/csv.ts) rather than a naive split. */
export function parseUnitOwnershipCsv(text: string): UnitOwnershipRow[] {
  const table = parseDelimited(text, ',').filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length === 0) return [];

  const header = (table[0] as string[]).map((c) => c.trim().toLowerCase());
  const vinIdx = header.indexOf('vin');
  const bearerIdx = header.indexOf('cost_bearer');
  if (vinIdx < 0 || bearerIdx < 0) {
    throw new Error(
      `unit ownership CSV is missing expected column(s) "vin"/"cost_bearer". Header: ${JSON.stringify(header)}`,
    );
  }

  const rows: UnitOwnershipRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i] as string[];
    const vin = (cells[vinIdx] ?? '').trim();
    const bearerRaw = (cells[bearerIdx] ?? '').trim().toLowerCase();
    if (!vin) continue;
    if (!VALID_BEARERS.has(bearerRaw)) {
      throw new Error(
        `unit ownership CSV: unrecognized cost_bearer "${bearerRaw}" for VIN ${vin}. Refusing to guess.`,
      );
    }
    rows.push({ vin, costBearer: bearerRaw as CostBearer });
  }
  return rows;
}

/** Re-read per call rather than cached at module scope: this is a small
 *  file, read only at commit time (not a hot path), and a stale in-memory
 *  copy across a long-lived process is a worse failure mode than an extra
 *  disk read. */
export function loadUnitOwnershipRows(): UnitOwnershipRow[] {
  const path = ownershipCsvPath();
  if (!existsSync(path)) return [];
  return parseUnitOwnershipCsv(readFileSync(path, 'utf8'));
}

/** The driver_class a truck's bearer implies, when that bearer is a driver
 *  at all. `investor` has no driver correlate — an investor is never a
 *  driver in `accounting.driver` — so there is nothing to cross-check a
 *  charged driver against for an investor-borne unit here. */
const BEARER_DRIVER_CLASS: Partial<Record<CostBearer, string>> = {
  ltp_owner: 'lease_to_own',
  owner_operator: 'owner_operator',
};

export type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

export interface OwnershipConflictInput {
  truckId: string | null;
  driverId: string | null;
  chargedTo: 'company' | 'driver' | 'split' | 'unknown' | null;
  categoryId: string | null;
}

/**
 * Detects — never auto-resolves — the double-bill: a cost charged directly
 * to a driver (`charged_to = 'driver'` or `'split'`) who is *also* the
 * truck's owner-of-record for that unit (ltp_owner/owner_operator already
 * bears 100% of that unit's costs by owning it). Which side is correct is a
 * human judgement (maybe the charge is unrelated to the unit, maybe the
 * `charged_to` decision was simply wrong) — this only ever returns a reason
 * string naming both facts, for the caller to reject the row on, never a
 * silent adjustment.
 *
 * "Is this driver the truck's owner" is answered from the one place that
 * fact is already recorded: prior `ledger_entry` rows pairing this exact
 * `(truck_id, driver_id)` under the driver_class the bearer implies (e.g. a
 * lease-to-own driver who has driven this exact truck). SOURCE-DISCOVERY.md
 * §11c notes this same crosswalk — unit to driver class — comes from the
 * dispatch sheet, which is exactly what already lands in `ledger_entry`.
 */
export async function findOwnershipConflict(q: QueryFn, input: OwnershipConflictInput): Promise<string | null> {
  if (input.chargedTo !== 'driver' && input.chargedTo !== 'split') return null;
  if (!input.truckId || !input.driverId) return null;

  const ownershipRows = loadUnitOwnershipRows();
  if (ownershipRows.length === 0) return null;

  const truckRows = (await q(`SELECT unit_number, vin FROM accounting.truck WHERE truck_id = $1`, [
    input.truckId,
  ])) as { unit_number: string; vin: string | null }[];
  const truck = truckRows[0];
  if (!truck?.vin) return null;

  const ownership = ownershipRows.find((r) => r.vin === truck.vin);
  if (!ownership) return null;

  const expectedClass = BEARER_DRIVER_CLASS[ownership.costBearer];
  if (!expectedClass) return null;

  const priorRows = (await q(
    `SELECT 1 FROM accounting.ledger_entry WHERE truck_id = $1 AND driver_id = $2 AND driver_class = $3 LIMIT 1`,
    [input.truckId, input.driverId, expectedClass],
  )) as unknown[];
  if (priorRows.length === 0) return null;

  const driverRows = (await q(`SELECT full_name FROM accounting.driver WHERE driver_id = $1`, [
    input.driverId,
  ])) as { full_name: string }[];
  const driverName = driverRows[0]?.full_name ?? input.driverId;

  return (
    `CONFLICT: this row charges the cost to driver "${driverName}" (charged_to='${input.chargedTo}'), but ` +
    `unit ${truck.unit_number} (VIN ${truck.vin}) is already on record as owned by that same driver ` +
    `(cost_bearer='${ownership.costBearer}' per the IRP ownership crosswalk; ledger history shows driver_class=` +
    `'${expectedClass}' for this driver on this truck) — the owner already bears 100% of this unit's costs, so ` +
    `charging it to the driver again double-bills them. Resolve by changing charged_to, or confirm this cost is ` +
    `genuinely unrelated to unit ownership, then recommit.`
  );
}
