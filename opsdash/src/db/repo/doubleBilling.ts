/**
 * The same repair reaching the ledger twice, from two directions.
 *
 * Two sources describe maintenance and they are supposed to be disjoint:
 *
 *   the expenses sheet      work done by OUTSIDE vendors — measured on the
 *                           real sheet, the named vendors are EFS, PSZ,
 *                           Loves, Penske, Ryder, Corcentric, Bowman, and
 *                           Truck Max appears zero times
 *   Truck Max's invoice log work done by the group's OWN shop
 *
 * Disjoint today. The reason this module exists is that nothing enforced
 * it, and the failure is silent and expensive: one repair posted from both
 * sources charges the carrier twice and credits the shop for work it was
 * already paid for inside another number. Nobody notices, because both
 * entries are individually correct.
 *
 * So rather than trusting the separation, every Truck Max charge is checked
 * against what is already on file for the same unit, the same day and the
 * same amount. A match is held for a person, not posted and not silently
 * dropped — the overlap might be real (the shop subcontracted it out) or it
 * might be a duplicate, and only somebody who knows can say.
 */

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

export interface PossibleDuplicate {
  where: 'ledger' | 'staging';
  entryOrRowId: string;
  entityCode: string | null;
  vendor: string | null;
  amount: string;
  accrualDate: string;
}

/**
 * Anything already on file that looks like this charge.
 *
 * Matching is exact on unit, date and amount. A looser match — a date
 * window, a tolerance on the amount — would catch more real duplicates and
 * also start holding unrelated work, and a check that holds good rows gets
 * switched off. Exact is the version that stays on.
 *
 * Both the ledger and staging are searched: a repair sitting unreviewed in
 * staging is still going to post one day, and finding the clash after both
 * are committed is finding it too late.
 */
export async function findPossibleDoubleBilling(
  q: QueryFn,
  charge: { unitNumber: string | null; accrualDate: string; amount: string },
): Promise<PossibleDuplicate[]> {
  if (!charge.unitNumber) return [];
  const magnitude = Number(charge.amount).toFixed(2);

  const posted = (await q(
    `SELECT l.entry_id::text AS id, e.code, l.amount::text AS amount, l.accrual_date::text AS d
       FROM accounting.ledger_entry l
       LEFT JOIN accounting.entity e ON e.entity_id = l.entity_id
      WHERE l.unit_number = $1
        AND l.accrual_date = $2::date
        AND abs(l.amount) = $3::numeric
        AND l.category_id LIKE 'maintenance%'
        AND l.intercompany_pair_id IS NULL`,
    [charge.unitNumber, charge.accrualDate, magnitude],
  )) as Array<{ id: string; code: string | null; amount: string; d: string }>;

  const staged = (await q(
    `SELECT s.staging_row_id::text AS id,
            e.code,
            s.parsed_payload->>'vendorRaw' AS vendor,
            s.amount::text AS amount,
            s.accrual_date::text AS d
       FROM accounting.staging_row s
       LEFT JOIN accounting.entity e ON e.entity_id = s.entity_id
      WHERE s.unit_number = $1
        AND s.accrual_date = $2::date
        AND abs(s.amount) = $3::numeric
        AND s.status IN ('parsed', 'under_review')`,
    [charge.unitNumber, charge.accrualDate, magnitude],
  )) as Array<{ id: string; code: string | null; vendor: string | null; amount: string; d: string }>;

  return [
    ...posted.map((r) => ({
      where: 'ledger' as const,
      entryOrRowId: r.id,
      entityCode: r.code,
      vendor: null,
      amount: r.amount,
      accrualDate: r.d,
    })),
    ...staged.map((r) => ({
      where: 'staging' as const,
      entryOrRowId: r.id,
      entityCode: r.code,
      vendor: r.vendor,
      amount: r.amount,
      accrualDate: r.d,
    })),
  ];
}

export function describeDuplicate(d: PossibleDuplicate): string {
  const who = d.vendor ? ` billed by ${d.vendor}` : '';
  return `${d.where === 'ledger' ? 'already posted' : 'waiting in review'}${who} for ${d.entityCode ?? 'an unknown company'}, ${d.amount} on ${d.accrualDate}`;
}
