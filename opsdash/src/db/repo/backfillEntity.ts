/**
 * Giving a company to staging rows that have none.
 *
 * Measured on the real expenses sheet: 1,361 rows carry a cost and no
 * entity, so they are fully categorised and still cannot post. Every
 * carrier's maintenance figure is therefore zero and the P&L is wrong in a
 * known direction.
 *
 * TWO SOURCES, kept apart because they are not equally strong.
 *
 *   bearer          The row itself names the company that bore it. Stated
 *                   evidence, read off the sheet, not inferred.
 *
 *   earliest_period The unit is in the roster, and the cost predates the
 *                   truck's first known period. `truck_entity_history` is
 *                   built from the dispatch sheet, so a period starts the
 *                   first week a truck EARNED — and a truck is bought,
 *                   prepped, plated and repaired before it earns anything.
 *                   The earliest period names its first known carrier and
 *                   the cost is attributed there. An inference, labelled as
 *                   one.
 *
 * NOTHING POSTS FROM HERE. Every row it touches stays `under_review`. An
 * entity resolved by inference is a proposal for a person, and the review
 * gate is the whole reason this system can be trusted.
 *
 * WHAT IS DELIBERATELY NOT RESOLVED:
 *
 *   trailer rows    They carry no unit number at all, because the truck
 *                   printed beside a trailer charge is the puller, not the
 *                   bearer. Trailers are pooled across the carriers; nearly
 *                   half of those with enough history were pulled by more
 *                   than one. 469 rows, and following the truck would be
 *                   worse than leaving them.
 *
 *   'company'       Says a company bore it, never which one. 905 rows.
 *
 *   'STL'           The pipeline records that the 80xx/81xx block is Zone's
 *                   own, bought from STL on a lease-to-purchase option. But
 *                   measured here, 65 of the 89 STL-bearing rows carry units
 *                   prefixed "ST" and only 9 are in that block, so the
 *                   documented mapping does not cover them. Mapping them all
 *                   to Zone would be inventing a fact.
 */
import { resolveEntityFromTruck } from './entityResolution';

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

export type EntitySource = 'bearer' | 'earliest_period';

export interface EntityProposal {
  stagingRowId: string;
  entityId: string;
  source: EntitySource;
  /** In the operator's language, stored on the row. */
  note: string;
}

export interface BackfillPlan {
  proposals: EntityProposal[];
  /** Why the rest were left, counted. */
  unresolved: Record<string, number>;
}

interface Candidate {
  staging_row_id: string;
  unit_number: string | null;
  accrual_date: string | null;
  unit_type: string | null;
  bearer: string | null;
}

/**
 * Company names as the sheet writes them. Only entities the row actually
 * names — no block-to-company guesses.
 */
const BEARER_TO_CODE: ReadonlyArray<[RegExp, string]> = [
  [/^zone( oh)?$/, 'ZONE'],
  [/^(xtrack|xtuck|xrack)$/, 'XTRACK'],
  [/^afg$/, 'AFG'],
  [/^iron ?lease$/, 'IRONLEASE'],
];

export function codeFromBearer(raw: string | null): string | null {
  if (!raw) return null;
  // Escaped tabs and trailing "exp." are stripped in that order, because the
  // sheet writes "Iron lease exp&#9;" — strip the suffix first and "exp" is
  // not at the end yet, so the row reads as an unknown company and a real
  // signal is thrown away.
  const norm = raw
    .replace(/&#9;|&#x9;|\t/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s*exp\.?$/, '')
    .trim();
  for (const [pattern, code] of BEARER_TO_CODE) if (pattern.test(norm)) return code;
  return null;
}

export async function planEntityBackfill(q: QueryFn): Promise<BackfillPlan> {
  const rows = (await q(
    `SELECT s.staging_row_id, s.unit_number, s.accrual_date::text AS accrual_date,
            s.parsed_payload->>'unitType' AS unit_type,
            COALESCE(s.parsed_payload->>'expenseBearerRaw', s.parsed_payload->>'expenseSideRaw') AS bearer
       FROM accounting.staging_row s
      WHERE s.entity_id IS NULL AND s.status <> 'committed'
      ORDER BY s.staging_row_id`,
  )) as Candidate[];

  const codeToId = new Map<string, string>(
    ((await q(`SELECT code, entity_id FROM accounting.entity`)) as Array<{ code: string; entity_id: string }>).map(
      (e) => [e.code, e.entity_id],
    ),
  );

  const proposals: EntityProposal[] = [];
  const unresolved: Record<string, number> = {};
  const note = (k: string) => { unresolved[k] = (unresolved[k] ?? 0) + 1; };

  for (const r of rows) {
    // Stated beats inferred: if the row names the company, nothing about a
    // truck's history can improve on that.
    const code = codeFromBearer(r.bearer);
    if (code) {
      const id = codeToId.get(code);
      if (id) {
        proposals.push({
          stagingRowId: r.staging_row_id,
          entityId: id,
          source: 'bearer',
          note: `Company taken from what the row itself says bore the cost ("${r.bearer?.trim()}").`,
        });
        continue;
      }
      note(`bearer names ${code}, which is not an entity here`);
      continue;
    }

    if (r.unit_type === 'trailer') { note('trailer row — the truck beside it is the puller, not the bearer'); continue; }
    if (!r.unit_number) { note('no unit number and no company named'); continue; }
    if (!r.accrual_date) { note('no date, so no period can be checked'); continue; }

    const viaTruck = await resolveEntityFromTruck(q, r.unit_number, r.accrual_date, { beforeFirstPeriod: true });
    if (viaTruck.entityId === null) {
      note(viaTruck.reason === 'no_assignment' ? 'unit is not in the roster' : `unit known but ${viaTruck.reason}`);
      continue;
    }
    if (viaTruck.resolvedFrom === 'earliest_period') {
      proposals.push({
        stagingRowId: r.staging_row_id,
        entityId: viaTruck.entityId,
        source: 'earliest_period',
        note:
          `Cost dated ${r.accrual_date} predates unit ${r.unit_number}'s first recorded week ` +
          `(${viaTruck.firstPeriodFrom}), which is when it first EARNED, not when the carrier got it. ` +
          'Attributed to that first carrier. Inferred — confirm before this posts.',
      });
      continue;
    }
    proposals.push({
      stagingRowId: r.staging_row_id,
      entityId: viaTruck.entityId,
      source: 'earliest_period',
      note: `Company from unit ${r.unit_number}'s assignment on ${r.accrual_date}.`,
    });
  }

  return { proposals, unresolved };
}

/** Writes the proposals. Rows stay `under_review` — see the module header. */
export async function applyEntityBackfill(
  q: QueryFn,
  proposals: readonly EntityProposal[],
  appliedBy: string,
): Promise<number> {
  let updated = 0;
  for (const p of proposals) {
    const res = (await q(
      `UPDATE accounting.staging_row
          SET entity_id = $2,
              status = 'under_review',
              reviewed_by = $3,
              reviewed_at = now(),
              review_notes = CASE WHEN review_notes IS NULL OR review_notes = ''
                                  THEN $4 ELSE review_notes || ' ' || $4 END
        WHERE staging_row_id = $1
          AND entity_id IS NULL
          AND status <> 'committed'
        RETURNING staging_row_id`,
      [p.stagingRowId, p.entityId, appliedBy, p.note],
    )) as unknown[];
    updated += res.length;
  }
  return updated;
}
