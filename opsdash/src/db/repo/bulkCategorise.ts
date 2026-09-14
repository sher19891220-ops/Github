/**
 * Applying the categorisation rules across a whole document at once.
 *
 * The rules and the review screen have existed since the review UI was
 * built. What was missing was anything that ran them over the backlog: on
 * the real expenses sheet 1,769 rows sat uncategorised, 267 of them
 * rejected outright for want of a category, so every carrier's maintenance
 * cost was zero and the P&L was wrong in a known direction. The work was
 * never hard, it was just 1,472 button presses, which is not a thing
 * anybody does.
 *
 * TWO THINGS THIS DOES NOT DO, both deliberate.
 *
 * It never assigns a category to a row no rule recognised. There is no
 * fallback and there must not be — `maintenance.repair` would quietly
 * absorb everything nobody thought about, and a chart of accounts that
 * absorbs everything means nothing.
 *
 * It does not make anything postable. `applyCategoryToGroup` puts every row
 * it touches into `under_review`, so a category applied by machine still
 * waits for a person. That is the review gate working, not a limitation to
 * route around: this clears the question "what kind of cost is this",
 * which is the half a rule can answer, and leaves "which company bore it"
 * and "is this right" to somebody who can.
 */
import { applyCategoryToGroup, getCategoryGroups, type CategoryGroup } from './categorise';

export interface DocumentPlan {
  documentId: string;
  uncategorisedRows: number;
  /** Groups a rule claimed, largest amount first. */
  recognised: CategoryGroup[];
  /** The one group nobody's rule matched, or null when every row matched. */
  unrecognised: CategoryGroup | null;
  unrecognisedDescriptions: number;
}

export interface ApplySummary {
  applied: number;
  skippedAlreadyCategorised: number;
  /** Categorised and still unable to post, for want of a company. */
  stillMissingEntity: number;
}

/** What the rules would claim, without writing anything. */
export async function planDocument(documentId: string): Promise<DocumentPlan> {
  const view = await getCategoryGroups(documentId);
  const recognised = view.groups
    .filter((g) => g.suggestedCategoryId !== null)
    .sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount));
  return {
    documentId,
    uncategorisedRows: view.uncategorisedRows,
    recognised,
    unrecognised: view.groups.find((g) => g.suggestedCategoryId === null) ?? null,
    unrecognisedDescriptions: view.unrecognisedDescriptions,
  };
}

/**
 * Applies every group a rule claimed. The unrecognised group is not passed
 * in and cannot be: `planDocument` keeps it separate precisely so a later
 * edit here cannot start categorising it by accident.
 */
export async function applyPlan(plan: DocumentPlan, appliedBy: string): Promise<ApplySummary> {
  const summary: ApplySummary = { applied: 0, skippedAlreadyCategorised: 0, stillMissingEntity: 0 };
  for (const g of plan.recognised) {
    if (g.suggestedCategoryId === null) continue; // unreachable; the type says so, this says it twice
    const result = await applyCategoryToGroup({
      documentId: plan.documentId,
      categoryId: g.suggestedCategoryId,
      stagingRowIds: g.stagingRowIds,
      appliedBy,
      // The rule in its own words, stored on every row it touched. A
      // category applied to hundreds of rows at once has to say why for as
      // long as those entries exist.
      basis: `Applied in bulk because the line ${g.rule}.`,
    });
    summary.applied += result.updated;
    summary.skippedAlreadyCategorised += result.skippedAlreadyCategorised;
    summary.stillMissingEntity += result.stillMissingEntity;
  }
  return summary;
}
