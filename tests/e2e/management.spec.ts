import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { testPassword } from '../support/management.js';
async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('test.admin');
  await page.getByLabel('Password', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Catalog', exact: true }),
  ).toBeVisible();
}
test('signed-in users switch branches, lock, unlock and end sessions', async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole('cell', { name: '25.00', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Active branch')
    .selectOption({ label: 'Synthetic branch B' });
  await expect(
    page.getByRole('cell', { name: '27.50', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Workstation locked' }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByLabel('Password', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Catalog', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();
});
test('catalog, contact and CSV workflows work from the shared browser UI', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const sku = `WEB-${suffix}`;
  await signIn(page);
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page
    .getByLabel('Product name', { exact: true })
    .fill('Synthetic browser item');
  await page.getByLabel('Variant name', { exact: true }).fill('Standard');
  await page.getByLabel('SKU', { exact: true }).fill(sku);
  await page
    .getByLabel('Base unit', { exact: true })
    .selectOption({ label: 'Piece' });
  await page.getByLabel('Barcode aliases').fill(`BAR-${suffix}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'New product variant' }),
  ).toHaveCount(0);
  await page.getByLabel('Search', { exact: true }).fill(`BAR-${suffix}`);
  await expect(
    page.getByRole('cell', { name: sku, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Price', exact: true }).click();
  await page.getByLabel('Price (PHP)', { exact: true }).fill('42.75');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: '42.75' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Price history', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Price history', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('catalog.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await page.getByRole('button', { name: 'Add customer', exact: true }).click();
  await page
    .getByLabel('Name', { exact: true })
    .fill(`Synthetic customer ${suffix}`);
  await page.getByLabel('Contact information').fill('Test contact only');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('cell', {
      name: `Synthetic customer ${suffix}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: `Edit Synthetic customer ${suffix}`,
      exact: true,
    })
    .click();
  await page.getByLabel('Archived', { exact: true }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Status', exact: true })
    .selectOption('true');
  await expect(
    page.getByRole('cell', {
      name: `Synthetic customer ${suffix}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Use walk-in customer' }).click();
  await expect(page.getByText('Walk-in', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Catalog import', exact: true }).click();
  const contents = `sku,product_name,variant_name,unit,conversion,fractional,minimum_stock,barcode,price\nCSV-${suffix},Synthetic imported item,Plain,Piece,1,false,0,,3.50`;
  await page.getByLabel('CSV file').setInputFiles({
    name: 'synthetic.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(contents),
  });
  await page.getByRole('button', { name: 'Preview import' }).click();
  await expect(
    page.getByRole('cell', { name: `CSV-${suffix}`, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Commit reviewed import' }).click();
  await expect(
    page.getByText('Import committed: 1 added, 0 skipped.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Commit reviewed import' }).click();
  await expect(
    page.getByText('Import committed: 1 added, 0 skipped.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Catalog', exact: true }).click();
  await page.getByLabel('Search', { exact: true }).fill(`CSV-${suffix}`);
  await expect(
    page.getByRole('cell', { name: '3.50', exact: true }),
  ).toBeVisible();
});
