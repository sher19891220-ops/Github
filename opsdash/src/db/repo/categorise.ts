/**
 * Bulk categorisation: turning 1,342 decisions into nine.
 *
 * The expenses parser leaves `category_id` null on purpose — a category is
 * an accounting judgement, not something to read out of a free-text cell —
 * and the review screen was built to take that judgement one row at a
 * time. On the operator's real export that is 1,342 rows, which means it
 * does not happen, which means no cost reaches the ledger, which means the
 * margin on every screen is revenue.
 *
 * So rows are grouped by a *suggested* category and decided per group. Two
 * properties make that safe rather than merely fast:
 *
 *  - **The operator applies the rows they were shown, not a rule.** The
 *    client sends explicit row ids. Re-running the rule server-side would
 *    be less code and would let the set drift between the screen rendering
 *    and the button being pressed — a bulk action has to be exactly the
 *    one that was reviewed.
 *  - **Only rows with no category are touched.** A second press, or two
 *    people working the same document, cannot overwrite a category
 *    somebody already chose. The response says how many rows were skipped
 *    for that reason rather than reporting a silent success.
 *
 * And the ordering is by money, not by row count. A wrong bulk decision on
 * the $221,869 group costs more than a wrong one on the $1,403 group, so
 * the expensive judgements are the ones put in front of a person first.
 */
import { query, withTransaction } from '@/db/pool';
import type { Decimal } from '@/contract/types';
import { normalizeDescription, suggestCategory } from '@/engines/categorise/suggest';

export class CategoriseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoriseError';
  }
}

export interface CategoryGroup {
  /** Null for the rows no rule recognised. They are never given a default
   *  — `maintenance.repair` would quietly absorb everything nobody thought
   *  about, and a chart of accounts that absorbs everything means nothing. */
  suggestedCategoryId: string | null;
  /** Why the rule fired, in the operator's words. */
  rule: string | null;
  rowCount: number;
  /** Absolute total, so ordering is by how much is at stake. */
  totalAmount: Decimal;
  /** A few real descriptions from the group, longest-first, so the
   *  operator sees the messiest members rather than the tidiest. */
  sampleDescriptions: string[];
  /** How many of these rows still lack an entity, and so cannot commit
   *  even once categorised. Surfaced per group because "you categorised
   *  267 rows and 140 of them still cannot post" is the thing a person
   *  needs to know before they think the job is done. */
  missingEntityCount: number;
  stagingRowIds: string[];
}

export interface CategoryGroupsView {
  documentId: string;
  uncategorisedRows: number;
  groups: CategoryGroup[];
  /** Distinct unrecognised descriptions — the tail that genuinely needs
   *  one-at-a-time attention. */
  unrecognisedDescriptions: number;
}

interface Row {
  staging_row_id: string;
  text: string | null;
  amount: string | null;
  entity_id: string | null;
}

export async function getCategoryGroups(documentId: string): Promise<CategoryGroupsView> {
  const rows = await query<Row>(
    `SELECT staging_row_id,
            parsed_payload->>'categoryText' AS text,
            amount,
            entity_id
       FROM accounting.staging_row
      WHERE document_id = $1
        AND category_id IS NULL
        AND status <> 'committed'
      ORDER BY row_index`,
    [documentId],
  );

  const buckets = new Map<string, { rule: string | null; rows: Row[] }>();
  const unrecognised = new Set<string>();

  for (const r of rows) {
    const suggestion = suggestCategory(r.text ?? '');
    const key = suggestion?.categoryId ?? '';
    if (suggestion === null) unrecognised.add(normalizeDescription(r.text ?? '') || '(blank)');
    const bucket = buckets.get(key) ?? { rule: suggestion?.rule ?? null, rows: [] };
    bucket.rows.push(r);
    buckets.set(key, bucket);
  }

  const groups: CategoryGroup[] = [...buckets].map(([categoryId, bucket]) => {
    const cents = bucket.rows.reduce((a, r) => a + absCents(r.amount), 0n);
    // Longest descriptions first: the operator should see the awkward
    // members of a group, not the three that obviously belong.
    const samples = [...new Set(bucket.rows.map((r) => normalizeDescription(r.text ?? '')).filter((t) => t !== ''))]
      .sort((a, b) => b.length - a.length)
      .slice(0, 5);
    return {
      suggestedCategoryId: categoryId === '' ? null : categoryId,
      rule: bucket.rule,
      rowCount: bucket.rows.length,
      totalAmount: money(cents),
      sampleDescriptions: samples,
      missingEntityCount: bucket.rows.filter((r) => r.entity_id === null).length,
      stagingRowIds: bucket.rows.map((r) => r.staging_row_id),
    };
  });

  // Most money first; the unrecognised bucket always last, because it is
  // not a decision — it is a list of things to work through.
  groups.sort((a, b) => {
    if (a.suggestedCategoryId === null) return 1;
    if (b.suggestedCategoryId === null) return -1;
    return Number(b.totalAmount) - Number(a.totalAmount);
  });

  return {
    documentId,
    uncategorisedRows: rows.length,
    groups,
    unrecognisedDescriptions: unrecognised.size,
  };
}

export interface ApplyResult {
  updated: number;
  /** Rows the caller asked for that already had a category, so were left
   *  alone. Reported rather than swallowed: it means somebody else has
   *  been working this document. */
  skippedAlreadyCategorised: number;
  /** Rows that now have a category and still cannot commit for want of an
   *  entity. */
  stillMissingEntity: number;
}

export async function applyCategoryToGroup(input: {
  documentId: string;
  categoryId: string;
  stagingRowIds: readonly string[];
  appliedBy: string;
  /** What the operator is asserting, in their words or the rule's. Stored
   *  on the row, because a category applied to 267 rows at once should say
   *  why for as long as those entries exist. */
  basis: string;
}): Promise<ApplyResult> {
  if (input.stagingRowIds.length === 0) {
    throw new CategoriseError('No rows were given to categorise.');
  }
  if (input.appliedBy.trim() === '') throw new CategoriseError('appliedBy is required.');
  if (input.basis.trim() === '') {
    throw new CategoriseError(
      'A bulk categorisation needs a basis. It is applied to many rows at once and will be read back long after the person who pressed the button has forgotten why.',
    );
  }

  const exists = await query(`SELECT 1 FROM accounting.category WHERE category_id = $1`, [input.categoryId]);
  if (exists.length === 0) {
    throw new CategoriseError(
      `No such category: ${input.categoryId}. Add it to the chart of accounts first rather than filing costs under a category that does not exist.`,
    );
  }

  return withTransaction(async (q) => {
    // Locked and counted before the update, so the "already categorised"
    // figure is what was actually there rather than a guess from the
    // difference in row counts.
    const targets = await q(
      `SELECT staging_row_id, category_id, entity_id
         FROM accounting.staging_row
        WHERE document_id = $1
          AND staging_row_id = ANY($2::uuid[])
          AND status <> 'committed'
        FOR UPDATE`,
      [input.documentId, input.stagingRowIds],
    ) as Array<{ staging_row_id: string; category_id: string | null; entity_id: string | null }>;

    const open = targets.filter((t) => t.category_id === null);
    const skipped = targets.length - open.length;

    if (open.length > 0) {
      const note = `Categorised in bulk as ${input.categoryId} by ${input.appliedBy.trim()}: ${input.basis.trim()}`;
      await q(
        `UPDATE accounting.staging_row
            SET category_id = $2,
                status = 'under_review',
                reviewed_by = $3,
                reviewed_at = now(),
                review_notes = CASE
                  WHEN review_notes IS NULL OR review_notes = '' THEN $4
                  ELSE review_notes || ' ' || $4 END
          WHERE staging_row_id = ANY($1::uuid[])`,
        [open.map((t) => t.staging_row_id), input.categoryId, input.appliedBy.trim(), note],
      );
    }

    return {
      updated: open.length,
      skippedAlreadyCategorised: skipped,
      stillMissingEntity: open.filter((t) => t.entity_id === null).length,
    };
  });
}

function absCents(value: string | null): bigint {
  if (value === null) return 0n;
  const m = /^-?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return 0n;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

function money(cents: bigint): Decimal {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
