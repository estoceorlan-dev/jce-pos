import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { testPassword } from '../support/management.js';
import { testDatabase } from '../support/database.js';
import { createPool } from '../../backend/src/db/pool.js';
import { withTransaction } from '../../backend/src/db/transaction.js';
import {
  applyMovement,
  installation,
  reconcile,
} from '../../backend/src/inventory/ledger.js';
import { conservation } from '../../backend/src/transfers/service.js';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Catalog', exact: true }),
  ).toBeVisible();
}
test('local transfers reserve, dispatch, recover partial receipts, resolve shortages and return linked stock', async ({
  page,
}) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(15000);
  const project = test.info().project.name,
    author = `test.transfer.${project}`,
    reviewer = `test.transfer-reviewer.${project}`;
  const sku = `BTR-${randomUUID().slice(0, 8).toUpperCase()}`;
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:3100')) external.push(r.url());
  });
  await page.route('**/*', (route) =>
    route.request().url().startsWith('http://127.0.0.1:3100')
      ? route.continue()
      : route.abort(),
  );
  await login(page, author);
  const session = (await (
    await page.request.get('/api/v1/auth/session')
  ).json()) as {
    csrfToken: string;
    branchId: string;
    branches: { id: string; name: string }[];
    user: { id: string };
  };
  const source = session.branchId,
    destination = session.branches.find((b) => b.id !== source)!.id;
  const lookups = (await (
    await page.request.get('/api/v1/catalog/lookups')
  ).json()) as { units: { id: string }[] };
  const productResponse = await page.request.post('/api/v1/catalog/variants', {
    headers: {
      Origin: 'http://127.0.0.1:3100',
      'X-CSRF-Token': session.csrfToken,
    },
    data: {
      productName: 'Browser transfer product',
      name: 'Each',
      sku,
      unitId: lookups.units[0]!.id,
      conversion: '1',
      fractional: false,
      minimumStock: '0',
      taxCodeId: null,
      categoryId: null,
      brandId: null,
      barcodes: [],
      archived: false,
    },
  });
  expect(productResponse.ok(), await productResponse.text()).toBe(true);
  const product = (await productResponse.json()) as { id: string };
  const pool = createPool(testDatabase().connection('runtime'));
  try {
    await withTransaction(pool, async (tx) =>
      applyMovement(tx, {
        installationId: await installation(tx, source),
        branchId: source,
        variantId: product.id,
        condition: 'sellable',
        quantity: '10',
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
  await page
    .getByRole('link', { name: 'Branch transfers', exact: true })
    .click();
  await expect(
    page.getByText(
      'Transfers are available only between branches in this local installation.',
      { exact: false },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New transfer', exact: true }).click();
  await page
    .getByLabel('Destination branch', { exact: true })
    .selectOption(destination);
  await page
    .getByLabel('Transfer reason', { exact: true })
    .fill('Move three units for branch replenishment');
  const addProduct = async () => {
    await page.getByLabel('Find transfer product').fill(sku);
    await page
      .getByLabel('Add product', { exact: true })
      .selectOption(product.id);
  };
  await addProduct();
  await page.getByLabel('Draft quantity 1', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Save transfer draft' }).click();
  await expect(
    page.getByRole('button', { name: 'Submit for approval' }),
  ).toBeVisible();
  const id = new URL(page.url()).searchParams.get('transfer')!;
  const detail = async (branch: string, transfer = id) =>
    (await (
      await page.request.get(`/api/v1/branches/${branch}/transfers/${transfer}`)
    ).json()) as {
      transfer: { status: string };
      ledger: {
        transit_quantity: string;
        transit_value: string;
        matched: boolean;
      }[];
      receipts: unknown[];
      events: { note: string }[];
    };
  const action = async (name: string, note: string) => {
    await page.getByLabel('Action reason', { exact: true }).fill(note);
    await page.getByRole('button', { name, exact: true }).click();
  };
  await action('Submit for approval', 'Ready for independent review');
  await expect(
    page.getByText(
      'A different source-branch reviewer must approve this transfer.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Approve and reserve' }),
  ).toHaveCount(0);
  const switchUser = async (name: string, branch: string, transfer = id) => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await login(page, name);
    await page
      .getByLabel('Active branch', { exact: true })
      .selectOption(branch);
    await expect(page.getByLabel('Active branch', { exact: true })).toHaveValue(
      branch,
    );
    await page.goto(`/transfers?transfer=${transfer}`);
    await expect(
      page.getByRole('heading', { name: 'Transfer actions', exact: true }),
    ).toBeVisible();
  };
  await switchUser(reviewer, source);
  await page
    .getByLabel('Confirmation password', { exact: true })
    .fill(testPassword);
  await action('Approve and reserve', 'Approve the exact transfer');
  await expect(
    page.getByRole('button', { name: 'Dispatch transfer', exact: true }),
  ).toBeVisible();
  await switchUser(author, source);
  await action('Dispatch transfer', 'Goods handed to local transport');
  await expect(
    page.getByText('Dispatched transfers cannot be cancelled.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Cancel before shipment' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Post actual receipt' }),
  ).toHaveCount(0);
  await page
    .getByLabel('Active branch', { exact: true })
    .selectOption(destination);
  await page.goto(`/transfers?transfer=${id}`);
  await expect(
    page.getByRole('button', { name: 'Post actual receipt' }),
  ).toBeVisible();
  await page.getByLabel('Actual quantity 1', { exact: true }).fill('1');
  await page
    .getByLabel('Receipt or discrepancy reason')
    .fill('First unit physically received');
  await page.route(
    `**/transfers/${id}/receive`,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('connectionfailed');
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Post actual receipt' }).click();
  await expect(
    page.getByRole('heading', { name: 'Recover saved transfer action' }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('button', { name: 'Retry saved transfer action' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Recover saved transfer action' }),
  ).toHaveCount(0);
  expect((await detail(destination)).receipts).toHaveLength(1);
  expect((await detail(destination)).ledger[0]?.transit_quantity).toBe(
    '2.000000',
  );
  await page.getByLabel('Actual quantity 1', { exact: true }).fill('1');
  await page.getByLabel('Condition 1', { exact: true }).selectOption('damaged');
  await page
    .getByLabel('Receipt or discrepancy reason')
    .fill('Second unit arrived damaged');
  await page.getByRole('button', { name: 'Post actual receipt' }).click();
  await expect(
    page.getByRole('table', { name: 'Quantity conservation' }),
  ).toContainText('1.000000');
  await expect
    .poll(async () => (await detail(destination)).receipts.length)
    .toBe(2);
  await page.getByLabel('Transit action').selectOption('discrepancy');
  await page.getByLabel('Actual quantity 1', { exact: true }).fill('1');
  await page
    .getByLabel('Receipt or discrepancy reason')
    .fill('Last unit missing after transport investigation');
  await page
    .getByRole('button', { name: 'Request discrepancy review' })
    .click();
  await expect(
    page.getByRole('table', { name: 'Exact discrepancy proposal' }),
  ).toContainText('10.000000');
  await expect(
    page.getByRole('button', { name: 'Confirm discrepancy resolution' }),
  ).toHaveCount(0);
  await switchUser(reviewer, destination);
  await page
    .getByLabel('Confirmation password', { exact: true })
    .fill(testPassword);
  await action(
    'Confirm discrepancy resolution',
    'Independent loss review confirmed',
  );
  await expect(
    page.getByText('Closed with discrepancy', { exact: true }),
  ).toBeVisible();
  const closed = await detail(destination);
  expect(closed.ledger[0]).toMatchObject({
    transit_quantity: '0.000000',
    transit_value: '0.000000',
    matched: true,
  });
  expect(closed.events.at(-1)?.note).toBe('Independent loss review confirmed');
  await page.evaluate(() => {
    window.print = () =>
      document.documentElement.setAttribute('data-transfer-print', 'yes');
  });
  await page.getByRole('button', { name: 'Print transfer slip' }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-transfer-print',
    'yes',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('transfer-closed.png'),
    fullPage: true,
  });
  await page.emulateMedia({ media: 'print' });
  await expect(
    page.getByRole('heading', { name: 'Transfer actions' }),
  ).toBeHidden();
  await expect(
    page.getByRole('region', { name: 'Transfer slip' }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('transfer-slip.png'),
    fullPage: true,
  });
  await page.emulateMedia({ media: 'screen' });
  // Received sellable stock returns through its own independently approved transfer.
  await switchUser(author, destination);
  await page
    .getByRole('button', { name: 'Create linked return transfer' })
    .click();
  await addProduct();
  await page.getByRole('button', { name: 'Save transfer draft' }).click();
  await expect(
    page.getByRole('button', { name: 'Submit for approval' }),
  ).toBeVisible();
  const returnId = new URL(page.url()).searchParams.get('transfer')!;
  expect(returnId).not.toBe(id);
  await action('Submit for approval', 'Return the sellable unit');
  await switchUser(reviewer, destination, returnId);
  await page
    .getByLabel('Confirmation password', { exact: true })
    .fill(testPassword);
  await action('Approve and reserve', 'Approve linked return');
  await expect(
    page.getByRole('button', { name: 'Dispatch transfer' }),
  ).toBeVisible();
  await action('Dispatch transfer', 'Return shipment dispatched');
  await expect(
    page.getByText('Dispatched transfers cannot be cancelled.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByLabel('Active branch', { exact: true }).selectOption(source);
  await page.goto(`/transfers?transfer=${returnId}`);
  await page.getByLabel('Actual quantity 1', { exact: true }).fill('1');
  await page
    .getByLabel('Receipt or discrepancy reason')
    .fill('Linked return physically received');
  await page.getByRole('button', { name: 'Post actual receipt' }).click();
  await expect
    .poll(async () => (await detail(source, returnId)).transfer.status)
    .toBe('received');
  const verify = createPool(testDatabase().connection('runtime'));
  try {
    expect((await conservation(verify, id)).every((r) => r.matched)).toBe(true);
    expect((await conservation(verify, returnId)).every((r) => r.matched)).toBe(
      true,
    );
    expect((await reconcile(verify)).every((r) => r.matched)).toBe(true);
    const balances = await verify.query<{
      branch_id: string;
      condition: string;
      quantity: string;
      value: string;
    }>(
      'SELECT branch_id,condition,quantity,value FROM inventories WHERE variant_id=$1',
      [product.id],
    );
    expect(balances.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch_id: source,
          condition: 'sellable',
          quantity: '8.000000',
          value: '80.000000',
        }),
        expect.objectContaining({
          branch_id: destination,
          condition: 'sellable',
          quantity: '0.000000',
          value: '0.000000',
        }),
        expect.objectContaining({
          branch_id: destination,
          condition: 'damaged',
          quantity: '1.000000',
          value: '10.000000',
        }),
      ]),
    );
  } finally {
    await verify.end();
  }
  expect(external).toEqual([]);
});
