import type { DriverEvidence } from '@/domain/types';
import type { RuleSet } from '@/domain/guideline';

/**
 * The boundary between this application and whichever AI vendor reads documents.
 *
 * Everything below this line is replaceable; nothing above it may depend on a
 * particular vendor. The database schema, normalised evidence, deterministic
 * rules, audit records and user interface must be identical whichever provider
 * is configured — which is only true if providers can express exactly these
 * three operations and nothing more.
 *
 * Note what is absent: there is no `decide` method. Providers transcribe and
 * interpret documents. The qualification decision is made in `domain/engine.ts`
 * from the returned evidence, and no provider can reach it.
 */

export interface SecureFile {
  name: string;
  mimeType: string;
  /** Base64 contents. Files are never persisted by the provider layer. */
  base64: string;
}

export interface ProviderOutcome<T> {
  ok: boolean;
  value: T | null;
  warnings: string[];
  /** Actionable messages. Never a raw stack trace or a credential. */
  errors: string[];
  /** For the audit record, so a past decision names the model that read it. */
  modelUsed: string | null;
}

export interface CoverageEvidence {
  coverageType: string | null;
  carrier: string | null;
  policyNumber: string | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  limits: string | null;
}

export interface DocumentIntelligenceProvider {
  /** Identifier stored on evaluations for reproducibility. */
  readonly name: string;

  /** Reads CDL, MVR, PSP and medical documents as one evidence package. */
  extractDriverEvidence(files: SecureFile[]): Promise<ProviderOutcome<DriverEvidence>>;

  /** Drafts a rule tree from a guideline document. Never self-approving. */
  extractGuideline(files: SecureFile[]): Promise<ProviderOutcome<RuleSet>>;

  /** Reads a certificate of insurance. */
  extractCertificateOfInsurance(files: SecureFile[]): Promise<ProviderOutcome<CoverageEvidence[]>>;
}

/** Returned when no provider is configured, so callers get a usable message. */
export function unconfigured<T>(what: string): ProviderOutcome<T> {
  return {
    ok: false,
    value: null,
    warnings: [],
    errors: [
      `No document-intelligence provider is configured, so ${what} cannot be read automatically. Add a key under Settings → Integrations, or enter the details by hand.`,
    ],
    modelUsed: null,
  };
}
