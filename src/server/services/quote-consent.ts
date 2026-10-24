import type { Context } from 'hono';
import type { AppEnv, Actor, Bindings } from '../types';
import { ApiError, fail, string, integer, date, type Row } from './common';
import { readSystemState, type SystemState } from '../system-state';

const lifetimeSeconds = 10 * 60;
const encoder = new TextEncoder();
const scope = 'kojima-order-quote:v1';
const metadata = new WeakMap<Row, SystemState>();
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const unbase64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const changed = () => fail(409, 'QUOTE_CHANGED', '見積の金額・条件が変わったか、有効時間を過ぎました。最新の見積を確認してから確定してください。');

export async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function signingKey(env: Bindings, usage: KeyUsage[]) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) fail(503, 'QUOTE_SIGNING_UNAVAILABLE', '見積の確認情報を発行できません。管理者へお問い合わせください。');
  return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

/** Hash semantic intent. A refreshed/expired quote never changes an order's retry identity. */
export function normalizedOrderRequest(who: Actor, input: Row, companyId: string) {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) fail(400, 'INVALID_ITEMS', '商品を1〜100種類選択してください。');
  const seen = new Set<string>();
  const items = (input.items as Row[]).map((item: Row) => {
    const product_id = string(item.product_id, '商品');
    if (seen.has(product_id)) fail(400, 'DUPLICATE_PRODUCT', '同じ商品は1行にまとめてください。');
    seen.add(product_id);
    return { product_id, quantity: integer(item.quantity, '数量', 1, 9999) };
  }).sort((a, b) => a.product_id.localeCompare(b.product_id));
  if (who.type === 'customer' && (input.ordered_by_line_user_id != null || input.is_test_order !== undefined)) fail(403, 'ADMIN_ONLY', '管理者専用の注文設定です。');
  if (input.is_test_order !== undefined && typeof input.is_test_order !== 'boolean') fail(400, 'INVALID_INPUT', 'テスト注文の指定が不正です。');
  return {
    actor: { type: who.type, id: who.id }, company_id: companyId,
    shipping_address_id: string(input.shipping_address_id, '配送先'),
    desired_delivery_date: date(input.desired_delivery_date, '到着希望日'), items,
    note: input.note ? string(input.note, '備考', false, 4000) || null : null,
    shipping_fee: who.type === 'admin' && input.shipping_fee != null ? integer(input.shipping_fee, '配送料', 0, 1000000) : null,
    reset_manual_shipping_fee: who.type === 'admin' && input.is_shipping_fee_manual === 0,
    ordered_by_line_user_id: who.type === 'admin' && input.ordered_by_line_user_id ? string(input.ordered_by_line_user_id, 'LINE通知先', true, 256) : null,
    is_test_order: who.type === 'admin' && input.is_test_order === true,
  };
}
export const orderRequestHash = (who: Actor, input: Row, companyId: string) => digest(JSON.stringify(normalizedOrderRequest(who, input, companyId)));

/** Revision is private request metadata, not part of the reusable financial agreement. */
export async function captureQuoteState(db: D1Database) { return readSystemState(db); }
export async function completeQuoteState(db: D1Database, quote: Row, before: SystemState) {
  const after = await readSystemState(db);
  if (before.generation !== after.generation || before.data_revision !== after.data_revision) changed();
  metadata.set(quote, before);
  return quote;
}

function financialView(input: Row, result: Row) {
  const address = result.shipping_address;
  return {
    desired_delivery_date: input.desired_delivery_date,
    items: result.items.map((item: Row) => ({ product_id: item.product_id, line_no: item.line_no,
      name: item.snap_product_name, category: item.snap_category, volume: item.snap_volume_ml,
      unit: item.snap_unit, price: item.unit_price, quantity: item.quantity, subtotal: item.subtotal, weight: item.weight_kg })),
    amounts: { items_subtotal: result.items_subtotal, shipping_fee: result.shipping_fee, tax_amount: result.tax_amount, total_amount: result.total_amount },
    address: { shipping_address_id: address.id, ...(result.shipping_snapshot || {
      snap_recipient_name: address.name, snap_postal_code: address.postal_code,
      snap_address: [address.prefecture, address.city, address.address_line1, address.address_line2].filter(Boolean).join(''), snap_phone: address.phone,
    }) },
    delivery_method: result.delivery_method, shipping_fee_source: result.shipping_fee_source,
    is_shipping_fee_manual: result.is_shipping_fee_manual, packages: result.packages,
    tax: { rate: Number(result.config.tax_rate ?? 10), unit: result.config.tax_calc_unit || 'invoice',
      rounding: result.config.tax_rounding || 'floor', shipping_taxable: [true, 1, '1', 'true'].includes(result.config.shipping_taxable ?? true) },
    shipping_features: result.shipping_features,
  };
}
type Consent = { purpose: typeof scope; actor: string; company_id: string; order_id: string | null; order_version: number | null; generation: number; hash: string; iat: number; exp: number };
const identity = (who: Actor) => `${who.type}:${who.id}`;

export async function quoteConsent(c: Context<AppEnv>, input: Row, companyId: string, result: Row, order?: Row) {
  if (!input.desired_delivery_date) return { quote_token: null, quote_expires_at: null };
  const state = metadata.get(result);
  if (!state) changed();
  const iat = Math.floor(Date.now() / 1000);
  const value: Consent = { purpose: scope, actor: identity(c.get('actor')), company_id: companyId,
    order_id: order?.id ?? null, order_version: order?.version ?? null, generation: state!.generation,
    hash: await digest(JSON.stringify(financialView(input, result))), iat, exp: iat + lifetimeSeconds };
  const payload = base64(encoder.encode(JSON.stringify(value)));
  const signature = base64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(c.env, ['sign']), encoder.encode(`${scope}.${payload}`))));
  return { quote_token: `${payload}.${signature}`, quote_expires_at: new Date(value.exp * 1000).toISOString() };
}
export async function verifyQuoteConsent(c: Context<AppEnv>, input: Row, companyId: string, result: Row, order?: Row): Promise<number> {
  const token = input.quote_token;
  if (typeof token !== 'string' || token.length > 4096) changed();
  let value: Consent;
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !await crypto.subtle.verify('HMAC', await signingKey(c.env, ['verify']), unbase64(parts[1]), encoder.encode(`${scope}.${parts[0]}`))) changed();
    value = JSON.parse(new TextDecoder().decode(unbase64(parts[0]))) as Consent;
  } catch (error) { if (error instanceof ApiError && error.status === 503) throw error; return changed(); }
  const now = Math.floor(Date.now() / 1000), state = metadata.get(result);
  if (!state || value!.purpose !== scope || value!.actor !== identity(c.get('actor')) || value!.company_id !== companyId
    || value!.order_id !== (order?.id ?? null) || value!.order_version !== (order?.version ?? null) || value!.generation !== state.generation
    || !Number.isSafeInteger(value!.iat) || !Number.isSafeInteger(value!.exp) || value!.iat > now + 30 || value!.exp <= now
    || value!.exp - value!.iat !== lifetimeSeconds || value!.hash !== await digest(JSON.stringify(financialView(input, result)))) changed();
  return value!.exp;
}
/** Fence the final commit after all master reads, with expiry evaluated on the live DB clock. */
export function quoteCommitGuard(db: D1Database, result: Row, expires: number) {
  const state = metadata.get(result);
  if (!state) changed();
  return db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM system_state WHERE id=1 AND generation=? AND data_revision=?) AND CAST(strftime('%s','now') AS INTEGER)<? THEN 'null' ELSE 'QUOTE_CHANGED' END)")
    .bind(state!.generation, state!.data_revision, expires);
}
export function rethrowQuoteConflict(error: unknown): never {
  if (/malformed JSON/i.test(String(error))) changed();
  throw error;
}
