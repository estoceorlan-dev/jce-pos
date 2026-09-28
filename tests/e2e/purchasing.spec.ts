import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { testPassword } from '../support/management.js';
async function login(page: Page, name: string, password = testPassword) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('purchase approval, partial receiving, printing, supplier history and reviewed reversal', async ({
  page,
}) => {
  test.setTimeout(120000);
  const suffix = randomUUID().slice(0, 8);
  const sku = `BUY-${suffix.toUpperCase()}`;
  const supplierName = `Receiving supplier ${suffix}`;
  const reviewer = `buyer.${suffix}`;
  const reviewPassword = 'Receiving-reviewer-password-2026!';
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
  const variant = await page.request.post('/api/v1/catalog/variants', {
    headers,
    data: {
      productName: 'Receiving test product',
      name: 'Pack',
      sku,
      unitId: lookups.units[0]!.id,
      conversion: '6',
      fractional: false,
      minimumStock: '0',
      taxCodeId: null,
      categoryId: null,
      brandId: null,
      barcodes: [],
      archived: false,
    },
  });
  expect(variant.ok()).toBe(true);
  const variantId = ((await variant.json()) as { id: string }).id;
  const supplier = await page.request.post(
    `/api/v1/branches/${session.branchId}/suppliers`,
    { headers, data: { name: supplierName, contact: '', archived: false } },
  );
  expect(supplier.ok()).toBe(true);
  const supplierId = ((await supplier.json()) as { id: string }).id;
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
  await page.getByRole('link', { name: 'Purchasing', exact: true }).click();
  await page
    .getByRole('button', { name: 'New purchase order', exact: true })
    .click();
  await page.getByLabel('Find supplier', { exact: true }).fill(suffix);
  await page
    .getByRole('combobox', { name: 'Supplier', exact: true })
    .selectOption(supplierId);
  await page.getByLabel('Order notes').fill(`Browser order ${suffix}`);
  await page.getByLabel('Find product').fill(sku);
  await page
    .getByRole('combobox', { name: 'Product variant', exact: true })
    .selectOption(variantId);
  await page.getByRole('button', { name: 'Add order line' }).click();
  await page.getByLabel('Ordered quantity').fill('5');
  await page.getByLabel('Cost per purchase unit (PHP)').fill('120');
  await page.getByLabel('Discount rate (0.10 = 10%)').fill('0.1');
  await page.getByLabel('Tax rate (0.12 = 12%)').fill('0.12');
  await page.getByRole('button', { name: 'Save order draft' }).click();
  await expect(
    page.getByRole('heading', { name: /Purchase order PO-/ }),
  ).toBeVisible();
  const orderId = new URL(page.url()).searchParams.get('order')!;
  await page.getByLabel('Action reason').fill('Ready for independent review');
  await page.getByRole('button', { name: 'Submit order', exact: true }).click();
  await expect(
    page.getByText('A different authorized reviewer must approve this order.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, reviewer);
  await expect(
    page.getByRole('heading', { name: 'Change password', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Current password').fill(testPassword);
  await page.getByLabel('New password').fill(reviewPassword);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await login(page, reviewer, reviewPassword);
  await expect(
    page.getByRole('heading', { name: 'Catalog', exact: true }),
  ).toBeVisible();
  await page.goto(`/purchasing?order=${orderId}`);
  await page.getByLabel('Action reason').fill('Terms and quantities checked');
  await page.getByLabel('Confirm your password').fill(reviewPassword);
  await page
    .getByRole('button', { name: 'Approve order', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Receive delivery' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Receive delivery' }).click();
  await page.getByLabel('Supplier invoice reference').fill(`INV-${suffix}`);
  await page.getByLabel('Unique delivery reference').fill(`DELIVERY-${suffix}`);
  await page.getByLabel('Delivered quantity').fill('2');
  await page.getByRole('button', { name: 'Save receiving draft' }).click();
  await expect(
    page.getByRole('button', { name: 'Post goods receipt' }),
  ).toBeVisible();
  const receiptId = new URL(page.url()).searchParams.get('receipt')!;
  await page.getByRole('button', { name: 'Post goods receipt' }).click();
  await expect(
    page.getByRole('heading', { name: /Goods receipt GR-/ }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Totals (PHP): net 216.00 · tax 25.92 · supplier total 241.92 · stock value 216.000000',
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    window.print = () => {
      document.documentElement.dataset['printRequested'] = 'true';
    };
  });
  await page.getByRole('button', { name: 'Print receiving document' }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-print-requested',
    'true',
  );
  const screenViewport = page.viewportSize()!;
  // Print layout uses the landscape paper width, including on a phone.
  await page.setViewportSize({ width: 1122, height: 794 });
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({
    path: test.info().outputPath('receiving-print.png'),
    fullPage: true,
  });
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize(screenViewport);
  await page.getByLabel('Reversal reason').fill('Correct the delivery entry');
  await page.getByRole('button', { name: 'Request full reversal' }).click();
  await expect(
    page.getByText(
      'A different authorized reviewer must approve this reversal.',
    ),
  ).toBeVisible();
  const reversalId = new URL(page.url()).searchParams.get('receipt')!;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, 'test.admin');
  await expect(
    page.getByRole('heading', { name: 'Catalog', exact: true }),
  ).toBeVisible();
  await page.goto(`/purchasing?receipt=${reversalId}`);
  await page.getByLabel('Reviewer password').fill(testPassword);
  await page.getByRole('button', { name: 'Approve receipt reversal' }).click();
  await expect(
    page.getByRole('heading', { name: /Receiving reversal GRV-/ }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open original receipt' }).click();
  await expect(
    page.getByRole('heading', { name: /Goods receipt GR-/ }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get('receipt')).toBe(receiptId);
  await page.getByRole('link', { name: 'Suppliers', exact: true }).click();
  await page.getByLabel('Search', { exact: true }).fill(suffix);
  await page
    .getByRole('row')
    .filter({ hasText: supplierName })
    .getByRole('link', { name: 'Purchase history' })
    .click();
  await expect(
    page.getByRole('table', { name: 'Goods receipts and reversals' }),
  ).toBeVisible();
  await expect(
    page.getByText(/Posted supplier totals, net of reversals: net PHP 0.00/),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('supplier-purchase-history.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(external).toEqual([]);
});
