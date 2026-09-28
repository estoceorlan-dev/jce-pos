import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { testPassword } from '../support/management.js';
import { testDatabase } from '../support/database.js';
import { createPool } from '../../backend/src/db/pool.js';
import { withTransaction } from '../../backend/src/db/transaction.js';
import {
  applyMovement,
  installation,
} from '../../backend/src/inventory/ledger.js';
async function login(page: Page, name = 'test.admin', password = testPassword) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('cashier scans, holds, discounts, recovers a lost checkout response and reprints committed receipts', async ({
  page,
}) => {
  test.setTimeout(150000);
  const author = `test.checkout.${test.info().project.name}`;
  const suffix = randomUUID().slice(0, 8),
    sku = `TILL-${suffix.toUpperCase()}`,
    reviewer = `till.${suffix}`,
    reviewPassword = 'Checkout-review-password-2026!';
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:3100')) external.push(r.url());
  });
  // Simulate no internet while retaining the branch host connection.
  await page.route('**/*', (route) =>
    route.request().url().startsWith('http://127.0.0.1:3100')
      ? route.continue()
      : route.abort(),
  );
  await login(page, author);
  await expect(
    page.getByRole('heading', { name: 'Catalog', exact: true }),
  ).toBeVisible();
  const session = (await (
    await page.request.get('/api/v1/auth/session')
  ).json()) as { csrfToken: string; branchId: string; user: { id: string } };
  const headers = {
    Origin: 'http://127.0.0.1:3100',
    'X-CSRF-Token': session.csrfToken,
  };
  const post = async (path: string, data: object) => {
    const r = await page.request.post('/api/v1' + path, { headers, data });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()) as { id: string };
  };
  const tax = await post('/catalog/taxes', {
    code: `TAX_${suffix.toUpperCase()}`,
    name: `Tax ${suffix}`,
    rate: '0.12',
    inclusive: true,
    archived: false,
  });
  const lookups = (await (
    await page.request.get('/api/v1/catalog/lookups')
  ).json()) as { units: { id: string }[] };
  const product = await post('/catalog/variants', {
    productName: 'Checkout browser product',
    name: 'Pack',
    sku,
    unitId: lookups.units[0]!.id,
    conversion: '6',
    fractional: false,
    minimumStock: '0',
    taxCodeId: tax.id,
    categoryId: null,
    brandId: null,
    barcodes: [`BAR-${suffix}`],
    archived: false,
  });
  expect(
    (
      await page.request.put(
        `/api/v1/branches/${session.branchId}/prices/${product.id}`,
        { headers, data: { version: 0, amount: '112' } },
      )
    ).ok(),
  ).toBe(true);
  const customer = await post(`/branches/${session.branchId}/customers`, {
    name: `Buyer ${suffix}`,
    contact: '',
    archived: false,
  });
  const terminal = await post(`/branches/${session.branchId}/terminals`, {
    code: `T_${suffix.toUpperCase()}`,
  });
  const register = await post(`/branches/${session.branchId}/registers`, {
    code: `R_${suffix.toUpperCase()}`,
    terminalId: terminal.id,
  });
  await post('/users', {
    username: reviewer,
    displayName: reviewer,
    password: testPassword,
    roles: ['manager'],
    branchIds: [session.branchId],
  });
  const pool = createPool(testDatabase().connection('runtime'));
  try {
    await withTransaction(pool, async (tx) =>
      applyMovement(tx, {
        installationId: await installation(tx, session.branchId),
        branchId: session.branchId,
        variantId: product.id,
        condition: 'sellable',
        quantity: '24',
        unitCost: '10',
        sourceType: 'synthetic',
        sourceId: randomUUID(),
        sourceLineId: randomUUID(),
        actorId: session.user.id,
      }),
    );
  } finally {
    await pool.end();
  }
  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  await page.getByText('Open a register with float', { exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Register', exact: true })
    .selectOption(register.id);
  await page.getByLabel('Opening float (PHP)').fill('500');
  await page
    .getByRole('button', { name: 'Open register', exact: true })
    .click();
  await page.getByRole('button', { name: 'New cart', exact: true }).click();
  const scan = page.getByLabel('Scan barcode or search');
  await expect(scan).toBeFocused();
  await scan.fill(`BAR-${suffix}`);
  await scan.press('Enter');
  await page.getByLabel(`Quantity for ${sku}`, { exact: true }).fill('2');
  await page
    .getByLabel(`Line discount for ${sku} (PHP)`, { exact: true })
    .fill('22.40');
  await page.getByLabel('Find customer').fill(suffix);
  await page
    .getByRole('combobox', { name: 'Customer', exact: true })
    .selectOption(customer.id);
  await page.getByRole('button', { name: 'Save and review cart' }).click();
  await expect(
    page.getByText(
      'Net PHP 180.00 · discount PHP 22.40 · tax PHP 21.60 · total PHP 201.60',
    ),
  ).toBeVisible();
  const cartId = new URL(page.url()).searchParams.get('cart')!;
  await page.getByRole('button', { name: 'Hold cart', exact: true }).click();
  await page.getByRole('button', { name: 'Resume cart', exact: true }).click();
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
  await page.goto(`/checkout?cart=${cartId}`);
  await page
    .getByLabel('Discount review reason')
    .fill('Synthetic discount verified');
  await page.getByLabel('Reviewer password').fill(reviewPassword);
  await page.getByRole('button', { name: 'Approve exact discount' }).click();
  await expect(
    page.getByText(new RegExp(`Discount reviewed by ${reviewer}`)),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, author);
  await expect(
    page.getByRole('heading', { name: 'Catalog', exact: true }),
  ).toBeVisible();
  await page.goto(`/checkout?cart=${cartId}`);
  await page.getByLabel('Amount 1 (PHP)').fill('150');
  await page.getByRole('button', { name: 'Add split payment' }).click();
  await page
    .getByRole('combobox', { name: 'Method 2', exact: true })
    .selectOption('card');
  await page.getByLabel('Amount 2 (PHP)').fill('100');
  await page.getByLabel('Reference 2').fill(`AUTH-${suffix}`);
  let committedId = '';
  await page.route(
    `**/checkout/carts/${cartId}/post`,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committedId = ((await response.json()) as { id: string }).id;
      await route.abort('connectionfailed');
    },
    { times: 1 },
  );
  await page
    .getByRole('button', { name: 'Complete sale', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Checkout result needs checking' }),
  ).toBeVisible();
  await expect.poll(() => committedId).not.toBe('');
  await page.reload();
  await page.route(
    `**/checkout/carts/${cartId}/post`,
    (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Sign in again to recover this checkout.',
          },
        }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Retry saved checkout' }).click();
  await expect(page.getByRole('alert')).toContainText('Sign in again');
  await expect(
    page.getByRole('heading', { name: 'Checkout result needs checking' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry saved checkout' }).click();
  await expect(
    page.getByRole('heading', { name: /Receipt SALE-/ }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get('sale')).toBe(committedId);
  await expect(
    page.getByText('Sale committed — printing not confirmed.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Change PHP 48.40', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.print = () => {
      throw new Error('Synthetic printer unavailable');
    };
  });
  await page
    .getByRole('button', { name: 'Print receipt', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic printer unavailable',
  );
  await page.getByRole('button', { name: 'Record printing failed' }).click();
  await page.evaluate(() => {
    window.print = () => {
      document.documentElement.dataset['printed'] = 'true';
    };
  });
  await page
    .getByRole('button', { name: 'Reprint receipt', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-printed', 'true');
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({
    path: test.info().outputPath('sale-receipt-print.png'),
    fullPage: true,
  });
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Confirm paper printed' }).click();
  await expect(
    page.getByText('Printing confirmed by operator.', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('sale-and-print-history.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const after = (await (
    await page.request.get(
      `/api/v1/branches/${session.branchId}/sales/${committedId}`,
    )
  ).json()) as { prints: unknown[]; sale: { total: string } };
  expect(after.prints).toHaveLength(4);
  expect(after.sale.total).toBe('201.60');
  expect(external).toEqual([]);
});
