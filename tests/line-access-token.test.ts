import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrateTestDatabase } from './helpers/migrate';
import type { Bindings } from '../src/server/types';

const SECRET = 'unit-test-channel-secret-not-for-production';
const ISSUED = 'unit-test-stateless-access-token';
const LEGACY = 'unit-test-existing-channel-token';
const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const issued = (access_token = ISSUED) => json({ access_token, token_type: 'Bearer', expires_in: 900 });
const environment = (overrides: Record<string, unknown> = {}) => ({ APP_ENV: 'production', LINE_MESSAGING_CHANNEL_ID: '2011903727', LINE_CHANNEL_SECRET: SECRET, ...overrides }) as unknown as Bindings;
const resolver = () => import('../src/server/line-access-token');

const recordingDatabases:DatabaseSync[]=[];
beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();for(const db of recordingDatabases.splice(0))db.close(); });

describe('LINE stateless access-token lifecycle', () => {
  it('issues a token with the Messaging channel credentials and prefers automation to an existing invalid token', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(TOKEN_URL);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('manual');
      const headers = new Headers(init?.headers);
      expect(headers.get('Content-Type')).toContain('application/x-www-form-urlencoded');
      expect(headers.has('Authorization')).toBe(false);
      const form = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: '2011903727', client_secret: SECRET });
      return issued();
    });
    vi.stubGlobal('fetch', fetcher);
    const { lineAccessTokenConfigured, resolveLineAccessToken } = await resolver();
    const env = environment({ LINE_CHANNEL_ACCESS_TOKEN: 'old-invalid-value' });
    expect(lineAccessTokenConfigured(env)).toBe(true);
    await expect(resolveLineAccessToken(env)).resolves.toBe(ISSUED);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares in-flight issuance and cache entries across requests with the same credentials', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn(async () => { await waiting; return issued(); });
    vi.stubGlobal('fetch', fetcher);
    const { resolveLineAccessToken } = await resolver();
    const results = Array.from({ length: 8 }, () => resolveLineAccessToken(environment()));
    try {
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    } finally { release(); }
    expect(await Promise.all(results)).toEqual(Array(8).fill(ISSUED));
    await expect(resolveLineAccessToken(environment())).resolves.toBe(ISSUED);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes before expiry and never returns an expired cached token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    const fetcher = vi.fn().mockResolvedValueOnce(issued('token-first')).mockResolvedValueOnce(issued('token-second')).mockResolvedValueOnce(issued('token-third'));
    vi.stubGlobal('fetch', fetcher);
    const { resolveLineAccessToken } = await resolver();
    await expect(resolveLineAccessToken(environment())).resolves.toBe('token-first');
    vi.setSystemTime(new Date('2026-10-20T00:13:59Z'));
    await expect(resolveLineAccessToken(environment())).resolves.toBe('token-first');
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-20T00:14:01Z'));
    await expect(resolveLineAccessToken(environment())).resolves.toBe('token-second');
    vi.setSystemTime(new Date('2026-10-20T00:30:00Z'));
    await expect(resolveLineAccessToken(environment())).resolves.toBe('token-third');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps rotated secrets and different Messaging channels out of each other’s cache', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(issued('first-credential-token')).mockResolvedValueOnce(issued('rotated-secret-token')).mockResolvedValueOnce(issued('other-channel-token'));
    vi.stubGlobal('fetch', fetcher);
    const { resolveLineAccessToken } = await resolver();
    await expect(resolveLineAccessToken(environment())).resolves.toBe('first-credential-token');
    await expect(resolveLineAccessToken(environment({ LINE_CHANNEL_SECRET: 'rotated-unit-test-secret' }))).resolves.toBe('rotated-secret-token');
    await expect(resolveLineAccessToken(environment({ LINE_MESSAGING_CHANNEL_ID: '2011903728' }))).resolves.toBe('other-channel-token');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('preserves existing long-token configuration when no automatic Messaging channel is selected', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { lineAccessTokenConfigured, resolveLineAccessToken } = await resolver();
    for (const missing of [{ LINE_MESSAGING_CHANNEL_ID: undefined }, { LINE_MESSAGING_CHANNEL_ID: undefined, LINE_CHANNEL_SECRET: undefined }]) {
      const env = environment({ ...missing, LINE_CHANNEL_ACCESS_TOKEN: LEGACY });
      expect(lineAccessTokenConfigured(env)).toBe(true);
      await expect(resolveLineAccessToken(env)).resolves.toBe(LEGACY);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not fall back to a legacy token when the explicitly selected automatic mode is misconfigured', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { lineAccessTokenConfigured, resolveLineAccessToken } = await resolver();
    for (const change of [{ LINE_CHANNEL_SECRET: undefined }, { LINE_MESSAGING_CHANNEL_ID: 'not-a-messaging-channel' }]) {
      const env = environment({ ...change, LINE_CHANNEL_ACCESS_TOKEN: LEGACY });
      expect(lineAccessTokenConfigured(env)).toBe(false);
      await expect(resolveLineAccessToken(env)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects missing credentials and invalid Messaging channel IDs without contacting LINE', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { lineAccessTokenConfigured, resolveLineAccessToken } = await resolver();
    for (const env of [environment({ LINE_CHANNEL_SECRET: undefined }), environment({ LINE_MESSAGING_CHANNEL_ID: 'https://other.example/' })]) {
      expect(lineAccessTokenConfigured(env)).toBe(false);
      await expect(resolveLineAccessToken(env)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not issue or return tokens from the resolver outside production', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { resolveLineAccessToken } = await resolver();
    await expect(resolveLineAccessToken(environment({ APP_ENV: 'development' }))).rejects.toThrow();
    await expect(resolveLineAccessToken(environment({ APP_ENV: 'development', LINE_CHANNEL_SECRET: undefined, LINE_CHANNEL_ACCESS_TOKEN: LEGACY }))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 302])('rejects provider HTTP %s without leaking its response or following a redirect', async status => {
    const fetcher = vi.fn(async () => json({ message: `${SECRET}:${ISSUED}` }, status));
    vi.stubGlobal('fetch', fetcher);
    const { resolveLineAccessToken } = await resolver();
    let caught: unknown;
    try { await resolveLineAccessToken(environment()); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(SECRET);
    expect(String(caught)).not.toContain(ISSUED);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { access_token: '', token_type: 'Bearer', expires_in: 900 },
    { access_token: 'token\r\nInjected: header', token_type: 'Bearer', expires_in: 900 },
    { access_token: ISSUED, token_type: 'Basic', expires_in: 900 },
    { access_token: ISSUED, token_type: 'Bearer', expires_in: 0 },
    { access_token: ISSUED, token_type: 'Bearer', expires_in: '900' },
  ])('rejects malformed token responses', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => json(response)));
    const { resolveLineAccessToken } = await resolver();
    await expect(resolveLineAccessToken(environment())).rejects.toThrow();
  });

  it('does not retain a rejected issuance promise or expose secret-bearing connection errors', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error(`network failure: ${SECRET} ${ISSUED}`)).mockResolvedValueOnce(issued());
    vi.stubGlobal('fetch', fetcher);
    const { resolveLineAccessToken } = await resolver();
    let caught: unknown;
    try { await resolveLineAccessToken(environment()); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(SECRET);
    expect(String(caught)).not.toContain(ISSUED);
    await expect(resolveLineAccessToken(environment())).resolves.toBe(ISSUED);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('notification authentication uses the shared resolver', () => {
  function recordingDatabase() {
    const records: unknown[][] = [],sqlite=new DatabaseSync(':memory:');
    migrateTestDatabase(sqlite);recordingDatabases.push(sqlite);
    function prepare(sql:string,values:any[]=[]):any{
      const execute=()=>{const result=sqlite.prepare(sql).run(...values);if(sql.includes('INSERT INTO audit_logs'))records.push(values);return {success:true,results:[],meta:{changes:Number(result.changes)}};};
      return {bind:(...args:any[])=>prepare(sql,args),first:async()=>sqlite.prepare(sql).get(...values)??null,run:async()=>execute(),execute};
    }
    const db={prepare,batch:async(statements:any[])=>{sqlite.exec('BEGIN');try{const results=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}} as unknown as D1Database;
    return { db, records };
  }

  it('uses an automatically issued token for a production notification and keeps secrets out of its audit', async () => {
    const { db, records } = recordingDatabase();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === TOKEN_URL) return issued();
      expect(String(input)).toBe('https://api.line.me/v2/bot/message/push');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${ISSUED}`);
      const body = JSON.parse(String(init?.body));
      expect(body.to).toBe('U-unit-test-user');
      expect(body.messages[0].type).toBe('text');
      return json({});
    });
    vi.stubGlobal('fetch', fetcher);
    const { notifyWelcome } = await import('../src/server/notifications');
    await expect(notifyWelcome(environment({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'invalid-old-value' }), 'U-unit-test-user', '担当者')).resolves.toEqual({ status: 'sent', channels: ['line'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(JSON.stringify(records)).not.toContain(ISSUED);
  });

  it('does not issue a token or send a notification in development', async () => {
    const { db, records } = recordingDatabase();
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { notifyWelcome } = await import('../src/server/notifications');
    await expect(notifyWelcome(environment({ DB: db, APP_ENV: 'development' }), 'U-unit-test-user', '担当者')).resolves.toEqual({ status: 'disabled', channels: [] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
  });
});
