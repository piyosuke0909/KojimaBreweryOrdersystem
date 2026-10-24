import { describe, expect, it } from 'vitest';
// @ts-expect-error The executable helper intentionally remains plain Node.js ESM.
import { addDays, jstToday, MARKER, prepareDemo } from '../scripts/prepare-demo.mjs';
// @ts-expect-error The executable helper intentionally remains plain Node.js ESM.
import { verifyDemoWorkflow } from '../scripts/verify-demo-workflow.mjs';

type Row = Record<string, any>;
const clone = <T>(value: T): T => structuredClone(value);

/** Stateful application boundary: no production requests, credentials, or files. */
class DemoAPI {
  origin = 'https://orders.example.invalid';
  sequence = 0;
  mutations = 0;
  notifications = 0;
  notificationResult = 'sent';
  signedQuotes = true;
  quoteInputs: Row[] = [];
  orderInputs: Row[] = [];
  requestLookups = 0;
  issuer: Row = { company_name: '小島醸造', display_name: '小島醸造', address: '既存の会社住所', bank_name: '既存銀行', bank_account_number: '1234567', note: '既存の会社情報' };
  settings: Row = { contact_phone: '既存電話', contact_email: 'existing@example.invalid', contact_hours: '', notification_email: '' };
  members: Row[] = [{ id: 'member-1', line_user_id: 'test-line-user-1', company_id: 'company-a', status: 'active' }];
  tables: Record<string, Row[]> = {
    companies: [{ id: 'company-a', name: 'A商店', status: 'active', address: '既存の取引先住所' }],
    products: [{ id: 'original-product', name: '既存商品', standard_price: 4500, weight_kg: 2.3, sales_status: 'on_sale', note: '既存の正式商品' }],
    'shipping-rules': [{ id: 'original-rule', name: '既存ルール', status: 'active', delivery_method: 'own_delivery', note: '既存の配送条件' }],
    addresses: [{ id: 'original-address', company_id: 'company-a', name: 'デモ配送先（動作確認用）', status: 'active', is_default: 1, postal_code: '000-0000', address_line1: '既存のデモ住所' }],
    prices: [{ id: 'original-price', company_id: 'company-a', product_id: 'original-product', unit_price: 3900, is_available: 1, status: 'active', valid_from: '2020-01-01', note: '既存の企業別単価' }],
    contracts: [{ id: 'original-contract', company_id: 'company-a', status: 'active', contract_name: '既存の契約' }],
    boxes: [{ id: 'original-box', name: '既存の箱', supported_volumes_json: '[80]', status: 'active', note: '既存の実測箱' }],
    sizes: [{ size_code: '60', max_three_sides_cm: 60, max_weight_kg: 1.9, status: 'active' }],
    rates: [{ id: 'original-rate', origin_region: '中部', dest_region: '東京都', size_code: '80', shipping_fee: 987, status: 'active', valid_from: '2020-01-01' }],
    calendar: [{ date: addDays(jstToday(), 1), is_deliverable: 0, reason: '既存の臨時休業', note: '既存の営業日設定' }],
    orders: [], invoices: [], audit: [],
  };
  detail() {
    return clone({ ...this.tables.companies[0], addresses: this.tables.addresses, prices: this.tables.prices, contracts: this.tables.contracts, line_users: this.members });
  }
  async get(path: string): Promise<Row> {
    if (path === '/api/admin/company-info') return clone(this.issuer);
    if (path === '/api/admin/settings') return clone(this.settings);
    if (path === '/api/admin/companies/company-a') return this.detail();
    if (path === '/api/admin/dashboard') return { new_orders: this.tables.orders.length, recent_orders: clone(this.tables.orders) };
    const parts = path.split('/');
    if (parts[3] === 'order-requests') {
      this.requestLookups++;
      const order = this.tables.orders.find(row => row.request_id === decodeURIComponent(parts[4]));
      return { processed: Boolean(order), order: order ? clone(order) : null };
    }
    if (parts[3] === 'orders' && parts[5] === 'delivery-note') {
      const order = this.tables.orders.find((row) => row.id === parts[4]);
      return clone({ kind: 'delivery-note', order, items: order?.items, issuer: this.issuer });
    }
    if (parts[3] === 'orders' || parts[3] === 'invoices') {
      const row = this.tables[parts[3]].find((row) => row.id === parts[4]);
      if (!row) throw new Error('Missing fake record');
      return clone(row);
    }
    throw new Error('Unexpected fake GET path');
  }
  async list(path: string): Promise<Row[]> {
    const url = new URL(path, this.origin);
    const resource = url.pathname.split('/')[3];
    let rows = this.tables[resource] ?? [];
    if (resource === 'audit') rows = rows.filter((row) => row.action === url.searchParams.get('action') && row.target_id === url.searchParams.get('q'));
    if (resource === 'orders' && url.searchParams.has('q')) rows = rows.filter((row) => row.id === url.searchParams.get('q'));
    return clone(rows);
  }
  quote(input: Row) {
    const items = input.items.map((item: Row) => ({ ...item, unit_price: this.tables.prices.find((price) => price.product_id === item.product_id && price.status === 'active')!.unit_price }));
    const subtotal = items.reduce((sum: number, item: Row) => sum + item.unit_price * item.quantity, 0);
    return { items, packages: [{ package_no: 1 }, { package_no: 2 }], shipping_fee: 2000, total_amount: Math.round((subtotal + 2000) * 1.1), delivery_dates: [addDays(jstToday(), 10)], ...(this.signedQuotes && input.desired_delivery_date ? { quote_token: 'unit-test-only-dated-quote', quote_expires_at: new Date(Date.now() + 600000).toISOString() } : {}) };
  }
  async write(path: string, input: Row, method = 'POST'): Promise<Row> {
    if (path === '/api/admin/orders/quote') { this.quoteInputs.push(clone(input)); return clone(this.quote(input)); } // Pure quote, no mutation.
    this.mutations++;
    if (path === '/api/admin/company-info' || path === '/api/admin/settings') {
      const store = path.endsWith('company-info') ? this.issuer : this.settings;
      Object.assign(store, input);
      return clone(store);
    }
    if (path === '/api/admin/invoices') {
      expect(input.order_ids).toHaveLength(1);
      const order = this.tables.orders.find((row) => row.id === input.order_ids[0])!;
      expect(order.id).toMatch(/^TEST-O/);
      const row = { id: `INV-TEST-${++this.sequence}`, status: 'issued', company_id: input.company_id, note: input.note, total_incl_tax: order.total_amount, items: [{ order_id: order.id }], snapshot: { orders: [clone(order)], items: clone(order.items), total_incl_tax: order.total_amount, issuer: clone(this.issuer) } };
      order.is_invoice_locked = 1;
      this.tables.invoices.push(row);
      return clone(row);
    }
    const parts = path.split('/');
    const companyChild = parts[3] === 'companies' && parts.length > 5;
    const resource = companyChild ? (parts[5] === 'prices' ? 'prices' : parts[5]) : parts[3];
    const key = resource === 'sizes' ? 'size_code' : resource === 'calendar' ? 'date' : 'id';
    const identifier = companyChild ? parts[6] : parts[4];
    const table = this.tables[resource];
    if (!table) throw new Error('Unexpected fake write path');
    if (method === 'PUT') {
      const row = table.find((item) => item[key] === identifier)!;
      expect(row).toBeTruthy();
      if (resource === 'addresses' && input.is_default === 1) for (const row of table) row.is_default = 0;
      Object.assign(row, input);
      return clone(row);
    }
    if (resource === 'prices') for (const row of table) if (row.product_id === input.product_id && row.status === 'active') row.status = 'archived';
    if (resource === 'addresses' && input.is_default === 1) for (const row of table) row.is_default = 0;
    const row = { ...(key === 'id' ? { id: `generated-${++this.sequence}` } : {}), ...(companyChild ? { company_id: parts[4] } : {}), ...(resource === 'prices' ? { status: 'active' } : {}), ...clone(input) };
    table.push(row);
    return clone(row);
  }
  async request(path: string, method = 'GET', input?: Row) {
    expect(path).toBe('/api/admin/orders');
    expect(method).toBe('POST');
    this.orderInputs.push(clone(input!));
    expect(input!.items).toHaveLength(3); expect(input!.shipping_address_id).toBeTruthy(); expect(input!.desired_delivery_date).toBeTruthy();
    const prior = this.tables.orders.find((order) => order.request_id === input!.request_id);
    if (prior) { const { quote_token: _first, ...first } = this.orderInputs[0], { quote_token: _next, ...next } = input!; expect(next).toEqual(first); return { status: 200, data: clone(prior) }; }
    expect(input!.quote_token).toBe('unit-test-only-dated-quote');
    expect(input!.is_test_order).toBe(true);
    expect(this.members.some((member) => member.line_user_id === input!.ordered_by_line_user_id)).toBe(true);
    this.mutations++;
    this.notifications++;
    const quote = this.quote(input!);
    const row = { ...clone(input!), ...quote, id: `TEST-O-FAKE-${++this.sequence}`, ordered_at: new Date().toISOString(), is_invoice_locked: 0 };
    this.tables.orders.push(row);
    this.tables.audit.push({ id: `audit-${++this.sequence}`, action: 'ORDER_CREATE', actor_type: 'admin', target_id: row.id }, { id: `audit-${++this.sequence}`, action: 'NOTIFICATION_ORDER_CREATE', target_id: row.id, note: this.notificationResult });
    return { status: 201, data: clone(row) };
  }
}

const opts = (apply: boolean) => ({ apply, notifyLine: apply, pdf: false });
async function prepared(api: DemoAPI) {
  let preparation: Row | null = null;
  await prepareDemo(api, opts(true), { persist: (value: Row) => { preparation = clone(value); } });
  expect(preparation).toBeTruthy();
  return preparation as unknown as Row;
}

describe('demo helper safety and single-order workflow', () => {
  it('plans without business writes or state files', async () => {
    const api = new DemoAPI(), before = clone(api.tables);
    let persisted = false;
    const summary = await prepareDemo(api, opts(false), { persist: () => { persisted = true; } });
    expect(summary.mode).toBe('plan');
    expect(api.mutations).toBe(0);
    expect(api.tables).toEqual(before);
    expect(persisted).toBe(false);
    expect(api.notifications).toBe(0);
  });

  it('preserves existing prices, masters, member, issuer, and holiday and applies owned demos only once', async () => {
    const api = new DemoAPI(), before = clone(api.tables), members = clone(api.members), issuer = clone(api.issuer);
    const preparation = await prepared(api);
    const writes = api.mutations;
    const second = await prepareDemo(api, opts(true), { persist: () => {} });
    expect(api.mutations).toBe(writes);
    expect(second.created).toEqual({});
    expect(second.updated).toEqual({});
    for (const resource of ['products', 'prices', 'shipping-rules', 'boxes', 'sizes', 'rates', 'calendar', 'contracts']) expect(api.tables[resource]).toContainEqual(before[resource][0]);
    expect(api.members).toEqual(members);
    for (const key of ['address', 'bank_name', 'bank_account_number', 'display_name']) expect(api.issuer[key]).toBe(issuer[key]);
    expect(api.settings.contact_email).toBe('existing@example.invalid');
    expect(api.tables.addresses.find((row) => row.id === preparation.addresses.yamato)?.is_default).toBe(1);
    expect(api.tables.addresses.find((row) => row.id === 'original-address')?.address_line1).toBe(before.addresses[0].address_line1);
    expect(api.tables.calendar).toEqual(before.calendar);
  });

  it('keeps a real default address while adding separate labelled addresses', async () => {
    const api = new DemoAPI();
    api.tables.addresses[0].name = '本店';
    const original = clone(api.tables.addresses[0]);
    const preparation = await prepared(api);
    expect(api.tables.addresses.find((row) => row.id === original.id)).toEqual(original);
    expect(api.tables.addresses.find((row) => row.id === preparation.addresses.yamato)?.is_default).toBe(0);
  });

  it('plans the workflow without creating an order, invoice, notification, or private state', async () => {
    const api = new DemoAPI(), preparation = await prepared(api), writes = api.mutations;
    const result = await verifyDemoWorkflow(api, opts(false), { preparation, state: null, persist: () => { throw new Error('Unexpected state write'); } });
    expect(result.application_writes).toBe(0);
    expect(result.existing_line_members).toBe(1);
    expect(api.mutations).toBe(writes);
    expect(api.tables.orders).toHaveLength(0);
    expect(api.tables.invoices).toHaveLength(0);
    expect(api.notifications).toBe(0);
  });

  it('verifies the same order, one recipient, one notification, and one invoice on repeated runs', async () => {
    const api = new DemoAPI(), preparation = await prepared(api), members = clone(api.members);
    let state: Row | null = null;
    const evidence: Row[] = [];
    const dependencies = () => ({ preparation, state, persist: (value: Row) => { state = clone(value); }, saveEvidence: (value: Row) => evidence.push(clone(value)), skipNotificationWait: true });
    const first = await verifyDemoWorkflow(api, opts(true), dependencies());
    const writes = api.mutations;
    const second = await verifyDemoWorkflow(api, opts(true), dependencies());
    expect(first.order_created_this_run).toBe(true);
    expect(second.order_created_this_run).toBe(false);
    expect(first.order_id).toBe(second.order_id);
    expect(first.invoice_id).toBe(second.invoice_id);
    expect(second.line_api_accepted).toBe(true);
    expect(second.idempotent_replay_verified).toBe(true);
    expect(first.idempotent_replay_this_run).toBe(true); expect(second.idempotent_replay_this_run).toBe(false);
    expect(first.order_result_lookup_verified).toBe(true); expect(second.order_result_lookup_verified).toBe(true);
    expect(api.orderInputs).toHaveLength(2); expect(api.orderInputs[1]).toEqual(api.orderInputs[0]);
    expect(api.quoteInputs.some(input => Boolean(input.desired_delivery_date))).toBe(true);
    expect(api.mutations).toBe(writes);
    expect(api.tables.orders).toHaveLength(1);
    expect(api.tables.invoices).toHaveLength(1);
    expect(api.notifications).toBe(1);
    expect(api.members).toEqual(members);
    expect(JSON.stringify(state)).not.toContain(api.members[0].line_user_id);
    expect(JSON.stringify(state)).not.toContain('unit-test-only-dated-quote');
    expect(JSON.stringify(evidence)).not.toContain(api.members[0].line_user_id);
  });

  it('requires a dated signed quote before creating any demo order or notification', async () => {
    const api = new DemoAPI(), preparation = await prepared(api), before = api.mutations;
    api.signedQuotes = false;
    await expect(verifyDemoWorkflow(api, opts(true), { preparation, state: null, persist: () => {}, skipNotificationWait: true })).rejects.toThrow('no valid confirmation token');
    expect(api.mutations).toBe(before); expect(api.tables.orders).toHaveLength(0); expect(api.notifications).toBe(0);
  });

  it('checks a legacy saved order through result lookup without inventing or replaying its original payload', async () => {
    const api = new DemoAPI(), preparation = await prepared(api); let state: Row | null = null;
    const dependencies = () => ({ preparation, state, persist: (value: Row) => { state = clone(value); }, saveEvidence: () => {}, skipNotificationWait: true });
    await verifyDemoWorkflow(api, opts(true), dependencies());
    delete (state as unknown as Row).idempotent_replay_verified;
    const requests = api.orderInputs.length, mutations = api.mutations;
    const result = await verifyDemoWorkflow(api, opts(true), dependencies());
    expect(result.order_result_lookup_verified).toBe(true); expect(result.idempotent_replay_verified).toBe(false); expect(result.idempotent_replay_this_run).toBe(false);
    expect(api.orderInputs).toHaveLength(requests); expect(api.mutations).toBe(mutations); expect(api.notifications).toBe(1);
  });

  it('refuses ambiguous recipients and missing notification authorization before creating an order', async () => {
    const api = new DemoAPI(), preparation = await prepared(api), writes = api.mutations;
    const dependencies = { preparation, state: null, persist: () => {}, saveEvidence: () => {}, skipNotificationWait: true };
    await expect(verifyDemoWorkflow(api, { ...opts(true), notifyLine: false }, dependencies)).rejects.toThrow('Provide --notify-line');
    api.members.push({ id: 'member-2', line_user_id: 'test-line-user-2', company_id: 'company-a', status: 'active' });
    await expect(verifyDemoWorkflow(api, opts(true), dependencies)).rejects.toThrow('Exactly one active LINE member');
    expect(api.mutations).toBe(writes);
    expect(api.notifications).toBe(0);
  });

  it('retains failure evidence and never retries a failed LINE notification by creating another order', async () => {
    const api = new DemoAPI(), preparation = await prepared(api);
    api.notificationResult = 'failed:http_403:recipient_unavailable';
    let state: Row | null = null, evidence: Row | null = null;
    const dependencies = () => ({ preparation, state, persist: (value: Row) => { state = clone(value); }, saveEvidence: (value: Row) => { evidence = clone(value); }, skipNotificationWait: true });
    await expect(verifyDemoWorkflow(api, opts(true), dependencies())).rejects.toThrow('LINE acceptance was not confirmed');
    await expect(verifyDemoWorkflow(api, opts(true), dependencies())).rejects.toThrow('LINE acceptance was not confirmed');
    expect(api.tables.orders).toHaveLength(1);
    expect(api.tables.invoices).toHaveLength(1);
    expect(api.notifications).toBe(1);
    expect(evidence).toMatchObject({ line_api_accepted: false, duplicate_notification_recorded: false });
  });
});
