import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * These run against a real production build with a real database, so each spec
 * creates the data it needs rather than assuming a seeded fixture — the
 * deployed application ships with no sample companies or applicants.
 */

const NAV_LINKS = [
  ['Dashboard', '/'],
  ['Applicants', '/applicants'],
  ['Manual reviews', '/manual-reviews'],
  ['Documents', '/documents'],
  ['Companies', '/companies'],
  ['Insurance programs', '/insurance-programs'],
  ['Rules & guidelines', '/guidelines'],
  ['Reports', '/reports'],
  ['Audit log', '/audit-log'],
  ['Team & roles', '/team'],
  ['Settings', '/settings'],
] as const;

/**
 * Tests share one database, so every driver needs a surname no other test can
 * match — otherwise a row filter silently picks up someone else's applicant.
 */
function driverSurname(testInfo: TestInfo): string {
  const slug = testInfo.title.replace(/[^a-z]/gi, '').slice(0, 12);
  return `${slug}${testInfo.project.name}`;
}

/** The phone layout hides the sidebar behind a menu button. */
async function openNav(page: Page) {
  const toggle = page.getByTestId('nav-toggle');
  if (await toggle.isVisible()) await toggle.click();
}

async function createCompany(page: Page, name: string) {
  await page.goto('/companies');
  await page.getByTestId('add-company').click();
  await page.getByTestId('company-name').fill(name);
  await page.getByTestId('save-company').click();
  await expect(page.getByTestId('company-card').filter({ hasText: name })).toBeVisible();
}

test.describe('navigation', () => {
  test('every navigation link opens its screen', async ({ page }) => {
    await page.goto('/');
    for (const [label, href] of NAV_LINKS) {
      await openNav(page);
      await page.getByRole('navigation').getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${href.replace('/', '\\/')}$`));
      await expect(page.locator('h1, .stat-label').first()).toBeVisible();
    }
  });

  test('no horizontal page overflow at any width', async ({ page }) => {
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('companies', () => {
  test('creates a company and shows it on a card', async ({ page }, testInfo) => {
    const name = `Zone-OH LLC ${testInfo.project.name}`;
    await createCompany(page, name);
    const card = page.getByTestId('company-card').filter({ hasText: name });
    await expect(card).toContainText('0 applicant(s)');
    await expect(card).toContainText('0 guideline(s)');
  });

  test('shows an actionable error when the company name is blank', async ({ page }) => {
    await page.goto('/companies');
    await page.getByTestId('add-company').click();
    await page.getByTestId('save-company').click();
    await expect(page.getByTestId('company-error')).toContainText('Company name is required');
  });

  test('reports that the USDOT lookup is not configured instead of inventing data', async ({
    page,
  }) => {
    await page.goto('/companies');
    await page.getByTestId('add-company').click();
    await page.locator('#usdot').fill('3456789');
    await page.getByTestId('usdot-lookup').click();
    await expect(page.getByTestId('company-error')).toContainText('not configured');
    await expect(page.getByTestId('company-name')).toHaveValue('');
  });
});

test.describe('applicants', () => {
  test('the company dropdown is populated in the add-applicant drawer', async ({ page }, testInfo) => {
    const name = `Dropdown Co ${testInfo.project.name}`;
    await createCompany(page, name);
    await page.goto('/applicants');
    await page.getByTestId('add-applicant').click();
    await expect(page.getByTestId('company-select')).toBeVisible();
    await expect(page.getByTestId('company-select').locator('option')).not.toHaveCount(0);
  });

  test('creates an applicant and evaluates it, showing Manual Review with no guideline', async ({
    page,
  }, testInfo) => {
    const company = `Eval Co ${testInfo.project.name}`;
    await createCompany(page, company);

    await page.goto('/applicants');
    await page.getByTestId('add-applicant').click();
    await page.getByTestId('company-select').selectOption({ label: company });
    await page.locator('#firstName').fill('Test');
    await page.locator('#lastName').fill(driverSurname(testInfo));
    await page.getByTestId('original-issue-date').fill('2022-01-10');
    await expect(page.getByTestId('experience-summary')).toContainText('completed months');
    await page.getByTestId('submit-applicant').click();

    const row = page.getByTestId('applicant-row').filter({ hasText: driverSurname(testInfo) });
    await expect(row).toBeVisible();
    // No Auto Liability guideline is configured, so the driver is held for review.
    await expect(row.getByTestId('overall-decision')).toHaveText('Manual Review');
  });

  test('requires a name before saving and says so', async ({ page }, testInfo) => {
    await createCompany(page, `Validation Co ${testInfo.project.name}`);
    await page.goto('/applicants');
    await page.getByTestId('add-applicant').click();
    await page.getByTestId('submit-applicant').click();
    await expect(page.getByTestId('drawer-error')).toContainText('First and last name are required');
  });

  test('reports that extraction is unconfigured rather than fabricating evidence', async ({
    page,
  }, testInfo) => {
    await createCompany(page, `Extract Co ${testInfo.project.name}`);
    await page.goto('/applicants');
    await page.getByTestId('add-applicant').click();

    await page.getByTestId('file-input').setInputFiles({
      name: 'mvr.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 test document'),
    });
    await expect(page.getByTestId('file-list')).toContainText('mvr.pdf');

    await page.getByTestId('read-documents').click();
    // The message is deliberately vendor-neutral: which provider is configured
    // is an operator's concern, not something the copy should hard-code.
    await expect(page.getByTestId('drawer-error')).toContainText(
      'No document-intelligence provider is configured',
    );
  });

  test('rejects an unsupported file type on the server', async ({ page }, testInfo) => {
    await createCompany(page, `Upload Co ${testInfo.project.name}`);
    await page.goto('/applicants');
    await page.getByTestId('add-applicant').click();
    await page.getByTestId('file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a driver document'),
    });
    await page.getByTestId('read-documents').click();
    await expect(page.getByTestId('drawer-error')).toContainText('unsupported');
  });
});

test.describe('guidelines', () => {
  test('adds a guideline, approves it, and qualifies a driver end to end', async ({
    page,
  }, testInfo) => {
    const company = `Guideline Co ${testInfo.project.name}`;
    await createCompany(page, company);

    await page.goto('/guidelines');
    await page.getByTestId('guideline-company-filter').selectOption({ label: company });
    await page.getByTestId('add-guideline').click();
    await page.locator('#glCoverage').selectOption('Auto Liability');
    await page.getByTestId('guideline-ruleset').fill(
      JSON.stringify({
        schemaVersion: 1,
        eligibilityPaths: [
          {
            id: 'path.one_year',
            label: 'One-year experience path',
            sourceText: 'At least one year of CDL experience.',
            conditions: [{ type: 'min_experience_months', months: 12 }],
          },
        ],
        disqualifiers: [],
      }),
    );
    await page.getByTestId('save-guideline').click();
    await expect(page.getByTestId('guidelines-table')).toContainText('awaiting approval');

    await page.getByTestId('approve-guideline').click();
    await expect(page.getByTestId('guidelines-table')).toContainText('approved');

    await page.goto('/applicants');
    await page.getByTestId('add-applicant').click();
    await page.getByTestId('company-select').selectOption({ label: company });
    await page.locator('#firstName').fill('Qualified');
    await page.locator('#lastName').fill(driverSurname(testInfo));
    await page.getByTestId('original-issue-date').fill('2020-01-15');
    await page.locator('#mvrOrderDate').fill(new Date().toISOString().slice(0, 10));
    await page.getByTestId('submit-applicant').click();

    const row = page.getByTestId('applicant-row').filter({ hasText: driverSurname(testInfo) });
    await expect(row.getByTestId('overall-decision')).toHaveText('Qualified');
  });

  test('drafting criteria from a document reports when extraction is unconfigured', async ({
    page,
  }, testInfo) => {
    const company = `Interpret Co ${testInfo.project.name}`;
    await createCompany(page, company);

    await page.goto('/guidelines');
    await page.getByTestId('guideline-company-filter').selectOption({ label: company });
    await page.getByTestId('add-guideline').click();

    await page.getByTestId('guideline-file').setInputFiles({
      name: 'zone-guideline.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 driver qualification guideline'),
    });
    await expect(page.getByTestId('guideline-file-list')).toContainText('zone-guideline.pdf');

    await page.getByTestId('interpret-guideline').click();

    // No key is configured in the test environment, so it must say so rather
    // than inventing criteria.
    await expect(page.getByTestId('guideline-error')).toContainText(
      'No document-intelligence provider is configured',
    );
    await expect(page.getByTestId('guideline-ruleset')).toHaveValue('');
  });

  test('refuses to draft criteria from an unsupported file type', async ({ page }, testInfo) => {
    const company = `Interpret Bad ${testInfo.project.name}`;
    await createCompany(page, company);

    await page.goto('/guidelines');
    await page.getByTestId('guideline-company-filter').selectOption({ label: company });
    await page.getByTestId('add-guideline').click();
    await page.getByTestId('guideline-file').setInputFiles({
      name: 'criteria.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('two years experience'),
    });
    await page.getByTestId('interpret-guideline').click();
    await expect(page.getByTestId('guideline-error')).toContainText('unsupported');
  });

  test('rejects an invalid rule set with a specific message', async ({ page }, testInfo) => {
    const company = `Bad Rules Co ${testInfo.project.name}`;
    await createCompany(page, company);
    await page.goto('/guidelines');
    await page.getByTestId('guideline-company-filter').selectOption({ label: company });
    await page.getByTestId('add-guideline').click();
    await page.getByTestId('guideline-ruleset').fill('{ not json');
    await page.getByTestId('save-guideline').click();
    await expect(page.getByTestId('guideline-error')).toContainText('not valid JSON');
  });

  test('filters the library by company', async ({ page }, testInfo) => {
    const a = `Filter A ${testInfo.project.name}`;
    const b = `Filter B ${testInfo.project.name}`;
    await createCompany(page, a);
    await createCompany(page, b);

    await page.goto('/guidelines');
    await page.getByTestId('guideline-company-filter').selectOption({ label: a });
    await page.getByTestId('add-guideline').click();
    await page.locator('#glCarrier').fill('Carrier-A');
    await page.getByTestId('save-guideline').click();
    await expect(page.getByTestId('guidelines-table')).toContainText('Carrier-A');

    await page.getByTestId('guideline-company-filter').selectOption({ label: b });
    await expect(page.getByTestId('no-guidelines')).toBeVisible();
  });
});

test.describe('company comparison', () => {
  test('evaluates two companies independently from one driver record', async ({
    page,
  }, testInfo) => {
    const lenient = `Lenient ${testInfo.project.name}`;
    const strict = `Strict ${testInfo.project.name}`;
    await createCompany(page, lenient);
    await createCompany(page, strict);

    for (const [company, months] of [
      [lenient, 12],
      [strict, 120],
    ] as const) {
      await page.goto('/guidelines');
      await page.getByTestId('guideline-company-filter').selectOption({ label: company });
      await page.getByTestId('add-guideline').click();
      await page.getByTestId('guideline-ruleset').fill(
        JSON.stringify({
          schemaVersion: 1,
          eligibilityPaths: [
            {
              id: 'p',
              label: `${months}-month path`,
              sourceText: `Requires ${months} months.`,
              conditions: [{ type: 'min_experience_months', months }],
            },
          ],
          disqualifiers: [],
        }),
      );
      await page.getByTestId('save-guideline').click();
      await page.getByTestId('approve-guideline').click();
    }

    await page.goto('/applicants');
    await page.getByTestId('add-applicant').click();
    await page.getByTestId('company-select').selectOption({ label: lenient });
    await page.locator('#firstName').fill('Compare');
    await page.locator('#lastName').fill(driverSurname(testInfo));
    await page.getByTestId('original-issue-date').fill('2021-03-01');
    await page.locator('#mvrOrderDate').fill(new Date().toISOString().slice(0, 10));
    await page.getByTestId('submit-applicant').click();

    const row = page.getByTestId('applicant-row').filter({ hasText: driverSurname(testInfo) });
    await row.getByRole('button', { name: 'Compare' }).click();

    const dialog = page.getByRole('dialog');
    for (const company of [lenient, strict]) {
      await dialog.locator('label').filter({ hasText: company }).getByRole('checkbox').check();
    }
    await page.getByTestId('run-comparison').click();

    const results = page.getByTestId('comparison-results');
    await expect(results).toContainText(lenient);
    await expect(results).toContainText(strict);
    // Each company's own guideline decided its own result.
    await expect(results).toContainText('Qualified');
    await expect(results).toContainText('Not Qualified');
    await expect(dialog).toContainText('never changes another company');
  });
});

test.describe('settings', () => {
  test('shows status and validates the key format without echoing secrets', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('openai-status')).toBeVisible();

    await page.getByTestId('openai-key-input').fill('definitely-not-a-key');
    await page.getByTestId('save-openai').click();
    await expect(page.getByTestId('settings-error')).toContainText('begin with "sk-"');

    await page.getByTestId('openai-key-input').fill('sk-test-key-1234567890abcdef');
    await page.getByTestId('save-openai').click();
    await expect(page.getByTestId('settings-notice')).toContainText('saved');
    // Only the last four characters are ever shown.
    await expect(page.getByTestId('openai-status')).toContainText('••••cdef');
    await expect(page.locator('body')).not.toContainText('sk-test-key-1234567890abcdef');

    await page.getByRole('button', { name: 'Remove' }).first().click();
    await expect(page.getByTestId('openai-status')).toContainText('Not configured');
  });
});

test.describe('responsive layout', () => {
  test('primary actions stay reachable and tap targets are large enough', async ({ page }) => {
    await page.goto('/applicants');
    const addButton = page.getByTestId('add-applicant');
    await expect(addButton).toBeVisible();
    const box = await addButton.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    await addButton.click();
    const submit = page.getByTestId('submit-applicant');
    await expect(submit).toBeInViewport();
    const submitBox = await submit.boundingBox();
    expect(submitBox!.height).toBeGreaterThanOrEqual(44);
  });

  test('the applicant table scrolls horizontally rather than clipping', async ({ page }, testInfo) => {
    await createCompany(page, `Scroll Co ${testInfo.project.name}`);
    await page.goto('/applicants');
    await page.getByTestId('add-applicant').click();
    await page.locator('#firstName').fill('Scroll');
    await page.locator('#lastName').fill(driverSurname(testInfo));
    await page.getByTestId('submit-applicant').click();

    await expect(page.getByTestId('applicants-table')).toBeVisible();
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(1);
  });
});
