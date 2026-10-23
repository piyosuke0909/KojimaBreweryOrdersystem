import { expect, test, type Page, type Route } from '@playwright/test';

const companyA = { id: 'badge-company-a', name: 'A商店', status: 'active', contact_name: '担当者A', addresses: [], invitations: [], contracts: [], prices: [], line_users: [] };
const companyB = { ...companyA, id: 'badge-company-b', name: 'Bホテル', contact_name: '担当者B' };
const event = (id: string, companyId: string, kind: string, href: string) => ({ id, company_id: companyId, kind, category: kind === 'line_message' ? 'companies' : 'orders', href, title: '会社ごとの新着', created_at: '2026-10-23T01:00:00Z', is_read: false });
async function setup(page: Page, options: { invalidHref?: boolean; unavailable?: boolean } = {}) {
  const events = [
    event('notice-a-order', companyA.id, 'order_created', '/admin/orders/badge-order'),
    event('notice-a-line', companyA.id, 'line_message', options.invalidHref ? 'https://example.invalid/untrusted' : `/admin/companies/${companyA.id}?tab=line-messages&line_user_id=badge-member-a`),
    event('notice-b-line', companyB.id, 'line_message', `/admin/companies/${companyB.id}?tab=line-messages&line_user_id=badge-member-b`),
  ];
  const state = { events, reads: [] as string[], companyQueries: [] as string[][], unavailable: options.unavailable ?? false };
  const send = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: { message: '通知サービスを再確認してください' } } });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/api/auth/me') return send(route, { actor: { type: 'admin', id: 'company-badge-admin', role: 'owner', name: '担当管理者' } });
    if (path === '/api/config') return send(route, { environment: 'development', demo_enabled: false });
    if (path === '/api/admin/notifications') return send(route, { items: events.slice(-5), total_unread: events.filter(item => !item.is_read).length, counts: { orders: 1, companies: 2 } });
    if (path === '/api/admin/notifications/companies') {
      const ids = (url.searchParams.get('company_ids') || '').split(','); state.companyQueries.push(ids);
      if (state.unavailable) return send(route, {}, 503);
      return send(route, { items: ids.filter(id => [companyA.id, companyB.id].includes(id)).map(companyId => {
        const unread = events.filter(item => item.company_id === companyId && !item.is_read);
        const orders = unread.filter(item => item.category === 'orders'), line = unread.filter(item => item.category === 'companies');
        return { company_id: companyId, total_unread: unread.length, counts: { orders: orders.length, line_messages: line.length }, latest: unread.at(-1) || null, latest_orders: orders.at(-1) || null, latest_line_message: line.at(-1) || null };
      }) });
    }
    const read = path.match(/^\/api\/admin\/notifications\/([^/]+)\/read$/);
    if (read) { state.reads.push(read[1]); const item = events.find(item => item.id === read[1]); if (item) item.is_read = true; return send(route, {}); }
    if (path === '/api/admin/companies') return send(route, [companyA, companyB]);
    if (path === `/api/admin/companies/${companyA.id}`) return send(route, companyA);
    if (path === `/api/admin/companies/${companyB.id}`) return send(route, companyB);
    if (path.endsWith('/line-messages')) return send(route, { contacts: [], send_enabled: false });
    if (path === '/api/admin/orders/badge-order') return send(route, { id: 'badge-order', company_id: companyA.id, company_name: companyA.name, status: 'received', total_amount: 1100, items_subtotal: 1000, shipping_fee: 0, tax_amount: 100, version: 1, items: [], packages: [], revisions: [], can_edit: true, can_cancel: true, is_invoice_locked: 0 });
    if (path === '/api/admin/shipping-rules' || path === '/api/admin/products' || path === '/api/admin/orders') return send(route, []);
    return send(route, {});
  });
  return state;
}

test('会社名の横で会社別の未読件数が分かり、通常の会社表示では既読にしない', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/admin/companies');
  const a = page.getByRole('link', { name: 'A商店の未読通知2件を確認', exact: true });
  const b = page.getByRole('link', { name: 'Bホテルの未読通知1件を確認', exact: true });
  await expect(a).toHaveText('未読 2'); await expect(b).toHaveText('未読 1');
  await expect(a).toHaveCSS('background-color', 'rgb(201, 37, 44)');
  expect(state.companyQueries.some(ids => ids.includes(companyA.id) && ids.includes(companyB.id))).toBe(true);
  expect(state.reads).toEqual([]);
  await page.getByRole('link', { name: 'A商店', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A商店', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'A商店の未読LINE1件を確認', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'A商店の未読注文1件を確認', exact: true })).toBeVisible();
  expect(state.reads).toEqual([]);
});

test('会社の赤い通知から該当先へ移動し、その通知だけを既読にする', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/admin/companies');
  await page.getByRole('link', { name: 'A商店の未読通知2件を確認', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/companies/${companyA.id}\\?tab=line-messages&line_user_id=badge-member-a$`));
  expect(state.reads).toEqual(['notice-a-line']);
  await expect(page.getByRole('link', { name: 'A商店の未読注文1件を確認', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'A商店の未読注文1件を確認', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/badge-order$/);
  expect(state.reads).toEqual(['notice-a-line', 'notice-a-order']);
  expect(state.events.find(item => item.id === 'notice-b-line')?.is_read).toBe(false);
});

test('スマートフォンでも会社の未読が収まり、既読イベントで該当会社だけ更新する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await setup(page); await page.goto('/admin/companies');
  await expect(page.getByRole('link', { name: 'A商店の未読通知2件を確認', exact: true })).toBeVisible();
  state.events.filter(item => item.company_id === companyA.id).forEach(item => { item.is_read = true; });
  await page.evaluate(() => window.dispatchEvent(new Event('kojima-admin-notifications-changed')));
  await expect(page.getByRole('link', { name: /A商店の未読通知/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Bホテルの未読通知1件を確認', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  expect(state.reads).toEqual([]);
});

test('未読APIの障害でも会社は表示し、再読込と外部リンクの遮断に対応する', async ({ page }) => {
  const state = await setup(page, { unavailable: true, invalidHref: true }); await page.goto('/admin/companies');
  await expect(page.getByRole('link', { name: 'A商店', exact: true })).toBeVisible();
  await expect(page.getByText('会社ごとの未読通知を取得できませんでした。', { exact: false })).toBeVisible();
  state.unavailable = false;
  await page.getByRole('button', { name: '通知を再読み込み', exact: true }).click();
  const badge = page.getByRole('link', { name: 'A商店の未読通知2件を確認', exact: true });
  await expect(badge).toHaveAttribute('href', `/admin/companies/${companyA.id}`);
  await badge.click(); await expect(page).toHaveURL(new RegExp(`/admin/companies/${companyA.id}$`));
  expect(state.reads).toEqual(['notice-a-line']);
});
