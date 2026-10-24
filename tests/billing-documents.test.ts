import { confirmedInput } from './helpers/confirmed-request';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateTestDatabase } from './helpers/migrate';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import type { Actor, Bindings } from '../src/server/types';

class SqliteD1 {
  sqlite = new DatabaseSync(':memory:');
  firstResult?: (sql: string, value: any) => Promise<any>;
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const result = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  binding() { return this as unknown as D1Database; }
}
class Statement {
  constructor(private db: SqliteD1, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.db, this.sql, args); }
  async first() { const value = this.db.sqlite.prepare(this.sql).get(...this.args) || null; return this.db.firstResult ? this.db.firstResult(this.sql, value) : value; }
  async all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args), success: true }; }
  execute() { const result = this.db.sqlite.prepare(this.sql).run(...this.args); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
  async run() { return this.execute(); }
}

const owner: Actor = { id: 'billing-owner', type: 'admin', role: 'owner', name: '帳票管理者' };
const staff: Actor = { id: 'billing-staff', type: 'admin', role: 'staff', name: '帳票担当者' };
const customer: Actor = { id: 'BILLING_CUSTOMER_A', type: 'customer', company_id: 'a', name: '注文担当者' };
const origin = 'https://orders.example';
let db: SqliteD1, env: Bindings, pending: Promise<unknown>[];

beforeEach(() => {
  db = new SqliteD1(); migrateTestDatabase(db.sqlite);
  db.sqlite.exec(`
    INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('billing-owner','billing-owner','unused','帳票管理者','owner'),('billing-staff','billing-staff','unused','帳票担当者','staff');
    INSERT INTO companies(id,name,address) VALUES('a','A商店','変更前の宛先住所'),('b','Bホテル','別企業の宛先住所');
    INSERT INTO line_users(id,company_id,line_user_id,staff_name) VALUES('billing-member','a','BILLING_CUSTOMER_A','注文担当者');
    INSERT INTO products(id,name,category,volume_ml,standard_price,weight_kg) VALUES('billing-product','帳票検証商品','その他',720,1000,1);
    INSERT INTO company_info(id,company_name,display_name,postal_code,address,tel,bank_name,bank_branch_name,bank_account_type,bank_account_number,bank_account_holder)
      VALUES(1,'変更前の発行会社','変更前の発行元','4840000','変更前の発行元住所','0000000000','架空銀行','架空支店','普通','0123456','カクウ');
    INSERT INTO report_settings(id,invoice_title,delivery_note_title,invoice_note_template,delivery_note_template) VALUES(1,'御請求書','納品書','請求の定型備考','納品の定型備考');
    INSERT INTO settings(key,value) VALUES('tax_rate','10'),('tax_calc_unit','invoice'),('tax_rounding','floor'),('shipping_taxable','true');
  `);
  env = { DB: db.binding(), APP_ENV: 'development', ALLOW_DEMO_AUTH: 'false', SESSION_SECRET: 'billing-documents-tests-only-session-key-longer-than-32-characters' } as Bindings;
  pending = [];
});
afterEach(async () => { await Promise.allSettled(pending); vi.useRealTimers(); vi.restoreAllMocks(); db.sqlite.close(); });

function order(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'TEST-O-BILL-' + crypto.randomUUID(), request_id: crypto.randomUUID(), company_id: 'a',
    ordered_by_name: '注文担当者', ordered_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:00.000Z',
    desired_delivery_date: '2099-12-20', status: 'received', snap_recipient_name: 'A商店配送先', snap_postal_code: '4840000', snap_address: '変更前の配送先住所',
    items_subtotal: 1000, shipping_fee: 800, is_shipping_fee_manual: 1, shipping_fee_source: 'manual',
    snap_tax_rate: 10, snap_tax_calc_unit: 'invoice', snap_tax_rounding: 'floor', tax_amount: 180, total_amount: 1980, ...overrides,
  };
  insert('orders', row);
  insert('order_items', { id: crypto.randomUUID(), order_id: row.id, line_no: 1, product_id: 'billing-product', snap_product_name: '発注時の商品名', snap_category: 'その他', snap_volume_ml: 720, snap_unit: '本', unit_price: 1000, quantity: 1, subtotal: 1000 });
  return row;
}
function insert(table: string, value: Record<string, any>) {
  const fields = Object.keys(value); db.sqlite.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...Object.values(value));
}
const saved = (table: string, id: string) => db.sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as any;
const count = (table: string) => Number((db.sqlite.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as any).count);
const histories = (id: string) => db.sqlite.prepare('SELECT * FROM invoice_histories WHERE invoice_id=? ORDER BY version,acted_at,id').all(id) as any[];
async function request(path: string, input?: unknown, who: Actor | null = owner, options: { origin?: string; method?: string } = {}) {
  input = await confirmedInput(options.method || (input === undefined ? 'GET' : 'POST'), '/api/admin' + path, input, async (m,p,b) => {const r=await request(p.slice('/api/admin'.length),b,who,{...options,method:m});return {status:r.status,data:r.body.data};});
  const cookie = who ? 'kojima_session=' + await signSession(who, env) : null;
  const response = await app.request(origin + '/api/admin' + path, {
    method: options.method || (input === undefined ? 'GET' : 'POST'),
    headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: options.origin || origin, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }, env, { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext);
  return { status: response.status, body: await response.json() as any };
}
async function invoice(rows = [order()]) {
  const result = await request('/invoices', { company_id: rows[0].company_id, period_start: '2099-12-01', period_end: '2099-12-31', due_date: '2100-01-31', order_ids: rows.map(row => row.id) });
  expect(result.status).toBe(201); return { invoice: result.body.data, orders: rows };
}
const revision = (version = 1, changes: Record<string, unknown> = { note: '表示だけを変更した備考' }) => ({ version, request_id: crypto.randomUUID(), changes });
const delivery = (id: string, extra: Record<string, unknown> = {}) => request(`/orders/${id}/delivery-notes`, { request_id: crypto.randomUUID(), version: saved('orders', id).version, ...extra });
const expectSuccess = (result: { status: number }) => expect([200, 201]).toContain(result.status);

describe('invoice presentation revisions over authenticated routes', () => {
  it('requires an administrator for both invoice revisions and delivery-note history', async () => {
    const issued = await invoice(); const id = issued.invoice.id, orderId = issued.orders[0].id;
    for (const who of [null, customer]) {
      const expected = who ? 403 : 401;
      expect((await request(`/invoices/${id}/presentation`, revision(), who)).status).toBe(expected);
      expect((await request(`/invoices/${id}/delivery-notes`, undefined, who)).status).toBe(expected);
      expect((await request(`/orders/${orderId}/delivery-notes`, undefined, who)).status).toBe(expected);
      expect((await request(`/orders/${orderId}/delivery-notes`, { request_id: crypto.randomUUID(), version: 2 }, who)).status).toBe(expected);
    }
    expect(histories(id)).toHaveLength(1); expect(count('delivery_note_histories')).toBe(0);
  });

  it('rejects cross-site writes without changing either history or source orders', async () => {
    const issued = await invoice(); const id = issued.invoice.id, orderId = issued.orders[0].id, before = saved('orders', orderId);
    expect((await request(`/invoices/${id}/presentation`, revision(), owner, { origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await request(`/orders/${orderId}/delivery-notes`, { request_id: crypto.randomUUID(), version: before.version }, owner, { origin: 'https://untrusted.example' })).status).toBe(403);
    expect(histories(id)).toHaveLength(1); expect(count('delivery_note_histories')).toBe(0); expect(saved('orders', orderId)).toEqual(before);
  });

  it('creates a new display version while preserving all financial values, source snapshots and locks', async () => {
    const issued = await invoice(); const id = issued.invoice.id, orderId = issued.orders[0].id;
    const beforeOrder = saved('orders', orderId), beforeItems = db.sqlite.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(id), beforeHistory = histories(id)[0];
    db.sqlite.exec("UPDATE settings SET value='33' WHERE key='tax_rate'; UPDATE company_info SET bank_name='変更後の会社マスタ'; UPDATE companies SET address='変更後の取引先マスタ' WHERE id='a'");
    const changes = { recipient_name: 'A商店 経理部', recipient_address: '帳票専用の送付先', title: '請求書（表示確認）', due_date: '2100-02-28', note: '帳票専用の備考', issuer: { display_name: '帳票専用の発行元', bank_name: '帳票専用の架空銀行' } };
    const result = await request(`/invoices/${id}/presentation`, revision(1, changes), staff); expectSuccess(result);
    const current = result.body.data;
    expect(current).toMatchObject({ id, latest_version: 2, due_date: '2100-02-28', note: changes.note, subtotal_excl_tax: 1800, tax_amount: 180, total_incl_tax: 1980 });
    expect(current.snapshot).toMatchObject({ revision_type: 'presentation', version: 2, subtotal_excl_tax: 1800, tax_amount: 180, total_incl_tax: 1980, tax_settings: { tax_rate: '10' } });
    for (const value of [changes.recipient_name, changes.recipient_address, changes.title, changes.note, changes.issuer.display_name, changes.issuer.bank_name]) expect(JSON.stringify(current.snapshot)).toContain(value);
    expect(current.snapshot.orders).toEqual(JSON.parse(beforeHistory.snapshot_json).orders);
    expect(saved('orders', orderId)).toEqual(beforeOrder); expect(db.sqlite.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(id)).toEqual(beforeItems);
    expect(histories(id)).toHaveLength(2); expect(histories(id)[0]).toEqual(beforeHistory);
    const original = await request(`/invoices/${id}/history/${beforeHistory.id}`); expect(original.status).toBe(200); expect(original.body.data.snapshot).toEqual(JSON.parse(beforeHistory.snapshot_json));
  });

  it('rejects financial fields at every input level instead of trusting client totals', async () => {
    const issued = await invoice(); const id = issued.invoice.id, original = saved('invoices', id);
    for (const changes of [{ total_incl_tax: 0 }, { tax_amount: 0 }, { quantity: 5 }, { unit_price: 0 }, { shipping_fee: 0 }, { tax_settings: { tax_rate: '0' } }, { orders: [] }, { items: [] }, { issuer: { tax_rate: 0 } }]) {
      const result = await request(`/invoices/${id}/presentation`, revision(1, changes)); expect(result.status).toBe(400);
    }
    expect((await request(`/invoices/${id}/presentation`, { ...revision(), total_incl_tax: 0 })).status).toBe(400);
    expect(saved('invoices', id)).toEqual(original); expect(histories(id)).toHaveLength(1);
  });

  it('validates dates, lengths and issuer details without adding an invalid version', async () => {
    const issued = await invoice(); const id = issued.invoice.id;
    for (const changes of [{ due_date: '2100-02-30' }, { recipient_name: '' }, { title: 'x'.repeat(1001) }, { issuer: { invoice_reg_no: 'NOT-A-REGISTRATION' } }, { issuer: { bank_account_number: 'ABC' } }]) {
      expect((await request(`/invoices/${id}/presentation`, revision(1, changes))).status).toBe(400);
    }
    expect(histories(id)).toHaveLength(1);
  });

  it('deduplicates the same revision UUID and rejects a changed payload or invoice reuse', async () => {
    const first = await invoice(); const input = revision();
    const result = await request(`/invoices/${first.invoice.id}/presentation`, input); expectSuccess(result);
    const replay = await request(`/invoices/${first.invoice.id}/presentation`, input); expectSuccess(replay);
    expect(replay.body.data.latest_version).toBe(2); expect(histories(first.invoice.id)).toHaveLength(2);
    expect((await request(`/invoices/${first.invoice.id}/presentation`, { ...input, changes: { note: '別の本文' } })).status).toBe(409);
    const second = await invoice([order()]);
    expect((await request(`/invoices/${second.invoice.id}/presentation`, input)).status).toBe(409); expect(histories(second.invoice.id)).toHaveLength(1);
  });

  it('keeps revision retry metadata private and replays a saved revision after later cancellation', async () => {
    const issued = await invoice(), id = issued.invoice.id, input = revision();
    const result = await request(`/invoices/${id}/presentation`, input); expectSuccess(result);
    const stored = histories(id).find(row => row.version === 2);
    for (const row of result.body.data.histories) {
      expect(row).not.toHaveProperty('request_id'); expect(row).not.toHaveProperty('request_hash');
    }
    expect(JSON.stringify(result.body.data)).not.toContain(input.request_id);
    expect(JSON.stringify(result.body.data)).not.toContain(stored.request_hash);
    expect((await request(`/invoices/${id}/cancel`, { reason: '再試行後も履歴を保持' })).status).toBe(200);
    const before = histories(id), replay = await request(`/invoices/${id}/presentation`, input);
    expectSuccess(replay); expect(replay.body.data.presentation_history_id).toBe(stored.id);
    expect(histories(id)).toEqual(before); expect(saved('invoices', id).status).toBe('cancelled');
  });

  it('rejects stale versions and permits only one concurrent revision for the same source version', async () => {
    const issued = await invoice(); const id = issued.invoice.id;
    expect((await request(`/invoices/${id}/presentation`, revision(999))).status).toBe(409);
    const responses = await Promise.all([request(`/invoices/${id}/presentation`, revision(1, { note: '同時編集A' })), request(`/invoices/${id}/presentation`, revision(1, { note: '同時編集B' }))]);
    expect(responses.filter(result => [200, 201].includes(result.status))).toHaveLength(1); expect(responses.filter(result => result.status === 409)).toHaveLength(1);
    expect(saved('invoices', id).latest_version).toBe(2); expect(histories(id)).toHaveLength(2);
  });

  it('does not issue another version when the displayed values are unchanged', async () => {
    const issued = await invoice(); const id = issued.invoice.id, before = saved('invoices', id);
    const result = await request(`/invoices/${id}/presentation`, revision(1, { due_date: '2100-01-31' }));
    expect(result.status).toBe(409); expect(result.body.error.code).toBe('DOCUMENT_UNCHANGED');
    expect(saved('invoices', id)).toEqual(before); expect(histories(id)).toHaveLength(1);
  });

  it('keeps paid status and permits display corrections without unlocking orders', async () => {
    const issued = await invoice(); const id = issued.invoice.id, orderId = issued.orders[0].id;
    db.sqlite.prepare("UPDATE invoices SET status='paid' WHERE id=?").run(id); const before = saved('orders', orderId);
    const result = await request(`/invoices/${id}/presentation`, revision()); expectSuccess(result);
    expect(saved('invoices', id)).toMatchObject({ status: 'paid', latest_version: 2, total_incl_tax: 1980 }); expect(saved('orders', orderId)).toEqual(before);
  });

  it('keeps cancelled invoices read-only and retains their original preview', async () => {
    const issued = await invoice(); const id = issued.invoice.id;
    expect((await request(`/invoices/${id}/cancel`, { reason: '取消の確認' })).status).toBe(200);
    const before = saved('invoices', id), past = histories(id);
    expect((await request(`/invoices/${id}/presentation`, revision())).status).toBe(409);
    expect(saved('invoices', id)).toEqual(before); expect(histories(id)).toEqual(past);
    expect((await request(`/invoices/${id}/history/${past[0].id}`)).body.data.snapshot.total_incl_tax).toBe(1980);
  });

  it('cancels the latest display version and preserves both issued previews', async () => {
    const issued = await invoice(); const id = issued.invoice.id, orderId = issued.orders[0].id;
    expectSuccess(await request(`/invoices/${id}/presentation`, revision(1, { note: '取消前の表示修正' })));
    const corrected = histories(id).find(row => row.version === 2);
    expect((await request(`/invoices/${id}/cancel`, { reason: '表示修正後の取消' })).status).toBe(200);
    expect(saved('invoices', id)).toMatchObject({ status: 'cancelled', latest_version: 2, total_incl_tax: 1980 });
    expect(saved('orders', orderId).is_invoice_locked).toBe(0);
    const all = histories(id); expect(all).toHaveLength(3);
    expect(all.find(row => row.action_type === 'cancel').snapshot_json).toBe(corrected.snapshot_json);
    expect((await request(`/invoices/${id}/history/${corrected.id}`)).body.data.snapshot.invoice.note).toBe('取消前の表示修正');
  });

  it('rolls the display revision back if its audit/history cannot be persisted', async () => {
    const issued = await invoice(); const id = issued.invoice.id, before = saved('invoices', id), history = histories(id);
    db.sqlite.exec("CREATE TRIGGER reject_display_revision BEFORE INSERT ON invoice_histories WHEN NEW.version>1 BEGIN SELECT RAISE(ABORT,'test display history failure'); END");
    const result = await request(`/invoices/${id}/presentation`, revision()); expect(result.status).toBe(500);
    expect(saved('invoices', id)).toEqual(before); expect(histories(id)).toEqual(history);
  });
});

describe('explicit and immutable delivery-note issuance', () => {
  it('does not issue a delivery note when draft or history endpoints are read', async () => {
    const issued = await invoice(); const orderId = issued.orders[0].id, before = saved('orders', orderId);
    expect((await request(`/orders/${orderId}/delivery-note`)).status).toBe(200);
    const history = await request(`/orders/${orderId}/delivery-notes`); expect(history.status).toBe(200); expect(history.body.data.items).toEqual([]);
    const fromInvoice = await request(`/invoices/${issued.invoice.id}/delivery-notes`); expect(fromInvoice.status).toBe(200); expect(fromInvoice.body.data.items).toEqual([]); expect(fromInvoice.body.data.orders.map((row: any) => row.id)).toEqual([orderId]);
    expect(count('delivery_note_histories')).toBe(0); expect(saved('orders', orderId)).toEqual(before);
  });

  it('records a fixed issuance date, issuer, item snapshot and source version without changing financial locks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-23T01:00:00Z'));
    const row = order(), before = saved('orders', row.id);
    const result = await delivery(row.id); expectSuccess(result); const document = result.body.data;
    expect(document).toMatchObject({ order_id: row.id, version: 1, source_order_version: before.version, issued_at: '2026-10-23T01:00:00.000Z' });
    expect(document.snapshot).toMatchObject({ kind: 'delivery-note', issued_date: '2026-10-23', order: { id: row.id, total_amount: 1980 }, issuer: { display_name: '変更前の発行元' } });
    expect(document.snapshot.items).toMatchObject([{ snap_product_name: '発注時の商品名', quantity: 1, unit_price: 1000 }]);
    const after = saved('orders', row.id); expect(after).toEqual({ ...before, delivery_note_issued_at: document.issued_at });
    const savedHistory = saved('delivery_note_histories', document.id);
    db.sqlite.exec("UPDATE company_info SET display_name='変更後の発行元'; UPDATE products SET name='変更後の商品名'; UPDATE report_settings SET delivery_note_title='変更後の納品書'");
    vi.setSystemTime(new Date('2026-10-25T01:00:00Z'));
    const historical = await request(`/orders/${row.id}/delivery-notes/${document.id}`); expect(historical.status).toBe(200); expect(historical.body.data.snapshot).toEqual(document.snapshot);
    expect(saved('delivery_note_histories', document.id)).toEqual(savedHistory);
    const second = await delivery(row.id); expectSuccess(second); expect(second.body.data.version).toBe(2); expect(second.body.data.snapshot.issuer.display_name).toBe('変更後の発行元');
  });

  it('deduplicates a delivery UUID while rejecting changed source or invoice association', async () => {
    const first = order(), second = order(); const input = { request_id: crypto.randomUUID(), version: 1 };
    const result = await request(`/orders/${first.id}/delivery-notes`, input); expectSuccess(result);
    const replay = await request(`/orders/${first.id}/delivery-notes`, input); expectSuccess(replay); expect(replay.body.data.id).toBe(result.body.data.id); expect(count('delivery_note_histories')).toBe(1);
    expect((await request(`/orders/${second.id}/delivery-notes`, input)).status).toBe(409);
    expect((await request(`/orders/${first.id}/delivery-notes`, { ...input, version: 2 })).status).toBe(409);
    expect(count('delivery_note_histories')).toBe(1);
  });

  it('issues only one record for concurrent submissions of the same delivery request', async () => {
    const row = order(), input = { request_id: crypto.randomUUID(), version: 1 };
    const result = await Promise.all([request(`/orders/${row.id}/delivery-notes`, input), request(`/orders/${row.id}/delivery-notes`, input)]);
    result.forEach(expectSuccess); expect(result[0].body.data.id).toBe(result[1].body.data.id);
    expect(count('delivery_note_histories')).toBe(1);
  });

  it('reports a conflict for concurrent distinct delivery requests without an orphan timestamp or audit', async () => {
    const row = order();
    let sourcesRead = 0, release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    db.firstResult = async (sql, value) => {
      if (sql.includes('COALESCE(MAX(version),0)')) { if (++sourcesRead === 2) release(); await ready; }
      return value;
    };
    const result = await Promise.all([delivery(row.id), delivery(row.id)]);
    db.firstResult = undefined;
    expect(result.filter(value => [200, 201].includes(value.status))).toHaveLength(1);
    expect(result.filter(value => value.status === 409)).toHaveLength(1);
    expect(count('delivery_note_histories')).toBe(1);
    const current = db.sqlite.prepare('SELECT * FROM delivery_note_histories').get() as any;
    expect(saved('orders', row.id).delivery_note_issued_at).toBe(current.issued_at);
    expect(db.sqlite.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action='DELIVERY_NOTE_ISSUE'").get()).toMatchObject({count: 1});
  });

  it('replays the original delivery snapshot after its source is cancelled without issuing again', async () => {
    const row = order(), input = { request_id: crypto.randomUUID(), version: 1 };
    const issued = await request(`/orders/${row.id}/delivery-notes`, input); expectSuccess(issued);
    db.sqlite.prepare("UPDATE orders SET status='cancelled',version=version+1 WHERE id=?").run(row.id);
    const before = saved('orders', row.id), replay = await request(`/orders/${row.id}/delivery-notes`, input);
    expectSuccess(replay); expect(replay.body.data).toEqual(issued.body.data);
    expect(saved('orders', row.id)).toEqual(before); expect(count('delivery_note_histories')).toBe(1);
  });

  it('binds invoice delivery histories to actual invoice members and rejects cross-company substitution', async () => {
    const issued = await invoice(); const invoiceId = issued.invoice.id, orderId = issued.orders[0].id, version = saved('orders', orderId).version;
    const foreign = order({ company_id: 'b', snap_recipient_name: 'Bホテル配送先' }), unbilled = order();
    for (const row of [foreign, unbilled]) expect((await delivery(row.id, { invoice_id: invoiceId, invoice_version: 1 })).status).toBe(409);
    expect((await delivery(orderId, { invoice_id: invoiceId, invoice_version: 999 })).status).toBe(409);
    db.sqlite.exec("UPDATE company_info SET display_name='請求後に変更された会社マスタ'; UPDATE report_settings SET delivery_note_title='請求後の新しい表題'");
    const result = await delivery(orderId, { invoice_id: invoiceId, invoice_version: 1 }); expectSuccess(result);
    expect(result.body.data).toMatchObject({ invoice_id: invoiceId, source_invoice_version: 1, source_order_version: version });
    expect(result.body.data.snapshot).toMatchObject({ issuer: { display_name: '変更前の発行元' }, report_settings: { delivery_note_title: '納品書' } });
    const list = await request(`/invoices/${invoiceId}/delivery-notes`); expect(list.status).toBe(200); expect(list.body.data.items.map((row: any) => row.id)).toEqual([result.body.data.id]);
    expect((await request(`/orders/${foreign.id}/delivery-notes/${result.body.data.id}`)).status).toBe(404);
  });

  it('previews the same frozen invoice source that will be issued after current master changes', async () => {
    const issued = await invoice(), id = issued.invoice.id, orderId = issued.orders[0].id;
    db.sqlite.exec("UPDATE company_info SET display_name='新しい会社情報'; UPDATE report_settings SET delivery_note_title='新しい表題'");
    const before = saved('orders', orderId);
    const preview = await request(`/invoices/${id}/delivery-notes/preview?order_id=${encodeURIComponent(orderId)}`);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({kind: 'delivery-note', is_draft: true, invoice_id: id, invoice_version: 1, source_order_version: before.version});
    expect(preview.body.data.issuer.display_name).toBe('変更前の発行元');
    expect(preview.body.data.report_settings.delivery_note_title).toBe('納品書');
    expect(count('delivery_note_histories')).toBe(0); expect(saved('orders', orderId)).toEqual(before);
    const result = await delivery(orderId, {invoice_id: id, invoice_version: 1}); expectSuccess(result);
    for (const field of ['order', 'items', 'issuer', 'report_settings']) expect(result.body.data.snapshot[field]).toEqual(preview.body.data[field]);
    expect(result.body.data).not.toHaveProperty('request_hash'); expect(result.body.data).not.toHaveProperty('request_id');
  });

  it('rejects foreign, missing, cancelled and unauthenticated invoice preview sources', async () => {
    const issued = await invoice(), id = issued.invoice.id, orderId = issued.orders[0].id;
    const foreign = order({company_id: 'b'});
    expect((await request(`/invoices/${id}/delivery-notes/preview?order_id=${foreign.id}`)).status).toBe(409);
    expect((await request(`/invoices/${id}/delivery-notes/preview`)).status).toBe(400);
    expect((await request(`/invoices/${id}/delivery-notes/preview?order_id=${orderId}`, undefined, null)).status).toBe(401);
    expect((await request(`/invoices/${id}/delivery-notes/preview?order_id=${orderId}`, undefined, customer)).status).toBe(403);
    expect((await request(`/invoices/${id}/cancel`, {reason: 'プレビュー対象の取消'})).status).toBe(200);
    expect((await request(`/invoices/${id}/delivery-notes/preview?order_id=${orderId}`)).status).toBe(409);
    expect(count('delivery_note_histories')).toBe(0);
  });

  it('rejects stale or cancelled sources and malicious snapshot fields without issuing a record', async () => {
    const row = order(), cancelled = order({ status: 'cancelled' });
    expect((await request(`/orders/${row.id}/delivery-notes`, { request_id: crypto.randomUUID(), version: 999 })).status).toBe(409);
    expect((await delivery(cancelled.id)).status).toBe(409);
    expect((await request(`/orders/${row.id}/delivery-notes`, { request_id: crypto.randomUUID(), version: 1, snapshot: { total_amount: 0 } })).status).toBe(400);
    const issued = await invoice(); expect((await request(`/invoices/${issued.invoice.id}/cancel`, { reason: '納品書発行停止の確認' })).status).toBe(200);
    expect((await delivery(issued.orders[0].id, { invoice_id: issued.invoice.id, invoice_version: 1 })).status).toBe(409);
    expect(count('delivery_note_histories')).toBe(0);
  });

  it('rolls the issuance timestamp and record back if history persistence fails', async () => {
    const row = order(), before = saved('orders', row.id);
    db.sqlite.exec("CREATE TRIGGER reject_delivery_history BEFORE INSERT ON delivery_note_histories BEGIN SELECT RAISE(ABORT,'test delivery history failure'); END");
    expect((await delivery(row.id)).status).toBe(500);
    expect(saved('orders', row.id)).toEqual(before); expect(count('delivery_note_histories')).toBe(0);
  });
});
