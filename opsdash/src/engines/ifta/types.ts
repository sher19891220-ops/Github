/**
 * Types for the IFTA engine.
 *
 * Every quantity crosses this boundary as an exact decimal string, for the
 * same reason money does everywhere else in this build: cost per mile is
 * linear in miles, tax is linear in gallons, and a float that drifts in the
 * fourth decimal produces a filing that is wrong by a defensible-looking
 * amount.
 */
import type { Decimal, IsoDate } from '@/contract/types';

/** Miles run in one jurisdiction. */
export interface JurisdictionMiles {
  jurisdiction: string;
  /** Total miles. */
  miles: Decimal;
  /**
   * Miles exempt from fuel tax in this jurisdiction — toll miles in some
   * states, off-highway, agricultural. Defaults to zero, and **zero is the
   * honest default**: claiming an exemption nobody has substantiated is a
   * filing position, not a rounding convenience.
   */
  exemptMiles?: Decimal;
}

/** Fuel bought in one jurisdiction, with tax paid at the pump. */
export interface JurisdictionFuel {
  jurisdiction: string;
  /** Gallons purchased *in that jurisdiction*. Where the fuel was burned
   *  is irrelevant; where it was bought is what earns the credit. */
  gallons: Decimal;
}

/** The tax rate for one jurisdiction, for one quarter. */
export interface IftaRate {
  jurisdiction: string;
  /** Dollars per gallon, e.g. "0.30000". */
  ratePerGallon: Decimal;
  /**
   * A second per-gallon charge some jurisdictions levy — Indiana, Kentucky
   * and Virginia are the usual ones.
   *
   * **The surcharge is charged on taxable gallons with no credit for
   * tax-paid gallons.** You cannot pre-pay it at the pump, so it is always
   * owed and never a credit. Netting it the way the base tax is netted is
   * the single most common way to under-report an IFTA return.
   */
  surchargePerGallon?: Decimal;
}

export interface IftaInput {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  milesByJurisdiction: JurisdictionMiles[];
  fuelByJurisdiction: JurisdictionFuel[];
  rates: IftaRate[];
  /**
   * How many decimal places the fleet MPG is carried to. Jurisdictions
   * publish instructions that differ; two is the common case and the
   * default. Stated explicitly because the whole return scales off this one
   * number, and a return computed at a different precision is a different
   * return.
   */
  mpgDecimalPlaces?: number;
}

/** One jurisdiction's line on the return. */
export interface IftaJurisdictionLine {
  jurisdiction: string;
  totalMiles: Decimal;
  /** Total miles less exempt miles. This is what gallons are computed on. */
  taxableMiles: Decimal;
  /** `taxableMiles / fleetMpg` — the gallons deemed burned here. */
  taxableGallons: Decimal;
  /** Gallons bought here, tax already paid at the pump. */
  taxPaidGallons: Decimal;
  /** `taxableGallons - taxPaidGallons`. Negative is a credit. */
  netTaxableGallons: Decimal;
  ratePerGallon: Decimal;
  /** `netTaxableGallons × rate`. Negative is a credit. */
  taxDue: Decimal;
  surchargePerGallon: Decimal;
  /** `taxableGallons × surcharge` — never netted, never a credit. */
  surchargeDue: Decimal;
  /** `taxDue + surchargeDue`. */
  totalDue: Decimal;
}

export interface IftaResult {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /**
   * Whether this period is a fileable quarter or a running estimate.
   *
   * IFTA is filed quarterly. A daily or weekly figure is an **accrual** —
   * useful for knowing what is building up, and not a return. Labelled
   * rather than left to the reader, because the two get quoted in the same
   * sentence and only one of them can be filed.
   */
  periodKind: 'quarter' | 'accrual';
  totalMiles: Decimal;
  totalGallonsPurchased: Decimal;
  /** Total miles ÷ total gallons, fleet-wide. **Not per jurisdiction** —
   *  IFTA deems fuel consumed at the fleet's average rate everywhere. */
  fleetMpg: Decimal;
  lines: IftaJurisdictionLine[];
  /** Sum of every line's `totalDue`. Positive is owed, negative is a net
   *  credit. */
  netDue: Decimal;
  /**
   * Everything that makes this figure less than a filing. Empty means the
   * inputs were complete and internally consistent — it does not mean the
   * inputs were *right*.
   */
  problems: string[];
}
