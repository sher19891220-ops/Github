#!/usr/bin/env node
/**
 * Seeds the acceptance-case scenario into a *running* instance so the app can be
 * exercised by hand without typing a rule tree.
 *
 * It talks to the HTTP API rather than the database directly, so what it creates
 * goes through the same validation, evaluation and audit path as a real user's
 * clicks — a seed that bypassed those would prove nothing.
 *
 * The specification forbids fictional applicants in a deployed system, so this
 * refuses to run against anything but a local instance unless explicitly forced.
 *
 *   npm run demo                          # http://localhost:3000
 *   npm run demo -- --url http://…        # another instance
 *   npm run demo -- --url http://… --force
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? '');
};

const BASE = (flag('--url') || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const FORCE = args.includes('--force');
/**
 * Every seeded date is derived from today rather than hardcoded.
 *
 * Fixed dates rot: an MVR ordered on a literal date eventually passes the
 * 90-day freshness limit and the whole demo silently turns into Manual Review,
 * which looks like a bug rather than the intended lesson.
 */
const TODAY = new Date();

function shift({ days = 0, months = 0 }) {
  const d = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate()));
  if (months) d.setUTCMonth(d.getUTCMonth() + months);
  if (days) d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$|\/)/.test(BASE);
if (!isLocal && !FORCE) {
  console.error(
    `Refusing to seed demo data into ${BASE}.\n\n` +
      'This creates fictional companies and drivers, which must never appear in a\n' +
      'deployed system holding real driver records. Re-run with --force only if you\n' +
      'are certain this instance is a scratch environment.',
  );
  process.exit(1);
}

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${data.error ?? text}`);
  return data;
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

/** Zone reads its guideline as a rule tree with two alternative paths. */
const ZONE_RULES = {
  schemaVersion: 1,
  notes: 'Zone-OH LLC Auto Liability driver criteria.',
  eligibilityPaths: [
    {
      id: 'path.two_year',
      label: 'Two-year experience path',
      sourceText:
        'Drivers with two (2) or more years of verifiable CDL experience: maximum of three (3) moving violations in the preceding 36 months.',
      conditions: [
        { type: 'min_experience_months', months: 24 },
        { type: 'max_events', category: 'moving_violation', lookbackMonths: 36, max: 3 },
        { type: 'max_events', category: 'major_moving_violation', lookbackMonths: 60, max: 0 },
        { type: 'license_status_in', statuses: ['Valid'] },
      ],
    },
    {
      id: 'path.one_year',
      label: 'One-year experience path',
      sourceText:
        'Drivers with at least one (1) year of verifiable CDL experience: maximum of one (1) moving violation in the preceding 36 months.',
      conditions: [
        { type: 'min_experience_months', months: 12 },
        { type: 'max_events', category: 'moving_violation', lookbackMonths: 36, max: 1 },
        { type: 'max_events', category: 'major_moving_violation', lookbackMonths: 60, max: 0 },
        { type: 'license_status_in', statuses: ['Valid'] },
      ],
    },
  ],
  disqualifiers: [],
};

/** Xtrack is deliberately stricter, so company isolation is visible. */
const XTRACK_RULES = {
  schemaVersion: 1,
  notes: 'Xtrack LLC Auto Liability driver criteria.',
  eligibilityPaths: [
    {
      id: 'path.standard',
      label: 'Standard path',
      sourceText:
        'Minimum three (3) years CDL experience and no moving violations in the preceding 36 months.',
      conditions: [
        { type: 'min_experience_months', months: 36 },
        { type: 'max_events', category: 'moving_violation', lookbackMonths: 36, max: 0 },
        { type: 'license_status_in', statuses: ['Valid'] },
      ],
    },
  ],
  disqualifiers: [],
};

const baseEvidence = {
  extractionFormatVersion: 3,
  licenseStatus: 'Valid',
  cdlState: 'OH',
  cdlClass: 'A',
  medicalCard: { present: true, expirationDate: '2027-06-30', examinerName: 'Dr. Lee' },
  suspensions: [],
  reportedExperienceMonths: null,
  confidence: {},
  warnings: [],
};

const event = (description, violationDate, convictionDate, statePoints, mvrPoints) => ({
  id: description.toLowerCase().replace(/\W+/g, '_'),
  description,
  violationDate,
  convictionDate,
  state: 'OH',
  statePoints,
  mvrActivityPoints: mvrPoints,
  disposition: null,
  eventType: 'Unknown',
  severity: 'Unknown',
  atFault: null,
  preventable: null,
});

async function addCompany(name, extra, rules) {
  const { company } = await post('/api/companies', { name, ...extra });
  if (rules) {
    const { guideline } = await post('/api/guidelines', {
      companyId: company.id,
      coverageType: 'Auto Liability',
      fileName: `${name.toLowerCase().replace(/\W+/g, '-')}-auto-liability.pdf`,
      effectiveDate: '2026-01-01',
      ruleSet: rules,
    });
    await post(`/api/guidelines/${guideline.id}`, { action: 'approve' });
  }
  return company;
}

async function main() {
  console.log(`Seeding demo data into ${BASE}\n`);

  const zone = await addCompany('Zone-OH LLC', { usdotNumber: '3456789' }, ZONE_RULES);
  const xtrack = await addCompany('Xtrack LLC', { usdotNumber: '9876543' }, XTRACK_RULES);
  // Deliberately has no Auto Liability guideline, to show Not Evaluated.
  const acme = await addCompany('Acme Freight', { usdotNumber: '1122334' }, null);
  console.log('Companies: Zone-OH LLC, Xtrack LLC, Acme Freight (no AL guideline)');

  // Exactly 90 days out — the boundary at which an alert opens.
  const cargoExpiry = shift({ days: 90 });
  await post('/api/coverages', {
    companyId: zone.id,
    coverageType: 'Cargo',
    carrier: 'Great West',
    policyNumber: 'CG-88213',
    effectiveDate: shift({ months: -12, days: 90 }),
    expirationDate: cargoExpiry,
    limits: '$100,000',
  });
  console.log(`Coverage: Zone Cargo policy expiring ${cargoExpiry} — exactly 90 days out`);

  const phenias = await post('/api/applicants', {
    companyId: zone.id,
    firstName: 'Phenias',
    lastName: 'Mugisha',
    driverType: 'Company driver',
    evidence: {
      ...baseEvidence,
      mvrOrderDate: shift({ days: -10 }),
      dateOfBirth: shift({ months: -436 }),
      cdlNumber: 'OH1234567',
      cdlOriginalIssueDate: shift({ months: -41 }),
      cdlCurrentIssueDate: shift({ months: -9 }),
      events: [
        // Administrative, and outside the 36-month window.
        event('Abandoned Vehicle Fee Due', shift({ months: -58 }), null, 0, 0),
        // Administrative, and the interesting one: outside the window by its
        // violation date, inside by its conviction date. It must be excluded on
        // classification, not on the window.
        event('Fail to Appear - Trial/Court', shift({ months: -39 }), shift({ months: -35 }), 0, 0),
        // The only countable moving violation.
        event('Limitations on Backing', shift({ months: -27 }), shift({ months: -25 }), 2, 4),
      ],
    },
  });

  const fabrice = await post('/api/applicants', {
    companyId: zone.id,
    firstName: 'Fabrice',
    lastName: 'Karambizi',
    driverType: 'Owner operator',
    evidence: {
      ...baseEvidence,
      mvrOrderDate: shift({ days: -10 }),
      dateOfBirth: shift({ months: -378 }),
      cdlNumber: 'OH7654321',
      // 26 months of experience on a card last renewed 9 months ago: using the
      // renewal date would read as 9 months and fail a two-year minimum.
      cdlOriginalIssueDate: shift({ months: -26 }),
      cdlCurrentIssueDate: shift({ months: -9 }),
      events: [],
    },
  });

  for (const [name, result] of [
    ['Phenias Mugisha', phenias],
    ['Fabrice Karambizi', fabrice],
  ]) {
    const auto = result.evaluation.coverages.find((c) => c.coverageType === 'Auto Liability');
    console.log(
      `Applicant: ${name} — ${result.evaluation.overall.decision} at Zone-OH LLC via ${auto.eligibilityPath}`,
    );
  }

  console.log(`
Done. Things worth looking at:

  Dashboard          Both drivers Qualified at Zone. Auto Liability alone sets Overall.

  Phenias → Compare  Tick all three companies and run it:
                       Zone-OH LLC    Qualified      1 countable violation, limit 3
                       Xtrack LLC     Not Qualified  same driver, stricter rule (limit 0)
                       Acme Freight   Manual Review  no Auto Liability guideline configured
                     One driver, one set of documents, three independent answers.

  Phenias → Zone     Read "Excluded records". Three MVR entries went in and one
                     was counted. The abandoned-vehicle fee is out of window; the
                     court entry is IN window by its conviction date and excluded
                     on classification instead. That distinction is the whole point.

  Fabrice            26 completed months, taken from the original CDL issue date.
                     His card was renewed 9 months ago — reading the renewal date
                     instead would fail him against a two-year minimum.

  Insurance programs The Zone Cargo policy sits exactly 90 days out, the boundary
                     at which an alert opens.

  Audit log          Every step above, including this seeding.
`);
}

main().catch((error) => {
  console.error(`\nSeeding failed: ${error.message}`);
  console.error('Is the app running at the URL above?');
  process.exit(1);
});
