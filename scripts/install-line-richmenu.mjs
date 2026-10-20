// Uses the existing owner login; the LINE access token stays inside the Worker.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(readFileSync(resolve(root, '.local/production-admin-credentials.json'), 'utf8'));
const base = new URL(credentials.url);
if (base.protocol !== 'https:' || base.hostname !== 'kojima-brewery-v2-a6577637.crossover-616.workers.dev') {
  throw new Error('Confirmed Kojima Brewery production URL is required.');
}
let cookie;
async function request(path, data) {
  const response = await fetch(new URL(path, base), {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: base.origin }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(90000),
  });
  const value = await response.json();
  if (!response.ok) {
    // Do not dump provider responses, passwords, cookies, or environment bindings.
    throw new Error(`Request failed: HTTP ${response.status}, ${value.error?.code ?? 'UNKNOWN_ERROR'}: ${value.error?.message ?? '処理できませんでした。'}`);
  }
  return { data: value.data, cookie: response.headers.get('set-cookie') };
}
try {
  const login = await request('/api/auth/admin/login', { login_id: credentials.login_id, password: credentials.password });
  if (login.data?.actor?.role !== 'owner' || !login.cookie) throw new Error('Owner login is required.');
  cookie = login.cookie.split(';')[0];
  const status = (await request('/api/admin/line/rich-menu')).data;
  console.log(JSON.stringify({ operation: 'rich_menu_status', configured: status.configured, bot: status.bot, current_default: status.default_rich_menu_id, default_menu_inaccessible: status.default_menu_inaccessible ?? false }, null, 2));
  if (process.argv.includes('--apply')) {
    const installed = (await request('/api/admin/line/rich-menu/install', {})).data;
    const verified = (await request('/api/admin/line/rich-menu')).data;
    if (!installed.rich_menu_id || verified.default_rich_menu_id !== installed.rich_menu_id) throw new Error('Default rich menu verification failed.');
    const evidence = {
      verified_at: new Date().toISOString(),
      official_account: verified.bot?.basic_id,
      rich_menu_id: installed.rich_menu_id,
      previous_rich_menu_id: installed.previous_rich_menu_id ?? null,
      previous_default_inaccessible: installed.previous_default_inaccessible ?? false,
      image_verified: installed.image_verified,
      already_installed: installed.already_installed,
      menu: installed.menu,
    };
    writeFileSync(resolve(root, '.local/line-richmenu-installation.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ operation: 'rich_menu_installed', ...evidence }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ operation: 'rich_menu_failed', message: error instanceof Error ? error.message : '処理できませんでした。' }));
  process.exitCode = 1;
} finally {
  if (cookie) {
    await request('/api/auth/logout', {}).catch(() => {});
    cookie = undefined;
  }
}
