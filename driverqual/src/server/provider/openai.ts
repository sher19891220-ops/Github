import { z } from 'zod';
import { extractionSchema, toEvidence } from '../extraction-schema';
import { interpretationSchema } from '../interpretation-schema';
import { buildDraft } from '../interpretation';
import type {
  CoverageEvidence,
  DocumentIntelligenceProvider,
  ProviderOutcome,
  SecureFile,
} from './types';
import type { DriverEvidence } from '@/domain/types';
import type { RuleSet } from '@/domain/guideline';
import {
  COI_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT,
  INTERPRETATION_SYSTEM_PROMPT,
  INTERPRETATION_USER_TEXT,
} from '../prompts';

const coiSchema = z.object({
  coverages: z.array(
    z.object({
      coverage_type: z.string().nullable(),
      carrier: z.string().nullable(),
      policy_number: z.string().nullable(),
      effective_date: z.string().nullable(),
      expiration_date: z.string().nullable(),
      limits: z.string().nullable(),
    }),
  ),
  warnings: z.array(z.string()).default([]),
});

/** OpenAI Responses API implementation of the provider contract. */
export class OpenAiProvider implements DocumentIntelligenceProvider {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.name = `openai:${model}`;
  }

  private async call<T extends z.ZodType>(
    instructions: string,
    userText: string,
    files: SecureFile[],
    schema: T,
    schemaName: string,
  ): Promise<{ ok: true; data: z.infer<T> } | { ok: false; errors: string[] }> {
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          instructions,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: userText },
                ...files.map((f) =>
                  f.mimeType === 'application/pdf'
                    ? {
                        type: 'input_file',
                        filename: f.name,
                        file_data: `data:${f.mimeType};base64,${f.base64}`,
                      }
                    : { type: 'input_image', image_url: `data:${f.mimeType};base64,${f.base64}` },
                ),
              ],
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: schemaName,
              strict: false,
              schema: z.toJSONSchema(schema),
            },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          ok: false,
          // The key is in a header, never in the body, so this is safe to surface.
          errors: [`The document service returned ${response.status}. ${body.slice(0, 400)}`],
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

      const parsed = schema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        return {
          ok: false,
          errors: [
            'The document service returned data that does not match the required schema. Nothing was saved.',
            ...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          ],
        };
      }
      return { ok: true, data: parsed.data };
    } catch (error) {
      return {
        ok: false,
        errors: [
          `Could not reach the document service: ${error instanceof Error ? error.message : String(error)}. Enter the details by hand, or retry once connectivity is restored.`,
        ],
      };
    }
  }

  async extractDriverEvidence(files: SecureFile[]): Promise<ProviderOutcome<DriverEvidence>> {
    const result = await this.call(
      EXTRACTION_SYSTEM_PROMPT,
      'Transcribe these driver documents as one evidence package.',
      files,
      extractionSchema,
      'driver_document_extraction',
    );
    if (!result.ok) {
      return { ok: false, value: null, warnings: [], errors: result.errors, modelUsed: this.model };
    }
    const evidence = toEvidence(result.data);
    return {
      ok: true,
      value: evidence,
      warnings: evidence.warnings,
      errors: [],
      modelUsed: this.model,
    };
  }

  async extractGuideline(files: SecureFile[]): Promise<ProviderOutcome<RuleSet>> {
    const result = await this.call(
      INTERPRETATION_SYSTEM_PROMPT,
      INTERPRETATION_USER_TEXT,
      files,
      interpretationSchema,
      'guideline_rule_tree',
    );
    if (!result.ok) {
      return { ok: false, value: null, warnings: [], errors: result.errors, modelUsed: this.model };
    }
    const draft = buildDraft(result.data);
    return {
      ok: draft.ok,
      value: draft.ruleSet,
      warnings: draft.warnings,
      errors: draft.errors,
      modelUsed: this.model,
    };
  }

  async extractCertificateOfInsurance(
    files: SecureFile[],
  ): Promise<ProviderOutcome<CoverageEvidence[]>> {
    const result = await this.call(
      COI_SYSTEM_PROMPT,
      'Transcribe the coverages listed on this certificate of insurance.',
      files,
      coiSchema,
      'certificate_of_insurance',
    );
    if (!result.ok) {
      return { ok: false, value: null, warnings: [], errors: result.errors, modelUsed: this.model };
    }
    return {
      ok: true,
      value: result.data.coverages.map((c) => ({
        coverageType: c.coverage_type,
        carrier: c.carrier,
        policyNumber: c.policy_number,
        effectiveDate: c.effective_date,
        expirationDate: c.expiration_date,
        limits: c.limits,
      })),
      warnings: result.data.warnings,
      errors: [],
      modelUsed: this.model,
    };
  }
}
