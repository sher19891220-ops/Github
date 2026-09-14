/**
 * Resolves who actually bears a cost row's amount: the company, the driver,
 * or (structurally) nobody yet because a human hasn't decided.
 *
 * This is entirely driven by `ledger_entry.charged_to` — the fact the
 * accounting team already recorded about THIS row — never by
 * `driver_class` or any other inference. A company-driver truck and an
 * owner-operator truck can each carry a `charged_to: 'driver'` row, and
 * each must be excluded from company cost the same way; `driver_class`
 * plays no part in that decision, which is also why this module never
 * imports it.
 */
import { centsFromDecimal } from '@/engines/registration';
import type { SummaryLedgerEntry } from './types';

export interface Bearing {
  /** Signed cents landing on company cost. 0 when nothing does. */
  companyCents: number;
  /** Positive cents owed BY the driver TO the company (a receivable), never
   *  signed the way a cost is. 0 when nothing does. */
  driverCents: number;
  /** True when this row's amount could not be assigned to either bucket
   *  because the chargeback decision isn't resolved yet — `'unknown'`, or
   *  `'split'` with no `splitDriverShare` supplied. */
  needsHuman: boolean;
}

function absCents(cents: number): number {
  return cents < 0 ? -cents : cents;
}

export function resolveBearing(
  entry: Pick<SummaryLedgerEntry, 'amount' | 'chargedTo' | 'splitDriverShare'>,
): Bearing {
  const cents = centsFromDecimal(entry.amount);
  switch (entry.chargedTo) {
    case 'company':
      return { companyCents: cents, driverCents: 0, needsHuman: false };

    case 'driver':
      // Rule 1: a driver-charged cost is a receivable, not a company cost.
      // Expressed as a positive "amount owed", not the ledger's own signed
      // convention — a receivable is an asset, not an outflow.
      return { companyCents: 0, driverCents: absCents(cents), needsHuman: false };

    case 'split': {
      if (entry.splitDriverShare == null) {
        // No resolved ratio on this row (accounting.chargeback_decision
        // hasn't decided it, or the caller didn't join it in) — treated
        // exactly like 'unknown' rather than guessing a 50/50 or a 0/100.
        return { companyCents: 0, driverCents: 0, needsHuman: true };
      }
      const totalAbs = absCents(cents);
      const shareAbsRaw = absCents(centsFromDecimal(entry.splitDriverShare));
      // A resolved share can never exceed the row's own total — clamp
      // defensively rather than let a bad upstream value invert the sign
      // of the company's remaining share.
      const shareAbs = Math.min(shareAbsRaw, totalAbs);
      const companyAbs = totalAbs - shareAbs;
      // Avoid producing a `-0` when the driver's share consumes the whole
      // row (companyAbs === 0): `-0 === 0` numerically, but `-0` fails a
      // strict `toBe(0)` and serializes oddly, so it is normalized away
      // here rather than leaking into every caller.
      const companySigned = companyAbs === 0 ? 0 : cents < 0 ? -companyAbs : companyAbs;
      return { companyCents: companySigned, driverCents: shareAbs, needsHuman: false };
    }

    case 'unknown':
    default:
      return { companyCents: 0, driverCents: 0, needsHuman: true };
  }
}
