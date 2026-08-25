import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { ACCESS_CODE } from './constants';

/**
 * A caller address unique to this test and this viewport.
 *
 * Lockouts are keyed by address, and the three viewport projects run the same
 * specs against one server — sharing an address would mean the desktop run locks
 * out the tablet run before it starts.
 */
function callerAddress(testInfo: TestInfo, octet: number): string {
  const project = ['desktop', 'tablet', 'phone'].indexOf(testInfo.project.name) + 1;
  return `203.0.113.${octet * 10 + project}`;
}

/** Sign-out lives in the sidebar, which is behind the menu button on mobile. */
async function openNav(page: Page) {
  const toggle = page.getByTestId('nav-toggle');
  if (await toggle.isVisible()) await toggle.click();
}

/**
 * These run without the saved session, so they see the app as an outsider does.
 *
 * Each test that submits a wrong code uses its own X-Forwarded-For address:
 * lockouts are per address, and a shared one would lock the suite out of its own
 * application partway through.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('access control', () => {
  test('an unauthenticated visitor is sent to the login screen', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('access-code')).toBeVisible();
    // The navigation must not be visible to someone who has not signed in.
    await expect(page.getByRole('navigation')).toHaveCount(0);
  });

  test('every protected screen redirects, not just the dashboard', async ({ page }) => {
    for (const path of ['/applicants', '/companies', '/guidelines', '/settings', '/audit-log']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test('the API returns 401 rather than data', async ({ request }) => {
    for (const path of ['/api/companies', '/api/applicants', '/api/settings']) {
      const response = await request.get(path);
      expect(response.status()).toBe(401);
      expect(await response.text()).not.toContain('companies');
    }
  });

  test('the health check stays public so the platform can see the app is alive', async ({
    request,
  }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    // Versions make a deploy verifiable from outside; they must not be
    // accompanied by anything that needs a session to see.
    expect(body.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof body.extractionFormatVersion).toBe('number');
    expect(Object.keys(body).sort()).toEqual([
      'engineVersion',
      'extractionFormatVersion',
      'status',
    ]);
  });

  test('a wrong code is refused and says how many attempts remain', async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'X-Forwarded-For': callerAddress(testInfo, 2) },
    });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByTestId('access-code').fill('0000');
    await page.getByTestId('sign-in').click();

    await expect(page.getByTestId('login-error')).toContainText('Incorrect access code');
    await expect(page.getByTestId('login-error')).toContainText('attempts remaining');
    await expect(page).toHaveURL(/\/login/);

    await context.close();
  });

  test('repeated wrong codes lock the address out, and the right code stays refused', async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'X-Forwarded-For': callerAddress(testInfo, 3) },
    });
    const page = await context.newPage();
    await page.goto('/login');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await page.getByTestId('access-code').fill(`bad-code-${attempt}`);
      await page.getByTestId('sign-in').click();
      await expect(page.getByTestId('login-error')).toBeVisible();
    }
    await expect(page.getByTestId('login-error')).toContainText('locked out');

    // The correct code must not open a locked door.
    await page.getByTestId('access-code').fill(ACCESS_CODE);
    await page.getByTestId('sign-in').click();
    await expect(page.getByTestId('login-error')).toContainText('Too many incorrect codes');
    await expect(page).toHaveURL(/\/login/);

    await context.close();
  });

  test('a lockout does not affect anyone else', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'X-Forwarded-For': callerAddress(testInfo, 4) },
    });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByTestId('access-code').fill(ACCESS_CODE);
    await page.getByTestId('sign-in').click();
    await expect(page).toHaveURL(/\/$/);

    await context.close();
  });

  test('the correct code signs in and returns to the requested page', async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'X-Forwarded-For': callerAddress(testInfo, 5) },
    });
    const page = await context.newPage();

    await page.goto('/companies');
    await expect(page).toHaveURL(/\/login\?next=%2Fcompanies/);

    await page.getByTestId('access-code').fill(ACCESS_CODE);
    await page.getByTestId('sign-in').click();

    await expect(page).toHaveURL(/\/companies$/);
    await expect(page.getByTestId('add-company')).toBeVisible();

    await context.close();
  });

  test('a forged session cookie is rejected', async ({ browser }) => {
    const context = await browser.newContext();
    // A well-formed but unsigned token: the payload claims a distant expiry.
    const payload = Buffer.from(JSON.stringify({ exp: 9_999_999_999 })).toString('base64url');
    await context.addCookies([
      {
        name: 'driverqual_session',
        value: `${payload}.${payload}`,
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    const page = await context.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);

    await context.close();
  });

  test('signing out ends the session', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'X-Forwarded-For': callerAddress(testInfo, 6) },
    });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByTestId('access-code').fill(ACCESS_CODE);
    await page.getByTestId('sign-in').click();
    await expect(page).toHaveURL(/\/$/);

    await openNav(page);
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/login/);

    // The session must be gone, not merely navigated away from.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);

    await context.close();
  });

  test('the unprotected-instance banner is absent when a code is configured', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('no-auth-banner')).toHaveCount(0);
  });
});
