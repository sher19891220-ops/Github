import type { Db } from '@/db';
import { z } from 'zod';
import { getExtractionModel, getSecret, SETTING_KEYS } from './settings';
import { parseRuleSet, type RuleSet } from '@/domain/guideline';

/**
 * Turning an insurer's guideline document into an evaluable rule tree.
 *
 * What comes back is a **draft**. It is validated against the rule schema before
 * it is returned, it is never stored automatically, and a reviewer must correct
 * and approve it before any decision uses it. The approval gate in
 * `isEvaluable()` is what makes drafting safe: an unreviewed reading of a PDF
 * cannot reject a driver.
 */

export const INTERPRETATION_SYSTEM_PROMPT = `You convert a commercial trucking insurance driver-qualification guideline into a strict JSON rule tree. You are transcribing structure, not exercising judgement.

Rules you must follow exactly:

1. Encode ONLY criteria the document states. Never add an industry-standard rule, a "typical" threshold, or a criterion the document does not contain. A missing criterion must stay missing.

2. ALTERNATIVES ARE SEPARATE PATHS. Guidelines are usually written as prose that reads like one list but often contains alternatives. "Two years experience with up to three violations; drivers with one year may be considered with up to one violation" is TWO eligibility paths, not one requirement with an exception. A driver qualifies by satisfying ANY ONE complete path. Encoding an alternative as a single stricter path wrongly rejects drivers the insurer would accept. Read the whole document for words like "or", "alternatively", "may be considered", "exception", "however", and tiered tables.

3. Conditions WITHIN a path are all required (AND). Paths are alternatives (OR).

4. A disqualifier is an absolute bar that applies no matter which path is satisfied. Its condition states the ACCEPTABLE state; failing that condition disqualifies. "Any DUI in 5 years is unacceptable" becomes a disqualifier with max_events / major_moving_violation / 60 months / max 0.

5. sourceText must quote the document VERBATIM — the exact sentence or clause the rule came from. Never paraphrase it. It is shown to auditors beside the decision it produced.

6. Each condition carries its own lookbackMonths. Different windows for minor and major violations in the same path are normal, not a conflict.

7. Only include a suspension criterion if the document explicitly makes suspension history a qualification criterion. There is no default suspension rule.

8. Only include a medical-certificate criterion if the document explicitly requires one.

9. If the document is ambiguous, unreadable, or you are unsure whether something is a separate path, say so in "warnings" rather than guessing. A flagged uncertainty is useful; a confident wrong rule is not.

10. If the document contains no driver-qualification criteria at all, return empty eligibilityPaths and explain in "warnings".`;

/** What the model returns: a rule set plus its own caveats. */
export const interpretationSchema = z.object({
  eligibilityPaths: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      sourceText: z.string(),
      conditions: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
  disqualifiers: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      sourceText: z.string(),
      condition: z.record(z.string(), z.unknown()),
    }),
  ),
  notes: z.string(),
  warnings: z.array(z.string()),
});

export type Interpretation = z.infer<typeof interpretationSchema>;

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

export async function interpretGuideline(
  db: Db,
  files: Array<{ name: string; mimeType: string; base64: string }>,
): Promise<InterpretationResult> {
  const apiKey = await getSecret(db, SETTING_KEYS.openaiApiKey);
  const model = await getExtractionModel(db);

  if (!apiKey) {
    return {
      ok: false,
      ruleSet: null,
      warnings: [],
      errors: [
        'No OpenAI API key is configured, so the guideline cannot be read automatically. Add a key under Settings → Integrations, or write the criteria by hand — see docs/USER-GUIDE.md for the format.',
      ],
      modelUsed: null,
    };
  }

  if (files.length === 0) {
    return { ok: false, ruleSet: null, warnings: [], errors: ['No document was supplied.'], modelUsed: model };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        instructions: INTERPRETATION_SYSTEM_PROMPT,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Convert this driver-qualification guideline into the rule tree schema.

Condition types available (use these exactly):
  { "type": "min_experience_months", "months": number }
  { "type": "min_age_years", "years": number }
  { "type": "max_events", "category": CATEGORY, "lookbackMonths": number, "max": number }
  { "type": "max_points", "basis": "state" | "mvr_activity", "lookbackMonths": number, "max": number }
  { "type": "license_status_in", "statuses": ["Valid" | "Expired" | "Suspended" | "Revoked" | "Disqualified"] }
  { "type": "cdl_class_in", "classes": ["A", "B", "C"] }
  { "type": "requires_valid_medical_card" }
  { "type": "max_suspensions", "lookbackMonths": number, "max": number }

CATEGORY is one of: moving_violation, minor_moving_violation, serious_moving_violation, major_moving_violation, accident, at_fault_accident, administrative`,
              },
              ...files.map((f) =>
                f.mimeType === 'application/pdf'
                  ? { type: 'input_file', filename: f.name, file_data: `data:${f.mimeType};base64,${f.base64}` }
                  : { type: 'input_image', image_url: `data:${f.mimeType};base64,${f.base64}` },
              ),
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'guideline_rule_tree',
            strict: false,
            schema: z.toJSONSchema(interpretationSchema),
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        ruleSet: null,
        warnings: [],
        errors: [`The interpretation service returned ${response.status}. ${body.slice(0, 400)}`],
        modelUsed: model,
      };
    }

    const json = (await response.json()) as { output_text?: string; output?: unknown };
    const text =
      json.output_text ??
      (Array.isArray(json.output)
        ? (json.output as Array<{ content?: Array<{ text?: string }> }>)
            .flatMap((o) => o.content ?? [])
            .map((c) => c.text ?? '')
            .join('')
        : '');

    const parsed = interpretationSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return {
        ok: false,
        ruleSet: null,
        warnings: [],
        errors: [
          'The interpretation did not match the required shape. Nothing was saved.',
          ...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        ],
        modelUsed: model,
      };
    }

    const draft = buildDraft(parsed.data);
    return { ...draft, modelUsed: model };
  } catch (error) {
    return {
      ok: false,
      ruleSet: null,
      warnings: [],
      errors: [
        `Could not reach the interpretation service: ${error instanceof Error ? error.message : String(error)}. Write the criteria by hand, or retry once connectivity is restored.`,
      ],
      modelUsed: model,
    };
  }
}
