/**
 * What a line on a fuel-card statement actually bought.
 *
 * This is the most valuable thing in this parser and the least obvious. **A
 * fuel card statement is not a diesel statement.** A single EFS or Relay
 * invoice mixes at least five kinds of line, and three of them look like
 * fuel because they are priced per gallon:
 *
 *  - **Diesel.** On-road ULSD. These are the IFTA taxable gallons.
 *  - **DEF** (diesel exhaust fluid, AdBlue). Sold by the gallon, at a
 *    gallon price, on the same receipt. It is not fuel and is not burned
 *    in the engine. DEF gallons inside an IFTA return inflate tax-paid
 *    gallons, which claims a credit that was never earned — it understates
 *    the tax owed, which is the direction an auditor looks for.
 *  - **Reefer diesel.** Bought for the trailer's refrigeration unit, dyed,
 *    consumed off-road. It is normally not taxable highway fuel and is
 *    often separately refundable. Folding it into the return both
 *    overstates credits and forfeits the refund.
 *  - **Gasoline.** Genuinely IFTA taxable — but as a *different fuel type*,
 *    with its own rate table (`accounting.ifta_rate.fuel_type`). Adding
 *    gasoline gallons to diesel gallons computes one fleet MPG across two
 *    fuels and prices the result at the diesel rate. Wrong twice.
 *  - **Everything else.** Cash advances, scales, showers, parking, tires,
 *    oil, washes, permits, card fees. Real money, zero gallons.
 *
 * So the classifier's output drives two independent decisions, and they are
 * not the same decision: whether a line is *money* (nearly always yes) and
 * whether its gallons are *IFTA diesel gallons* (only for `diesel`).
 *
 * Unrecognised descriptions classify as `unknown`, never as diesel. A line
 * nobody can name does not get to contribute gallons to a tax filing on the
 * strength of having a number in the quantity column.
 */

export type FuelProductKind =
  | 'diesel'
  | 'def'
  | 'reefer'
  | 'gasoline'
  | 'non_fuel'
  | 'unknown';

export interface ProductClassification {
  kind: FuelProductKind;
  /** True only for `diesel`. The single question the IFTA engine asks. */
  countsAsIftaDiesel: boolean;
  /** Why, in words, for the review screen and for `parsedPayload`. */
  reason: string;
}

/**
 * Order matters. DEF is checked before diesel because "DEF" appears inside
 * descriptions that also say diesel ("DEF/DIESEL EXHAUST FLUID"), and
 * reefer before diesel for the same reason ("REEFER DIESEL", "DIESEL -
 * REEFER"). A naive diesel-first match would classify both as taxable fuel.
 */
const RULES: ReadonlyArray<{ kind: FuelProductKind; re: RegExp; reason: string }> = [
  {
    kind: 'def',
    // `\bDEF\b` alone is too eager — it hits "DEFAULT" and "DEF LINE".
    // Anchored on the word plus the things vendors actually print.
    re: /\b(def)\b|diesel\s*exhaust\s*fluid|\badblue\b|\bd\.e\.f\b/i,
    reason: 'Diesel exhaust fluid — sold by the gallon but not fuel, and never IFTA gallons.',
  },
  {
    kind: 'reefer',
    re: /\breefer\b|\brfr\b|\breef\b|refrigerat|\bdyed\b|off[-\s]?road|\bred\s*dye/i,
    reason: 'Reefer or dyed off-road diesel — not taxable highway fuel, and often separately refundable.',
  },
  {
    // Before diesel: "diesel anti gel" and "Anti gel diesel" both appear
    // verbatim in the operator's real expense sheet. They are additives —
    // sold in bottles, poured into the tank, not fuel — and a
    // diesel-first matcher puts their quantity into an IFTA return.
    kind: 'non_fuel',
    re: /anti[-\s]?gel|\bantigel\b|fuel\s*(treatment|conditioner|additive|supplement)|\bcetane\b|\bhowes\b|\bpower\s*service\b/i,
    reason: 'A fuel additive, not fuel — poured into the tank but never IFTA gallons.',
  },
  {
    kind: 'gasoline',
    re: /\bgasoline\b|\bunleaded\b|\bunl\b|\bgas\b(?!\s*(oil|ket))|\bregular\s*gas|\bmid[-\s]?grade\b|\bpremium\s*unl/i,
    reason: 'Gasoline — IFTA taxable, but a different fuel type with its own rate. Never added to diesel gallons.',
  },
  {
    kind: 'diesel',
    re: /\bdiesel\b|\bulsd\b|\bdsl\b|\b#?2\s*(oil|diesel)\b|\bbio[-\s]?diesel\b|\bb\d{1,2}\b(?=.*diesel)|\btractor\s*fuel\b|\bon[-\s]?road\s*d/i,
    reason: 'On-road diesel — IFTA taxable gallons.',
  },
  {
    kind: 'non_fuel',
    re: /cash\s*adv|\batm\b|\bscale\b|\bshower\b|\bparking\b|\bwash\b|\btire\b|\boil\b|\bantifreeze\b|\bcoolant\b|\bwiper\b|\bchain\b|\bpermit\b|\bfee\b|\bsurcharge\b|\btransaction\s*charge\b|\bmeal\b|\bfood\b|\blumper\b|\brepair\b|\bchemical\b|\bglove\b/i,
    reason: 'Not a fuel purchase — money on the statement, no gallons.',
  },
];

export function classifyProduct(description: string): ProductClassification {
  const text = description.trim();
  if (text === '') {
    return {
      kind: 'unknown',
      countsAsIftaDiesel: false,
      reason: 'The statement named no product for this line, so its gallons cannot be classified.',
    };
  }

  for (const rule of RULES) {
    if (rule.re.test(text)) {
      return {
        kind: rule.kind,
        countsAsIftaDiesel: rule.kind === 'diesel',
        reason: rule.reason,
      };
    }
  }

  return {
    kind: 'unknown',
    countsAsIftaDiesel: false,
    // Never diesel by default. A line nobody can name does not get to put
    // gallons into a tax filing because it happened to have a number in
    // the quantity column.
    reason: `Unrecognised product ${JSON.stringify(text)} — classified as unknown rather than assumed to be diesel.`,
  };
}

/** Human label for the review screen. */
export function productLabel(kind: FuelProductKind): string {
  switch (kind) {
    case 'diesel':
      return 'Diesel';
    case 'def':
      return 'DEF';
    case 'reefer':
      return 'Reefer / off-road';
    case 'gasoline':
      return 'Gasoline';
    case 'non_fuel':
      return 'Not fuel';
    case 'unknown':
      return 'Unclassified';
  }
}
