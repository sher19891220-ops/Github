/**
 * `GET /api/registration/overhead` support: runs the real registration
 * engine (src/engines/registration/**) against the real IRP roster + unit
 * status documents and returns its `overheadRates` output. This reads the
 * engine's output — it does not re-derive per-unit dollar figures itself.
 *
 * Scope, stated plainly (see final report for the full version):
 *  - The dollar fee-line amounts (`REAL_FEE_LINES`/`REAL_INVOICE_TOTAL`
 *    below) are not machine-readable from any source this build ingests yet
 *    — the real BMV roster export carries unit identity, not dollars. These
 *    are the exact real, filed figures already used and reconciled by
 *    tests/unit/registration.test.ts and quoted in
 *    docs/SOURCE-DISCOVERY.md §11c; they are not fabricated, but they are
 *    also not read from a document upload, because no such ingestion path
 *    has been built. Flagged, not hidden.
 *  - The operator recharge crosswalk (`irp_unit_operator.csv`,
 *    `operatorAssignments`/`operatorEntityByKey`) is intentionally not wired
 *    in here — every unit's cost stays with the paying entity, which is a
 *    fully supported, already-tested engine mode. Wiring the recharge
 *    crosswalk through `source_key_map` is future work, not a correctness
 *    gap in what this route returns today.
 */
import { existsSync, readFileSync } from 'node:fs';
import { query } from '@/db/pool';
import {
  buildRegistrationPosting,
  parseIrpVehicleStatusReport,
  parseUnitStatusCsv,
  type IrpFeeLine,
  type RegistrationPostingInput,
  type TruckOverheadRate,
} from '@/engines/registration';

// Read per-call, not at module load: lets tests point at a missing path
// without needing to re-import the module.
function rosterPath(): string {
  return process.env.OPSDASH_IRP_ROSTER_PATH ?? '/home/user/opsdash-fixtures/irp_invoice_units.txt';
}
function statusPath(): string {
  return process.env.OPSDASH_IRP_STATUS_PATH ?? '/home/user/opsdash-fixtures/irp_unit_status.csv';
}

// Real, filed figures — see the module doc above and SOURCE-DISCOVERY.md §11c.
const REAL_FEE_LINES: IrpFeeLine[] = [
  { description: 'Registration Fee', categoryId: 'permit.irp', amount: '4067.28' },
  { description: 'Foreign Jurisdiction Fees', categoryId: 'permit.irp_foreign', amount: '74554.18' },
  { description: 'BMV Fee', categoryId: 'permit.bmv', amount: '336.00' },
  { description: 'Postage Fee', categoryId: 'permit.bmv', amount: '1.75' },
];
const REAL_INVOICE_TOTAL = '78959.21';
const DEFAULT_HVUT_RATE_PER_UNIT = '550.00';

export class RegistrationSourcesUnavailableError extends Error {}
export class RegistrationEntityUnresolvedError extends Error {}

export interface GetOverheadRatesOptions {
  asOf?: string;
  hvutRatePerUnit?: string;
}

export async function getOverheadRates(options: GetOverheadRatesOptions = {}): Promise<TruckOverheadRate[]> {
  const roster_ = rosterPath();
  const status_ = statusPath();
  if (!existsSync(roster_) || !existsSync(status_)) {
    throw new RegistrationSourcesUnavailableError(
      `IRP roster/status source files are not available at ${roster_} / ${status_}; ` +
        'no registration-document ingestion path exists yet (see docs/DATA-CONTRACT.md §7).',
    );
  }

  const roster = parseIrpVehicleStatusReport(readFileSync(roster_, 'utf8'));
  const unitStatuses = parseUnitStatusCsv(readFileSync(status_, 'utf8'));

  const payerEntityId = await resolveEntityIdByLegalName(roster.header.legalName);
  const truckByVin = await resolveTruckByVin(roster.units.map((u) => u.vin));

  const input: RegistrationPostingInput = {
    roster,
    feeLines: REAL_FEE_LINES,
    invoiceTotal: REAL_INVOICE_TOTAL,
    hvutRatePerUnit: options.hvutRatePerUnit ?? DEFAULT_HVUT_RATE_PER_UNIT,
    unitStatuses,
    entityId: payerEntityId,
    truckByVin,
    irpSourceDocumentId: 'irp-invoice-real-2026',
    hvutSourceDocumentId: 'hvut-2290-real-2026',
    irpPaymentDate: roster.header.runDate,
    hvutPaymentDate: roster.header.runDate,
    postedBy: 'api:registration-overhead',
    asOf: options.asOf ?? new Date().toISOString().slice(0, 10),
  };

  const result = buildRegistrationPosting(input);
  return result.overheadRates;
}

/**
 * The roster's `Legal Name` (e.g. "ZONE-OH LLC") is the payer per
 * SOURCE-DISCOVERY.md §11e. Resolved through `source_key_map` — never a
 * direct string match against `entity.code` — so a spelling variant doesn't
 * silently misattribute the whole fleet's registration cost.
 */
async function resolveEntityIdByLegalName(legalName: string): Promise<string> {
  const rows = await query<{ canonical_id: string }>(
    `SELECT canonical_id FROM accounting.source_key_map
     WHERE canonical_kind = 'entity' AND source_system = 'irp' AND source_key = $1`,
    [legalName],
  );
  const row = rows[0];
  if (!row) {
    throw new RegistrationEntityUnresolvedError(
      `no source_key_map entry maps IRP legal name "${legalName}" to a canonical entity_id; ` +
        `seed accounting.source_key_map (source_system='irp') before requesting overhead rates.`,
    );
  }
  return row.canonical_id;
}

async function resolveTruckByVin(vins: string[]): Promise<RegistrationPostingInput['truckByVin']> {
  if (vins.length === 0) return {};
  const rows = await query<{ vin: string; truck_id: string }>(
    `SELECT vin, truck_id FROM accounting.truck WHERE vin = ANY($1::text[])`,
    [vins],
  );
  const map: RegistrationPostingInput['truckByVin'] = {};
  for (const vin of vins) map[vin] = { truckId: null };
  for (const row of rows) map[row.vin] = { truckId: row.truck_id };
  return map;
}
