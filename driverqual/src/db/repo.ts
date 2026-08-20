import type { Db, Statement } from './index';
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

type Row = Record<string, unknown>;

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

/** Builds the audit insert so it can be included in a caller's transaction. */
function auditStatement(input: AuditInput): Statement {
  return {
    sql: `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, company_id, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('aud'),
      input.actor,
      input.action,
      input.entityType,
      input.entityId,
      input.companyId ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      nowIso(),
    ],
  };
}

export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  const statement = auditStatement(input);
  await db.run(statement.sql, statement.args);
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

export async function listAuditEvents(db: Db, limit = 200): Promise<AuditEvent[]> {
  const rows = await db.all<Row>(
    `SELECT * FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [limit],
  );
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

function mapCompany(r: Row): Company {
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

export async function createCompany(
  db: Db,
  input: Partial<Company> & { name: string },
  actor = 'system',
): Promise<Company> {
  const id = newId('co');
  const ts = nowIso();
  await db.batch([
    {
      sql: `INSERT INTO companies (id, name, dba, status, usdot_number, mc_number, address, contact, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.name,
        input.dba ?? null,
        input.status ?? 'active',
        input.usdotNumber ?? null,
        input.mcNumber ?? null,
        input.address ?? null,
        input.contact ?? null,
        input.notes ?? null,
        ts,
        ts,
      ],
    },
    auditStatement({
      actor,
      action: 'company.create',
      entityType: 'company',
      entityId: id,
      companyId: id,
      detail: { name: input.name },
    }),
  ]);
  return (await getCompany(db, id))!;
}

export async function getCompany(db: Db, id: string): Promise<Company | null> {
  const row = await db.get<Row>(`SELECT * FROM companies WHERE id = ?`, [id]);
  return row ? mapCompany(row) : null;
}

export async function listCompanies(db: Db): Promise<Company[]> {
  const rows = await db.all<Row>(`SELECT * FROM companies ORDER BY name`);
  return rows.map(mapCompany);
}

export interface CompanyCard extends Company {
  guidelineCount: number;
  activeCoverageCount: number;
  applicantCount: number;
  coverageTags: CoverageType[];
}

export async function listCompanyCards(db: Db): Promise<CompanyCard[]> {
  const companies = await listCompanies(db);
  if (companies.length === 0) return [];

  // One query per aggregate rather than per company: a hosted database makes
  // per-row round trips the dominant cost.
  const guidelineRows = await db.all<Row>(
    `SELECT company_id, coverage_type FROM guidelines WHERE status = 'active'`,
  );
  const coverageRows = await db.all<Row>(`SELECT company_id, coverage_type FROM coverages`);
  const applicantRows = await db.all<Row>(
    `SELECT company_id, COUNT(*) AS n FROM applicants GROUP BY company_id`,
  );

  const applicantCounts = new Map(
    applicantRows.map((r) => [r['company_id'] as string, Number(r['n'])]),
  );

  return companies.map((company) => {
    const guidelines = guidelineRows.filter((r) => r['company_id'] === company.id);
    const coverages = coverageRows.filter((r) => r['company_id'] === company.id);
    return {
      ...company,
      guidelineCount: guidelines.length,
      activeCoverageCount: coverages.length,
      applicantCount: applicantCounts.get(company.id) ?? 0,
      coverageTags: Array.from(
        new Set([
          ...coverages.map((r) => r['coverage_type'] as CoverageType),
          ...guidelines.map((r) => r['coverage_type'] as CoverageType),
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

export async function companyDeletionImpact(
  db: Db,
  companyId: string,
): Promise<CompanyDeletionImpact> {
  const count = async (table: string) =>
    Number(
      (await db.get<Row>(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ?`, [companyId]))?.[
        'n'
      ] ?? 0,
    );
  return {
    applicants: await count('applicants'),
    guidelines: await count('guidelines'),
    coverages: await count('coverages'),
    evaluations: await count('coverage_evaluations'),
  };
}

/**
 * Deletes a company and everything belonging to it.
 *
 * Deletion is refused while applicants still point at the company — those
 * drivers would otherwise lose their applying company silently. Child rows are
 * removed explicitly rather than left to `ON DELETE CASCADE`, so the outcome
 * does not depend on whether the engine happens to enforce foreign keys. No
 * other company's data is touched.
 */
export async function deleteCompany(
  db: Db,
  companyId: string,
  actor = 'system',
): Promise<{ ok: true } | { ok: false; error: string; impact: CompanyDeletionImpact }> {
  const impact = await companyDeletionImpact(db, companyId);
  if (impact.applicants > 0) {
    return {
      ok: false,
      error: `${impact.applicants} applicant(s) still list this company as their applying company. Reassign or remove them first.`,
      impact,
    };
  }

  await db.batch([
    auditStatement({
      actor,
      action: 'company.delete',
      entityType: 'company',
      entityId: companyId,
      companyId,
      detail: impact,
    }),
    { sql: `DELETE FROM expiration_notifications WHERE company_id = ?`, args: [companyId] },
    { sql: `DELETE FROM coverage_evaluations WHERE company_id = ?`, args: [companyId] },
    { sql: `DELETE FROM coverages WHERE company_id = ?`, args: [companyId] },
    { sql: `DELETE FROM guidelines WHERE company_id = ?`, args: [companyId] },
    { sql: `DELETE FROM companies WHERE id = ?`, args: [companyId] },
  ]);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Guidelines
 * ------------------------------------------------------------------ */

function mapGuideline(r: Row): Guideline {
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

export async function listGuidelines(
  db: Db,
  filter: { companyId?: string; coverageType?: CoverageType; status?: string } = {},
): Promise<Guideline[]> {
  const clauses: string[] = [];
  const args: Array<string> = [];
  if (filter.companyId) {
    clauses.push('company_id = ?');
    args.push(filter.companyId);
  }
  if (filter.coverageType) {
    clauses.push('coverage_type = ?');
    args.push(filter.coverageType);
  }
  if (filter.status) {
    clauses.push('status = ?');
    args.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.all<Row>(
    `SELECT * FROM guidelines ${where} ORDER BY coverage_type, created_at DESC`,
    args,
  );
  return rows.map(mapGuideline);
}

export async function getActiveGuideline(
  db: Db,
  companyId: string,
  coverageType: CoverageType,
): Promise<Guideline | null> {
  const row = await db.get<Row>(
    `SELECT * FROM guidelines WHERE company_id = ? AND coverage_type = ? AND status = 'active'`,
    [companyId, coverageType],
  );
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
 * Adds a guideline, archiving the one it replaces for the same company and
 * coverage. Version history is preserved: the superseded row stays, marked
 * archived and linked from its replacement, so past evaluations replay exactly.
 */
export async function createGuideline(
  db: Db,
  input: GuidelineInput,
  actor = 'system',
): Promise<Guideline> {
  const existing = await getActiveGuideline(db, input.companyId, input.coverageType);
  const id = newId('gl');
  const ts = nowIso();
  const version = input.version ?? (existing ? String(Number(existing.version || '0') + 1) : '1');

  const statements: Statement[] = [];
  if (existing) {
    statements.push({
      sql: `UPDATE guidelines SET status = 'archived', updated_at = ? WHERE id = ?`,
      args: [ts, existing.id],
    });
  }
  statements.push({
    sql: `INSERT INTO guidelines (id, company_id, coverage_type, version, status, effective_date,
            expiration_date, carrier, policy_number, file_name, storage_key,
            used_for_driver_qualification, review_status, rule_set, supersedes_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.companyId,
      input.coverageType,
      version,
      input.effectiveDate ?? null,
      input.expirationDate ?? null,
      input.carrier ?? null,
      input.policyNumber ?? null,
      input.fileName ?? null,
      input.storageKey ?? null,
      input.usedForDriverQualification === false ? 0 : 1,
      input.reviewStatus ?? (input.ruleSet ? 'awaiting_approval' : 'pending_interpretation'),
      input.ruleSet ? JSON.stringify(input.ruleSet) : null,
      existing?.id ?? null,
      ts,
      ts,
    ],
  });
  statements.push(
    auditStatement({
      actor,
      action: existing ? 'guideline.replace' : 'guideline.create',
      entityType: 'guideline',
      entityId: id,
      companyId: input.companyId,
      detail: { coverageType: input.coverageType, version, replaced: existing?.id ?? null },
    }),
  );

  await db.batch(statements);

  const row = await db.get<Row>(`SELECT * FROM guidelines WHERE id = ?`, [id]);
  return mapGuideline(row!);
}

export async function approveGuideline(
  db: Db,
  guidelineId: string,
  actor = 'system',
): Promise<void> {
  await db.batch([
    {
      sql: `UPDATE guidelines SET review_status = 'approved', updated_at = ? WHERE id = ?`,
      args: [nowIso(), guidelineId],
    },
    auditStatement({
      actor,
      action: 'guideline.approve',
      entityType: 'guideline',
      entityId: guidelineId,
    }),
  ]);
}

/** Archives rather than destroys, so past evaluations remain reproducible. */
export async function removeGuideline(
  db: Db,
  guidelineId: string,
  actor = 'system',
): Promise<void> {
  const row = await db.get<Row>(`SELECT company_id FROM guidelines WHERE id = ?`, [guidelineId]);
  await db.batch([
    {
      sql: `UPDATE guidelines SET status = 'archived', updated_at = ? WHERE id = ?`,
      args: [nowIso(), guidelineId],
    },
    auditStatement({
      actor,
      action: 'guideline.remove',
      entityType: 'guideline',
      entityId: guidelineId,
      companyId: (row?.['company_id'] as string | undefined) ?? null,
    }),
  ]);
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

function mapApplicant(r: Row): Applicant {
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

/** Builds the statements that append a new current evidence snapshot. */
function saveEvidenceStatements(
  applicantId: string,
  evidenceId: string,
  evidence: DriverEvidence,
  actor: string,
): Statement[] {
  return [
    {
      sql: `UPDATE applicant_evidence SET is_current = 0 WHERE applicant_id = ?`,
      args: [applicantId],
    },
    {
      sql: `INSERT INTO applicant_evidence (id, applicant_id, extraction_format_version, payload, is_current, verified_by, created_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)`,
      args: [
        evidenceId,
        applicantId,
        evidence.extractionFormatVersion,
        JSON.stringify(evidence),
        actor,
        nowIso(),
      ],
    },
    auditStatement({
      actor,
      action: 'evidence.save',
      entityType: 'applicant',
      entityId: applicantId,
      detail: { evidenceId, formatVersion: evidence.extractionFormatVersion },
    }),
  ];
}

export async function createApplicant(
  db: Db,
  input: Omit<Partial<Applicant>, 'id'> & { companyId: string; firstName: string; lastName: string },
  evidence: DriverEvidence,
  actor = 'system',
): Promise<Applicant> {
  if (!(await getCompany(db, input.companyId))) {
    throw new Error(`Unknown company ${input.companyId}`);
  }
  const id = newId('ap');
  const evidenceId = newId('ev');
  const ts = nowIso();

  await db.batch([
    {
      sql: `INSERT INTO applicants (id, company_id, first_name, middle_name, last_name, date_of_birth,
              phone, email, cdl_number, cdl_state, cdl_class, driver_type, recruiter, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.companyId,
        input.firstName,
        input.middleName ?? null,
        input.lastName,
        input.dateOfBirth ?? evidence.dateOfBirth ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.cdlNumber ?? evidence.cdlNumber ?? null,
        input.cdlState ?? evidence.cdlState ?? null,
        input.cdlClass ?? evidence.cdlClass ?? null,
        input.driverType ?? null,
        input.recruiter ?? null,
        ts,
        ts,
      ],
    },
    ...saveEvidenceStatements(id, evidenceId, evidence, actor),
    auditStatement({
      actor,
      action: 'applicant.create',
      entityType: 'applicant',
      entityId: id,
      companyId: input.companyId,
    }),
  ]);

  return (await getApplicant(db, id))!;
}

export async function getApplicant(db: Db, id: string): Promise<Applicant | null> {
  const row = await db.get<Row>(`SELECT * FROM applicants WHERE id = ?`, [id]);
  return row ? mapApplicant(row) : null;
}

export async function listApplicants(db: Db, companyId?: string): Promise<Applicant[]> {
  const rows = companyId
    ? await db.all<Row>(`SELECT * FROM applicants WHERE company_id = ? ORDER BY created_at DESC`, [
        companyId,
      ])
    : await db.all<Row>(`SELECT * FROM applicants ORDER BY created_at DESC`);
  return rows.map(mapApplicant);
}

export async function deleteApplicant(db: Db, id: string, actor = 'system'): Promise<void> {
  const applicant = await getApplicant(db, id);
  await db.batch([
    auditStatement({
      actor,
      action: 'applicant.delete',
      entityType: 'applicant',
      entityId: id,
      companyId: applicant?.companyId ?? null,
    }),
    { sql: `DELETE FROM comparison_runs WHERE applicant_id = ?`, args: [id] },
    { sql: `DELETE FROM coverage_evaluations WHERE applicant_id = ?`, args: [id] },
    { sql: `DELETE FROM applicant_evidence WHERE applicant_id = ?`, args: [id] },
    { sql: `DELETE FROM applicant_documents WHERE applicant_id = ?`, args: [id] },
    { sql: `DELETE FROM applicants WHERE id = ?`, args: [id] },
  ]);
}

/** Appends a new evidence snapshot and marks it current. Prior rows are kept. */
export async function saveEvidence(
  db: Db,
  applicantId: string,
  evidence: DriverEvidence,
  actor = 'system',
): Promise<string> {
  const id = newId('ev');
  await db.batch(saveEvidenceStatements(applicantId, id, evidence, actor));
  return id;
}

export async function getCurrentEvidence(
  db: Db,
  applicantId: string,
): Promise<{ id: string; evidence: DriverEvidence } | null> {
  const row = await db.get<Row>(
    `SELECT id, payload FROM applicant_evidence WHERE applicant_id = ? AND is_current = 1`,
    [applicantId],
  );
  if (!row) return null;
  return {
    id: row['id'] as string,
    evidence: { ...emptyEvidence(), ...JSON.parse(row['payload'] as string) },
  };
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
 * Every write is scoped by `company_id`, so a re-evaluation for one company can
 * never disturb another company's stored result.
 */
export async function evaluateApplicantForCompany(
  db: Db,
  applicantId: string,
  companyId: string,
  options: { evaluationDate?: string; actor?: string } = {},
): Promise<ApplicantEvaluation> {
  const actor = options.actor ?? 'system';
  const evaluationDate = options.evaluationDate ?? todayIso();

  const applicant = await getApplicant(db, applicantId);
  if (!applicant) throw new Error(`Unknown applicant ${applicantId}`);
  const company = await getCompany(db, companyId);
  if (!company) throw new Error(`Unknown company ${companyId}`);

  const current = await getCurrentEvidence(db, applicantId);
  const evidence = current?.evidence ?? {
    ...emptyEvidence(),
    extractionFormatVersion: CURRENT_EXTRACTION_FORMAT_VERSION,
  };

  // Load every active guideline for this company in one query, then hand each
  // coverage exactly the one that belongs to it.
  const guidelineRows = await db.all<Row>(
    `SELECT * FROM guidelines WHERE company_id = ? AND status = 'active'`,
    [companyId],
  );
  const byCoverage = new Map<string, Guideline>(
    guidelineRows.map((r) => {
      const guideline = mapGuideline(r);
      return [guideline.coverageType, guideline];
    }),
  );

  const coverages = COVERAGE_TYPES.map((coverageType) =>
    evaluateCoverage({
      companyId,
      coverageType,
      guideline: byCoverage.get(coverageType) ?? null,
      evidence,
      evaluationDate,
    }),
  );

  const overall = overallDecision(coverages, company.name);
  const evaluatedAt = nowIso();

  await db.batch([
    ...coverages.map<Statement>((result) => ({
      sql: `INSERT INTO coverage_evaluations (id, applicant_id, company_id, coverage_type, decision, reason,
              guideline_id, guideline_version, evidence_id, engine_version, extraction_format_version,
              model_version, result_json, evaluated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
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
      args: [
        newId('ce'),
        applicantId,
        companyId,
        result.coverageType,
        result.decision,
        result.reason,
        result.guidelineId,
        result.guidelineVersion,
        current?.id ?? null,
        result.engineVersion,
        result.extractionFormatVersion,
        JSON.stringify(result),
        evaluatedAt,
      ],
    })),
    auditStatement({
      actor,
      action: 'applicant.evaluate',
      entityType: 'applicant',
      entityId: applicantId,
      companyId,
      detail: { overall: overall.decision, evaluationDate },
    }),
  ]);

  return { companyId, companyName: company.name, coverages, overall, evaluatedAt };
}

export async function getStoredEvaluation(
  db: Db,
  applicantId: string,
  companyId: string,
): Promise<{ coverages: CoverageEvaluation[]; overall: OverallDecision; evaluatedAt: string | null }> {
  const rows = await db.all<Row>(
    `SELECT result_json, evaluated_at FROM coverage_evaluations
     WHERE applicant_id = ? AND company_id = ?`,
    [applicantId, companyId],
  );
  const coverages = rows.map((r) => JSON.parse(r['result_json'] as string) as CoverageEvaluation);
  const company = await getCompany(db, companyId);
  return {
    coverages,
    overall: overallDecision(coverages, company?.name),
    evaluatedAt: (rows[0]?.['evaluated_at'] as string | undefined) ?? null,
  };
}

/** Moving an applicant to another company re-evaluates under the new company only. */
export async function setApplicantCompany(
  db: Db,
  applicantId: string,
  companyId: string,
  options: { evaluationDate?: string; actor?: string } = {},
): Promise<ApplicantEvaluation> {
  const applicant = await getApplicant(db, applicantId);
  if (!applicant) throw new Error(`Unknown applicant ${applicantId}`);

  await db.batch([
    {
      sql: `UPDATE applicants SET company_id = ?, updated_at = ? WHERE id = ?`,
      args: [companyId, nowIso(), applicantId],
    },
    auditStatement({
      actor: options.actor ?? 'system',
      action: 'applicant.change_company',
      entityType: 'applicant',
      entityId: applicantId,
      companyId,
      detail: { from: applicant.companyId, to: companyId },
    }),
  ]);

  return evaluateApplicantForCompany(db, applicantId, companyId, options);
}

export async function compareCompanies(
  db: Db,
  applicantId: string,
  companyIds: string[],
  options: { evaluationDate?: string; actor?: string } = {},
): Promise<ApplicantEvaluation[]> {
  const results: ApplicantEvaluation[] = [];
  for (const companyId of companyIds) {
    results.push(await evaluateApplicantForCompany(db, applicantId, companyId, options));
  }
  await db.run(
    `INSERT INTO comparison_runs (id, applicant_id, company_ids, result_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [newId('cmp'), applicantId, JSON.stringify(companyIds), JSON.stringify(results), nowIso()],
  );
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

export async function createCoverage(
  db: Db,
  input: Omit<Coverage, 'id'>,
  actor = 'system',
): Promise<Coverage> {
  const id = newId('cov');
  const ts = nowIso();
  await db.batch([
    {
      sql: `INSERT INTO coverages (id, company_id, coverage_type, carrier, policy_number, effective_date,
              expiration_date, limits, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
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
      ],
    },
    auditStatement({
      actor,
      action: 'coverage.create',
      entityType: 'coverage',
      entityId: id,
      companyId: input.companyId,
      detail: { coverageType: input.coverageType },
    }),
  ]);
  await refreshExpirationAlerts(db, input.companyId);
  return { ...input, id };
}

export async function listCoverages(db: Db, companyId?: string): Promise<Coverage[]> {
  const rows = companyId
    ? await db.all<Row>(`SELECT * FROM coverages WHERE company_id = ? ORDER BY coverage_type`, [
        companyId,
      ])
    : await db.all<Row>(`SELECT * FROM coverages ORDER BY company_id, coverage_type`);
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

export async function refreshExpirationAlerts(
  db: Db,
  companyId?: string,
  today = todayIso(),
): Promise<ExpirationAlert[]> {
  const coverages = await listCoverages(db, companyId);
  const alerts: ExpirationAlert[] = [];
  const statements: Statement[] = [];

  for (const coverage of coverages) {
    if (!coverage.expirationDate) continue;
    const daysUntil = daysBetween(today, coverage.expirationDate);
    if (daysUntil > COVERAGE_ALERT_WINDOW_DAYS) continue;

    const severity: ExpirationAlert['severity'] = daysUntil < 0 ? 'expired' : 'expiring';
    const message = (
      severity === 'expired'
        ? `${coverage.coverageType} policy ${coverage.policyNumber ?? ''} expired ${coverage.expirationDate} (${Math.abs(daysUntil)} days ago).`
        : `${coverage.coverageType} policy ${coverage.policyNumber ?? ''} expires ${coverage.expirationDate} in ${daysUntil} days.`
    ).replace(/\s+/g, ' ');

    const id = newId('exp');
    statements.push({
      sql: `INSERT INTO expiration_notifications (id, coverage_id, company_id, severity, message, days_until, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(coverage_id, severity) DO UPDATE SET message = excluded.message, days_until = excluded.days_until`,
      args: [id, coverage.id, coverage.companyId, severity, message, daysUntil, nowIso()],
    });

    alerts.push({
      id,
      coverageId: coverage.id,
      companyId: coverage.companyId,
      severity,
      message,
      daysUntil,
    });
  }

  await db.batch(statements);
  return alerts;
}

export async function listExpirationAlerts(db: Db): Promise<ExpirationAlert[]> {
  const rows = await db.all<Row>(
    `SELECT * FROM expiration_notifications WHERE acknowledged = 0 ORDER BY days_until ASC`,
  );
  return rows.map((r) => ({
    id: r['id'] as string,
    coverageId: r['coverage_id'] as string,
    companyId: r['company_id'] as string,
    severity: r['severity'] as ExpirationAlert['severity'],
    message: r['message'] as string,
    daysUntil: Number(r['days_until']),
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

export async function dashboardRows(db: Db): Promise<DashboardRow[]> {
  const applicants = await listApplicants(db);
  if (applicants.length === 0) return [];

  const companies = new Map((await listCompanies(db)).map((c) => [c.id, c.name]));

  // Every stored decision in one query, keyed by applicant and company, rather
  // than one query per applicant.
  const evaluationRows = await db.all<Row>(
    `SELECT applicant_id, company_id, coverage_type, decision, result_json FROM coverage_evaluations`,
  );

  return applicants.map((applicant) => {
    const mine = evaluationRows.filter(
      (r) => r['applicant_id'] === applicant.id && r['company_id'] === applicant.companyId,
    );
    const coverageDecisions: Partial<Record<CoverageType, Decision>> = {};
    for (const r of mine) {
      coverageDecisions[r['coverage_type'] as CoverageType] = r['decision'] as Decision;
    }
    const coverages = mine.map((r) => JSON.parse(r['result_json'] as string) as CoverageEvaluation);
    const companyName = companies.get(applicant.companyId) ?? 'Unknown';
    const overall = overallDecision(coverages, companyName);

    return {
      applicant,
      companyName,
      coverageDecisions,
      overall: overall.decision,
      overallReason: overall.reason,
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

export async function dashboardStats(db: Db): Promise<DashboardStats> {
  const rows = await dashboardRows(db);

  const evidenceRows = await db.all<Row>(
    `SELECT applicant_id, extraction_format_version, payload FROM applicant_evidence WHERE is_current = 1`,
  );
  const currentByApplicant = new Map(evidenceRows.map((r) => [r['applicant_id'] as string, r]));

  const documentsNeedingReview = rows.filter(({ applicant }) => {
    const current = currentByApplicant.get(applicant.id);
    if (!current) return true;
    if (Number(current['extraction_format_version']) < CURRENT_EXTRACTION_FORMAT_VERSION) {
      return true;
    }
    const payload = JSON.parse(current['payload'] as string) as Partial<DriverEvidence>;
    return !payload.mvrOrderDate;
  }).length;

  return {
    totalApplicants: rows.length,
    qualified: rows.filter((r) => r.overall === 'Qualified').length,
    manualReview: rows.filter((r) => r.overall === 'Manual Review').length,
    notQualified: rows.filter((r) => r.overall === 'Not Qualified').length,
    documentsNeedingReview,
    coverageAlerts: (await listExpirationAlerts(db)).length,
  };
}
