/**
 * Next week's revenue, cost and margin — and how wrong this method has
 * actually been.
 *
 * The build contract for this panel is unusually specific, and it is
 * specific about the right thing: *"the confidence band is not decoration.
 * Show it, and back-test the method against the last 4 actual weeks,
 * reporting the real error. If the method is bad, say so with numbers
 * rather than shipping a confident-looking line."*
 *
 * So the back-test is not a diagnostic bolted on beside the forecast — it
 * **produces** the forecast's band. The interval comes from the errors the
 * method actually made on this fleet's own recent history, not from an
 * assumed distribution. That has three consequences worth stating:
 *
 *  - A method that has been wildly wrong gets a wide band, automatically,
 *    and looks as uncertain as it is.
 *  - A fleet with too little history to back-test gets **no forecast at
 *    all**. An unvalidated band is worse than no band, because it reads
 *    like a measurement.
 *  - The band is not symmetric unless the errors were. Revenue that
 *    typically comes in under forecast produces a band that sits low, and
 *    forcing it symmetric would hide the bias.
 */
import type { Decimal, IsoDate } from '@/contract/types';

export type ForecastMetric = 'revenue' | 'cost' | 'margin';

/** One closed week of actuals, oldest first. */
export interface WeekActual {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  revenue: Decimal;
  cost: Decimal;
  margin: Decimal;
}

export interface BackTestPoint {
  periodStart: IsoDate;
  /** What the method would have said, using only weeks before this one. */
  predicted: Decimal;
  actual: Decimal;
  /** `actual - predicted`. Negative means the method ran high. */
  error: Decimal;
}

export interface MetricForecast {
  metric: ForecastMetric;
  pointEstimate: Decimal;
  lowerBound: Decimal;
  upperBound: Decimal;
  /** Measured on the back-test, not assumed. */
  meanAbsoluteError: Decimal;
  /** Signed mean error. Non-zero means the method is biased, and which way. */
  meanError: Decimal;
  backTest: BackTestPoint[];
}

export interface ForecastResult {
  horizonStart: IsoDate;
  horizonEnd: IsoDate;
  method: string;
  /** How many closed weeks fed the average. */
  windowWeeks: number;
  /** Null when there was not enough history to validate the method — in
   *  which case there is no forecast either, only `blocked`. */
  metrics: MetricForecast[] | null;
  blocked: string | null;
  problems: string[];
}
