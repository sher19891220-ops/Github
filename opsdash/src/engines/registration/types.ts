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
// VIN -> operating-entity crosswalk (parsed from irp_unit_operator.csv)
//
// The registration entity (whoever's name is on the IRP invoice) is not
// always the entity that operates the truck and earns from it. See
// docs/SOURCE-DISCOVERY.md §11e. `operatingEntityKey` is the raw crosswalk
// label ('zone', 'xtrack', 'afg', 'sher_imam', 'iron_lease', 'UNRESOLVED') —
// never itself an `entity_id`; mapping a key to a real `entity_id` happens
// externally (`RegistrationPostingInput.operatorEntityByKey`), the same way
// `truckByVin` resolves a VIN to a truck id outside this engine.
// ---------------------------------------------------------------------

export interface UnitOperatorRow {
  irpUnit: string;
  vin: string;
  /** 'zone' | 'xtrack' | 'afg' | 'sher_imam' | 'iron_lease' | 'UNRESOLVED',
   *  taken verbatim from the crosswalk. Never inferred from any other
   *  string (unit number, lane text, etc.) — see CLAUDE.md §2. */
  operatingEntityKey: string;
  /** Date of the settlement-sheet snapshot (or operator statement) this
   *  assignment is drawn from, or null when the source is a one-off
   *  operator statement rather than a dated snapshot. */
  asOf: IsoDate | null;
  /** Free-text provenance ('settlement sheet (latest snapshot)', 'operator
   *  stated - owner', 'no source', ...) — kept so a recharge can be
   *  explained, never used as a posting decision itself. */
  source: string;
}

/** A unit whose registration-cost routing needs a human look before the
 *  recharge is trusted at face value — either because the named operator is
 *  not an ordinary carrier (`sher_imam`, `iron_lease`), or because no
 *  operator could be determined at all (`UNRESOLVED`, which stays with the
 *  payer rather than inventing one). Surfaced separately from the row-level
 *  `needsConfirmation` flag so the orchestrator can list them without
 *  re-scanning every ledger row. */
export interface NeedsConfirmationUnit {
  unitNumber: string;
  vin: string;
  operatorKey: string;
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
  /** VIN -> operating-entity crosswalk (irp_unit_operator.csv), parsed
   *  externally via `parseUnitOperatorCsv`. Optional and omitted entirely
   *  preserves the pre-recharge behavior: every unit's cost stays with
   *  `entityId` (the payer), no recharge, no receivable — this is what
   *  keeps the 25 pre-existing tests passing unchanged. Once supplied,
   *  EVERY unit on the roster must have a row (even an explicit UNRESOLVED
   *  one) — a unit silently missing from the crosswalk is not allowed to
   *  fall back to "no recharge" by omission. */
  operatorAssignments?: UnitOperatorRow[];
  /** Maps a crosswalk operator key ('zone', 'xtrack', 'afg', 'sher_imam',
   *  'iron_lease') to its resolved `entity_id`, resolved externally exactly
   *  like `truckByVin`. Never consulted for the 'UNRESOLVED' sentinel key,
   *  which is handled structurally (stays with the payer) rather than
   *  looked up. A key present in `operatorAssignments` but absent here is
   *  an error, not a silent default. */
  operatorEntityByKey?: Record<string, string>;
}

/** A ledger row this engine wants inserted. Not a DB id yet — `key` is a
 *  stable local handle so `AmortizationScheduleRowDraft.postedEntryKey` /
 *  `.prepaidEntryKey` can point at one without a real `entry_id` existing. */
export interface LedgerEntryDraft {
  key: string;
  /** The entity whose P&L (or, for an intercompany leg, balance sheet)
   *  carries this row. For an ordinary cost row this is the operator the
   *  truck runs under; for a receivable row it is the payer. */
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
  /** Mirrors `ledger_entry.paid_by_entity_id`: null means "same as
   *  entityId" (the ordinary case). Set only when this cost was funded by
   *  another group company — i.e. entityId is the operator and this names
   *  the payer. */
  paidByEntityId: string | null;
  /** Mirrors `ledger_entry.counterparty_entity_id`: the other side of an
   *  intercompany balance. Required (non-null) on every
   *  `receivable.intercompany` / `payable.intercompany` row, per migration
   *  004's `intercompany_names_counterparty` check; null on every ordinary
   *  cost row. */
  counterpartyEntityId: string | null;
  /** True when the operating entity behind this row is not an ordinary
   *  carrier (`sher_imam`, `iron_lease`) or could not be determined at all
   *  (`UNRESOLVED`) — the recharge (or lack of one) is structurally correct
   *  but wants a human look before being trusted at face value. */
  needsConfirmation: boolean;
}

export interface AmortizationScheduleRowDraft {
  sourceDocumentId: string;
  /** Local key of the `LedgerEntryDraft` recording the original prepaid
   *  payment this row spreads out. */
  prepaidEntryKey: string;
  /** The entity this month's cost recognition lands on — the operator, once
   *  a truck's registration cost is recharged. */
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
  /** Mirrors `amortization_schedule.paid_by_entity_id`: null means "same as
   *  entityId". Set to the payer when this month's cost is recharged to a
   *  different operating entity. Each month uses the operator's latest
   *  known assignment as of when this posting ran — a future transfer is
   *  never modeled ahead of time, per SOURCE-DISCOVERY §11d/§11e. Note:
   *  migration 004 gives `amortization_schedule` no `counterparty_entity_id`
   *  column, so this table can only ever record the cost side of a
   *  recharge (who bears it, who paid) — never who the receivable is owed
   *  by. That is why the receivable itself is posted as an immediate
   *  `ledger_entry` (see `RegistrationPostingResult.intercompanyEntries`),
   *  not as a scheduled row. */
  paidByEntityId: string | null;
  /** See `LedgerEntryDraft.needsConfirmation`. */
  needsConfirmation: boolean;
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
  /** Combined IRP + HVUT cost, bucketed by where it actually lands
   *  (`entityId`) after the recharge: 'zone', 'xtrack', 'afg', 'sher_imam',
   *  'iron_lease', 'unresolved'. Present (all six keys, zero-filled) even
   *  when `operatorAssignments` is omitted, in which case everything is
   *  under 'zone'. Sums to `irpAllocatedTotal` + `hvutTotal` exactly. */
  costByOperatorKey: Record<'zone' | 'xtrack' | 'afg' | 'sher_imam' | 'iron_lease' | 'unresolved', Decimal>;
  /** Sum of every `intercompanyEntries` amount — Zone's total intercompany
   *  receivable across every recharged unit and stream. Zero when
   *  `operatorAssignments` is omitted. */
  intercompanyReceivableTotal: Decimal;
  /** Units whose operator needs a human look before the recharge (or the
   *  decision not to recharge, for UNRESOLVED) is trusted at face value. */
  needsConfirmationUnits: NeedsConfirmationUnit[];
}

export interface RegistrationPostingResult {
  prepaidEntries: LedgerEntryDraft[];
  scheduleRows: AmortizationScheduleRowDraft[];
  postedEntries: LedgerEntryDraft[];
  /** Zone's intercompany receivables against recharged operators — one row
   *  per (recharged unit, cost stream), for that stream's full annual
   *  allocation, dated at the stream's payment date. Posted immediately,
   *  like `prepaidEntries`, because the underlying cash already moved on
   *  that date; NOT gated by `isMonthClosed`, which governs only the
   *  monthly *expense-recognition* timeline in `postedEntries`. Always `[]`
   *  when `operatorAssignments` is omitted. */
  intercompanyEntries: LedgerEntryDraft[];
  reconciliation: RegistrationPostingReconciliation;
}
