import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateTestDatabase } from './helpers/migrate';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import type { Actor, Bindings } from '../src/server/types';

class SqliteD1 {
  sqlite = new DatabaseSync(':memory:');
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
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args), success: true }; }
  execute() { const result = this.db.sqlite.prepare(this.sql).run(...this.args); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
  async run() { return this.execute(); }
}

const admin: Actor = { id: 'order-status-admin', type: 'admin', role: 'owner', name: '管理者' };
const customer: Actor = { id: 'order-status-customer', type: 'customer', company_id: 'a', name: '注文担当者' };
const foreignCustomer: Actor = { id: 'order-status-foreign', type: 'customer', company_id: 'b', name: '別取引先担当者' };
let db: SqliteD1, env: Bindings, pending: Promise<unknown>[];

beforeEach(() => {
  db = new SqliteD1();
  migrateTestDatabase(db.sqlite);
  db.sqlite.exec(`
    INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('order-status-admin','order-status-admin','unused','管理者','owner');
    INSERT INTO companies(id,name) VALUES('a','A商店'),('b','Bホテル');
    INSERT INTO line_users(id,company_id,line_user_id,staff_name,status)
      VALUES('status-user-a','a','order-status-customer','注文担当者','active'),
            ('status-user-b','b','order-status-foreign','別取引先担当者','active');
  `);
  env = { DB: db.binding(), APP_ENV: 'development', ALLOW_DEMO_AUTH: 'false', SESSION_SECRET: 'order-status-tests-only-session-key-longer-than-32-characters' } as Bindings;
  pending = [];
});
afterEach(async () => { await Promise.allSettled(pending); vi.restoreAllMocks(); db.sqlite.close(); });

function order(status = 'received', overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'TEST-O-STATUS-' + crypto.randomUUID(), request_id: crypto.randomUUID(), company_id: 'a',
    ordered_by_name: '注文担当者', ordered_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:00.000Z',
    desired_delivery_date: '2099-12-20', status, snap_recipient_name: 'A商店', snap_postal_code: '4840000', snap_address: '愛知県犬山市検証用住所',
    items_subtotal: 1000, shipping_fee: 800, is_shipping_fee_manual: 1, shipping_fee_source: 'manual',
    snap_tax_rate: 10, snap_tax_calc_unit: 'order', snap_tax_rounding: 'floor', tax_amount: 180, total_amount: 1980,
    ...overrides,
  };
  const fields = Object.keys(row);
  db.sqlite.prepare(`INSERT INTO orders(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...Object.values(row) as any[]);
  return row;
}
function saved(id: string) { return db.sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id) as any; }
function statusAudits() { return db.sqlite.prepare("SELECT * FROM audit_logs WHERE action='ORDER_STATUS_CHANGE'").all() as any[]; }
async function request(path: string, actor: Actor, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const prefix = actor.type === 'admin' ? '/api/admin' : '/api/customer';
  const token = await signSession(actor, env);
  const response = await app.request(`https://orders.example${prefix}${path}`, {
    method, headers: { Cookie: `kojima_session=${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'https://orders.example' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext);
  return { status: response.status, value: await response.json() as any };
}

describe('three-state orders over the actual Hono routes', () => {
  it('presents historical states canonically without rewriting the stored records', async () => {
    for (const [raw, canonical] of [['received', 'received'], ['confirmed', 'received'], ['preparing', 'received'], ['shipped', 'shipped'], ['completed', 'shipped'], ['cancelled', 'cancelled']]) {
      const row = order(raw);
      const result = await request('/orders/' + row.id, admin);
      expect(result.status).toBe(200);
      expect(result.value.data).toMatchObject({ status: canonical, can_edit: canonical === 'received', can_cancel: canonical === 'received' });
      expect(saved(row.id).status).toBe(raw);
    }
  });

  it('filters canonical status groups while keeping company isolation', async () => {
    for (const raw of ['received', 'confirmed', 'preparing', 'shipped', 'completed', 'cancelled']) order(raw);
    order('received', { company_id: 'b' });
    for (const actor of [admin, customer]) {
      const received = await request('/orders?status=received', actor);
      expect(received.status).toBe(200);
      expect(received.value.data).toHaveLength(actor.type === 'admin' ? 4 : 3);
      expect(received.value.data.every((row: any) => row.status === 'received')).toBe(true);
      const shipped = await request('/orders?status=shipped', actor);
      expect(shipped.value.data).toHaveLength(2);
      expect(shipped.value.data.every((row: any) => row.status === 'shipped')).toBe(true);
      const cancelled = await request('/orders?status=cancelled', actor);
      expect(cancelled.value.data).toHaveLength(1);
    }
    const foreign = await request('/orders?status=received', foreignCustomer);
    expect(foreign.value.data).toHaveLength(1);
    expect(foreign.value.data[0].company_id).toBe('b');
  });

  it('lets an administrator ship and correct a shipment while preserving financial snapshots', async () => {
    const row = order();
    const financialKeys = ['items_subtotal', 'shipping_fee', 'shipping_fee_source', 'snap_tax_rate', 'snap_tax_calc_unit', 'snap_tax_rounding', 'tax_amount', 'total_amount'];
    const financial = Object.fromEntries(financialKeys.map(key => [key, saved(row.id)[key]]));
    const shipped = await request(`/orders/${row.id}/status`, admin, { status: 'shipped', version: 1 });
    expect(shipped.status).toBe(200);
    expect(shipped.value.data).toMatchObject({ status: 'shipped', version: 2, can_edit: false, can_cancel: false });
    expect(saved(row.id)).toMatchObject(financial);
    const corrected = await request(`/orders/${row.id}/status`, admin, { status: 'received', version: 2 });
    expect(corrected.status).toBe(200);
    expect(corrected.value.data).toMatchObject({ status: 'received', version: 3, can_edit: true, can_cancel: true });
    expect(saved(row.id)).toMatchObject(financial);
    expect(statusAudits()).toHaveLength(2);
    expect(JSON.parse(statusAudits()[0].after_json)).toMatchObject({ status: 'shipped' });
  });

  it('allows shipping an invoiced order without releasing its financial lock', async () => {
    const row = order('received', { is_invoice_locked: 1 });
    const shipped = await request(`/orders/${row.id}/status`, admin, { status: 'shipped', version: 1 });
    expect(shipped.status).toBe(200);
    expect(shipped.value.data).toMatchObject({ status: 'shipped', is_invoice_locked: 1, can_edit: false, can_cancel: false });
    expect(saved(row.id).total_amount).toBe(1980);
  });

  it('rejects removed intermediate states and never cancels through the status endpoint', async () => {
    const row = order();
    for (const status of ['confirmed', 'preparing', 'completed', 'cancelled', 'other']) {
      const result = await request(`/orders/${row.id}/status`, admin, { status, version: 1 });
      expect(result.status).toBe(409);
      expect(saved(row.id)).toMatchObject({ status: 'received', version: 1 });
    }
    expect(statusAudits()).toHaveLength(0);
  });

  it('keeps cancelled orders terminal and prevents both roles changing shipped contents', async () => {
    for (const status of ['shipped', 'completed', 'cancelled']) {
      const row = order(status);
      for (const actor of [admin, customer]) {
        const detail = await request('/orders/' + row.id, actor);
        expect(detail.value.data).toMatchObject({ can_edit: false, can_cancel: false });
        for (const [suffix, body, method] of [['lock', {}, 'POST'], ['', { version: 1 }, 'PUT'], ['cancel', { version: 1, reason: '検証' }, 'POST']] as const) {
          const result = await request(`/orders/${row.id}${suffix ? '/' + suffix : ''}`, actor, body, method);
          expect(result.status).toBe(409);
          expect(saved(row.id)).toMatchObject({ status, version: 1, total_amount: 1980 });
        }
      }
      if (status === 'cancelled') {
        const result = await request(`/orders/${row.id}/status`, admin, { status: 'received', version: 1 });
        expect(result.status).toBe(409);
        expect(saved(row.id).status).toBe('cancelled');
      }
    }
  });

  it('allows future received orders to be locked and cancelled by their own customer', async () => {
    const row = order();
    const lock = await request(`/orders/${row.id}/lock`, customer, {});
    expect(lock.status).toBe(200);
    expect(saved(row.id).edit_locked_by).toBe(customer.id);
    const cancelled = await request(`/orders/${row.id}/cancel`, customer, { version: 1 });
    expect(cancelled.status).toBe(200);
    expect(cancelled.value.data).toMatchObject({ status: 'cancelled', version: 2, can_edit: false, can_cancel: false });
    expect(saved(row.id).edit_locked_by).toBeNull();
  });

  it('lets customers cancel historical unshipped states through the same guarded operation', async () => {
    for (const status of ['confirmed', 'preparing']) {
      const row = order(status);
      expect((await request(`/orders/${row.id}/lock`, customer, {})).status).toBe(200);
      expect(saved(row.id).status).toBe(status);
      const cancelled = await request(`/orders/${row.id}/cancel`, customer, { version: 1 });
      expect(cancelled.status).toBe(200);
      expect(cancelled.value.data).toMatchObject({ status: 'cancelled', version: 2, can_edit: false, can_cancel: false });
      expect(saved(row.id)).toMatchObject({ status: 'cancelled', total_amount: 1980, edit_locked_by: null });
    }
  });

  it('preserves customer cutoff rules while allowing an administrator to correct a received order', async () => {
    const row = order('received', { desired_delivery_date: '2000-01-10' });
    const customerDetail = await request('/orders/' + row.id, customer);
    expect(customerDetail.value.data).toMatchObject({ can_edit: false, can_cancel: false });
    expect((await request(`/orders/${row.id}/lock`, customer, {})).status).toBe(409);
    expect((await request(`/orders/${row.id}/cancel`, customer, { version: 1 })).status).toBe(409);
    const adminDetail = await request('/orders/' + row.id, admin);
    expect(adminDetail.value.data).toMatchObject({ can_edit: true, can_cancel: true });
    expect((await request(`/orders/${row.id}/cancel`, admin, { version: 1, reason: '管理者による受付取消' })).status).toBe(200);
  });

  it('preserves invoice locks for both customer and administrator edit/cancel actions', async () => {
    const row = order('received', { is_invoice_locked: 1 });
    for (const actor of [admin, customer]) {
      expect((await request('/orders/' + row.id, actor)).value.data).toMatchObject({ can_edit: false, can_cancel: false });
      expect((await request(`/orders/${row.id}/lock`, actor, {})).status).toBe(409);
      expect((await request(`/orders/${row.id}/cancel`, actor, { version: 1, reason: '検証' })).status).toBe(409);
    }
    expect(saved(row.id)).toMatchObject({ status: 'received', is_invoice_locked: 1, version: 1 });
  });

  it('requires administrator cancellation reasons and records a successful dedicated cancellation', async () => {
    const row = order();
    expect((await request(`/orders/${row.id}/cancel`, admin, { version: 1 })).status).toBe(400);
    expect(saved(row.id).status).toBe('received');
    const cancelled = await request(`/orders/${row.id}/cancel`, admin, { version: 1, reason: '取引先からの取消依頼' });
    expect(cancelled.status).toBe(200);
    const audit = db.sqlite.prepare("SELECT * FROM audit_logs WHERE action='ORDER_CANCEL'").get() as any;
    expect(JSON.parse(audit.after_json)).toMatchObject({ status: 'cancelled', reason: '取引先からの取消依頼' });
  });

  it('rejects stale versions and active editors before changing status', async () => {
    const row = order();
    expect((await request(`/orders/${row.id}/status`, admin, { status: 'shipped', version: 2 })).status).toBe(409);
    db.sqlite.prepare("UPDATE orders SET edit_lock_status='locked',edit_locked_by=?,edit_lock_expires_at='2099-12-01T00:00:00.000Z' WHERE id=?").run(customer.id, row.id);
    const locked = await request(`/orders/${row.id}/status`, admin, { status: 'shipped', version: 1 });
    expect(locked.status).toBe(409);
    expect(saved(row.id)).toMatchObject({ status: 'received', version: 1, edit_locked_by: customer.id });
    expect(statusAudits()).toHaveLength(0);
  });

  it('allows only one of two concurrent shipment changes using the same version', async () => {
    const row = order();
    const results = await Promise.all([request(`/orders/${row.id}/status`, admin, { status: 'shipped', version: 1 }), request(`/orders/${row.id}/status`, admin, { status: 'shipped', version: 1 })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(saved(row.id)).toMatchObject({ status: 'shipped', version: 2 });
    expect(statusAudits()).toHaveLength(1);
  });

  it('allows only one winner when shipping and cancellation race for the same received version', async () => {
    const row = order();
    const results = await Promise.all([
      request(`/orders/${row.id}/status`, admin, { status: 'shipped', version: 1 }),
      request(`/orders/${row.id}/cancel`, customer, { version: 1 }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const final = saved(row.id);
    expect(['shipped', 'cancelled']).toContain(final.status);
    expect(final).toMatchObject({ version: 2, total_amount: 1980 });
    const actions = db.sqlite.prepare("SELECT action FROM audit_logs WHERE target_id=? AND action IN ('ORDER_STATUS_CHANGE','ORDER_CANCEL')").all(row.id) as any[];
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe(final.status === 'shipped' ? 'ORDER_STATUS_CHANGE' : 'ORDER_CANCEL');
    expect((await request('/orders/' + row.id, customer)).value.data).toMatchObject({ can_edit: false, can_cancel: false });
  });

  it('rolls back a shipment change when its audit record cannot be saved', async () => {
    const row = order();
    db.sqlite.exec("CREATE TRIGGER fail_order_status_audit BEFORE INSERT ON audit_logs WHEN NEW.action='ORDER_STATUS_CHANGE' BEGIN SELECT RAISE(ABORT,'test-only status audit failure'); END;");
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await request(`/orders/${row.id}/status`, admin, { status: 'shipped', version: 1 });
    expect(result.status).toBe(500);
    expect(saved(row.id)).toMatchObject({ status: 'received', version: 1, total_amount: 1980 });
    expect(statusAudits()).toHaveLength(0);
    expect(log).toHaveBeenCalled();
  });

  it('does not expose status changes to customers or orders to another company', async () => {
    const row = order();
    expect((await request(`/orders/${row.id}/status`, customer, { status: 'shipped', version: 1 })).status).toBe(404);
    for (const [suffix, body] of [['', undefined], ['lock', {}], ['cancel', { version: 1 }]] as const) {
      const result = await request(`/orders/${row.id}${suffix ? '/' + suffix : ''}`, foreignCustomer, body);
      expect(result.status).toBe(404);
    }
    expect(saved(row.id)).toMatchObject({ status: 'received', version: 1 });
  });
});
