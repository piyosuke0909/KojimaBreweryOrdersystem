import { expect, test } from '@playwright/test';

test('管理者が受付済と発送済を切り替え、発送後の編集・取消を止めてキャンセル済を終端にする', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await page.request.post('/api/auth/demo/admin', { data: {} })).ok()).toBe(true);
  const datesResponse = await page.request.get('/api/admin/companies/company-a/delivery-dates?shipping_address_id=address-a');
  expect(datesResponse.ok()).toBe(true);
  const dates = (await datesResponse.json()).data;
  const input = {
    request_id: crypto.randomUUID(), company_id: 'company-a', shipping_address_id: 'address-a',
    desired_delivery_date: dates[0], items: [{ product_id: 'samurai-300', quantity: 1 }],
    is_test_order: true, note: '注文ステータスの画面回帰確認',
  };
  const quoted = await page.request.post('/api/admin/orders/quote', { data: input });
  expect(quoted.ok()).toBe(true);
  const quote = (await quoted.json()).data;
  expect(quote.quote_token).toEqual(expect.any(String));
  const createdResponse = await page.request.post('/api/admin/orders', { data: { ...input, quote_token: quote.quote_token } });
  expect(createdResponse.ok()).toBe(true);
  const created = (await createdResponse.json()).data;
  const endpoint = `/api/admin/orders/${created.id}`;
  try {
    await page.goto(`/admin/orders/${created.id}`);
    const selector = page.getByRole('combobox', { name: '注文ステータス', exact: true });
    const permissions = page.getByRole('group', { name: '注文の編集可否', exact: true });
    const edit = page.getByRole('button', { name: '注文内容を編集', exact: true });
    const cancel = page.getByRole('button', { name: '注文をキャンセル', exact: true });
    const change = page.getByRole('button', { name: 'ステータスを変更', exact: true });
    await expect(selector).toHaveValue('received');
    await expect(selector.locator('option')).toHaveText(['受付済', '発送済', 'キャンセル済']);
    await expect(edit).toBeEnabled();
    await expect(cancel).toBeEnabled();
    await expect(permissions).toContainText('注文編集可');
    await expect(permissions).toContainText('キャンセル可');

    await selector.selectOption('shipped');
    await change.click();
    const confirmation = page.getByRole('dialog', { name: 'ステータスを変更しますか？', exact: true });
    await expect(confirmation).toContainText('発送済みの注文は編集・キャンセルができなくなります。');
    await confirmation.getByRole('button', { name: '確認して実行', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(selector).toHaveValue('shipped');
    await expect(edit).toBeDisabled();
    await expect(cancel).toBeDisabled();
    await expect(selector.locator('option[value="cancelled"]')).toHaveJSProperty('disabled', true);
    await expect(permissions).toContainText('注文編集不可');
    await expect(permissions).toContainText('キャンセル不可');
    expect(Math.max(...await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth]))).toBeLessThanOrEqual(391);

    await selector.selectOption('received');
    await change.click();
    await expect(confirmation).toContainText('発送済みから受付済みに戻す場合は、発送状況をご確認ください。');
    await confirmation.getByRole('button', { name: '確認して実行', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(edit).toBeEnabled();
    await expect(cancel).toBeEnabled();

    await selector.selectOption('cancelled');
    await change.click();
    const cancellation = page.getByRole('dialog', { name: '注文をキャンセルしますか？', exact: true });
    const execute = cancellation.getByRole('button', { name: '確認して実行', exact: true });
    await expect(execute).toBeDisabled();
    await cancellation.getByRole('textbox').fill('ステータスの画面回帰確認を終了');
    await execute.click();
    await expect(cancellation).toHaveCount(0);
    await expect(selector).toHaveValue('cancelled');
    await expect(selector).toBeDisabled();
    await expect(change).toBeDisabled();
    await expect(edit).toBeDisabled();
    await expect(cancel).toBeDisabled();
    const saved = (await (await page.request.get(endpoint)).json()).data;
    expect(saved.status).toBe('cancelled');
  } finally {
    let order = (await (await page.request.get(endpoint)).json()).data;
    if (order.status === 'shipped') {
      await page.request.post(endpoint + '/status', { data: { version: order.version, status: 'received' } });
      order = (await (await page.request.get(endpoint)).json()).data;
    }
    if (order.status === 'received') await page.request.post(endpoint + '/cancel', { data: { version: order.version, reason: '注文ステータステストの後片付け' } });
  }
});
