import { expect, test } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

test.beforeAll(() => mkdir('.local/screenshots', { recursive: true }).then(() => {}));

test('管理者ログインからダッシュボードと業務画面を開ける', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '管理者ログイン' })).toBeVisible();
  await page.getByRole('button', { name: 'デモ環境を開く' }).click();
  await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true })).toBeVisible();
  for (const label of ['本日の新規注文', '確認待ち', '本日の到着予定', '配送準備中']) {
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
  await page.getByRole('link', { name: /^詳細/ }).first().click();
  await expect(page.getByText(/商品明細|注文明細/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('納品書をプレビューし、日本語PDFファイルをダウンロードできる', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'デモ環境を開く' }).click();
  await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('link', { name: '注文管理', exact: true }).click();
  await page.getByRole('link', { name: /^詳細/ }).first().click();
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

test('取引先の招待QRコードを発行し、案内状をPDF保存できる', async ({ page }) => {
  expect((await page.request.post('/api/auth/demo/admin', { data: {} })).ok()).toBe(true);
  await page.goto('/admin/companies/company-a');
  await page.getByRole('button', { name: 'LINE利用者・招待QR', exact: true }).click();
  await page.getByRole('button', { name: '招待QRを発行', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'LINE招待QRコードを発行', exact: true });
  await form.getByRole('button', { name: '入力内容を確認', exact: true }).click();
  await form.getByRole('button', { name: '確認して保存', exact: true }).click();
  const issued = page.getByRole('dialog', { name: '招待QRコードを発行しました', exact: true });
  await expect(issued.getByRole('img', { name: 'LINE注文サービス登録用QRコード' })).toBeVisible();
  await issued.getByRole('link', { name: '案内状プレビュー・PDF保存', exact: true }).click();
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
});
