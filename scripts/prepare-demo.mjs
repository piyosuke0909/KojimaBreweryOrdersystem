/**
 * Add clearly labelled, fictional test masters via the existing owner-only API.
 * Default is a read-only plan; --apply is required for application writes.
 * Credentials, cookies, LINE IDs and API response bodies are never logged.
 *   node scripts/prepare-demo.mjs --base-url https://confirmed.example --apply
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = 'KOJIMA_PUBLIC_DEMO_V1';
export const PREPARATION_FILE = resolve(ROOT, '.local/demo-preparation-state.json');
export const WORKFLOW_FILE = resolve(ROOT, '.local/demo-workflow-state.json');
export class SafeError extends Error {}
export const ensure = (value, message) => { if (!value) throw new SafeError(message); };
export function options(argv = process.argv.slice(2)) {
  const parsed = { apply: false, base: '', companyId: null, pdf: false, notifyLine: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--apply') parsed.apply = true;
    else if (value === '--pdf') parsed.pdf = true;
    else if (value === '--notify-line') parsed.notifyLine = true;
    else if (value === '--base-url') parsed.base = argv[++i] ?? '';
    else if (value.startsWith('--base-url=')) parsed.base = value.slice(11);
    else if (value === '--company-id') parsed.companyId = argv[++i] ?? '';
    else if (value.startsWith('--company-id=')) parsed.companyId = value.slice(13);
    else throw new SafeError('Unsupported command-line option.');
  }
  ensure(parsed.base, 'Provide --base-url explicitly. No remote writes occur without --apply.');
  return parsed;
}
export function privateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
export function readPrivate(path) {
  ensure(existsSync(path), 'The required private state file is missing.');
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new SafeError('The private state file could not be read.'); }
}
export function addDays(date, count) { return new Date(Date.parse(date + 'T00:00:00Z') + count * 86400000).toISOString().slice(0, 10); }
export function jstToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
export async function connectApi(baseInput) {
  const owner = readPrivate(resolve(ROOT, '.local/production-admin-credentials.json'));
  let base, confirmed;
  try { base = new URL(baseInput); confirmed = new URL(owner.url); }
  catch { throw new SafeError('The confirmed production URL is unavailable.'); }
  ensure(base.protocol === 'https:' && base.origin === confirmed.origin && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
    'Use the exact HTTPS origin recorded in the existing private owner configuration.');
  ensure(typeof owner.login_id === 'string' && typeof owner.password === 'string', 'Existing owner credentials are required.');
  let cookie;
  async function raw(path, method = 'GET', data) {
    ensure(path.startsWith('/api/') && !path.startsWith('//'), 'Only the same-origin application API is allowed.');
    let response;
    try {
      response = await fetch(new URL(path, base), {
        method, redirect: 'manual', signal: AbortSignal.timeout(45000),
        headers: { Accept: 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: base.origin }), ...(cookie ? { Cookie: cookie } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    } catch { throw new SafeError('Application API connection failed. No credential or response values were logged.'); }
    let result;
    try { result = await response.json(); }
    catch { throw new SafeError(`Application API returned an unreadable response (HTTP ${response.status}).`); }
    if (!response.ok) {
      const code = /^[A-Z0-9_]{1,60}$/.test(result?.error?.code ?? '') ? result.error.code : 'REQUEST_FAILED';
      throw new SafeError(`Application API request failed (HTTP ${response.status}; ${code}).`);
    }
    return { data: result.data, meta: result.meta, status: response.status, sessionCookie: response.headers.get('set-cookie') };
  }
  const login = await raw('/api/auth/admin/login', 'POST', { login_id: owner.login_id, password: owner.password });
  ensure(login.data?.actor?.type === 'admin' && login.data.actor.role === 'owner' && login.sessionCookie?.startsWith('kojima_session='), 'Existing owner login failed.');
  ensure(login.sessionCookie.includes('HttpOnly') && login.sessionCookie.includes('Secure'), 'A secure owner session is required.');
  cookie = login.sessionCookie.split(';')[0];
  const api = {
    origin: base.origin,
    request: raw,
    async get(path) { return (await raw(path)).data; },
    async write(path, data, method = 'POST') { return (await raw(path, method, data)).data; },
    async list(path) {
      const all = [];
      for (let page = 1; page <= 100; page++) {
        const response = await raw(path + (path.includes('?') ? '&' : '?') + `page_size=1000&page=${page}`);
        ensure(Array.isArray(response.data), 'Expected a paginated application response.');
        all.push(...response.data);
        if (!response.meta || all.length >= response.meta.total || !response.data.length) return all;
      }
      throw new SafeError('The application collection is too large for this demo helper.');
    },
    /** Owner cookie stays in memory. The relay preserves TLS validation via Node. */
    browserTransport: 'tls_verified_node_fetch',
    async browserContext(browser, { transport = 'tls_verified_node_fetch' } = {}) {
      ensure(transport === 'tls_verified_node_fetch', 'Only the verified same-origin browser transport is supported.');
      const context = await browser.newContext({ acceptDownloads: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
      await context.addCookies([{ name: 'kojima_session', value: cookie.slice('kojima_session='.length), url: base.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
      await context.route(base.origin + '/**', async (route) => {
        const request = route.request();
        let target;
        try { target = new URL(request.url()); } catch { await route.abort('failed'); return; }
        if (target.origin !== base.origin || target.protocol !== 'https:' || target.username || target.password) { await route.abort('failed'); return; }
        try {
          const headers = { ...await request.allHeaders() };
          for (const name of ['host', 'connection', 'accept-encoding', 'content-length']) delete headers[name];
          // Preserve the browser's current same-origin cookie jar, including logout.
          // allHeaders() includes Cookie; never replace it with a stale session.
          const body = request.postDataBuffer();
          const response = await fetch(target, { method: request.method(), headers, ...(body && !['GET', 'HEAD'].includes(request.method()) ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(45000) });
          const responseHeaders = Object.fromEntries(response.headers.entries());
          // Fetch has decoded compressed bodies; retaining these headers corrupts them.
          for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) delete responseHeaders[name];
          await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
        } catch { await route.abort('failed'); }
      });
      return context;
    },
    async close() { if (cookie) { await raw('/api/auth/logout', 'POST', {}).catch(() => {}); cookie = undefined; } },
  };
  return api;
}
const hasMarker = (row) => String(row?.note ?? '').includes(MARKER);
const isBlank = (value) => value == null || String(value).trim() === '';
const canonical = (key, value) => {
  if (key.endsWith('_json') && typeof value === 'string') { try { return JSON.stringify(JSON.parse(value)); } catch { return value; } }
  return value;
};
const changed = (current, desired) => Object.fromEntries(Object.entries(desired).filter(([key, value]) => canonical(key, current?.[key]) !== canonical(key, value)));
const note = (text) => `[デモ・架空] ${text} 実際の注文・配送・請求・送金には使用しないでください。 ${MARKER}`;
function owned(records, name) {
  const matches = records.filter((row) => row.name === name && hasMarker(row));
  ensure(matches.length <= 1, 'Duplicate owned demo records were found. Review them before continuing.');
  return matches[0];
}
export async function prepareDemo(api, opts, dependencies = {}) {
  const today = jstToday();
  const summary = { mode: opts.apply ? 'apply' : 'plan', created: {}, updated: {}, reused_existing: {}, preserved_calendar_days: 0, untouched: ['existing LINE registrations', 'existing customer/company values', 'original product prices and sales status', 'non-demo master records', 'existing calendar closures'] };
  const bump = (kind, resource) => { summary[kind][resource] = (summary[kind][resource] ?? 0) + 1; };
  async function upsert(resource, current, desired, path = `/api/admin/${resource}`, key = 'id') {
    if (!current) {
      bump('created', resource);
      return opts.apply ? api.write(path, desired) : { ...desired, [key]: desired[key] ?? `planned-${resource}-${summary.created[resource]}` };
    }
    const delta = changed(current, desired);
    if (!Object.keys(delta).length) return current;
    bump('updated', resource);
    return opts.apply ? api.write(path + '/' + encodeURIComponent(current[key]), delta, 'PUT') : { ...current, ...delta };
  }
  const [companies, products, rules, boxes, sizes, rates, calendar, issuer, config] = await Promise.all([
    api.list('/api/admin/companies'), api.list('/api/admin/products'), api.list('/api/admin/shipping-rules'), api.list('/api/admin/boxes'), api.list('/api/admin/sizes'), api.list('/api/admin/rates'),
    api.list(`/api/admin/calendar?from=${addDays(today, -14)}&to=${addDays(today, 89)}`), api.get('/api/admin/company-info'), api.get('/api/admin/settings'),
  ]);
  let company;
  if (opts.companyId) {
    company = companies.find((row) => row.id === opts.companyId && row.status === 'active');
    ensure(company, 'The selected active company was not found.');
  } else {
    const exact = companies.filter((row) => row.status === 'active' && ['A商店', 'Ａ商店', '[デモ] A商店', 'A商店（デモ）'].includes(row.name));
    ensure(exact.length <= 1, 'Multiple eligible companies exist. Supply --company-id without logging private user values.');
    company = exact[0];
  }
  if (!company) company = await upsert('companies', null, { name: '[デモ] A商店', contact_name: '[デモ] 動作確認担当', phone: '000-0000-0000', postal_code: '000-0000', address: '[デモ・架空] 東京都千代田区テスト町0-0', status: 'active', note: note('動作確認用の仮想取引先です。') });
  const companyPath = `/api/admin/companies/${encodeURIComponent(company.id)}`;
  const detail = company.id.startsWith('planned-') ? { addresses: [], prices: [], contracts: [], line_users: [] } : await api.get(companyPath);
  const activeLineCount = detail.line_users.filter((user) => user.status === 'active').length;
  const demoRules = {};
  for (const [code, name, method, free] of [['yamato', '[デモ] 宅配便（仮運賃）', 'yamato', 0], ['own', '[デモ] 自社便（通月・無料）', 'own_delivery', 1]]) {
    demoRules[code] = await upsert('shipping-rules', owned(rules, name), { name, target_condition_json: '{}', delivery_method: method, allowed_periods_json: '[]', is_free_shipping: free, status: 'active', note: note('この配送先専用のテスト用配送ルールです。') });
  }
  const demoAddresses = {};
  const activeDefault = detail.addresses.find((address) => address.status === 'active' && address.is_default === 1);
  const canSetDemoDefault = !activeDefault || hasMarker(activeDefault) || String(activeDefault.name ?? '').includes('デモ');
  for (const [code, name, prefecture, city] of [['yamato', '[デモ] 宅配配送先（東京・架空）', '東京都', '千代田区'], ['own', '[デモ] 自社便配送先（犬山・架空）', '愛知県', '犬山市']]) {
    const current = owned(detail.addresses, name);
    demoAddresses[code] = await upsert('addresses', current, { name, postal_code: '000-0000', prefecture, city, address_line1: 'テスト町0-0（架空住所）', address_line2: '動作確認用・発送厳禁', phone: '000-0000-0000', contact_name: '[デモ] 動作確認担当', is_default: canSetDemoDefault ? (code === 'yamato' ? 1 : 0) : (current?.is_default ?? 0), shipping_rule_id: demoRules[code].id, status: 'active', note: note('架空の配送先です。現実の配送住所として使用できません。') }, companyPath + '/addresses');
  }
  const definitions = [
    { code: 'small300', name: '[デモ] 忍冬酒 300ml', volume_ml: 300, standard_price: 1200, price: 1000, weight_kg: .6 },
    { code: 'small700', name: '[デモ] 忍冬酒 700ml', volume_ml: 700, standard_price: 2500, price: 2000, weight_kg: 1.2 },
    { code: 'large1800', name: '[デモ] 忍冬梅酒 1800ml', volume_ml: 1800, standard_price: 6500, price: 6000, weight_kg: 2.7 },
  ];
  const demoProducts = {};
  for (const def of definitions) {
    const current = owned(products, def.name);
    const product = await upsert('products', current, { name: def.name, category: '動作確認用（架空商品）', volume_ml: def.volume_ml, unit: '本', standard_price: def.standard_price, tax_type: 'excl', weight_kg: def.weight_kg, is_limited: 1, sales_status: 'on_sale', sort_order: 900 + definitions.indexOf(def), short_description: '動作確認専用の架空商品です。発送・請求・決済は行いません。', description: '画面と注文フローの確認用データです。実際の商品を表すものではありません。', commitment: 'デモ用の架空説明です。', taste: 'デモ用の架空説明です。', recommended_way: '実際の商品の飲用案内ではありません。', note: note('仮単価・仮重量を持つ専用商品です。正式商品の単価と重量は変更していません。') });
    const existingPrice = detail.prices.find((row) => row.product_id === product.id && row.status === 'active' && row.valid_from <= today && (!row.valid_to || row.valid_to >= today));
    ensure(!existingPrice || hasMarker(existingPrice), 'A non-demo company price already exists for an owned demo product. It was preserved.');
    if (!existingPrice || existingPrice.unit_price !== def.price || existingPrice.is_available !== 1) {
      bump(existingPrice ? 'updated' : 'created', 'company-prices');
      if (opts.apply) await api.write(companyPath + '/prices', { product_id: product.id, unit_price: def.price, is_available: 1, valid_from: today, note: note('この会社専用の動作確認価格です。') });
    }
    demoProducts[def.code] = { id: product.id, unit_price: def.price, weight_kg: def.weight_kg, volume_ml: def.volume_ml };
  }
  if (!detail.contracts.some((row) => row.status === 'active')) {
    await upsert('contracts', null, { contract_name: '[デモ] 月末締め翌月末払い', start_date: today, closing_day: 31, payment_terms: '[デモ] 月末締め翌月末払い（実請求なし）', status: 'active', note: note('帳票確認用の仮契約です。') }, companyPath + '/contracts');
  } else bump('reused_existing', 'active-contract');
  // Standard size limits come from the supplied design. Existing limits are never changed.
  for (const [size_code, max_three_sides_cm, max_weight_kg] of [['60', 60, 2], ['80', 80, 5], ['100', 100, 10], ['120', 120, 15], ['140', 140, 20], ['160', 160, 25]]) {
    if (sizes.some((row) => row.size_code === size_code)) { bump('reused_existing', 'sizes'); continue; }
    await upsert('sizes', null, { size_code, max_three_sides_cm, max_weight_kg, valid_from: today, status: 'active' }, '/api/admin/sizes', 'size_code');
  }
  const boxDefinitions = [
    { name: '[デモ] 小瓶2本箱', volumes: [300, 700], max_bottles: 2, length_cm: 24, width_cm: 12, height_cm: 32, box_weight_kg: .3, priority: 992 },
    { name: '[デモ] 小瓶6本箱', volumes: [300, 700], max_bottles: 6, length_cm: 30, width_cm: 20, height_cm: 32, box_weight_kg: .5, priority: 996 },
    { name: '[デモ] 一升瓶2本箱', volumes: [1800], max_bottles: 2, length_cm: 30, width_cm: 15, height_cm: 45, box_weight_kg: .5, priority: 992 },
    { name: '[デモ] 一升瓶6本箱', volumes: [1800], max_bottles: 6, length_cm: 40, width_cm: 30, height_cm: 45, box_weight_kg: 1, priority: 996 },
  ];
  for (const def of boxDefinitions) {
    const current = owned(boxes, def.name);
    const nonDemoCompatible = boxes.some((row) => row.status === 'active' && !hasMarker(row) && def.volumes.every((v) => { try { return JSON.parse(row.supported_volumes_json).includes(v); } catch { return false; } }));
    if (!current && nonDemoCompatible) { bump('reused_existing', 'boxes'); continue; }
    const { volumes, ...rest } = def;
    await upsert('boxes', current, { ...rest, supported_volumes_json: JSON.stringify(volumes), allow_mixed: 1, valid_from: current?.valid_from ?? today, status: 'active', note: note('寸法・重量は仮値です。実梱包には利用できません。') });
  }
  for (const [size, shipping_fee] of [['60', 600], ['80', 800], ['100', 1000], ['120', 1200], ['140', 1400], ['160', 1600]]) {
    const matching = rates.filter((row) => row.dest_region === '東京都' && row.size_code === size && (row.origin_region ?? '中部') === '中部');
    const current = matching.find(hasMarker);
    const existingReal = matching.some((row) => !hasMarker(row) && row.status === 'active' && (!row.valid_from || row.valid_from <= today) && (!row.valid_to || row.valid_to >= today));
    if (existingReal) { bump('reused_existing', 'rates'); continue; }
    await upsert('rates', current, { origin_region: '中部', dest_region: '東京都', size_code: size, shipping_fee, rate_type: 'standard', valid_from: current?.valid_from ?? today, status: 'active', note: note('仮運賃です。ヤマト運輸の正式な料金ではありません。') });
  }
  const calendarMap = new Map(calendar.map((row) => [row.date, row]));
  for (let day = -14; day <= 89; day++) {
    const date = addDays(today, day);
    if (calendarMap.has(date)) { summary.preserved_calendar_days++; continue; }
    const weekend = [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay());
    await upsert('calendar', null, { date, is_deliverable: weekend ? 0 : 1, reason: weekend ? '定休日' : null, note: note('仮の営業日です。土日休業・祝日未反映。正式な休業日は別途登録してください。') }, '/api/admin/calendar', 'date');
  }
  const issuerDefaults = {
    display_name: '[デモ] 小島醸造（動作確認用）', postal_code: '000-0000', address: '[デモ・架空] 愛知県犬山市テスト町0-0', tel: '000-0000-0000', email: 'demo@example.invalid', contact_person: '[デモ] 動作確認担当',
    bank_name: '[デモ・架空] サンプル銀行', bank_branch_name: '[デモ・架空] テスト支店', bank_account_type: '普通', bank_account_number: '0000000', bank_account_holder: 'デモ）コジマジョウゾウ',
  };
  const placeholder = (key, value) => isBlank(value) || (key === 'display_name' && value === '小島醸造') || (['tel', 'postal_code', 'bank_account_number'].includes(key) && /^0[-0]*$/.test(String(value))) || (key === 'email' && ['test@example.com', 'demo@example.invalid'].includes(value));
  const issuerChanges = Object.fromEntries(Object.entries(issuerDefaults).filter(([key]) => placeholder(key, issuer?.[key]) && issuer?.[key] !== issuerDefaults[key]));
  // A real issuer must keep its name. Never manufacture an eligible invoice registration number.
  const hasRealIssuer = ['address', 'tel', 'bank_name', 'bank_account_number', 'invoice_reg_no'].some((key) => !isBlank(issuer?.[key]) && !placeholder(key, issuer[key]) && !String(issuer[key]).includes('[デモ'));
  if (hasRealIssuer) delete issuerChanges.display_name;
  if (Object.keys(issuerChanges).length) {
    if (!hasMarker(issuer)) issuerChanges.note = [issuer?.note, note('空欄だけを仮設定しています。適格請求書登録番号は未登録のままです。')].filter(Boolean).join('\n');
    bump('updated', 'company-info');
    if (opts.apply) await api.write('/api/admin/company-info', issuerChanges, 'PUT');
  }
  const contactDefaults = { contact_phone: '000-0000-0000', contact_email: 'demo@example.invalid', contact_hours: '[デモ] 平日9:00〜17:00（実際の問い合わせ窓口ではありません）', notification_email: 'demo@example.invalid' };
  const contactChanges = Object.fromEntries(Object.entries(contactDefaults).filter(([key, value]) => key in config && (isBlank(config[key]) || ['test@example.com', '0000-00-0000'].includes(config[key])) && config[key] !== value));
  if (Object.keys(contactChanges).length) { bump('updated', 'settings'); if (opts.apply) await api.write('/api/admin/settings', contactChanges, 'PUT'); }
  const state = { schema: 1, marker: MARKER, origin: api.origin, prepared_at: new Date().toISOString(), company_id: company.id, product_ids: demoProducts, addresses: { yamato: demoAddresses.yamato.id, own: demoAddresses.own.id }, calendar_from: addDays(today, -14), calendar_to: addDays(today, 89), active_line_user_count: activeLineCount };
  if (opts.apply) (dependencies.persist ?? ((value) => privateJson(PREPARATION_FILE, value)))(state);
  return { ...summary, demo_products: definitions.length, demo_addresses: 2, existing_line_registrations_preserved: activeLineCount, calendar_days_considered: 104, line_notifications_sent: 0, formal_invoice_registration_number: 'not fabricated', ...(opts.apply ? { private_state_file: '.local/demo-preparation-state.json' } : {}) };
}
export async function runPreparation() {
  let api;
  try {
    const opts = options(); api = await connectApi(opts.base);
    const summary = await prepareDemo(api, opts);
    console.log(JSON.stringify({ operation: 'prepare_demo', ...summary }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ operation: 'prepare_demo_failed', message: error instanceof SafeError ? error.message : 'Unexpected demo preparation failure. Sensitive values were withheld.' }));
    process.exitCode = 1;
  } finally { await api?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPreparation();
