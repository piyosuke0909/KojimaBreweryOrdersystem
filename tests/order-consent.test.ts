import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import type { Actor, Bindings } from '../src/server/types';
import { migrateTestDatabase } from './helpers/migrate';
import { jstDate } from '../src/domain';

class SqliteD1 {
  sqlite = new DatabaseSync(':memory:');
  queryCount = 0;
  beforeBatch: (() => void | Promise<void>) | null = null;
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    const hook = this.beforeBatch; this.beforeBatch = null; await hook?.();
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const result = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  binding() { return this as unknown as D1Database; }
}
class Statement {
  constructor(private db: SqliteD1, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.db, this.sql, args); }
  async first(column?: string) { this.db.queryCount++; const row = this.db.sqlite.prepare(this.sql).get(...this.args); return column ? row?.[column] ?? null : row ?? null; }
  async all() { this.db.queryCount++; return { results: this.db.sqlite.prepare(this.sql).all(...this.args), success: true }; }
  execute() {
    this.db.queryCount++;
    const statement = this.db.sqlite.prepare(this.sql), result = statement.columns().length ? statement.all(...this.args) : statement.run(...this.args);
    return { success: true, results: Array.isArray(result) ? result : [], meta: { changes: Number((this.db.sqlite.prepare('SELECT changes() AS n').get() as any).n) } };
  }
  async run() { return this.execute(); }
}
const origin = 'https://order-consent.example';
const owner: Actor = { id: 'consent-owner', type: 'admin', name: '管理者', role: 'owner' };
const customer: Actor = { id: 'DEMO_LINE_USER_A', type: 'customer', name: '担当者' };
const second: Actor = { id: 'CONSENT_SECOND_CUSTOMER', type: 'customer', name: '別担当者' };
const foreign: Actor = { id: 'CONSENT_FOREIGN_CUSTOMER', type: 'customer', name: '別取引先' };
let db: SqliteD1, env: Bindings, pending: Promise<unknown>[], seedIds:Set<string>;
beforeEach(() => {
  db = new SqliteD1(); migrateTestDatabase(db.sqlite); db.sqlite.exec(readFileSync('seeds/demo.sql', 'utf8'));
  db.sqlite.exec("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('consent-owner','consent-owner','unused','管理者','owner');INSERT INTO line_users(id,company_id,line_user_id,staff_name) VALUES('consent-second-member','company-a','CONSENT_SECOND_CUSTOMER','別担当者'),('consent-foreign-member','company-b','CONSENT_FOREIGN_CUSTOMER','別取引先');");
  seedIds=new Set((db.sqlite.prepare('SELECT id FROM orders').all() as any[]).map(row=>row.id));
  env = { DB: db.binding(), APP_ENV: 'development', ALLOW_DEMO_AUTH: 'false', SESSION_SECRET: 'isolated-order-consent-signing-key-longer-than-32' } as Bindings;
  pending = [];
});
afterEach(async () => { await Promise.allSettled(pending); vi.useRealTimers(); vi.unstubAllGlobals(); db.sqlite.close(); });
async function request(who: Actor, path: string, input?: any, method = input === undefined ? 'GET' : 'POST') {
  const prefix = who.type === 'admin' ? '/api/admin' : '/api/customer';
  const cookie = 'kojima_session=' + await signSession(who, env);
  const response = await app.request(origin + prefix + path, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }, env,
    { waitUntil: (task: Promise<unknown>) => {pending.push(task);}, passThroughOnException() {} } as unknown as ExecutionContext);
  const body = await response.json() as any;
  await Promise.allSettled(pending.splice(0));
  return { status: response.status, data: body.data, error: body.error };
}
async function input(who: Actor = customer) {
  const admin = who.type === 'admin';
  const dates = await request(customer, '/delivery-dates?shipping_address_id=address-a');
  expect(dates.status).toBe(200);
  return { ...(admin ? { company_id: 'company-a' } : {}), request_id: crypto.randomUUID(), shipping_address_id: 'address-a', desired_delivery_date: dates.data[0], items: [{ product_id: 'samurai-300', quantity: 1 }], note: '確認した注文' };
}
async function quoted(who: Actor, value: any) {
  const response = await request(who, '/quote', value);
  expect(response.status, JSON.stringify(response.error)).toBe(200);
  return { ...value, quote_token: response.data.quote_token };
}
const orders = () => (db.sqlite.prepare('SELECT * FROM orders').all() as any[]).filter(row=>!seedIds.has(row.id));
const receipt = (id: string) => db.sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id) as any;
async function updatePrice(price: number) {
  const result = await request(owner, '/companies/company-a/prices', { product_id: 'samurai-300', unit_price: price, is_available: 1, valid_from: jstDate(new Date()) });
  expect(result.status).toBe(201);
}

describe('explicit agreement to a stable server quote', () => {
  it('requires a signed quote and returns canonical line prices with a bounded expiry', async () => {
    const value = await input(), quote = await request(customer, '/quote', value);
    expect(quote.data).toMatchObject({ items_subtotal: 2100, total_amount: 2310 });
    expect(quote.data.items[0]).toMatchObject({ product_id: 'samurai-300', unit_price: 2100, subtotal: 2100 });
    expect(Date.parse(quote.data.quote_expires_at) - Date.now()).toBeGreaterThan(590000);
    expect((await request(customer, '/orders', value)).error.code).toBe('QUOTE_CHANGED');
    expect(orders()).toHaveLength(0);
    const saved = await request(customer, '/orders', { ...value, quote_token: quote.data.quote_token });
    expect(saved.status).toBe(201); expect(saved.data.total_amount).toBe(2310);
    expect(saved.data.snap_shipping_taxable).toBe(1); expect(saved.data).not.toHaveProperty('request_hash');
    expect(receipt(saved.data.id).request_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('does not issue consent before a delivery date has been chosen', async () => {
    const value = await input(); delete (value as any).desired_delivery_date;
    const response = await request(customer, '/quote', value);
    expect(response.status).toBe(200); expect(response.data.quote_token).toBeNull(); expect(response.data.quote_expires_at).toBeNull();
  });
  it('requires explicit re-confirmation when a company price changes after the displayed quote', async () => {
    const value = await quoted(customer, await input()); await updatePrice(4200);
    const stale = await request(customer, '/orders', value);
    expect(stale.status).toBe(409); expect(stale.error.code).toBe('QUOTE_CHANGED'); expect(orders()).toHaveLength(0);
    const refreshed = await quoted(customer, value), saved = await request(customer, '/orders', refreshed);
    expect(saved.status).toBe(201); expect(saved.data.total_amount).toBe(4620);
  });
  it('rejects altered tokens and another person borrowing a same-company quote', async () => {
    const value = await quoted(customer, await input());
    expect((await request(customer, '/orders', { ...value, quote_token: value.quote_token + 'x' })).error.code).toBe('QUOTE_CHANGED');
    expect((await request(second, '/orders', value)).error.code).toBe('QUOTE_CHANGED'); expect(orders()).toHaveLength(0);
  });
  it('rejects expired consent without creating an order', async () => {
    const value = await quoted(customer, await input()); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 601000);
    const result = await request(customer, '/orders', value);
    expect(result.status).toBe(409); expect(result.error.code).toBe('QUOTE_CHANGED'); expect(orders()).toHaveLength(0);
  });
  it('rejects changed delivery snapshots even when the numerical total happens to match', async () => {
    const value = await quoted(customer, await input());
    db.sqlite.exec("UPDATE shipping_addresses SET address_line1='変更された住所';UPDATE system_state SET data_revision=data_revision+1;");
    const result = await request(customer, '/orders', value); expect(result.error.code).toBe('QUOTE_CHANGED'); expect(orders()).toHaveLength(0);
  });
  it('allows an unrelated completed setting change when the confirmed financial conditions still match', async () => {
    const value = await quoted(customer, await input());
    db.sqlite.exec("UPDATE settings SET value='問い合わせ先の変更' WHERE key='contact_hours';UPDATE system_state SET data_revision=data_revision+1;");
    expect((await request(customer, '/orders', value)).status).toBe(201);
  });
  it('rolls back when a real master update wins after the last quote read but before its transaction', async () => {
    const value = await quoted(customer, await input());
    db.beforeBatch = () => updatePrice(4200);
    const result = await request(customer, '/orders', value);
    expect(result.status).toBe(409); expect(result.error.code).toBe('QUOTE_CHANGED'); expect(orders()).toHaveLength(0);
  });
  it('enforces expiry using the database clock at commit, not an earlier request timestamp', async () => {
    const value = await input(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() - 599000);
    const signed = await quoted(customer, value); vi.useRealTimers();
    db.beforeBatch = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); };
    const result = await request(customer, '/orders', signed);
    expect(result.status).toBe(409); expect(result.error.code).toBe('QUOTE_CHANGED'); expect(orders()).toHaveLength(0);
  });
  it('fits a complete customer commit and its disabled-provider notification within D1 Free query limits', async () => {
    const value = await quoted(customer, await input()); db.queryCount = 0;
    const result = await request(customer, '/orders', value);
    expect(result.status).toBe(201); expect(db.queryCount).toBeLessThanOrEqual(50);
  });
  it('fits production creation plus one successful LINE push and disabled Gmail within the full query budget', async () => {
    env.APP_ENV='production'; env.LINE_CHANNEL_ACCESS_TOKEN='isolated-query-budget-line-token';
    db.sqlite.prepare("INSERT INTO email_notification_config(id,provider,enabled,app_origin,updated_at) VALUES(1,'gmail',0,?,?)").run(origin,new Date().toISOString());
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      expect(String(input)).toBe('https://api.line.me/v2/bot/message/push');
      expect(init?.method).toBe('POST');
      const body=JSON.parse(String(init?.body));expect(body.to).toBe(customer.id);expect(body.messages).toHaveLength(1);
      return Response.json({sentMessages:[{id:'isolated-query-budget-message'}]});
    });
    vi.stubGlobal('fetch',fetcher);
    const value=await quoted(customer,await input());db.queryCount=0;
    // request() awaits every waitUntil promise, so leases, provider checkpoints,
    // disabled-mail lookup, delivery audit and lease cleanup are all counted.
    const result=await request(customer,'/orders',value),queries=db.queryCount;
    expect(result.status).toBe(201);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.sqlite.prepare("SELECT note FROM audit_logs WHERE action='NOTIFICATION_ORDER_CREATE' AND target_id=?").get(result.data.id)).toMatchObject({note:'sent'});
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM system_task_leases').get()).toMatchObject({n:0});
    expect(queries).toBeLessThanOrEqual(50);console.log(JSON.stringify({production_like_order_queries:queries,line_pushes:1,gmail_enabled:false}));
  });
});

describe('order intent survives retries without accepting another payload', () => {
  it('returns the original order for an identical retry even after quote expiry', async () => {
    const value = await quoted(customer, await input()), first = await request(customer, '/orders', value);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 601000);
    const second = await request(customer, '/orders', value);
    expect(second.status).toBe(200); expect(second.data.id).toBe(first.data.id); expect(orders()).toHaveLength(1);
  });
  it('rejects changed quantities or notes for the same UUID and exposes an authorized recovery lookup', async () => {
    const value = await quoted(customer, await input()), first = await request(customer, '/orders', value);
    for (const changed of [{ ...value, items: [{ product_id: 'samurai-300', quantity: 2 }] }, { ...value, note: '違う注文内容' }]) {
      const result = await request(customer, '/orders', changed); expect(result.status).toBe(409); expect(result.error.code).toBe('REQUEST_CONTENT_CHANGED');
    }
    const recovered = await request(customer, '/order-requests/' + value.request_id);
    expect(recovered.data).toMatchObject({ processed: true, order: { id: first.data.id, total_amount: 2310 } }); expect(recovered.data.order).not.toHaveProperty('request_hash');
    expect((await request(foreign, '/order-requests/' + value.request_id)).data).toEqual({ processed: false, order: null });
    expect((await request(customer, '/order-requests/' + crypto.randomUUID())).data).toEqual({ processed: false, order: null });
  });
  it('normalizes harmless note whitespace and excludes a refreshed quote from the request digest', async () => {
    const value = await quoted(customer, await input()), first = await request(customer, '/orders', value);
    const response = await request(customer, '/orders', { ...value, note: '  確認した注文  ', quote_token: 'expired-or-lost-token' });
    expect(response.status).toBe(200); expect(response.data.id).toBe(first.data.id);
  });
  it('does not guess the original intent of a legacy order with no request hash', async () => {
    const value = await quoted(customer, await input()), first = await request(customer, '/orders', value);
    db.sqlite.prepare('UPDATE orders SET request_hash=NULL WHERE id=?').run(first.data.id);
    const response = await request(customer, '/orders', value);
    expect(response.status).toBe(409); expect(response.error.code).toBe('REQUEST_RESULT_UNVERIFIABLE');
    expect((await request(customer, '/order-requests/' + value.request_id)).data.order.id).toBe(first.data.id); expect(orders()).toHaveLength(1);
  });
  it('recovers an identical concurrent winner before reporting a stale revision', async () => {
    const value = await quoted(customer, await input()); let winner: any;
    db.beforeBatch = async () => { winner = await request(customer, '/orders', value); };
    const result = await request(customer, '/orders', value);
    expect(winner.status).toBe(201); expect(result.status).toBe(200); expect(result.data.id).toBe(winner.data.id); expect(orders()).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='ORDER_CREATE'").get()).toMatchObject({ n: 1 });
  });
  it('rejects a different concurrent winner rather than returning its order as matching intent', async () => {
    const value = await quoted(customer, await input());
    const changed = await quoted(customer, { ...value, items: [{ product_id: 'samurai-300', quantity: 2 }] });
    db.beforeBatch = async () => { expect((await request(customer, '/orders', changed)).status).toBe(201); };
    const result = await request(customer, '/orders', value);
    expect(result.status).toBe(409); expect(result.error.code).toBe('REQUEST_CONTENT_CHANGED'); expect(orders()).toHaveLength(1); expect(orders()[0].items_subtotal).toBe(4200);
  });
});

describe('editing preserves the ordered tax treatment', () => {
  it.each([false, true])('keeps a %s shipping-tax snapshot when current settings change and only a note is edited', async taxable => {
    await request(owner, '/settings', { packing_enabled: 'false', manual_shipping_fee: '1000', shipping_taxable: String(taxable) }, 'PUT');
    const value = { ...await input(owner), company_id: 'company-b', shipping_address_id: 'address-b' };
    const first = await request(owner, '/orders', await quoted(owner, value)); expect(first.status).toBe(201);
    await request(owner, '/settings', { shipping_taxable: String(!taxable) }, 'PUT');
    await request(owner, `/orders/${first.data.id}/lock`, {});
    const edit = await quoted(owner, { ...value, order_id: first.data.id, version: first.data.version, note: '備考だけ変更' });
    const saved = await request(owner, '/orders/' + first.data.id, edit, 'PUT');
    expect(saved.status).toBe(200); expect(saved.data.total_amount).toBe(first.data.total_amount); expect(saved.data.snap_shipping_taxable).toBe(taxable ? 1 : 0);
  });
  it('can infer an unambiguous legacy shipping-tax policy without using current settings', async () => {
    await request(owner, '/settings', { packing_enabled: 'false', manual_shipping_fee: '1000', shipping_taxable: 'true' }, 'PUT');
    const value = { ...await input(owner), company_id: 'company-b', shipping_address_id: 'address-b' };
    const first = await request(owner, '/orders', await quoted(owner, value)); expect(first.status).toBe(201);
    db.sqlite.prepare('UPDATE orders SET snap_shipping_taxable=NULL WHERE id=?').run(first.data.id);
    await request(owner, '/settings', { shipping_taxable: 'false' }, 'PUT'); await request(owner, `/orders/${first.data.id}/lock`, {});
    const edit = await quoted(owner, { ...value, order_id: first.data.id, version: 1 });
    const saved = await request(owner, '/orders/' + first.data.id, edit, 'PUT');
    expect(saved.status).toBe(200); expect(saved.data.total_amount).toBe(3630); expect(saved.data.snap_shipping_taxable).toBe(1);
  });
  it('rejects a stale edit agreement after price-affecting shipping changes, preserving the saved order', async () => {
    const value = await input(owner), first = await request(owner, '/orders', await quoted(owner, value));
    await request(owner, `/orders/${first.data.id}/lock`, {});
    const edit = await quoted(owner, { ...value, order_id: first.data.id, version: 1, shipping_fee: 100 });
    const saved = await request(owner, '/orders/' + first.data.id, { ...edit, shipping_fee: 200 }, 'PUT');
    expect(saved.status).toBe(409); expect(saved.error.code).toBe('QUOTE_CHANGED'); expect(receipt(first.data.id).total_amount).toBe(first.data.total_amount); expect(receipt(first.data.id).version).toBe(1);
  });
});
