import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { testPassword } from '../support/management.js';
async function login(page: Page, name: string, password = testPassword) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('opening import, independent approval, reservations and source drill-down work on the inventory screen', async ({
  page,
}) => {
  test.setTimeout(90000);
  const suffix = randomUUID().slice(0, 8);
  const sku = `STOCK-${suffix.toUpperCase()}`;
  const reviewer = `review.${suffix}`;
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:3100')) external.push(r.url());
  });
  await login(page, 'test.admin');
  await expect(
    page.getByRole('heading', { name: 'Catalog', exact: true }),
  ).toBeVisible();
  const session = (await (
    await page.request.get('/api/v1/auth/session')
  ).json()) as { csrfToken: string; branchId: string };
  const headers = {
    Origin: 'http://127.0.0.1:3100',
    'X-CSRF-Token': session.csrfToken,
  };
  const lookups = (await (
    await page.request.get('/api/v1/catalog/lookups')
  ).json()) as { units: { id: string }[] };
  const created = await page.request.post('/api/v1/catalog/variants', {
    headers,
    data: {
      productName: `Browser stock item ${suffix}`,
      name: 'Plain',
      sku,
      unitId: lookups.units[0]!.id,
      conversion: '1',
      fractional: false,
      minimumStock: '3',
      taxCodeId: null,
      categoryId: null,
      brandId: null,
      barcodes: [],
      archived: false,
    },
  });
  expect(created.ok()).toBe(true);
  const user = await page.request.post('/api/v1/users', {
    headers,
    data: {
      username: reviewer,
      displayName: reviewer,
      password: testPassword,
      roles: ['manager'],
      branchIds: [session.branchId],
    },
  });
  expect(user.ok()).toBe(true);
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  await page.getByLabel('Search stock').fill(sku);
  await expect(
    page.getByRole('cell', { name: sku, exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Import opening stock', exact: true })
    .click();
  await page
    .getByLabel('CSV manifest')
    .fill(
      `sku,condition,quantity,unitCost\n${sku},sellable,10,12.50\n${sku},damaged,2,8`,
    );
  await page
    .getByLabel('Manifest source reference')
    .fill(`synthetic-${suffix}.csv`);
  await page.getByLabel('Opening date', { exact: true }).fill('2026-09-01');
  await page
    .getByLabel('Import review notes')
    .fill(`Browser opening ${suffix}`);
  await page
    .getByRole('button', { name: 'Validate and create opening draft' })
    .click();
  await expect(
    page.getByText('Total value change: PHP 141.000000'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Approve and post' }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('opening-review.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, reviewer);
  await expect(
    page.getByRole('heading', { name: 'Change password', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Current password').fill(testPassword);
  const newPassword = 'Browser-reviewer-password-2026!';
  await page.getByLabel('New password').fill(newPassword);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await login(page, reviewer, newPassword);
  await expect(
    page.getByRole('heading', { name: 'Catalog', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: `Browser opening ${suffix}` })
    .getByRole('button', { name: 'Review document' })
    .click();
  await page.getByLabel('Your password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Approve and post' }).click();
  await expect(page.getByText(/STK-\d+ · opening · posted/)).toBeVisible();
  const download = page.waitForEvent('download');
  await page
    .getByRole('link', { name: 'Download reconciliation report (CSV)' })
    .click();
  expect((await download).suggestedFilename()).toBe('export.csv');
  await page.getByRole('button', { name: 'Stock', exact: true }).click();
  await page.getByLabel('Search stock').fill(sku);
  const stock = page.getByRole('table', { name: 'Branch stock' });
  await expect(
    stock.getByRole('cell', { name: '141.000000', exact: true }),
  ).toBeVisible();
  await stock.getByRole('button', { name: 'Reserve', exact: true }).click();
  await page.getByLabel('Reservation quantity').fill('3');
  await page.getByLabel('Reservation reference').fill(`WEB-${suffix}`);
  await page.getByRole('button', { name: 'Allocate reservation' }).click();
  await expect(
    stock.getByRole('cell', { name: '7.000000', exact: true }),
  ).toBeVisible();
  await stock.getByRole('button', { name: 'Movements', exact: true }).click();
  await page
    .getByRole('table', { name: 'Movement ledger' })
    .getByRole('button', { name: 'Open source document' })
    .first()
    .click();
  await expect(page.getByText(/STK-\d+ · opening · posted/)).toBeVisible();
  await page.getByRole('button', { name: 'Reservations', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: `WEB-${suffix}` })
    .getByRole('button', { name: 'Release', exact: true })
    .click();
  await expect(
    page.getByRole('row').filter({ hasText: `WEB-${suffix}` }),
  ).toContainText('released');
  await page
    .getByRole('button', { name: 'Reconciliation', exact: true })
    .click();
  await expect(
    page.getByText('All balances reconcile.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stock', exact: true }).click();
  await page.screenshot({
    path: test.info().outputPath('inventory-stock.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(external).toEqual([]);
});
