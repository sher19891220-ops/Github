/**
 * Splits one shared amount across carriers by a whole-number weight, without
 * inventing or losing a cent.
 *
 * Naive proportional maths does both: three carriers splitting $100.00 by
 * 39/31/4 give 52.70 + 41.89 + 5.41 = 100.00 only by luck, and rounding each
 * independently usually misses the total. The shares here are floored and the
 * remaining pennies handed out largest-remainder, so the parts always sum to
 * the whole exactly.
 *
 * Ties break on the weight, then on the key, so the same input always
 * produces the same output — an allocation that moved a penny between
 * carriers on re-run would make every period irreproducible.
 */
export interface Share {
  key: string;
  weight: number;
  cents: number;
}

export function shareByCount(totalCents: number, weights: ReadonlyArray<{ key: string; weight: number }>): Share[] {
  if (weights.length === 0) throw new Error('Nothing to allocate to: no carriers were given a weight.');
  for (const w of weights) {
    if (!Number.isInteger(w.weight) || w.weight < 0) {
      throw new Error(`Weight for ${w.key} must be a non-negative whole number, got ${w.weight}.`);
    }
  }
  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);
  if (totalWeight === 0) {
    throw new Error('Every carrier has a weight of zero — there is no defensible way to split this.');
  }

  const sign = totalCents < 0 ? -1 : 1;
  const abs = Math.abs(totalCents);

  const base = weights.map((w) => {
    const exact = (abs * w.weight) / totalWeight;
    const floor = Math.floor(exact);
    return { key: w.key, weight: w.weight, cents: floor, remainder: exact - floor };
  });

  let handed = base.reduce((s, b) => s + b.cents, 0);
  const order = [...base].sort(
    (a, b) => b.remainder - a.remainder || b.weight - a.weight || a.key.localeCompare(b.key),
  );
  for (let i = 0; handed < abs; i += 1, handed += 1) {
    order[i % order.length]!.cents += 1;
  }

  // `sign * 0` is -0 in JavaScript, which serialises as "-0.00" on a ledger
  // row. Normalise it, or a carrier with no trucks appears to have been
  // charged a negative nothing.
  const out = base.map((b) => ({
    key: b.key,
    weight: b.weight,
    cents: b.cents === 0 ? 0 : sign * b.cents,
  }));
  const check = out.reduce((s, o) => s + o.cents, 0);
  if (check !== totalCents) {
    throw new Error(`Allocation does not reconcile: parts sum to ${check}, total is ${totalCents}.`);
  }
  return out;
}
