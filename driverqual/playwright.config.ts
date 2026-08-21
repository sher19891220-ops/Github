import { defineConfig, devices } from '@playwright/test';
import { ACCESS_CODE, STORAGE_STATE } from './tests/ui/constants';

const PORT = 3311;

const CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: './tests/ui',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    // The sandbox ships Chromium at a fixed path; Playwright's own build id may
    // not match, so point every project at the installed binary.
    launchOptions: { executablePath: CHROMIUM_PATH },
  },
  projects: [
    // Signs in once; every other project reuses the saved session.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: STORAGE_STATE },
    },
    {
      name: 'tablet',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, storageState: STORAGE_STATE },
    },
    {
      name: 'phone',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, storageState: STORAGE_STATE },
    },
  ],
  webServer: {
    // Reset before the server opens the file. Playwright starts webServer ahead
    // of globalSetup, so deleting it from a setup hook would unlink the database
    // out from under a live connection.
    command: `rm -f .data/e2e.db .data/e2e.db-wal .data/e2e.db-shm && npm run start -- -p ${PORT}`,
    // /api/health is public and touches neither the session nor the database,
    // so readiness never depends on either.
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      TURSO_DATABASE_URL: 'file:.data/e2e.db',
      // The suite runs against a protected instance, as production is.
      APP_ACCESS_CODE: ACCESS_CODE,
    },
  },
});
