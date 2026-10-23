import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/server';
import { hashPassword, signSession } from '../src/server/auth';
import type { Actor, Bindings } from '../src/server/types';
import { resetTables } from '../src/server/services/system-reset';
import { resetCompanyInfo, resetProducts, resetSettings } from '../src/shared/reset-defaults';
import { migrateTestDatabase } from './helpers/migrate';

class SqliteD1 {
  sqlite = new DatabaseSync(':memory:'); beforeBatch: (() => void) | null = null; queryCount = 0;
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    const hook = this.beforeBatch; this.beforeBatch = null; hook?.();
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const result = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  binding() { return this as unknown as D1Database; }
}
class Statement {
  constructor(private db: SqliteD1, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.db, this.sql, args); }
  async first() { this.db.queryCount++; return this.db.sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { this.db.queryCount++; return { success: true, results: this.db.sqlite.prepare(this.sql).all(...this.args) }; }
  execute() {
    this.db.queryCount++;
    const query = this.db.sqlite.prepare(this.sql);
    const results = query.columns().length ? query.all(...this.args) : [];
    const result = query.columns().length ? null : query.run(...this.args);
    return { success: true, results, meta: { changes: Number(result?.changes ?? 0) } };
  }
  async run() { return this.execute(); }
}
const origin = 'https://reset.example', password = 'reset-owner-private-current-password';
let db: SqliteD1, env: Bindings, owner: Actor, staff: Actor, otherOwner: Actor, oldHash: string, cookie: string, staffCookie: string, customerCookie: string;
beforeEach(async () => {
  db = new SqliteD1(); migrateTestDatabase(db.sqlite);
  owner = { id: 'reset-owner-' + crypto.randomUUID(), name: '維持する管理者', type: 'admin', role: 'owner' };
  staff = { id: 'reset-staff', name: '削除する担当者', type: 'admin', role: 'staff' };
  otherOwner = { id: 'reset-other-owner', name: '別オーナー', type: 'admin', role: 'owner' };
  oldHash = await hashPassword(password);
  for (const [who, login] of [[owner, 'reset-owner'], [staff, 'reset-staff'], [otherOwner, 'reset-other-owner']] as const) {
    db.sqlite.prepare('INSERT INTO admins(id,login_id,password_hash,name,role) VALUES(?,?,?,?,?)').run(who.id, login, oldHash, who.name, who.role!);
  }
  db.sqlite.exec(readFileSync(new URL('../seeds/production.sql', import.meta.url), 'utf8'));
  seedPrivateData();
  env = { DB: db.binding(), APP_ENV: 'production', ALLOW_DEMO_AUTH: 'false', SESSION_SECRET: 'reset-test-only-session-secret-longer-than-32-characters', LINE_CHANNEL_ID: 'same-login-channel', LIFF_ID: 'same-liff', LINE_CHANNEL_SECRET: 'same-private-secret', LINE_CHANNEL_ACCESS_TOKEN: 'same-private-access-token' } as Bindings;
  cookie = 'kojima_session=' + await signSession(owner, env); staffCookie = 'kojima_session=' + await signSession(staff, env);
  customerCookie = 'kojima_session=' + await signSession({ id: 'RESET-LINE-CUSTOMER', name: '担当者', type: 'customer' }, env);
});
afterEach(() => db.sqlite.close());
function insert(table: string, row: Record<string, any>) {
  db.sqlite.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}
const count = (table: string) => Number((db.sqlite.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as any).count);
const admin = () => db.sqlite.prepare('SELECT * FROM admins WHERE id=?').get(owner.id) as any;
function seedPrivateData() {
  db.sqlite.exec(`
    UPDATE products SET image_url='https://private.example/image',weight_kg=9,sales_status='on_sale',standard_price=999999,note='PRIVATE-PRODUCT';
    UPDATE settings SET value='PRIVATE-CONTACT' WHERE key='contact_email';
    INSERT INTO settings(key,value) VALUES('custom-private-setting','PRIVATE-SETTING');
    UPDATE company_info SET address='PRIVATE-ISSUER',bank_name='PRIVATE-BANK';
    UPDATE report_settings SET invoice_title='PRIVATE-TITLE',invoice_note_template='PRIVATE-REPORT';
    INSERT INTO companies(id,name,address,note) VALUES('reset-company','PRIVATE-COMPANY','PRIVATE-ADDRESS','PRIVATE-COMPANY-NOTE');
    INSERT INTO shipping_rules(id,name,delivery_method) VALUES('reset-rule','PRIVATE-RULE','own_delivery');
    INSERT INTO shipping_addresses(id,company_id,name,postal_code,prefecture,city,address_line1,phone,shipping_rule_id) VALUES('reset-address','reset-company','PRIVATE-RECIPIENT','0000000','愛知県','犬山市','PRIVATE-HOME','0000000000','reset-rule');
    INSERT INTO invitations(id,company_id,token_hash,expires_at,note) VALUES('reset-invite','reset-company','PRIVATE-QR','9999-12-31T00:00:00.000Z','PRIVATE-QR-NOTE');
    INSERT INTO line_users(id,company_id,line_user_id,staff_name,invitation_id) VALUES('reset-member','reset-company','RESET-LINE-CUSTOMER','PRIVATE-STAFF','reset-invite');
    INSERT INTO contracts(id,company_id,contract_name,start_date) VALUES('reset-contract','reset-company','PRIVATE-CONTRACT','2026-01-01');
    INSERT INTO company_product_prices(id,company_id,product_id,unit_price,valid_from) VALUES('reset-price','reset-company','samurai-300',12,'2026-01-01');
    INSERT INTO delivery_calendar(date,is_deliverable,reason) VALUES('2099-12-20',0,'PRIVATE-HOLIDAY');
    INSERT INTO yamato_sizes(size_code,max_three_sides_cm,max_weight_kg) VALUES('reset-size',60,2);
    INSERT INTO yamato_rates(id,origin_region,dest_region,size_code,rate_type,shipping_fee,valid_from) VALUES('reset-fare','中部','中部','reset-size','contract',12,'2026-01-01');
  `);
  // Read actual field names for the packing fixture from the same production schema.
  insert('packaging_boxes', { id: 'reset-box', name: 'PRIVATE-BOX', length_cm: 10, width_cm: 10, height_cm: 10, box_weight_kg: 1, max_bottles: 1, supported_volumes_json: '[300]' });
  insert('line_invitation_handoffs', { subject_hash: 'f'.repeat(64), handoff_id: 'PRIVATE-HANDOFF', invitation_id: 'reset-invite', created_at: '2026-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' });
  insert('orders', { id: 'reset-order', request_id: 'PRIVATE-REQUEST', company_id: 'reset-company', contract_id: 'reset-contract', ordered_by_line_user_id: 'RESET-LINE-CUSTOMER', ordered_by_name: 'PRIVATE-STAFF', ordered_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', desired_delivery_date: '2099-12-20', shipping_address_id: 'reset-address', snap_recipient_name: 'PRIVATE-RECIPIENT', snap_postal_code: '0000000', snap_address: 'PRIVATE-HOME', items_subtotal: 100, shipping_fee: 0, snap_tax_rate: 10, snap_tax_calc_unit: 'invoice', snap_tax_rounding: 'floor', tax_amount: 10, total_amount: 110 });
  insert('order_items', { id: 'reset-item', order_id: 'reset-order', line_no: 1, product_id: 'samurai-300', snap_product_name: 'PRIVATE-SNAP', snap_volume_ml: 300, snap_unit: '本', unit_price: 100, quantity: 1, subtotal: 100 });
  insert('order_packages', { id: 'reset-parcel', order_id: 'reset-order', package_no: 1, packaging_box_id: 'reset-box', size_code: 'reset-size' });
  insert('order_package_items', { id: 'reset-parcel-item', order_package_id: 'reset-parcel', order_id: 'reset-order', product_id: 'samurai-300', quantity: 1 });
  insert('order_revisions', { id: 'reset-revision', order_id: 'reset-order', revision_no: 1, changed_at: '2026-01-01T00:00:00.000Z', changer_type: 'customer', before_json: '{"private":"PRIVATE-BEFORE"}', after_json: '{"private":"PRIVATE-AFTER"}', before_total: 110, after_total: 110 });
  insert('order_requests', { request_id: 'reset-order-request', line_user_id: 'RESET-LINE-CUSTOMER', company_id: 'reset-company', status: 'completed', order_id: 'reset-order' });
  insert('invoices', { id: 'reset-invoice', company_id: 'reset-company', contract_id: 'reset-contract', period_start: '2026-01-01', period_end: '2026-01-31', subtotal_excl_tax: 100, tax_amount: 10, total_incl_tax: 110, snap_company_info_json: '{"private":"PRIVATE-ISSUER"}' });
  insert('invoice_items', { id: 'reset-invoice-item', invoice_id: 'reset-invoice', line_no: 1, order_id: 'reset-order', amount_excl_tax: 100, tax_amount: 10, amount_incl_tax: 110 });
  insert('invoice_histories', { id: 'reset-invoice-history', invoice_id: 'reset-invoice', version: 1, action_type: 'issue', acted_at: '2026-01-01T00:00:00.000Z', acted_by: staff.id, snapshot_json: '{"private":"PRIVATE-INVOICE"}' });
  insert('delivery_note_histories', { id: 'reset-delivery-history', order_id: 'reset-order', invoice_id: 'reset-invoice', version: 1, request_id: 'PRIVATE-DELIVERY-REQ', request_hash: 'PRIVATE-HASH', snapshot_json: '{"private":"PRIVATE-DELIVERY"}', issued_at: '2026-01-01T00:00:00.000Z', issued_by: staff.id, source_order_version: 1, source_invoice_version: 1 });
  insert('line_messages', { id: 'reset-message', company_id: 'reset-company', line_user_id: 'reset-member', direction: 'incoming', text: 'PRIVATE-MESSAGE', status: 'received', created_at: '2026-01-01T00:00:00.000Z' });
  insert('line_message_unsends', { line_message_id: 'PRIVATE-UNSENT', line_user_id: 'reset-member', created_at: '2026-01-01T00:00:00.000Z' });
  insert('admin_notifications', { id: 'reset-alert', event_key: 'PRIVATE-ALERT', kind: 'line_message', category: 'companies', company_id: 'reset-company', line_user_id: 'reset-member', title: 'PRIVATE-ALERT-TITLE', created_at: '2026-01-01T00:00:00.000Z' });
  insert('admin_notification_reads', { notification_id: 'reset-alert', admin_id: staff.id, read_at: '2026-01-01T00:00:00.000Z' });
  insert('email_notification_config', { id: 1, enabled: 1, recipients_json: '["private@example.test"]', sender_email: 'private@example.test', gmail_client_id: 'PRIVATE-CLIENT', gmail_client_secret_ciphertext: 'PRIVATE-CIPHER', gmail_refresh_token_ciphertext: 'PRIVATE-REFRESH', app_origin: origin, version: 41, updated_at: '2026-01-01T00:00:00.000Z' });
  insert('gmail_oauth_states', { state_hash: 'a'.repeat(64), admin_id: staff.id, code_verifier_ciphertext: 'PRIVATE-VERIFIER', client_id: 'PRIVATE-CLIENT', redirect_uri: origin, config_version: 41, created_at: '2026-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' });
  insert('audit_logs', { id: 'reset-audit', acted_at: '2026-01-01T00:00:00.000Z', actor_type: 'admin', actor_id: staff.id, action: 'PRIVATE-ACTION', target_type: 'companies', target_id: 'reset-company', after_json: '{"private":"PRIVATE-AUDIT"}' });
}
async function request(path = '', input?: unknown, session: string | null = cookie, extraHeaders: Record<string, string> = {}) {
  const response = await app.request(origin + '/api/admin/reset' + path, { method: input === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}), ...extraHeaders }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }, env);
  return { status: response.status, body: await response.json() as any, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null };
}
const prepare = () => request('/prepare', { current_password: password });
async function token() { const result = await prepare(); expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body.data.token as string; }
const execute = (token: string, extra: Record<string, unknown> = {}, session: string | null = cookie) => request('/execute', { token, confirmation: '初期リセット', ...extra }, session);
const state = () => db.sqlite.prepare('SELECT generation,data_revision FROM system_state WHERE id=1').get() as any;

describe('password-confirmed initial reset', () => {
  it('tracks every production data table explicitly and restores defaults from the seed source', () => {
    const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map(row => row.name).sort();
    expect([...resetTables, 'admins', 'system_state', 'system_task_leases', 'system_reset_challenges'].sort()).toEqual(tables);
    const pristine = new DatabaseSync(':memory:'); migrateTestDatabase(pristine); pristine.exec(readFileSync(new URL('../seeds/production.sql', import.meta.url), 'utf8'));
    expect(pristine.prepare('SELECT key,value FROM settings ORDER BY key').all()).toEqual(Object.entries(resetSettings).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })));
    expect(pristine.prepare('SELECT ' + Object.keys(resetProducts[0]).join(',') + ' FROM products ORDER BY sort_order').all()).toEqual(resetProducts);
    expect(pristine.prepare('SELECT id,company_name,display_name,note FROM company_info').get()).toEqual(resetCompanyInfo); pristine.close();
  });
  it('only permits owners and denies anonymous, staff and customer use for all reset endpoints', async () => {
    for (const session of [null, staffCookie, customerCookie]) {
      const expected = session ? 403 : 401;
      expect((await request('', undefined, session)).status).toBe(expected);
      expect((await request('/prepare', { current_password: password }, session)).status).toBe(expected);
      expect((await execute('a'.repeat(64), {}, session)).status).toBe(expected);
    }
    expect(count('system_reset_challenges')).toBe(0); expect(count('companies')).toBe(1);
  });
  it('shows safe counts, excludes preserved owner and does not modify data on GET', async () => {
    const before = state(), result = await request(); expect(result.status).toBe(200);
    expect(result.body.data.counts).toMatchObject({ companies: 1, orders: 1, products: 11, other_admins: 2 });
    expect(result.body.data).toMatchObject({ defaults: { product_count: 11, products_unavailable: true }, preserved: ['current_owner_login', 'line_cloudflare_connection'], can_reset: true });
    expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE-|password|cipher|RESET-LINE|private@example/); expect(state()).toEqual(before);
  });
  it('checks current password and rate-limits repeated failures without writing private input', async () => {
    for (let index = 0; index < 8; index++) expect((await request('/prepare', { current_password: 'wrong-private-password' })).status).toBe(400);
    const result = await prepare(); expect(result.status).toBe(429); expect(count('system_reset_challenges')).toBe(0); expect(count('companies')).toBe(1);
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM audit_logs').all())).not.toContain('wrong-private-password');
  });
  it('blocks cross-site reset operations and unrecognized scope/password bypass input', async () => {
    expect((await request('/prepare', { current_password: password }, cookie, { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await request('/prepare', { current_password: password, scope: 'everything' })).status).toBe(400);
    const next = await token(); expect((await execute(next, { confirmation: 'リセット' })).status).toBe(400);
    expect((await execute(next, { tables: ['companies'] })).status).toBe(400); expect(count('companies')).toBe(1);
  });
  it('stores only a one-use token digest and does not reset anything when preparing', async () => {
    const before = state(), result = await prepare(); expect(result.status).toBe(200); const challenge = db.sqlite.prepare('SELECT * FROM system_reset_challenges').get() as any;
    expect(result.body.data.token).toMatch(/^[a-f0-9]{64}$/); expect(challenge.token_hash).not.toBe(result.body.data.token); expect(challenge.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(challenge.credential_fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(challenge)).not.toContain(password); expect(JSON.stringify(challenge)).not.toContain(oldHash);
    expect(count('orders')).toBe(1); expect(state()).toEqual(before);
  });
  it('atomically clears every data class, restores defaults and retains owner credentials and environment', async () => {
    const before = { ...admin() }, next = await token(); db.queryCount = 0;
    const result = await execute(next), invocationQueries = db.queryCount;
    expect(result.status, JSON.stringify(result.body)).toBe(200); expect(result.body.data).toMatchObject({ reset: true, generation: 1 });
    expect(invocationQueries).toBeLessThanOrEqual(50);
    for (const table of resetTables) if (!['products', 'settings', 'company_info', 'report_settings', 'email_notification_config', 'audit_logs'].includes(table)) expect(count(table), table).toBe(0);
    expect(count('admins')).toBe(1); expect(admin()).toEqual({ ...before, session_version: 1 }); expect(count('system_reset_challenges')).toBe(0);
    expect(db.sqlite.prepare('SELECT key,value FROM settings ORDER BY key').all()).toEqual(Object.entries(resetSettings).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })));
    expect(db.sqlite.prepare('SELECT ' + Object.keys(resetProducts[0]).join(',') + ' FROM products ORDER BY sort_order').all()).toEqual(resetProducts);
    const mail = db.sqlite.prepare('SELECT * FROM email_notification_config').get() as any; expect(mail).toMatchObject({ enabled: 0, version: 42, recipients_json: '[]', sender_email: '', gmail_client_id: '', gmail_client_secret_ciphertext: null, gmail_refresh_token_ciphertext: null });
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0); expect(state()).toEqual({ generation: 1, data_revision: 1 });
    const receipt = db.sqlite.prepare('SELECT * FROM audit_logs').all() as any[]; expect(receipt).toHaveLength(1); expect(receipt[0]).toMatchObject({ action: 'SYSTEM_RESET', actor_id: owner.id, before_json: null });
    expect(JSON.stringify({ receipt, result: result.body, mail })).not.toMatch(/PRIVATE-|private@example|pbkdf2|reset-owner-private/);
    expect(JSON.stringify(resetTables.flatMap(table => db.sqlite.prepare(`SELECT * FROM ${table}`).all()))).not.toMatch(/PRIVATE-|private@example/);
    expect(env.LINE_CHANNEL_ID).toBe('same-login-channel'); expect(env.LINE_CHANNEL_ACCESS_TOKEN).toBe('same-private-access-token');
    expect((await request('', undefined, result.cookie)).status).toBe(200); expect((await request()).status).toBe(401);
  });
  it('rejects stale owner/customer cookies even after the same LINE subject registers again', async () => {
    const result = await execute(await token()); expect(result.status).toBe(200);
    db.sqlite.exec("INSERT INTO companies(id,name) VALUES('new-company','新規取引先');INSERT INTO line_users(id,company_id,line_user_id,staff_name) VALUES('new-member','new-company','RESET-LINE-CUSTOMER','再登録担当者');");
    const response = await app.request(origin + '/api/customer/me', { headers: { Cookie: customerCookie } }, env); expect(response.status).toBe(401);
    const fresh = 'kojima_session=' + await signSession({ id: 'RESET-LINE-CUSTOMER', name: '再登録担当者', type: 'customer' }, env);
    expect((await app.request(origin + '/api/customer/me', { headers: { Cookie: fresh } }, env)).status).toBe(200);
    expect((await execute('a'.repeat(64))).status).toBe(401);
  });
  it('rejects expiry, forged or another-owner challenges without deleting anything', async () => {
    expect((await execute('a'.repeat(64))).status).toBe(409);
    const next = await token(), alternate = 'kojima_session=' + await signSession(otherOwner, env); expect((await execute(next, {}, alternate)).status).toBe(409);
    db.sqlite.exec("UPDATE system_reset_challenges SET created_at='2000-01-01T00:00:00.000Z',expires_at='2000-01-01T00:05:00.000Z'");
    expect((await execute(next)).status).toBe(409); expect(count('orders')).toBe(1); expect(state().generation).toBe(0);
  });
  it('binds preview to every business change and requires fresh password review', async () => {
    const next = await token(); const update = await app.request(origin + '/api/admin/companies/reset-company', { method: 'PUT', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '変更後の会社', contact_name: '', phone: '', postal_code: '', address: '', status: 'active', note: '' }) }, env);
    expect(update.status).toBe(200); expect(state().data_revision).toBeGreaterThan(0);
    expect((await execute(next)).status).toBe(409); expect(count('companies')).toBe(1);
  });
  it('invalidates a prepared challenge after login credentials change', async () => {
    const next = await token(); db.sqlite.prepare('UPDATE admins SET login_id=? WHERE id=?').run('revised-owner', owner.id);
    const response = await execute(next); expect(response.status).toBe(409); expect(response.body.error.code).toBe('RESET_ACCOUNT_CHANGED'); expect(count('orders')).toBe(1);
  });
  it('does not issue a challenge if credentials change after the password check', async () => {
    db.beforeBatch = () => db.sqlite.prepare('UPDATE admins SET login_id=? WHERE id=?').run('raced-owner', owner.id);
    expect((await prepare()).status).toBe(409); expect(count('system_reset_challenges')).toBe(0); expect(count('orders')).toBe(1);
  });
  it('refuses an active send and permits expired leases without retaining stale task metadata', async () => {
    const next = await token(); insert('system_task_leases', { id: 'active-send', generation: 0, kind: 'line_delivery', expires_at: '9999-01-01T00:00:00.000Z' });
    expect((await request()).body.data).toMatchObject({ active_tasks: 1, can_reset: false }); expect((await execute(next)).status).toBe(409);
    db.sqlite.exec("UPDATE system_task_leases SET expires_at='2000-01-01T00:00:00.000Z'"); expect((await execute(next)).status).toBe(200); expect(count('system_task_leases')).toBe(0);
  });
  it('blocks a new lease or data revision that wins the race immediately before reset transaction', async () => {
    const next = await token(); db.beforeBatch = () => insert('system_task_leases', { id: 'raced-send', generation: 0, kind: 'email_delivery', expires_at: '9999-01-01T00:00:00.000Z' });
    expect((await execute(next)).status).toBe(409); expect(count('orders')).toBe(1); expect(state().generation).toBe(0);
    db.sqlite.exec('DELETE FROM system_task_leases'); db.beforeBatch = () => db.sqlite.exec('UPDATE system_state SET data_revision=data_revision+1');
    expect((await execute(next)).status).toBe(409); expect(count('orders')).toBe(1);
  });
  it('rechecks challenge expiry inside the atomic transaction rather than accepting an earlier snapshot', async () => {
    const next = await token(); db.beforeBatch = () => db.sqlite.exec("UPDATE system_reset_challenges SET created_at='2000-01-01T00:00:00.000Z',expires_at='2000-01-01T00:05:00.000Z'");
    expect((await execute(next)).status).toBe(409); expect(count('orders')).toBe(1); expect(state().generation).toBe(0);
  });
  it('rolls back deletion, new defaults, token consumption and owner session revocation on any failure', async () => {
    const next = await token(), before = { ...admin() }; db.sqlite.exec("CREATE TRIGGER fail_reset BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT,'reset fixture failure'); END");
    expect((await execute(next)).status).toBe(500); expect(count('orders')).toBe(1); expect(count('companies')).toBe(1); expect(count('delivery_note_histories')).toBe(1); expect(admin()).toEqual(before); expect(state()).toEqual({ generation: 0, data_revision: 0 }); expect(count('system_reset_challenges')).toBe(1);
    db.sqlite.exec('DROP TRIGGER fail_reset'); expect((await execute(next)).status).toBe(200);
  });
  it('consumes the reset token once and requires a fresh password for a second reset', async () => {
    const next = await token(), result = await execute(next); expect(result.status).toBe(200);
    expect((await execute(next, {}, result.cookie)).status).toBe(409); expect(state().generation).toBe(1);
    cookie = result.cookie!; expect((await execute(await token())).status).toBe(200); expect(state().generation).toBe(2); expect(admin().session_version).toBe(2);
  });
});
