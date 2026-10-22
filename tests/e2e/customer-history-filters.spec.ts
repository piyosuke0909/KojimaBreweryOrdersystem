import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('注文履歴の絞り込みは3状態だけを表示し、過去の状態も同じグループで確認できる', async ({ page }) => {
  expect((await page.request.post('/api/auth/demo/customer', { data: { company_id: 'company-a' } })).ok()).toBe(true);
  const orders = [
    ['HISTORY-RECEIVED', 'received'], ['HISTORY-CONFIRMED', 'confirmed'], ['HISTORY-PREPARING', 'preparing'],
    ['HISTORY-SHIPPED', 'shipped'], ['HISTORY-COMPLETED', 'completed'], ['HISTORY-CANCELLED', 'cancelled'],
  ].map(([id, status]) => ({ id, status, ordered_at: '2026-10-22T00:00:00Z', desired_delivery_date: '2030-01-10', total_amount: 1980, item_count: 1 }));
  const requestedStatuses: (string | null)[] = [];
  await page.route('**/api/customer/orders?*', route => {
    const status = new URL(route.request().url()).searchParams.get('status');
    requestedStatuses.push(status);
    if (status && !['received', 'shipped', 'cancelled'].includes(status)) {
      return route.fulfill({ status: 400, json: { error: { code: 'UNEXPECTED_FILTER', message: '3種類の状態で検索してください。' } } });
    }
    const grouped = { received: ['received', 'confirmed', 'preparing'], shipped: ['shipped', 'completed'], cancelled: ['cancelled'] };
    const rows = status ? orders.filter(order => grouped[status as keyof typeof grouped].includes(order.status)) : orders;
    return route.fulfill({ json: { data: rows, meta: { total: rows.length, page: 1, page_size: 20 } } });
  });
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: '注文履歴', exact: true })).toBeVisible();
  const filters = page.locator('.ko-filters').getByRole('button');
  await expect(filters).toHaveText(['すべて', '受付済', '発送済', 'キャンセル済']);
  await expect(filters).toHaveCount(4);
  await expect(page.locator('.ko-history-card')).toHaveCount(6);

  for (const [value, label, ids] of [
    ['received', '受付済', ['HISTORY-RECEIVED', 'HISTORY-CONFIRMED', 'HISTORY-PREPARING']],
    ['shipped', '発送済', ['HISTORY-SHIPPED', 'HISTORY-COMPLETED']],
    ['cancelled', 'キャンセル済', ['HISTORY-CANCELLED']],
  ] as const) {
    const response = page.waitForResponse(result => {
      const url = new URL(result.url());
      return url.pathname === '/api/customer/orders' && url.searchParams.get('status') === value;
    });
    await page.locator('.ko-filters').getByRole('button', { name: label, exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.locator('.ko-history-card h2')).toHaveText([...ids]);
    await expect(page.locator('.ko-history-card .ko-status')).toHaveText(ids.map(() => label));
    await expect(filters).toHaveCount(4);
  }

  await page.locator('.ko-filters').getByRole('button', { name: 'すべて', exact: true }).click();
  await expect(page.locator('.ko-history-card')).toHaveCount(6);
  expect(requestedStatuses).toEqual(expect.arrayContaining([null, 'received', 'shipped', 'cancelled']));
  expect(requestedStatuses.every(value => value === null || ['received', 'shipped', 'cancelled'].includes(value))).toBe(true);
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
});
