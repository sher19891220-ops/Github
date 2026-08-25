import { z } from 'zod';

/** What a provider returns when drafting a rule tree: the tree plus its caveats. */
export const interpretationSchema = z.object({
  eligibilityPaths: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      sourceText: z.string(),
      appliesToExperienceBand: z
        .enum(['two_year', 'one_year', 'under_one_year', 'unknown'])
        .nullable()
        .default(null),
      underwritingConditions: z.array(z.string()).default([]),
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
  majorCategoryMappings: z
    .array(
      z.object({
        matches: z.string(),
        category: z.string(),
        guidelineReference: z.string(),
      }),
    )
    .default([]),
  notes: z.string(),
  warnings: z.array(z.string()),
});

export type Interpretation = z.infer<typeof interpretationSchema>;
