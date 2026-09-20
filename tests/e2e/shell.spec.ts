import { expect, test } from '@playwright/test';

test('production shell supports navigation, local assets and a validated form', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:3100'))
      external.push(request.url());
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Ready for the next chapter.' }),
  ).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: test.info().outputPath('overview.png'),
    fullPage: true,
  });
  await expect(page.getByRole('navigation').getByText('Checkout')).toHaveCount(
    0,
  );
  await page.getByRole('link', { name: 'Workstation', exact: true }).click();
  await expect(page.locator('main')).toBeFocused();
  await page.getByLabel('Display name').fill('X');
  await page.getByRole('button', { name: 'Apply label' }).click();
  await expect(page.getByText('Enter at least 2 characters.')).toBeVisible();
  await page.getByLabel('Display name').fill('Till 01');
  await page.getByRole('button', { name: 'Apply label' }).click();
  await expect(page.locator('.station')).toHaveText('Till 01');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Workstation label' }),
  ).toBeVisible();
  expect(external).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test('exposes loading, error and recovery states', async ({ page }) => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/health/ready', async (route) => {
    await pending;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"status":"not_ready"}',
    });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Checking the local service' }),
  ).toBeVisible();
  release();
  await expect(page.getByRole('alert')).toContainText(
    'Local service unavailable',
  );
  await page.unroute('**/health/ready');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
});
test('deep links remain guarded and unknown pages are clear', async ({
  page,
  request,
}) => {
  await page.goto('/checkout');
  await expect(
    page.getByRole('heading', { name: 'Access unavailable' }),
  ).toBeVisible();
  await page.goto('/missing');
  await expect(
    page.getByRole('heading', { name: 'Page not found' }),
  ).toBeVisible();
  const response = await request.get('/api/v1/missing', {
    headers: { Accept: 'text/html' },
  });
  expect(response.status()).toBe(404);
  expect((await response.json()).error.code).toBe('NOT_FOUND');
});
