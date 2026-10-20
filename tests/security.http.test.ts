import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'vitest';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8787';
type Json = Record<string, any>;

class Session {
  cookie = '';
  constructor(public readonly origin = base) {}
  async request(method: string, path: string, body?: Json, headers: Record<string, string> = {}) {
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';', 1)[0];
    const json = await response.json().catch(() => ({})) as Json;
    return { response, status: response.status, json, data: json.data };
  }
  async ok(method: string, path: string, body?: Json) {
    const result = await this.request(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.json)}`).toBeLessThan(300);
    expect(result.status).toBeGreaterThanOrEqual(200);
    return result.data;
  }
}

const admin = new Session();
const customerA = new Session();
const customerB = new Session();
const anonymous = new Session();
const unique = randomUUID().slice(0, 8);
let companyId = '';
let addressId = '';
let deliveryDate = '';
const customer = new Session();

async function loginCustomer(session: Session, company_id: string) {
  return session.ok('POST', '/api/auth/demo/customer', { company_id });
}
async function makeOrder(session = customer, overrides: Json = {}) {
  const data = await session.ok('POST', '/api/customer/orders', {
    request_id: randomUUID(),
    shipping_address_id: addressId,
    desired_delivery_date: deliveryDate,
    items: [{ product_id: 'samurai-300', quantity: 2 }],
    ...overrides,
  });
  return data;
}
async function detail(id: string, session = customer) {
  return session.ok('GET', `/api/customer/orders/${id}`);
}
const itemPrice = (order: Json) => Number(order.items.find((row: Json) => row.product_id === 'samurai-300').unit_price);

beforeAll(async () => {
  const health = await fetch(`${base}/api/health`).catch(() => {
    throw new Error(`Start the local worker before HTTP checks (TEST_BASE_URL=${base}).`);
  });
  expect(health.ok).toBe(true);
  await admin.ok('POST', '/api/auth/demo/admin', {});
  await Promise.all([loginCustomer(customerA, 'company-a'), loginCustomer(customerB, 'company-b')]);
  const company = await admin.ok('POST', '/api/admin/companies', { name: `検証用取引先 ${unique}`, contact_name: '自動検証', phone: '000-0000-0000' });
  companyId = company.id;
  const address = await admin.ok('POST', `/api/admin/companies/${companyId}/addresses`, {
    name: '検証用配送先', postal_code: '4840081', prefecture: '愛知県', city: '犬山市',
    address_line1: '検証用住所', phone: '000-0000-0000', contact_name: '自動検証',
    shipping_rule_id: 'RULE_AREA_A', is_default: 1,
  });
  addressId = address.id;
  await loginCustomer(customer, companyId);
  const dates = await customer.ok('GET', `/api/customer/delivery-dates?shipping_address_id=${addressId}`);
  deliveryDate = (Array.isArray(dates) ? dates : dates.dates)[0];
  expect(deliveryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

describe('authentication and tenant boundaries over HTTP', () => {
  test('requires authentication on every business API and rejects forged bearer identity', async () => {
    for (const path of ['/api/admin/dashboard', '/api/admin/companies', '/api/admin/orders', '/api/admin/invoices', '/api/admin/audit', '/api/customer/orders', '/api/customer/catalog', '/api/customer/addresses']) {
      const result = await anonymous.request('GET', path);
      expect(result.status, path).toBe(401);
    }
    const forged = await anonymous.request('GET', '/api/customer/orders?company_id=company-a&lineUserId=demo', undefined, { authorization: 'Bearer dev:company-a' });
    // An unconfigured LINE verifier returns 503; neither response grants a session.
    expect([401, 503]).toContain(forged.status);
  });

  test('keeps admin and customer permissions separate', async () => {
    const result = await customerA.request('GET', '/api/admin/orders');
    expect([401, 403]).toContain(result.status);
  });

  test('rejects tampered sessions and cross-site administrative writes', async () => {
    expect(admin.cookie).toBeTruthy();
    const tampered = new Session();
    tampered.cookie = admin.cookie.slice(0, -3) + 'xyz';
    expect((await tampered.request('GET', '/api/admin/orders')).status).toBe(401);
    const crossSite = await admin.request('POST', '/api/admin/companies', { name: `cross-site ${unique}` }, { origin: 'https://untrusted.example' });
    expect(crossSite.status).toBe(403);
  });

  test('does not let supplied company IDs broaden customer queries', async () => {
    const addresses = await customerA.ok('GET', '/api/customer/addresses?company_id=company-b');
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((row: Json) => row.company_id === 'company-a')).toBe(true);
    const orders = await customerA.ok('GET', '/api/customer/orders?company_id=company-b');
    expect(orders.every((row: Json) => row.company_id === 'company-a')).toBe(true);
    const aPrices = await customerA.ok('GET', '/api/customer/catalog?company_id=company-b');
    const bPrices = await customerB.ok('GET', '/api/customer/catalog?company_id=company-a');
    expect(aPrices.find((row: Json) => row.id === 'samurai-300').unit_price).toBe(2100);
    expect(bPrices.find((row: Json) => row.id === 'samurai-300').unit_price).toBe(2300);
    const restricted = await customer.ok('GET', '/api/customer/catalog');
    expect(restricted.some((row: Json) => row.id === 'nindou-1800')).toBe(false);
  });

  test('rejects another tenant\'s shipping address before creating an order', async () => {
    const result = await customerA.request('POST', '/api/customer/orders', {
      company_id: 'company-b', request_id: randomUUID(), shipping_address_id: 'address-b',
      desired_delivery_date: deliveryDate, items: [{ product_id: 'samurai-300', quantity: 1 }],
    });
    expect([400, 403, 404]).toContain(result.status);
  });
});

describe('order integrity over HTTP', () => {
  test('deduplicates concurrent confirmation requests and does not expose their result to another company', async () => {
    const payload = {
      request_id: randomUUID(), shipping_address_id: addressId, desired_delivery_date: deliveryDate,
      items: [{ product_id: 'samurai-300', quantity: 2 }],
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => customer.request('POST', '/api/customer/orders', payload)));
    for (const result of results) expect([200, 201]).toContain(result.status);
    const ids = new Set(results.map((result) => result.data.id));
    expect(ids.size).toBe(1);
    const orderId = results[0].data.id;
    const foreignRead = await customerB.request('GET', `/api/customer/orders/${orderId}`);
    expect([403, 404]).toContain(foreignRead.status);
    for (const [method, suffix, body] of [
      ['POST', '/lock', {}],
      ['POST', '/cancel', { version: 1, reason: '権限検証' }],
      ['PUT', '', { ...payload, version: 1 }],
    ] as const) {
      expect((await customerB.request(method, `/api/customer/orders/${orderId}${suffix}`, body)).status).toBe(404);
    }
    const foreignReplay = await customerB.request('POST', '/api/customer/orders', { ...payload, shipping_address_id: 'address-b' });
    expect([400, 403, 404, 409]).toContain(foreignReplay.status);
    expect(JSON.stringify(foreignReplay.json)).not.toContain(orderId);
  });

  test('rejects invalid and duplicate quantities before persisting any order', async () => {
    for (const items of [
      [{ product_id: 'samurai-300', quantity: 0 }],
      [{ product_id: 'samurai-300', quantity: -1 }],
      [{ product_id: 'samurai-300', quantity: 1.5 }],
      [{ product_id: 'samurai-300', quantity: 1 }, { product_id: 'samurai-300', quantity: 1 }],
      [{ product_id: 'mini-80', quantity: 1 }],
    ]) {
      const result = await customer.request('POST', '/api/customer/orders', { request_id: randomUUID(), shipping_address_id: addressId, desired_delivery_date: deliveryDate, items });
      expect([400, 422]).toContain(result.status);
    }
  });

  test('preserves original item prices after a master change and rejects stale versions', async () => {
    const created = await makeOrder();
    const original = await detail(created.id);
    const price = itemPrice(original);
    await admin.ok('POST', `/api/admin/companies/${companyId}/prices`, {
      product_id: 'samurai-300', unit_price: price + 137, is_available: 1, valid_from: '2020-01-01',
    });
    await admin.ok('PUT', `/api/admin/companies/${companyId}/addresses/${addressId}`, { address_line1: '編集後の配送先住所' });
    expect(itemPrice(await detail(created.id))).toBe(price);
    await customer.ok('POST', `/api/customer/orders/${created.id}/lock`, {});
    const edited = await customer.ok('PUT', `/api/customer/orders/${created.id}`, {
      version: original.version, shipping_address_id: addressId, desired_delivery_date: deliveryDate,
      items: [{ product_id: 'samurai-300', quantity: 3 }],
    });
    const current = await detail(created.id);
    expect(itemPrice(current)).toBe(price);
    expect(current.version).toBe(original.version + 1);
    expect(current.items[0].quantity).toBe(3);
    expect(current.snap_address).toBe(original.snap_address);
    const stale = await customer.request('PUT', `/api/customer/orders/${created.id}`, {
      version: original.version, shipping_address_id: addressId, desired_delivery_date: deliveryDate,
      items: [{ product_id: 'samurai-300', quantity: 4 }],
    });
    expect(stale.status).toBe(409);
    expect((await detail(created.id)).items[0].quantity).toBe(3);
    expect(edited.id).toBe(created.id);
    const next = await detail((await makeOrder()).id);
    expect(itemPrice(next)).toBe(price + 137);
    // A temporary removal must not erase the first-order price of this product.
    await customer.ok('POST', `/api/customer/orders/${created.id}/lock`, {});
    const removed = await customer.ok('PUT', `/api/customer/orders/${created.id}`, {
      version: current.version, shipping_address_id: addressId, desired_delivery_date: deliveryDate,
      items: [{ product_id: 'samurai-500', quantity: 1 }],
    });
    await customer.ok('POST', `/api/customer/orders/${created.id}/lock`, {});
    const restored = await customer.ok('PUT', `/api/customer/orders/${created.id}`, {
      version: removed.version, shipping_address_id: addressId, desired_delivery_date: deliveryDate,
      items: [{ product_id: 'samurai-300', quantity: 3 }, { product_id: 'samurai-500', quantity: 1 }],
    });
    expect(itemPrice(restored)).toBe(price);
    expect(restored.revisions).toHaveLength(3);
  });

  test('commits one edit revision when two saves race on the same version', async () => {
    const created = await makeOrder();
    await customer.ok('POST', `/api/customer/orders/${created.id}/lock`, {});
    const results = await Promise.all([3, 4].map((quantity) => customer.request('PUT', `/api/customer/orders/${created.id}`, {
      version: created.version, shipping_address_id: addressId, desired_delivery_date: deliveryDate,
      items: [{ product_id: 'samurai-300', quantity }],
    })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200)!.data;
    const saved = await detail(created.id);
    expect(saved.version).toBe(created.version + 1);
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0].quantity).toBe(winner.items[0].quantity);
    expect(saved.revisions).toHaveLength(1);
    expect(saved.items_subtotal).toBe(saved.items[0].unit_price * saved.items[0].quantity);
    const logs = await admin.ok('GET', `/api/admin/audit?action=ORDER_EDIT&company_id=${companyId}`);
    expect(logs.filter((row: Json) => row.target_id === created.id)).toHaveLength(1);
  });

  test('holds the edit lock against another actor and never overwrites the active editor', async () => {
    const created = await makeOrder();
    const original = await detail(created.id);
    await admin.ok('POST', `/api/admin/orders/${created.id}/lock`, {});
    const secondLock = await customer.request('POST', `/api/customer/orders/${created.id}/lock`, {});
    expect(secondLock.status).toBe(409);
    const attemptedEdit = await customer.request('PUT', `/api/customer/orders/${created.id}`, {
      version: original.version, shipping_address_id: addressId, desired_delivery_date: deliveryDate,
      items: [{ product_id: 'samurai-300', quantity: 99 }],
    });
    expect(attemptedEdit.status).toBe(409);
    expect((await detail(created.id)).items[0].quantity).toBe(2);
    expect((await detail(created.id)).can_edit).toBe(false);
    await admin.ok('DELETE', `/api/admin/orders/${created.id}/lock`);
    await customer.ok('POST', `/api/customer/orders/${created.id}/lock`, {});
    const passiveCleanup = await admin.ok('DELETE', `/api/admin/orders/${created.id}/lock`);
    expect(passiveCleanup.unlocked).toBe(false);
    expect((await admin.request('POST', `/api/admin/orders/${created.id}/lock`, {})).status).toBe(409);
    const forced = await admin.ok('DELETE', `/api/admin/orders/${created.id}/lock?force=true`);
    expect(forced).toMatchObject({ unlocked: true });
    await admin.ok('POST', `/api/admin/orders/${created.id}/lock`, {});
    const logs = await admin.ok('GET', `/api/admin/audit?action=ORDER_FORCE_UNLOCK&company_id=${companyId}`);
    expect(logs.filter((row: Json) => row.target_id === created.id)).toHaveLength(1);
  });

  test('allows an administrator to correct a completed order while preserving customer restrictions', async () => {
    const created = await makeOrder();
    let order = created;
    for (const status of ['confirmed', 'preparing', 'shipped', 'completed']) {
      order = await admin.ok('POST', `/api/admin/orders/${created.id}/status`, { version: order.version, status });
    }
    expect((await detail(created.id)).can_edit).toBe(false);
    expect((await customer.request('POST', `/api/customer/orders/${created.id}/lock`, {})).status).toBe(409);
    await admin.ok('POST', `/api/admin/orders/${created.id}/lock`, {});
    const corrected = await admin.ok('PUT', `/api/admin/orders/${created.id}`, {
      version: order.version, shipping_address_id: addressId, desired_delivery_date: deliveryDate,
      items: [{ product_id: 'samurai-300', quantity: 3 }],
    });
    expect(corrected.status).toBe('completed');
    expect(corrected.items[0].quantity).toBe(3);
    expect((await admin.request('POST', `/api/admin/orders/${created.id}/cancel`, { version: corrected.version, reason: '完了後取消不可' })).status).toBe(409);
  });

  test('locks issued orders and keeps historical invoice print data immutable', async () => {
    const order = await makeOrder();
    const invoice = await admin.ok('POST', '/api/admin/invoices', {
      company_id: companyId, period_start: '2020-01-01', period_end: '2099-12-31', order_ids: [order.id], due_date: '2099-12-31',
    });
    const histories = await admin.ok('GET', `/api/admin/invoices/${invoice.id}/history`);
    expect(histories.length).toBe(1);
    const before = await admin.ok('GET', `/api/admin/invoices/${invoice.id}/history/${histories[0].id}`);
    const locked = await detail(order.id);
    expect(locked.is_invoice_locked).toBe(1);
    const cancel = await customer.request('POST', `/api/customer/orders/${order.id}/cancel`, { version: locked.version, reason: 'ロック検証' });
    expect([400, 403, 409]).toContain(cancel.status);
    const editLock = await customer.request('POST', `/api/customer/orders/${order.id}/lock`, {});
    expect([400, 403, 409]).toContain(editLock.status);
    await admin.ok('PUT', `/api/admin/companies/${companyId}`, { name: `請求後変更 ${unique}`, contact_name: '自動検証' });
    const after = await admin.ok('GET', `/api/admin/invoices/${invoice.id}/history/${histories[0].id}`);
    expect(after.snapshot_json).toEqual(before.snapshot_json);
    await admin.ok('POST', `/api/admin/invoices/${invoice.id}/cancel`, { reason: '自動検証後の取消' });
    expect((await detail(order.id)).is_invoice_locked).toBe(0);
    const cancelledHistory = await admin.ok('GET', `/api/admin/invoices/${invoice.id}/history/${histories[0].id}`);
    expect(cancelledHistory.snapshot_json).toEqual(before.snapshot_json);
    const unlocked = await detail(order.id);
    await customer.ok('POST', `/api/customer/orders/${order.id}/lock`, {});
    await customer.ok('PUT', `/api/customer/orders/${order.id}`, {
      version: unlocked.version, shipping_address_id: addressId, desired_delivery_date: deliveryDate,
      items: [{ product_id: 'samurai-300', quantity: 4 }],
    });
    const reissued = await admin.ok('POST', `/api/admin/invoices/${invoice.id}/reissue`, {});
    expect(reissued.latest_version).toBe(2);
    expect(reissued.total_incl_tax).toBeGreaterThan(invoice.total_incl_tax);
    expect((await detail(order.id)).is_invoice_locked).toBe(1);
    const reissuedHistories = await admin.ok('GET', `/api/admin/invoices/${invoice.id}/history`);
    expect(reissuedHistories.filter((row: Json) => ['issue', 'reissue'].includes(row.action_type))).toHaveLength(2);
    expect(reissuedHistories.find((row: Json) => row.id === histories[0].id).snapshot_json).toBe(before.snapshot_json);
    await admin.ok('POST', `/api/admin/invoices/${invoice.id}/cancel`, { reason: '再発行の自動検証終了' });
  });
});

describe('invitation HTTP access control', () => {
  test('keeps URLs opaque, never returns stored hashes, and refuses active cross-company rebinding', async () => {
    const invite = await admin.ok('POST', `/api/admin/companies/${companyId}/invitations`, { max_uses: 1 });
    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.url).not.toContain(companyId);
    expect(invite.token_hash).toBeUndefined();
    const lookup = await anonymous.ok('GET', `/api/public/invitations/lookup?t=${invite.token}`);
    expect(lookup.token_hash).toBeUndefined();
    expect(lookup).toMatchObject({ full: false, usable: true, already_registered: false, different_company: false });
    const existingLookup = await customer.ok('GET', `/api/public/invitations/lookup?t=${invite.token}`);
    expect(existingLookup).toMatchObject({ already_registered: true, usable: true });
    const foreignLookup = await customerB.ok('GET', `/api/public/invitations/lookup?t=${invite.token}`);
    expect(foreignLookup).toMatchObject({ different_company: true, usable: false });
    const rebind = await customerB.request('POST', '/api/public/invitations/register', { token: invite.token, staff_name: '検証担当者' });
    expect(rebind.status).toBe(409);
    const replay = await customer.request('POST', '/api/public/invitations/register', { token: invite.token, staff_name: '登録済み担当者' });
    expect(replay.status).toBe(200);
    const invitations = await admin.ok('GET', `/api/admin/companies/${companyId}/invitations`);
    const stored = invitations.find((row: Json) => row.id === invite.id);
    expect(stored.used_count).toBe(0);
    expect(stored.token_hash).toBeUndefined();
    const logs = await admin.ok('GET', `/api/admin/audit?action=INVITE_ISSUE&company_id=${companyId}`);
    expect(JSON.stringify(logs)).not.toContain(invite.token);
    await admin.ok('POST', `/api/admin/companies/${companyId}/invitations/${invite.id}/revoke`, {});
    expect((await anonymous.request('GET', `/api/public/invitations/lookup?t=${invite.token}`)).status).toBe(410);
  });
});
