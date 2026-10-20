import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import { issueInvitation } from '../src/server/services/invitations';
import type { Bindings } from '../src/server/types';

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
const LOGIN_CHANNEL = '2012094093', MESSAGING_CHANNEL = '2011903727';
const ACCESS = 'test-liff-user-access-token', ID = 'test-liff-id-token';
const owner = { id: 'owner', type: 'admin', role: 'owner', name: '管理者' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let db: SqliteD1, env: Bindings, pending: Promise<unknown>[];

beforeEach(() => {
  db = new SqliteD1();
  db.sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  db.sqlite.exec(`
    INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('owner','owner','unused','管理者','owner');
    INSERT INTO companies(id,name) VALUES('a','A商店'),('b','Bホテル');
    INSERT INTO settings(key,value) VALUES('invite_default_max_uses','5'),('invite_valid_days','30');
  `);
  env = { DB: db.binding(), APP_ENV: 'development', ALLOW_DEMO_AUTH: 'false', LINE_CHANNEL_ID: LOGIN_CHANNEL, LINE_MESSAGING_CHANNEL_ID: MESSAGING_CHANNEL, SESSION_SECRET: 'unit-test-only-session-key-longer-than-32-characters' } as Bindings;
  pending = [];
});
afterEach(async () => { await Promise.allSettled(pending); vi.unstubAllGlobals(); db.sqlite.close(); });

function lineProvider(options: { client_id?: unknown; expires_in?: unknown; scope?: unknown; userId?: unknown; idSub?: string; badID?: boolean; profileStatus?: number } = {}) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    if (url.origin === 'https://api.line.me' && url.pathname === '/oauth2/v2.1/verify' && init?.method === 'POST') {
      const body = new URLSearchParams(String(init.body));
      expect(body.get('id_token')).toBe(ID);
      expect(body.get('client_id')).toBe(LOGIN_CHANNEL);
      return options.badID ? json({ error: 'invalid_token' }, 400) : json({ sub: options.idSub ?? 'U_NEW', name: 'LINE担当者', aud: LOGIN_CHANNEL, iss: 'https://access.line.me', exp: Math.floor(Date.now() / 1000) + 600 });
    }
    if (url.origin === 'https://api.line.me' && url.pathname === '/oauth2/v2.1/verify' && (init?.method === undefined || init.method === 'GET')) {
      expect(url.searchParams.get('access_token')).toBe(ACCESS);
      return json({ client_id: options.client_id === undefined ? LOGIN_CHANNEL : options.client_id, expires_in: options.expires_in === undefined ? 600 : options.expires_in, scope: options.scope === undefined ? 'openid profile' : options.scope });
    }
    if (url.origin === 'https://api.line.me' && url.pathname === '/v2/profile') {
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${ACCESS}`);
      return options.profileStatus ? json({ message: 'invalid access token' }, options.profileStatus) : json({ userId: options.userId === undefined ? 'U_NEW' : options.userId, displayName: 'LINE担当者' });
    }
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  }));
  return calls;
}
function lineAccountsProvider(count = 3) {
  const accounts = Array.from({ length: count }, (_, index) => ({
    userId: `U_MULTI_STAFF_${index + 1}`, displayName: `LINE表示名 ${index + 1}`,
    idToken: `mock-id-token-for-staff-${index + 1}`, accessToken: `mock-access-token-for-staff-${index + 1}`,
  }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    if (url.origin !== 'https://api.line.me') throw new Error('Unexpected provider origin');
    if (url.pathname === '/oauth2/v2.1/verify' && method === 'POST') {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe(LOGIN_CHANNEL);
      const account = accounts.find(entry => entry.idToken === body.get('id_token'));
      return account ? json({ sub: account.userId, name: account.displayName, aud: LOGIN_CHANNEL, iss: 'https://access.line.me', exp: Math.floor(Date.now() / 1000) + 600 }) : json({ error: 'invalid_token' }, 400);
    }
    if (url.pathname === '/oauth2/v2.1/verify' && method === 'GET') {
      const account = accounts.find(entry => entry.accessToken === url.searchParams.get('access_token'));
      return account ? json({ client_id: LOGIN_CHANNEL, expires_in: 600, scope: 'openid profile' }) : json({ error: 'invalid_token' }, 400);
    }
    if (url.pathname === '/v2/profile') {
      const authorization = new Headers(init?.headers).get('Authorization');
      const account = accounts.find(entry => authorization === `Bearer ${entry.accessToken}`);
      return account ? json({ userId: account.userId, displayName: account.displayName }) : json({ message: 'invalid access token' }, 401);
    }
    throw new Error('Unexpected LINE API operation');
  }));
  return accounts;
}
function request(path: string, body?: unknown, cookie?: string, method = body === undefined ? 'GET' : 'POST') {
  return app.request(`https://orders.example${path}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'https://orders.example' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env, { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext);
}
function linkedUser(id = 'U_OLD', company = 'b') {
  db.sqlite.prepare('INSERT INTO line_users(id,company_id,line_user_id,staff_name,status) VALUES(?,?,?,?,?)').run(`row-${id}`, company, id, '登録済み担当者', 'active');
}
async function customerCookie(id = 'U_OLD', company = 'b') { return `kojima_session=${await signSession({ id, type: 'customer', name: '登録済み担当者', company_id: company }, env)}`; }
async function adminCookie() { return `kojima_session=${await signSession({ id: 'owner', type: 'admin', name: '管理者', role: 'owner' }, env)}`; }
const invitation = (company = 'a', input: Record<string, any> = {}) => issueInvitation(db.binding(), owner, company, input, 'https://orders.example');
const cookieFrom = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
function expectCleared(response: Response) { expect(response.headers.get('set-cookie')).toContain('kojima_session=;'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0'); }

describe('LINE Login identity and invitation binding over the actual HTTP routes', () => {
  it('adds different LINE accounts to one company and preserves each identity while refusing cross-company invitations', async () => {
    const invite = await invitation();
    const accounts = lineAccountsProvider();
    const cookies: string[] = [];
    for (const [index, account] of accounts.slice(0, 2).entries()) {
      const credentials = index === 0 ? { id_token: account.idToken } : { access_token: account.accessToken };
      const response = await request('/api/public/invitations/register', { token: invite.token, staff_name: `注文担当 ${index + 1}`, ...credentials });
      expect(response.status).toBe(200);
      expect((await response.json() as any).data.actor).toMatchObject({ id: account.userId, type: 'customer', company_id: 'a', name: `注文担当 ${index + 1}` });
      cookies.push(cookieFrom(response));
    }
    expect(cookies[0]).not.toBe(cookies[1]);
    expect(db.sqlite.prepare('SELECT line_user_id,company_id,staff_name,line_display_name FROM line_users ORDER BY line_user_id').all()).toEqual(accounts.slice(0, 2).map((account, index) => ({ line_user_id: account.userId, company_id: 'a', staff_name: `注文担当 ${index + 1}`, line_display_name: account.displayName })));
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invite.id)).toMatchObject({ used_count: 2 });
    const otherCompany = await invitation('b');
    for (const [index, account] of accounts.slice(0, 2).entries()) {
      const me = await request('/api/auth/me', undefined, cookies[index]);
      expect((await me.json() as any).data.actor).toMatchObject({ id: account.userId, company_id: 'a', company_name: 'A商店' });
      const login = await request('/api/auth/line', index === 0 ? { access_token: account.accessToken } : { id_token: account.idToken });
      expect(login.status).toBe(200);
      expect((await login.json() as any).data.actor).toMatchObject({ id: account.userId, company_id: 'a' });
      const rejected = await request('/api/public/invitations/register', { token: otherCompany.token, staff_name: '別企業への変更', access_token: account.accessToken }, cookies[index]);
      expect(rejected.status).toBe(409);
      expect((await rejected.json() as any).error.code).toBe('ALREADY_REGISTERED');
      expect(rejected.headers.get('set-cookie')).toBeNull();
      const unchanged = await request('/api/auth/me', undefined, cookies[index]);
      expect((await unchanged.json() as any).data.actor).toMatchObject({ id: account.userId, company_id: 'a' });
    }
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(otherCompany.id)).toMatchObject({ used_count: 0 });
    expect(db.sqlite.prepare('SELECT count(*) count FROM line_users WHERE company_id=?').get('a')).toMatchObject({ count: 2 });
    expect(db.sqlite.prepare('SELECT count(*) count FROM line_users WHERE company_id=?').get('b')).toMatchObject({ count: 0 });
  });

  it('enforces invite capacity for new accounts without affecting members, retries, or later capacity increases', async () => {
    const invite = await invitation('a', { max_uses: 2 });
    const accounts = lineAccountsProvider();
    const cookies: string[] = [];
    for (const [index, account] of accounts.slice(0, 2).entries()) {
      const response = await request('/api/public/invitations/register', { token: invite.token, staff_name: `担当者 ${index + 1}`, access_token: account.accessToken });
      expect(response.status).toBe(200);
      cookies.push(cookieFrom(response));
    }
    const before = db.sqlite.prepare('SELECT id,line_user_id,company_id,staff_name FROM line_users ORDER BY line_user_id').all();
    const blocked = await request('/api/public/invitations/register', { token: invite.token, staff_name: '上限超過の担当者', access_token: accounts[2].accessToken });
    expect(blocked.status).toBe(409);
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invite.id)).toMatchObject({ used_count: 2 });
    expect(db.sqlite.prepare('SELECT id,line_user_id,company_id,staff_name FROM line_users ORDER BY line_user_id').all()).toEqual(before);
    const retry = await request('/api/public/invitations/register', { token: invite.token, staff_name: '再登録時の別表記', id_token: accounts[0].idToken }, cookies[0]);
    expect(retry.status).toBe(200);
    expect((await retry.json() as any).data.actor).toMatchObject({ id: accounts[0].userId, name: '担当者 1', company_id: 'a' });
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invite.id)).toMatchObject({ used_count: 2 });
    for (const [index, cookie] of cookies.entries()) {
      const lookup = await request(`/api/public/invitations/lookup?t=${invite.token}`, undefined, cookie);
      expect((await lookup.json() as any).data).toMatchObject({ full: true, usable: true, already_registered: true });
      const me = await request('/api/auth/me', undefined, cookie);
      expect((await me.json() as any).data.actor).toMatchObject({ id: accounts[index].userId, company_id: 'a' });
    }
    const increased = await request(`/api/admin/companies/a/invitations/${invite.id}`, { max_uses: 3 }, await adminCookie(), 'PUT');
    expect(increased.status).toBe(200);
    const admitted = await request('/api/public/invitations/register', { token: invite.token, staff_name: '担当者 3', access_token: accounts[2].accessToken });
    expect(admitted.status).toBe(200);
    expect((await admitted.json() as any).data.actor).toMatchObject({ id: accounts[2].userId, company_id: 'a' });
    expect(db.sqlite.prepare('SELECT max_uses,used_count FROM invitations WHERE id=?').get(invite.id)).toMatchObject({ max_uses: 3, used_count: 3 });
    expect(db.sqlite.prepare('SELECT count(*) count FROM line_users').get()).toMatchObject({ count: 3 });
    for (const [index, cookie] of cookies.entries()) {
      const stillValid = await request('/api/auth/me', undefined, cookie);
      expect((await stillValid.json() as any).data.actor).toMatchObject({ id: accounts[index].userId, company_id: 'a' });
    }
  });

  it('honors an unlimited invitation for more than the default five distinct LINE accounts', async () => {
    const invite = await invitation('a', { max_uses: null });
    const accounts = lineAccountsProvider(6);
    for (const [index, account] of accounts.entries()) {
      const response = await request('/api/public/invitations/register', { token: invite.token, staff_name: `担当者 ${index + 1}`, access_token: account.accessToken });
      expect(response.status).toBe(200);
      const me = await request('/api/auth/me', undefined, cookieFrom(response));
      expect((await me.json() as any).data.actor).toMatchObject({ id: account.userId, company_id: 'a' });
    }
    expect(db.sqlite.prepare('SELECT max_uses,used_count FROM invitations WHERE id=?').get(invite.id)).toMatchObject({ max_uses: null, used_count: 6 });
    expect(db.sqlite.prepare('SELECT count(*) count FROM line_users WHERE company_id=?').get('a')).toMatchObject({ count: 6 });
    expect(db.sqlite.prepare("SELECT count(*) count FROM audit_logs WHERE action='LINE_USER_REGISTER'").get()).toMatchObject({ count: 6 });
  });

  it('registers an access-token-only LIFF user into only the invitation company and restores the same actor from the cookie', async () => {
    const invite = await invitation();
    const calls = lineProvider();
    const response = await request('/api/public/invitations/register', { token: invite.token, staff_name: '正しい担当者', access_token: ACCESS, company_id: 'b', line_user_id: 'FORGED', profile: { userId: 'FORGED' } });
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.data.actor).toMatchObject({ id: 'U_NEW', type: 'customer', company_id: 'a', name: '正しい担当者' });
    expect(db.sqlite.prepare('SELECT line_user_id,company_id FROM line_users').all()).toEqual([{ line_user_id: 'U_NEW', company_id: 'a' }]);
    expect((db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invite.id) as any).used_count).toBe(1);
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.get('set-cookie')).not.toContain('Max-Age=0');
    const me = await request('/api/auth/me', undefined, cookieFrom(response));
    expect(me.status).toBe(200);
    expect((await me.json() as any).data.actor).toMatchObject({ id: 'U_NEW', company_id: 'a', company_name: 'A商店' });
    expect(calls.filter(call => call.url.pathname === '/v2/profile')).toHaveLength(1);
  });

  it('logs a registered user in with a validated user access token, using the Login channel rather than the Messaging channel', async () => {
    linkedUser('U_NEW', 'a');
    lineProvider();
    const response = await request('/api/auth/line', { access_token: ACCESS });
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.actor).toMatchObject({ id: 'U_NEW', company_id: 'a' });
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it.each([
    ['wrong Messaging channel', { client_id: MESSAGING_CHANNEL }],
    ['expired token', { expires_in: 0 }],
    ['negative lifetime', { expires_in: -1 }],
    ['string lifetime', { expires_in: '600' }],
    ['missing profile scope', { scope: 'openid' }],
    ['invalid profile scope shape', { scope: ['profile'] }],
  ])('rejects %s without consuming an invitation or requesting a profile', async (_, invalid) => {
    const invite = await invitation();
    const calls = lineProvider(invalid);
    const response = await request('/api/public/invitations/register', { token: invite.token, staff_name: '担当者', access_token: ACCESS });
    expect(response.status).toBe(401);
    expect(db.sqlite.prepare('SELECT count(*) count FROM line_users').get()).toMatchObject({ count: 0 });
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invite.id)).toMatchObject({ used_count: 0 });
    expect(calls.some(call => call.url.pathname === '/v2/profile')).toBe(false);
  });

  it.each([{ profileStatus: 401 }, { userId: null }])('rejects a failed or malformed authoritative profile even when the browser claims a user ID (%#)', async options => {
    const invite = await invitation();
    lineProvider(options);
    const response = await request('/api/public/invitations/register', { token: invite.token, staff_name: '担当者', access_token: ACCESS, profile: { userId: 'FORGED' } });
    expect(response.status).toBe(401);
    expect(db.sqlite.prepare('SELECT count(*) count FROM line_users').get()).toMatchObject({ count: 0 });
  });

  it('retains the ID-token path and never falls back to an access token after ID verification fails', async () => {
    linkedUser('U_NEW', 'a');
    lineProvider();
    const successful = await request('/api/auth/line', { id_token: ID, access_token: ACCESS });
    expect(successful.status).toBe(200);
    expect((await successful.json() as any).data.actor).toMatchObject({ id: 'U_NEW', company_id: 'a' });
    const calls = lineProvider({ badID: true });
    const rejected = await request('/api/auth/line', { id_token: ID, access_token: ACCESS }, cookieFrom(successful));
    expect(rejected.status).toBe(401);
    expectCleared(rejected);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('POST');
  });

  it('returns a stable registration-required code and expires a previous customer cookie instead of keeping the wrong company', async () => {
    linkedUser();
    lineProvider();
    const response = await request('/api/auth/line', { access_token: ACCESS }, await customerCookie());
    expect(response.status).toBe(403);
    expect((await response.json() as any).error.code).toBe('LINE_USER_NOT_REGISTERED');
    expectCleared(response);
    expect(db.sqlite.prepare('SELECT line_user_id,company_id FROM line_users').all()).toEqual([{ line_user_id: 'U_OLD', company_id: 'b' }]);
  });

  it('expires a previous customer cookie on registration credential failure but preserves an existing administrator session', async () => {
    linkedUser();
    const invite = await invitation();
    lineProvider({ client_id: MESSAGING_CHANNEL });
    const body = { token: invite.token, staff_name: '担当者', access_token: ACCESS };
    const customer = await request('/api/public/invitations/register', body, await customerCookie());
    expect(customer.status).toBe(401);
    expectCleared(customer);
    const admin = await request('/api/public/invitations/register', body, await adminCookie());
    expect(admin.status).toBe(401);
    expect(admin.headers.get('set-cookie')).toBeNull();
    const me = await request('/api/auth/me', undefined, await adminCookie());
    expect((await me.json() as any).data.actor).toMatchObject({ type: 'admin', role: 'owner' });
  });

  it('preserves an existing administrator cookie when the verified LINE identity needs a company invitation', async () => {
    lineProvider();
    const response = await request('/api/auth/line', { access_token: ACCESS }, await adminCookie());
    expect(response.status).toBe(403);
    expect((await response.json() as any).error.code).toBe('LINE_USER_NOT_REGISTERED');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('never rebinds an already registered LINE account to a different invitation company', async () => {
    linkedUser('U_NEW', 'b');
    const invite = await invitation('a');
    lineProvider();
    const cookie = await customerCookie('U_NEW', 'b');
    const response = await request('/api/public/invitations/register', { token: invite.token, staff_name: '担当者', access_token: ACCESS }, cookie);
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe('ALREADY_REGISTERED');
    expect(response.headers.get('set-cookie')).toBeNull();
    const me = await request('/api/auth/me', undefined, cookie);
    expect((await me.json() as any).data.actor).toMatchObject({ id: 'U_NEW', company_id: 'b' });
    expect(db.sqlite.prepare('SELECT line_user_id,company_id FROM line_users').all()).toEqual([{ line_user_id: 'U_NEW', company_id: 'b' }]);
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invite.id)).toMatchObject({ used_count: 0 });
  });

  it('clears a different stale LINE identity even when the current verified identity hits a business registration error', async () => {
    linkedUser('U_OLD', 'b');
    linkedUser('U_NEW', 'b');
    const invite = await invitation('a');
    lineProvider();
    const response = await request('/api/public/invitations/register', { token: invite.token, staff_name: '担当者', access_token: ACCESS }, await customerCookie('U_OLD', 'b'));
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe('ALREADY_REGISTERED');
    expectCleared(response);
    expect(db.sqlite.prepare('SELECT company_id FROM line_users WHERE line_user_id=?').get('U_NEW')).toMatchObject({ company_id: 'b' });
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invite.id)).toMatchObject({ used_count: 0 });
  });
});
