import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

/** Migrations contain one complete SQL statement per semicolon followed by a newline. */
function migrationStatements() {
  const root = new URL('../migrations/', import.meta.url);
  return readdirSync(root).filter(name => /^\d+.*\.sql$/.test(name)).sort()
    .flatMap(name => readFileSync(new URL(name, root), 'utf8').split(/;\s*(?:\r?\n|$)/).map(sql => sql.trim()).filter(sql => sql && !/^\s*(?:--[^\n]*(?:\n|$)\s*)+$/.test(sql)));
}

it('executes the complete password-confirmed reset over HTTP with native workerd D1 and replaces the owner cookie', async () => {
  const bundled = await build({ stdin: { contents: `
    import app from './src/server/index';
    globalThis.fetch = async () => { throw new Error('External requests are forbidden in this test'); };
    export default app;
  `, loader: 'ts', resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
  const worker = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-19',
    d1Databases: ['DB'], script: bundled.outputFiles[0].text, bindings: {
      APP_ENV: 'production', SESSION_SECRET: 'isolated-runtime-reset-session-key-longer-than-32',
      ADMIN_BOOTSTRAP_PASSWORD: 'isolated-runtime-reset-password',
    },
  }));
  const origin = 'https://isolated-reset.example';
  let cookie = '';
  async function request(path: string, input?: unknown, session = cookie) {
    const response = await worker.dispatchFetch(origin + path, { method: input === undefined ? 'GET' : 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}),
    }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const database = await worker.getD1Database('DB');
    // Only this Miniflare instance exists here; no shared local or production database is used.
    for (const sql of migrationStatements()) await database.prepare(sql).run();
    const login = await request('/api/auth/admin/login', { login_id: 'admin', password: 'isolated-runtime-reset-password' });
    expect(login.status).toBe(200); expect(login.cookie).toBeTruthy(); cookie = login.cookie!;
    const original = await request('/api/admin/account'); expect(original.status).toBe(200);
    await database.batch([
      database.prepare("INSERT INTO companies(id,name) VALUES('old-company','削除対象の取引先')"),
      database.prepare("INSERT INTO settings(key,value) VALUES('tax_rate','8')"),
      database.prepare("INSERT INTO products(id,name,category,volume_ml,weight_kg) VALUES('old-product','削除対象の商品','テスト',500,1)"),
    ]);
    const prepared = await request('/api/admin/reset/prepare', { current_password: 'isolated-runtime-reset-password' });
    expect(prepared.status).toBe(200); expect(prepared.data.data.overview.counts.companies).toBe(1);
    expect((await database.prepare('SELECT COUNT(*) AS count FROM companies').first('count'))).toBe(1);
    const result = await request('/api/admin/reset/execute', { token: prepared.data.data.token, confirmation: '初期リセット' });
    expect(result.status).toBe(200); expect(result.data.data).toMatchObject({ reset: true, generation: 1 });
    expect(result.cookie).toBeTruthy(); expect(result.cookie).not.toBe(cookie);
    expect((await request('/api/admin/account')).status).toBe(401);
    cookie = result.cookie!;
    expect((await request('/api/admin/account')).data.data).toEqual(original.data.data);
    const after = await request('/api/admin/reset');
    expect(after.status).toBe(200); expect(after.data.data).toMatchObject({ generation: 1, can_reset: true, counts: { companies: 0, products: 11, audit_logs: 1, other_admins: 0 } });
    expect(await database.prepare("SELECT value FROM settings WHERE key='tax_rate'").first('value')).toBe('10');
    expect(await database.prepare("SELECT COUNT(*) AS count FROM products WHERE sales_status='unavailable'").first('count')).toBe(11);
    expect((await request('/api/admin/reset/execute', { token: prepared.data.data.token, confirmation: '初期リセット' })).status).toBe(409);
    const again = await request('/api/auth/admin/login', { login_id: 'admin', password: 'isolated-runtime-reset-password' });
    expect(again.status).toBe(200);
  } finally { await worker.dispose(); }
}, 30_000);
