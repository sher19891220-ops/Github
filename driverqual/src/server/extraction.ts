import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { getExtractionModel, getSecret, SETTING_KEYS } from './settings';
import {
  CURRENT_EXTRACTION_FORMAT_VERSION,
  emptyEvidence,
  type DriverEvidence,
} from '@/domain/types';
import { normalizeEvidence } from '@/domain/evidence';
import { isValidIsoDate } from '@/domain/dates';

/**
 * Document extraction.
 *
 * The model's only job is to transcribe what a document says into a strict
 * schema. It never classifies severity, never decides anything, and never fills
 * a field it cannot see — every date field is nullable precisely so the model
 * can say "not present" instead of guessing.
 */

export const extractionSchema = z.object({
  mvr_order_date: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  cdl_number: z.string().nullable(),
  cdl_state: z.string().nullable(),
  cdl_class: z.string().nullable(),
  /** Explicitly the first/original issue date, not the current card's. */
  cdl_original_issue_date: z.string().nullable(),
  cdl_current_issue_date: z.string().nullable(),
  cdl_expiration_date: z.string().nullable(),
  license_status: z.enum(['Valid', 'Expired', 'Suspended', 'Revoked', 'Disqualified', 'Unknown']),
  medical_card_present: z.boolean(),
  medical_card_expiration_date: z.string().nullable(),
  events: z.array(
    z.object({
      description: z.string(),
      violation_date: z.string().nullable(),
      conviction_date: z.string().nullable(),
      state: z.string().nullable(),
      state_points: z.number().nullable(),
      mvr_activity_points: z.number().nullable(),
      disposition: z.string().nullable(),
    }),
  ),
  /** Only records the document explicitly labels as suspensions. */
  explicit_suspensions: z.array(
    z.object({
      description: z.string(),
      start_date: z.string().nullable(),
      end_date: z.string().nullable(),
      reinstated_date: z.string().nullable(),
      state: z.string().nullable(),
    }),
  ),
  field_confidence: z.record(z.string(), z.number()).default({}),
  warnings: z.array(z.string()).default([]),
});

export type ExtractionPayload = z.infer<typeof extractionSchema>;

export const EXTRACTION_SYSTEM_PROMPT = `You transcribe United States commercial driver documents (MVR, CDL, driver license, medical examiner's certificate) into a strict JSON schema.

Rules you must follow exactly:
1. Transcribe only what the document states. Never infer, complete, or estimate a value. If a field is not present, return null.
2. cdl_original_issue_date is the FIRST/ORIGINAL CDL issue date ("CDL since", "original issue", "first issued"). Never substitute the current card's issue date, a renewal date, a duplicate/replacement date, an expiration date, or the MVR order date. If the document does not state an original issue date, return null.
3. Copy each violation description verbatim. Do not paraphrase, summarise, expand abbreviations, or merge records.
4. Record a suspension in explicit_suspensions ONLY when the document contains an explicit suspension, revocation, or disqualification record. Never derive one from a violation, a fee, a court entry, a disposition, or a points total.
5. Do not classify severity or decide whether anything counts. Transcription only.
6. All dates must be YYYY-MM-DD. If a document shows only a month and year, return null and add a warning describing what was shown.
7. field_confidence maps field names to 0-1 confidence. Be honest: low confidence for anything faint, handwritten, or ambiguous.`;

export interface ExtractionResult {
  ok: boolean;
  evidence: DriverEvidence | null;
  warnings: string[];
  errors: string[];
  modelUsed: string | null;
}

function coerceDate(value: string | null, field: string, warnings: string[]): string | null {
  if (!value) return null;
  if (isValidIsoDate(value)) return value;
  warnings.push(`${field} was returned as "${value}", which is not a valid YYYY-MM-DD date; it has been dropped.`);
  return null;
}

/** Converts a validated model payload into the engine's evidence shape. */
export function toEvidence(payload: ExtractionPayload): DriverEvidence {
  const warnings = [...payload.warnings];

  const evidence: DriverEvidence = {
    ...emptyEvidence(),
    extractionFormatVersion: CURRENT_EXTRACTION_FORMAT_VERSION,
    mvrOrderDate: coerceDate(payload.mvr_order_date, 'MVR order date', warnings),
    dateOfBirth: coerceDate(payload.date_of_birth, 'Date of birth', warnings),
    cdlNumber: payload.cdl_number,
    cdlState: payload.cdl_state,
    cdlClass: payload.cdl_class,
    cdlOriginalIssueDate: coerceDate(
      payload.cdl_original_issue_date,
      'Original CDL issue date',
      warnings,
    ),
    cdlCurrentIssueDate: coerceDate(payload.cdl_current_issue_date, 'Current CDL issue date', warnings),
    cdlExpirationDate: coerceDate(payload.cdl_expiration_date, 'CDL expiration date', warnings),
    licenseStatus: payload.license_status,
    medicalCard: payload.medical_card_present
      ? {
          present: true,
          expirationDate: coerceDate(
            payload.medical_card_expiration_date,
            'Medical card expiration date',
            warnings,
          ),
          examinerName: null,
        }
      : { present: false, expirationDate: null, examinerName: null },
    events: payload.events.map((e, index) => ({
      id: `ext_${index}`,
      description: e.description,
      violationDate: coerceDate(e.violation_date, `Event ${index + 1} violation date`, warnings),
      convictionDate: coerceDate(e.conviction_date, `Event ${index + 1} conviction date`, warnings),
      state: e.state,
      statePoints: e.state_points,
      mvrActivityPoints: e.mvr_activity_points,
      disposition: e.disposition,
      eventType: 'Unknown',
      severity: 'Unknown',
      atFault: null,
      preventable: null,
    })),
    suspensions: payload.explicit_suspensions.map((s, index) => ({
      id: `susp_${index}`,
      description: s.description,
      startDate: coerceDate(s.start_date, `Suspension ${index + 1} start date`, warnings),
      endDate: coerceDate(s.end_date, `Suspension ${index + 1} end date`, warnings),
      reinstatedDate: coerceDate(s.reinstated_date, `Suspension ${index + 1} reinstated date`, warnings),
      state: s.state,
      source: 'explicit_document_record' as const,
    })),
    reportedExperienceMonths: null,
    confidence: payload.field_confidence,
    warnings,
  };

  return evidence;
}

/**
 * Runs extraction against the configured provider.
 *
 * When no key is configured this returns a clear, actionable error rather than
 * placeholder data — a safety file must never contain invented evidence.
 */
export async function extractDocuments(
  db: Database,
  files: Array<{ name: string; mimeType: string; base64: string }>,
): Promise<ExtractionResult> {
  const apiKey = getSecret(db, SETTING_KEYS.openaiApiKey);
  const model = getExtractionModel(db);

  if (!apiKey) {
    return {
      ok: false,
      evidence: null,
      warnings: [],
      errors: [
        'No OpenAI API key is configured, so documents cannot be read automatically. Add a key under Settings → Integrations, or enter the driver’s evidence manually below.',
      ],
      modelUsed: null,
    };
  }

  if (files.length === 0) {
    return {
      ok: false,
      evidence: null,
      warnings: [],
      errors: ['No documents were supplied.'],
      modelUsed: model,
    };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions: EXTRACTION_SYSTEM_PROMPT,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Transcribe these driver documents.' },
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
            name: 'driver_document_extraction',
            strict: false,
            schema: z.toJSONSchema(extractionSchema),
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        evidence: null,
        warnings: [],
        errors: [
          `The extraction service returned ${response.status}. ${body.slice(0, 400)}`,
        ],
        modelUsed: model,
      };
    }

    const json = (await response.json()) as { output_text?: string; output?: unknown };
    const text =
      json.output_text ??
      // Responses API also returns a structured output array.
      (Array.isArray(json.output)
        ? (json.output as Array<{ content?: Array<{ text?: string }> }>)
            .flatMap((o) => o.content ?? [])
            .map((c) => c.text ?? '')
            .join('')
        : '');

    const parsed = extractionSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return {
        ok: false,
        evidence: null,
        warnings: [],
        errors: [
          'The extraction service returned data that does not match the required schema. Nothing was saved.',
          ...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        ],
        modelUsed: model,
      };
    }

    const evidence = toEvidence(parsed.data);
    const normalized = normalizeEvidence(evidence, new Date().toISOString().slice(0, 10));

    return {
      ok: true,
      evidence,
      warnings: [...evidence.warnings, ...normalized.blockers.map((b) => b.message)],
      errors: [],
      modelUsed: model,
    };
  } catch (error) {
    return {
      ok: false,
      evidence: null,
      warnings: [],
      errors: [
        `Could not reach the extraction service: ${error instanceof Error ? error.message : String(error)}. Enter the driver’s evidence manually, or retry once connectivity is restored.`,
      ],
      modelUsed: model,
    };
  }
}
