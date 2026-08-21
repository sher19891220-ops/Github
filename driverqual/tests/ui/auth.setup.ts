import { expect, test as setup } from '@playwright/test';
import { ACCESS_CODE, STORAGE_STATE } from './constants';

/**
 * Signs in once and saves the session for every other project to reuse.
 *
 * The whole suite therefore runs against a protected instance, which is what
 * production looks like — rather than testing the app with its front door open
 * and the lock only checked in one place.
 */
setup('sign in', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('access-code').fill(ACCESS_CODE);
  await page.getByTestId('sign-in').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('dashboard-stats')).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
