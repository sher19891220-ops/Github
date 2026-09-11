/**
 * Next week's forecast, and the back-test that gives it its band.
 *
 * The build contract is explicit that the band is not decoration: it must
 * be back-tested against real weeks and the real error reported, and "if
 * the method is bad, say so with numbers rather than shipping a
 * confident-looking line."
 *
 * So most of these tests are about the forecast refusing to look more
 * certain than it is.
 */
import { describe, expect, it } from 'vitest';
import { calculateForecast, MIN_BACKTEST_POINTS, WINDOW_WEEKS } from '@/engines/forecast';
import type { WeekActual } from '@/engines/forecast';

/** Consecutive Monday-start weeks from a fixed date. */
function weeks(values: Array<{ revenue: number; cost: number }>): WeekActual[] {
  const out: WeekActual[] = [];
  let start = Date.UTC(2026, 0, 5); // a Monday
  for (const v of values) {
    const end = start + 6 * 86400000;
    const margin = v.revenue + v.cost;
    out.push({
      periodStart: new Date(start).toISOString().slice(0, 10),
      periodEnd: new Date(end).toISOString().slice(0, 10),
      revenue: v.revenue.toFixed(2),
      cost: v.cost.toFixed(2),
      margin: margin.toFixed(2),
    });
    start = end + 86400000;
  }
  return out;
}

/** Eight steady weeks — enough to average four and back-test four. */
const STEADY = weeks(Array.from({ length: 8 }, () => ({ revenue: 100000, cost: -70000 })));

const HORIZON = { start: '2026-03-02', end: '2026-03-08' };

describe('calculateForecast', () => {
  it('refuses to forecast without enough history to validate the method', () => {
    // An unvalidated band reads like a measurement, which is worse than
    // no forecast at all.
    const r = calculateForecast(weeks(Array.from({ length: 5 }, () => ({ revenue: 1, cost: -1 }))), HORIZON.start, HORIZON.end);
    expect(r.metrics).toBeNull();
    expect(r.blocked).toMatch(new RegExp(`needs ${WINDOW_WEEKS + MIN_BACKTEST_POINTS} closed weeks`));
  });

  it('predicts the trailing mean when the weeks are steady', () => {
    const r = calculateForecast(STEADY, HORIZON.start, HORIZON.end);
    const revenue = r.metrics!.find((m) => m.metric === 'revenue')!;
    expect(revenue.pointEstimate).toBe('100000.00');
    // Steady history means the method was never wrong, so the band
    // collapses onto the estimate. That is a measurement, not a claim of
    // certainty — it says this method has not missed yet.
    expect(revenue.meanAbsoluteError).toBe('0.00');
    expect(revenue.lowerBound).toBe('100000.00');
    expect(revenue.upperBound).toBe('100000.00');
  });

  it('widens the band by itself when the method has been unreliable', () => {
    const volatile = weeks([
      { revenue: 100000, cost: -70000 },
      { revenue: 40000, cost: -70000 },
      { revenue: 160000, cost: -70000 },
      { revenue: 50000, cost: -70000 },
      { revenue: 150000, cost: -70000 },
      { revenue: 30000, cost: -70000 },
      { revenue: 170000, cost: -70000 },
      { revenue: 60000, cost: -70000 },
    ]);
    const r = calculateForecast(volatile, HORIZON.start, HORIZON.end);
    const revenue = r.metrics!.find((m) => m.metric === 'revenue')!;
    // Nothing configured this width — it is the error the method actually
    // made on these weeks.
    expect(Number(revenue.meanAbsoluteError)).toBeGreaterThan(40000);
    expect(Number(revenue.upperBound) - Number(revenue.lowerBound)).toBeGreaterThan(80000);
  });

  it('says with numbers when the method carries no information', () => {
    // The contract's requirement, in one assertion: an error as large as
    // the figure gets stated, not dressed up.
    const volatile = weeks([
      { revenue: 100000, cost: -70000 },
      { revenue: 0, cost: -70000 },
      { revenue: 200000, cost: -70000 },
      { revenue: 0, cost: -70000 },
      { revenue: 200000, cost: -70000 },
      { revenue: 0, cost: -70000 },
      { revenue: 200000, cost: -70000 },
      { revenue: 0, cost: -70000 },
    ]);
    const r = calculateForecast(volatile, HORIZON.start, HORIZON.end);
    expect(
      r.problems.some((p) => /revenue: over the last \d+ weeks this method was wrong by/.test(p)),
    ).toBe(true);
    expect(r.problems.some((p) => /carries no usable information/.test(p))).toBe(true);
  });

  it('reports a biased method as biased, and shifts the band to match', () => {
    // Steadily rising revenue: a trailing mean always lags, so it runs
    // low every single week. A band centred politely on the lagging
    // estimate would hide that.
    const rising = weeks(
      Array.from({ length: 10 }, (_, i) => ({ revenue: 100000 + i * 20000, cost: -70000 })),
    );
    const r = calculateForecast(rising, HORIZON.start, HORIZON.end);
    const revenue = r.metrics!.find((m) => m.metric === 'revenue')!;
    expect(Number(revenue.meanError)).toBeGreaterThan(0); // actuals came in above forecast
    expect(r.problems.some((p) => /revenue: the method is biased/.test(p))).toBe(true);
    // The band's centre sits above the raw trailing mean.
    const mid = (Number(revenue.lowerBound) + Number(revenue.upperBound)) / 2;
    expect(mid).toBeGreaterThan(Number(revenue.pointEstimate));
  });

  it('always brackets the point estimate, however biased the method', () => {
    // The database enforces lower <= point <= upper. A strong bias can
    // push a measured-error band off the estimate entirely; the honest
    // fix is to widen, never to move the estimate to suit the band.
    const rising = weeks(
      Array.from({ length: 12 }, (_, i) => ({ revenue: 10000 + i * 50000, cost: -70000 })),
    );
    const r = calculateForecast(rising, HORIZON.start, HORIZON.end);
    for (const m of r.metrics!) {
      expect(Number(m.lowerBound)).toBeLessThanOrEqual(Number(m.pointEstimate));
      expect(Number(m.upperBound)).toBeGreaterThanOrEqual(Number(m.pointEstimate));
    }
  });

  it('never lets the back-test see the week it is predicting', () => {
    // A back-test that peeks measures nothing. Each point is predicted
    // from the four weeks before it: here, week 5 is predicted from weeks
    // 1-4, whose mean is 100000, against an actual of 500000.
    const jump = weeks([
      { revenue: 100000, cost: -70000 },
      { revenue: 100000, cost: -70000 },
      { revenue: 100000, cost: -70000 },
      { revenue: 100000, cost: -70000 },
      { revenue: 500000, cost: -70000 },
      { revenue: 100000, cost: -70000 },
      { revenue: 100000, cost: -70000 },
      { revenue: 100000, cost: -70000 },
    ]);
    const r = calculateForecast(jump, HORIZON.start, HORIZON.end);
    const revenue = r.metrics!.find((m) => m.metric === 'revenue')!;
    const first = revenue.backTest[0]!;
    expect(first.predicted).toBe('100000.00');
    expect(first.actual).toBe('500000.00');
    expect(first.error).toBe('400000.00');
  });

  it('refuses a history with a gap rather than averaging across it', () => {
    // A missing week silently reweights the others and the output looks
    // like an ordinary forecast.
    const gapped = [...STEADY];
    gapped.splice(3, 1);
    const r = calculateForecast(gapped, HORIZON.start, HORIZON.end);
    expect(r.metrics).toBeNull();
    expect(r.blocked).toMatch(/not consecutive/);
  });

  it('forecasts all three metrics, and margin is forecast in its own right', () => {
    const r = calculateForecast(STEADY, HORIZON.start, HORIZON.end);
    expect(r.metrics!.map((m) => m.metric)).toEqual(['revenue', 'cost', 'margin']);
    const margin = r.metrics!.find((m) => m.metric === 'margin')!;
    expect(margin.pointEstimate).toBe('30000.00');
  });

  it('back-tests every week it can, not a fixed four', () => {
    const r = calculateForecast(STEADY, HORIZON.start, HORIZON.end);
    // 8 weeks, 4 in the window, so 4 predictable weeks.
    expect(r.metrics![0]!.backTest).toHaveLength(4);
    const longer = calculateForecast(
      weeks(Array.from({ length: 12 }, () => ({ revenue: 100000, cost: -70000 }))),
      HORIZON.start,
      HORIZON.end,
    );
    expect(longer.metrics![0]!.backTest).toHaveLength(8);
  });
});
