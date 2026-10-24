import { expect, test, type Page } from '@playwright/test';

test.use({ baseURL: process.env.TEST_LIFF_BASE_URL || 'http://127.0.0.1:5173', viewport: { width: 390, height: 844 } });
const company = 'trust-company', productId = 'trust-product', addressId = 'trust-address';
async function orderSetup(page: Page) {
  const state = { price: 2000, token: 1, expiryMs: 600_000, next: 'success', writes: [] as any[], lookupCount: 0, accepted: null as any };
  const actor = { id: 'trust-customer', type: 'customer', company_id: company, company_name: '確認用商店', name: '確認担当' };
  const address = { id: addressId, name: '確認本店', postal_code: '0000000', prefecture: '愛知県', city: '確認市', address_line1: '確認用住所', phone: '0000000000', is_default: 1 };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (data: any, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: data } });
    const item = (quantity: number) => ({ product_id: productId, snap_product_name: '確認商品', snap_volume_ml: 500, snap_unit: '本', unit_price: state.price, quantity, subtotal: state.price * quantity });
    const accepted = (body: any) => ({ id: 'TRUST-ORDER', company_id: company, shipping_address_id: body.shipping_address_id, note: body.note, desired_delivery_date: body.desired_delivery_date, items: body.items.map((value: any) => item(value.quantity)), total_amount: state.price * body.items.reduce((n: number, value: any) => n + value.quantity, 0) * 1.1, ordered_at: '2030-01-01T00:00:00Z' });
    if (path === '/api/config') return send({ environment: 'production', demo_enabled: false });
    if (path === '/api/auth/me') return send({ actor });
    if (path === '/api/customer/catalog') return send([{ id: productId, name: '確認商品', category: '確認', volume_ml: 500, unit: '本', unit_price: 1000, is_available: 1, sales_status: 'on_sale' }]);
    if (path === '/api/customer/addresses') return send([address]);
    if (path === '/api/customer/delivery-dates') return send(['2030-01-10']);
    if (path === '/api/customer/quote') {
      const body = request.postDataJSON(), quantity = body.items.reduce((n: number, value: any) => n + value.quantity, 0);
      return send({ items: body.items.map((value: any) => item(value.quantity)), items_subtotal: state.price * quantity, shipping_fee: 0, tax_amount: state.price * quantity / 10, total_amount: state.price * quantity * 1.1, packages: [], is_reference_tax: true, shipping_address: address, delivery_method: 'own_delivery', quote_token: body.desired_delivery_date ? `signed-quote-${state.token}` : null, quote_expires_at: body.desired_delivery_date ? new Date(Date.now() + state.expiryMs).toISOString() : null });
    }
    if (path.startsWith('/api/customer/order-requests/')) { state.lookupCount++; return send({ processed: !!state.accepted, order: state.accepted }); }
    if (path === '/api/customer/orders' && request.method() === 'POST') {
      const body = request.postDataJSON(); state.writes.push(body);
      if (state.next === 'price-change') { state.next = 'success'; state.price = 3000; state.token++; return send({ code: 'QUOTE_CHANGED', message: '価格が変更されました。' }, 409); }
      if (state.next === 'lost-accepted') { state.accepted = accepted(body); return route.abort('connectionreset'); }
      if (state.next === 'lost-missing') return route.abort('connectionreset');
      if (state.next === 'conflict') { state.accepted = { ...accepted(body), total_amount: 1100, items: [item(1)] }; return send({ code: 'REQUEST_CONTENT_CHANGED', message: '登録済みの注文と内容が異なります。' }, 409); }
      state.accepted = accepted(body); return send(state.accepted, 201);
    }
    return send([]);
  });
  await page.goto('/order');
  return state;
}
async function selectOrder(page: Page) {
  await page.locator('.ko-order-product').first().getByRole('button', { name: /を増やす$/ }).click();
  await page.getByRole('button', { name: 'カートを見る', exact: true }).click();
  await expect(page.locator('.ko-cart-item')).toContainText('￥2,000');
  await page.locator('.ko-date-select').click(); await page.locator('.ko-calendar-day:not(:disabled)').first().click();
  await expect(page.getByRole('button', { name: '注文内容を確認する', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '注文内容を確認する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文内容の確認', exact: true })).toBeVisible();
}

test('確認明細と合計は同じ見積を使い、確定時にそのトークンを送る', async ({ page }) => {
  const state = await orderSetup(page); await selectOrder(page);
  await expect(page.locator('.ko-confirm-item')).toContainText('￥2,000');
  await expect(page.locator('.ko-confirm-item')).not.toContainText('￥1,000');
  await expect(page.locator('.ko-total')).toContainText('￥2,200');
  await page.getByRole('button', { name: '注文を確定する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文を受け付けました', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1); expect(state.writes[0].quote_token).toBe('signed-quote-1');
  await expect(page.locator('.ko-receipt')).toContainText('￥2,200'); await expect(page.locator('.ko-receipt')).toContainText('1本');
  expect(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('kojima-order-pending:')))).toBe(false);
});

test('価格変更を拒否されたら最新の金額へ戻り、再確認するまで再送しない', async ({ page }) => {
  const state = await orderSetup(page); state.next = 'price-change'; await selectOrder(page);
  await page.getByRole('button', { name: '注文を確定する', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'カート', exact: true })).toBeVisible();
  await expect(page.locator('.ko-cart-item')).toContainText('￥3,000'); await expect(page.locator('.ko-total')).toContainText('￥3,300');
  expect(state.writes).toHaveLength(1); await expect(page.getByRole('heading', { name: 'ご注文を受け付けました', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '注文内容を確認する', exact: true }).click();
  await page.getByRole('button', { name: '注文を確定する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文を受け付けました', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2); expect(state.writes[1].quote_token).toBe('signed-quote-2'); expect(state.writes[1].request_id).toBe(state.writes[0].request_id);
});

test('見積の期限切れは確認画面を離れて再確認し、注文を自動送信しない', async ({ page }) => {
  await page.clock.install(); const state = await orderSetup(page); state.expiryMs = 2000; await selectOrder(page);
  state.expiryMs = 600_000; state.token++; await page.clock.fastForward(2500);
  await expect(page.getByRole('dialog', { name: 'カート', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible(); expect(state.writes).toHaveLength(0);
  await expect(page.getByRole('button', { name: '注文内容を確認する', exact: true })).toBeEnabled();
});

test('受付後に応答だけ失われてもUUIDの結果を確認し、再発注せず完了する', async ({ page }) => {
  const state = await orderSetup(page); state.next = 'lost-accepted'; await selectOrder(page);
  await page.getByRole('button', { name: '注文を確定する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文を受け付けました', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1); expect(state.lookupCount).toBeGreaterThan(0);
});

test('結果不明の間は内容変更を止め、明示的な再送も同じUUID・内容だけを使う', async ({ page }) => {
  const state = await orderSetup(page); state.next = 'lost-missing'; await selectOrder(page);
  await page.getByRole('button', { name: '注文を確定する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '注文の受付結果を確認', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /を増やす$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '同じ内容で再送する', exact: true })).toBeEnabled();
  state.next = 'success'; await page.getByRole('button', { name: '同じ内容で再送する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文を受け付けました', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2); expect(state.writes[1]).toEqual(state.writes[0]);
});

test('画面を開き直しても確認待ちUUIDを保持し、新しい注文を送信しない', async ({ page }) => {
  const state = await orderSetup(page); state.next = 'lost-missing'; await selectOrder(page);
  await page.getByRole('button', { name: '注文を確定する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '注文の受付結果を確認', exact: true })).toBeVisible();
  const pendingId = state.writes[0].request_id;
  expect(await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('kojima-order-pending:')))).toEqual([[`kojima-order-pending:${company}`, pendingId]]);
  await page.reload(); await expect(page.getByRole('heading', { name: '注文の受付結果を確認', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '同じ内容で再送する', exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(1);
  state.accepted = { id: 'TRUST-ORDER', total_amount: 2200, desired_delivery_date: '2030-01-10', items: [{ quantity: 1 }] };
  await page.getByRole('button', { name: '受付結果を確認する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文を受け付けました', exact: true })).toBeVisible(); expect(state.writes).toHaveLength(1);
});

test('内容違いの再送は古い注文を新しい成功として表示しない', async ({ page }) => {
  const state = await orderSetup(page); state.next = 'conflict'; await selectOrder(page);
  await page.getByRole('button', { name: '注文を確定する', exact: true }).click();
  await expect(page.getByText('今回の変更内容を受け付けたという意味ではありません。', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ご注文を受け付けました', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '登録済みの注文を確認する', exact: true })).toHaveAttribute('href', '/orders/TRUST-ORDER'); expect(state.writes).toHaveLength(1);
});


test('通信断の結果照会でも内容が違う既存注文を新しい受付成功にしない', async ({ page }) => {
  const state = await orderSetup(page); state.next = 'lost-missing'; await selectOrder(page);
  await page.getByRole('button', { name: '注文を確定する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '注文の受付結果を確認', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '受付結果を確認する', exact: true })).toBeEnabled();
  state.accepted = { id: 'TRUST-ORDER', shipping_address_id: addressId, desired_delivery_date: '2030-01-10', note: '', items: [{ product_id: productId, quantity: 2 }], total_amount: 4400 };
  await page.getByRole('button', { name: '受付結果を確認する', exact: true }).click();
  await expect(page.getByRole('link', { name: '登録済みの注文を確認する', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ご注文を受け付けました', exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(1);
});

async function registrationSetup(page: Page, wrongCompany = false, sessionLookupUnavailable = false) {
  const state = { linked: false, registrations: 0, authChecks: 0, sessionChecks: 0 };
  const actor = { id: 'registered-customer', type: 'customer', company_id: wrongCompany ? 'another-company' : company, company_name: '確認用商店', name: '担当者' };
  await page.route('**/node_modules/.vite/deps/@line_liff.js*', route => route.fulfill({ contentType: 'application/javascript', body: `export default {async init(){},isLoggedIn(){return true},getIDToken(){return 'test-only-verified-id-token'},getAccessToken(){return null},async getProfile(){return {userId:'registered-customer',displayName:'担当者'}},async getFriendship(){return {friendFlag:true}},isInClient(){return false},logout(){},login(){}};` }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, send = (data: any, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: data } });
    if (path === '/api/config') return send({ liff_id: 'test-liff', environment: 'production', demo_enabled: false });
    if (path === '/api/auth/line') { state.authChecks++; return state.linked ? send({ actor }) : send({ code: 'LINE_USER_NOT_REGISTERED', message: '登録が必要です。' }, 403); }
    if (path === '/api/auth/me') { state.sessionChecks++; return sessionLookupUnavailable ? send({ code: 'UNAVAILABLE', message: '一時的にセッションを照会できません。' }, 503) : state.linked ? send({ actor }) : send({ code: 'HTTP_401' }, 401); }
    if (path === '/api/customer/me') return send({ ...actor, id: 'membership-id', line_user_id: actor.id });
    if (path === '/api/public/invitations/resume') return send({ pending: true, handoff_id: 'test-handoff', company_id: company, company_name: '確認用商店' });
    if (path === '/api/public/invitations/register-pending') { state.registrations++; state.linked = true; return sessionLookupUnavailable ? send({ actor }) : route.abort('connectionreset'); }
    if (path === '/api/customer/catalog') return send([]);
    if (path === '/api/customer/addresses') return send([{ id: addressId, name: '確認本店', is_default: 1 }]);
    if (path === '/api/customer/delivery-dates') return send(['2030-01-10']);
    return send([]);
  });
  await page.goto('/invite/resume'); await expect(page.getByLabel('ご担当者名')).toBeVisible();
  await page.getByLabel('ご担当者名').fill('確認担当'); await page.getByRole('button', { name: '登録して注文へ進む', exact: true }).click(); return state;
}

test('登録応答だけ失われた場合は同じ企業への登録を再認証で確認して復帰する', async ({ page }) => {
  const state = await registrationSetup(page);
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
  expect(state.registrations).toBe(1); expect(state.authChecks).toBe(2);
});

test('登録結果の再確認で別企業が返った場合は登録成功として遷移しない', async ({ page }) => {
  const state = await registrationSetup(page, true);
  await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('heading', { name: 'お取引先のご登録', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toHaveCount(0); expect(state.registrations).toBe(1);
});


test('登録成功応答の利用者を保持し、後続のセッション照会障害で登録画面へ戻らない', async ({ page }) => {
  const state = await registrationSetup(page, false, true);
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
  expect(state.registrations).toBe(1); expect(state.sessionChecks).toBe(0);
  await expect(page.getByRole('heading', { name: 'お取引先のご登録', exact: true })).toHaveCount(0);
});
