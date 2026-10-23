import type { Actor, Bindings } from '../types';
import { checkPassword } from '../auth';
import { getSystemGeneration, unwrapSystemDatabase } from '../system-state';
import { fail, insert, insertMany, one } from './common';
import { resetCompanyInfo, resetProducts, resetSettings } from '../../shared/reset-defaults';

// This list is deliberately authored here: clients cannot choose tables or reset scopes.
export const resetTables = [
  'admin_notification_reads', 'admin_notifications', 'delivery_note_histories',
  'invoice_histories', 'invoice_items', 'invoices', 'order_package_items',
  'order_packages', 'order_items', 'order_revisions', 'order_requests', 'orders',
  'line_messages', 'line_message_unsends', 'line_users', 'line_invitation_handoffs',
  'invitations', 'company_product_prices', 'contracts', 'shipping_addresses',
  'companies', 'products', 'yamato_rates', 'yamato_sizes', 'packaging_boxes',
  'shipping_rules', 'delivery_calendar', 'gmail_oauth_states',
  'email_notification_config', 'company_info', 'report_settings', 'settings', 'audit_logs',
] as const;
type ResetCounts = Record<(typeof resetTables)[number] | 'other_admins', number>;
export type ResetOverview = {
  generation: number; data_revision: number; counts: ResetCounts; active_tasks: number;
  defaults: { product_count: number; products_unavailable: true };
  preserved: ['current_owner_login', 'line_cloudflare_connection']; can_reset: boolean;
};
type Admin = { id: string; login_id: string; name: string; role: string; password_hash: string; session_version: number };
type Challenge = { admin_id: string; session_version: number; credential_fingerprint: string; generation: number; data_revision: number; counts_json: string; expires_at: string };
const attempts = new Map<string, { count: number; until: number }>();
const lifetime = 5 * 60 * 1000;
const changed = () => fail(409, 'RESET_PREVIEW_CHANGED', '確認後にデータが変更されました。現在のパスワードを入力し、対象をもう一度確認してください。');
const invalid = () => fail(409, 'RESET_CHALLENGE_INVALID', '確認の有効時間が切れているか、すでに使用されています。パスワードを入力してやり直してください。');
const busy = () => fail(409, 'RESET_BUSY', '通知の送信処理中です。処理が終わってから、リセット対象をもう一度確認してください。');
const stamp = () => new Date().toISOString();
async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(value => value.toString(16).padStart(2, '0')).join('');
}
const fingerprint = (admin: Admin) => digest(JSON.stringify([admin.id, admin.login_id, admin.password_hash, admin.session_version]));
function requireOwner(who: Actor) {
  if (who.type !== 'admin' || who.role !== 'owner') fail(403, 'OWNER_REQUIRED', '初期リセットはオーナー管理者だけが使用できます。');
}
async function administrator(db: D1Database, who: Actor): Promise<Admin> {
  requireOwner(who);
  const row = await one(db, "SELECT id,login_id,name,role,password_hash,session_version FROM admins WHERE id=? AND status='active' AND role='owner'", who.id) as Admin | null;
  const expected = (who as Actor & { session_version?: number }).session_version ?? 0;
  if (!row || row.session_version !== expected) fail(409, 'RESET_ACCOUNT_CHANGED', '管理者のログイン設定が変わりました。ログインし直してください。');
  return row!;
}
/** One SELECT provides a consistent review without counting reset metadata as business changes. */
export async function resetOverview(env: Bindings, who: Actor): Promise<ResetOverview> {
  requireOwner(who);
  const db = unwrapSystemDatabase(env.DB);
  const columns = resetTables.map(table => `(SELECT COUNT(*) FROM ${table}) AS ${table}`).join(',');
  const row = await one(db, `SELECT generation,data_revision,${columns},(SELECT COUNT(*) FROM admins WHERE id!=?) AS other_admins,(SELECT COUNT(*) FROM system_task_leases WHERE expires_at>?) AS active_tasks FROM system_state WHERE id=1`, who.id, stamp());
  if (!row || row.generation !== await getSystemGeneration(env)) changed();
  const counts = Object.fromEntries([...resetTables, 'other_admins'].map(table => [table, Number(row![table])])) as ResetCounts;
  return { generation: row!.generation, data_revision: row!.data_revision, counts, active_tasks: Number(row!.active_tasks), defaults: { product_count: resetProducts.length, products_unavailable: true }, preserved: ['current_owner_login', 'line_cloudflare_connection'], can_reset: Number(row!.active_tasks) === 0 };
}
function stateAndAccount(db: D1Database, overview: Pick<ResetOverview, 'generation' | 'data_revision'>, admin: Admin) {
  // Invalid JSON aborts the D1 transaction. A later failure therefore cannot leave a partial reset.
  return db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM system_state WHERE id=1 AND generation=? AND data_revision=?) AND EXISTS(SELECT 1 FROM admins WHERE id=? AND role='owner' AND status='active' AND session_version=? AND login_id=? AND password_hash=?) THEN 'null' ELSE 'RESET_PREVIEW_CHANGED' END)")
    .bind(overview.generation, overview.data_revision, admin.id, admin.session_version, admin.login_id, admin.password_hash);
}
function intentionalGuardFailure(error: unknown) { return /malformed JSON/i.test(String(error)); }
export async function prepareSystemReset(env: Bindings, who: Actor, password: string) {
  const db = unwrapSystemDatabase(env.DB), admin = await administrator(db, who);
  const now = Date.now(), key = admin.id, rate = attempts.get(key);
  if (rate && rate.until > now && rate.count >= 8) fail(429, 'PASSWORD_CHECK_RATE_LIMIT', 'しばらく待ってからもう一度お試しください。');
  if (!await checkPassword(password, admin.password_hash)) {
    const next = rate && rate.until > now ? rate : { count: 0, until: now + 15 * 60 * 1000 }; next.count++; attempts.set(key, next);
    if (attempts.size > 10000) for (const [id, value] of attempts) if (value.until <= now) attempts.delete(id);
    fail(400, 'CURRENT_PASSWORD_INCORRECT', '現在のパスワードが違います。');
  }
  const overview = await resetOverview(env, who);
  if (!overview.can_reset) busy();
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
  const tokenHash = await digest(token), credentialFingerprint = await fingerprint(admin);
  const created = new Date(now).toISOString(), expires = new Date(now + lifetime).toISOString();
  try {
    await db.batch([
      stateAndAccount(db, overview, admin),
      db.prepare('DELETE FROM system_reset_challenges WHERE admin_id=? OR expires_at<=?').bind(admin.id, created),
      insert(db, 'system_reset_challenges', { token_hash: tokenHash, admin_id: admin.id, session_version: admin.session_version, credential_fingerprint: credentialFingerprint, generation: overview.generation, data_revision: overview.data_revision, counts_json: JSON.stringify(overview.counts), created_at: created, expires_at: expires }),
    ]);
  } catch (error) { if (intentionalGuardFailure(error)) changed(); throw error; }
  attempts.delete(key);
  return { token, expires_at: expires, overview };
}
export async function executeSystemReset(env: Bindings, who: Actor, token: string) {
  requireOwner(who);
  const db = unwrapSystemDatabase(env.DB), tokenHash = await digest(token), at = stamp();
  // Fetch credentials, token binding and the monotonic mail version together to fit D1 Free's query budget.
  const row = await one(db, `SELECT a.id,a.login_id,a.name,a.role,a.password_hash,a.session_version,
    c.admin_id,c.session_version challenge_session_version,c.credential_fingerprint,c.generation,c.data_revision,c.counts_json,c.expires_at,
    COALESCE((SELECT version FROM email_notification_config WHERE id=1),0) mail_version
    FROM admins a LEFT JOIN system_reset_challenges c ON c.token_hash=? AND c.admin_id=a.id
    WHERE a.id=? AND a.role='owner' AND a.status='active'`, tokenHash, who.id);
  const expected = (who as Actor & { session_version?: number }).session_version ?? 0;
  if (!row || row.session_version !== expected) fail(409, 'RESET_ACCOUNT_CHANGED', '管理者のログイン設定が変わりました。ログインし直してください。');
  const admin = row as Admin;
  const challenge = row!.admin_id ? { ...row, session_version: row!.challenge_session_version } as Challenge : null;
  if (!challenge || challenge.admin_id !== admin.id || challenge.expires_at <= at) invalid();
  if (challenge!.session_version !== admin.session_version || challenge!.credential_fingerprint !== await fingerprint(admin)) fail(409, 'RESET_ACCOUNT_CHANGED', '管理者のログイン設定が変わりました。パスワードを入力してやり直してください。');
  const current = await resetOverview(env, who);
  if (current.generation !== challenge!.generation || current.data_revision !== challenge!.data_revision) changed();
  if (!current.can_reset) busy();
  const counts = JSON.parse(challenge!.counts_json) as ResetCounts;
  const version = admin.session_version + 1, generation = current.generation + 1;
  const statements: D1PreparedStatement[] = [
    stateAndAccount(db, current, admin),
    db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM system_reset_challenges WHERE token_hash=? AND admin_id=? AND session_version=? AND credential_fingerprint=? AND generation=? AND data_revision=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND NOT EXISTS(SELECT 1 FROM system_task_leases WHERE expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN 'null' ELSE 'RESET_PREVIEW_CHANGED' END)")
      .bind(tokenHash, admin.id, admin.session_version, challenge!.credential_fingerprint, current.generation, current.data_revision),
    // Company/order/member ON DELETE CASCADE clears both notification tables and reads.
    ...resetTables.filter(table => table !== 'admin_notifications' && table !== 'admin_notification_reads').map(table => db.prepare(`DELETE FROM ${table}`)),
    db.prepare('DELETE FROM system_reset_challenges'),
    db.prepare('DELETE FROM system_task_leases'),
    db.prepare('DELETE FROM admins WHERE id!=?').bind(admin.id),
    db.prepare('UPDATE admins SET session_version=? WHERE id=?').bind(version, admin.id),
    ...insertMany(db, 'products', resetProducts.map(product => ({ ...product }))),
    ...insertMany(db, 'settings', Object.entries(resetSettings).map(([key, value]) => ({ key, value }))),
    insert(db, 'company_info', { ...resetCompanyInfo }),
    db.prepare('INSERT INTO report_settings(id) VALUES(1)'),
    insert(db, 'email_notification_config', { id: 1, provider: 'gmail', enabled: 0, recipients_json: '[]', sender_email: '', notify_created: 1, notify_edited: 0, notify_cancelled: 1, gmail_client_id: '', gmail_client_secret_ciphertext: null, gmail_refresh_token_ciphertext: null, app_origin: '', version: Number(row!.mail_version) + 1, updated_at: at }),
    db.prepare('UPDATE system_state SET generation=?,data_revision=data_revision+1 WHERE id=1').bind(generation),
    insert(db, 'audit_logs', { id: crypto.randomUUID(), acted_at: at, actor_type: 'admin', actor_id: admin.id, company_id: null, action: 'SYSTEM_RESET', target_type: 'system', target_id: '1', before_json: null, after_json: JSON.stringify({ counts, generation }) }),
  ];
  try { await db.batch(statements); }
  catch (error) {
    if (intentionalGuardFailure(error)) {
      const latest = await resetOverview(env, who).catch(() => null);
      if (latest && latest.active_tasks > 0) busy();
      changed();
    }
    throw error;
  }
  return { reset: true as const, counts, generation, current: { id: admin.id, type: 'admin' as const, name: admin.name, role: admin.role, session_version: version } };
}
