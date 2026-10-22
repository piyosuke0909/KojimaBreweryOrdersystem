import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import { issueInvitation } from '../src/server/services/invitations';
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
const LOGIN_CHANNEL = '2011901973';
const owner = { id: 'handoff-owner', type: 'admin', role: 'owner', name: '管理者' };
const accounts = [
  { sub: 'HANDOFF_LINE_STAFF_A', name: 'LINE担当A', id_token: 'handoff-id-a', access_token: 'handoff-access-a' },
  { sub: 'HANDOFF_LINE_STAFF_B', name: 'LINE担当B', id_token: 'handoff-id-b', access_token: 'handoff-access-b' },
];
const credentials = (index = 0, access = false) => access ? { access_token: accounts[index].access_token } : { id_token: accounts[index].id_token };
const responseJson = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let db: SqliteD1, env: Bindings, background: Promise<unknown>[];

beforeEach(() => {
  db = new SqliteD1();
  migrateTestDatabase(db.sqlite);
  db.sqlite.exec("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('handoff-owner','handoff-owner','unused','管理者','owner'); INSERT INTO companies(id,name) VALUES('a','A商店'),('b','Bホテル'); INSERT INTO settings(key,value) VALUES('invite_default_max_uses','5');");
  env = { DB: db.binding(), APP_ENV: 'development', ALLOW_DEMO_AUTH: 'false', LINE_CHANNEL_ID: LOGIN_CHANNEL, SESSION_SECRET: 'handoff-unit-test-only-session-secret-longer-than-32-characters' } as Bindings;
  background = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.line.me') throw new Error('Unexpected provider origin');
    if (url.pathname === '/oauth2/v2.1/verify' && init?.method === 'POST') {
      const body = new URLSearchParams(String(init.body));
      expect(body.get('client_id')).toBe(env.LINE_CHANNEL_ID);
      const account = accounts.find(row => row.id_token === body.get('id_token'));
      return account ? responseJson({ sub: account.sub, name: account.name, aud: env.LINE_CHANNEL_ID, iss: 'https://access.line.me', exp: Math.floor(Date.now() / 1000) + 600 }) : responseJson({ error: 'invalid_token' }, 400);
    }
    if (url.pathname === '/oauth2/v2.1/verify') {
      const account = accounts.find(row => row.access_token === url.searchParams.get('access_token'));
      return account ? responseJson({ client_id: env.LINE_CHANNEL_ID, expires_in: 600, scope: 'openid profile' }) : responseJson({ error: 'invalid_token' }, 400);
    }
    if (url.pathname === '/v2/profile') {
      const authorization = new Headers(init?.headers).get('Authorization');
      const account = accounts.find(row => authorization === `Bearer ${row.access_token}`);
      return account ? responseJson({ userId: account.sub, displayName: account.name }) : responseJson({ message: 'invalid access token' }, 401);
    }
    throw new Error('Unexpected provider operation');
  }));
});
afterEach(async () => { await Promise.allSettled(background); vi.unstubAllGlobals(); vi.restoreAllMocks(); db.sqlite.close(); });

async function request(path: string, body: Record<string, unknown>, cookie?: string) {
  const response = await app.request(`https://orders.example/api/public/invitations/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://orders.example', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  }, env, { waitUntil: (promise: Promise<unknown>) => background.push(promise), passThroughOnException() {} } as unknown as ExecutionContext);
  return { response, status: response.status, json: await response.json() as any };
}
async function prepare(token: string, index = 0) {
  const result = await request('prepare', { token, ...credentials(index) });
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  return result.json.data;
}
async function finish(handoff: string, index = 0, name = '注文担当者') {
  return request('register-pending', { handoff_id: handoff, staff_name: name, ...credentials(index, true) });
}
async function invitation(company = 'a', max_uses = 5) { return issueInvitation(db.binding(), owner, company, { max_uses }, 'https://orders.example'); }
const used = (id: string) => (db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(id) as any).used_count;
const memberCount = () => (db.sqlite.prepare('SELECT count(*) count FROM line_users').get() as any).count;
const handoffCount = () => (db.sqlite.prepare('SELECT count(*) count FROM line_invitation_handoffs').get() as any).count;
function link(index = 0, company = 'a') {
  db.sqlite.prepare("INSERT INTO line_users(id,line_user_id,company_id,staff_name,status) VALUES(?,?,?,?,'active')").run(`linked-${index}`, accounts[index].sub, company, '既存の担当者');
}

describe('verified LINE invitation handoff through actual routes', () => {
  it('resumes across cookie-free browser contexts and consumes a slot only when the name is confirmed', async () => {
    const invite = await invitation();
    const prepared = await prepare(invite.token);
    expect(prepared).toMatchObject({ pending: true, company_id: 'a', company_name: 'A商店', already_registered: false });
    expect(prepared.handoff_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(used(invite.id)).toBe(0); expect(memberCount()).toBe(0);
    const resumed = await request('resume', credentials(0, true));
    expect(resumed.status).toBe(200);
    expect(resumed.json.data).toMatchObject({ pending: true, handoff_id: prepared.handoff_id, company_id: 'a' });
    const complete = await finish(prepared.handoff_id, 0, '別ブラウザーの担当者');
    expect(complete.status).toBe(200);
    expect(complete.json.data.actor).toMatchObject({ id: accounts[0].sub, company_id: 'a', name: '別ブラウザーの担当者' });
    expect(complete.response.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(complete.response.headers.get('set-cookie')).toMatch(/Secure/i);
    expect(complete.response.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);
    expect(used(invite.id)).toBe(1); expect(memberCount()).toBe(1); expect(handoffCount()).toBe(0);
    expect((await request('resume', credentials())).json.data).toMatchObject({ pending: false });
  });

  it('stores only an opaque scoped subject digest and invitation reference, and never exposes credentials in the response', async () => {
    const invite = await invitation(); const result = await prepare(invite.token);
    const rows = db.sqlite.prepare('SELECT * FROM line_invitation_handoffs').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_hash: expect.stringMatching(/^[0-9a-f]{64}$/), invitation_id: invite.id, handoff_id: result.handoff_id });
    const serialized = JSON.stringify({ rows, result });
    for (const secret of [invite.token, accounts[0].sub, accounts[0].id_token, accounts[0].access_token]) expect(serialized).not.toContain(secret);
    const row = rows[0] as any;
    const lifetime = Date.parse(row.expires_at) - Date.parse(row.created_at);
    expect(lifetime).toBeGreaterThan(23 * 3600000); expect(lifetime).toBeLessThanOrEqual(24 * 3600000);
    expect(db.sqlite.prepare('SELECT expires_at FROM invitations WHERE id=?').get(invite.id)).toMatchObject({ expires_at: '' });
  });

  it('does not let another freshly authenticated LINE identity resume or consume the first person\'s handoff', async () => {
    const invite = await invitation(); const prepared = await prepare(invite.token);
    expect((await request('resume', credentials(1))).json.data).toEqual({ pending: false });
    const foreign = await finish(prepared.handoff_id, 1);
    expect(foreign.status).toBe(409); expect(foreign.json.error.code).toBe('INVITATION_HANDOFF_EXPIRED');
    expect(used(invite.id)).toBe(0); expect(memberCount()).toBe(0); expect(handoffCount()).toBe(1);
    expect((await finish(prepared.handoff_id)).status).toBe(200);
  });

  it('does not reuse a pending invitation from another Login channel even when its verified subject matches', async () => {
    const invite = await invitation(); const prepared = await prepare(invite.token);
    env.LINE_CHANNEL_ID = '2012094093';
    expect((await request('resume', credentials())).json.data).toEqual({ pending: false });
    expect((await finish(prepared.handoff_id)).status).toBe(409);
    expect(memberCount()).toBe(0); expect(used(invite.id)).toBe(0);
    env.LINE_CHANNEL_ID = LOGIN_CHANNEL;
    expect((await request('resume', credentials())).json.data).toMatchObject({ pending: true, handoff_id: prepared.handoff_id });
  });

  it('requires current LINE credentials even when a valid old customer cookie is supplied', async () => {
    const invite = await invitation(); link(1, 'b');
    const oldCookie = `kojima_session=${await signSession({ id: accounts[1].sub, type: 'customer', company_id: 'b', name: '既存の担当者' }, env)}`;
    for (const [path, body] of [['prepare', { token: invite.token }], ['resume', {}], ['register-pending', { handoff_id: crypto.randomUUID(), staff_name: 'なりすまし' }]] as const) {
      const rejected = await request(path, body, oldCookie);
      expect(rejected.status).toBe(401);
    }
    expect(handoffCount()).toBe(0); expect(used(invite.id)).toBe(0);
    const fresh = await request('prepare', { token: invite.token, ...credentials() }, oldCookie);
    expect(fresh.status).toBe(200); expect(fresh.json.data.company_id).toBe('a');
    expect((await request('resume', credentials())).json.data).toMatchObject({ handoff_id: fresh.json.data.handoff_id, company_id: 'a' });
  });

  it('rejects an invalid supplied ID token even when a valid access token is also supplied', async () => {
    const invite = await invitation();
    const result = await request('prepare', { token: invite.token, id_token: 'invalid-id', ...credentials(0, true) });
    expect(result.status).toBe(401); expect(handoffCount()).toBe(0); expect(used(invite.id)).toBe(0);
  });

  it('reuses the same current handoff without reserving additional registration slots', async () => {
    const invite = await invitation('a', 1);
    const first = await prepare(invite.token); const second = await prepare(invite.token);
    expect(second.handoff_id).toBe(first.handoff_id);
    expect(handoffCount()).toBe(1); expect(used(invite.id)).toBe(0);
  });

  it('rejects a stale confirmation after the same person scans a different company invitation', async () => {
    const a = await invitation('a'); const b = await invitation('b');
    const old = await prepare(a.token); const current = await prepare(b.token);
    expect(current.handoff_id).not.toBe(old.handoff_id);
    const stale = await finish(old.handoff_id);
    expect(stale.status).toBe(409); expect(stale.json.error.code).toBe('INVITATION_HANDOFF_EXPIRED');
    expect(memberCount()).toBe(0); expect(used(a.id)).toBe(0); expect(used(b.id)).toBe(0);
    const valid = await finish(current.handoff_id);
    expect(valid.status).toBe(200); expect(valid.json.data.actor.company_id).toBe('b');
    expect(used(a.id)).toBe(0); expect(used(b.id)).toBe(1);
  });

  it('expires only the temporary handoff while leaving the no-expiry invitation usable', async () => {
    const invite = await invitation(); const first = await prepare(invite.token);
    db.sqlite.prepare('UPDATE line_invitation_handoffs SET created_at=?,expires_at=?').run('2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z');
    expect((await request('resume', credentials())).json.data).toEqual({ pending: false });
    expect(handoffCount()).toBe(0);
    const rejected = await finish(first.handoff_id);
    expect(rejected.status).toBe(409); expect(rejected.json.error.code).toBe('INVITATION_HANDOFF_EXPIRED');
    const rescanned = await prepare(invite.token);
    expect(rescanned.handoff_id).not.toBe(first.handoff_id); expect(used(invite.id)).toBe(0);
  });

  it.each([
    ['revoked', "UPDATE invitations SET status='revoked' WHERE id=?", 410, 'INVITATION_EXPIRED'],
    ['deleted', "UPDATE invitations SET deleted_at='2026-01-01T00:00:00Z' WHERE id=?", 410, 'INVITATION_EXPIRED'],
    ['expired invitation', "UPDATE invitations SET expires_at='2000-01-01T00:00:00Z' WHERE id=?", 410, 'INVITATION_EXPIRED'],
    ['full', 'UPDATE invitations SET used_count=max_uses WHERE id=?', 409, 'INVITATION_FULL'],
  ] as const)('rechecks a %s invitation after preparation', async (_label, sql, status, code) => {
    const invite = await invitation(); const prepared = await prepare(invite.token);
    db.sqlite.prepare(sql).run(invite.id);
    const resume = await request('resume', credentials());
    expect(resume.status).toBe(status); expect(resume.json.error.code).toBe(code);
    const complete = await finish(prepared.handoff_id);
    expect(complete.status).toBe(status); expect(complete.json.error.code).toBe(code);
    expect(memberCount()).toBe(0);
  });

  it('refuses an inactive company after preparation', async () => {
    const invite = await invitation(); const prepared = await prepare(invite.token);
    db.sqlite.prepare("UPDATE companies SET status='inactive' WHERE id='a'").run();
    expect((await request('resume', credentials())).status).toBe(410);
    expect((await finish(prepared.handoff_id)).status).toBe(410);
    expect(used(invite.id)).toBe(0); expect(memberCount()).toBe(0);
  });

  it('allows an existing member to reuse a full same-company invitation but rejects a different company', async () => {
    const a = await invitation('a', 1); const b = await invitation('b'); link();
    db.sqlite.prepare('UPDATE invitations SET used_count=1 WHERE id=?').run(a.id);
    const same = await prepare(a.token);
    expect(same).toMatchObject({ pending: false, handoff_id: null, company_id: 'a', already_registered: true });
    expect(handoffCount()).toBe(0); expect(used(a.id)).toBe(1);
    const different = await request('prepare', { token: b.token, ...credentials() });
    expect(different.status).toBe(409); expect(different.json.error.code).toBe('ALREADY_REGISTERED');
    expect(used(b.id)).toBe(0); expect(memberCount()).toBe(1);
  });

  it('enforces the last remaining registration slot when two people confirm their pending invitations', async () => {
    const invite = await invitation('a', 1);
    const first = await prepare(invite.token, 0); const second = await prepare(invite.token, 1);
    expect(used(invite.id)).toBe(0); expect(handoffCount()).toBe(2);
    const results = await Promise.all([finish(first.handoff_id, 0), finish(second.handoff_id, 1)]);
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect(results.filter(result => result.status === 409)).toHaveLength(1);
    expect(used(invite.id)).toBe(1); expect(memberCount()).toBe(1);
  });

  it('does not duplicate a member or consume another slot for concurrent confirmation of one handoff', async () => {
    const invite = await invitation(); const prepared = await prepare(invite.token);
    const results = await Promise.all([finish(prepared.handoff_id), finish(prepared.handoff_id)]);
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect(results.filter(result => result.status === 409)).toHaveLength(1);
    expect(used(invite.id)).toBe(1); expect(memberCount()).toBe(1); expect(handoffCount()).toBe(0);
  });

  it('rolls back pending consumption, member creation and slot usage when the registration audit fails', async () => {
    const invite = await invitation(); const prepared = await prepare(invite.token);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.sqlite.exec("CREATE TRIGGER reject_handoff_audit BEFORE INSERT ON audit_logs WHEN NEW.action='LINE_USER_REGISTER' BEGIN SELECT RAISE(ABORT,'intentional audit failure'); END;");
    const failed = await finish(prepared.handoff_id);
    expect(failed.status).toBe(500);
    expect(used(invite.id)).toBe(0); expect(memberCount()).toBe(0); expect(handoffCount()).toBe(1);
    const recorded = JSON.stringify(logs.mock.calls);
    for (const secret of [invite.token, accounts[0].sub, accounts[0].id_token, accounts[0].access_token]) expect(recorded).not.toContain(secret);
    db.sqlite.exec('DROP TRIGGER reject_handoff_audit');
    expect((await finish(prepared.handoff_id)).status).toBe(200);
    expect(used(invite.id)).toBe(1); expect(handoffCount()).toBe(0);
  });
});
