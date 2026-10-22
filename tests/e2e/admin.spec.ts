import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

test.beforeAll(() => mkdir('.local/screenshots', { recursive: true }).then(() => {}));

async function openFirstOrder(page: Page) {
  const row = page.locator('tbody tr[data-row-navigation]').first();
  await expect(row).toBeVisible();
  const href = await row.locator('a[href^="/admin/orders/"]').first().getAttribute('href');
  expect(href).toBeTruthy();
  await row.locator('td').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
}

test('管理者ログインからダッシュボードと業務画面を開ける', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '管理者ログイン' })).toBeVisible();
  await page.getByRole('button', { name: 'デモ環境を開く' }).click();
  await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true })).toBeVisible();
  for (const label of ['本日の新規注文', '受付済の注文', '本日の到着予定', '発送済の注文']) {
    await expect(page.locator('.admin-kpi').filter({ hasText: label })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: '最近の注文' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'クイックメニュー' })).toBeVisible();
  await page.screenshot({ path: '.local/screenshots/admin-dashboard.png', fullPage: true });
  const nav = page.getByRole('navigation', { name: '管理メニュー' });
  for (const label of ['注文管理', '取引先管理', '商品管理', '配送管理', '請求管理', '監査ログ', '設定']) {
    await nav.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  await nav.getByRole('link', { name: '注文管理', exact: true }).click();
  await openFirstOrder(page);
  await expect(page.getByText(/商品明細|注文明細/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('納品書をプレビューし、日本語PDFファイルをダウンロードできる', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'デモ環境を開く' }).click();
  await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('link', { name: '注文管理', exact: true }).click();
  await openFirstOrder(page);
  await page.getByRole('link', { name: '納品書プレビュー', exact: true }).click();
  await expect(page.getByRole('heading', { name: '納品書', exact: true })).toBeVisible();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDFダウンロード', exact: true }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toMatch(/^納品書_.*\.pdf$/);
  await download.saveAs('.local/screenshots/delivery-note.pdf');
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(5_000);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('認証を解除すると管理画面に戻れない', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'デモ環境を開く' }).click();
  await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理者ログイン' })).toBeVisible();
  await page.goto('/admin/orders');
  await expect(page.getByRole('heading', { name: '管理者ログイン' })).toBeVisible();
});

test('期限なしの招待QRを再表示・画像保存し、同じQRの上限変更と案内状PDF保存ができる', async ({ page }) => {
  expect((await page.request.post('/api/auth/demo/admin', { data: {} })).ok()).toBe(true);
  const before = (await (await page.request.get('/api/admin/companies/company-a')).json()).data;
  let invitationId: string | undefined;
  try {
    await page.goto('/admin/companies/company-a');
    await page.getByRole('button', { name: 'LINE利用者・招待QR', exact: true }).click();
    await page.getByRole('button', { name: '招待QRを発行', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'LINE招待QRコードを発行', exact: true });
    await expect(form.getByLabel('有効期限', { exact: true })).toHaveCount(0);
    await form.getByPlaceholder('例：5（空欄で無制限）', { exact: true }).fill('823');
    await form.getByRole('button', { name: '入力内容を確認', exact: true }).click();
    const createdReady = page.waitForResponse(response => response.url().endsWith('/api/admin/companies/company-a/invitations') && response.request().method() === 'POST');
    await form.getByRole('button', { name: '確認して保存', exact: true }).click();
    const invitation = (await (await createdReady).json()).data;
    invitationId = invitation.id;
    expect(invitation.expires_at).toBeNull();
    expect(invitation.qr_available).toBe(true);
    const issued = page.getByRole('dialog', { name: 'LINE招待QRコード', exact: true });
    await expect(issued.getByRole('img', { name: 'LINE注文サービス登録用QRコード' })).toBeVisible();
    const pngReady = page.waitForEvent('download');
    await issued.getByRole('button', { name: 'QR画像を保存', exact: true }).click();
    const png = await pngReady;
    expect(png.suggestedFilename()).toMatch(/_LINE招待QR_.*\.png$/);
    const pngBytes = await readFile((await png.path())!);
    expect([...pngBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngBytes.readUInt32BE(16)).toBe(1000);
    expect(pngBytes.readUInt32BE(20)).toBe(1000);
    await issued.getByRole('button', { name: '閉じる', exact: true }).click();

    await page.reload();
    await page.getByRole('button', { name: 'LINE利用者・招待QR', exact: true }).click();
    const savedRow = page.locator('.admin-invitation-table tbody tr').filter({ hasText: '0 / 823 名' });
    await savedRow.getByRole('button', { name: 'QRを表示・保存', exact: true }).click();
    await expect(issued.getByRole('img', { name: 'LINE注文サービス登録用QRコード' })).toBeVisible();
    expect((await issued.locator('.admin-qr-letter small').innerText()) === invitation.url).toBe(true);
    await issued.getByRole('button', { name: '閉じる', exact: true }).click();
    await savedRow.getByRole('button', { name: '登録上限を変更', exact: true }).click();
    const limit = page.getByRole('dialog', { name: '招待QRの登録上限を変更', exact: true });
    await limit.getByPlaceholder('例：5（空欄で無制限）', { exact: true }).fill('824');
    await limit.getByRole('button', { name: '入力内容を確認', exact: true }).click();
    await limit.getByRole('button', { name: '確認して保存', exact: true }).click();
    await expect(limit).toHaveCount(0);
    const updatedRow = page.locator('.admin-invitation-table tbody tr').filter({ hasText: '0 / 824 名' });
    await updatedRow.getByRole('button', { name: 'QRを表示・保存', exact: true }).click();
    await expect(issued.getByRole('img', { name: 'LINE注文サービス登録用QRコード' })).toBeVisible();
    expect((await issued.locator('.admin-qr-letter small').innerText()) === invitation.url).toBe(true);
    const after = (await (await page.request.get('/api/admin/companies/company-a')).json()).data;
    expect(after.invitations.length).toBe(before.invitations.length + 1);
    const updated = after.invitations.find((row: any) => row.id === invitationId);
    expect({ used_count: updated.used_count, max_uses: updated.max_uses, expires_at: updated.expires_at }).toEqual({ used_count: invitation.used_count, max_uses: 824, expires_at: null });
    expect(after.line_users.map((user: any) => ({ id: user.id, status: user.status }))).toEqual(before.line_users.map((user: any) => ({ id: user.id, status: user.status })));
    await issued.getByRole('link', { name: '案内状・PDF保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'LINE注文 ご登録のご案内', exact: true })).toBeVisible();
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: 'PDFダウンロード', exact: true }).click();
    const download = await downloadReady;
    expect(download.suggestedFilename()).toMatch(/^LINE注文 ご登録のご案内_.*\.pdf$/);
    await download.saveAs('.local/screenshots/invitation.pdf');
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(5_000);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    if (invitationId) await page.request.delete(`/api/admin/companies/company-a/invitations/${invitationId}`);
  }
});
