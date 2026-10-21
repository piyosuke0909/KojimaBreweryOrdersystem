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
  await expect(page.getByRole('grid')).toBeVisible();
  await page.locator('.ko-calendar-day:not(:disabled)').first().click();
  const selectedDate = await page.locator('.ko-date-select').innerText();
  const note = page.getByRole('textbox', { name: /ご要望・備考/ });
  await note.click();
  await note.pressSequentially('Please deliver in the afternoon.', { delay: 15 });
  await expect(note).toHaveValue('Please deliver in the afternoon.');
  await expect(note).toBeFocused();
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
  await expect(page.locator('.ko-date-select')).toHaveText(selectedDate);
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
  expect(order.note).toBe('Please deliver in the afternoon.');
  await page.getByRole('link', { name: '注文内容を確認する', exact: true }).click();
  await page.getByRole('button', { name: '注文をキャンセル', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '注文のキャンセル', exact: true }).getByRole('textbox')).toHaveCount(0);
  const cancelRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/api/customer/orders/${orderId}/cancel`));
  await page.getByRole('button', { name: 'キャンセルを確定する', exact: true }).click();
  expect((await cancelRequest).postDataJSON()).toEqual({ version: 2 });
  await expect(page.getByText('この注文はキャンセル済みです。')).toBeVisible();
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '注文履歴', exact: true }).click();
  await expect(page.getByRole('heading', { name: '注文履歴', exact: true })).toBeVisible();
  await expect(page.getByRole('link').filter({ hasText: orderId })).toBeVisible();
  expect(errors).toEqual([]);
});

test('月間カレンダーで配送可能日だけを選択し、月とキーボードで移動できる', async ({ page }) => {
  const dates = ['2099-03-28', '2099-03-30', '2099-04-01', '2099-04-04'];
  await page.route('**/api/customer/delivery-dates?*', route => route.fulfill({ json: { data: dates } }));
  // Use a fixed booking window to exercise the calendar independently of today's lead time.
  await page.route('**/api/customer/quote', async route => {
    const { desired_delivery_date: _date, ...input } = route.request().postDataJSON();
    const response = await route.fetch({ postData: JSON.stringify(input) });
    await route.fulfill({ response });
  });
  await page.goto('/order/calendar');
  await page.getByRole('button', { name: 'テスト用取引先としてログイン' }).click();
  const calendar = page.getByRole('dialog', { name: '到着希望日を選択' });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByRole('grid')).toBeVisible();
  await expect(calendar.locator('.ko-calendar-month')).toHaveText('2099年3月');
  await expect(calendar.getByRole('button', { name: '前の月', exact: true })).toBeDisabled();
  await expect(calendar.getByRole('button', { name: '2099年3月29日', exact: false })).toBeDisabled();
  const firstDate = calendar.getByRole('button', { name: '2099年3月28日', exact: false });
  await expect(firstDate).toBeEnabled();
  await firstDate.focus();
  await firstDate.press('ArrowRight');
  const nextDate = calendar.getByRole('button', { name: '2099年3月30日', exact: false });
  await expect(nextDate).toBeFocused();
  await nextDate.press('ArrowRight');
  await expect(calendar.locator('.ko-calendar-month')).toHaveText('2099年4月');
  await expect(calendar.getByRole('button', { name: '2099年4月1日', exact: false })).toBeFocused();
  await expect(calendar.getByRole('button', { name: '次の月', exact: true })).toBeDisabled();
  await calendar.getByRole('button', { name: '前の月', exact: true }).click();
  await expect(calendar.locator('.ko-calendar-month')).toHaveText('2099年3月');
  await calendar.getByRole('button', { name: '次の月', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await calendar.getByRole('button', { name: '2099年4月4日', exact: false }).click();
  await expect(page.getByRole('dialog', { name: 'カート', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.locator('.ko-order-product').first().getByRole('button', { name: /を増やす$/ }).click();
  await page.getByRole('button', { name: 'カートを見る' }).click();
  await expect(page.locator('.ko-date-select')).toContainText('2099年4月4日');
  await page.locator('.ko-date-select').click();
  await expect(calendar.getByRole('button', { name: '2099年4月4日', exact: false })).toHaveAttribute('aria-pressed', 'true');
});

test('梱包機能がオフの見積では個口やサイズを注文者に表示しない', async ({ page }) => {
  await page.route('**/api/customer/quote', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.shipping_features = { packing_enabled: false, yamato_sizes_enabled: false, yamato_rates_enabled: false };
    body.data.shipping_fee_source = 'fixed';
    body.data.delivery_method = 'yamato';
    body.data.shipping_fee = 0;
    body.data.packages = [{ quantity: 2, size_code: 'HIDDEN-SIZE', box_name: 'HIDDEN-BOX' }];
    await route.fulfill({ response, json: body });
  });
  await page.goto('/order');
  await page.getByRole('button', { name: 'テスト用取引先としてログイン' }).click();
  await page.locator('.ko-order-product').first().getByRole('button', { name: /を増やす$/ }).click();
  await page.getByRole('button', { name: 'カートを見る' }).click();
  const cart = page.getByRole('dialog', { name: 'カート', exact: true });
  await expect(cart.locator('.ko-quote')).toBeVisible();
  await expect(cart.locator('.ko-packaging')).toHaveText('ヤマト運輸 宅急便・送料無料');
  await expect(cart).not.toContainText(/HIDDEN-SIZE|HIDDEN-BOX|個口/);
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
