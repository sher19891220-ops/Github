/**
 * Rates that came from somewhere else: the operator's arrangement sheets,
 * and the analysis pipeline that reads the invoices, policies and bank
 * statements this application never sees.
 *
 * `accounting.rate_fact` has existed since migration 007 and nothing had
 * ever written to it. Its shape turned out to be exactly right — `stated`
 * versus `measured`, optional entity, unit and driver class, an effective
 * period, and a constraint that each kind names its origin.
 *
 * The one thing it did not carry, and now does, is whether a rate is what
 * we CHARGE or what we BEAR. That distinction is not bookkeeping pedantry
 * in this business. An owner-operator is charged for insurance and trailer
 * rent weekly; the company also pays for insurance and trailers. File both
 * under "insurance" and the lease programme's margin disappears into a
 * single number, and a truck charged less than it costs looks exactly like
 * one charged more.
 */

export type RateKind = 'stated' | 'measured';
export type CostBasis = 'per_unit' | 'per_value' | 'per_gross_dollar' | 'per_mile' | 'per_enrollee' | 'per_period';
export type DriverClass = 'lease_to_own' | 'company' | 'owner_operator' | 'unassigned' | 'ltwa';

export interface RateFactInput {
  /** Must begin `charge.` or `cost.` — the database enforces it. */
  rateKey: string;
  kind: RateKind;
  amount: string;
  basis: CostBasis;
  effectiveFrom: string;
  effectiveTo?: string | null;
  entityId?: string | null;
  unitNumber?: string | null;
  driverClass?: DriverClass | null;
  categoryId?: string | null;
  /** Required when kind is 'stated'. */
  sourceDocumentId?: string | null;
  /** Required when kind is 'measured'. */
  calcRunId?: string | null;
  note?: string | null;
  recordedBy: string;
}

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

export class RateFactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateFactError';
  }
}

/** Checked here as well as in the database, so the message names the rate
 *  rather than surfacing a constraint violation with no context. */
export function validateRateFact(r: RateFactInput): void {
  if (!/^(charge|cost)\./.test(r.rateKey)) {
    throw new RateFactError(
      `Rate key "${r.rateKey}" must begin "charge." or "cost.". ` +
        'What a driver is billed and what the company bears are different facts, and a rate ' +
        'that does not say which it is cannot be used to work out whether an arrangement pays.',
    );
  }
  if (r.kind === 'stated' && !r.sourceDocumentId) {
    throw new RateFactError(
      `"${r.rateKey}" is a stated rate, so it needs the document that states it. ` +
        'Upload that document first; a stated rate with no source is a number somebody remembered.',
    );
  }
  if (r.kind === 'measured' && !r.calcRunId) {
    throw new RateFactError(
      `"${r.rateKey}" is a measured rate, so it needs the run that measured it. ` +
        'A measured rate is only as good as the calculation behind it, and that calculation ' +
        'has to be re-runnable.',
    );
  }
  if (!/^-?\d+(\.\d+)?$/.test(r.amount)) {
    throw new RateFactError(`"${r.rateKey}" has a non-decimal amount: ${r.amount}`);
  }
}

/**
 * Inserts a rate, or reports that an identical one is already on file.
 *
 * "Identical" means same key, same scope, same period and same amount.
 * Re-running a load must not produce a second copy of a rate nobody
 * changed, and must not silently overwrite one somebody did.
 */
export async function upsertRateFact(q: QueryFn, r: RateFactInput): Promise<'inserted' | 'unchanged' | 'conflict'> {
  validateRateFact(r);

  const existing = await q(
    `SELECT rate_id, amount::text AS amount FROM accounting.rate_fact
      WHERE rate_key = $1
        AND entity_id IS NOT DISTINCT FROM $2
        AND unit_number IS NOT DISTINCT FROM $3
        AND driver_class IS NOT DISTINCT FROM $4::accounting.driver_class
        AND effective_from = $5::date
        AND effective_to IS NOT DISTINCT FROM $6::date`,
    [r.rateKey, r.entityId ?? null, r.unitNumber ?? null, r.driverClass ?? null, r.effectiveFrom, r.effectiveTo ?? null],
  );

  if (existing.length > 0) {
    const prior = (existing[0] as { amount: string }).amount;
    return Number(prior) === Number(r.amount) ? 'unchanged' : 'conflict';
  }

  await q(
    `INSERT INTO accounting.rate_fact
       (rate_key, kind, entity_id, unit_number, driver_class, category_id,
        amount, basis, effective_from, effective_to,
        source_document_id, calc_run_id, note, recorded_by)
     VALUES ($1, $2::accounting.rate_kind, $3, $4, $5::accounting.driver_class, $6,
             $7, $8::accounting.cost_basis, $9::date, $10::date, $11, $12, $13, $14)`,
    [
      r.rateKey, r.kind, r.entityId ?? null, r.unitNumber ?? null, r.driverClass ?? null, r.categoryId ?? null,
      r.amount, r.basis, r.effectiveFrom, r.effectiveTo ?? null,
      r.sourceDocumentId ?? null, r.calcRunId ?? null, r.note ?? null, r.recordedBy,
    ],
  );
  return 'inserted';
}

export interface SpreadRow {
  subject: string;
  driverClass: string | null;
  charge: string | null;
  cost: string | null;
  spread: string | null;
}

/**
 * What a lease arrangement earns, per week, per matched pair.
 *
 * This is the query the whole charge/cost split exists to make possible. A
 * negative spread is a truck that loses money every week it runs, and
 * nothing else in this system would show it: the charge lands in revenue,
 * the cost lands in expense, and at fleet level they net into a margin that
 * looks fine while an individual arrangement bleeds.
 *
 * A pair with a cost and no charge, or a charge and no cost, comes back
 * with a null spread rather than being dropped — a missing half is the
 * thing worth seeing, not a row to hide.
 */
export async function rateSpread(q: QueryFn, onDate: string): Promise<SpreadRow[]> {
  // Charges and costs are scoped differently, and pairing them naively does
  // not work. A charge is per arrangement — what an owner-operator pays for
  // insurance. A measured cost is per carrier or fleet-wide, because that is
  // how the invoice arrives. Grouping on both subject AND driver class meant
  // the two halves never met: every spread came back null, which reads as
  // "nothing to see" rather than "these were never compared".
  //
  // So the join is on subject alone, and the arrangement is carried from the
  // charge side. A full outer join keeps a cost with no charge as well, since
  // an unbilled cost is as much worth seeing as an unpriced charge.
  const rows = await q(
    `WITH inforce AS (
       SELECT regexp_replace(rate_key, '^(charge|cost)\\.', '') AS subject,
              CASE WHEN rate_key LIKE 'charge.%' THEN 'charge' ELSE 'cost' END AS side,
              driver_class::text AS driver_class,
              amount
         FROM accounting.rate_fact
        WHERE effective_from <= $1::date
          AND (effective_to IS NULL OR effective_to >= $1::date)
     ),
     ch AS (
       SELECT subject, driver_class, max(amount) AS amt
         FROM inforce WHERE side = 'charge' GROUP BY subject, driver_class
     ),
     co AS (
       SELECT subject, max(amount) AS amt
         FROM inforce WHERE side = 'cost' GROUP BY subject
     )
     SELECT COALESCE(ch.subject, co.subject)      AS "subject",
            ch.driver_class                        AS "driverClass",
            ch.amt::text                           AS "charge",
            co.amt::text                           AS "cost",
            (ch.amt - co.amt)::text                AS "spread"
       FROM ch FULL OUTER JOIN co ON co.subject = ch.subject
      ORDER BY 1, 2`,
    [onDate],
  );
  return rows as SpreadRow[];
}
