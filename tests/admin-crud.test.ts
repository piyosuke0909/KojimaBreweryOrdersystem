import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import { issueInvitation, registerInvitation } from '../src/server/services/invitations';
import { notifyWelcome } from '../src/server/notifications';
import type { Bindings } from '../src/server/types';
import { migrateTestDatabase } from './helpers/migrate';

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

const owner = { id: 'crud-owner', type: 'admin' as const, role: 'owner', name: '管理者' };
let db: SqliteD1, env: Bindings, pending: Promise<unknown>[], ownerCookie: string, customerCookie: string;

beforeEach(async () => {
  db = new SqliteD1();
  migrateTestDatabase(db.sqlite);
  db.sqlite.exec(readFileSync(new URL('../seeds/demo.sql', import.meta.url), 'utf8'));
  db.sqlite.exec("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('crud-owner','crud-owner','unused','管理者','owner'); INSERT INTO line_users(id,company_id,line_user_id,staff_name,status) VALUES('test-user-b','company-b','TEST_LINE_USER_B','B担当者','active');");
  env = { DB: db.binding(), APP_ENV: 'development', ALLOW_DEMO_AUTH: 'false', SESSION_SECRET: 'crud-tests-only-session-secret-longer-than-32-characters' } as Bindings;
  pending = [];
  ownerCookie = `kojima_session=${await signSession(owner, env)}`;
  customerCookie = `kojima_session=${await signSession({ id: 'DEMO_LINE_USER_A', type: 'customer', company_id: 'company-a', name: 'A担当者' }, env)}`;
});
afterEach(async () => { await Promise.allSettled(pending); vi.unstubAllGlobals(); db.sqlite.close(); });

async function request(method: string, path: string, body?: unknown, cookie = ownerCookie) {
  const response = await app.request(`https://orders.example${path}`, {
    method,
    headers: { Origin: 'https://orders.example', ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext);
  const json = await response.json() as any;
  return { status: response.status, data: json.data, error: json.error, json };
}
async function ok(method: string, path: string, body?: unknown, cookie = ownerCookie) {
  const result = await request(method, path, body, cookie);
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.json)}`).toBeGreaterThanOrEqual(200);
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.json)}`).toBeLessThan(300);
  return result.data;
}
async function orderInput(extra: Record<string, unknown> = {}) {
  const dates = await ok('GET', '/api/customer/delivery-dates?shipping_address_id=address-a', undefined, customerCookie);
  return { request_id: crypto.randomUUID(), company_id: 'company-a', shipping_address_id: 'address-a', desired_delivery_date: dates[0], items: [{ product_id: 'samurai-300', quantity: 2 }], note: 'CRUD回帰テスト', ...extra };
}

describe('administrative deletion with real routes and transactional SQLite', () => {
  it('rejects anonymous and customer deletion without changing data', async () => {
    expect((await request('DELETE', '/api/admin/products/samurai-300', undefined, '')).status).toBe(401);
    expect((await request('DELETE', '/api/admin/products/samurai-300', undefined, customerCookie)).status).toBe(403);
    expect(db.sqlite.prepare('SELECT sales_status,deleted_at FROM products WHERE id=?').get('samurai-300')).toMatchObject({ sales_status: 'on_sale', deleted_at: null });
  });

  it('deletes an invitation from lists and stops registration while preserving existing LINE members and usage', async () => {
    const invitation = await issueInvitation(db.binding(), owner, 'company-a', { max_uses: 3 }, 'https://orders.example');
    await registerInvitation(db.binding(), { sub: 'LINKED_THROUGH_DELETED_QR', name: '招待経由の本人' }, invitation.token, '招待担当者');
    const memberCookie = `kojima_session=${await signSession({ id: 'LINKED_THROUGH_DELETED_QR', type: 'customer', company_id: 'company-a', name: '招待担当者' }, env)}`;
    const deleted = await ok('DELETE', `/api/admin/companies/company-a/invitations/${invitation.id}`);
    expect(deleted).toMatchObject({ deleted: true, mode: 'soft_deleted' });
    const stored = db.sqlite.prepare('SELECT status,used_count,deleted_at FROM invitations WHERE id=?').get(invitation.id);
    expect(stored).toMatchObject({ status: 'revoked', used_count: 1, deleted_at: expect.any(String) });
    expect((await ok('GET', '/api/admin/companies/company-a/invitations')).some((row: any) => row.id === invitation.id)).toBe(false);
    expect((await request('GET', `/api/public/invitations/lookup?t=${invitation.token}`, undefined, '')).status).toBe(410);
    await expect(registerInvitation(db.binding(), { sub: 'NEW_USER_AFTER_QR_DELETE' }, invitation.token, '新担当者')).rejects.toMatchObject({ status: 410 });
    expect((await ok('GET', '/api/auth/me', undefined, memberCookie)).actor).toMatchObject({ id: 'LINKED_THROUGH_DELETED_QR', company_id: 'company-a' });
    expect(db.sqlite.prepare('SELECT status,invitation_id FROM line_users WHERE line_user_id=?').get('LINKED_THROUGH_DELETED_QR')).toMatchObject({ status: 'active', invitation_id: invitation.id });
    expect(db.sqlite.prepare("SELECT count(*) count FROM audit_logs WHERE target_id=? AND action LIKE '%DELETE%'").get(invitation.id)).toMatchObject({ count: 1 });
  });

  it('preserves a deleted product and historic order snapshots but excludes it from new catalogs and quotes', async () => {
    const before = await ok('GET', '/api/admin/orders/O202610190001/delivery-note');
    await ok('DELETE', '/api/admin/products/samurai-300');
    expect(db.sqlite.prepare('SELECT deleted_at FROM products WHERE id=?').get('samurai-300')).toMatchObject({ deleted_at: expect.any(String) });
    expect((await ok('GET', '/api/admin/products?page_size=1000')).some((row: any) => row.id === 'samurai-300')).toBe(false);
    expect((await ok('GET', '/api/customer/catalog', undefined, customerCookie)).some((row: any) => row.id === 'samurai-300')).toBe(false);
    const rejected = await request('POST', '/api/admin/orders/quote', await orderInput());
    expect(rejected.status).toBe(422);
    const after = await ok('GET', '/api/admin/orders/O202610190001/delivery-note');
    expect(after.order.items).toEqual(before.order.items);
    expect(after.order.total_amount).toBe(before.order.total_amount);
  });

  it('checks ownership of child records and removes a deleted address from new delivery selections', async () => {
    expect((await request('DELETE', '/api/admin/companies/company-b/addresses/address-a')).status).toBe(404);
    const before = await ok('GET', '/api/admin/orders/O202610190001');
    await ok('DELETE', '/api/admin/companies/company-a/addresses/address-a');
    expect((await ok('GET', '/api/customer/addresses', undefined, customerCookie)).some((row: any) => row.id === 'address-a')).toBe(false);
    expect((await request('GET', '/api/customer/delivery-dates?shipping_address_id=address-a', undefined, customerCookie)).status).toBe(404);
    const historical = await ok('GET', '/api/admin/orders/O202610190001');
    expect(historical.snap_address).toBe(before.snap_address);
    expect(historical.shipping_address_id).toBe('address-a');
  });

  it('removes a company from operations and rejects its customer session without breaking historical delivery documents', async () => {
    const before = await ok('GET', '/api/admin/orders/O202610190001/delivery-note');
    await ok('DELETE', '/api/admin/companies/company-a');
    expect((await ok('GET', '/api/admin/companies?page_size=1000')).some((row: any) => row.id === 'company-a')).toBe(false);
    expect((await request('GET', '/api/auth/me', undefined, customerCookie)).status).toBe(401);
    const after = await ok('GET', '/api/admin/orders/O202610190001/delivery-note');
    expect(after.order.snap_address).toBe(before.order.snap_address);
    expect(after.order.items).toEqual(before.order.items);
    expect(db.sqlite.prepare('SELECT deleted_at FROM companies WHERE id=?').get('company-a')).toMatchObject({ deleted_at: expect.any(String) });
  });

  it.each([
    ['shipping-rules', 'shipping_rules', 'RULE_AREA_A', 'id'],
    ['boxes', 'packaging_boxes', 'small-1', 'id'],
    ['sizes', 'yamato_sizes', '60', 'size_code'],
    ['rates', 'yamato_rates', 'first-seeded-row', 'id'],
    ['calendar', 'delivery_calendar', 'first-seeded-row', 'date'],
  ])('soft-deletes %s without removing its database identity', async (path, table, id, key) => {
    const recordId = id === 'first-seeded-row' ? String((db.sqlite.prepare(`SELECT ${key} FROM ${table} ORDER BY ${key} LIMIT 1`).get() as any)[key]) : id;
    await ok('DELETE', `/api/admin/${path}/${recordId}`);
    expect((await ok('GET', `/api/admin/${path}?page_size=1000`)).some((row: any) => String(row[key]) === recordId)).toBe(false);
    expect(db.sqlite.prepare(`SELECT deleted_at FROM ${table} WHERE ${key}=?`).get(recordId)).toMatchObject({ deleted_at: expect.any(String) });
  });

  it('preserves contract and price history while excluding deleted records from company detail and new pricing', async () => {
    expect((await request('DELETE', '/api/admin/companies/company-b/contracts/contract-a')).status).toBe(404);
    expect((await request('DELETE', '/api/admin/companies/company-b/prices/price-a-samurai-300')).status).toBe(404);
    await ok('DELETE', '/api/admin/companies/company-a/contracts/contract-a');
    await ok('DELETE', '/api/admin/companies/company-a/prices/price-a-samurai-300');
    const company = await ok('GET', '/api/admin/companies/company-a');
    expect(company.contracts.some((row: any) => row.id === 'contract-a')).toBe(false);
    expect(company.prices.some((row: any) => row.id === 'price-a-samurai-300')).toBe(false);
    const quoted = await ok('POST', '/api/admin/orders/quote', await orderInput());
    expect(quoted.items[0].unit_price).toBe(2500);
    const historical = await ok('GET', '/api/admin/orders/O202610190001');
    expect(historical.contract_id).toBe('contract-a');
    expect(historical.items[0].unit_price).toBe(2100);
  });
});

describe('administrative demo order notification boundaries', () => {
  it.each([
    [400, 'The property to is invalid', 'failed:http_400:invalid_recipient'],
    [429, 'Monthly message quota exceeded', 'failed:http_429:monthly_quota_exceeded'],
  ])('records a safe LINE failure category for HTTP %s without reflecting identities or credentials', async (status, message, category) => {
    const recipient = 'TEST_PRIVATE_LINE_RECIPIENT';
    const token = 'mock-notification-channel-access-token';
    env.APP_ENV = 'production';
    env.LINE_CHANNEL_ACCESS_TOKEN = token;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: `${message}; recipient=${recipient}; credential=${token}` }), { status, headers: { 'Content-Type': 'application/json' } })));
    expect(await notifyWelcome(env, recipient, '通知担当者')).toMatchObject({ status: 'failed', channels: [] });
    const logged = db.sqlite.prepare("SELECT target_id,note,before_json,after_json FROM audit_logs WHERE action='NOTIFICATION_WELCOME'").get();
    expect(logged).toMatchObject({ target_id: 'line-registration', note: category });
    expect(JSON.stringify(logged)).not.toContain(recipient);
    expect(JSON.stringify(logged)).not.toContain(token);
    expect(JSON.stringify(logged)).not.toContain(String(message));
  });

  it('rejects another company notification recipient before creating an order or sending notifications', async () => {
    const input = await orderInput({ ordered_by_line_user_id: 'TEST_LINE_USER_B', is_test_order: true });
    const before = Number((db.sqlite.prepare('SELECT count(*) count FROM orders').get() as any).count);
    const external = vi.fn(() => { throw new Error('No external request expected'); });
    vi.stubGlobal('fetch', external);
    const result = await request('POST', '/api/admin/orders', input);
    expect(result.status).toBe(422);
    expect(Number((db.sqlite.prepare('SELECT count(*) count FROM orders').get() as any).count)).toBe(before);
    expect(external).not.toHaveBeenCalled();
  });

  it('records an admin demo order, sends one clearly marked LINE test message, suppresses email, and does not resend on retry', async () => {
    const input = await orderInput({ ordered_by_line_user_id: 'DEMO_LINE_USER_A', is_test_order: true });
    env.APP_ENV = 'production';
    env.LINE_CHANNEL_ACCESS_TOKEN = 'mock-notification-channel-access-token';
    env.NOTIFICATION_EMAIL_API_KEY = 'mock-email-provider-key';
    env.NOTIFICATION_FROM = 'test@example.com';
    const pushes: any[] = [], emails: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === 'https://api.line.me/v2/bot/message/push') { pushes.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 200 }); }
      if (target === 'https://api.resend.com/emails') { emails.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 200 }); }
      throw new Error('Unexpected external operation');
    }));
    const first = await request('POST', '/api/admin/orders', input);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.data.id).toMatch(/^TEST-O/);
    expect(first.data.ordered_by_line_user_id).toBe('DEMO_LINE_USER_A');
    const second = await request('POST', '/api/admin/orders', input);
    expect(second.status).toBe(200);
    expect(second.data.id).toBe(first.data.id);
    await Promise.all(pending);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].to).toBe('DEMO_LINE_USER_A');
    expect(pushes[0].messages[0].text).toMatch(/デモ|動作確認/);
    expect(emails).toHaveLength(0);
    expect(db.sqlite.prepare("SELECT actor_type,actor_id FROM audit_logs WHERE action='ORDER_CREATE' AND target_id=?").get(first.data.id)).toMatchObject({ actor_type: 'admin', actor_id: owner.id });
    expect(db.sqlite.prepare("SELECT note FROM audit_logs WHERE action='NOTIFICATION_ORDER_CREATE' AND target_id=?").get(first.data.id)).toMatchObject({ note: 'sent' });
  });
});
