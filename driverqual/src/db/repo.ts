import type { Database } from 'better-sqlite3';
import { newId, nowIso, todayIso } from './ids';
import {
  evaluateCoverage,
  overallDecision,
  type CoverageEvaluation,
  type OverallDecision,
} from '@/domain/engine';
import { guidelineSchema, type Guideline } from '@/domain/guideline';
import {
  COVERAGE_TYPES,
  CURRENT_EXTRACTION_FORMAT_VERSION,
  emptyEvidence,
  type CoverageType,
  type Decision,
  type DriverEvidence,
} from '@/domain/types';
import { daysBetween } from '@/domain/dates';

/* ------------------------------------------------------------------ *
 * Audit — append only
 * ------------------------------------------------------------------ */

export interface AuditInput {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  companyId?: string | null;
  detail?: unknown;
}

export function recordAudit(db: Database, input: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, company_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('aud'),
    input.actor,
    input.action,
    input.entityType,
    input.entityId,
    input.companyId ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    nowIso(),
  );
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  companyId: string | null;
  detail: unknown;
  createdAt: string;
}

export function listAuditEvents(db: Database, limit = 200): AuditEvent[] {
  const rows = db
    .prepare(`SELECT * FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    actor: r['actor'] as string,
    action: r['action'] as string,
    entityType: r['entity_type'] as string,
    entityId: r['entity_id'] as string,
    companyId: (r['company_id'] as string | null) ?? null,
    detail: r['detail'] ? JSON.parse(r['detail'] as string) : null,
    createdAt: r['created_at'] as string,
  }));
}

/* ------------------------------------------------------------------ *
 * Companies
 * ------------------------------------------------------------------ */

export interface Company {
  id: string;
  name: string;
  dba: string | null;
  status: string;
  usdotNumber: string | null;
  mcNumber: string | null;
  address: string | null;
  contact: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapCompany(r: Record<string, unknown>): Company {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    dba: (r['dba'] as string | null) ?? null,
    status: r['status'] as string,
    usdotNumber: (r['usdot_number'] as string | null) ?? null,
    mcNumber: (r['mc_number'] as string | null) ?? null,
    address: (r['address'] as string | null) ?? null,
    contact: (r['contact'] as string | null) ?? null,
    notes: (r['notes'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
  };
}

export function createCompany(
  db: Database,
  input: Partial<Company> & { name: string },
  actor = 'system',
): Company {
  const id = newId('co');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO companies (id, name, dba, status, usdot_number, mc_number, address, contact, notes, created_at, updated_at)
     VALUES (@id, @name, @dba, @status, @usdot, @mc, @address, @contact, @notes, @ts, @ts)`,
  ).run({
    id,
    name: input.name,
    dba: input.dba ?? null,
    status: input.status ?? 'active',
    usdot: input.usdotNumber ?? null,
    mc: input.mcNumber ?? null,
    address: input.address ?? null,
    contact: input.contact ?? null,
    notes: input.notes ?? null,
    ts,
  });
  recordAudit(db, {
    actor,
    action: 'company.create',
    entityType: 'company',
    entityId: id,
    companyId: id,
    detail: { name: input.name },
  });
  return getCompany(db, id)!;
}

export function getCompany(db: Database, id: string): Company | null {
  const row = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapCompany(row) : null;
}

export function listCompanies(db: Database): Company[] {
  const rows = db.prepare(`SELECT * FROM companies ORDER BY name`).all() as Array<
    Record<string, unknown>
  >;
  return rows.map(mapCompany);
}

export interface CompanyCard extends Company {
  guidelineCount: number;
  activeCoverageCount: number;
  applicantCount: number;
  coverageTags: CoverageType[];
}

export function listCompanyCards(db: Database): CompanyCard[] {
  return listCompanies(db).map((company) => {
    const guidelines = listGuidelines(db, { companyId: company.id, status: 'active' });
    const coverages = db
      .prepare(`SELECT coverage_type FROM coverages WHERE company_id = ?`)
      .all(company.id) as Array<{ coverage_type: string }>;
    const applicants = db
      .prepare(`SELECT COUNT(*) AS n FROM applicants WHERE company_id = ?`)
      .get(company.id) as { n: number };
    return {
      ...company,
      guidelineCount: guidelines.length,
      activeCoverageCount: coverages.length,
      applicantCount: applicants.n,
      coverageTags: Array.from(
        new Set([
          ...coverages.map((c) => c.coverage_type as CoverageType),
          ...guidelines.map((g) => g.coverageType),
        ]),
      ),
    };
  });
}

export interface CompanyDeletionImpact {
  applicants: number;
  guidelines: number;
  coverages: number;
  evaluations: number;
}

export function companyDeletionImpact(db: Database, companyId: string): CompanyDeletionImpact {
  const one = (sql: string) => (db.prepare(sql).get(companyId) as { n: number }).n;
  return {
    applicants: one(`SELECT COUNT(*) AS n FROM applicants WHERE company_id = ?`),
    guidelines: one(`SELECT COUNT(*) AS n FROM guidelines WHERE company_id = ?`),
    coverages: one(`SELECT COUNT(*) AS n FROM coverages WHERE company_id = ?`),
    evaluations: one(`SELECT COUNT(*) AS n FROM coverage_evaluations WHERE company_id = ?`),
  };
}

/**
 * Deleting a company is refused while applicants still point at it — those
 * drivers would lose their applying company silently. Guidelines, coverages and
 * this company's evaluations cascade; no other company's data is touched.
 */
export function deleteCompany(
  db: Database,
  companyId: string,
  actor = 'system',
): { ok: true } | { ok: false; error: string; impact: CompanyDeletionImpact } {
  const impact = companyDeletionImpact(db, companyId);
  if (impact.applicants > 0) {
    return {
      ok: false,
      error: `${impact.applicants} applicant(s) still list this company as their applying company. Reassign or remove them first.`,
      impact,
    };
  }
  recordAudit(db, {
    actor,
    action: 'company.delete',
    entityType: 'company',
    entityId: companyId,
    companyId,
    detail: impact,
  });
  db.prepare(`DELETE FROM companies WHERE id = ?`).run(companyId);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Guidelines
 * ------------------------------------------------------------------ */

function mapGuideline(r: Record<string, unknown>): Guideline {
  return guidelineSchema.parse({
    id: r['id'],
    companyId: r['company_id'],
    coverageType: r['coverage_type'],
    version: r['version'],
    status: r['status'],
    effectiveDate: r['effective_date'] ?? null,
    expirationDate: r['expiration_date'] ?? null,
    carrier: r['carrier'] ?? null,
    policyNumber: r['policy_number'] ?? null,
    fileName: r['file_name'] ?? null,
    usedForDriverQualification: Boolean(r['used_for_driver_qualification']),
    reviewStatus: r['review_status'],
    ruleSet: r['rule_set'] ? JSON.parse(r['rule_set'] as string) : null,
  });
}

export function listGuidelines(
  db: Database,
  filter: { companyId?: string; coverageType?: CoverageType; status?: string } = {},
): Guideline[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.companyId) {
    clauses.push('company_id = ?');
    params.push(filter.companyId);
  }
  if (filter.coverageType) {
    clauses.push('coverage_type = ?');
    params.push(filter.coverageType);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM guidelines ${where} ORDER BY coverage_type, created_at DESC`)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapGuideline);
}

export function getActiveGuideline(
  db: Database,
  companyId: string,
  coverageType: CoverageType,
): Guideline | null {
  const row = db
    .prepare(
      `SELECT * FROM guidelines WHERE company_id = ? AND coverage_type = ? AND status = 'active'`,
    )
    .get(companyId, coverageType) as Record<string, unknown> | undefined;
  return row ? mapGuideline(row) : null;
}

export interface GuidelineInput {
  companyId: string;
  coverageType: CoverageType;
  version?: string;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  carrier?: string | null;
  policyNumber?: string | null;
  fileName?: string | null;
  storageKey?: string | null;
  usedForDriverQualification?: boolean;
  reviewStatus?: Guideline['reviewStatus'];
  ruleSet?: unknown;
}

/**
 * Adds a guideline, archiving any guideline it replaces for the same company and
 * coverage. Version history is preserved: the old row stays, marked archived and
 * linked from the new one.
 */
export function createGuideline(db: Database, input: GuidelineInput, actor = 'system'): Guideline {
  const existing = getActiveGuideline(db, input.companyId, input.coverageType);
  const id = newId('gl');
  const ts = nowIso();
  const version =
    input.version ?? (existing ? String(Number(existing.version || '0') + 1) : '1');

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(`UPDATE guidelines SET status = 'archived', updated_at = ? WHERE id = ?`).run(
        ts,
        existing.id,
      );
    }
    db.prepare(
      `INSERT INTO guidelines (id, company_id, coverage_type, version, status, effective_date,
         expiration_date, carrier, policy_number, file_name, storage_key,
         used_for_driver_qualification, review_status, rule_set, supersedes_id, created_at, updated_at)
       VALUES (@id, @companyId, @coverageType, @version, 'active', @effectiveDate, @expirationDate,
         @carrier, @policyNumber, @fileName, @storageKey, @used, @reviewStatus, @ruleSet, @supersedes, @ts, @ts)`,
    ).run({
      id,
      companyId: input.companyId,
      coverageType: input.coverageType,
      version,
      effectiveDate: input.effectiveDate ?? null,
      expirationDate: input.expirationDate ?? null,
      carrier: input.carrier ?? null,
      policyNumber: input.policyNumber ?? null,
      fileName: input.fileName ?? null,
      storageKey: input.storageKey ?? null,
      used: input.usedForDriverQualification === false ? 0 : 1,
      reviewStatus: input.reviewStatus ?? (input.ruleSet ? 'awaiting_approval' : 'pending_interpretation'),
      ruleSet: input.ruleSet ? JSON.stringify(input.ruleSet) : null,
      supersedes: existing?.id ?? null,
      ts,
    });
  });
  tx();

  recordAudit(db, {
    actor,
    action: existing ? 'guideline.replace' : 'guideline.create',
    entityType: 'guideline',
    entityId: id,
    companyId: input.companyId,
    detail: { coverageType: input.coverageType, version, replaced: existing?.id ?? null },
  });

  return listGuidelines(db, { companyId: input.companyId }).find((g) => g.id === id)!;
}

export function approveGuideline(db: Database, guidelineId: string, actor = 'system'): void {
  db.prepare(`UPDATE guidelines SET review_status = 'approved', updated_at = ? WHERE id = ?`).run(
    nowIso(),
    guidelineId,
  );
  recordAudit(db, {
    actor,
    action: 'guideline.approve',
    entityType: 'guideline',
    entityId: guidelineId,
  });
}

/** Archives rather than destroys, so past evaluations remain reproducible. */
export function removeGuideline(db: Database, guidelineId: string, actor = 'system'): void {
  const row = db.prepare(`SELECT company_id FROM guidelines WHERE id = ?`).get(guidelineId) as
    | { company_id: string }
    | undefined;
  db.prepare(`UPDATE guidelines SET status = 'archived', updated_at = ? WHERE id = ?`).run(
    nowIso(),
    guidelineId,
  );
  recordAudit(db, {
    actor,
    action: 'guideline.remove',
    entityType: 'guideline',
    entityId: guidelineId,
    companyId: row?.company_id ?? null,
  });
}

/* ------------------------------------------------------------------ *
 * Applicants and evidence
 * ------------------------------------------------------------------ */

export interface Applicant {
  id: string;
  companyId: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  cdlNumber: string | null;
  cdlState: string | null;
  cdlClass: string | null;
  driverType: string | null;
  recruiter: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapApplicant(r: Record<string, unknown>): Applicant {
  return {
    id: r['id'] as string,
    companyId: r['company_id'] as string,
    firstName: r['first_name'] as string,
    middleName: (r['middle_name'] as string | null) ?? null,
    lastName: r['last_name'] as string,
    dateOfBirth: (r['date_of_birth'] as string | null) ?? null,
    phone: (r['phone'] as string | null) ?? null,
    email: (r['email'] as string | null) ?? null,
    cdlNumber: (r['cdl_number'] as string | null) ?? null,
    cdlState: (r['cdl_state'] as string | null) ?? null,
    cdlClass: (r['cdl_class'] as string | null) ?? null,
    driverType: (r['driver_type'] as string | null) ?? null,
    recruiter: (r['recruiter'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
  };
}

export function createApplicant(
  db: Database,
  input: Omit<Partial<Applicant>, 'id'> & { companyId: string; firstName: string; lastName: string },
  evidence: DriverEvidence,
  actor = 'system',
): Applicant {
  if (!getCompany(db, input.companyId)) {
    throw new Error(`Unknown company ${input.companyId}`);
  }
  const id = newId('ap');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO applicants (id, company_id, first_name, middle_name, last_name, date_of_birth,
       phone, email, cdl_number, cdl_state, cdl_class, driver_type, recruiter, created_at, updated_at)
     VALUES (@id, @companyId, @firstName, @middleName, @lastName, @dob, @phone, @email,
       @cdlNumber, @cdlState, @cdlClass, @driverType, @recruiter, @ts, @ts)`,
  ).run({
    id,
    companyId: input.companyId,
    firstName: input.firstName,
    middleName: input.middleName ?? null,
    lastName: input.lastName,
    dob: input.dateOfBirth ?? evidence.dateOfBirth ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    cdlNumber: input.cdlNumber ?? evidence.cdlNumber ?? null,
    cdlState: input.cdlState ?? evidence.cdlState ?? null,
    cdlClass: input.cdlClass ?? evidence.cdlClass ?? null,
    driverType: input.driverType ?? null,
    recruiter: input.recruiter ?? null,
    ts,
  });

  saveEvidence(db, id, evidence, actor);
  recordAudit(db, {
    actor,
    action: 'applicant.create',
    entityType: 'applicant',
    entityId: id,
    companyId: input.companyId,
  });
  return getApplicant(db, id)!;
}

export function getApplicant(db: Database, id: string): Applicant | null {
  const row = db.prepare(`SELECT * FROM applicants WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapApplicant(row) : null;
}

export function listApplicants(db: Database, companyId?: string): Applicant[] {
  const rows = companyId
    ? (db
        .prepare(`SELECT * FROM applicants WHERE company_id = ? ORDER BY created_at DESC`)
        .all(companyId) as Array<Record<string, unknown>>)
    : (db.prepare(`SELECT * FROM applicants ORDER BY created_at DESC`).all() as Array<
        Record<string, unknown>
      >);
  return rows.map(mapApplicant);
}

export function deleteApplicant(db: Database, id: string, actor = 'system'): void {
  const applicant = getApplicant(db, id);
  db.prepare(`DELETE FROM applicants WHERE id = ?`).run(id);
  recordAudit(db, {
    actor,
    action: 'applicant.delete',
    entityType: 'applicant',
    entityId: id,
    companyId: applicant?.companyId ?? null,
  });
}

/** Appends a new evidence snapshot and marks it current. Prior rows are kept. */
export function saveEvidence(
  db: Database,
  applicantId: string,
  evidence: DriverEvidence,
  actor = 'system',
): string {
  const id = newId('ev');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE applicant_evidence SET is_current = 0 WHERE applicant_id = ?`).run(
      applicantId,
    );
    db.prepare(
      `INSERT INTO applicant_evidence (id, applicant_id, extraction_format_version, payload, is_current, verified_by, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      applicantId,
      evidence.extractionFormatVersion,
      JSON.stringify(evidence),
      actor,
      nowIso(),
    );
  });
  tx();
  recordAudit(db, {
    actor,
    action: 'evidence.save',
    entityType: 'applicant',
    entityId: applicantId,
    detail: { evidenceId: id, formatVersion: evidence.extractionFormatVersion },
  });
  return id;
}

export function getCurrentEvidence(
  db: Database,
  applicantId: string,
): { id: string; evidence: DriverEvidence } | null {
  const row = db
    .prepare(`SELECT id, payload FROM applicant_evidence WHERE applicant_id = ? AND is_current = 1`)
    .get(applicantId) as { id: string; payload: string } | undefined;
  if (!row) return null;
  return { id: row.id, evidence: { ...emptyEvidence(), ...JSON.parse(row.payload) } };
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

export interface ApplicantEvaluation {
  companyId: string;
  companyName: string;
  coverages: CoverageEvaluation[];
  overall: OverallDecision;
  evaluatedAt: string;
}

/**
 * Evaluates one applicant against one company, writing one row per coverage.
 *
 * Rows for every other company are left untouched — the delete/insert below is
 * scoped by company_id, so a re-evaluation for Zone can never disturb Xtrack's
 * stored result.
 */
export function evaluateApplicantForCompany(
  db: Database,
  applicantId: string,
  companyId: string,
  options: { evaluationDate?: string; actor?: string } = {},
): ApplicantEvaluation {
  const actor = options.actor ?? 'system';
  const evaluationDate = options.evaluationDate ?? todayIso();
  const applicant = getApplicant(db, applicantId);
  if (!applicant) throw new Error(`Unknown applicant ${applicantId}`);
  const company = getCompany(db, companyId);
  if (!company) throw new Error(`Unknown company ${companyId}`);

  const current = getCurrentEvidence(db, applicantId);
  const evidence = current?.evidence ?? {
    ...emptyEvidence(),
    extractionFormatVersion: CURRENT_EXTRACTION_FORMAT_VERSION,
  };

  const coverages = COVERAGE_TYPES.map((coverageType) =>
    evaluateCoverage({
      companyId,
      coverageType,
      guideline: getActiveGuideline(db, companyId, coverageType),
      evidence,
      evaluationDate,
    }),
  );

  const overall = overallDecision(coverages, company.name);
  const evaluatedAt = nowIso();

  const tx = db.transaction(() => {
    for (const result of coverages) {
      db.prepare(
        `INSERT INTO coverage_evaluations (id, applicant_id, company_id, coverage_type, decision, reason,
           guideline_id, guideline_version, evidence_id, engine_version, extraction_format_version,
           model_version, result_json, evaluated_at)
         VALUES (@id, @applicantId, @companyId, @coverageType, @decision, @reason, @guidelineId,
           @guidelineVersion, @evidenceId, @engineVersion, @extractionFormatVersion, NULL, @resultJson, @evaluatedAt)
         ON CONFLICT(applicant_id, company_id, coverage_type) DO UPDATE SET
           decision = excluded.decision,
           reason = excluded.reason,
           guideline_id = excluded.guideline_id,
           guideline_version = excluded.guideline_version,
           evidence_id = excluded.evidence_id,
           engine_version = excluded.engine_version,
           extraction_format_version = excluded.extraction_format_version,
           result_json = excluded.result_json,
           evaluated_at = excluded.evaluated_at`,
      ).run({
        id: newId('ce'),
        applicantId,
        companyId,
        coverageType: result.coverageType,
        decision: result.decision,
        reason: result.reason,
        guidelineId: result.guidelineId,
        guidelineVersion: result.guidelineVersion,
        evidenceId: current?.id ?? null,
        engineVersion: result.engineVersion,
        extractionFormatVersion: result.extractionFormatVersion,
        resultJson: JSON.stringify(result),
        evaluatedAt,
      });
    }
  });
  tx();

  recordAudit(db, {
    actor,
    action: 'applicant.evaluate',
    entityType: 'applicant',
    entityId: applicantId,
    companyId,
    detail: { overall: overall.decision, evaluationDate },
  });

  return { companyId, companyName: company.name, coverages, overall, evaluatedAt };
}

export function getStoredEvaluation(
  db: Database,
  applicantId: string,
  companyId: string,
): { coverages: CoverageEvaluation[]; overall: OverallDecision; evaluatedAt: string | null } {
  const rows = db
    .prepare(
      `SELECT result_json, evaluated_at FROM coverage_evaluations
       WHERE applicant_id = ? AND company_id = ?`,
    )
    .all(applicantId, companyId) as Array<{ result_json: string; evaluated_at: string }>;
  const coverages = rows.map((r) => JSON.parse(r.result_json) as CoverageEvaluation);
  const company = getCompany(db, companyId);
  return {
    coverages,
    overall: overallDecision(coverages, company?.name),
    evaluatedAt: rows[0]?.evaluated_at ?? null,
  };
}

/** Moving an applicant to another company re-evaluates under the new company only. */
export function setApplicantCompany(
  db: Database,
  applicantId: string,
  companyId: string,
  options: { evaluationDate?: string; actor?: string } = {},
): ApplicantEvaluation {
  const applicant = getApplicant(db, applicantId);
  if (!applicant) throw new Error(`Unknown applicant ${applicantId}`);
  db.prepare(`UPDATE applicants SET company_id = ?, updated_at = ? WHERE id = ?`).run(
    companyId,
    nowIso(),
    applicantId,
  );
  recordAudit(db, {
    actor: options.actor ?? 'system',
    action: 'applicant.change_company',
    entityType: 'applicant',
    entityId: applicantId,
    companyId,
    detail: { from: applicant.companyId, to: companyId },
  });
  return evaluateApplicantForCompany(db, applicantId, companyId, options);
}

export function compareCompanies(
  db: Database,
  applicantId: string,
  companyIds: string[],
  options: { evaluationDate?: string; actor?: string } = {},
): ApplicantEvaluation[] {
  const results = companyIds.map((companyId) =>
    evaluateApplicantForCompany(db, applicantId, companyId, options),
  );
  db.prepare(
    `INSERT INTO comparison_runs (id, applicant_id, company_ids, result_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(newId('cmp'), applicantId, JSON.stringify(companyIds), JSON.stringify(results), nowIso());
  return results;
}

/* ------------------------------------------------------------------ *
 * Coverages and expiration alerts
 * ------------------------------------------------------------------ */

export interface Coverage {
  id: string;
  companyId: string;
  coverageType: CoverageType;
  carrier: string | null;
  policyNumber: string | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  limits: string | null;
}

export function createCoverage(
  db: Database,
  input: Omit<Coverage, 'id'>,
  actor = 'system',
): Coverage {
  const id = newId('cov');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO coverages (id, company_id, coverage_type, carrier, policy_number, effective_date,
       expiration_date, limits, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.companyId,
    input.coverageType,
    input.carrier,
    input.policyNumber,
    input.effectiveDate,
    input.expirationDate,
    input.limits,
    ts,
    ts,
  );
  recordAudit(db, {
    actor,
    action: 'coverage.create',
    entityType: 'coverage',
    entityId: id,
    companyId: input.companyId,
    detail: { coverageType: input.coverageType },
  });
  refreshExpirationAlerts(db, input.companyId);
  return { ...input, id };
}

export function listCoverages(db: Database, companyId?: string): Coverage[] {
  const rows = (
    companyId
      ? db.prepare(`SELECT * FROM coverages WHERE company_id = ? ORDER BY coverage_type`).all(companyId)
      : db.prepare(`SELECT * FROM coverages ORDER BY company_id, coverage_type`).all()
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    companyId: r['company_id'] as string,
    coverageType: r['coverage_type'] as CoverageType,
    carrier: (r['carrier'] as string | null) ?? null,
    policyNumber: (r['policy_number'] as string | null) ?? null,
    effectiveDate: (r['effective_date'] as string | null) ?? null,
    expirationDate: (r['expiration_date'] as string | null) ?? null,
    limits: (r['limits'] as string | null) ?? null,
  }));
}

export interface ExpirationAlert {
  id: string;
  coverageId: string;
  companyId: string;
  severity: 'expired' | 'expiring';
  message: string;
  daysUntil: number;
}

/** Coverage alerts open 90 days out and stay open through expiry. */
export const COVERAGE_ALERT_WINDOW_DAYS = 90;

export function refreshExpirationAlerts(
  db: Database,
  companyId?: string,
  today = todayIso(),
): ExpirationAlert[] {
  const coverages = listCoverages(db, companyId);
  const alerts: ExpirationAlert[] = [];

  for (const coverage of coverages) {
    if (!coverage.expirationDate) continue;
    const daysUntil = daysBetween(today, coverage.expirationDate);
    if (daysUntil > COVERAGE_ALERT_WINDOW_DAYS) continue;

    const severity: ExpirationAlert['severity'] = daysUntil < 0 ? 'expired' : 'expiring';
    const message =
      severity === 'expired'
        ? `${coverage.coverageType} policy ${coverage.policyNumber ?? ''} expired ${coverage.expirationDate} (${Math.abs(daysUntil)} days ago).`.replace(/\s+/g, ' ')
        : `${coverage.coverageType} policy ${coverage.policyNumber ?? ''} expires ${coverage.expirationDate} in ${daysUntil} days.`.replace(/\s+/g, ' ');

    const id = newId('exp');
    db.prepare(
      `INSERT INTO expiration_notifications (id, coverage_id, company_id, severity, message, days_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(coverage_id, severity) DO UPDATE SET message = excluded.message, days_until = excluded.days_until`,
    ).run(id, coverage.id, coverage.companyId, severity, message, daysUntil, nowIso());

    alerts.push({
      id,
      coverageId: coverage.id,
      companyId: coverage.companyId,
      severity,
      message,
      daysUntil,
    });
  }
  return alerts;
}

export function listExpirationAlerts(db: Database): ExpirationAlert[] {
  const rows = db
    .prepare(`SELECT * FROM expiration_notifications WHERE acknowledged = 0 ORDER BY days_until ASC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    coverageId: r['coverage_id'] as string,
    companyId: r['company_id'] as string,
    severity: r['severity'] as ExpirationAlert['severity'],
    message: r['message'] as string,
    daysUntil: r['days_until'] as number,
  }));
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

export interface DashboardRow {
  applicant: Applicant;
  companyName: string;
  coverageDecisions: Partial<Record<CoverageType, Decision>>;
  overall: Decision;
  overallReason: string;
}

export function dashboardRows(db: Database): DashboardRow[] {
  return listApplicants(db).map((applicant) => {
    const stored = getStoredEvaluation(db, applicant.id, applicant.companyId);
    const coverageDecisions: Partial<Record<CoverageType, Decision>> = {};
    for (const c of stored.coverages) coverageDecisions[c.coverageType] = c.decision;
    return {
      applicant,
      companyName: getCompany(db, applicant.companyId)?.name ?? 'Unknown',
      coverageDecisions,
      overall: stored.overall.decision,
      overallReason: stored.overall.reason,
    };
  });
}

export interface DashboardStats {
  totalApplicants: number;
  qualified: number;
  manualReview: number;
  notQualified: number;
  documentsNeedingReview: number;
  coverageAlerts: number;
}

export function dashboardStats(db: Database): DashboardStats {
  const rows = dashboardRows(db);
  const documentsNeedingReview = listApplicants(db).filter((a) => {
    const current = getCurrentEvidence(db, a.id);
    return (
      !current ||
      current.evidence.extractionFormatVersion < CURRENT_EXTRACTION_FORMAT_VERSION ||
      current.evidence.mvrOrderDate === null
    );
  }).length;

  return {
    totalApplicants: rows.length,
    qualified: rows.filter((r) => r.overall === 'Qualified').length,
    manualReview: rows.filter((r) => r.overall === 'Manual Review').length,
    notQualified: rows.filter((r) => r.overall === 'Not Qualified').length,
    documentsNeedingReview,
    coverageAlerts: listExpirationAlerts(db).length,
  };
}
