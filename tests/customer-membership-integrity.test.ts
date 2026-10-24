import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server';
import { resolveActor, signSession, verifySession } from '../src/server/auth';
import { issueInvitation } from '../src/server/services/invitations';
import type { Bindings } from '../src/server/types';
import { migrateTestDatabase } from './helpers/migrate';

class Database {
  sqlite = new DatabaseSync(':memory:'); beforeBatch: (() => void) | null = null;
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    const hook = this.beforeBatch; this.beforeBatch = null; hook?.();
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  binding() { return this as unknown as D1Database; }
}
class Statement {
  constructor(private db: Database, private sql: string, private args: any[] = []) { }
  bind(...args: any[]) { return new Statement(this.db, this.sql, args); }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { success: true, results: this.db.sqlite.prepare(this.sql).all(...this.args) }; }
  execute() { const result = this.db.sqlite.prepare(this.sql).run(...this.args); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async run() { return this.execute(); }
}
const origin = 'https://membership.example';
const owner = { id: 'membership-owner', name: '管理者', type: 'admin' as const, role: 'owner' };
const identities = ['MEMBERSHIP-LINE-A', 'MEMBERSHIP-LINE-B'];
let db: Database, env: Bindings, background: Promise<unknown>[], ownerCookie: string;
beforeEach(async () => {
  db = new Database(); migrateTestDatabase(db.sqlite);
  db.sqlite.exec("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('membership-owner','membership-owner','unused','管理者','owner'); INSERT INTO companies(id,name) VALUES('membership-a','A商店'),('membership-b','B商店');");
  env = { DB: db.binding(), APP_ENV: 'development', ALLOW_DEMO_AUTH: 'false', LINE_CHANNEL_ID: 'membership-login-channel', SESSION_SECRET: 'membership-tests-only-session-signing-key-at-least-32' } as Bindings;
  ownerCookie = 'kojima_session=' + await signSession(owner, env); background = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: RequestInit) => {
    const token = new URLSearchParams(String(init.body)).get('id_token');
    const identity = token === 'identity-b' ? identities[1] : identities[0];
    return Response.json({ sub: identity, name: '担当者', aud: env.LINE_CHANNEL_ID, iss: 'https://access.line.me', exp: Math.floor(Date.now() / 1000) + 600 });
  }));
});
afterEach(async () => { await Promise.allSettled(background); vi.unstubAllGlobals(); vi.restoreAllMocks(); db.sqlite.close(); });
async function request(path: string, input?: unknown, cookie?: string) {
  const response = await app.request(origin + path, { method: input === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }, env, { waitUntil: (promise: Promise<unknown>) => background.push(promise), passThroughOnException() { } } as any);
  return { status: response.status, data: await response.json() as any, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const member = () => db.sqlite.prepare('SELECT * FROM line_users WHERE line_user_id=?').get(identities[0]) as any;
const count = (table: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as any).count;
async function invite(company = 'membership-a', input: Record<string, unknown> = {}) { return issueInvitation(db.binding(), owner, company, { max_uses: 1, ...input }, origin); }
async function register(token: string) { return request('/api/public/invitations/register', { token, staff_name: '担当者', id_token: 'identity-a' }); }
async function prepare(token: string) { const result = await request('/api/public/invitations/prepare', { token, id_token: 'identity-a' }); expect(result.status).toBe(200); return result.data.data.handoff_id as string; }
async function finish(handoff: string, staff = '担当者', idToken = 'identity-a') { return request('/api/public/invitations/register-pending', { handoff_id: handoff, staff_name: staff, id_token: idToken }); }
async function unlink(company = 'membership-a') { return request(`/api/admin/companies/${company}/line-users/${member().id}/unlink`, {}, ownerCookie); }
async function encoded(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url'), seconds = Math.floor(Date.now() / 1000);
  const data = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ sub: identities[0], type: 'customer', iat: seconds, exp: seconds + 3600, reset_generation: 0, ...payload });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return data + '.' + Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64url');
}

describe('membership-bound customer sessions', () => {
  it('keeps every old cookie invalid after ordinary unlink and registration into another company', async () => {
    const first = await register((await invite()).token), old = first.cookie!;
    const claims = await verifySession(old.slice('kojima_session='.length), env);
    expect(claims).toMatchObject({ company_id: 'membership-a', membership_id: member().id, membership_version: 0 });
    expect((await request('/api/customer/me', undefined, old)).status).toBe(200);
    expect((await unlink()).status).toBe(200); expect(member().session_version).toBe(1);
    expect((await request('/api/customer/me', undefined, old)).status).toBe(401);
    const second = await register((await invite('membership-b')).token);
    expect(second.status).toBe(200); expect(member().session_version).toBe(2);
    expect((await request('/api/customer/me', undefined, old)).status).toBe(401);
    expect((await request('/api/customer/me', undefined, second.cookie)).data.data.company_id).toBe('membership-b');
  });
  it('does not revive old cookies when the same company registers the member again', async () => {
    const old = (await register((await invite()).token)).cookie!;
    await unlink(); const current = await register((await invite()).token);
    expect(current.status).toBe(200); expect((await request('/api/customer/me', undefined, old)).status).toBe(401);
    expect((await request('/api/customer/me', undefined, current.cookie)).status).toBe(200);
  });
  it('requires fresh LINE authentication for old bare-subject cookies and rejects incomplete membership claims', async () => {
    await register((await invite()).token);
    for (const claims of [{}, { membership_id: member().id }, { membership_id: member().id, company_id: 'membership-a', membership_version: -1 }]) {
      const token = await encoded(claims); expect(await verifySession(token, env)).toBeNull();
      expect((await request('/api/customer/me', undefined, 'kojima_session=' + token)).status).toBe(401);
    }
    const fresh = await request('/api/auth/line', { id_token: 'identity-a' }); expect(fresh.status).toBe(200);
    expect((await request('/api/customer/me', undefined, fresh.cookie)).status).toBe(200);
  });
  it('rejects a signed but stale membership version, company or row id and refuses signing a stale actor', async () => {
    await register((await invite()).token);
    const base = { membership_id: member().id, company_id: 'membership-a', membership_version: 0 };
    for (const claims of [{ ...base, membership_version: 1 }, { ...base, company_id: 'membership-b' }, { ...base, membership_id: 'another-registration' }]) {
      expect((await request('/api/customer/me', undefined, 'kojima_session=' + await encoded(claims))).status).toBe(401);
    }
    const stale = (await resolveActor(env, { sub: identities[0], type: 'customer' }))!;
    await unlink(); await register((await invite('membership-b')).token);
    await expect(signSession(stale, env)).rejects.toMatchObject({ status: 401 });
  });
  it('does not let an old-company unlink race revoke the newly relinked company member', async () => {
    await register((await invite()).token);
    db.beforeBatch = () => db.sqlite.prepare("UPDATE line_users SET company_id='membership-b',session_version=session_version+2 WHERE line_user_id=?").run(identities[0]);
    const result = await unlink(); expect(result.status).toBe(409);
    expect(member()).toMatchObject({ company_id: 'membership-b', status: 'active', session_version: 2 });
  });
});

describe('safe registration retry receipts', () => {
  it('returns the exact committed registration after a lost response without another slot or welcome notification', async () => {
    const invitation = await invite(), handoff = await prepare(invitation.token);
    const first = await finish(handoff), retry = await finish(handoff);
    expect(first.status).toBe(200); expect(retry.status).toBe(200); expect(retry.data.data.actor).toEqual(first.data.data.actor);
    expect(count('line_users')).toBe(1); expect(count('line_invitation_handoffs')).toBe(0);
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invitation.id)).toMatchObject({ used_count: 1 });
    await Promise.allSettled(background); expect((db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='NOTIFICATION_WELCOME'").get() as any).count).toBe(1);
    expect(member().registration_handoff_hash).toMatch(/^[a-f0-9]{64}$/); expect(member().registration_handoff_hash).not.toBe(handoff);
    const audit=JSON.stringify(db.sqlite.prepare("SELECT before_json,after_json FROM audit_logs WHERE action IN ('LINE_USER_REGISTER','LINE_USER_RELINK')").all());
    expect(audit).not.toContain('registration_handoff_hash'); expect(audit).not.toContain(member().registration_handoff_hash);
  });
  it('returns the same success for two simultaneous identical confirmations', async () => {
    const invitation = await invite(), handoff = await prepare(invitation.token);
    const results = await Promise.all([finish(handoff), finish(handoff)]);
    expect(results.map(result => result.status)).toEqual([200, 200]); expect(count('line_users')).toBe(1);
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invitation.id)).toMatchObject({ used_count: 1 });
    await Promise.allSettled(background); expect((db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='NOTIFICATION_WELCOME'").get() as any).count).toBe(1);
  });
  it('requires the exact person, Login channel and staff name for an already-completed receipt', async () => {
    const handoff = await prepare((await invite()).token); expect((await finish(handoff)).status).toBe(200);
    expect((await finish(handoff, '別の担当者名')).status).toBe(409);
    expect((await finish(handoff, '担当者', 'identity-b')).status).toBe(409);
    env.LINE_CHANNEL_ID = 'different-login-channel'; expect((await finish(handoff)).status).toBe(409);
    expect(count('line_users')).toBe(1);
  });
  it('preserves a committed receipt when its invite is later full or revoked, without registering again', async () => {
    const invitation = await invite(), handoff = await prepare(invitation.token); await finish(handoff);
    db.sqlite.prepare("UPDATE invitations SET status='revoked' WHERE id=?").run(invitation.id);
    expect((await finish(handoff)).status).toBe(200); expect(count('line_users')).toBe(1);
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(invitation.id)).toMatchObject({ used_count: 1 });
  });
  it('never restores a receipt after unlink or after registration into a different company', async () => {
    const handoff = await prepare((await invite()).token); await finish(handoff); await unlink();
    expect(member().registration_handoff_hash).toBeNull(); expect((await finish(handoff)).status).toBe(409);
    await register((await invite('membership-b')).token); expect((await finish(handoff)).status).toBe(409);
    expect(member().company_id).toBe('membership-b');
  });
  it.each(['invitation', 'handoff'])('checks the %s deadline at the final transaction clock', async target => {
    // A normal no-expiry invite avoids dependence on the host clock; expire only after validation.
    const valid = await invite(), handoff = await prepare(valid.token);
    db.beforeBatch = () => target === 'invitation'
      ? db.sqlite.prepare("UPDATE invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(valid.id)
      : db.sqlite.prepare("UPDATE line_invitation_handoffs SET created_at='1999-01-01T00:00:00.000Z',expires_at='2000-01-01T00:00:00.000Z' WHERE handoff_id=?").run(handoff);
    expect((await finish(handoff)).status).toBe(409); expect(count('line_users')).toBe(0); expect(count('line_invitation_handoffs')).toBe(1);
    expect(db.sqlite.prepare('SELECT used_count FROM invitations WHERE id=?').get(valid.id)).toMatchObject({ used_count: 0 });
  });
});
