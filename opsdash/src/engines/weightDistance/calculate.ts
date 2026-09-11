/**
 * The weight-distance calculation.
 *
 * Short arithmetic — miles times a rate per mile — and the same four
 * refusals the IFTA engine holds, for the same reasons:
 *
 *  - **A jurisdiction with miles and no rate on file is withheld and
 *    named, never taxed at zero.** Zero is a claim that nothing is owed
 *    there; no rate means nobody has said what is owed.
 *  - **Below a jurisdiction's weight threshold is a real zero**, and is
 *    reported as a line reading $0.00 rather than being dropped — the
 *    miles were run, and "we do not owe this" is a different fact from
 *    "we did not go there".
 *  - **A figure the mileage source cannot compute exactly is labelled an
 *    upper bound**, not quietly rounded into an exact-looking number.
 *  - **No miles is not zero tax** — it is mileage data that has not
 *    arrived.
 *
 * Integer throughout: miles in hundredths, rates in hundred-thousandths
 * (`permit_rate.rate` is numeric(12,4), carried to five here so a rate
 * quoted in mills survives), money in cents, BigInt rather than number.
 */
import type { Decimal } from '@/contract/types';
import type {
  WeightDistanceInput,
  WeightDistanceLine,
  WeightDistanceRate,
  WeightDistanceResult,
} from './types';

export class WeightDistanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeightDistanceInputError';
  }
}

const MILES = 2;
const RATE = 5;
const MONEY = 2;

function scaled(value: string, places: number): bigint {
  const cleaned = value.trim().replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!m) throw new WeightDistanceInputError(`Not a decimal figure: ${JSON.stringify(value)}`);
  const frac = m[3] ?? '';
  if (frac.length > places) {
    throw new WeightDistanceInputError(
      `${JSON.stringify(value)} carries more than ${places} decimal places; rounding it here would hide a precision mismatch in the source.`,
    );
  }
  const sign = m[1] === '-' ? -1n : 1n;
  return sign * (BigInt(m[2]!) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, '0') || '0'));
}

function unscaled(value: bigint, places: number): Decimal {
  const p = 10n ** BigInt(places);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  return `${neg && abs !== 0n ? '-' : ''}${abs / p}.${(abs % p).toString().padStart(places, '0')}`;
}

/** Round half away from zero, the convention tax tables use. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const neg = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return neg ? -q : q;
}

export function calculateWeightDistance(input: WeightDistanceInput): WeightDistanceResult {
  const problems: string[] = [];

  const milesByJur = new Map<string, bigint>();
  for (const m of input.milesByJurisdiction) {
    const j = m.jurisdiction.trim().toUpperCase();
    milesByJur.set(j, (milesByJur.get(j) ?? 0n) + scaled(m.miles, MILES));
  }

  const totalMiles = [...milesByJur.values()].reduce((a, v) => a + v, 0n);
  if (totalMiles === 0n) {
    throw new WeightDistanceInputError(
      'No miles in this period, so there is no distance to tax. A figure produced without mileage data would be a guess, not a liability.',
    );
  }

  const rateByJur = new Map<string, WeightDistanceRate>();
  for (const r of input.rates) rateByJur.set(r.jurisdiction.trim().toUpperCase(), r);

  const lines: WeightDistanceLine[] = [];
  let totalCents = 0n;
  let anyUpperBound = false;

  for (const jurisdiction of [...rateByJur.keys()].sort()) {
    const rate = rateByJur.get(jurisdiction)!;
    const miles = milesByJur.get(jurisdiction);
    // A jurisdiction with a rate on file but no miles this period simply
    // does not appear: nothing was run there, so nothing is owed, and a
    // $0.00 line for every weight-distance state would bury the ones that
    // matter.
    if (miles === undefined || miles === 0n) continue;

    if (input.grossWeightLb < rate.weightThresholdLb) {
      // A real zero, and worth a line: the miles were run, and "below the
      // threshold" is a different fact from "we did not go there".
      lines.push({
        jurisdiction,
        miles: unscaled(miles, MILES),
        ratePerMile: '0.00000',
        taxDue: '0.00',
        isUpperBound: false,
        note: `Not owed: this fleet runs at ${input.grossWeightLb.toLocaleString('en-US')} lb and ${jurisdiction} taxes from ${rate.weightThresholdLb.toLocaleString('en-US')} lb.`,
      });
      continue;
    }

    const rateScaled = scaled(rate.ratePerMile, RATE);
    // cents = miles(1e2) * rate(1e5) / 10^(2+5-2)
    const taxCents = divRound(miles * rateScaled, 10n ** BigInt(MILES + RATE - MONEY));
    totalCents += taxCents;

    const isUpperBound = rate.upperBoundReason !== undefined;
    if (isUpperBound) {
      anyUpperBound = true;
      problems.push(`${jurisdiction}: ${rate.upperBoundReason}`);
    }

    lines.push({
      jurisdiction,
      miles: unscaled(miles, MILES),
      ratePerMile: unscaled(rateScaled, RATE),
      taxDue: unscaled(taxCents, MONEY),
      isUpperBound,
      note: rate.upperBoundReason ?? null,
    });
  }

  // Miles run somewhere that levies this tax, with no rate on file. The
  // engine cannot know which jurisdictions levy it — the rate table is the
  // only authority — so this reports what it could not price rather than
  // guessing at a list.
  const priced = new Set(lines.map((l) => l.jurisdiction));
  const unpriced = [...milesByJur.keys()].filter((j) => !priced.has(j) && !rateByJur.has(j)).sort();
  if (unpriced.length > 0 && lines.length > 0) {
    problems.push(
      `No weight-distance rate is on file for ${unpriced.join(', ')}. ` +
        'Most jurisdictions do not levy this tax at all, so that is usually correct — but New York, Kentucky, ' +
        'New Mexico and Oregon do, and a missing rate for one of those is a liability this figure does not include.',
    );
  }

  if (lines.length === 0) {
    problems.push(
      'No weight-distance rates are on file for any jurisdiction with miles this period, so nothing could be computed. ' +
        'New York, Kentucky, New Mexico and Oregon each levy a distance tax that IFTA does not cover.',
    );
  }

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    lines,
    totalDue: unscaled(totalCents, MONEY),
    anyUpperBound,
    problems,
  };
}
