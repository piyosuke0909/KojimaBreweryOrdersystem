import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.beforeAll(() => mkdir('.local/screenshots', { recursive: true }).then(() => {}));
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('スマートフォンで商品を選び、到着日を指定して発注・変更・取消できる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/order');
  await page.getByRole('button', { name: 'テスト用取引先としてログイン' }).click();
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
  const firstProduct = page.locator('.ko-order-product').first();
  await firstProduct.getByRole('button', { name: /を増やす$/ }).click({ clickCount: 2 });
  await expect(page.locator('.ko-cart-bar')).toContainText('2本');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/screenshots/customer-order-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'カートを見る' }).click();
  await expect(page.getByRole('dialog', { name: 'カート', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('参考税額');
  await page.getByRole('button', { name: 'お届け可能日から選択してください' }).click();
  await expect(page.getByRole('dialog', { name: '到着希望日を選択' })).toBeVisible();
  await page.locator('.ko-date-options button').first().click();
  await page.getByRole('button', { name: '注文内容を確認する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文内容の確認', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '注文を確定する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文を受け付けました', exact: true })).toBeVisible();
  const orderId = (await page.locator('.ko-receipt strong').first().textContent())!.trim();
  expect(orderId).toMatch(/^O\d{8}[A-Z0-9]+$/);
  await page.getByRole('link', { name: '注文内容を確認する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文の詳細', exact: true })).toBeVisible();
  await expect(page.getByText('犬山忍冬酒：侍の酒', { exact: true })).toBeVisible();
  await expect(page.getByText(/犬山市/)).toBeVisible();
  await page.getByRole('button', { name: '注文内容を編集', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文の変更', exact: true })).toBeVisible();
  await page.locator('.ko-order-product').first().getByRole('button', { name: /を増やす$/ }).click();
  await page.getByRole('button', { name: 'カートを見る' }).click();
  await page.getByRole('button', { name: '変更内容を確認する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '変更内容の確認', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '変更を確定する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '変更を受け付けました', exact: true })).toBeVisible();
  const response = await page.request.get(`/api/customer/orders/${orderId}`);
  expect(response.ok()).toBe(true);
  const { data: order } = await response.json();
  expect(order.version).toBe(2);
  expect(order.items[0].quantity).toBe(3);
  expect(order.revisions).toHaveLength(1);
  await page.getByRole('link', { name: '注文内容を確認する', exact: true }).click();
  await page.getByRole('button', { name: '注文をキャンセル', exact: true }).click();
  await page.getByLabel(/キャンセル理由/).fill('ブラウザー自動検証');
  await page.getByRole('button', { name: 'キャンセルを確定する', exact: true }).click();
  await expect(page.getByText('この注文はキャンセル済みです。')).toBeVisible();
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '注文履歴', exact: true }).click();
  await expect(page.getByRole('heading', { name: '注文履歴', exact: true })).toBeVisible();
  await expect(page.getByRole('link').filter({ hasText: orderId })).toBeVisible();
  expect(errors).toEqual([]);
});

test('LINE未連携でも商品紹介と問い合わせ先を参照できる', async ({ page }) => {
  await page.goto('/products');
  await expect(page.getByRole('heading', { name: '商品紹介', exact: true })).toBeVisible();
  await page.locator('.ko-public-product').first().click();
  for (const name of ['商品説明', 'こだわり', '味わい', 'おすすめの飲み方']) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: 'お問い合わせ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'お問い合わせ', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '電話をかける' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('招待を再読込すると同じ取引先は注文画面へ進み、他社への変更は拒否される', async ({ page, request }) => {
  expect((await request.post('/api/auth/demo/admin', { data: {} })).ok()).toBe(true);
  const ownResponse = await request.post('/api/admin/companies/company-a/invitations', { data: { max_uses: 1 } });
  const otherResponse = await request.post('/api/admin/companies/company-b/invitations', { data: { max_uses: 1 } });
  expect(ownResponse.ok()).toBe(true);
  expect(otherResponse.ok()).toBe(true);
  const own = (await ownResponse.json()).data;
  const other = (await otherResponse.json()).data;
  expect((await page.request.post('/api/auth/demo/customer', { data: { company_id: 'company-a' } })).ok()).toBe(true);
  await page.goto(`/invite?t=${other.token}`);
  await expect(page.getByRole('heading', { name: '別のお取引先で登録されています', exact: true })).toBeVisible();
  await page.goto(`/invite?t=${own.token}`);
  await expect(page).toHaveURL(/\/order$/);
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
});
