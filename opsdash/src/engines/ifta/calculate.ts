/**
 * The IFTA calculation.
 *
 * The arithmetic is short; almost all of the value here is in the four
 * things it refuses to do.
 *
 * **Fleet MPG is fleet-wide, never per jurisdiction.** IFTA deems fuel
 * consumed at one average rate everywhere — that is the entire mechanism
 * that makes a credit in one state offset tax in another. Computing MPG per
 * state (total miles there ÷ fuel bought there) is arithmetically tempting
 * and produces a return that is wrong in every line.
 *
 * **A surcharge is never netted.** Indiana, Kentucky and Virginia levy a
 * second per-gallon charge on taxable gallons with *no credit* for tax-paid
 * gallons — you cannot pre-pay it at the pump. Netting it the way the base
 * tax is netted under-reports the return, and it is the most common error
 * in hand-built IFTA spreadsheets.
 *
 * **Miles in a jurisdiction with no rate on file stop the calculation for
 * that line.** A missing rate is not zero tax. Defaulting it to zero
 * produces a return that is quietly short by exactly that state's
 * liability.
 *
 * **No fuel means no MPG means no return.** Dividing by zero gallons is not
 * an edge case to handle gracefully; it means the fuel data has not arrived,
 * and the honest output is a refusal.
 *
 * Arithmetic is integer throughout — miles in hundredths, gallons in
 * ten-thousandths (matching `ifta_liability`'s `numeric(14,4)`), rates in
 * hundred-thousandths, money in cents — and uses BigInt rather than
 * number-cents. A large fleet's gallons times a rate exceeds the safe
 * integer range in a way the registration engine's magnitudes never do.
 */
import type { Decimal } from '@/contract/types';
import type {
  IftaInput,
  IftaJurisdictionLine,
  IftaRate,
  IftaResult,
} from './types';

export class IftaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IftaInputError';
  }
}

/* --------------------------------------------------------------------- */
/* Exact scaled-integer helpers                                          */
/* --------------------------------------------------------------------- */

/** Parses a decimal string into an integer scaled by 10^places. */
export function scaled(value: string, places: number): bigint {
  const cleaned = value.trim().replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!m) throw new IftaInputError(`Not a decimal figure: ${JSON.stringify(value)}`);
  const frac = (m[3] ?? '').padEnd(places, '0');
  if (frac.length > places) {
    throw new IftaInputError(
      `${JSON.stringify(value)} carries more than ${places} decimal places; rounding it here would hide a precision mismatch in the source.`,
    );
  }
  const sign = m[1] === '-' ? -1n : 1n;
  return sign * (BigInt(m[2]!) * 10n ** BigInt(places) + BigInt(frac === '' ? '0' : frac));
}

export function unscaled(value: bigint, places: number): Decimal {
  const p = 10n ** BigInt(places);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / p;
  const frac = abs % p;
  const fracStr = places === 0 ? '' : `.${frac.toString().padStart(places, '0')}`;
  return `${neg && abs !== 0n ? '-' : ''}${whole}${fracStr}`;
}

/** Division with round-half-away-from-zero, the convention tax tables use. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new IftaInputError('division by zero');
  const neg = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return neg ? -q : q;
}

const MILES = 2; // hundredths
const GALLONS = 4; // ten-thousandths, matching ifta_liability
const RATE = 5; // hundred-thousandths, matching ifta_rate
const MONEY = 2; // cents

/* --------------------------------------------------------------------- */

/**
 * A period is a fileable quarter only if it starts on a quarter's first day
 * and ends on its last. Anything else is an accrual — worth seeing daily,
 * not a return.
 */
export function classifyPeriod(periodStart: string, periodEnd: string): 'quarter' | 'accrual' {
  const starts = new Set(['01-01', '04-01', '07-01', '10-01']);
  const ends = new Set(['03-31', '06-30', '09-30', '12-31']);
  const s = periodStart.slice(5);
  const e = periodEnd.slice(5);
  if (!starts.has(s) || !ends.has(e)) return 'accrual';
  // Same year, and the end must be the quarter that the start opened.
  if (periodStart.slice(0, 4) !== periodEnd.slice(0, 4)) return 'accrual';
  const pairs: Record<string, string> = {
    '01-01': '03-31',
    '04-01': '06-30',
    '07-01': '09-30',
    '10-01': '12-31',
  };
  return pairs[s] === e ? 'quarter' : 'accrual';
}

export function calculateIfta(input: IftaInput): IftaResult {
  const problems: string[] = [];
  const places = input.mpgDecimalPlaces ?? 2;

  const milesByJur = new Map<string, { total: bigint; exempt: bigint }>();
  for (const m of input.milesByJurisdiction) {
    const j = m.jurisdiction.trim().toUpperCase();
    const total = scaled(m.miles, MILES);
    const exempt = m.exemptMiles === undefined ? 0n : scaled(m.exemptMiles, MILES);
    if (exempt > total) {
      problems.push(
        `${j}: more miles are claimed exempt (${unscaled(exempt, MILES)}) than were driven there (${unscaled(total, MILES)}).`,
      );
    }
    const prev = milesByJur.get(j) ?? { total: 0n, exempt: 0n };
    milesByJur.set(j, { total: prev.total + total, exempt: prev.exempt + exempt });
  }

  const fuelByJur = new Map<string, bigint>();
  for (const f of input.fuelByJurisdiction) {
    const j = f.jurisdiction.trim().toUpperCase();
    const g = scaled(f.gallons, GALLONS);
    if (g < 0n) problems.push(`${j}: negative gallons purchased.`);
    fuelByJur.set(j, (fuelByJur.get(j) ?? 0n) + g);
  }

  const rateByJur = new Map<string, IftaRate>();
  for (const r of input.rates) rateByJur.set(r.jurisdiction.trim().toUpperCase(), r);

  const totalMiles = [...milesByJur.values()].reduce((a, v) => a + v.total, 0n);
  const totalGallons = [...fuelByJur.values()].reduce((a, v) => a + v, 0n);

  // No fuel is not zero fuel: it is fuel data that has not arrived.
  if (totalGallons === 0n) {
    throw new IftaInputError(
      'No fuel purchases in this period, so there is no fleet MPG and no return to compute. ' +
        'A figure produced without fuel data would be a guess dressed as a filing.',
    );
  }
  if (totalMiles === 0n) {
    throw new IftaInputError('No miles in this period, so there is nothing to apportion.');
  }

  // Fleet MPG, to the stated precision. miles(1e2) / gallons(1e4) scaled to
  // 10^places: (miles * 10^places * 10^4) / (gallons * 10^2).
  const mpgScale = 10n ** BigInt(places);
  const fleetMpg = divRound(totalMiles * mpgScale * 10n ** BigInt(GALLONS), totalGallons * 10n ** BigInt(MILES));
  if (fleetMpg === 0n) {
    throw new IftaInputError('Fleet MPG rounds to zero at this precision — the inputs cannot be right.');
  }

  // Every jurisdiction that appears on either side gets a line: fuel bought
  // where no miles were run is still a credit, and must not be dropped.
  const jurisdictions = [...new Set([...milesByJur.keys(), ...fuelByJur.keys()])].sort();

  const lines: IftaJurisdictionLine[] = [];
  let netDueCents = 0n;

  for (const j of jurisdictions) {
    const miles = milesByJur.get(j) ?? { total: 0n, exempt: 0n };
    const taxableMiles = miles.total - miles.exempt;
    const taxPaidGallons = fuelByJur.get(j) ?? 0n;

    const rate = rateByJur.get(j);
    if (rate === undefined) {
      // A missing rate is not zero tax. The line is reported with what is
      // known and the total is explicitly incomplete.
      problems.push(
        `${j}: no tax rate on file for this period, so its liability is unknown and is NOT in the total. ` +
          `${unscaled(taxableMiles, MILES)} taxable miles and ${unscaled(taxPaidGallons, GALLONS)} tax-paid gallons are unaccounted for.`,
      );
      continue;
    }

    // taxableGallons(1e4) = taxableMiles(1e2) / mpg(10^places)
    const taxableGallons = divRound(
      taxableMiles * 10n ** BigInt(GALLONS) * mpgScale,
      fleetMpg * 10n ** BigInt(MILES),
    );
    const netTaxableGallons = taxableGallons - taxPaidGallons;

    const rateScaled = scaled(rate.ratePerGallon, RATE);
    const surchargeScaled =
      rate.surchargePerGallon === undefined ? 0n : scaled(rate.surchargePerGallon, RATE);

    // cents = gallons(1e4) * rate(1e5) / 10^(4+5-2)
    const taxDue = divRound(netTaxableGallons * rateScaled, 10n ** BigInt(GALLONS + RATE - MONEY));

    // The surcharge is on TAXABLE gallons, not net. There is no pump credit
    // against it, so it can never be negative.
    const surchargeDue = divRound(taxableGallons * surchargeScaled, 10n ** BigInt(GALLONS + RATE - MONEY));

    const totalDue = taxDue + surchargeDue;
    netDueCents += totalDue;

    lines.push({
      jurisdiction: j,
      totalMiles: unscaled(miles.total, MILES),
      taxableMiles: unscaled(taxableMiles, MILES),
      taxableGallons: unscaled(taxableGallons, GALLONS),
      taxPaidGallons: unscaled(taxPaidGallons, GALLONS),
      netTaxableGallons: unscaled(netTaxableGallons, GALLONS),
      ratePerGallon: unscaled(rateScaled, RATE),
      taxDue: unscaled(taxDue, MONEY),
      surchargePerGallon: unscaled(surchargeScaled, RATE),
      surchargeDue: unscaled(surchargeDue, MONEY),
      totalDue: unscaled(totalDue, MONEY),
    });
  }

  const periodKind = classifyPeriod(input.periodStart, input.periodEnd);
  if (periodKind === 'accrual') {
    problems.push(
      'This period is not a calendar quarter, so this is an accrual — what is building up — not a return that can be filed.',
    );
  }
  if (jurisdictions.length === 1) {
    problems.push(
      `Only one jurisdiction (${jurisdictions[0]}) appears in this period. A single-jurisdiction figure is not a complete IFTA return; check that the mileage source is not filtered to one state.`,
    );
  }

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    periodKind,
    totalMiles: unscaled(totalMiles, MILES),
    totalGallonsPurchased: unscaled(totalGallons, GALLONS),
    fleetMpg: unscaled(fleetMpg, places),
    lines,
    netDue: unscaled(netDueCents, MONEY),
    problems,
  };
}
