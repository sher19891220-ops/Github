import { z } from 'zod';
import { isValidIsoDate } from '@/domain/dates';
import {
  CURRENT_EXTRACTION_FORMAT_VERSION,
  emptyEvidence,
  type CdlIssueDateCandidate,
  type DriverEvidence,
  type SourceDocument,
} from '@/domain/types';

const sourceDocument = z.enum(['CDL', 'MVR', 'PSP', 'Other']);

export const extractionSchema = z.object({
  mvr_order_date: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  cdl_number: z.string().nullable(),
  cdl_state: z.string().nullable(),
  cdl_class: z.string().nullable(),
  /**
   * Every issue date seen anywhere, each with the document it came from and the
   * label exactly as printed. The choice between them is made in application
   * code, not here — the model's job is to report what each document says.
   */
  cdl_issue_date_candidates: z.array(
    z.object({
      date: z.string(),
      source_document: sourceDocument,
      printed_label: z.string(),
      explicitly_original: z.boolean(),
    }),
  ),
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
      source_document: sourceDocument,
      /** True for PSP roadside inspections, which are not convictions. */
      is_inspection: z.boolean(),
    }),
  ),
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

function coerceDate(value: string | null, field: string, warnings: string[]): string | null {
  if (!value) return null;
  if (isValidIsoDate(value)) return value;
  warnings.push(
    `${field} was returned as "${value}", which is not a valid YYYY-MM-DD date; it has been dropped.`,
  );
  return null;
}

/** Converts a validated payload into the engine's evidence shape. */
export function toEvidence(payload: ExtractionPayload): DriverEvidence {
  const warnings = [...payload.warnings];

  const candidates: CdlIssueDateCandidate[] = [];
  for (const [index, candidate] of payload.cdl_issue_date_candidates.entries()) {
    const date = coerceDate(candidate.date, `CDL issue date candidate ${index + 1}`, warnings);
    if (!date) continue;
    candidates.push({
      date,
      sourceDocument: candidate.source_document as SourceDocument,
      printedLabel: candidate.printed_label,
      explicitlyOriginal: candidate.explicitly_original,
    });
  }

  return {
    ...emptyEvidence(),
    extractionFormatVersion: CURRENT_EXTRACTION_FORMAT_VERSION,
    mvrOrderDate: coerceDate(payload.mvr_order_date, 'MVR order date', warnings),
    dateOfBirth: coerceDate(payload.date_of_birth, 'Date of birth', warnings),
    cdlNumber: payload.cdl_number,
    cdlState: payload.cdl_state,
    cdlClass: payload.cdl_class,
    cdlIssueDateCandidates: candidates,
    // Left null: the resolved date is derived from the candidates by the
    // documented precedence, never taken as a loose field.
    cdlOriginalIssueDate: null,
    cdlCurrentIssueDate: coerceDate(
      payload.cdl_current_issue_date,
      'Current CDL issue date',
      warnings,
    ),
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
      eventType: 'Unknown' as const,
      severity: 'Unknown' as const,
      atFault: null,
      preventable: null,
      source: e.source_document as SourceDocument,
      isInspection: e.is_inspection,
      majorClassification: null,
    })),
    suspensions: payload.explicit_suspensions.map((s, index) => ({
      id: `susp_${index}`,
      description: s.description,
      startDate: coerceDate(s.start_date, `Suspension ${index + 1} start date`, warnings),
      endDate: coerceDate(s.end_date, `Suspension ${index + 1} end date`, warnings),
      reinstatedDate: coerceDate(
        s.reinstated_date,
        `Suspension ${index + 1} reinstated date`,
        warnings,
      ),
      state: s.state,
      source: 'explicit_document_record' as const,
    })),
    reportedExperienceMonths: null,
    confidence: payload.field_confidence,
    warnings,
  };
}
