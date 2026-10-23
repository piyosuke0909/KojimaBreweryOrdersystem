import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { jstDate } from '../../domain';
import { normalizeOrderStatus } from '../../shared/order-status';
import { actor, assertChanges, atomic, date, fail, insert, now, one, rows, uid, update, type Row } from './common';
import { findInvoice, invoiceDetail } from './invoices';
import { findOrder, orderDetail } from './orders';

const text = (max: number) => z.string().trim().max(max);
const nullableDate = z.union([z.string().refine(value => {
  try { return date(value, '支払期日') === value; } catch { return false; }
}, '支払期日の日付が不正です。'), z.null()]);
const issuerChanges = z.object({
  display_name: text(200).optional(), company_name: text(200).optional(), postal_code: text(20).optional(),
  address: text(1000).optional(), tel: text(50).optional(), fax: text(50).optional(),
  email: z.union([z.literal(''), z.string().trim().email().max(254)]).optional(), contact_person: text(100).optional(),
  invoice_reg_no: z.union([z.literal(''), z.string().regex(/^T\d{13}$/)]).optional(),
  bank_name: text(100).optional(), bank_branch_name: text(100).optional(),
  bank_account_type: z.enum(['', '普通', '当座']).optional(),
  bank_account_number: z.union([z.literal(''), z.string().regex(/^\d{6,7}$/)]).optional(),
  bank_account_holder: text(200).optional(),
}).strict();
const presentationInput = z.object({
  version: z.number().int().positive(), request_id: z.string().uuid(),
  changes: z.object({
    recipient_name: text(200).min(1).optional(), recipient_address: text(1000).optional(),
    title: text(100).min(1).optional(), due_date: nullableDate.optional(), note: text(4000).optional(),
    issuer: issuerChanges.optional(),
  }).strict(),
}).strict();
const deliveryInput = z.object({
  request_id: z.string().uuid(), version: z.number().int().positive(),
  invoice_id: z.string().min(1).max(256).optional(), invoice_version: z.number().int().positive().optional(),
}).strict().refine(value => !!value.invoice_id === (value.invoice_version !== undefined), '請求書とその版を一緒に指定してください。');

async function hash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function snapshot(row: Row): Row {
  try {
    const value = JSON.parse(row.snapshot_json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Row;
  } catch { return fail(409, 'DOCUMENT_SNAPSHOT_INVALID', '保存された帳票を確認できません。管理者に確認してください。'); }
}
function requestMatches(row: Row, requestHash: string, targetId: string, field: 'invoice_id' | 'order_id') {
  if (row[field] !== targetId || row.request_hash !== requestHash) fail(409, 'DOCUMENT_REQUEST_CONFLICT', '同じ操作番号で別の帳票は発行できません。再読み込みしてください。');
}
async function invoiceRequest(c: Context<AppEnv>, requestId: string, requestHash: string, invoiceId: string) {
  const existing = await one(c.env.DB, 'SELECT * FROM invoice_histories WHERE request_id=?', requestId);
  if (!existing) return null;
  requestMatches(existing, requestHash, invoiceId, 'invoice_id');
  return { created: false, data: { ...await invoiceDetail(c, await findInvoice(c, invoiceId)), presentation_history_id: existing.id } };
}
function financialSnapshotMatches(invoice: Row, document: Row) {
  return document.kind === 'invoice' && document.invoice?.id === invoice.id &&
    ['subtotal_excl_tax', 'tax_amount', 'total_incl_tax'].every(key => Number(document.invoice?.[key]) === Number(invoice[key]) && Number(document[key]) === Number(invoice[key]));
}

/** Save display-only changes as a new immutable version, without repricing or unlocking orders. */
export async function reviseInvoicePresentation(c: Context<AppEnv>, invoiceId: string, input: Row) {
  const data = presentationInput.parse(input);
  const requestHash = await hash({ kind: 'invoice-presentation', invoice_id: invoiceId, ...data });
  const repeated = await invoiceRequest(c, data.request_id, requestHash, invoiceId);
  if (repeated) return repeated;
  const invoice = await findInvoice(c, invoiceId);
  if (!['issued', 'paid'].includes(invoice.status)) fail(409, 'INVOICE_PRESENTATION_READONLY', '取消済みの請求書は表示内容を変更できません。');
  if (invoice.latest_version !== data.version) fail(409, 'VERSION_CONFLICT', '請求書が更新されています。再読み込みしてください。');
  const prior = await one(c.env.DB, "SELECT * FROM invoice_histories WHERE invoice_id=? AND version=? AND action_type IN ('issue','reissue')", invoiceId, invoice.latest_version);
  if (!prior) fail(409, 'SNAPSHOT_MISSING', '発行履歴が見つかりません。');
  const document = snapshot(prior!);
  if (!financialSnapshotMatches(invoice, document)) fail(409, 'DOCUMENT_FINANCIAL_MISMATCH', '請求金額と保存済み帳票が一致しません。金額を直接編集せず、管理者に確認してください。');
  const before = JSON.stringify(document);
  document.company = { ...document.company };
  document.invoice = { ...document.invoice };
  document.report_settings = { ...document.report_settings };
  document.issuer = { ...document.issuer };
  const change = data.changes;
  if (change.recipient_name !== undefined) document.company.name = change.recipient_name;
  if (change.recipient_address !== undefined) document.company.address = change.recipient_address;
  if (change.title !== undefined) document.report_settings.invoice_title = change.title;
  if (change.due_date !== undefined) document.invoice.due_date = change.due_date;
  if (change.note !== undefined) document.invoice.note = change.note;
  Object.assign(document.issuer, change.issuer || {});
  if (JSON.stringify(document) === before) fail(409, 'DOCUMENT_UNCHANGED', '表示内容に変更がありません。');
  const stamp = now(), version = invoice.latest_version + 1, historyId = uid();
  document.version = version;
  document.revision_type = 'presentation';
  document.issued_at = stamp; document.issued_by = actor(c).name;
  Object.assign(document.invoice, { latest_version: version, issued_date: jstDate(stamp), status: invoice.status });
  const updated = { latest_version: version, issued_date: document.invoice.issued_date, due_date: document.invoice.due_date ?? null, note: document.invoice.note ?? null, snap_company_info_json: JSON.stringify(document.issuer) };
  try {
    await atomic(c.env.DB, [
      update(c.env.DB, 'invoices', updated, 'id=? AND latest_version=? AND status=?', invoiceId, data.version, invoice.status),
      assertChanges(c.env.DB, 1, actor(c), 'INVOICE_PRESENTATION_REVISE', 'invoices', invoiceId, { version: data.version }, { version, display_fields: Object.keys(change) }, invoice.company_id),
      insert(c.env.DB, 'invoice_histories', { id: historyId, invoice_id: invoiceId, version, action_type: 'reissue', acted_at: stamp, acted_by: actor(c).id, snapshot_json: JSON.stringify(document), note: document.invoice.note ?? null, request_id: data.request_id, request_hash: requestHash }),
    ]);
  } catch (error) {
    const retry = await invoiceRequest(c, data.request_id, requestHash, invoiceId);
    if (retry) return retry;
    if (String(error).includes('UNIQUE constraint failed')) fail(409, 'DOCUMENT_CONFLICT', '帳票が更新されています。再読み込みしてください。');
    throw error;
  }
  return { created: true, data: { ...await invoiceDetail(c, await findInvoice(c, invoiceId)), presentation_history_id: historyId } };
}

const noteSelect = `SELECT h.id,h.order_id,h.invoice_id,h.version,h.issued_at,h.issued_by,
  COALESCE(json_extract(h.snapshot_json,'$.issued_by'),a.name) AS issued_by_name,
  h.source_order_version,h.source_invoice_version FROM delivery_note_histories h LEFT JOIN admins a ON a.id=h.issued_by`;
function publicNote(row: Row, withSnapshot = false) {
  const document = row.snapshot_json ? snapshot(row) : null;
  return { id: row.id, order_id: row.order_id, invoice_id: row.invoice_id, version: row.version, issued_at: row.issued_at,
    issued_by: row.issued_by, issued_by_name: row.issued_by_name || document?.issued_by || row.issued_by,
    source_order_version: row.source_order_version, source_invoice_version: row.source_invoice_version,
    ...(withSnapshot ? { snapshot: document } : {}) };
}
export async function deliveryNoteHistory(c: Context<AppEnv>, orderId: string, historyId: string) {
  await findOrder(c, orderId);
  const row = await one(c.env.DB, 'SELECT * FROM delivery_note_histories WHERE id=? AND order_id=?', historyId, orderId);
  if (!row) fail(404, 'NOT_FOUND', '納品書の発行履歴が見つかりません。');
  return publicNote(row!, true);
}
function sourceOrder(row: Row) {
  return { id: row.id, version: row.version, status: normalizeOrderStatus(row.status), desired_delivery_date: row.desired_delivery_date,
    snap_recipient_name: row.snap_recipient_name, items_subtotal: row.items_subtotal, shipping_fee: row.shipping_fee, tax_amount: row.tax_amount, total_amount: row.total_amount };
}
export async function orderDeliveryNotes(c: Context<AppEnv>, orderId: string) {
  const order = await findOrder(c, orderId);
  const items = await rows(c.env.DB, `${noteSelect} WHERE h.order_id=? ORDER BY h.version DESC`, orderId);
  return { items: items.map(row => publicNote(row)), order: sourceOrder(order) };
}
export async function invoiceDeliveryNotes(c: Context<AppEnv>, invoiceId: string) {
  const invoice = await findInvoice(c, invoiceId);
  const [items, orders] = await Promise.all([
    rows(c.env.DB, `${noteSelect} WHERE h.invoice_id=? ORDER BY h.issued_at DESC,h.rowid DESC`, invoiceId),
    rows(c.env.DB, 'SELECT o.* FROM orders o JOIN invoice_items ii ON ii.order_id=o.id WHERE ii.invoice_id=? AND o.company_id=? ORDER BY ii.line_no', invoiceId, invoice.company_id),
  ]);
  return { items: items.map(row => publicNote(row)), orders: orders.map(sourceOrder), invoice_id: invoiceId, invoice_version: invoice.latest_version, can_issue: ['issued', 'paid'].includes(invoice.status) };
}
async function noteRequest(c: Context<AppEnv>, requestId: string, requestHash: string, orderId: string) {
  const existing = await one(c.env.DB, 'SELECT * FROM delivery_note_histories WHERE request_id=?', requestId);
  if (!existing) return null;
  requestMatches(existing, requestHash, orderId, 'order_id');
  return { created: false, data: publicNote(existing, true) };
}
/** Drafts and issued documents resolve their source through the same validation. */
async function deliverySource(c: Context<AppEnv>, order: Row, data: {invoice_id?: string; invoice_version?: number}) {
  let printedOrder: Row, issuer: Row, report: Row;
  if (data.invoice_id) {
    const invoice = await findInvoice(c, data.invoice_id);
    if (!['issued', 'paid'].includes(invoice.status)) fail(409, 'DELIVERY_NOTE_CANCELLED_INVOICE', '取消済みの請求書から納品書は発行できません。');
    if (invoice.latest_version !== data.invoice_version) fail(409, 'VERSION_CONFLICT', '請求書が更新されています。再読み込みしてください。');
    const included = await one(c.env.DB, 'SELECT id FROM invoice_items WHERE invoice_id=? AND order_id=?', invoice.id, order.id);
    if (invoice.company_id !== order.company_id || !included) fail(409, 'DELIVERY_NOTE_INVOICE_ORDER_MISMATCH', 'この請求書に含まれる注文を選んでください。');
    if (!order.is_invoice_locked) fail(409, 'DELIVERY_NOTE_SOURCE_UNLOCKED', '請求対象の注文が更新可能になっています。請求書を確認してください。');
    const history = await one(c.env.DB, "SELECT * FROM invoice_histories WHERE invoice_id=? AND version=? AND action_type IN ('issue','reissue')", invoice.id, invoice.latest_version);
    if (!history) fail(409, 'SNAPSHOT_MISSING', '請求書の発行履歴が見つかりません。');
    const document = snapshot(history!);
    const savedOrder = Array.isArray(document.orders) ? document.orders.find((value: Row) => value.id === order.id) : null;
    if (!financialSnapshotMatches(invoice, document) || !savedOrder || !['items_subtotal', 'shipping_fee', 'tax_amount', 'total_amount'].every(key => Number(savedOrder[key]) === Number(order[key])))
      fail(409, 'DOCUMENT_FINANCIAL_MISMATCH', '請求書と注文の保存済み金額が一致しません。管理者に確認してください。');
    printedOrder = { ...savedOrder, version: order.version, status: normalizeOrderStatus(order.status), company_name: document.company?.name || order.company_name };
    issuer = document.issuer || {}; report = document.report_settings || {};
  } else {
    printedOrder = await orderDetail(c, order);
    [issuer, report] = await Promise.all([one(c.env.DB, 'SELECT * FROM company_info WHERE id=1'), one(c.env.DB, 'SELECT * FROM report_settings WHERE id=1')]) as [Row, Row];
  }
  return { printedOrder, issuer: issuer || {}, report: report || {} };
}

/** Invoice-linked previews use the exact issuer/settings captured by that invoice. */
export async function invoiceDeliveryNotePreview(c: Context<AppEnv>, invoiceId: string, orderIdValue?: string) {
  const orderId = z.string().min(1).max(256).parse(orderIdValue);
  const invoice = await findInvoice(c, invoiceId), order = await findOrder(c, orderId);
  if (normalizeOrderStatus(order.status) === 'cancelled') fail(409, 'DELIVERY_NOTE_CANCELLED_ORDER', 'キャンセル済みの注文の納品書は発行できません。');
  const source = await deliverySource(c, order, {invoice_id: invoiceId, invoice_version: invoice.latest_version});
  return {kind: 'delivery-note', is_draft: true, order: source.printedOrder, items: source.printedOrder.items || [],
    issuer: source.issuer, report_settings: source.report, issued_date: jstDate(now()),
    invoice_id: invoiceId, invoice_version: invoice.latest_version, source_order_version: order.version};
}

/** Explicit issuance preserves exactly the approved source, including its issuer and report settings. */
export async function issueDeliveryNote(c: Context<AppEnv>, orderId: string, input: Row) {
  const data = deliveryInput.parse(input);
  const requestHash = await hash({ kind: 'delivery-note', order_id: orderId, ...data });
  const repeated = await noteRequest(c, data.request_id, requestHash, orderId);
  if (repeated) return repeated;
  const order = await findOrder(c, orderId);
  if (normalizeOrderStatus(order.status) === 'cancelled') fail(409, 'DELIVERY_NOTE_CANCELLED_ORDER', 'キャンセル済みの注文の納品書は発行できません。');
  if (order.version !== data.version) fail(409, 'VERSION_CONFLICT', '注文が更新されています。再読み込みしてください。');
  const { printedOrder, issuer, report } = await deliverySource(c, order, data);
  const stamp = now(), latest = await one(c.env.DB, 'SELECT COALESCE(MAX(version),0) AS version FROM delivery_note_histories WHERE order_id=?', orderId);
  const version = Number(latest?.version || 0) + 1, id = uid();
  const document = { kind: 'delivery-note', version, order: printedOrder, items: printedOrder.items || [], issuer: issuer || {}, report_settings: report || {}, issued_date: jstDate(stamp), issued_at: stamp, issued_by: actor(c).name };
  const record = { id, order_id: orderId, invoice_id: data.invoice_id || null, version, request_id: data.request_id, request_hash: requestHash, snapshot_json: JSON.stringify(document), issued_at: stamp, issued_by: actor(c).id, source_order_version: order.version, source_invoice_version: data.invoice_version ?? null };
  const invoiceGuard = data.invoice_id ? " AND is_invoice_locked=1 AND EXISTS(SELECT 1 FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id WHERE i.id=? AND i.latest_version=? AND i.status IN('issued','paid') AND i.company_id=orders.company_id AND ii.order_id=orders.id)" : '';
  try {
    await atomic(c.env.DB, [
      c.env.DB.prepare(`UPDATE orders SET delivery_note_issued_at=? WHERE id=? AND company_id=? AND version=? AND status!='cancelled'${invoiceGuard}`).bind(stamp, orderId, order.company_id, data.version, ...(data.invoice_id ? [data.invoice_id, data.invoice_version] : [])),
      assertChanges(c.env.DB, 1, actor(c), 'DELIVERY_NOTE_ISSUE', 'delivery_note_histories', id, null, { order_id: orderId, invoice_id: data.invoice_id || null, version, source_order_version: order.version }, order.company_id),
      insert(c.env.DB, 'delivery_note_histories', record),
    ]);
  } catch (error) {
    const retry = await noteRequest(c, data.request_id, requestHash, orderId);
    if (retry) return retry;
    if (String(error).includes('UNIQUE constraint failed')) fail(409, 'DOCUMENT_CONFLICT', '納品書が発行されています。履歴を再読み込みしてください。');
    throw error;
  }
  return { created: true, data: publicNote(record, true) };
}
