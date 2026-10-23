import { expect, test, type Page, type Locator } from '@playwright/test';

const companyId = 'confirmation-company';
const confirmationText = '入力内容を確認しました。下の「確認して保存」を押すと反映されます。';
async function setup(page: Page, reject = false) {
  const state = { company: { id: companyId, name: '確認用商店', contact_name: '確認担当', phone: '0000000000', postal_code: '4840000', address: '愛知県犬山市 確認用住所', status: 'active', note: '確認前の備考' }, writes: [] as Record<string, unknown>[], reject };
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (data: unknown, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: { message: '保存できませんでした。入力内容を確認してください。' } } });
    if (path === '/api/auth/me') return send({ actor: { type: 'admin', id: 'confirmation-owner', role: 'owner', name: '確認管理者' } });
    if (path === '/api/config') return send({ environment: 'development', demo_enabled: false });
    if (path === '/api/admin/notifications') return send({ items: [], total_unread: 0, counts: { orders: 0, companies: 0 } });
    if (path === '/api/admin/notifications/companies') return send({ items: [] });
    if (path === '/api/admin/companies') return send([state.company]);
    if (path === `/api/admin/companies/${companyId}` && request.method() === 'PUT') {
      const input = request.postDataJSON(); state.writes.push(input);
      if (state.reject) return send({}, 503);
      state.company = { ...state.company, ...input }; return send(state.company);
    }
    return send({});
  });
  await page.goto('/admin/companies');
  await page.getByRole('button', { name: '確認用商店を編集', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '取引先情報を編集', exact: true })).toBeVisible();
  return state;
}
const form = (page: Page) => page.getByRole('dialog', { name: '取引先情報を編集', exact: true });
const nameField = (page: Page) => form(page).getByPlaceholder('例：株式会社 小島酒店', { exact: true });
const confirmation = (page: Page) => form(page).getByRole('status').filter({ hasText: confirmationText });
async function expectConfirmationInView(dialog: Locator, message: Locator) {
  await expect(message).toBeFocused();
  await expect.poll(() => message.evaluate(element => {
    const modal = element.closest('.admin-modal')!;
    const head = modal.querySelector('.admin-modal-head')!.getBoundingClientRect();
    const foot = modal.querySelector('.admin-modal-foot')!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return bounds.top >= head.bottom - 1 && bounds.bottom <= foot.top + 1;
  })).toBe(true);
  await expect.poll(() => dialog.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
}

test('スマートフォンで確認メッセージまでスクロールし、2段階目の操作だけで保存する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await setup(page);
  await nameField(page).fill('変更後の確認用商店');
  await form(page).evaluate(element => { element.scrollTop = 0; });
  await form(page).getByRole('button', { name: '入力内容を確認', exact: true }).click();
  await expectConfirmationInView(form(page), confirmation(page));
  await expect(form(page).getByRole('button', { name: '確認して保存', exact: true })).toBeInViewport();
  await expect(nameField(page)).toHaveValue('変更後の確認用商店');
  expect(state.writes).toHaveLength(0);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await form(page).getByRole('button', { name: '確認して保存', exact: true }).click();
  await expect(form(page)).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ name: '変更後の確認用商店' });
});

test('確認後に入力し直してもフォーカスを奪わず、再確認したときに再び案内へ移動する', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 620 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const state = await setup(page);
  await form(page).getByRole('button', { name: '入力内容を確認', exact: true }).click();
  await expectConfirmationInView(form(page), confirmation(page));
  await nameField(page).fill('再確認する商店');
  await expect(confirmation(page)).toHaveCount(0);
  await nameField(page).press('End'); await nameField(page).pressSequentially('追記');
  await expect(nameField(page)).toBeFocused();
  await expect(nameField(page)).toHaveValue('再確認する商店追記');
  await form(page).getByRole('button', { name: '入力内容を確認', exact: true }).click();
  await expectConfirmationInView(form(page), confirmation(page));
  expect(state.writes).toHaveLength(0);
  await form(page).getByRole('button', { name: '戻る', exact: true }).click();
  await expect(form(page)).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('必須入力と保存エラーの後も内容を保持し、案内の再確認だけでは保存しない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await setup(page, true);
  await nameField(page).fill('');
  await form(page).getByRole('button', { name: '入力内容を確認', exact: true }).click();
  await expect(confirmation(page)).toHaveCount(0); expect(state.writes).toHaveLength(0);
  await nameField(page).fill('エラー後も保持する商店');
  await form(page).getByRole('button', { name: '入力内容を確認', exact: true }).click();
  await expectConfirmationInView(form(page), confirmation(page));
  await form(page).getByRole('button', { name: '確認して保存', exact: true }).click();
  await expect(form(page).getByRole('alert')).toContainText('保存できませんでした');
  await expect(nameField(page)).toHaveValue('エラー後も保持する商店');
  await expect(confirmation(page)).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  await form(page).getByRole('button', { name: '入力内容を確認', exact: true }).click();
  await expectConfirmationInView(form(page), confirmation(page));
  expect(state.writes).toHaveLength(1);
});
