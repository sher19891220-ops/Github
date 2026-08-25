import type { Db } from '@/db';
import { parseRuleSet, type RuleSet } from '@/domain/guideline';
import { getProvider } from './provider';
import { unconfigured } from './provider/types';
import type { Interpretation } from './interpretation-schema';

export { interpretationSchema, type Interpretation } from './interpretation-schema';
export { INTERPRETATION_SYSTEM_PROMPT } from './prompts';

export interface InterpretationResult {
  ok: boolean;
  ruleSet: RuleSet | null;
  warnings: string[];
  errors: string[];
  modelUsed: string | null;
}

/**
 * Validates a drafted rule tree and attaches the caveats a reviewer should see.
 *
 * Kept separate from the network call so the part that decides whether a draft
 * is usable can be tested directly.
 */
export function buildDraft(payload: Interpretation): Omit<InterpretationResult, 'modelUsed'> {
  // Checked before schema validation: the schema rejects an empty path list too,
  // but as "expected array to have >=1 items", which tells a safety reviewer
  // nothing about what to do next.
  if (payload.eligibilityPaths.length === 0) {
    return {
      ok: false,
      ruleSet: null,
      warnings: payload.warnings,
      errors: [
        'No driver-qualification criteria were found in this document. Check that it is the driver guideline rather than a policy or certificate, or write the criteria by hand.',
      ],
    };
  }

  // Re-validate against the real rule schema. A draft the engine cannot parse
  // must never reach the editor looking usable.
  const validated = parseRuleSet({
    schemaVersion: 1,
    eligibilityPaths: payload.eligibilityPaths,
    disqualifiers: payload.disqualifiers,
    notes: payload.notes,
  });

  if (!validated.ok) {
    return {
      ok: false,
      ruleSet: null,
      warnings: payload.warnings,
      errors: [
        'The drafted criteria are not valid against the rule schema, so they were discarded rather than shown as usable:',
        ...validated.errors,
      ],
    };
  }

  const warnings = [...payload.warnings];

  if (validated.ruleSet.eligibilityPaths.length === 1) {
    warnings.push(
      'Only one eligibility path was found. Check the document for alternative or reduced-experience paths — encoding an alternative as a single stricter rule wrongly rejects drivers the insurer would accept.',
    );
  }

  for (const path of validated.ruleSet.eligibilityPaths) {
    if (!path.sourceText.trim()) {
      warnings.push(
        `"${path.label}" carries no quoted source text, so a reviewer cannot check it against the document. Add the guideline's own wording before approving.`,
      );
    }
  }

  return { ok: true, ruleSet: validated.ruleSet, warnings, errors: [] };
}

/**
 * Drafts a rule tree from a guideline document.
 *
 * The result is a draft: schema-validated before it is returned, never stored
 * automatically, and never approved automatically. The approval gate is what
 * makes drafting safe — an unreviewed reading of a PDF cannot reject a driver.
 */
export async function interpretGuideline(
  db: Db,
  files: Array<{ name: string; mimeType: string; base64: string }>,
): Promise<InterpretationResult> {
  const provider = await getProvider(db);
  if (!provider) {
    const outcome = unconfigured<RuleSet>('the guideline');
    return { ok: false, ruleSet: null, warnings: [], errors: outcome.errors, modelUsed: null };
  }

  if (files.length === 0) {
    return {
      ok: false,
      ruleSet: null,
      warnings: [],
      errors: ['No document was supplied.'],
      modelUsed: provider.name,
    };
  }

  const outcome = await provider.extractGuideline(files);
  return {
    ok: outcome.ok,
    ruleSet: outcome.value,
    warnings: outcome.warnings,
    errors: outcome.errors,
    modelUsed: outcome.modelUsed,
  };
}
