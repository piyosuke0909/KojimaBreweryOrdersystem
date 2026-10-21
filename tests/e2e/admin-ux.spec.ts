import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.beforeAll(() => mkdir('.local/screenshots', { recursive: true }).then(() => {}));
test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/auth/demo/admin', { data: {} })).ok()).toBe(true);
});

async function expectNoPageOverflow(page: Page) {
  // Responsive sidebar transitions may still be in flight after a viewport change.
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
}

test('注文の行背景と取引先のキーボード操作で詳細へ移動でき、内側の削除操作は遷移しない', async ({ page }) => {
  await page.goto('/admin/orders');
  const orderRow = page.locator('tbody tr[data-row-navigation]').first();
  await expect(orderRow).toBeVisible();
  const orderPath = await orderRow.locator('a[href^="/admin/orders/"]').first().getAttribute('href');
  expect(orderPath).toBeTruthy();
  await orderRow.locator('td').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`${orderPath}$`));

  await page.goto('/admin/companies');
  const companyRow = page.locator('tbody tr[data-row-navigation]').first();
  await expect(companyRow).toBeVisible();
  const companyPath = await companyRow.locator('a[href^="/admin/companies/"]').first().getAttribute('href');
  await companyRow.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${companyPath}$`));
  await page.goto('/admin/companies');
  const deleteRow = page.locator('tbody tr[data-row-navigation]').first();
  await deleteRow.getByRole('button', { name: /削除/ }).click();
  await expect(page.getByRole('dialog', { name: '取引先を削除しますか？', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/companies$/);
  await page.getByRole('dialog').getByRole('button', { name: '戻る', exact: true }).click();
});

test('配送先カードの背景から編集でき、入力例とヘルプを表示してもフォームを閉じない', async ({ page }) => {
  await page.goto('/admin/companies/company-a');
  await page.getByRole('button', { name: '配送先', exact: true }).click();
  const address = page.locator('.admin-address-card').first();
  await expect(address).toBeVisible();
  await address.locator('p').first().click();
  const form = page.getByRole('dialog', { name: '配送先を登録・編集', exact: true });
  await expect(form).toBeVisible();
  const name = form.getByPlaceholder('例：本店・名古屋支店・物流倉庫', { exact: true });
  await expect(name).toHaveAttribute('placeholder', /例：/);
  const help = form.getByRole('button', { name: '配送先名の説明', exact: true });
  await help.click();
  const explanation = page.getByRole('note', { name: '配送先名の説明', exact: true });
  await expect(explanation).toContainText('注文画面');
  await page.getByRole('button', { name: '説明を閉じる', exact: true }).click();
  await expect(explanation).toHaveCount(0);
  await expect(form).toBeVisible();
  await help.click();
  await expect(explanation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(explanation).toHaveCount(0);
  await expect(form).toBeVisible();
});

test('発行済み招待QRを画面から削除でき、LINE利用者の登録数は維持される', async ({ page }) => {
  const before = (await (await page.request.get('/api/admin/companies/company-a')).json()).data;
  const issued = await page.request.post('/api/admin/companies/company-a/invitations', { data: { max_uses: 997, note: 'UI回帰テスト専用QR' } });
  expect(issued.ok()).toBe(true);
  const invitation = (await issued.json()).data;
  try {
    await page.goto('/admin/companies/company-a');
    await page.getByRole('button', { name: 'LINE利用者・招待QR', exact: true }).click();
    const invitationRow = page.locator('tbody tr').filter({ hasText: '0 / 997 名' });
    await expect(invitationRow).toHaveCount(1);
    await invitationRow.getByRole('button', { name: /招待QRを削除/ }).click();
    const confirm = page.getByRole('dialog', { name: '招待QRコードを削除しますか？', exact: true });
    await expect(confirm).toContainText('登録済みのLINE利用者');
    await confirm.getByRole('button', { name: '確認して実行', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(invitationRow).toHaveCount(0);
    const after = (await (await page.request.get('/api/admin/companies/company-a')).json()).data;
    expect(after.line_users.map((user: any) => ({ id: user.id, status: user.status }))).toEqual(before.line_users.map((user: any) => ({ id: user.id, status: user.status })));
    expect(after.invitations.some((entry: any) => entry.id === invitation.id)).toBe(false);
    expect((await page.request.get(`/api/public/invitations/lookup?t=${encodeURIComponent(invitation.token)}`)).status()).toBe(410);
  } finally {
    await page.request.delete(`/api/admin/companies/company-a/invitations/${invitation.id}`);
  }
});

test('商品を管理画面で追加・行から編集・削除できる', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  const name = `UI回帰テスト商品 ${Date.now()}`;
  let id: string | undefined;
  try {
    await page.goto('/admin/products');
    await page.getByRole('button', { name: '商品を追加', exact: true }).click();
    const added = page.getByRole('dialog', { name: '商品を追加', exact: true });
    await expect(added.locator('#master-name')).toHaveAttribute('placeholder', /例：/);
    await added.locator('#master-name').fill(name);
    await added.locator('#master-volume_ml').fill('300');
    await added.locator('#master-weight_kg').fill('0.6');
    const created = page.waitForResponse(response => response.url().endsWith('/api/admin/products') && response.request().method() === 'POST');
    await added.getByRole('button', { name: '保存する', exact: true }).click();
    const creation = await created;
    expect(creation.ok()).toBe(true);
    id = (await creation.json()).data.id;
    const row = page.locator('tbody tr').filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await row.locator('td').nth(1).click();
    const edited = page.getByRole('dialog', { name: '商品を編集', exact: true });
    await edited.locator('#master-short_description').fill('管理者画面から編集した商品説明');
    await edited.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(edited).toHaveCount(0);
    const stored = (await (await page.request.get(`/api/admin/products/${id}`)).json()).data;
    expect(stored.short_description).toBe('管理者画面から編集した商品説明');
    await row.locator('td').nth(1).click();
    await page.getByRole('dialog', { name: '商品を編集', exact: true }).getByRole('button', { name: '削除する', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row).toHaveCount(0);
    expect((await page.request.get(`/api/admin/products/${id}`)).status()).toBe(404);
  } finally {
    if (id) await page.request.delete(`/api/admin/products/${id}`);
  }
});

test('管理者が注文フォームで見積を確認し、通知先未選択のテスト注文を登録できる', async ({ page }) => {
  let id: string | undefined;
  try {
    const datesResponse = await page.request.get('/api/admin/companies/company-a/delivery-dates?shipping_address_id=address-a');
    expect(datesResponse.ok()).toBe(true);
    const dates = (await datesResponse.json()).data;
    expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await page.goto('/admin/orders');
    await page.getByRole('button', { name: '注文を登録', exact: true }).click();
    const form = page.getByRole('dialog', { name: '注文を登録', exact: true });
    await form.getByRole('combobox', { name: '注文する取引先', exact: true }).selectOption('company-a');
    await expect(form.getByRole('heading', { name: '商品と数量', exact: true })).toBeVisible();
    await form.locator('select').nth(1).selectOption('address-a');
    await form.locator('input[type="date"]').fill(dates[0]);
    await form.getByRole('spinbutton', { name: '犬山忍冬酒：侍の酒 300mlの注文数量', exact: true }).fill('2');
    await form.getByRole('checkbox', { name: '動作確認用のテスト注文にする', exact: true }).check();
    await form.getByPlaceholder('例：午前中のお届け希望。納品先の受付へお渡しください。', { exact: true }).fill('UI回帰テストの管理者登録注文');
    await form.getByRole('button', { name: '送料・合計を確認', exact: true }).click();
    await expect(form.getByRole('heading', { name: '登録内容の確認', exact: true })).toBeVisible();
    await form.getByRole('button', { name: '注文を登録する', exact: true }).click();
    await expect(form).toContainText('LINE通知は送信しません。');
    const creation = page.waitForResponse(response => response.url().endsWith('/api/admin/orders') && response.request().method() === 'POST');
    await form.getByRole('button', { name: '確認して注文を登録', exact: true }).click();
    const created = await creation;
    expect(created.ok()).toBe(true);
    const order = (await created.json()).data;
    id = order.id;
    expect(id).toMatch(/^TEST-O/);
    expect(order.company_id).toBe('company-a');
    expect(order.shipping_address_id).toBe('address-a');
    expect(order.items).toMatchObject([{ product_id: 'samurai-300', quantity: 2 }]);
    expect(order.ordered_by_line_user_id).toBeNull();
    await expect(page).toHaveURL(new RegExp(`/admin/orders/${id}$`));
    await expect(page.getByRole('heading', { name: '注文明細', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '納品書プレビュー', exact: true })).toBeVisible();
  } finally {
    if (id) {
      const order = (await (await page.request.get(`/api/admin/orders/${id}`)).json()).data;
      if (order?.status !== 'cancelled') await page.request.post(`/api/admin/orders/${id}/cancel`, { data: { version: order.version, reason: 'UI回帰テストの後片付け' } });
    }
  }
});

for (const width of [390, 768, 1024]) {
  test(`${width}pxで商品フォームとヘルプが画面と枠の中に収まる`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/admin/products');
    await page.getByRole('button', { name: '商品を追加', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '商品を追加', exact: true });
    await expect(dialog).toBeVisible();
    await expectNoPageOverflow(page);
    const overflow = await dialog.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll('input,textarea,select')).map(node => ({ name: node.getAttribute('name'), rect: node.getBoundingClientRect() })).filter(({ rect }) => rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)).map(({ name }) => name);
    });
    expect(overflow).toEqual([]);
    await dialog.getByRole('button', { name: '商品名の説明', exact: true }).click();
    const help = page.getByRole('note', { name: '商品名の説明', exact: true });
    await expect(help).toBeVisible();
    const helpBounds = await help.boundingBox();
    expect(helpBounds).not.toBeNull();
    expect(helpBounds!.x).toBeGreaterThanOrEqual(0);
    expect(helpBounds!.x + helpBounds!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `.local/screenshots/admin-ux-product-${width}.png`, fullPage: true });
  });
}

async function selectAdminCalendarDate(page: Page, date: string) {
  await expect(page.locator('.master-calendar')).toBeVisible();
  const day = page.locator(`.master-calendar-day[aria-label^="${date} "]`);
  for (let offset = 0; offset < 4 && await day.count() === 0; offset++) {
    const next = page.waitForResponse(response => response.url().includes('/api/admin/calendar?') && response.request().method() === 'GET');
    await page.getByRole('button', { name: '翌月', exact: true }).click();
    expect((await next).ok()).toBe(true);
    await expect(page.locator('.master-calendar')).toBeVisible();
  }
  await day.click();
}

test('休業日だけを登録・解除でき、カレンダーの日付を注文フォームへ引き継いで見積できる', async ({ page }) => {
  const dates = (await (await page.request.get('/api/admin/companies/company-a/delivery-dates?shipping_address_id=address-a')).json()).data;
  const deliveryDate: string = dates[0];
  expect(deliveryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const calendarUrl = `/api/admin/calendar?from=${deliveryDate}&to=${deliveryDate}`;
  const original = (await (await page.request.get(calendarUrl)).json()).data.find((entry: any) => entry.date === deliveryDate);
  try {
    await page.goto('/admin/shipping');
    await expect(page.getByText('通常は休みなしです。休む日だけ選んで登録してください。', { exact: true })).toBeVisible();
    await selectAdminCalendarDate(page, deliveryDate);
    const editor = page.locator('.master-day-editor');
    await editor.getByPlaceholder('例：設備点検のため休業', { exact: true }).fill('UI回帰テストの休業日');
    await editor.getByRole('button', { name: '休業日にする', exact: true }).click();
    await expect(page.locator(`.master-calendar-day[aria-label="${deliveryDate} 休業日"]`)).toBeVisible();
    await expect(editor.getByRole('button', { name: 'この日で注文を登録', exact: true })).toHaveCount(0);
    const closedDates = (await (await page.request.get('/api/admin/companies/company-a/delivery-dates?shipping_address_id=address-a')).json()).data;
    expect(closedDates).not.toContain(deliveryDate);
    await editor.getByRole('button', { name: '休業日を解除', exact: true }).click();
    await expect(page.locator(`.master-calendar-day[aria-label="${deliveryDate} 通常営業"]`)).toBeVisible();
    await editor.getByRole('button', { name: 'この日で注文を登録', exact: true }).click();
    const form = page.getByRole('dialog', { name: '注文を登録', exact: true });
    await expect(form).toBeVisible();
    await form.getByRole('combobox', { name: '注文する取引先', exact: true }).selectOption('company-a');
    await expect(form.locator('input[type="date"]')).toHaveValue(deliveryDate);
    await form.getByRole('spinbutton', { name: '犬山忍冬酒：侍の酒 300mlの注文数量', exact: true }).fill('1');
    await form.getByRole('button', { name: '送料・合計を確認', exact: true }).click();
    await expect(form.getByRole('heading', { name: '登録内容の確認', exact: true })).toBeVisible();
    await form.getByRole('button', { name: '戻る', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/orders$/);
  } finally {
    await page.request.delete(`/api/admin/calendar/${deliveryDate}`);
    if (original) expect((await page.request.post('/api/admin/calendar', { data: { date: original.date, is_deliverable: original.is_deliverable, reason: original.reason, note: original.note } })).ok()).toBe(true);
  }
});

test('梱包をオフにすると関連タブと自動計算が停止し、固定送料と注文ごとの送料を使える', async ({ page }) => {
  const original = (await (await page.request.get('/api/admin/settings')).json()).data;
  page.on('dialog', dialog => dialog.accept());
  try {
    expect((await page.request.put('/api/admin/settings', { data: { packing_enabled: 'false', yamato_sizes_enabled: 'true', yamato_rates_enabled: 'true', manual_shipping_fee: '' } })).ok()).toBe(true);
    await page.goto('/admin/settings');
    await page.getByRole('tab', { name: '配送・梱包機能', exact: true }).click();
    await expect(page.locator('#master-packing_enabled')).not.toBeChecked();
    await expect(page.locator('#master-yamato_sizes_enabled')).toBeDisabled();
    await expect(page.locator('#master-yamato_rates_enabled')).toBeDisabled();
    await page.locator('#master-manual_shipping_fee').fill('770');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/settings') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '設定を保存', exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByRole('status')).toContainText('設定を保存しました');
    await page.getByRole('tab', { name: '税・注文・通知', exact: true }).click();
    await expect(page.locator('#master-tax_rate')).toBeVisible();
    const taxSaved = page.waitForResponse(response => response.url().endsWith('/api/admin/settings') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '設定を保存', exact: true }).click();
    expect((await taxSaved).ok()).toBe(true);
    await expect(page.getByRole('status')).toContainText('設定を保存しました');
    const afterTaxSave = (await (await page.request.get('/api/admin/settings')).json()).data;
    expect(afterTaxSave.manual_shipping_fee).toBe('770');
    await expect(page.locator('#master-multi_parcel_discount_enabled')).toHaveCount(0);
    await expect(page.locator('#master-multi_parcel_discount_amount')).toHaveCount(0);
    await page.goto('/admin/shipping');
    for (const name of ['梱包箱', 'ヤマトサイズ', 'ヤマト運賃']) await expect(page.getByRole('tab', { name, exact: true })).toHaveCount(0);
    const dates = (await (await page.request.get('/api/admin/companies/company-b/delivery-dates?shipping_address_id=address-b')).json()).data;
    expect(dates.length).toBeGreaterThan(0);
    await page.goto(`/admin/orders?create=1&desired_delivery_date=${dates[0]}`);
    const form = page.getByRole('dialog', { name: '注文を登録', exact: true });
    await form.getByRole('combobox', { name: '注文する取引先', exact: true }).selectOption('company-b');
    await form.getByRole('spinbutton', { name: '犬山忍冬酒：侍の酒 300mlの注文数量', exact: true }).fill('1');
    const fixedQuote = page.waitForResponse(response => response.url().endsWith('/api/admin/orders/quote'));
    await form.getByRole('button', { name: '送料・合計を確認', exact: true }).click();
    const fixed = (await (await fixedQuote).json()).data;
    expect(fixed.shipping_fee).toBe(770);
    expect(fixed.shipping_fee_source).toBe('fixed');
    expect(fixed.packages).toEqual([]);
    await expect(form.locator('.admin-create-quote')).not.toContainText('0個口');
    await form.getByRole('spinbutton', { name: 'この注文の送料（税抜・円）', exact: true }).fill('880');
    const manualQuote = page.waitForResponse(response => response.url().endsWith('/api/admin/orders/quote'));
    await form.getByRole('button', { name: '送料・合計を確認', exact: true }).click();
    const manual = (await (await manualQuote).json()).data;
    expect(manual.shipping_fee).toBe(880);
    expect(manual.shipping_fee_source).toBe('manual');
    await page.goto('/admin/settings');
    await page.getByRole('tab', { name: '配送・梱包機能', exact: true }).click();
    await page.locator('#master-packing_enabled').check();
    await expect(page.locator('#master-yamato_sizes_enabled')).toBeEnabled();
    await expect(page.locator('#master-yamato_rates_enabled')).toBeEnabled();
    await page.getByRole('button', { name: '設定を保存', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('設定を保存しました');
    await page.locator('#master-packing_enabled').uncheck();
    await expect(page.locator('#master-manual_shipping_fee')).toHaveValue('770');
    await page.locator('#master-packing_enabled').check();
    await page.goto('/admin/shipping');
    for (const name of ['梱包箱', 'ヤマトサイズ', 'ヤマト運賃']) await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  } finally {
    expect((await page.request.put('/api/admin/settings', { data: original })).ok()).toBe(true);
  }
});

for (const width of [390, 768, 1366]) {
  test(`${width}pxで配送メニューと各表に横スクロールが発生しない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/admin/shipping');
    await expect(page.getByRole('tab', { name: 'ヤマト運賃', exact: true })).toBeVisible();
    for (const name of ['配送カレンダー', '梱包箱', 'ヤマトサイズ', 'ヤマト運賃', '配送ルール']) {
      await page.getByRole('tab', { name, exact: true }).click();
      if (name === '配送カレンダー') await expect(page.locator('.master-calendar')).toBeVisible();
      else await expect(page.locator('.master-shipping-table tbody tr').first()).toBeVisible();
      await expectNoPageOverflow(page);
      const overflowing = await page.locator('.master-page-shipping .master-tabs, .master-page-shipping .admin-table-wrap').evaluateAll(elements => elements.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className));
      expect(overflowing).toEqual([]);
    }
    await page.screenshot({ path: `.local/screenshots/admin-ux-shipping-${width}.png`, fullPage: true });
  });
}
