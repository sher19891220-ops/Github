import { z } from 'zod';
import { DECISIONS, type Decision } from './types';
import type { CoverageEvaluation } from './engine';

/**
 * Deterministic guards that sit between generated text and a stored decision.
 *
 * The engine decides; language models only ever describe. These guards enforce
 * that separation: any narrative that contradicts the arithmetic, or any model
 * payload that cites a rule the guideline does not contain, is rejected before
 * it can reach the record.
 */

/* ------------------------------------------------------------------ *
 * Numeric claim guard
 * ------------------------------------------------------------------ */

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  eighteen: 18, twenty: 20, twentyfour: 24, thirty: 30, thirtysix: 36,
};

function toNumber(token: string): number | null {
  const trimmed = token.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const collapsed = trimmed.replace(/[\s-]/g, '');
  return WORD_NUMBERS[collapsed] ?? null;
}

function toMonths(value: number, unit: string): number {
  return /^year/i.test(unit.trim()) ? value * 12 : value;
}

type Comparator = 'lt' | 'gt' | 'gte' | 'lte' | 'eq';

const COMPARATORS: Array<{ pattern: RegExp; comparator: Comparator }> = [
  { pattern: /^(is\s+)?(less\s+than|fewer\s+than|under|below|short\s+of|does\s+not\s+meet|does\s+not\s+satisfy|falls\s+short\s+of)$/i, comparator: 'lt' },
  { pattern: /^(is\s+)?(greater\s+than|more\s+than|over|above|exceeds)$/i, comparator: 'gt' },
  { pattern: /^(is\s+)?(at\s+least|meets|satisfies|no\s+less\s+than|not\s+less\s+than)$/i, comparator: 'gte' },
  { pattern: /^(is\s+)?(at\s+most|no\s+more\s+than|not\s+more\s+than)$/i, comparator: 'lte' },
  { pattern: /^(is\s+)?(equals?|equal\s+to|exactly)$/i, comparator: 'eq' },
];

function resolveComparator(raw: string): Comparator | null {
  for (const c of COMPARATORS) if (c.pattern.test(raw.trim())) return c.comparator;
  return null;
}

export interface NumericClaim {
  text: string;
  leftMonths: number;
  rightMonths: number;
  comparator: Comparator;
  holds: boolean;
}

const UNIT = '(?:months?|years?)';
const NUM = '(?:\\d+(?:\\.\\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty|twenty[\\s-]?four|thirty|thirty[\\s-]?six)';
const COMPARATOR_TEXT =
  '(?:is\\s+)?(?:less\\s+than|fewer\\s+than|under|below|short\\s+of|does\\s+not\\s+meet|does\\s+not\\s+satisfy|falls\\s+short\\s+of|greater\\s+than|more\\s+than|over|above|exceeds|at\\s+least|meets|satisfies|no\\s+less\\s+than|not\\s+less\\s+than|at\\s+most|no\\s+more\\s+than|not\\s+more\\s+than|equals?|equal\\s+to|exactly)';

/**
 * Bridges filler between the two halves of a claim ("28 months, which is less
 * than 2 years") without letting a match run past a sentence boundary or over
 * an intervening month/year figure that belongs to a different comparison.
 */
const FILLER = '(?:(?!\\b(?:months?|years?)\\b)[^.;!?]){0,60}?';

const CLAIM_RE = new RegExp(
  `(${NUM})\\s*(${UNIT})${FILLER}\\b(${COMPARATOR_TEXT})\\s+(?:the\\s+)?(?:required\\s+)?(?:minimum\\s+)?(${NUM})[\\s-]*(${UNIT})`,
  'gi',
);

function holdsUnder(comparator: Comparator, left: number, right: number): boolean {
  switch (comparator) {
    case 'lt': return left < right;
    case 'gt': return left > right;
    case 'gte': return left >= right;
    case 'lte': return left <= right;
    case 'eq': return left === right;
  }
}

/**
 * Finds every "<N> months <comparator> <M> years"-shaped claim in a narrative
 * and checks the arithmetic. Both sides are converted to months first, so
 * "28 months is less than two years" is compared as 28 < 24 and caught.
 */
export function extractNumericClaims(text: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  for (const match of text.matchAll(CLAIM_RE)) {
    const [full, leftNum, leftUnit, comparatorText, rightNum, rightUnit] = match;
    if (!leftNum || !leftUnit || !comparatorText || !rightNum || !rightUnit) continue;

    const left = toNumber(leftNum);
    const right = toNumber(rightNum);
    const comparator = resolveComparator(comparatorText);
    if (left === null || right === null || comparator === null) continue;

    const leftMonths = toMonths(left, leftUnit);
    const rightMonths = toMonths(right, rightUnit);
    claims.push({
      text: full.trim(),
      leftMonths,
      rightMonths,
      comparator,
      holds: holdsUnder(comparator, leftMonths, rightMonths),
    });
  }
  return claims;
}

export interface GuardResult {
  decision: Decision;
  reason: string;
  downgraded: boolean;
  invalidClaims: NumericClaim[];
}

/**
 * A Not Qualified decision whose explanation contains an arithmetically false
 * comparison is downgraded to Manual Review, naming the invalid comparison.
 * A rejection is never allowed to stand on maths that does not hold.
 */
export function applyNumericGuard(decision: Decision, narrative: string): GuardResult {
  const invalidClaims = extractNumericClaims(narrative).filter((c) => !c.holds);

  if (invalidClaims.length === 0) {
    return { decision, reason: narrative, downgraded: false, invalidClaims: [] };
  }

  const listed = invalidClaims
    .map((c) => `"${c.text}" (${c.leftMonths} months vs ${c.rightMonths} months)`)
    .join('; ');

  if (decision === 'Not Qualified') {
    return {
      decision: 'Manual Review',
      reason: `Downgraded from Not Qualified to Manual Review: the explanation contains an invalid numeric comparison — ${listed}. A rejection may not rest on arithmetic that does not hold. Original explanation: ${narrative}`,
      downgraded: true,
      invalidClaims,
    };
  }

  return {
    decision,
    reason: `${narrative}\n\n[Validation warning] Invalid numeric comparison detected in the explanation: ${listed}.`,
    downgraded: false,
    invalidClaims,
  };
}

/* ------------------------------------------------------------------ *
 * Structured model output
 * ------------------------------------------------------------------ */

/**
 * The contract a model must satisfy when it drafts an explanation. Note that
 * `decision` is echoed for cross-checking only — `validateModelExplanation`
 * discards it whenever it disagrees with the engine.
 */
export const modelExplanationSchema = z.object({
  decision: z.enum(DECISIONS),
  reason: z.string().min(1),
  criteria_applied: z.array(z.string()).default([]),
  eligibility_path: z
    .enum(['2-year driver criteria', '1-year driver criteria', 'Under 1 year', 'Not specified'])
    .default('Not specified'),
  minor_violation_count: z.number().int().min(0).default(0),
  maximum_minor_violations: z.number().int().min(0).default(0),
  accident_count: z.number().int().min(0).default(0),
  maximum_accidents: z.number().int().min(0).default(0),
  major_violation_matches: z
    .array(
      z.object({
        event: z.string(),
        matched_category: z.string(),
        guideline_reference: z.string(),
      }),
    )
    .default([]),
  failed_criteria: z.array(z.string()).default([]),
  underwriting_conditions: z.array(z.string()).default([]),
  evidence_used: z.array(z.string()).default([]),
  excluded_evidence: z.array(z.string()).default([]),
  data_gaps: z.array(z.string()).default([]),
});

export type ModelExplanation = z.infer<typeof modelExplanationSchema>;

export interface ExplanationValidation {
  accepted: boolean;
  rejectionReasons: string[];
  explanation: ModelExplanation | null;
}

const VAGUE_PATTERNS = [
  /does not meet (the )?guidelines?\.?$/i,
  /^(not|does not) qualif\w*\.?$/i,
  /^fails? (to )?(meet )?(the )?(criteria|requirements?)\.?$/i,
  /^see guideline\.?$/i,
];

/**
 * Accepts a model-drafted explanation only when it agrees with the engine's
 * decision, cites nothing the guideline does not contain, and says something
 * specific. Anything else is rejected and the deterministic explanation stands.
 */
export function validateModelExplanation(
  raw: unknown,
  evaluation: CoverageEvaluation,
): ExplanationValidation {
  const parsed = modelExplanationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      accepted: false,
      rejectionReasons: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
      explanation: null,
    };
  }

  const explanation = parsed.data;
  const rejectionReasons: string[] = [];

  if (explanation.decision !== evaluation.decision) {
    rejectionReasons.push(
      `Model returned decision "${explanation.decision}" but the engine decided "${evaluation.decision}". The engine's decision is authoritative.`,
    );
  }

  const allowedCriteria = new Set(
    [...evaluation.criteriaApplied, ...evaluation.paths.map((p) => p.label)].map((c) =>
      c.toLowerCase(),
    ),
  );
  for (const cited of explanation.criteria_applied) {
    const known = [...allowedCriteria].some(
      (allowed) => allowed.includes(cited.toLowerCase()) || cited.toLowerCase().includes(allowed),
    );
    if (!known) {
      rejectionReasons.push(
        `Model cited criterion "${cited}", which is not present in the applied guideline.`,
      );
    }
  }

  if (VAGUE_PATTERNS.some((p) => p.test(explanation.reason.trim()))) {
    rejectionReasons.push(
      `Model explanation is too vague to store: "${explanation.reason}".`,
    );
  }

  const guard = applyNumericGuard(evaluation.decision, explanation.reason);
  if (guard.invalidClaims.length > 0) {
    rejectionReasons.push(
      `Model explanation contains an invalid numeric comparison: ${guard.invalidClaims
        .map((c) => c.text)
        .join('; ')}.`,
    );
  }

  // Recomputed independently rather than trusted: a narrative that reports the
  // wrong band or the wrong threshold is describing a different driver than the
  // one the engine decided about, and storing it would make the record lie.
  if (explanation.eligibility_path !== 'Not specified') {
    const engineBand = evaluation.experienceBandLabel;
    if (explanation.eligibility_path !== engineBand) {
      rejectionReasons.push(
        `Model reported eligibility path "${explanation.eligibility_path}" but the driver's ${evaluation.completedExperienceMonths} completed months place them in "${engineBand}".`,
      );
    }
  }

  if (
    explanation.minor_violation_count > explanation.maximum_minor_violations &&
    evaluation.decision === 'Qualified'
  ) {
    rejectionReasons.push(
      `Model reported ${explanation.minor_violation_count} minor violations against a maximum of ${explanation.maximum_minor_violations}, which cannot support a Qualified decision.`,
    );
  }

  if (
    explanation.minor_violation_count <= explanation.maximum_minor_violations &&
    explanation.failed_criteria.some((c) => /minor/i.test(c))
  ) {
    rejectionReasons.push(
      `Model listed a minor-violation failure while reporting ${explanation.minor_violation_count} ≤ ${explanation.maximum_minor_violations}, which passes. A satisfied threshold must not be described as failed.`,
    );
  }

  // A major classification without its authority is exactly the silent
  // strengthening the guideline safeguard exists to prevent.
  for (const match of explanation.major_violation_matches) {
    if (!match.guideline_reference.trim()) {
      rejectionReasons.push(
        `Model classified "${match.event}" as ${match.matched_category} without citing the guideline wording that authorises it.`,
      );
    }
  }

  const engineConditions = new Set(evaluation.underwritingConditions);
  for (const condition of explanation.underwriting_conditions) {
    if (!engineConditions.has(condition)) {
      rejectionReasons.push(
        `Model reported an underwriting condition the applied path does not carry: "${condition}".`,
      );
    }
  }

  return {
    accepted: rejectionReasons.length === 0,
    rejectionReasons,
    explanation: rejectionReasons.length === 0 ? explanation : null,
  };
}
