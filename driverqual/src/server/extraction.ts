import type { Db } from '@/db';
import { getProvider } from './provider';
import { unconfigured } from './provider/types';
import { normalizeEvidence } from '@/domain/evidence';
import type { DriverEvidence } from '@/domain/types';

export { extractionSchema, toEvidence, type ExtractionPayload } from './extraction-schema';
export { EXTRACTION_SYSTEM_PROMPT } from './prompts';

export interface ExtractionResult {
  ok: boolean;
  evidence: DriverEvidence | null;
  warnings: string[];
  errors: string[];
  modelUsed: string | null;
}

/**
 * Reads a driver's documents through whichever provider is configured.
 *
 * With none configured this returns a clear, actionable error rather than
 * placeholder data — a safety file must never contain invented evidence.
 */
export async function extractDocuments(
  db: Db,
  files: Array<{ name: string; mimeType: string; base64: string }>,
): Promise<ExtractionResult> {
  const provider = await getProvider(db);
  if (!provider) {
    const outcome = unconfigured<DriverEvidence>('driver documents');
    return { ok: false, evidence: null, warnings: [], errors: outcome.errors, modelUsed: null };
  }

  if (files.length === 0) {
    return {
      ok: false,
      evidence: null,
      warnings: [],
      errors: ['No documents were supplied.'],
      modelUsed: provider.name,
    };
  }

  const outcome = await provider.extractDriverEvidence(files);
  if (!outcome.ok || !outcome.value) {
    return {
      ok: false,
      evidence: null,
      warnings: outcome.warnings,
      errors: outcome.errors,
      modelUsed: outcome.modelUsed,
    };
  }

  // Surface the same holds the engine would apply, so a reviewer sees them at
  // verification time rather than after saving.
  const normalized = normalizeEvidence(outcome.value, new Date().toISOString().slice(0, 10));

  return {
    ok: true,
    evidence: outcome.value,
    warnings: [...outcome.warnings, ...normalized.blockers.map((b) => b.message)],
    errors: [],
    modelUsed: outcome.modelUsed,
  };
}
