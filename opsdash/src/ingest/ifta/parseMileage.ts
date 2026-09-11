/**
 * The IFTA mileage report — miles by state, per vehicle.
 *
 * This is the source `DATA-CONTRACT.md` §7 listed as open and blocking:
 * *"Miles by state has no source. No sheet carries it... Phase 3 cannot
 * start until one arrives."* It has arrived. The operator's telematics
 * produces a per-period PDF in this shape:
 *
 *     XTRACK LLC 2830 Gypsum Circle Naperville IL 60564
 *     IFTA by Vehicles: 60
 *     2026-04-01 - 2026-06-30
 *     Vehicle: 7004 (1FUJHHDR1NLNC0044)
 *     Seq State Miles
 *     1 NY 3,758.04
 *     Total 3,758.04
 *     ... one block per vehicle ...
 *     Total Distance by State
 *     Seq State Miles
 *     1 NY 118,145.67
 *     Total 118,145.67
 *
 * **The document checks itself twice**, which is unusually good fortune and
 * the reason this parser can be strict. Each vehicle block states its own
 * total, and the report states a grand total by state. A parser that reads
 * a row wrong will disagree with one or both, so it can say so instead of
 * producing a plausible mileage figure — and per-mile cost is linear in
 * miles, so an error here moves every downstream figure by the same
 * proportion.
 *
 * One caveat that belongs with the data, not in it: every report seen so
 * far carries a **single jurisdiction** (all OR, or all NY). The format
 * clearly supports more — the rows are numbered and headed `Seq State
 * Miles` — but a single-state report is not a complete IFTA return. The
 * parser handles any number of states per vehicle and reports how many it
 * found, so a caller can tell a one-state extract from a full quarter.
 */

export interface IftaStateMiles {
  /** Two-letter jurisdiction as printed. */
  jurisdiction: string;
  /** Exact decimal string. Never a float: miles feed cost-per-mile. */
  miles: string;
}

export interface IftaVehicle {
  /** The unit number as the office writes it. Not always numeric — one
   *  real unit is "KB9859". */
  unitNumber: string;
  vin: string;
  states: IftaStateMiles[];
  /** The total this block states for itself. */
  statedTotal: string;
  /** Set when the state rows do not add up to `statedTotal`. Flagged
   *  rather than corrected: the document disagreeing with itself is a fact
   *  about the document. */
  totalMismatch: string | null;
}

export interface IftaMileageReport {
  carrier: string;
  periodStart: string;
  periodEnd: string;
  /** What the header claims. Compared against what was actually parsed. */
  statedVehicleCount: number | null;
  vehicles: IftaVehicle[];
  /** The report's own "Total Distance by State" section. */
  statedTotalsByState: IftaStateMiles[];
  /** Distinct jurisdictions across the whole report. One means this is a
   *  single-state extract, not a complete return. */
  jurisdictions: string[];
  /** Every disagreement found, in the order found. Empty means the
   *  document is internally consistent and the parse reproduces it. */
  problems: string[];
}

/* --------------------------------------------------------------------- */
/* Exact decimal arithmetic — hundredths, as the report prints them.      */
/* --------------------------------------------------------------------- */

/** `"3,758.04"` -> `375804` hundredths. Throws on anything else. */
export function hundredthsFromMiles(value: string): number {
  const cleaned = value.trim().replace(/,/g, '');
  const m = /^(-?)(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new Error(`Not a mileage figure: ${JSON.stringify(value)}`);
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0')));
}

export function milesFromHundredths(h: number): string {
  const sign = h < 0 ? '-' : '';
  const abs = Math.abs(h);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/* --------------------------------------------------------------------- */

const VEHICLE_RE = /^Vehicle:\s*(.+?)\s*\(([A-HJ-NPR-Z0-9]{11,17})\)\s*$/;
const STATE_ROW_RE = /^(\d+)\s+([A-Z]{2})\s+([\d,]+\.?\d*)$/;
const TOTAL_RE = /^Total\s+([\d,]+\.?\d*)$/;
const PERIOD_RE = /^(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$/;
const COUNT_RE = /^IFTA by Vehicles:\s*(\d+)$/i;

/**
 * Parses the report.
 *
 * Structural, not positional: blocks are found by their `Vehicle:` marker
 * and rows by their shape, so a blank line appearing or disappearing
 * between sections — which differs between the PDF extractors this project
 * uses — changes nothing.
 */
export function parseIftaMileage(rawText: string): IftaMileageReport {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

  const problems: string[] = [];
  const vehicles: IftaVehicle[] = [];
  const statedTotalsByState: IftaStateMiles[] = [];

  let carrier = '';
  let periodStart = '';
  let periodEnd = '';
  let statedVehicleCount: number | null = null;

  // Null until the first `Vehicle:` line; then the block being filled.
  let current: IftaVehicle | null = null;
  // True once "Total Distance by State" is seen — rows after it belong to
  // the report, not to any vehicle.
  let inGrandTotals = false;

  for (const line of lines) {
    const count = COUNT_RE.exec(line);
    if (count) {
      statedVehicleCount = Number(count[1]);
      continue;
    }

    const period = PERIOD_RE.exec(line);
    if (period) {
      periodStart = period[1]!;
      periodEnd = period[2]!;
      continue;
    }

    if (/^Total Distance by State$/i.test(line)) {
      if (current) vehicles.push(finish(current, problems));
      current = null;
      inGrandTotals = true;
      continue;
    }

    const vehicle = VEHICLE_RE.exec(line);
    if (vehicle) {
      if (current) vehicles.push(finish(current, problems));
      current = {
        unitNumber: vehicle[1]!,
        vin: vehicle[2]!,
        states: [],
        statedTotal: '0.00',
        totalMismatch: null,
      };
      continue;
    }

    const stateRow = STATE_ROW_RE.exec(line);
    if (stateRow) {
      const entry: IftaStateMiles = { jurisdiction: stateRow[2]!, miles: normalize(stateRow[3]!) };
      if (inGrandTotals) statedTotalsByState.push(entry);
      else if (current) current.states.push(entry);
      else problems.push(`A state row appeared before any vehicle: "${line}"`);
      continue;
    }

    const total = TOTAL_RE.exec(line);
    if (total) {
      if (inGrandTotals) {
        checkGrandTotal(statedTotalsByState, normalize(total[1]!), problems);
      } else if (current) {
        current.statedTotal = normalize(total[1]!);
      }
      continue;
    }

    // The first unrecognised line is the carrier and its address; anything
    // later is column headings ("Seq State Miles") or noise.
    if (carrier === '' && !/^Seq\s+State\s+Miles$/i.test(line)) carrier = line;
  }

  if (current) vehicles.push(finish(current, problems));

  if (statedVehicleCount !== null && statedVehicleCount !== vehicles.length) {
    problems.push(
      `The report says ${statedVehicleCount} vehicles; ${vehicles.length} were found. ` +
        'Some of the report did not parse, so its mileage is incomplete.',
    );
  }
  if (periodStart === '') problems.push('No reporting period found — these miles belong to no quarter.');

  crossCheckStateTotals(vehicles, statedTotalsByState, problems);

  const jurisdictions = [
    ...new Set(vehicles.flatMap((v) => v.states.map((s) => s.jurisdiction))),
  ].sort();

  return {
    carrier,
    periodStart,
    periodEnd,
    statedVehicleCount,
    vehicles,
    statedTotalsByState,
    jurisdictions,
    problems,
  };
}

function normalize(value: string): string {
  return milesFromHundredths(hundredthsFromMiles(value));
}

/** A vehicle's state rows must add up to the total it states for itself. */
function finish(vehicle: IftaVehicle, problems: string[]): IftaVehicle {
  const summed = vehicle.states.reduce((acc, s) => acc + hundredthsFromMiles(s.miles), 0);
  const stated = hundredthsFromMiles(vehicle.statedTotal);
  if (summed !== stated) {
    const message =
      `Unit ${vehicle.unitNumber}: its state rows add to ${milesFromHundredths(summed)} ` +
      `but the block states ${vehicle.statedTotal}.`;
    vehicle.totalMismatch = message;
    problems.push(message);
  }
  return vehicle;
}

function checkGrandTotal(byState: IftaStateMiles[], stated: string, problems: string[]): void {
  const summed = byState.reduce((acc, s) => acc + hundredthsFromMiles(s.miles), 0);
  if (summed !== hundredthsFromMiles(stated)) {
    problems.push(
      `The report's own state totals add to ${milesFromHundredths(summed)} but it states ${stated}.`,
    );
  }
}

/**
 * The second, independent check: every vehicle's miles in a state must add
 * up to what the report claims for that state.
 *
 * This is the one that catches a dropped vehicle block, which the
 * per-vehicle check cannot see — each surviving block is internally
 * consistent, and only the grand total knows somebody is missing.
 */
function crossCheckStateTotals(
  vehicles: readonly IftaVehicle[],
  statedTotalsByState: readonly IftaStateMiles[],
  problems: string[],
): void {
  if (statedTotalsByState.length === 0) return;

  const computed = new Map<string, number>();
  for (const v of vehicles) {
    for (const s of v.states) {
      computed.set(s.jurisdiction, (computed.get(s.jurisdiction) ?? 0) + hundredthsFromMiles(s.miles));
    }
  }

  for (const stated of statedTotalsByState) {
    const got = computed.get(stated.jurisdiction) ?? 0;
    const want = hundredthsFromMiles(stated.miles);
    if (got !== want) {
      problems.push(
        `${stated.jurisdiction}: the vehicles add to ${milesFromHundredths(got)} ` +
          `but the report's total for that state is ${stated.miles}. ` +
          'A vehicle block is probably missing.',
      );
    }
    computed.delete(stated.jurisdiction);
  }

  for (const [jurisdiction, got] of computed) {
    problems.push(
      `${jurisdiction}: vehicles report ${milesFromHundredths(got)} but the report has no total for that state.`,
    );
  }
}
