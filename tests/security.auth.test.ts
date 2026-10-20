import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { demoEnabled, checkPassword, hashPassword, signSession, verifySession } from '../src/server/auth';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8787';

test('uses salted PBKDF2 password hashes and rejects a wrong password', async () => {
  const first = await hashPassword('test-password-for-hash-only');
  const second = await hashPassword('test-password-for-hash-only');
  expect(first).not.toBe(second);
  expect(first).toMatch(/^pbkdf2-sha256\$100000\$/);
  expect(first).not.toContain('test-password-for-hash-only');
  expect(await checkPassword('test-password-for-hash-only', first)).toBe(true);
  expect(await checkPassword('incorrect-password', first)).toBe(false);
});

test('requires a signed, unmodified session and confines demos to local development', async () => {
  const env = { SESSION_SECRET: 'unit-test-only-'.repeat(4), APP_ENV: 'development', ALLOW_DEMO_AUTH: 'true' } as any;
  const token = await signSession({ id: 'test', type: 'admin', name: '検証' }, env);
  expect(await verifySession(token, env)).toMatchObject({ sub: 'test', type: 'admin' });
  expect(await verifySession(token.slice(0, -4) + 'abcd', env)).toBeNull();
  expect(await verifySession(token, { ...env, SESSION_SECRET: 'different-secret'.repeat(4) })).toBeNull();
  expect(demoEnabled(env, base)).toBe(true);
  expect(demoEnabled({ ...env, APP_ENV: 'production' }, base)).toBe(false);
  expect(demoEnabled(env, 'https://public-preview.example')).toBe(false);
});

test('the generated administrator password can log in even after demo use', async () => {
  let password = process.env.TEST_ADMIN_PASSWORD;
  if (!password) {
    const vars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    const match = vars.match(/^ADMIN_BOOTSTRAP_PASSWORD=(.+)$/m);
    if (match) password = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
  }
  if (!password) throw new Error('Run npm run setup, or securely set TEST_ADMIN_PASSWORD before the administrator login check.');
  const response = await fetch(`${base}/api/auth/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login_id: 'admin', password }),
  });
  // Neither the generated password nor any serialized login request is included in assertions.
  expect(response.status).toBe(200);
  const cookieHeader = response.headers.get('set-cookie') || '';
  expect(cookieHeader).toMatch(/HttpOnly/i);
  expect(cookieHeader).toMatch(/SameSite=Strict/i);
  const cookie = cookieHeader.split(';', 1)[0];
  const profile = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  expect(profile.status).toBe(200);
  expect((await profile.json() as any).data.actor).toMatchObject({ type: 'admin', role: 'owner' });
  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  expect(logout.status).toBe(200);
  expect(logout.headers.get('set-cookie')).toMatch(/Max-Age=0/);
});
