import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import { notifyOrder } from '../src/server/notifications';
import type { Actor, Bindings } from '../src/server/types';
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
const origin = 'https://orders.example';
const owner: Actor = { id: 'mail-owner', name: 'オーナー', type: 'admin', role: 'owner' };
const otherOwner: Actor = { ...owner, id: 'mail-other-owner' };
const staff: Actor = { ...owner, id: 'mail-staff', role: 'staff' };
const clientId = 'mail-test-client.apps.googleusercontent.com';
const clientSecret = 'test-google-client-secret-do-not-return';
const refreshToken = 'test-google-refresh-token-do-not-return';
const accessToken = 'test-google-access-token-do-not-return';
const sender = 'brewery@example.com';
const recipients = ['orders@example.com', 'shipping@example.com'];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let db: SqliteD1, env: Bindings, pending: Promise<unknown>[], ownerCookie: string, otherOwnerCookie: string, staffCookie: string;
let providerCalls: { url: URL; init?: RequestInit }[], gmailRaw: string[], providerFailure: 'none' | 'token' | 'send', omitRefresh: boolean;

beforeEach(async () => {
  db = new SqliteD1(); migrateTestDatabase(db.sqlite);
  db.sqlite.exec("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('mail-owner','mail-owner','unused','オーナー','owner'),('mail-other-owner','mail-other-owner','unused','別オーナー','owner'),('mail-staff','mail-staff','unused','担当者','staff'); INSERT INTO companies(id,name) VALUES('mail-company','メール確認取引先'); INSERT INTO settings(key,value) VALUES('notification_email','legacy@example.com');");
  env = { DB: db.binding(), APP_ENV: 'production', ALLOW_DEMO_AUTH: 'false', SESSION_SECRET: 'mail-test-only-session-secret-at-least-thirty-two-characters' } as Bindings;
  ownerCookie = 'kojima_session=' + await signSession(owner, env);
  otherOwnerCookie = 'kojima_session=' + await signSession(otherOwner, env);
  staffCookie = 'kojima_session=' + await signSession(staff, env);
  pending = []; providerCalls = []; gmailRaw = []; providerFailure = 'none'; omitRefresh = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    providerCalls.push({ url, init });
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe(clientId); expect(body.get('client_secret')).toBe(clientSecret);
      if (providerFailure === 'token') return json({ error: 'invalid_grant', error_description: refreshToken + ' ' + sender }, 400);
      expect(['authorization_code', 'refresh_token']).toContain(body.get('grant_type'));
      if (body.get('grant_type') === 'authorization_code') {
        expect(body.get('redirect_uri')).toBe(origin + '/admin/settings/mail/callback');
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      } else expect(body.get('refresh_token')).toBe(refreshToken);
      return json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.send', ...(!omitRefresh && body.get('grant_type') === 'authorization_code' ? { refresh_token: refreshToken } : {}) });
    }
    if (url.origin === 'https://gmail.googleapis.com' && url.pathname === '/gmail/v1/users/me/messages/send') {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + accessToken);
      const body = JSON.parse(String(init?.body));
      gmailRaw.push(Buffer.from(body.raw, 'base64url').toString('utf8'));
      return providerFailure === 'send' ? json({ error: { code: 403, message: clientSecret + ' ' + recipients.join(' ') } }, 403) : json({ id: 'test-mail-message' });
    }
    if (url.origin === 'https://api.resend.com' && url.pathname === '/emails') return json({ id: 'test-resend-message' });
    throw new Error('Unexpected external provider');
  }));
});
afterEach(async () => { await Promise.allSettled(pending); vi.unstubAllGlobals(); vi.restoreAllMocks(); db.sqlite.close(); });

async function request(path = '', method = 'GET', body?: Record<string, unknown>, cookie: string | null = ownerCookie) {
  const response = await app.request(origin + '/api/admin/mail-settings' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, env, { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {} } as unknown as ExecutionContext);
  return { status: response.status, response, json: await response.json() as any };
}
async function save(extra: Record<string, unknown> = {}) {
  const result = await request('', 'PUT', { provider: 'gmail', enabled: false, recipients, sender_email: sender, notify_created: true, notify_edited: false, notify_cancelled: true, gmail_client_id: clientId, gmail_client_secret: clientSecret, ...extra });
  expect(result.status, JSON.stringify(result.json)).toBe(200); return result.json.data;
}
async function start() {
  const result = await request('/gmail/start', 'POST', {});
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  const url = new URL(result.json.data.authorization_url);
  return { result, url, state: url.searchParams.get('state')! };
}
async function connect() {
  await save(); const begun = await start();
  const finished = await request('/gmail/finish', 'POST', { state: begun.state, code: 'test-google-authorization-code' });
  expect(finished.status, JSON.stringify(finished.json)).toBe(200);
  return { begun, finished };
}
const privateRows = (table: string) => db.sqlite.prepare('SELECT * FROM ' + table).all();
const auditText = () => JSON.stringify(privateRows('audit_logs'));

describe('owner-only email configuration and Gmail OAuth through actual routes', () => {
  it('requires an authenticated owner for configuration and all connection actions', async () => {
    expect((await request('', 'GET', undefined, null)).status).toBe(401);
    for (const [path, method, body] of [['', 'GET', undefined], ['', 'PUT', {}], ['/gmail/start', 'POST', {}], ['/gmail/finish', 'POST', {}], ['/gmail/disconnect', 'POST', {}], ['/test', 'POST', {}]] as const) {
      expect((await request(path, method, body, staffCookie)).status).toBe(403);
    }
    expect(providerCalls).toHaveLength(0);
  });

  it('deduplicates multiple recipients and never returns saved secrets in public configuration or audit', async () => {
    const saved = await save({ recipients: ['orders@example.com', 'orders@example.com', 'shipping@example.com'] });
    expect(saved.recipients).toEqual(recipients); expect(saved.gmail_client_secret_configured).toBe(true); expect(saved.gmail_connected).toBe(false);
    const read = await request(); expect(read.status).toBe(200);
    const exposed = JSON.stringify({ saved, read: read.json }) + auditText();
    expect(exposed).not.toContain(clientSecret); expect(exposed).not.toContain(refreshToken); expect(exposed).not.toContain('ciphertext');
    const generic = await app.request(origin + '/api/admin/settings', { headers: { Cookie: ownerCookie } }, env);
    const text = await generic.text(); expect(text).not.toContain(clientSecret); expect(text).not.toContain('gmail_client_secret');
  });

  it('retains an existing client secret when the masked form submits a blank field', async () => {
    await save(); const saved = await save({ gmail_client_secret: '' });
    expect(saved.gmail_client_secret_configured).toBe(true);
    const begun = await start();
    expect((await request('/gmail/finish', 'POST', { state: begun.state, code: 'test-code' })).status).toBe(200);
  });

  it.each([{ recipients: ['not-an-email'] }, { recipients: ['victim@example.com\r\nBcc: intruder@example.com'] }, { recipients: Array.from({ length: 21 }, (_, i) => `recipient${i}@example.com`) }])('rejects invalid or excessive recipient lists: %j', async ({ recipients: invalid }) => {
      const result = await request('', 'PUT', { provider: 'gmail', enabled: false, recipients: invalid, sender_email: sender, gmail_client_id: clientId, notify_created: true, notify_edited: false, notify_cancelled: true });
    expect(result.status).toBe(400); expect(providerCalls).toHaveLength(0);
  });

  it('rejects sender header injection and a non-Google OAuth client identifier', async () => {
    for (const invalid of [{ sender_email: 'sender@example.com\r\nBcc: intruder@example.com' }, { gmail_client_id: 'https://intruder.example/client' }]) {
      const result = await request('', 'PUT', { provider: 'gmail', enabled: false, recipients, sender_email: sender, gmail_client_id: clientId, notify_created: true, notify_edited: false, notify_cancelled: true, ...invalid });
      expect(result.status).toBe(400);
    }
    expect(providerCalls).toHaveLength(0);
  });

  it('constructs a Google-only offline consent URL with PKCE and the exact same-origin callback', async () => {
    await save(); const { result, url, state } = await start();
    expect(url.origin).toBe('https://accounts.google.com'); expect(url.pathname).toBe('/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(clientId); expect(url.searchParams.get('redirect_uri')).toBe(origin + '/admin/settings/mail/callback');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.send');
    expect(url.searchParams.get('access_type')).toBe('offline'); expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state.length).toBeGreaterThanOrEqual(32); expect(result.json.data.redirect_uri).toBe(origin + '/admin/settings/mail/callback');
    expect(url.href).not.toContain(clientSecret); expect(providerCalls).toHaveLength(0);
    expect((await request('/gmail/finish', 'POST', { state, code: 'test-code' })).status).toBe(200);
    const exchange = providerCalls.find(call => call.url.pathname === '/token')!;
    const verifier = new URLSearchParams(String(exchange.init?.body)).get('code_verifier')!;
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    expect(challenge).toBe(url.searchParams.get('code_challenge'));
  });

  it('binds OAuth completion to the initiating owner and consumes each state once', async () => {
    await save(); const { state } = await start();
    expect((await request('/gmail/finish', 'POST', { state, code: 'test-code' }, otherOwnerCookie)).status).toBeGreaterThanOrEqual(400);
    expect(providerCalls).toHaveLength(0);
    expect((await request('/gmail/finish', 'POST', { state, code: 'test-code' })).status).toBe(200);
    const count = providerCalls.length;
    expect((await request('/gmail/finish', 'POST', { state, code: 'test-code' })).status).toBeGreaterThanOrEqual(400);
    expect(providerCalls).toHaveLength(count);
  });

  it('rejects expired states without contacting Google and without consuming a newer state', async () => {
    await save(); const old = await start();
    db.sqlite.exec("UPDATE gmail_oauth_states SET created_at='2000-01-01T00:00:00.000Z',expires_at='2000-01-02T00:00:00.000Z'");
    expect((await request('/gmail/finish', 'POST', { state: old.state, code: 'test-code' })).status).toBeGreaterThanOrEqual(400);
    expect(providerCalls).toHaveLength(0);
    const current = await start();
    expect((await request('/gmail/finish', 'POST', { state: current.state, code: 'test-code' })).status).toBe(200);
  });

  it('refuses an authorization result started before the OAuth client configuration changed', async () => {
    await save(); const old = await start();
    await save({ gmail_client_id: 'new-mail-test-client.apps.googleusercontent.com', gmail_client_secret: '' });
    expect((await request('/gmail/finish', 'POST', { state: old.state, code: 'test-code' })).status).toBeGreaterThanOrEqual(400);
    expect(providerCalls).toHaveLength(0);
    expect((await request()).json.data.gmail_connected).toBe(false);
  });

  it('allows only one concurrent completion of the same OAuth state', async () => {
    await save(); const { state } = await start();
    const results = await Promise.all([request('/gmail/finish', 'POST', { state, code: 'test-code' }), request('/gmail/finish', 'POST', { state, code: 'test-code' })]);
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect(results.filter(result => result.status >= 400)).toHaveLength(1);
    expect(providerCalls.filter(call => call.url.pathname === '/token' && new URLSearchParams(String(call.init?.body)).get('grant_type') === 'authorization_code')).toHaveLength(1);
  });

  it('stores credentials encrypted and keeps successful connection responses and audit free of credentials', async () => {
    const { finished } = await connect(); const read = await request();
    expect(read.json.data.gmail_connected).toBe(true);
    const exposed = JSON.stringify({ finished: finished.json, read: read.json }) + auditText();
    for (const secret of [clientSecret, refreshToken, accessToken, 'test-google-authorization-code']) expect(exposed).not.toContain(secret);
    const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%email%' OR name LIKE '%gmail%')").all() as { name: string }[];
    const stored = JSON.stringify(tables.flatMap(table => privateRows(table.name)));
    expect(stored).not.toContain(clientSecret); expect(stored).not.toContain(refreshToken); expect(stored).not.toContain(accessToken);
  });

  it('does not report a durable connection if Google omits the required refresh token', async () => {
    await save(); const { state } = await start(); omitRefresh = true;
    expect((await request('/gmail/finish', 'POST', { state, code: 'test-code' })).status).toBeGreaterThanOrEqual(400);
    expect((await request()).json.data.gmail_connected).toBe(false);
  });

  it('disconnects Gmail without exposing credentials or changing configured recipient addresses', async () => {
    await connect(); const disconnected = await request('/gmail/disconnect', 'POST', {});
    expect(disconnected.status).toBe(200);
    const read = await request(); expect(read.json.data.gmail_connected).toBe(false); expect(read.json.data.recipients).toEqual(recipients);
    expect(JSON.stringify(disconnected.json) + auditText()).not.toContain(refreshToken);
  });

  it('invalidates unfinished authorization states when Gmail is disconnected', async () => {
    await save(); const { state } = await start();
    expect((await request('/gmail/disconnect', 'POST', {})).status).toBe(200);
    expect((await request('/gmail/finish', 'POST', { state, code: 'test-code' })).status).toBeGreaterThanOrEqual(400);
    expect(providerCalls).toHaveLength(0);
  });
});

describe('order email delivery using saved recipients', () => {
  it.each(['none', 'token', 'send'] as const)('accepts and stores an order once and never resends its idempotent retry with mail provider state %s', async failure => {
    await connect(); await save({ enabled: true, gmail_client_secret: '' }); providerFailure = failure;
    db.sqlite.exec(`
      INSERT INTO shipping_rules(id,name,delivery_method,is_free_shipping) VALUES('mail-rule','メール検証用自社便','own_delivery',1);
      INSERT INTO shipping_addresses(id,company_id,name,postal_code,prefecture,city,address_line1,phone,shipping_rule_id)
        VALUES('mail-address','mail-company','検証用配送先','4840000','愛知県','犬山市','架空住所','0000000000','mail-rule');
      INSERT INTO products(id,name,category,volume_ml,standard_price,weight_kg)
        VALUES('mail-product','メール通知確認用商品','その他',300,1000,1);
    `);
    const orderRequest = async (path: string, body: unknown) => {
      const response = await app.request(origin + '/api/admin' + path, { method: 'POST', headers: { Cookie: ownerCookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env, { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {} } as unknown as ExecutionContext);
      return { status: response.status, json: await response.json() as any };
    };
    const input = { company_id: 'mail-company', shipping_address_id: 'mail-address', items: [{ product_id: 'mail-product', quantity: 1 }] };
    const quoted = await orderRequest('/orders/quote', input);
    expect(quoted.status, JSON.stringify(quoted.json)).toBe(200);
    const payload = { ...input, desired_delivery_date: quoted.json.data.delivery_dates[0], request_id: crypto.randomUUID() };
    const confirmed = await orderRequest('/orders/quote', payload);
    expect(confirmed.status).toBe(200);
    Object.assign(payload, { quote_token: confirmed.json.data.quote_token });
    const accepted = await orderRequest('/orders', payload);
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(201);
    await Promise.all(pending);
    const calls = providerCalls.length;
    const retried = await orderRequest('/orders', payload);
    expect(retried.status, JSON.stringify(retried.json)).toBe(200);
    await Promise.all(pending);
    expect(retried.json.data.id).toBe(accepted.json.data.id);
    expect(providerCalls).toHaveLength(calls);
    expect(db.sqlite.prepare('SELECT count(*) count FROM orders').get()).toMatchObject({ count: 1 });
    expect(db.sqlite.prepare("SELECT count(*) count FROM audit_logs WHERE action='NOTIFICATION_ORDER_CREATE'").get()).toMatchObject({ count: 1 });
    expect(gmailRaw).toHaveLength(failure === 'token' ? 0 : recipients.length);
  });

  it('refreshes access safely and sends one Gmail message per configured recipient', async () => {
    await connect(); const result = await request('/test', 'POST', {});
    expect(result.status, JSON.stringify(result.json)).toBe(200); expect(gmailRaw).toHaveLength(2);
    for (let i = 0; i < recipients.length; i++) {
      expect(gmailRaw[i]).toContain(recipients[i]); expect(gmailRaw[i]).not.toContain(recipients[1 - i]);
      expect(gmailRaw[i]).toMatch(/Subject:/); expect(gmailRaw[i]).toMatch(/From:/);
    }
    expect(providerCalls.filter(call => call.url.pathname === '/token').some(call => new URLSearchParams(String(call.init?.body)).get('grant_type') === 'refresh_token')).toBe(true);
    expect(auditText()).not.toContain(accessToken); expect(auditText()).not.toContain(refreshToken);
  });

  it('sends a configured new-order email through the existing notification entry point and respects event switches', async () => {
    await connect(); await save({ enabled: true, gmail_client_secret: '' });
    const order = { id: 'O-EMAIL-UNIT-1', company_id: 'mail-company', desired_delivery_date: '2030-01-01', total_amount: 1980 };
    const created = await notifyOrder(env, owner, order, 'create');
    expect(created.channels).toContain('email'); expect(gmailRaw).toHaveLength(2);
    await notifyOrder(env, owner, order, 'edit'); expect(gmailRaw).toHaveLength(2);
    await save({ enabled: false, gmail_client_secret: '' }); await notifyOrder(env, owner, order, 'create'); expect(gmailRaw).toHaveLength(2);
  });

  it.each(['send', 'token'] as const)('records safe %s failure diagnostics without leaking response contents or throwing after an accepted order', async failure => {
    await connect(); await save({ enabled: true, gmail_client_secret: '' }); providerFailure = failure;
    const result = await notifyOrder(env, owner, { id: 'O-EMAIL-UNIT-2', company_id: 'mail-company', desired_delivery_date: '2030-01-01', total_amount: 1980 }, 'create');
    expect(result.status).toBe('failed');
    const logs = JSON.stringify(privateRows('audit_logs').filter((row: any) => row.action.startsWith('NOTIFICATION_'))); expect(logs).toMatch(/failed/);
    for (const secret of [clientSecret, refreshToken, accessToken, ...recipients]) expect(logs).not.toContain(secret);
  });

  it('still delivers email when LINE rejects the same order notification', async () => {
    await connect(); await save({ enabled: true, gmail_client_secret: '' });
    env.LINE_CHANNEL_ACCESS_TOKEN = 'test-line-token-for-isolated-provider-failure';
    const mailProvider = fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://api.line.me') return json({ message: 'private LINE provider rejection' }, 401);
      return mailProvider(input, init);
    }));
    const result = await notifyOrder(env, owner, { id: 'O-EMAIL-WITH-LINE-FAILURE', company_id: 'mail-company', ordered_by_line_user_id: 'test-line-recipient', desired_delivery_date: '2030-01-01', total_amount: 1980 }, 'create');
    expect(result).toEqual({ status: 'failed', channels: ['email'] });
    expect(gmailRaw).toHaveLength(2);
    expect(auditText()).not.toContain('private LINE provider rejection');
  });

  it('preserves a successful LINE send when reading mail settings fails', async () => {
    env.LINE_CHANNEL_ACCESS_TOKEN = 'test-line-token-for-isolated-settings-failure';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe('https://api.line.me');
      return json({ sentMessages: [{ id: 'test-line-message' }] });
    }));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      if (sql.includes('FROM email_notification_config')) throw new Error('private database details');
      return prepare(sql);
    });
    const result = await notifyOrder(env, owner, { id: 'O-LINE-WITH-MAIL-FAILURE', company_id: 'mail-company', ordered_by_line_user_id: 'test-line-recipient', desired_delivery_date: '2030-01-01', total_amount: 1980 }, 'create');
    expect(result).toEqual({ status: 'failed', channels: ['line'] });
    expect(auditText()).toContain('failed:email_connection_failed');
    expect(auditText()).not.toContain('private database details');
  });

  it('does not reject or resend provider messages when notification audit storage fails', async () => {
    await connect(); await save({ enabled: true, gmail_client_secret: '' });
    db.sqlite.exec("CREATE TRIGGER reject_notification_audit BEFORE INSERT ON audit_logs WHEN NEW.action LIKE 'NOTIFICATION_%' BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END;");
    const result = await notifyOrder(env, owner, { id: 'O-EMAIL-AUDIT-FAILURE', company_id: 'mail-company', desired_delivery_date: '2030-01-01', total_amount: 1980 }, 'create');
    expect(result).toEqual({ status: 'failed', channels: ['email'] });
    expect(gmailRaw).toHaveLength(2);
  });

  it('never contacts a mail provider for normal order notifications in development', async () => {
    await connect(); await save({ enabled: true, gmail_client_secret: '' }); providerCalls.length = 0; env.APP_ENV = 'development';
    const result = await notifyOrder(env, owner, { id: 'O-EMAIL-UNIT-3', company_id: 'mail-company', desired_delivery_date: '2030-01-01', total_amount: 1980 }, 'create');
    expect(result.channels).not.toContain('email'); expect(providerCalls).toHaveLength(0);
  });
});
