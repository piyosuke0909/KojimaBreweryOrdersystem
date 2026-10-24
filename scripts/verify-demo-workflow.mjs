/**
 * Verify one explicitly labelled test order without impersonating a LINE user.
 * The owner remains the actor. An existing company member is only the recipient.
 * Default is a read-only plan. --apply --notify-line authorizes the single order
 * and its one LINE notification. Re-runs reuse a persisted request UUID/order.
 *   node --use-env-proxy scripts/verify-demo-workflow.mjs \
 *     --base-url https://confirmed.example --apply --notify-line --pdf
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, MARKER, PREPARATION_FILE, WORKFLOW_FILE, SafeError, ensure, options, privateJson, readPrivate, addDays, jstToday, connectApi } from './prepare-demo.mjs';

const FLOW_MARKER = `${MARKER}_WORKFLOW`;
const evidenceFile = resolve(ROOT, '.local/demo-workflow-verification.json');
const validUUID = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function savedInvoice(api, orderId, state) {
  if (state.invoice_id) {
    const invoice = await api.get(`/api/admin/invoices/${encodeURIComponent(state.invoice_id)}`);
    ensure(invoice.status === 'issued' || invoice.status === 'paid', 'The saved demo invoice was cancelled. Review it before another workflow run.');
    ensure(invoice.items?.length === 1 && invoice.items[0].order_id === orderId, 'The saved invoice does not contain only this demo order.');
    return invoice;
  }
  const candidates = await api.list(`/api/admin/invoices?company_id=${encodeURIComponent(state.company_id)}`);
  const matches = [];
  for (const candidate of candidates.filter((row) => String(row.note ?? '').includes(FLOW_MARKER))) {
    const invoice = await api.get(`/api/admin/invoices/${encodeURIComponent(candidate.id)}`);
    if (invoice.items?.some((item) => item.order_id === orderId)) matches.push(invoice);
  }
  ensure(matches.length <= 1, 'Multiple invoices reference this demo workflow. No additional invoice was issued.');
  if (matches.length) {
    ensure(['issued', 'paid'].includes(matches[0].status), 'The existing demo invoice was cancelled. No additional invoice was issued.');
    ensure(matches[0].items.length === 1, 'The existing demo invoice includes another order.');
    return matches[0];
  }
  return null;
}

async function savePDFs(api, orderId, invoiceId) {
  let browser;
  try {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ headless: true, ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}) });
    const context = await api.browserContext(browser);
    const page = await context.newPage();
    const directory = resolve(ROOT, '.local/demo-workflow-documents');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const documents = [];
    for (const [kind, path, filename, label] of [
      ['delivery_note', `/admin/reports/order/${encodeURIComponent(orderId)}`, 'demo-delivery-note.pdf', '納品'],
      ['invoice', `/admin/reports/invoice/${encodeURIComponent(invoiceId)}`, 'demo-invoice.pdf', '請求'],
    ]) {
      const response = await page.goto(api.origin + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
      ensure(response?.ok(), 'The production report page could not be opened.');
      await page.locator('.report-sheet').waitFor({ timeout: 30000 });
      ensure((await page.locator('.report-sheet h1').textContent())?.includes(label), 'The report preview title was not correct.');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 45000 }),
        page.getByRole('button', { name: 'PDFダウンロード', exact: true }).click(),
      ]);
      const target = resolve(directory, filename);
      await download.saveAs(target);
      chmodSync(target, 0o600);
      const bytes = readFileSync(target);
      ensure(bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 10000, 'A downloaded document was not a valid PDF.');
      await page.screenshot({ path: resolve(directory, `${kind}-preview.png`), fullPage: true });
      chmodSync(resolve(directory, `${kind}-preview.png`), 0o600);
      documents.push({ kind, file: `.local/demo-workflow-documents/${filename}`, bytes: bytes.length, pdf_header: true, production_browser_download: true, production_browser_transport: api.browserTransport ?? 'direct' });
    }
    await context.close();
    return documents;
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('The production browser PDF check could not complete. The saved demo order and invoice were retained; no notification was retried.');
  } finally { await browser?.close(); }
}

export async function verifyDemoWorkflow(api, opts, dependencies = {}) {
  const preparation = dependencies.preparation ?? readPrivate(PREPARATION_FILE);
  ensure(preparation.schema === 1 && preparation.marker === MARKER && preparation.origin === api.origin, 'Demo preparation must match this confirmed origin. Run prepare-demo first.');
  ensure(!opts.companyId || opts.companyId === preparation.company_id, 'The selected company differs from the prepared demo company.');
  const companyPath = `/api/admin/companies/${encodeURIComponent(preparation.company_id)}`;
  const company = await api.get(companyPath);
  ensure(company.status === 'active', 'The prepared demo company is not active.');
  const destination = company.addresses.find((row) => row.id === preparation.addresses.yamato && row.status === 'active');
  ensure(destination && String(destination.note ?? '').includes(MARKER), 'The dedicated demo shipping address is unavailable.');
  const members = company.line_users.filter((row) => row.status === 'active');
  const items = [
    { product_id: preparation.product_ids.small300.id, quantity: 2 },
    { product_id: preparation.product_ids.small700.id, quantity: 1 },
    { product_id: preparation.product_ids.large1800.id, quantity: 1 },
  ];
  const orders = await api.list(`/api/admin/orders?company_id=${encodeURIComponent(preparation.company_id)}`);
  const persisted = Object.prototype.hasOwnProperty.call(dependencies, 'state') ? dependencies.state : (existsSync(WORKFLOW_FILE) ? readPrivate(WORKFLOW_FILE) : null);
  let state = persisted;
  if (state) ensure(state.schema === 1 && state.marker === FLOW_MARKER && state.origin === api.origin && state.company_id === preparation.company_id && validUUID(state.request_id), 'Existing workflow state does not match this company and origin. It was preserved.');
  let existingOrder = state?.order_id ? orders.find((row) => row.id === state.order_id) : state ? orders.find((row) => row.request_id === state.request_id) : null;
  if (!state) {
    const prior = orders.filter((row) => String(row.note ?? '').includes(FLOW_MARKER));
    ensure(prior.length <= 1, 'Multiple existing demo workflows were found. No new order was created.');
    if (prior.length) {
      existingOrder = prior[0];
      ensure(validUUID(existingOrder.request_id), 'The existing workflow has no valid idempotency key.');
      state = { schema: 1, marker: FLOW_MARKER, origin: api.origin, company_id: preparation.company_id, request_id: existingOrder.request_id, order_id: existingOrder.id, desired_delivery_date: existingOrder.desired_delivery_date, created_at: existingOrder.ordered_at };
    }
  }
  if (existingOrder) ensure(String(existingOrder.id).startsWith('TEST-O') && String(existingOrder.note ?? '').includes(FLOW_MARKER), 'The saved request refers to an ordinary order. No changes were made.');
  if (state?.order_id) ensure(existingOrder, 'The saved demo order is no longer available. No replacement order was created.');
  const quoteInput = { company_id: preparation.company_id, shipping_address_id: destination.id, items, ...(existingOrder ? { order_id: existingOrder.id, desired_delivery_date: existingOrder.desired_delivery_date } : {}) };
  const preview = await api.write('/api/admin/orders/quote', quoteInput);
  ensure(Array.isArray(preview.delivery_dates) && preview.delivery_dates.length && preview.items?.length === items.length && Number.isSafeInteger(preview.total_amount) && preview.total_amount > 0, 'The demo quote has no valid delivery dates, items, or total.');
  if (!opts.apply) return { operation: 'verify_demo_workflow', mode: 'plan', company_active: true, existing_line_members: members.length, demo_items: items.length, available_delivery_dates: preview.delivery_dates.length, estimated_total: preview.total_amount, existing_workflow_order: Boolean(existingOrder), line_notifications_sent: 0, application_writes: 0, next_step: '--apply --notify-line creates or reuses one labelled test order; --pdf also checks real browser downloads' };
  ensure(opts.notifyLine, 'Provide --notify-line with --apply for the explicitly requested single LINE demo notification.');
  if (!existingOrder) ensure(members.length === 1, 'Exactly one active LINE member is required to select the demo recipient safely. No order was created.');
  if (!state) state = { schema: 1, marker: FLOW_MARKER, origin: api.origin, company_id: preparation.company_id, request_id: randomUUID(), created_at: new Date().toISOString(), desired_delivery_date: preview.delivery_dates[0] };
  const persist = dependencies.persist ?? ((value) => privateJson(WORKFLOW_FILE, value));
  persist(state); // Persist the idempotency key before any order mutation or LINE push.
  let order = existingOrder ? await api.get(`/api/admin/orders/${encodeURIComponent(existingOrder.id)}`) : null;
  let newlyCreated = false;
  let createdInput = null;
  if (!order) {
    ensure(preview.delivery_dates.includes(state.desired_delivery_date), 'The saved demo date is no longer selectable. Review the saved workflow before continuing.');
    const input = { ...quoteInput, request_id: state.request_id, desired_delivery_date: state.desired_delivery_date, ordered_by_line_user_id: members[0].line_user_id, is_test_order: true, note: `[デモ・動作確認] ${FLOW_MARKER} 架空商品・架空住所・仮運賃による一連の確認です。発送・実請求・送金は行いません。` };
    const signed = await api.write('/api/admin/orders/quote', input);
    ensure(typeof signed.quote_token === 'string' && signed.quote_token && Date.parse(signed.quote_expires_at) > Date.now(), 'The dated demo quote has no valid confirmation token. No order was created.');
    createdInput = { ...input, quote_token: signed.quote_token };
    const result = await api.request('/api/admin/orders', 'POST', createdInput);
    order = result.data;
    newlyCreated = result.status === 201;
  }
  ensure(String(order.id).startsWith('TEST-O') && order.company_id === preparation.company_id && order.request_id === state.request_id, 'The application did not create the expected labelled demo order.');
  ensure(order.items?.length === items.length && items.every((item) => order.items.some((actual) => actual.product_id === item.product_id && actual.quantity === item.quantity)), 'The saved demo order items do not match the selected products.');
  const expectedPrices = new Map(Object.values(preparation.product_ids).map((product) => [product.id, product.unit_price]));
  ensure(order.items.every((item) => item.unit_price === expectedPrices.get(item.product_id)), 'The saved order did not use the prepared company-specific prices.');
  ensure(order.packages?.length >= 2 && order.shipping_fee > 0, 'The demo small bottles and one-sho bottle were not split into priced packages.');
  ensure(order.ordered_by_line_user_id && members.some((member) => member.line_user_id === order.ordered_by_line_user_id), 'The demo order recipient is not an active member of this company. No further notifications were sent.');
  state.order_id = order.id;
  state.desired_delivery_date = order.desired_delivery_date;
  persist(state);
  const listed = await api.list(`/api/admin/orders?company_id=${encodeURIComponent(state.company_id)}&q=${encodeURIComponent(order.id)}`);
  ensure(listed.some((row) => row.id === order.id && row.total_amount === order.total_amount), 'The demo order is missing from the administrator order list.');
  const dashboard = await api.get('/api/admin/dashboard');
  const createdAudit = await api.list(`/api/admin/audit?action=ORDER_CREATE&q=${encodeURIComponent(order.id)}`);
  ensure(createdAudit.some((row) => row.target_id === order.id && row.actor_type === 'admin'), 'The demo order was not audited as a real administrator action.');
  let notificationAudit = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    notificationAudit = (await api.list(`/api/admin/audit?action=NOTIFICATION_ORDER_CREATE&q=${encodeURIComponent(order.id)}`)).filter((row) => row.target_id === order.id);
    if (notificationAudit.length || dependencies.skipNotificationWait) break;
    await delay(1000);
  }
  ensure(notificationAudit.length <= 1, 'More than one creation notification was recorded for the demo order. No notification was retried.');
  let notification = notificationAudit[0]?.note ?? 'not_recorded';
  const delivery = await api.get(`/api/admin/orders/${encodeURIComponent(order.id)}/delivery-note`);
  ensure(delivery.kind === 'delivery-note' && delivery.order?.id === order.id && delivery.items?.length === items.length && delivery.order.total_amount === order.total_amount, 'The delivery note does not match the demo order.');
  ensure(delivery.issuer && typeof delivery.issuer.display_name === 'string', 'The delivery note has no issuer information.');
  let invoice = await savedInvoice(api, order.id, state);
  if (!invoice) invoice = await api.write('/api/admin/invoices', { company_id: state.company_id, period_start: order.desired_delivery_date, period_end: order.desired_delivery_date, order_ids: [order.id], due_date: addDays(jstToday(), 30), note: `[デモ・動作確認] ${FLOW_MARKER} このテスト注文1件だけの帳票確認です。実際のお支払いは不要です。` });
  ensure(invoice.items?.length === 1 && invoice.items[0].order_id === order.id && invoice.snapshot?.orders?.length === 1 && invoice.snapshot.orders[0].id === order.id, 'The invoice contains an unexpected order.');
  ensure(invoice.total_incl_tax === invoice.snapshot.total_incl_tax && invoice.snapshot.items?.length === items.length, 'The invoice snapshot does not match its stored totals and items.');
  ensure(invoice.total_incl_tax === order.total_amount, 'The invoice total does not match the single demo order.');
  ensure(invoice.snapshot.issuer?.bank_account_number, 'The invoice has no demo bank information.');
  state.invoice_id = invoice.id;
  state.last_verified_at = new Date().toISOString();
  persist(state);
  const after = await api.get(`/api/admin/orders/${encodeURIComponent(order.id)}`);
  ensure(after.is_invoice_locked === 1, 'Invoice issuance did not protect the demo order from editing.');
  // Only an exact request body can be replayed. Existing/legacy workflow files do
  // not contain the original body; confirm their result with the read-only API.
  const recovered = await api.get(`/api/admin/order-requests/${encodeURIComponent(state.request_id)}`);
  ensure(recovered.processed && recovered.order?.id === order.id, 'The saved demo request result could not be verified. No replacement order was created.');
  let replayedThisRun = false;
  if (newlyCreated && createdInput) {
    const replay = await api.request('/api/admin/orders', 'POST', createdInput);
    ensure(replay.status === 200 && replay.data?.id === order.id, 'The exact demo order replay did not return the existing order.');
    replayedThisRun = true;
    state.idempotent_replay_verified = true;
    persist(state);
  }
  const notificationAfterReplay = (await api.list(`/api/admin/audit?action=NOTIFICATION_ORDER_CREATE&q=${encodeURIComponent(order.id)}`)).filter((row) => row.target_id === order.id);
  ensure(notificationAfterReplay.length <= 1 && (!notificationAudit.length || same(notificationAudit.map((row) => row.id).sort(), notificationAfterReplay.map((row) => row.id).sort())), 'The idempotent replay added a second notification.');
  if (!notificationAudit.length && notificationAfterReplay.length === 1) notification = notificationAfterReplay[0].note;
  const membersAfter = (await api.get(companyPath)).line_users;
  const membership = (users) => users.map(({ id, line_user_id, company_id, status }) => [id, line_user_id, company_id, status]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  ensure(same(membership(company.line_users), membership(membersAfter)), 'The company LINE registration list changed during verification. No member records were edited by this helper.');
  const summary = { operation: 'verify_demo_workflow', mode: 'apply', verified_at: new Date().toISOString(), order_id: order.id, invoice_id: invoice.id, order_created_this_run: newlyCreated, order_actor: 'admin', administrator_list_verified: true, dashboard_database_read_verified: typeof dashboard.new_orders === 'number', dashboard_recent_order_visible: dashboard.recent_orders?.some((row) => row.id === order.id) ?? false, item_count: items.length, package_count: order.packages?.length ?? 0, shipping_fee: order.shipping_fee, order_total: order.total_amount, invoice_total: invoice.total_incl_tax, invoice_order_count: invoice.items.length, invoice_snapshot_verified: true, invoice_lock_verified: true, delivery_note_verified: true, line_notification_audit: notification, line_api_accepted: notification === 'sent', line_device_receipt: 'requires_user_confirmation', order_result_lookup_verified: true, idempotent_replay_verified: state.idempotent_replay_verified === true, idempotent_replay_this_run: replayedThisRun, duplicate_notification_recorded: false, existing_line_registrations_unchanged: true, pdf_downloads: [] };
  const saveEvidence = dependencies.saveEvidence ?? ((value) => privateJson(evidenceFile, value));
  saveEvidence(summary);
  if (opts.pdf) {
    summary.pdf_downloads = await (dependencies.savePDFs ?? savePDFs)(api, order.id, invoice.id);
    saveEvidence(summary);
  }
  ensure(notification === 'sent', 'The demo order and documents were saved, but LINE acceptance was not confirmed. The existing notification was not retried; inspect the notification audit.');
  return summary;
}

export async function runWorkflow() {
  let api;
  try {
    const opts = options();
    api = await connectApi(opts.base);
    const summary = await verifyDemoWorkflow(api, opts);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ operation: 'verify_demo_workflow_failed', message: error instanceof SafeError ? error.message : 'Unexpected workflow verification failure. Sensitive values were withheld.', evidence_file: '.local/demo-workflow-verification.json' }));
    process.exitCode = 1;
  } finally { await api?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runWorkflow();
