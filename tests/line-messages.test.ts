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

const origin = 'https://orders.example';
const providerA = 'U' + 'a'.repeat(32), providerA2 = 'U' + 'b'.repeat(32), providerB = 'U' + 'c'.repeat(32);
const fixedToken = 'test-line-message-token-never-return';
const owner: Actor = { id: 'chat-owner', name: '管理者', type: 'admin', role: 'owner' };
const staff: Actor = { id: 'chat-staff', name: '別管理者', type: 'admin', role: 'staff' };
const customer: Actor = { id: providerA, name: '担当者A', type: 'customer', company_id: 'a' };
let db: SqliteD1, env: Bindings, pending: Promise<unknown>[];
let calls: { url: string; init?: RequestInit }[];
let response: () => Promise<Response>;
const json = (data: unknown = {}, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
beforeEach(() => {
  db = new SqliteD1(); migrateTestDatabase(db.sqlite);
  db.sqlite.exec(`INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('chat-owner','chat-owner','unused','管理者','owner'),('chat-staff','chat-staff','unused','別管理者','staff');
    INSERT INTO companies(id,name) VALUES('a','A商店'),('b','Bホテル');
    INSERT INTO line_users(id,company_id,line_user_id,staff_name,status) VALUES('member-a','a','${providerA}','担当者A','active'),('member-a2','a','${providerA2}','担当者A2','active'),('member-b','b','${providerB}','担当者B','active');`);
  env = { DB: db.binding(), APP_ENV: 'production', ALLOW_DEMO_AUTH: 'false', SESSION_SECRET: 'line-message-tests-only-secret-at-least-thirty-two-characters', LINE_CHANNEL_ACCESS_TOKEN: fixedToken, LINE_CHANNEL_SECRET: 'line-message-test-webhook-secret' } as Bindings;
  pending = []; calls = []; response = async () => json();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    calls.push({ url, init });
    return response();
  }));
});
afterEach(async () => { await Promise.allSettled(pending); vi.unstubAllGlobals(); vi.restoreAllMocks(); db.sqlite.close(); });
async function request(path: string, body?: unknown, who: Actor | null = owner, method = body === undefined ? 'GET' : 'POST', extraHeaders: Record<string, string> = {}) {
  const cookie = who ? 'kojima_session=' + await signSession(who, env) : null;
  const result = await app.request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }, env, { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext);
  return { status: result.status, value: await result.json() as any };
}
async function signed(events: unknown[], valid = true) {
  const body = JSON.stringify({ events });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(valid ? env.LINE_CHANNEL_SECRET : 'wrong-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('base64');
  return request('/api/line/webhook', body, null, 'POST', { 'x-line-signature': signature });
}
const message = (id: string, text = '注文について確認したいです', provider = providerA) => ({ type: 'message', webhookEventId: 'event-' + id, source: { type: 'user', userId: provider }, timestamp: Date.now(), message: { type: 'text', id: 'message-' + id, text } });
const send = (text = 'ご連絡ありがとうございます', requestId = crypto.randomUUID(), member = 'member-a', company = 'a', retry?: boolean) => request(`/api/admin/companies/${company}/line-messages/${member}`, { text, request_id: requestId, ...(retry ? { retry: true } : {}) });
const thread = (member = 'member-a', company = 'a', query = '') => request(`/api/admin/companies/${company}/line-messages/${member}${query}`);
const count = (table: string) => (db.sqlite.prepare('SELECT COUNT(*) count FROM ' + table).get() as any).count;
const audits = () => JSON.stringify(db.sqlite.prepare('SELECT before_json,after_json,note FROM audit_logs').all());
const notice = (who = owner) => request('/api/admin/notifications', undefined, who);

describe('LINE company conversations through authenticated routes and signed webhooks', () => {
  it('requires administrator authentication and keeps provider IDs and credentials out of conversation responses', async () => {
    expect((await request('/api/admin/companies/a/line-messages', undefined, null)).status).toBe(401);
    expect((await request('/api/admin/companies/a/line-messages', undefined, customer)).status).toBe(403);
    expect((await request('/api/admin/companies/a/line-messages/member-a', { text: 'no', request_id: crypto.randomUUID() }, customer)).status).toBe(403);
    await signed([message('a')]);
    for (const result of [await request('/api/admin/companies/a/line-messages'), await thread()]) {
      expect(result.status).toBe(200); expect(JSON.stringify(result.value)).not.toContain(providerA); expect(JSON.stringify(result.value)).not.toContain(fixedToken);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects unsigned or forged webhook bodies before storing messages or notifications', async () => {
    expect((await request('/api/line/webhook', { events: [message('forged')] }, null)).status).toBe(401);
    expect((await signed([message('wrong')], false)).status).toBe(401);
    expect(count('line_messages')).toBe(0); expect(count('admin_notifications')).toBe(0);
  });

  it('stores a verified message and its notification once across redelivery and alternate event IDs', async () => {
    const event = message('replayed', '同じ本文を重複して保存しない');
    for (const incoming of [event, { ...event, deliveryContext: { isRedelivery: true } }, { ...event, webhookEventId: 'alternate-event' }]) expect((await signed([incoming])).status).toBe(200);
    expect(count('line_messages')).toBe(1); expect(count('admin_notifications')).toBe(1);
    const result = (await thread()).value.data;
    expect(result.messages[0]).toMatchObject({ direction: 'incoming', status: 'received', line_user_id: 'member-a', text: event.message.text });
    expect(result.messages[0].sequence).toBeGreaterThan(0);
    expect((await notice()).value.data).toMatchObject({ total_unread: 1, counts: { orders: 0, companies: 1 } });
    expect(audits()).not.toContain(event.message.text); expect(audits()).not.toContain(providerA);
  });

  it('ignores unknown users, inactive companies, unlinked members, group events and diagnostic-only phrases', async () => {
    db.sqlite.exec("UPDATE companies SET status='inactive' WHERE id='b'; UPDATE line_users SET status='unlinked' WHERE id='member-a2'");
    const group = { ...message('group'), source: { type: 'group', userId: providerA } };
    await signed([message('unknown', '秘密', 'U' + 'd'.repeat(32)), message('inactive', '秘密', providerB), message('unlinked', '秘密', providerA2), group, message('diagnostic', '通知確認-ABC123')]);
    expect(count('line_messages')).toBe(0); expect(count('admin_notifications')).toBe(0); expect(audits()).not.toContain('秘密');
    expect((await notice()).value.data.total_unread).toBe(0);
  });

  it('records non-text arrivals as fixed placeholders without retaining provider attachment data', async () => {
    const event = { ...message('image'), message: { type: 'image', id: 'message-image', originalContentUrl: 'https://private.example/image', text: 'PRIVATE_ATTACHMENT_VALUE' } };
    await signed([event]);
    const result = (await thread()).value.data.messages[0];
    expect(result.message_type).toBe('image'); expect(result.text).toContain('画像を受信');
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM line_messages').all())).not.toContain('PRIVATE_ATTACHMENT_VALUE');
    expect(count('admin_notifications')).toBe(1);
  });

  it('removes unsent text and prevents a late original event from restoring it', async () => {
    const first = message('remove', 'UNSENT_PRIVATE_TEXT'); await signed([first]);
    const unsend = { type: 'unsend', source: first.source, unsend: { messageId: first.message.id } };
    await signed([unsend]); await signed([first]);
    expect((await thread()).value.data.messages[0]).toMatchObject({ text: '送信が取り消されました', message_type: 'unsent' });
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM line_messages').all())).not.toContain('UNSENT_PRIVATE_TEXT');
    const later = message('preempt', 'NEVER_PERSIST_THIS');
    await signed([{ type: 'unsend', source: later.source, unsend: { messageId: later.message.id } }, later]);
    expect(count('line_messages')).toBe(1); expect(count('admin_notifications')).toBe(1);
    expect(audits()).not.toContain('NEVER_PERSIST_THIS');
  });

  it('honors a known sender unsend after unlinking or disabling the company without accepting new messages', async () => {
    const event = message('inactive-unsend', 'REMOVE_AFTER_UNLINK'); await signed([event]);
    db.sqlite.exec("UPDATE line_users SET status='unlinked' WHERE id='member-a'; UPDATE companies SET status='inactive',deleted_at='2026-10-22T01:00:00Z' WHERE id='a'");
    expect((await signed([{ type: 'unsend', source: event.source, unsend: { messageId: event.message.id } }, message('inactive-new', 'DO_NOT_PERSIST_INACTIVE')])).status).toBe(200);
    const records = JSON.stringify(db.sqlite.prepare('SELECT * FROM line_messages').all());
    expect(records).not.toContain('REMOVE_AFTER_UNLINK'); expect(records).not.toContain('DO_NOT_PERSIST_INACTIVE');
    expect(count('line_messages')).toBe(1); expect(count('admin_notifications')).toBe(1);
  });

  it('redacts the same provider message after its existing member record moves to a different company', async () => {
    const event = message('moved-member', 'REMOVE_AFTER_MOVE'); await signed([event]);
    db.sqlite.exec("UPDATE line_users SET company_id='b' WHERE id='member-a'");
    await signed([{ type: 'unsend', source: event.source, unsend: { messageId: event.message.id } }]);
    expect((db.sqlite.prepare('SELECT company_id,text FROM line_messages').get() as any)).toMatchObject({ company_id: 'a', text: '送信が取り消されました' });
  });

  it('prefers active recent conversations or newer registrations and includes a date to distinguish same-name members', async () => {
    db.sqlite.exec("UPDATE line_users SET staff_name='同じ担当者',registered_at='2025-01-01T00:00:00Z' WHERE id='member-a'; UPDATE line_users SET staff_name='同じ担当者',registered_at='2026-10-22T00:00:00Z' WHERE id='member-a2'");
    let contacts = (await request('/api/admin/companies/a/line-messages')).value.data.contacts;
    expect(contacts.map((value: any) => value.id)).toEqual(['member-a2', 'member-a']);
    expect(contacts[0].registered_at).toBe('2026-10-22T00:00:00Z');
    await signed([message('recent-old-member')]);
    contacts = (await request('/api/admin/companies/a/line-messages')).value.data.contacts;
    expect(contacts.map((value: any) => value.id)).toEqual(['member-a', 'member-a2']);
    expect(contacts[0].last_message.sequence).toBeGreaterThan(0);
    db.sqlite.exec("UPDATE line_users SET status='unlinked' WHERE id='member-a'");
    expect((await request('/api/admin/companies/a/line-messages')).value.data.contacts[0].id).toBe('member-a2');
  });

  it('keeps message and notification atomic when notification storage fails', async () => {
    db.sqlite.exec("CREATE TRIGGER fail_chat_notification BEFORE INSERT ON admin_notifications BEGIN SELECT RAISE(ABORT,'test-notification-failure'); END;");
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await signed([message('atomic', 'DO_NOT_LOG_BODY')])).status).toBe(500);
    expect(count('line_messages')).toBe(0); expect(count('admin_notifications')).toBe(0);
    expect(JSON.stringify(logger.mock.calls)).not.toContain('DO_NOT_LOG_BODY');
  });

  it('returns stable chronological pages even when all arrival timestamps match', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
    try {
      for (let index = 0; index < 5; index++) await signed([message('page-' + index, '順番' + index)]);
      const latest = (await thread('member-a', 'a', '?limit=2')).value.data;
      expect(latest.messages.map((value: any) => value.text)).toEqual(['順番3', '順番4']);
      const earlier = (await thread('member-a', 'a', '?limit=2&before=' + latest.next_cursor)).value.data;
      expect(earlier.messages.map((value: any) => value.text)).toEqual(['順番1', '順番2']);
      expect(latest.messages[0].sequence).toBeLessThan(latest.messages[1].sequence);
      expect((await thread('member-b', 'b', '?before=' + latest.messages[0].id)).status).toBe(400);
    } finally { vi.useRealTimers(); }
  });

  it('acknowledges only loaded incoming IDs for this administrator and exact conversation', async () => {
    await signed([message('seen'), message('unseen'), message('other-member', '別担当者', providerA2), message('other-company', '別会社', providerB)]);
    const records = (await thread()).value.data.messages;
    const ownId = records.find((value: any) => value.text === '注文について確認したいです').id;
    const foreignId = (await thread('member-b', 'b')).value.data.messages[0].id;
    expect((await request('/api/admin/companies/a/line-messages/member-a/read', { message_ids: [ownId, foreignId, 'unknown'] })).status).toBe(200);
    expect((await notice()).value.data.total_unread).toBe(3);
    expect((await notice(staff)).value.data.total_unread).toBe(4);
    expect((await request('/api/admin/companies/a/line-messages/member-b/read', { message_ids: [foreignId] })).status).toBe(404);
    expect((await thread('member-b', 'a')).status).toBe(404);
  });

  it('sends the confirmed text using a fixed HTTPS destination and UUID retry key, without exposing content in audit', async () => {
    const requestId = crypto.randomUUID(), text = 'CONFIRMED_CUSTOMER_MESSAGE';
    const sent = await send(text, requestId);
    expect(sent.status).toBe(201); expect(sent.value.data).toMatchObject({ direction: 'outgoing', status: 'sent', text, line_user_id: 'member-a' });
    expect(calls).toHaveLength(1); expect(calls[0].init?.redirect).toBe('manual');
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer ' + fixedToken); expect(headers.get('X-Line-Retry-Key')).toBe(requestId);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ to: providerA, messages: [{ type: 'text', text }] });
    const duplicate = await send(text, requestId); expect(duplicate.value.data.id).toBe(sent.value.data.id); expect(calls).toHaveLength(1);
    expect(count('line_messages')).toBe(1); expect(count('admin_notifications')).toBe(0);
    expect(audits()).not.toContain(text); expect(audits()).not.toContain(fixedToken); expect(audits()).not.toContain(providerA);
  });

  it('rejects a reused request ID with a different text or company before making another provider call', async () => {
    const requestId = crypto.randomUUID(); await send('元の本文', requestId);
    expect((await send('別の本文', requestId)).status).toBe(409);
    expect((await send('元の本文', requestId, 'member-b', 'b')).status).toBe(409);
    expect((await send('元の本文', crypto.randomUUID(), 'member-b', 'a')).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('lets concurrent duplicates share a pending claim and performs only one external send', async () => {
    let started!: () => void, finish!: (value: Response) => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    response = () => { started(); return new Promise<Response>(resolve => { finish = resolve; }); };
    const requestId = crypto.randomUUID();
    const first = send('同時送信', requestId); await began;
    const duplicate = await send('同時送信', requestId);
    expect(duplicate.status).toBe(202); expect(duplicate.value.data.status).toBe('pending'); expect(calls).toHaveLength(1);
    finish(json()); expect((await first).value.data.status).toBe('sent'); expect(count('line_messages')).toBe(1);
  });

  it('does not send in development, without credentials, to an inactive member or inactive company', async () => {
    env.APP_ENV = 'development'; expect((await send()).status).toBe(409);
    env.APP_ENV = 'production'; env.LINE_CHANNEL_ACCESS_TOKEN = undefined; expect((await send()).status).toBe(503);
    env.LINE_CHANNEL_ACCESS_TOKEN = fixedToken;
    db.sqlite.exec("UPDATE line_users SET status='unlinked' WHERE id='member-a'"); expect((await send()).status).toBe(409);
    db.sqlite.exec("UPDATE line_users SET status='active' WHERE id='member-a'; UPDATE companies SET status='inactive' WHERE id='a'"); expect((await send()).status).toBe(409);
    expect(calls).toHaveLength(0); expect(count('line_messages')).toBe(0);
  });

  it('revalidates the member after token issuance so an intervening unlink cannot send to the stale recipient', async () => {
    env.LINE_MESSAGING_CHANNEL_ID = '2011903727';
    const provider = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://api.line.me/oauth2/v3/token');
      db.sqlite.exec("UPDATE line_users SET status='unlinked' WHERE id='member-a'");
      return json({ access_token: 'test-issued-line-token', token_type: 'Bearer', expires_in: 900 });
    });
    vi.stubGlobal('fetch', provider);
    const result = await send('途中解除');
    expect(result.value.data).toMatchObject({ status: 'failed', error_code: 'LINE_CONTACT_INACTIVE' });
    expect(provider).toHaveBeenCalledTimes(1); expect(count('line_messages')).toBe(1);
  });

  it('uses an unknown outcome after timeout and safely confirms the same retry key via LINE acceptance', async () => {
    response = async () => { throw new Error('unconfirmed transport'); };
    const requestId = crypto.randomUUID();
    const timedOut = await send('到達確認', requestId); expect(timedOut.value.data).toMatchObject({ status: 'unknown', can_retry: true, error_code: 'LINE_DELIVERY_UNCONFIRMED' });
    response = async () => json({}, 409, { 'x-line-accepted-request-id': 'accepted-request' });
    const retried = await send('到達確認', requestId, 'member-a', 'a', true);
    expect(retried.value.data.status).toBe('sent'); expect(calls).toHaveLength(2);
    expect(new Headers(calls[0].init?.headers).get('X-Line-Retry-Key')).toBe(new Headers(calls[1].init?.headers).get('X-Line-Retry-Key'));
    expect(count('line_messages')).toBe(1);
  });

  it('distinguishes provider rejection, uncertain server error, and a 409 lacking accepted-request proof', async () => {
    for (const [status, expected] of [[401, 'failed'], [500, 'unknown'], [409, 'failed']] as const) {
      response = async () => json({ message: fixedToken + ' secret response body' }, status);
      const result = await send('結果' + status);
      expect(result.value.data.status).toBe(expected); expect(result.value.data.error_code).toBe('LINE_HTTP_' + status);
      expect(JSON.stringify(result.value)).not.toContain(fixedToken);
    }
  });

  it('reclaims an abandoned claim only after its lease and refuses retries near LINE retry-key expiry', async () => {
    response = async () => { throw new Error('network'); };
    const requestId = crypto.randomUUID(); await send('再試行', requestId);
    db.sqlite.prepare("UPDATE line_messages SET status='pending',send_claimed_at=? WHERE request_id=?").run(new Date().toISOString(), requestId);
    expect((await send('再試行', requestId, 'member-a', 'a', true)).status).toBe(409);
    db.sqlite.prepare('UPDATE line_messages SET send_claimed_at=? WHERE request_id=?').run(new Date(Date.now() - 121000).toISOString(), requestId);
    response = async () => json();
    expect((await send('再試行', requestId, 'member-a', 'a', true)).value.data.status).toBe('sent');
    const expired = crypto.randomUUID(); response = async () => { throw new Error('network'); }; await send('期限後', expired);
    db.sqlite.prepare('UPDATE line_messages SET created_at=? WHERE request_id=?').run(new Date(Date.now() - 24 * 3600000).toISOString(), expired);
    const before = calls.length; expect((await send('期限後', expired, 'member-a', 'a', true)).status).toBe(409); expect(calls).toHaveLength(before);
  });

  it('retains an uncertain result rather than claiming success when delivery-result audit persistence fails', async () => {
    db.sqlite.exec("CREATE TRIGGER fail_send_result BEFORE INSERT ON audit_logs WHEN NEW.action='LINE_MESSAGE_SEND_RESULT' BEGIN SELECT RAISE(ABORT,'test-result-audit-failure'); END;");
    const result = await send('保存障害'); expect(result.value.data).toMatchObject({ status: 'unknown', can_retry: false, error_code: 'LINE_DELIVERY_RECORDING_FAILED' });
    expect(calls).toHaveLength(1); expect((db.sqlite.prepare('SELECT status FROM line_messages').get() as any).status).toBe('pending');
  });

  it('does not contact LINE if the durable send claim and audit cannot be committed', async () => {
    db.sqlite.exec("CREATE TRIGGER fail_send_claim BEFORE INSERT ON audit_logs WHEN NEW.action='LINE_MESSAGE_SEND_REQUEST' BEGIN SELECT RAISE(ABORT,'test-claim-audit-failure'); END;");
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await send('保存前には送信しない')).status).toBe(500);
    expect(calls).toHaveLength(0); expect(count('line_messages')).toBe(0);
  });
});
