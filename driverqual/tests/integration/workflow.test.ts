import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '@/db';
import {
  compareCompanies,
  createApplicant,
  createCompany,
  createCoverage,
  createGuideline,
  dashboardRows,
  dashboardStats,
  deleteCompany,
  evaluateApplicantForCompany,
  getStoredEvaluation,
  listAuditEvents,
  listCompanyCards,
  listExpirationAlerts,
  listGuidelines,
  refreshExpirationAlerts,
  removeGuideline,
  saveEvidence,
  setApplicantCompany,
} from '@/db/repo';
import { CURRENT_EXTRACTION_FORMAT_VERSION } from '@/domain/types';
import {
  XTRACK_AUTO_LIABILITY,
  ZONE_AUTO_LIABILITY,
  fabriceEvidence,
  pheniasEvidence,
} from '../fixtures';

const EVAL_DATE = '2026-08-19';
let db: Db;
let dbFile: string;

async function seedCompanies() {
  const zone = await createCompany(db, { name: 'Zone-OH LLC', usdotNumber: '3456789' }, 'tester');
  const xtrack = await createCompany(db, { name: 'Xtrack LLC', usdotNumber: '9876543' }, 'tester');
  await createGuideline(
    db,
    {
      companyId: zone.id,
      coverageType: 'Auto Liability',
      ruleSet: ZONE_AUTO_LIABILITY,
      reviewStatus: 'approved',
      fileName: 'zone-al.pdf',
    },
    'tester',
  );
  await createGuideline(
    db,
    {
      companyId: xtrack.id,
      coverageType: 'Auto Liability',
      ruleSet: XTRACK_AUTO_LIABILITY,
      reviewStatus: 'approved',
      fileName: 'xtrack-al.pdf',
    },
    'tester',
  );
  return { zone, xtrack };
}

// libSQL has no in-memory mode, so each test gets its own throwaway file.
beforeEach(async () => {
  dbFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'driverqual-test-')),
    'test.db',
  );
  db = await openDatabase(`file:${dbFile}`);
});

afterEach(() => {
  db.close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe('company management', () => {
  it('creates a company and exposes it for the applicant dropdown', async () => {
    const zone = await createCompany(db, { name: 'Zone-OH LLC' });
    const cards = await listCompanyCards(db);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.name).toBe('Zone-OH LLC');
    expect(cards[0]!.applicantCount).toBe(0);
    expect(zone.id).toMatch(/^co_/);
  });

  it('counts guidelines, coverages and applicants on the company card', async () => {
    const { zone } = await seedCompanies();
    await createCoverage(db, {
      companyId: zone.id,
      coverageType: 'Cargo',
      carrier: 'Acme Insurance',
      policyNumber: 'CG-1',
      effectiveDate: '2026-01-01',
      expirationDate: '2027-01-01',
      limits: '$100,000',
    });
    await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );
    const card = (await listCompanyCards(db)).find((c) => c.id === zone.id)!;
    expect(card.guidelineCount).toBe(1);
    expect(card.activeCoverageCount).toBe(1);
    expect(card.applicantCount).toBe(1);
    expect(card.coverageTags).toContain('Cargo');
    expect(card.coverageTags).toContain('Auto Liability');
  });

  it('refuses to delete a company that still has applicants', async () => {
    const { zone } = await seedCompanies();
    await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );
    const result = await deleteCompany(db, zone.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/still list this company/);
      expect(result.impact.applicants).toBe(1);
    }
    expect((await listCompanyCards(db)).some((c) => c.id === zone.id)).toBe(true);
  });

  it('deletes a company with no applicants and cascades its guidelines', async () => {
    const { zone } = await seedCompanies();
    expect((await deleteCompany(db, zone.id)).ok).toBe(true);
    expect(await listGuidelines(db, { companyId: zone.id })).toHaveLength(0);
  });
});

describe('applicant creation and evaluation', () => {
  it('creates an applicant and evaluates only the selected company', async () => {
    const { zone, xtrack } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );
    const result = await evaluateApplicantForCompany(db, applicant.id, zone.id, {
      evaluationDate: EVAL_DATE,
    });

    expect(result.overall.decision).toBe('Qualified');
    expect((await getStoredEvaluation(db, applicant.id, zone.id)).coverages).toHaveLength(8);
    // Nothing was written for Xtrack.
    expect((await getStoredEvaluation(db, applicant.id, xtrack.id)).coverages).toHaveLength(0);
  });

  it('keeps each company’s stored results independent', async () => {
    const { zone, xtrack } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );

    const zoneResult = await evaluateApplicantForCompany(db, applicant.id, zone.id, {
      evaluationDate: EVAL_DATE,
    });
    const xtrackResult = await evaluateApplicantForCompany(db, applicant.id, xtrack.id, {
      evaluationDate: EVAL_DATE,
    });

    expect(zoneResult.overall.decision).toBe('Qualified');
    expect(xtrackResult.overall.decision).toBe('Not Qualified');

    // Re-reading Zone must show Zone's original result, untouched by Xtrack's run.
    const storedZone = await getStoredEvaluation(db, applicant.id, zone.id);
    expect(storedZone.overall.decision).toBe('Qualified');
    const storedXtrack = await getStoredEvaluation(db, applicant.id, xtrack.id);
    expect(storedXtrack.overall.decision).toBe('Not Qualified');
  });

  it('re-evaluates automatically when the applying company changes', async () => {
    const { zone, xtrack } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );
    await evaluateApplicantForCompany(db, applicant.id, zone.id, { evaluationDate: EVAL_DATE });

    const moved = await setApplicantCompany(db, applicant.id, xtrack.id, { evaluationDate: EVAL_DATE });
    expect(moved.overall.decision).toBe('Not Qualified');

    // The dashboard row follows the new company; Zone's result is retained.
    const row = (await dashboardRows(db)).find((r) => r.applicant.id === applicant.id)!;
    expect(row.companyName).toBe('Xtrack LLC');
    expect(row.overall).toBe('Not Qualified');
    expect((await getStoredEvaluation(db, applicant.id, zone.id)).overall.decision).toBe('Qualified');
  });

  it('compares companies side by side without cross-contamination', async () => {
    const { zone, xtrack } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );
    const [zoneResult, xtrackResult] = await compareCompanies(db, applicant.id, [zone.id, xtrack.id], {
      evaluationDate: EVAL_DATE,
    });
    expect(zoneResult!.overall.decision).toBe('Qualified');
    expect(xtrackResult!.overall.decision).toBe('Not Qualified');
    expect(zoneResult!.coverages[0]!.guidelineId).not.toBe(xtrackResult!.coverages[0]!.guidelineId);
  });
});

describe('document updates', () => {
  it('holds legacy evidence in Manual Review until documents are re-read', async () => {
    const { zone } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence({ extractionFormatVersion: 1 }),
    );
    const stale = await evaluateApplicantForCompany(db, applicant.id, zone.id, {
      evaluationDate: EVAL_DATE,
    });
    expect(stale.overall.decision).toBe('Manual Review');

    // Re-reading the documents with the current format clears the hold.
    await saveEvidence(db, applicant.id, pheniasEvidence(), 'reviewer');
    const fresh = await evaluateApplicantForCompany(db, applicant.id, zone.id, {
      evaluationDate: EVAL_DATE,
    });
    expect(fresh.overall.decision).toBe('Qualified');
  });

  it('replaces evidence without destroying earlier snapshots', async () => {
    const { zone } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Fabrice', lastName: 'Karambizi' },
      fabriceEvidence(),
    );
    await saveEvidence(db, applicant.id, fabriceEvidence({ cdlOriginalIssueDate: '2023-01-10' }));
    const snapshots = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM applicant_evidence WHERE applicant_id = ?`,
      [applicant.id],
    );
    expect(Number(snapshots!.n)).toBe(2);
    const current = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM applicant_evidence WHERE applicant_id = ? AND is_current = 1`,
      [applicant.id],
    );
    expect(Number(current!.n)).toBe(1);
  });
});

describe('guideline library', () => {
  it('archives the previous version when a guideline is replaced', async () => {
    const { zone } = await seedCompanies();
    const replacement = await createGuideline(db, {
      companyId: zone.id,
      coverageType: 'Auto Liability',
      ruleSet: XTRACK_AUTO_LIABILITY,
      reviewStatus: 'approved',
      fileName: 'zone-al-v2.pdf',
    });
    expect(replacement.version).toBe('2');
    const all = await listGuidelines(db, { companyId: zone.id, coverageType: 'Auto Liability' });
    expect(all).toHaveLength(2);
    expect(all.filter((g) => g.status === 'active')).toHaveLength(1);
  });

  it('filters the library by company', async () => {
    const { zone, xtrack } = await seedCompanies();
    expect(await listGuidelines(db, { companyId: zone.id })).toHaveLength(1);
    expect(await listGuidelines(db, { companyId: xtrack.id })).toHaveLength(1);
    expect((await listGuidelines(db, { companyId: zone.id }))[0]!.companyId).toBe(zone.id);
  });

  it('removing the guideline moves the applicant to Manual Review, not Not Qualified', async () => {
    const { zone } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );
    const guidelineId = (await listGuidelines(db, { companyId: zone.id, status: 'active' }))[0]!.id;
    await removeGuideline(db, guidelineId);

    const result = await evaluateApplicantForCompany(db, applicant.id, zone.id, {
      evaluationDate: EVAL_DATE,
    });
    expect(result.overall.decision).toBe('Manual Review');
    expect(result.overall.reason).toMatch(/No active Auto Liability driver guideline/);
  });

  it('holds for review when a replacement guideline is not yet approved', async () => {
    const { zone } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );
    await createGuideline(db, {
      companyId: zone.id,
      coverageType: 'Auto Liability',
      ruleSet: ZONE_AUTO_LIABILITY,
      fileName: 'zone-al-v2.pdf',
    });
    const result = await evaluateApplicantForCompany(db, applicant.id, zone.id, {
      evaluationDate: EVAL_DATE,
    });
    expect(result.overall.decision).toBe('Manual Review');
    expect(result.coverages[0]!.reason).toMatch(/not been approved/);
  });
});

describe('coverage expiration alerts', () => {
  it('opens an alert exactly 90 days before expiration', async () => {
    const { zone } = await seedCompanies();
    await createCoverage(db, {
      companyId: zone.id,
      coverageType: 'Cargo',
      carrier: 'Acme',
      policyNumber: 'CG-90',
      effectiveDate: '2025-11-17',
      expirationDate: '2026-11-17', // 90 days after 2026-08-19
      limits: null,
    });
    const alerts = await refreshExpirationAlerts(db, zone.id, EVAL_DATE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('expiring');
    expect(alerts[0]!.daysUntil).toBe(90);
  });

  it('does not alert at 91 days', async () => {
    const { zone } = await seedCompanies();
    await createCoverage(db, {
      companyId: zone.id,
      coverageType: 'Cargo',
      carrier: 'Acme',
      policyNumber: 'CG-91',
      effectiveDate: '2025-11-18',
      expirationDate: '2026-11-18',
      limits: null,
    });
    expect(await refreshExpirationAlerts(db, zone.id, EVAL_DATE)).toHaveLength(0);
  });

  it('flags an already-expired policy', async () => {
    const { zone } = await seedCompanies();
    await createCoverage(db, {
      companyId: zone.id,
      coverageType: 'Physical Damage',
      carrier: 'Acme',
      policyNumber: 'PD-1',
      effectiveDate: '2025-01-01',
      expirationDate: '2026-01-01',
      limits: null,
    });
    const alerts = await refreshExpirationAlerts(db, zone.id, EVAL_DATE);
    expect(alerts[0]!.severity).toBe('expired');
    expect(alerts[0]!.message).toMatch(/expired 2026-01-01/);
    expect((await listExpirationAlerts(db)).length).toBeGreaterThan(0);
  });
});

describe('dashboard', () => {
  it('summarises applicants by their current company decision', async () => {
    const { zone, xtrack } = await seedCompanies();
    const phenias = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );
    const fabrice = await createApplicant(
      db,
      { companyId: xtrack.id, firstName: 'Fabrice', lastName: 'Karambizi' },
      fabriceEvidence(),
    );
    await evaluateApplicantForCompany(db, phenias.id, zone.id, { evaluationDate: EVAL_DATE });
    await evaluateApplicantForCompany(db, fabrice.id, xtrack.id, { evaluationDate: EVAL_DATE });

    const stats = await dashboardStats(db);
    expect(stats.totalApplicants).toBe(2);
    expect(stats.qualified).toBe(1); // Phenias at Zone
    expect(stats.notQualified).toBe(1); // Fabrice at Xtrack (26 months < 36 required)

    const rows = await dashboardRows(db);
    expect(rows.find((r) => r.applicant.id === phenias.id)!.coverageDecisions['Auto Liability']).toBe(
      'Qualified',
    );
    expect(rows.find((r) => r.applicant.id === fabrice.id)!.coverageDecisions['Cargo']).toBe(
      'Not Evaluated',
    );
  });
});

describe('audit log', () => {
  it('records company, guideline, applicant and evaluation activity', async () => {
    const { zone } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
      'safety.reviewer',
    );
    await evaluateApplicantForCompany(db, applicant.id, zone.id, {
      evaluationDate: EVAL_DATE,
      actor: 'safety.reviewer',
    });

    const actions = (await listAuditEvents(db)).map((e) => e.action);
    expect(actions).toContain('company.create');
    expect(actions).toContain('guideline.create');
    expect(actions).toContain('applicant.create');
    expect(actions).toContain('evidence.save');
    expect(actions).toContain('applicant.evaluate');
  });

  it('stores the evidence id and engine version so a decision can be replayed', async () => {
    const { zone } = await seedCompanies();
    const applicant = await createApplicant(
      db,
      { companyId: zone.id, firstName: 'Phenias', lastName: 'Mugisha' },
      pheniasEvidence(),
    );
    await evaluateApplicantForCompany(db, applicant.id, zone.id, { evaluationDate: EVAL_DATE });
    const row = await db.get<Record<string, unknown>>(
      `SELECT evidence_id, engine_version, extraction_format_version, guideline_version
       FROM coverage_evaluations WHERE applicant_id = ? AND coverage_type = 'Auto Liability'`,
      [applicant.id],
    );
    expect(row!['evidence_id']).toMatch(/^ev_/);
    expect(row!['engine_version']).toBeTruthy();
    expect(Number(row!['extraction_format_version'])).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
    expect(row!['guideline_version']).toBe('1');
  });
});
