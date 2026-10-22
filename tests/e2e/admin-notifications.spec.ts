import { expect, test, type Page, type Route } from '@playwright/test';

type Item = { id: string; kind: string; category: 'orders' | 'companies'; title: string; href: string; created_at: string; is_read: boolean };
const items = (): Item[] => Array.from({ length: 8 }, (_, index) => ({
  id: `notification-${index}`, kind: index % 3 === 0 ? 'line_message' : index === 1 ? 'order_cancelled' : 'order_created',
  category: index % 3 === 0 ? 'companies' : 'orders', title: `新着通知 ${index + 1}`,
  href: index % 3 === 0 ? '/admin/companies/company-a?tab=line-messages&line_user_id=line-user-a' : '/admin/orders/notify-order',
  created_at: `2026-10-22T10:${String(30 - index).padStart(2, '0')}:00.000Z`, is_read: false,
}));

async function setup(page: Page, options: { role?: 'owner' | 'staff'; total?: number; invalidHref?: boolean } = {}) {
  const state = { items: items(), reads: [] as string[], readAll: 0, requests: 0, loggedIn: true };
  if (options.invalidHref) state.items[0].href = 'https://example.invalid/steal';
  const result = () => {
    const unread = state.items.filter(item => !item.is_read);
    return { items: state.items.slice(0, 5), total_unread: options.total && unread.length ? options.total : unread.length, counts: { orders: unread.filter(item => item.category === 'orders').length, companies: unread.filter(item => item.category === 'companies').length } };
  };
  const send = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: data } });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return state.loggedIn ? send(route, { actor: { id: 'notification-admin', type: 'admin', role: options.role || 'owner', name: '通知確認管理者' } }) : send(route, { message: 'ログインしてください' }, 401);
    if (path === '/api/auth/logout') { state.loggedIn = false; return send(route, { logged_out: true }); }
    if (path === '/api/config') return send(route, { environment: 'development', demo_enabled: false });
    if (path === '/api/admin/notifications') { state.requests++; return send(route, result()); }
    if (path === '/api/admin/notifications/read-all') { state.readAll++; state.items.forEach(item => { item.is_read = true; }); return send(route, result()); }
    const mark = path.match(/^\/api\/admin\/notifications\/([^/]+)\/read$/);
    if (mark) { state.reads.push(mark[1]); const item = state.items.find(item => item.id === mark[1]); if (item) item.is_read = true; return send(route, result()); }
    if (path === '/api/admin/dashboard') return send(route, { recent_orders: [] });
    if (path === '/api/admin/company-info') return send(route, { id: 1, name: '小島醸造' });
    if (path === '/api/admin/orders/notify-order') return send(route, { id: 'notify-order', company_id: 'company-a', company_name: 'A商店', ordered_by_name: '注文担当者', ordered_at: '2026-10-22T10:00:00Z', desired_delivery_date: '2030-01-01', status: 'received', total_amount: 1980, items_subtotal: 1800, shipping_fee: 0, tax_amount: 180, items: [], packages: [], revisions: [], can_edit: true, can_cancel: true, version: 1, is_invoice_locked: 0 });
    if (path === '/api/admin/orders' || path === '/api/admin/companies') return send(route, []);
    return send(route, {});
  });
  return state;
}

const bell = (page: Page) => page.getByRole('button', { name: /^通知(?:（未読\d+件）)?$/ });

test('ベルは最新5件だけを表示し、開くだけでは既読にせず左メニューに未読数を表示する', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/admin/settings');
  await expect(bell(page)).toHaveAccessibleName('通知（未読8件）');
  const nav = page.getByRole('navigation', { name: '管理メニュー', exact: true });
  await expect(nav.getByRole('link', { name: '注文管理', exact: true }).locator('sup')).toHaveText('5');
  await expect(nav.getByRole('link', { name: '取引先管理', exact: true }).locator('sup')).toHaveText('3');
  await bell(page).click();
  const panel = page.getByRole('dialog', { name: '新着通知', exact: true });
  await expect(panel.getByRole('link')).toHaveCount(5);
  await expect(panel).toContainText('新着通知 1');
  await expect(panel).not.toContainText('新着通知 6');
  await expect(panel.getByRole('link').first()).toHaveAttribute('href', '/admin/companies/company-a?tab=line-messages&line_user_id=line-user-a');
  expect(state.reads).toEqual([]); expect(state.readAll).toBe(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(bell(page)).toBeFocused();
  await expect(bell(page)).toHaveAccessibleName('通知（未読8件）');
});

test('通知リンクから注文詳細へ移動し、その通知だけを既読にする', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/admin/settings');
  await expect(bell(page)).toHaveAccessibleName('通知（未読8件）');
  await bell(page).click();
  await page.getByRole('dialog', { name: '新着通知', exact: true }).getByRole('link', { name: /新着通知 2/ }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/notify-order$/);
  await expect(page.getByRole('heading', { name: /注文詳細/ })).toBeVisible();
  await expect(bell(page)).toHaveAccessibleName('通知（未読7件）');
  expect(state.reads).toEqual(['notification-1']); expect(state.readAll).toBe(0);
  await expect(page.getByRole('navigation', { name: '管理メニュー', exact: true }).getByRole('link', { name: '注文管理', exact: true }).locator('sup')).toHaveText('4');
});

test('すべて既読は明示操作時だけ実行し、赤い件数を消す', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/admin/settings');
  await expect(bell(page)).toHaveAccessibleName('通知（未読8件）');
  await bell(page).click();
  expect(state.readAll).toBe(0);
  await page.getByRole('button', { name: 'すべて既読', exact: true }).click();
  await expect(bell(page)).toHaveAccessibleName('通知');
  await expect(page.locator('.admin-notification-nav-badge')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'すべて既読', exact: true })).toBeDisabled();
  expect(state.readAll).toBe(1);
  await expect(page.getByRole('dialog', { name: '新着通知', exact: true }).getByRole('link')).toHaveCount(5);
});

test('LINE会話の既読イベント後に件数を再取得し、別の未読通知は残す', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/admin/settings');
  await expect(bell(page)).toHaveAccessibleName('通知（未読8件）');
  state.items.filter(item => item.category === 'companies').forEach(item => { item.is_read = true; });
  const before = state.requests;
  await page.evaluate(() => window.dispatchEvent(new Event('kojima-admin-notifications-changed')));
  await expect.poll(() => state.requests).toBeGreaterThan(before);
  await expect(bell(page)).toHaveAccessibleName('通知（未読5件）');
  await expect(page.getByRole('navigation', { name: '管理メニュー', exact: true }).getByRole('link', { name: '取引先管理', exact: true }).locator('sup')).toHaveCount(0);
  expect(state.reads).toEqual([]); expect(state.readAll).toBe(0);
});

test('スマートフォンと折りたたみメニューでも件数とベルを表示し、通知は画面内に収まる', async ({ page }) => {
  await setup(page, { total: 123 });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/admin/settings');
  await expect(bell(page)).toHaveAccessibleName('通知（未読123件）');
  await expect(page.locator('.admin-notification-bell-badge')).toHaveText('99+');
  await page.getByRole('button', { name: /メニューを閉じる/ }).click();
  await expect(page.locator('.admin-notification-nav-badge').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await bell(page).click();
  await expect(page.getByRole('dialog', { name: '新着通知', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  expect(await bell(page).evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
});

test('スタッフ管理者も通知を確認でき、外部URLの通知は管理画面内へ留める', async ({ page }) => {
  await setup(page, { role: 'staff', invalidHref: true });
  await page.goto('/admin/settings');
  await expect(bell(page)).toHaveAccessibleName('通知（未読8件）');
  await bell(page).click();
  await expect(page.getByRole('dialog', { name: '新着通知', exact: true }).getByRole('link').first()).toHaveAttribute('href', '/admin/companies');
});

test('通知APIの一時障害は通常画面を止めず、ベル内から再読み込みできる', async ({ page }) => {
  const state = await setup(page);
  let failed = true;
  await page.route('**/api/admin/notifications', route => failed ? route.fulfill({ status: 503, json: { error: { message: 'Temporarily unavailable' } } }) : route.fallback());
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
  await bell(page).click();
  await expect(page.getByRole('dialog', { name: '新着通知', exact: true }).getByRole('alert')).toContainText('通知を読み込めませんでした');
  failed = false;
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await expect(bell(page)).toHaveAccessibleName('通知（未読8件）');
  expect(state.reads).toEqual([]); expect(state.readAll).toBe(0);
});
