/**
 * Weight-distance tax — the tax IFTA does not cover.
 *
 * IFTA apportions *fuel* tax. Four US jurisdictions levy a **second,
 * separate tax on distance**, owed on top of IFTA and filed on its own
 * return:
 *
 *   New York   Highway Use Tax (HUT)
 *   Kentucky   KYU weight-distance tax
 *   New Mexico Weight Distance Tax (WDT)
 *   Oregon     Weight-Mile Tax
 *
 * A carrier running those states and filing only IFTA is short by the
 * whole amount, every quarter, silently — the IFTA return is complete and
 * correct on its own terms, and this liability simply never appears on it.
 * Oregon is the sharpest case: it charges **no** IFTA fuel tax at all
 * (its rate is a real zero, see the IFTA rate importer), so a carrier
 * looking only at IFTA sees Oregon costing nothing while the weight-mile
 * tax accrues.
 *
 * These miles come from the same reports the IFTA engine reads, so no new
 * ingestion is needed — only the rates, which nothing can derive.
 */
import type { Decimal, IsoDate } from '@/contract/types';

export interface WeightDistanceRate {
  jurisdiction: string;
  /** Dollars per mile at the fleet's weight. */
  ratePerMile: Decimal;
  /** The tax applies only at or above this gross weight, in pounds. */
  weightThresholdLb: number;
  /**
   * Set when the jurisdiction's real rate depends on a distinction the
   * mileage source does not carry — New York exempts Thruway miles and
   * charges unladen miles at a lower rate, and a telematics IFTA report
   * gives one total per state.
   *
   * The engine still computes, and says the figure is an **upper bound**.
   * That is the honest direction to be wrong in for a tax liability, and
   * it is stated rather than left for the reader to discover at audit.
   */
  upperBoundReason?: string;
  sourceNote: string;
}

export interface WeightDistanceInput {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /** Miles by jurisdiction, as the IFTA engine takes them. */
  milesByJurisdiction: Array<{ jurisdiction: string; miles: Decimal }>;
  rates: WeightDistanceRate[];
  /** The fleet's gross weight in pounds. Every unit on this operator's IRP
   *  roster is weight group 80 — 80,000 lb — and the registration engine
   *  asserts that uniformity, so one figure is correct here rather than a
   *  per-truck lookup. */
  grossWeightLb: number;
}

export interface WeightDistanceLine {
  jurisdiction: string;
  miles: Decimal;
  ratePerMile: Decimal;
  taxDue: Decimal;
  /** True where the mileage source cannot make a distinction the rate
   *  depends on, so `taxDue` is the most this could be rather than what it
   *  is. */
  isUpperBound: boolean;
  note: string | null;
}

export interface WeightDistanceResult {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  lines: WeightDistanceLine[];
  /** Sum of every line. An upper bound if any line is. */
  totalDue: Decimal;
  anyUpperBound: boolean;
  /** Everything that makes this less than a filing. */
  problems: string[];
}
