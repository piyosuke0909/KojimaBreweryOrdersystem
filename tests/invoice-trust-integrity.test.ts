import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import { computePricing, type TaxUnit, type TaxRounding } from '../src/domain';
import { resolveOrderTaxPolicy } from '../src/server/services/tax-policy';
import { migrateTestDatabase } from './helpers/migrate';
import type { Bindings } from '../src/server/types';

class SqliteD1 {
  sqlite = new DatabaseSync(':memory:'); beforeBatch: (() => void) | null = null;
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    const hook = this.beforeBatch; this.beforeBatch = null; hook?.(); this.sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  binding() { return this as unknown as D1Database; }
}
class Statement {
  constructor(private db: SqliteD1, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.db, this.sql, args); }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args), success: true }; }
  execute() { const result = this.db.sqlite.prepare(this.sql).run(...this.args); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async run() { return this.execute(); }
}
let db: SqliteD1, env: Bindings;
const owner = { id: 'invoice-trust-owner', type: 'admin' as const, name: '請求確認管理者', role: 'owner' };
beforeEach(() => {
  db = new SqliteD1(); migrateTestDatabase(db.sqlite);
  db.sqlite.exec(`INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('invoice-trust-owner','invoice-trust-owner','unused','請求確認管理者','owner');
    INSERT INTO companies(id,name) VALUES('invoice-trust-company','請求確認商店');
    INSERT INTO products(id,name,category,volume_ml,weight_kg) VALUES('invoice-trust-product','検証商品','検証',720,1);
    INSERT INTO settings(key,value) VALUES('tax_rate','10'),('tax_calc_unit','invoice'),('tax_rounding','floor'),('shipping_taxable','true');`);
  env = { DB: db.binding(), APP_ENV: 'development', SESSION_SECRET: 'invoice-trust-test-session-secret-longer-than-32-characters' } as Bindings;
});
afterEach(() => db.sqlite.close());
function insert(table: string, row: Record<string, any>) {
  const keys = Object.keys(row); db.sqlite.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}
function order(input: Record<string, any> = {}) {
  const { legacy_flag, ...overrides } = input;
  const base = { items_subtotal: 1000, shipping_fee: 800, snap_shipping_taxable: 1, snap_tax_rate: 10, snap_tax_calc_unit: 'invoice', snap_tax_rounding: 'floor', ...overrides };
  const lines = [{ unit_price: base.items_subtotal, quantity: 1 }];
  const totals = computePricing(lines, { tax_rate: base.snap_tax_rate, tax_calc_unit: base.snap_tax_calc_unit as TaxUnit, tax_rounding: base.snap_tax_rounding as TaxRounding, shipping_fee: base.shipping_fee, shipping_taxable: (base.snap_shipping_taxable ?? legacy_flag ?? 1) === 1 });
  const row = { id: 'TEST-O-INVOICE-TRUST-' + crypto.randomUUID(), request_id: crypto.randomUUID(), company_id: 'invoice-trust-company', ordered_by_name: '検証担当者', ordered_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:00.000Z', desired_delivery_date: '2099-12-20', status: 'received', snap_recipient_name: '請求確認商店', snap_postal_code: '4840000', snap_address: '検証用住所', ...totals, ...base, tax_amount: input.tax_amount ?? totals.tax_amount, total_amount: input.total_amount ?? base.items_subtotal + base.shipping_fee + (input.tax_amount ?? totals.tax_amount) };
  const { is_reference_tax: _reference, ...persisted } = row; insert('orders', persisted);
  insert('order_items', { id: crypto.randomUUID(), order_id: row.id, line_no: 1, product_id: 'invoice-trust-product', snap_product_name: '検証商品', snap_category: '検証', snap_volume_ml: 720, snap_unit: '本', unit_price: base.items_subtotal, quantity: 1, subtotal: base.items_subtotal });
  return persisted;
}
const saved = (table: string, id: string) => db.sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as any;
const confirmation = (invoice: any) => ({ expected_version: invoice.latest_version, expected_total: invoice.total_incl_tax, expected_status: invoice.status });
async function request(path: string, input?: unknown) {
  const cookie = 'kojima_session=' + await signSession(owner, env);
  const response = await app.request('https://invoice-trust.example/api/admin' + path, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: 'https://invoice-trust.example', 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }, env);
  return { status: response.status, body: await response.json() as any };
}
async function issue(orders = [order()]) {
  return request('/invoices', { company_id: 'invoice-trust-company', period_start: '2099-12-01', period_end: '2099-12-31', order_ids: orders.map(row => row.id) });
}

describe('invoice action confirmation binds the user-visible revision and amount', () => {
  it('rejects the old payment confirmation after another operation reissues a higher amount', async () => {
    const first = await issue(); expect(first.status).toBe(201); const v1 = first.body.data;
    expect((await request(`/invoices/${v1.id}/cancel`, { ...confirmation(v1), reason: '対象訂正' })).status).toBe(200);
    const replacement = order({ items_subtotal: 2000 });
    const reissued = await request(`/invoices/${v1.id}/reissue`, { ...confirmation(saved('invoices', v1.id)), order_ids: [replacement.id] });
    expect(reissued.status).toBe(200); expect(reissued.body.data.total_incl_tax).toBe(3080);
    const stale = await request(`/invoices/${v1.id}/pay`, confirmation(v1));
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('INVOICE_CONFIRMATION_CHANGED'); expect(saved('invoices', v1.id).status).toBe('issued');
    expect((await request(`/invoices/${v1.id}/pay`, confirmation(reissued.body.data))).status).toBe(200);
  });
  it('requires all expected fields and rejects extra financial overrides without changing the invoice', async () => {
    const issued = (await issue()).body.data;
    for (const input of [{}, { expected_version: 1 }, { ...confirmation(issued), expected_total: -1 }, { ...confirmation(issued), tax_amount: 0 }]) expect((await request(`/invoices/${issued.id}/pay`, input)).status).toBe(400);
    expect(saved('invoices', issued.id).status).toBe('issued');
  });
  it('rejects stale cancellation and stale reissue rather than applying the latest row', async () => {
    const v1 = (await issue()).body.data;
    const cancelled1 = (await request(`/invoices/${v1.id}/cancel`, { ...confirmation(v1), reason: '再発行' })).body.data;
    const v2 = (await request(`/invoices/${v1.id}/reissue`, confirmation(cancelled1))).body.data;
    expect((await request(`/invoices/${v1.id}/cancel`, { ...confirmation(v1), reason: '古い確認' })).status).toBe(409);
    expect((await request(`/invoices/${v1.id}/cancel`, { ...confirmation(v2), reason: '再確認' })).status).toBe(200);
    expect((await request(`/invoices/${v1.id}/reissue`, confirmation(cancelled1))).status).toBe(409);
    expect(saved('invoices', v1.id).latest_version).toBe(2); expect(saved('invoices', v1.id).status).toBe('cancelled');
  });
  it('checks the confirmed amount again in the final transaction', async () => {
    const v1 = (await issue()).body.data;
    db.beforeBatch = () => db.sqlite.prepare('UPDATE invoices SET tax_amount=tax_amount+1,total_incl_tax=total_incl_tax+1 WHERE id=?').run(v1.id);
    const result = await request(`/invoices/${v1.id}/pay`, confirmation(v1)); expect(result.status).toBe(409);
    expect(saved('invoices', v1.id).status).toBe('issued');
    expect(db.sqlite.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action='INVOICE_PAID'").get()).toMatchObject({ count: 0 });
  });
});

describe('invoice taxes use saved order policies', () => {
  it('does not tax historically non-taxable shipping after the current setting becomes taxable', async () => {
    const old = order({ snap_shipping_taxable: 0 }); const result = await issue([old]);
    expect(result.status).toBe(201); expect(result.body.data.total_incl_tax).toBe(1900); expect(result.body.data.tax_amount).toBe(100);
    expect(result.body.data.snapshot.tax_settings).toMatchObject({ source: 'order_snapshots', shipping_taxable: 'false' });
  });
  it('infers a legacy policy only when the saved amount uniquely determines it', async () => {
    const old = order({ snap_shipping_taxable: null, legacy_flag: 0 });
    const result = await issue([old]); expect(result.status).toBe(201); expect(result.body.data.total_incl_tax).toBe(1900);
    expect(result.body.data.snapshot.tax_policies[0]).toMatchObject({ shipping_taxable: false, source: 'inferred' });
    expect(saved('orders', old.id).snap_shipping_taxable).toBeNull();
  });
  it('retains recorded order and item tax even when current mode and rounding differ', async () => {
    db.sqlite.exec("UPDATE settings SET value='ceil' WHERE key='tax_rounding'");
    const old = order({ items_subtotal: 169, shipping_fee: 0, snap_tax_calc_unit: 'order', snap_tax_rounding: 'floor' });
    const result = await issue([old]); expect(result.status).toBe(201); expect(result.body.data.tax_amount).toBe(16); expect(result.body.data.total_incl_tax).toBe(185);
  });
  it('rounds invoice tax once per rate using only the shipping amounts actually taxable', async () => {
    const a = order({ items_subtotal: 14, shipping_fee: 4, snap_shipping_taxable: 0 });
    const b = order({ items_subtotal: 14, shipping_fee: 4, snap_shipping_taxable: 1 });
    const result = await issue([a, b]); expect(result.status).toBe(201); expect(result.body.data.tax_amount).toBe(3); expect(result.body.data.total_incl_tax).toBe(39);
  });
  it('combines saved item/order taxes with independently rounded invoice rates', async () => {
    const item = order({ items_subtotal: 38, shipping_fee: 0, snap_tax_calc_unit: 'item', tax_amount: 2 });
    db.sqlite.prepare('UPDATE order_items SET unit_price=19,subtotal=19 WHERE order_id=?').run(item.id);
    insert('products', { id: 'invoice-second-product', name: '別の検証商品', category: '検証', volume_ml: 720, weight_kg: 1 });
    insert('order_items', { id: crypto.randomUUID(), order_id: item.id, line_no: 2, product_id: 'invoice-second-product', snap_product_name: '別の検証商品', snap_category: '検証', snap_volume_ml: 720, snap_unit: '本', unit_price: 19, quantity: 1, subtotal: 19 });
    const perOrder = order({ items_subtotal: 38, shipping_fee: 0, snap_tax_calc_unit: 'order' });
    const reducedA = order({ items_subtotal: 19, shipping_fee: 0, snap_tax_rate: 8 });
    const reducedB = order({ items_subtotal: 19, shipping_fee: 0, snap_tax_rate: 8 });
    const standard = order({ items_subtotal: 19, shipping_fee: 0 });
    const result = await issue([item, perOrder, reducedA, reducedB, standard]);
    expect(result.status).toBe(201); expect(result.body.data.tax_amount).toBe(9); expect(result.body.data.total_incl_tax).toBe(142);
    expect(result.body.data.snapshot.tax_settings.tax_calc_unit).toBe('mixed');
  });
  it('rejects ambiguous legacy shipping instead of guessing from current settings or splitting rounding', async () => {
    const old = order({ items_subtotal: 100, shipping_fee: 1, snap_shipping_taxable: null, legacy_flag: 0 });
    const result = await issue([old]); expect(result.status).toBe(409); expect(result.body.error.code).toBe('TAX_POLICY_UNKNOWN');
    expect(saved('orders', old.id).is_invoice_locked).toBe(0); expect(db.sqlite.prepare('SELECT COUNT(*) count FROM invoices').get()).toMatchObject({ count: 0 });
  });
  it('rejects an unresolvable historical tax amount without rewriting it', async () => {
    const old = order({ snap_shipping_taxable: null, tax_amount: 999 }); const result = await issue([old]);
    expect(result.status).toBe(409); expect(result.body.error.code).toBe('TAX_POLICY_UNKNOWN'); expect(saved('orders', old.id).tax_amount).toBe(999);
  });
  it('permits neutral free shipping without turning an unknown historical flag into a saved choice', () => {
    const old = order({ shipping_fee: 0, snap_shipping_taxable: null });
    expect(resolveOrderTaxPolicy(old, [{ unit_price: 1000, quantity: 1 }])).toMatchObject({ source: 'neutral' });
    expect(() => resolveOrderTaxPolicy(old, [{ unit_price: 1000, quantity: 1 }], 800)).toThrow(); expect(saved('orders', old.id).snap_shipping_taxable).toBeNull();
  });
  it('requires separate selections for incompatible invoice rounding at the same rate', async () => {
    const a = order({ items_subtotal: 16, shipping_fee: 0, snap_tax_rounding: 'floor' });
    const b = order({ items_subtotal: 16, shipping_fee: 0, snap_tax_rounding: 'ceil' });
    const result = await issue([a, b]); expect(result.status).toBe(409); expect(result.body.error.code).toBe('TAX_POLICY_MIXED_ROUNDING');
    expect(saved('orders', a.id).is_invoice_locked).toBe(0); expect(saved('orders', b.id).is_invoice_locked).toBe(0);
  });
  it('keeps already-issued history and amounts unchanged when current settings change', async () => {
    const issued = (await issue()).body.data, before = db.sqlite.prepare('SELECT snapshot_json FROM invoice_histories WHERE invoice_id=?').get(issued.id);
    db.sqlite.exec("UPDATE settings SET value='false' WHERE key='shipping_taxable';UPDATE settings SET value='ceil' WHERE key='tax_rounding'");
    const result = await request('/invoices/' + issued.id); expect(result.status).toBe(200); expect(result.body.data.total_incl_tax).toBe(1980);
    expect(db.sqlite.prepare('SELECT snapshot_json FROM invoice_histories WHERE invoice_id=?').get(issued.id)).toEqual(before);
  });
});
