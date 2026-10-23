import { expect, test, type Page, type Route } from '@playwright/test';

const password = 'reset-browser-current-password';
const token = 'reset-browser-one-use-token';
const summary = () => ({ generation: 0, data_revision: 12,
  counts: { companies: 2, orders: 5, invoices: 1, delivery_note_histories: 2, line_users: 3, line_messages: 4, invitations: 2, products: 14, other_admins: 1 },
  active_tasks: 0, defaults: { product_count: 11, products_unavailable: true }, preserved: ['current_owner_login', 'line_cloudflare_connection'], can_reset: true,
});
async function setup(page: Page, { owner = true, active = false }: { owner?: boolean; active?: boolean } = {}) {
  const state = { overview: summary(), prepares: [] as any[], executions: [] as any[], gets: 0, prepareError: false, executeError: false, reset: false };
  if (active) { state.overview.active_tasks = 1; state.overview.can_reset = false; }
  const send = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: data } });
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/auth/me') return send(route, { actor: { id: 'reset-owner', role: owner ? 'owner' : 'staff', type: 'admin', name: '確認管理者' } });
    if (path === '/api/config') return send(route, { environment: 'development', demo_enabled: false });
    if (path === '/api/admin/notifications') return send(route, { items: [], total_unread: 0, counts: { companies: 0, orders: 0 } });
    if (path === '/api/admin/settings') return send(route, {});
    if (path === '/api/admin/reset') { state.gets++; return send(route, state.overview); }
    if (path === '/api/admin/reset/prepare') {
      state.prepares.push(request.postDataJSON());
      if (state.prepareError) return send(route, { code: 'CURRENT_PASSWORD_INCORRECT', message: '現在のパスワードが違います。' }, 400);
      return send(route, { token, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), overview: state.overview });
    }
    if (path === '/api/admin/reset/execute') {
      state.executions.push(request.postDataJSON());
      if (state.executeError) return send(route, { code: 'RESET_PREVIEW_CHANGED', message: '確認後にデータが変更されました。リセット対象を確認し直してください。' }, 409);
      state.reset = true; state.overview = { ...summary(), generation: 1, counts: { companies: 0, orders: 0, invoices: 0, delivery_note_histories: 0, line_users: 0, line_messages: 0, invitations: 0, products: 11, other_admins: 0 } };
      return send(route, { reset: true, counts: state.overview.counts, generation: 1 });
    }
    return send(route, {});
  });
  await page.goto('/admin/settings?tab=reset');
  await expect(page.getByRole('tab', { name: '初期リセット', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: '初期リセット', exact: true })).toBeVisible();
  if (owner) await expect(page.getByRole('heading', { name: '登録されているデータ', exact: true })).toBeVisible();
  return state;
}
const current = (page: Page) => page.getByLabel('現在のパスワード', { exact: true });
const prepare = (page: Page) => page.getByRole('button', { name: 'リセット対象を確認', exact: true });
const confirmation = (page: Page) => page.getByLabel('確認の文字入力', { exact: true });
const execute = (page: Page) => page.getByRole('button', { name: '確認して初期リセット', exact: true });
async function review(page: Page) {
  await current(page).fill(password); await prepare(page).click();
  await expect(page.getByRole('heading', { name: 'リセット対象の最終確認', exact: true })).toBeVisible();
}

test('初期表示は削除範囲と残す接続を説明し、パスワードも実行リクエストも空にする', async ({ page }) => {
  const state = await setup(page);
  await expect(current(page)).toHaveValue(''); await expect(current(page)).toHaveAttribute('type', 'password'); await expect(prepare(page)).toBeDisabled();
  await expect(page.getByText('削除したデータは元に戻せません。', { exact: true })).toBeVisible();
  await expect(page.getByText('操作中の管理者のユーザー名・パスワードと、LINE・Cloudflareの接続設定は維持します。', { exact: false })).toBeVisible();
  await expect(page.getByText('LINE公式アカウントの友だち・LINEアプリ内のトーク・送信済みメールは削除されません。', { exact: false })).toBeVisible();
  expect(state.prepares).toHaveLength(0); expect(state.executions).toHaveLength(0);
});

test('パスワード確認だけでは削除せず、正しい確認文字と実行操作の後だけ一度リセットする', async ({ page }) => {
  const state = await setup(page); await review(page);
  expect(state.prepares).toEqual([{ current_password: password }]); expect(state.executions).toHaveLength(0);
  await expect(current(page)).toHaveCount(0); await expect(execute(page)).toBeDisabled();
  await confirmation(page).fill('初期リセットする'); await expect(execute(page)).toBeDisabled();
  await confirmation(page).fill('初期リセット'); await execute(page).click();
  await expect.poll(() => state.reset).toBe(true);
  await expect.poll(() => state.gets).toBeGreaterThan(1);
  await expect(current(page)).toHaveValue('');
  await expect(page.getByRole('status')).toContainText('初期リセットが完了しました');
  expect(await page.evaluate(() => sessionStorage.getItem('kojima_reset_completed'))).toBeNull();
  expect(state.executions).toEqual([{ token, confirmation: '初期リセット' }]);
});

test('確認を取り消すと秘密の入力を消し、再操作してもパスワード確認から始める', async ({ page }) => {
  const state = await setup(page); await review(page); await confirmation(page).fill('初期リセット');
  await page.getByRole('button', { name: '取り消す', exact: true }).click();
  await expect(current(page)).toHaveValue(''); await expect(page.getByRole('status')).toContainText('データは変更していません');
  await expect(execute(page)).toHaveCount(0); expect(state.executions).toHaveLength(0);
  await expect(prepare(page)).toBeDisabled();
});

test('パスワードが違う場合は入力を消し、自動で再試行しない', async ({ page }) => {
  const state = await setup(page); state.prepareError = true;
  await current(page).fill('wrong-password'); await prepare(page).click();
  await expect(page.getByRole('alert')).toContainText('現在のパスワードが違います'); await expect(current(page)).toHaveValue('');
  await expect(execute(page)).toHaveCount(0); expect(state.prepares).toHaveLength(1); expect(state.executions).toHaveLength(0);
  state.prepareError = false; await review(page); expect(state.prepares).toHaveLength(2); expect(state.executions).toHaveLength(0);
});

test('確認後のデータ変更で実行が拒否されたらトークンを捨て、読み直しとパスワード確認を求める', async ({ page }) => {
  const state = await setup(page); state.executeError = true;
  await review(page); await confirmation(page).fill('初期リセット'); await execute(page).click();
  await expect(page.getByRole('alert')).toContainText('確認後にデータが変更されました');
  await expect(page.getByRole('alert')).toContainText('自動では再実行しません'); await expect(execute(page)).toHaveCount(0);
  expect(state.executions).toHaveLength(1);
  await page.getByRole('button', { name: 'リセット対象を読み直す', exact: true }).click(); await expect(current(page)).toHaveValue('');
  expect(state.executions).toHaveLength(1); await expect(prepare(page)).toBeDisabled();
});

test('有効時間が切れた確認は実行できず、パスワードから確認し直す', async ({ page }) => {
  await page.clock.install({ time: Date.now() }); const state = await setup(page); await review(page);
  await confirmation(page).fill('初期リセット'); await page.clock.fastForward(6 * 60_000);
  await expect(page.getByRole('status')).toContainText('確認の有効時間が切れました'); await expect(execute(page)).toHaveCount(0); await expect(current(page)).toHaveValue('');
  expect(state.executions).toHaveLength(0); expect(state.prepares).toHaveLength(1);
});

test('確認中もパスワードや一回限りのトークンをURL・永続ストレージ・画面に残さない', async ({ page }) => {
  const state = await setup(page); await review(page);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href, html: document.documentElement.outerHTML }));
  expect(storage).not.toContain(password); expect(storage).not.toContain(token); expect(state.executions).toHaveLength(0);
  await page.reload(); await expect(current(page)).toHaveValue(''); await expect(execute(page)).toHaveCount(0); expect(state.executions).toHaveLength(0);
});

test('スタッフには権限の説明だけを表示し、リセットAPIへ接続しない', async ({ page }) => {
  const state = await setup(page, { owner: false });
  await expect(page.getByText('初期リセットは、オーナー権限の管理者でログインして行ってください。', { exact: true })).toBeVisible();
  await expect(current(page)).toHaveCount(0); await expect(prepare(page)).toHaveCount(0); expect(state.gets).toBe(0); expect(state.prepares).toHaveLength(0); expect(state.executions).toHaveLength(0);
});

test('通知の送信中は確認を止め、処理完了後に明示的に読み直して再開する', async ({ page }) => {
  const state = await setup(page, { active: true });
  await expect(page.getByRole('status')).toContainText('通知などの処理が進行中'); await expect(current(page)).toBeDisabled(); await expect(prepare(page)).toBeDisabled();
  state.overview.active_tasks = 0; state.overview.can_reset = true;
  await page.getByRole('button', { name: 'リセット対象を読み直す', exact: true }).click(); await expect(current(page)).toBeEnabled();
  expect(state.prepares).toHaveLength(0); expect(state.executions).toHaveLength(0);
});

for (const width of [390, 768, 1366]) test(`${width}pxで削除範囲と確認フォームが画面内に収まる`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' }); const state = await setup(page); await review(page);
  await expect(page.getByRole('heading', { name: 'リセット対象の最終確認', exact: true })).toBeFocused();
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth); expect(overflow).toBeLessThanOrEqual(1);
  await confirmation(page).fill('初期リセット'); await expect(execute(page)).toBeEnabled(); expect(state.executions).toHaveLength(0);
});
