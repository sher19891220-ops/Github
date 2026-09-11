/**
 * The forecast, and the back-test that gives it its band.
 *
 * The method is a trailing moving average, and that is deliberate: the
 * contract says *"moving average is fine; sophistication is not the goal,
 * honesty is."* A more elaborate model would be harder to back-test and no
 * more trustworthy on a fleet this size.
 *
 * What makes it honest is the order of operations. The band is computed
 * **from the method's own measured errors** on this fleet's recent weeks,
 * so it widens by itself when the method has been unreliable. Nothing here
 * assumes a normal distribution, and nothing symmetrises an asymmetric
 * error — a method that consistently runs high should produce a band that
 * sits low, and saying otherwise would hide the bias.
 *
 * Money is integer cents throughout.
 */
import type { Decimal } from '@/contract/types';
import type {
  BackTestPoint,
  ForecastMetric,
  ForecastResult,
  MetricForecast,
  WeekActual,
} from './types';

export class ForecastInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForecastInputError';
  }
}

/** Weeks of history averaged to make one prediction. */
export const WINDOW_WEEKS = 4;
/** Back-test points required before a forecast is allowed out at all. */
export const MIN_BACKTEST_POINTS = 4;

function cents(value: Decimal): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new ForecastInputError(`Not a money figure: ${JSON.stringify(value)}`);
  const abs = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -abs : abs;
}

function money(c: bigint): Decimal {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg && abs !== 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Mean of a list of cent values, rounded half away from zero. */
function mean(values: readonly bigint[]): bigint {
  if (values.length === 0) return 0n;
  const total = values.reduce((a, b) => a + b, 0n);
  const n = BigInt(values.length);
  const neg = total < 0n;
  const abs = neg ? -total : total;
  const q = (abs * 2n + n) / (n * 2n);
  return neg ? -q : q;
}

function valueOf(week: WeekActual, metric: ForecastMetric): bigint {
  return cents(metric === 'revenue' ? week.revenue : metric === 'cost' ? week.cost : week.margin);
}

/**
 * Predicts one metric for the week after `history`, and measures how wrong
 * that method would have been on the weeks it can check.
 *
 * Each back-test point re-runs the method using **only the weeks before
 * the one being predicted** — no peeking. A back-test that lets the method
 * see the answer measures nothing.
 */
function forecastMetric(history: readonly WeekActual[], metric: ForecastMetric): MetricForecast | null {
  const backTest: BackTestPoint[] = [];

  for (let i = WINDOW_WEEKS; i < history.length; i += 1) {
    const window = history.slice(i - WINDOW_WEEKS, i).map((w) => valueOf(w, metric));
    const predicted = mean(window);
    const actual = valueOf(history[i]!, metric);
    backTest.push({
      periodStart: history[i]!.periodStart,
      predicted: money(predicted),
      actual: money(actual),
      error: money(actual - predicted),
    });
  }

  if (backTest.length < MIN_BACKTEST_POINTS) return null;

  const errors = backTest.map((p) => cents(p.error));
  const absErrors = errors.map((e) => (e < 0n ? -e : e));
  const meanAbs = mean(absErrors);
  const meanSigned = mean(errors);

  const window = history.slice(-WINDOW_WEEKS).map((w) => valueOf(w, metric));
  const point = mean(window);

  // The band is the method's own measured error, applied around the point
  // estimate — and it is centred on the SIGNED mean, so a method that has
  // run consistently high produces a band that sits low rather than one
  // politely centred on a number the history says is wrong.
  const centre = point + meanSigned;
  const lower = centre - meanAbs;
  const upper = centre + meanAbs;

  return {
    metric,
    pointEstimate: money(point),
    // The bounds must bracket the point estimate — the database enforces
    // this too. A strong bias can push the measured-error band off the
    // point estimate entirely, and when that happens the honest fix is to
    // widen the band to include it, not to move the estimate.
    lowerBound: money(lower < point ? lower : point),
    upperBound: money(upper > point ? upper : point),
    meanAbsoluteError: money(meanAbs),
    meanError: money(meanSigned),
    backTest,
  };
}

/**
 * `history` must be closed weeks, oldest first, with no gaps.
 *
 * A gap is refused rather than averaged over: a missing week in a moving
 * average silently reweights the others, and the result looks exactly like
 * a normal forecast.
 */
export function calculateForecast(
  history: readonly WeekActual[],
  horizonStart: string,
  horizonEnd: string,
): ForecastResult {
  const problems: string[] = [];
  const needed = WINDOW_WEEKS + MIN_BACKTEST_POINTS;

  // Consecutiveness before sufficiency, deliberately. A gapped history is
  // often also a short one, and "not enough weeks" would send somebody
  // looking for more data when the real problem is that a week in the
  // middle is missing. The more specific diagnosis wins.
  for (let i = 1; i < history.length; i += 1) {
    const prevEnd = new Date(`${history[i - 1]!.periodEnd}T00:00:00Z`);
    const thisStart = new Date(`${history[i]!.periodStart}T00:00:00Z`);
    const gapDays = Math.round((thisStart.getTime() - prevEnd.getTime()) / 86400000);
    if (gapDays !== 1) {
      return {
        horizonStart,
        horizonEnd,
        method: `trailing ${WINDOW_WEEKS}-week mean`,
        windowWeeks: WINDOW_WEEKS,
        metrics: null,
        blocked:
          `The weeks supplied are not consecutive: ${history[i - 1]!.periodEnd} is followed by ${history[i]!.periodStart}. ` +
          'A gap inside a moving average silently reweights the weeks around it, and the result looks like an ordinary forecast.',
        problems,
      };
    }
  }

  if (history.length < needed) {
    return {
      horizonStart,
      horizonEnd,
      method: `trailing ${WINDOW_WEEKS}-week mean`,
      windowWeeks: WINDOW_WEEKS,
      metrics: null,
      blocked:
        `A forecast needs ${needed} closed weeks — ${WINDOW_WEEKS} to average and ${MIN_BACKTEST_POINTS} more to ` +
        `measure how wrong that average has been — and there ${history.length === 1 ? 'is' : 'are'} ${history.length}. ` +
        'A band nobody has validated reads like a measurement, which is worse than no forecast at all.',
      problems,
    };
  }

  const metrics: MetricForecast[] = [];
  for (const metric of ['revenue', 'cost', 'margin'] as const) {
    const f = forecastMetric(history, metric);
    if (f !== null) metrics.push(f);
  }

  // Say plainly when the method is bad. A mean absolute error at or above
  // the point estimate means the band spans zero and the forecast carries
  // no information — which the contract asks to be reported with numbers
  // rather than dressed up.
  for (const m of metrics) {
    const point = cents(m.pointEstimate);
    const absPoint = point < 0n ? -point : point;
    const mae = cents(m.meanAbsoluteError);
    if (absPoint > 0n && mae >= absPoint) {
      problems.push(
        `${m.metric}: over the last ${m.backTest.length} weeks this method was wrong by ${m.meanAbsoluteError} on average ` +
          `against a prediction of ${m.pointEstimate}. The error is as large as the figure, so this forecast carries no usable information.`,
      );
    }
    const bias = cents(m.meanError);
    const absBias = bias < 0n ? -bias : bias;
    if (mae > 0n && absBias * 2n > mae) {
      problems.push(
        `${m.metric}: the method is biased — it ran ${bias < 0n ? 'high' : 'low'} by ${m.meanError} on average, not just noisily. ` +
          'The band is shifted to match rather than centred politely on a number the history says is wrong.',
      );
    }
  }

  return {
    horizonStart,
    horizonEnd,
    method: `trailing ${WINDOW_WEEKS}-week mean, band from measured back-test error`,
    windowWeeks: WINDOW_WEEKS,
    metrics,
    blocked: null,
    problems,
  };
}
