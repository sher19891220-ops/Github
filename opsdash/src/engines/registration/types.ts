/**
 * Types for the registration (IRP + HVUT) posting engine.
 *
 * These layer on top of `@/contract/types` rather than replacing it: the
 * contract's `LedgerEntry` is the wire/DB shape everyone else builds
 * against, and this file adds the columns migration 003 put on
 * `ledger_entry` (`charged_to`, `allocation_basis`, `allocation_note`,
 * `unit_type`, `unit_number`) plus everything `amortization_schedule` needs.
 * Nothing here is imported from or written back into `@/contract/types`.
 */

import type { Decimal, IsoDate } from '@/contract/types';

/** Mirrors `accounting.charged_to`. */
export type ChargedTo = 'company' | 'driver' | 'split' | 'unknown';

/** Mirrors `accounting.allocation_basis`. */
export type AllocationBasis = 'actual' | 'even_split' | 'by_weight' | 'by_miles' | 'manual';

/** Mirrors `accounting.unit_type`. */
export type UnitType = 'truck' | 'trailer' | 'other' | 'unknown';

// ---------------------------------------------------------------------
// Invoice input (parsed from the real IRP vehicle-status report)
// ---------------------------------------------------------------------

export interface IrpInvoiceHeader {
  runDate: IsoDate;
  accountNo: string;
  legalName: string;
  fleetNo: string;
  fleetExpirationYear: number;
  fleetExpirationMonth: number; // 1-12
  totalUnits: number;
}

export interface IrpInvoiceUnit {
  /** The unit label exactly as printed on the IRP report. Per
   *  SOURCE-DISCOVERY §11b, only 10/42 of these matched the *operational*
   *  unit number on the real invoice — this is the registration system's own
   *  alias, not necessarily the dispatch/fuel/expenses unit number. */
  unitNumber: string;
  usdot: string;
  /** The universal crosswalk key (§11b: 42/42 joined on VIN vs 10/42 on
   *  unit number). Everything that resolves this unit to a canonical truck
   *  must go through the VIN, never the unit number. */
  vin: string;
  status: string;
  weightGroup: number;
  vehicleType: string;
  year: number;
  make: string;
  plate: string;
}

export interface IrpInvoiceRoster {
  header: IrpInvoiceHeader;
  units: IrpInvoiceUnit[];
}

export type IrpFeeCategory = 'permit.irp' | 'permit.irp_foreign' | 'permit.bmv';

export interface IrpFeeLine {
  description: string;
  categoryId: IrpFeeCategory;
  amount: Decimal;
}

// ---------------------------------------------------------------------
// VIN -> HVUT payer crosswalk (parsed from the real status CSV)
// ---------------------------------------------------------------------

export interface UnitStatusRow {
  irpUnit: string;
  vin: string;
  /** Raw operational status text ('financed/owned', 'rented', 'UNKNOWN',
   *  'NO STATUS ROW'), kept for audit; not itself the posting decision. */
  status: string;
  /** The resolved HVUT payer. This IS the posting decision — 'unknown' means
   *  genuinely unresolved, never silently defaulted to 'company'. */
  hvutPayer: ChargedTo;
}

// ---------------------------------------------------------------------
// Engine input / output
// ---------------------------------------------------------------------

export interface TruckResolution {
  /** Resolved truck dimension id for this VIN, or null if the truck has not
   *  been onboarded into `accounting.truck` yet. Resolution happens outside
   *  this engine (via `source_key_map`, keyed on VIN) — this engine never
   *  guesses a truck from a unit number or any other string match. */
  truckId: string | null;
}

export interface RegistrationPostingInput {
  roster: IrpInvoiceRoster;
  feeLines: IrpFeeLine[];
  /** The invoice's own stated grand total. Guarded against the fee-line sum
   *  before anything else runs (readiness criterion 5). */
  invoiceTotal: Decimal;
  /** The current statutory flat HVUT rate per unit (Form 2290), e.g.
   *  "550.00". Passed in, never hardcoded — the rate is set by the IRS, not
   *  by this code, and a rate change must not require a deploy. */
  hvutRatePerUnit: Decimal;
  unitStatuses: UnitStatusRow[];
  /** Resolved externally (source_key_map). One legal entity paid this
   *  invoice; a fleet spanning entities would need a per-unit entityId
   *  instead, which this real transaction does not. */
  entityId: string;
  /** VIN -> truck dimension lookup, resolved externally. Units whose VIN is
   *  absent post with `truckId: null` and their raw unit_number preserved,
   *  never silently dropped. */
  truckByVin: Record<string, TruckResolution>;
  irpSourceDocumentId: string;
  hvutSourceDocumentId: string;
  irpPaymentDate: IsoDate;
  hvutPaymentDate: IsoDate;
  postedBy: string;
  /** The date the caller is posting as of. Determines which amortization
   *  months have closed and may therefore produce a posted ledger entry. */
  asOf: IsoDate;
}

/** A ledger row this engine wants inserted. Not a DB id yet — `key` is a
 *  stable local handle so `AmortizationScheduleRowDraft.postedEntryKey` /
 *  `.prepaidEntryKey` can point at one without a real `entry_id` existing. */
export interface LedgerEntryDraft {
  key: string;
  entityId: string;
  truckId: string | null;
  unitType: UnitType;
  unitNumber: string | null;
  categoryId: string;
  /** Signed decimal string, ledger convention: negative = outflow. */
  amount: Decimal;
  currency: string;
  accrualDate: IsoDate;
  chargedTo: ChargedTo;
  allocationBasis: AllocationBasis;
  allocationNote: string | null;
  sourceKind: 'document';
  sourceDocumentId: string;
  memo: string;
  postedBy: string;
}

export interface AmortizationScheduleRowDraft {
  sourceDocumentId: string;
  /** Local key of the `LedgerEntryDraft` recording the original prepaid
   *  payment this row spreads out. */
  prepaidEntryKey: string;
  entityId: string;
  truckId: string | null;
  unitNumber: string;
  vin: string;
  categoryId: string;
  periodMonth: IsoDate;
  /** Signed decimal string: this month's share of the annual cost. */
  amount: Decimal;
  chargedTo: ChargedTo;
  allocationBasis: AllocationBasis;
  /** Whether `periodMonth` has closed as of the engine's `asOf` input. */
  closed: boolean;
  /** Set only when `closed` is true: the local key of the `LedgerEntryDraft`
   *  in `postedEntries` this row produced. Null for every future month —
   *  a commitment, never an actual. */
  postedEntryKey: string | null;
}

export interface HvutChargedToTotals {
  company: Decimal;
  driver: Decimal;
  unknown: Decimal;
}

export interface HvutChargedToCounts {
  company: number;
  driver: number;
  unknown: number;
}

export interface RegistrationPostingReconciliation {
  irpFeeLineTotal: Decimal;
  irpInvoiceTotal: Decimal;
  irpAllocatedTotal: Decimal;
  irpPerUnit: { unitNumber: string; vin: string; amount: Decimal }[];
  hvutRatePerUnit: Decimal;
  hvutTotal: Decimal;
  hvutByChargedTo: HvutChargedToTotals;
  hvutUnitCountByChargedTo: HvutChargedToCounts;
  weightGroup: number;
  unitCount: number;
}

export interface RegistrationPostingResult {
  prepaidEntries: LedgerEntryDraft[];
  scheduleRows: AmortizationScheduleRowDraft[];
  postedEntries: LedgerEntryDraft[];
  reconciliation: RegistrationPostingReconciliation;
}
