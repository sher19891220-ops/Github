import { z } from 'zod';
import { COVERAGE_TYPES } from './types';

/**
 * A guideline is stored twice: the original file (authoritative, immutable) and
 * an interpreted *rule set* (a machine-evaluable rule tree). The rule set is the
 * only thing the engine reads. It is produced by document interpretation and
 * must be reviewed and approved by a human before any decision uses it —
 * `reviewStatus` below is what enforces that.
 *
 * A guideline whose rule set is missing or unapproved yields Manual Review, not
 * a decision, so an unreviewed interpretation can never reject a driver.
 */

export const licenseStatusSchema = z.enum([
  'Valid',
  'Expired',
  'Suspended',
  'Revoked',
  'Disqualified',
  'Unknown',
]);

export const eventCategorySchema = z.enum([
  'moving_violation',           // any moving violation, any severity
  'minor_moving_violation',
  'serious_moving_violation',
  'major_moving_violation',
  'accident',
  'at_fault_accident',
  'administrative',
]);

export type EventCategory = z.infer<typeof eventCategorySchema>;

/**
 * Conditions are tri-state: they can pass, fail, or come back indeterminate
 * when the evidence needed to decide them is absent, stale or low confidence.
 * Indeterminate is what keeps missing evidence out of the Not Qualified bucket.
 */
export const conditionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('min_experience_months'),
    months: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('min_age_years'),
    years: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('max_events'),
    category: eventCategorySchema,
    lookbackMonths: z.number().int().positive(),
    max: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('max_points'),
    basis: z.enum(['state', 'mvr_activity']),
    lookbackMonths: z.number().int().positive(),
    max: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('license_status_in'),
    statuses: z.array(licenseStatusSchema).min(1),
  }),
  z.object({
    type: z.literal('cdl_class_in'),
    classes: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('requires_valid_medical_card'),
  }),
  /**
   * Suspension only ever matters when a guideline carries this condition
   * explicitly. There is no implicit industry-wide suspension rule.
   */
  z.object({
    type: z.literal('max_suspensions'),
    lookbackMonths: z.number().int().positive(),
    max: z.number().int().min(0),
  }),
]);

export type Condition = z.infer<typeof conditionSchema>;

/**
 * One complete way to qualify. A guideline with a two-year path and a one-year
 * path has two entries here; satisfying either one qualifies the driver. The
 * engine never picks the stricter branch to justify a rejection.
 */
export const eligibilityPathSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Verbatim guideline text this path was derived from, for the explanation. */
  sourceText: z.string().default(''),
  conditions: z.array(conditionSchema).min(1),
});

export type EligibilityPath = z.infer<typeof eligibilityPathSchema>;

/** A condition that, when satisfied, disqualifies regardless of any path. */
export const disqualifierSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  sourceText: z.string().default(''),
  condition: conditionSchema,
});

export type Disqualifier = z.infer<typeof disqualifierSchema>;

export const ruleSetSchema = z.object({
  schemaVersion: z.literal(1),
  /**
   * Paths are alternatives (OR). Conditions inside a path are conjunctive (AND).
   */
  eligibilityPaths: z.array(eligibilityPathSchema).min(1),
  disqualifiers: z.array(disqualifierSchema).default([]),
  /** Free-text notes carried into the explanation; never evaluated. */
  notes: z.string().default(''),
});

export type RuleSet = z.infer<typeof ruleSetSchema>;

export const guidelineSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  coverageType: z.enum(COVERAGE_TYPES),
  version: z.string(),
  status: z.enum(['active', 'archived']),
  effectiveDate: z.string().nullable(),
  expirationDate: z.string().nullable(),
  carrier: z.string().nullable(),
  policyNumber: z.string().nullable(),
  fileName: z.string().nullable(),
  /**
   * False for coverages that are tracked for compliance but play no part in
   * qualifying a driver. Those coverages report Not Evaluated.
   */
  usedForDriverQualification: z.boolean(),
  reviewStatus: z.enum(['pending_interpretation', 'awaiting_approval', 'approved']),
  ruleSet: ruleSetSchema.nullable(),
});

export type Guideline = z.infer<typeof guidelineSchema>;

/**
 * Display name derived from what the record actually has — the guideline form
 * deliberately has no "name" field to fill in wrong.
 */
export function guidelineDisplayName(g: {
  coverageType: string;
  carrier: string | null;
  fileName: string | null;
  version: string;
}): string {
  const parts = [g.coverageType];
  if (g.carrier) parts.push(g.carrier);
  else if (g.fileName) parts.push(g.fileName.replace(/\.[a-z0-9]+$/i, ''));
  return `${parts.join(' — ')} (v${g.version})`;
}

/** A guideline may only drive a decision once it is active and approved. */
export function isEvaluable(g: Guideline): boolean {
  return g.status === 'active' && g.reviewStatus === 'approved' && g.ruleSet !== null;
}

export function parseRuleSet(input: unknown): { ok: true; ruleSet: RuleSet } | { ok: false; errors: string[] } {
  const parsed = ruleSetSchema.safeParse(input);
  if (parsed.success) return { ok: true, ruleSet: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
