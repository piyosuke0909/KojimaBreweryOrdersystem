import { expect, test, type Page, type Route } from '@playwright/test';

type Row = Record<string, any>;
const invoiceId = 'INV-DOCUMENT-TEST';
const companyId = 'billing-document-company';
const firstOrder = 'O-DOCUMENT-1';
const secondOrder = 'O-DOCUMENT-2';
const originalHistory = 'invoice-history-original';
const deliveryHistory = 'delivery-history-original';
const invoicePath = `/api/admin/invoices/${invoiceId}`;
const previewPath = `/admin/reports/invoice/${invoiceId}`;
const oldIssuer = '発行当時の小島醸造';
const currentIssuer = '後から変更した会社情報';
const reportSettings = {
  invoice_title: '御請求書', delivery_note_title: '納品書', show_issuer_info: 1,
  show_invoice_reg_no: 1, show_contact_person: 1, show_fax: 1, show_email: 1,
  invoice_note_template: '請求書の初期備考', delivery_note_template: '納品書の初期備考',
};
function order(id: string, extra: Row = {}): Row {
  const first = id === firstOrder;
  return {
    id, company_id: companyId, company_name: '帳票確認商店', version: 3, status: 'received',
    ordered_at: '2026-10-19T01:00:00.000Z', desired_delivery_date: '2026-10-25',
    snap_recipient_name: '帳票確認商店 本店', snap_postal_code: '4840000', snap_address: '愛知県犬山市 テスト住所',
    items_subtotal: first ? 2000 : 500, shipping_fee: first ? 200 : 0,
    tax_amount: first ? 220 : 50, total_amount: first ? 2420 : 550,
    snap_tax_rate: 10, snap_tax_calc_unit: 'order', snap_tax_rounding: 'floor', is_invoice_locked: 1,
    items: [{ id: `${id}-item`, order_id: id, snap_product_name: first ? 'テスト純米酒' : 'テスト梅酒',
      snap_volume_ml: 720, quantity: first ? 2 : 1, snap_unit: '本', unit_price: first ? 1000 : 500, subtotal: first ? 2000 : 500 }],
    ...extra,
  };
}
function invoiceSnapshot(): Row {
  return {
    kind: 'invoice', version: 1, issued_at: '2026-10-20T01:00:00.000Z', issued_by: '帳票発行担当',
    invoice: { id: invoiceId, company_id: companyId, period_start: '2026-10-01', period_end: '2026-10-31',
      issued_date: '2026-10-20', due_date: '2026-11-30', note: '発行当時の備考', status: 'issued', latest_version: 1 },
    company: { id: companyId, name: '帳票確認商店', address: '愛知県犬山市 旧宛先' },
    issuer: { company_name: oldIssuer, display_name: oldIssuer, postal_code: '4840000', address: '発行元の旧住所',
      tel: '0000000000', email: 'invoice@example.invalid', contact_person: '帳票発行担当', invoice_reg_no: 'T1234567890123',
      bank_name: 'テスト銀行', bank_branch_name: 'テスト支店', bank_account_type: '普通', bank_account_number: '1234567', bank_account_holder: 'テスト' },
    report_settings: { ...reportSettings }, tax_settings: { tax_calc_unit: 'order', tax_rounding: 'floor', tax_rate: 10 },
    orders: [order(firstOrder), order(secondOrder)], items: [...order(firstOrder).items, ...order(secondOrder).items],
    subtotal_excl_tax: 2700, tax_amount: 270, total_incl_tax: 2970,
  };
}
function savedDelivery(): Row {
  const snapshot = { kind: 'delivery-note', order: order(firstOrder), items: order(firstOrder).items,
    issuer: { company_name: oldIssuer, display_name: oldIssuer, address: '発行元の旧住所', tel: '0000000000' },
    report_settings: { ...reportSettings }, version: 1, issued_at: '2026-10-20T02:00:00.000Z', issued_date: '2026-10-20',
    issued_by: '納品書担当', delivery_note: { id: deliveryHistory, version: 1, issued_at: '2026-10-20T02:00:00.000Z', issued_date: '2026-10-20' } };
  return { id: deliveryHistory, order_id: firstOrder, invoice_id: invoiceId, version: 1,
    issued_at: snapshot.issued_at, issued_by: 'document-admin', issued_by_name: '納品書担当', snapshot, snapshot_json: JSON.stringify(snapshot) };
}
type Options = { presentationFailure?: 'once' | 'conflict'; deliveryFailure?: boolean; cancelled?: boolean };
async function setup(page: Page, options: Options = {}) {
  const original = invoiceSnapshot();
  const state = {
    snapshot: structuredClone(original),
    histories: [{ id: originalHistory, invoice_id: invoiceId, version: 1, action_type: 'issue',
      acted_at: original.issued_at, acted_by: 'document-admin', acted_by_name: '帳票発行担当', note: '発行当時の備考',
      snapshot: structuredClone(original), snapshot_json: JSON.stringify(original) }] as Row[],
    deliveries: [savedDelivery()] as Row[],
    presentationSaves: [] as Row[], deliverySaves: [] as { order_id: string; body: Row }[],
    unexpectedWrites: [] as string[], companyInfoReads: 0,
  };
  const detail = () => ({ ...state.snapshot.invoice, company_name: '帳票確認商店',
    status: options.cancelled ? 'cancelled' : 'issued', latest_version: state.snapshot.version,
    subtotal_excl_tax: 2700, tax_amount: 270, total_incl_tax: 2970,
    items: state.snapshot.orders.map((value: Row, index: number) => ({ id: `invoice-item-${index}`, invoice_id: invoiceId,
      order_id: value.id, order_date: '2026-10-19', delivery_date: value.desired_delivery_date,
      amount_excl_tax: value.items_subtotal + value.shipping_fee, tax_amount: value.tax_amount, amount_incl_tax: value.total_amount })),
    history: state.histories, histories: state.histories, snapshot: state.snapshot,
    can_edit_presentation: !options.cancelled,
  });
  const send = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: data } });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === '/api/auth/me') return send(route, { actor: { type: 'admin', id: 'document-admin', role: 'owner', name: '帳票管理者' } });
    if (path === '/api/config') return send(route, { environment: 'production', demo_enabled: false, liff_id: '' });
    if (path === '/api/admin/notifications') return send(route, { items: [], total_unread: 0, counts: { orders: 0, companies: 0 } });
    if (path === '/api/admin/company-info') { state.companyInfoReads++; return send(route, { company_name: currentIssuer, display_name: currentIssuer }); }
    if (path === invoicePath) return send(route, detail());
    if (path === `${invoicePath}/history`) return send(route, state.histories);
    if (path.startsWith(`${invoicePath}/history/`)) {
      const selected = state.histories.find(value => value.id === path.split('/').at(-1));
      return selected ? send(route, selected) : send(route, { code: 'NOT_FOUND', message: '履歴がありません。' }, 404);
    }
    if (path === `${invoicePath}/presentation` && method === 'POST') {
      const body = request.postDataJSON(); state.presentationSaves.push(structuredClone(body));
      if (options.presentationFailure === 'conflict') return send(route, { code: 'VERSION_CONFLICT', message: '別の管理者が更新しました。再読み込みしてください。' }, 409);
      if (options.presentationFailure === 'once' && state.presentationSaves.length === 1) return send(route, { code: 'TEMPORARY_FAILURE', message: '保存結果を確認できませんでした。同じ内容で再試行してください。' }, 503);
      const existing = state.histories.find(value => value.request_id === body.request_id);
      if (existing) return send(route, detail());
      const next = structuredClone(state.snapshot), changes = body.changes;
      next.version++; next.invoice.latest_version = next.version;
      if (changes.recipient_name !== undefined) next.company.name = changes.recipient_name;
      if (changes.recipient_address !== undefined) next.company.address = changes.recipient_address;
      if (changes.title !== undefined) next.report_settings.invoice_title = changes.title;
      if (changes.due_date !== undefined) next.invoice.due_date = changes.due_date;
      if (changes.note !== undefined) next.invoice.note = changes.note;
      if (changes.issuer) next.issuer = { ...next.issuer, ...changes.issuer };
      next.revision_type = 'presentation';
      state.snapshot = next;
      state.histories.unshift({ id: `invoice-history-${next.version}`, invoice_id: invoiceId, version: next.version,
        action_type: 'reissue', revision_type: 'presentation', acted_at: '2026-10-23T01:00:00.000Z', acted_by: 'document-admin', acted_by_name: '帳票管理者',
        request_id: body.request_id, snapshot: structuredClone(next), snapshot_json: JSON.stringify(next) });
      return send(route, detail(), 201);
    }
    if (path === `${invoicePath}/delivery-notes`) return send(route, { items: state.deliveries,
      orders: [order(firstOrder), order(secondOrder)], invoice_id: invoiceId, invoice_version: state.snapshot.version, can_issue: !options.cancelled });
    if (path === `${invoicePath}/delivery-notes/preview`) {
      const selectedOrder = new URL(request.url()).searchParams.get('order_id');
      if (selectedOrder !== firstOrder && selectedOrder !== secondOrder) return send(route, { code: 'NOT_FOUND', message: '対象注文がありません。' }, 404);
      return send(route, { kind: 'delivery-note', is_draft: true, order: order(selectedOrder), items: order(selectedOrder).items,
        issuer: structuredClone(state.snapshot.issuer), report_settings: structuredClone(state.snapshot.report_settings), invoice_id: invoiceId, invoice_version: state.snapshot.version });
    }
    const delivery = path.match(/^\/api\/admin\/orders\/([^/]+)\/delivery-notes(?:\/([^/]+))?$/);
    if (delivery) {
      if (method === 'GET' && delivery[2]) {
        const selected = state.deliveries.find(value => value.id === delivery[2] && value.order_id === delivery[1]);
        return selected ? send(route, selected) : send(route, { code: 'NOT_FOUND', message: '履歴がありません。' }, 404);
      }
      if (method === 'GET') return send(route, state.deliveries.filter(value => value.order_id === delivery[1]));
      const body = request.postDataJSON(); state.deliverySaves.push({ order_id: delivery[1], body: structuredClone(body) });
      if (options.deliveryFailure) return send(route, { code: 'VERSION_CONFLICT', message: '注文が更新されました。再読み込みしてから発行してください。' }, 409);
      const selected = order(delivery[1]), version = state.deliveries.filter(value => value.order_id === selected.id).length + 1;
      const snapshot = { kind: 'delivery-note', order: selected, items: selected.items, issuer: { company_name: oldIssuer, display_name: oldIssuer },
        report_settings: { ...reportSettings }, version, issued_at: '2026-10-23T02:00:00.000Z', issued_date: '2026-10-23' };
      const created = { id: `delivery-issued-${state.deliverySaves.length}`, order_id: selected.id, invoice_id: invoiceId,
        version, issued_at: snapshot.issued_at, issued_by: 'document-admin', issued_by_name: '帳票管理者', snapshot, snapshot_json: JSON.stringify(snapshot) };
      state.deliveries.unshift(created); return send(route, created, 201);
    }
    const draft = path.match(/^\/api\/admin\/orders\/([^/]+)\/delivery-note$/);
    if (draft) return send(route, { kind: 'delivery-note', order: order(draft[1]), items: order(draft[1]).items,
      issuer: { company_name: currentIssuer, display_name: currentIssuer }, report_settings: reportSettings });
    if (method !== 'GET') state.unexpectedWrites.push(`${method} ${path}`);
    return send(route, { code: 'TEST_UNEXPECTED_API', message: path }, 404);
  });
  return state;
}
const sheet = (page: Page) => page.locator('.report-sheet');
const editor = (page: Page) => page.getByRole('region', { name: '請求書の表示内容を編集', exact: true });
const invoiceHistorySection = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: '請求書の発行履歴', exact: true }) });
const deliveryHistorySection = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: '納品書の発行履歴', exact: true }) });
async function startEditing(page: Page) {
  await page.goto(previewPath);
  await expect(sheet(page)).toContainText('2,970円');
  await page.getByRole('button', { name: '表示内容を編集', exact: true }).click();
  await expect(editor(page)).toBeVisible();
}
async function previewEdit(page: Page, recipient = '修正した帳票確認商店') {
  await editor(page).getByRole('textbox', { name: '宛名', exact: true }).fill(recipient);
  await editor(page).getByRole('textbox', { name: '備考', exact: true }).fill('表示だけを修正した備考');
  await editor(page).getByRole('button', { name: '編集内容をプレビュー', exact: true }).click();
  await expect(sheet(page)).toContainText(recipient);
  await page.getByRole('button', { name: '新しい版として保存', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '請求書の表示内容を保存しますか？', exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}

test('請求プレビューで表示だけ編集し、金額を維持して確認後に新しい版を1回だけ保存する', async ({ page }) => {
  const state = await setup(page); await startEditing(page);
  await expect(page.getByText(/数量.*単価.*送料.*税/).first()).toBeVisible();
  for (const label of ['数量', '単価', '送料', '税率', '税込合計']) {
    const input = editor(page).getByLabel(label, { exact: true });
    if (await input.count()) expect(await input.isEditable()).toBe(false);
  }
  const before = structuredClone(state.snapshot);
  const dialog = await previewEdit(page);
  expect(state.presentationSaves).toHaveLength(0);
  await expect(sheet(page)).toContainText('2,970円');
  await dialog.getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect.poll(() => state.presentationSaves.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(sheet(page)).toContainText('修正した帳票確認商店');
  expect(state.presentationSaves[0]).toMatchObject({ version: 1, changes: { recipient_name: '修正した帳票確認商店', note: '表示だけを修正した備考' } });
  expect(state.presentationSaves[0].request_id).toMatch(/^[0-9a-f-]{36}$/i);
  const changes = state.presentationSaves[0].changes;
  for (const key of ['quantity', 'unit_price', 'shipping_fee', 'tax_rate', 'tax_amount', 'total_incl_tax', 'orders', 'items']) expect(changes).not.toHaveProperty(key);
  expect(state.snapshot.orders).toEqual(before.orders);
  expect([state.snapshot.subtotal_excl_tax, state.snapshot.tax_amount, state.snapshot.total_incl_tax]).toEqual([2700, 270, 2970]);
  expect(state.histories.find(value => value.id === originalHistory)?.snapshot).toEqual(before);
  expect(state.unexpectedWrites).toEqual([]);
});

test('保存障害のあとも修正内容を保持し、再試行では同じUUIDと本文を使う', async ({ page }) => {
  const state = await setup(page, { presentationFailure: 'once' }); await startEditing(page);
  await (await previewEdit(page)).getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('保存結果を確認できませんでした');
  await expect(sheet(page)).toContainText('修正した帳票確認商店');
  expect(state.presentationSaves).toHaveLength(1);
  await page.getByRole('button', { name: '新しい版として保存', exact: true }).click();
  await page.getByRole('dialog', { name: '請求書の表示内容を保存しますか？', exact: true }).getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect.poll(() => state.presentationSaves.length).toBe(2);
  expect(state.presentationSaves[1]).toEqual(state.presentationSaves[0]);
  expect(state.histories.filter(value => value.request_id === state.presentationSaves[0].request_id)).toHaveLength(1);
});

test('別管理者との版の競合は再読み込みを案内し、保存成功や自動再発行にしない', async ({ page }) => {
  const state = await setup(page, { presentationFailure: 'conflict' }); await startEditing(page);
  await (await previewEdit(page)).getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('別の管理者が更新しました。再読み込みしてください。');
  expect(state.presentationSaves).toHaveLength(1);
  expect(state.histories).toHaveLength(1); expect(state.snapshot.version).toBe(1);
  expect(state.deliverySaves).toHaveLength(0); expect(state.unexpectedWrites).toEqual([]);
});

test('過去の請求書は保存時の発行元と日付を表示し、プレビューとPDFだけでは発行しない', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`/admin/reports/invoice/${invoiceId}/history/${originalHistory}`);
  await expect(page.getByRole('status').filter({ hasText: '発行履歴のプレビュー' })).toBeVisible();
  await expect(sheet(page)).toContainText(oldIssuer); await expect(sheet(page)).not.toContainText(currentIssuer);
  await expect(sheet(page)).toContainText('2026-10-20');
  await expect(page.getByRole('button', { name: '表示内容を編集', exact: true })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDFダウンロード', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  expect(state.presentationSaves).toHaveLength(0); expect(state.deliverySaves).toHaveLength(0);
  expect(state.companyInfoReads).toBe(0); expect(state.unexpectedWrites).toEqual([]);
});

test('請求操作の下から対象注文の納品書を確認し、明示発行後の履歴をプレビューできる', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`/admin/invoices/${invoiceId}`);
  const invoiceActions = page.locator('section').filter({ has: page.getByRole('heading', { name: '請求書の操作', exact: true }) });
  const deliveryActions = page.locator('section').filter({ has: page.getByRole('heading', { name: '納品書の操作', exact: true }) });
  await expect(deliveryActions).toBeVisible();
  const invoiceBox = await invoiceActions.boundingBox(), deliveryBox = await deliveryActions.boundingBox();
  expect(deliveryBox!.y).toBeGreaterThan(invoiceBox!.y);
  await page.getByRole('combobox', { name: '納品書の対象注文', exact: true }).selectOption(secondOrder);
  await expect(deliveryActions.getByRole('link', { name: '納品書をプレビュー', exact: true })).toHaveAttribute('href', `/admin/reports/order/${secondOrder}?invoice_id=${invoiceId}`);
  await deliveryActions.getByRole('link', { name: '納品書をプレビュー', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '未発行のプレビュー' })).toBeVisible();
  await expect(sheet(page)).toContainText('550円'); await expect(sheet(page)).toContainText(oldIssuer); await expect(sheet(page)).not.toContainText(currentIssuer);
  expect(state.deliverySaves).toHaveLength(0);
  await page.goto(`/admin/invoices/${invoiceId}`);
  await page.getByRole('combobox', { name: '納品書の対象注文', exact: true }).selectOption(secondOrder);
  await expect(invoiceHistorySection(page).getByRole('link', { name: 'プレビュー', exact: true })).toHaveCount(1);
  await expect(deliveryHistorySection(page).getByRole('link', { name: 'プレビュー', exact: true })).toHaveCount(1);
  expect(state.deliverySaves).toHaveLength(0);
  await deliveryActions.getByRole('button', { name: '納品書を発行', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '納品書を発行しますか？', exact: true });
  await expect(confirm).toContainText(secondOrder); expect(state.deliverySaves).toHaveLength(0);
  await confirm.getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect.poll(() => state.deliverySaves.length).toBe(1);
  expect(state.deliverySaves[0]).toMatchObject({ order_id: secondOrder, body: { version: 3, invoice_id: invoiceId, invoice_version: 1 } });
  expect(state.deliverySaves[0].body.request_id).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(deliveryHistorySection(page).getByRole('link', { name: 'プレビュー', exact: true })).toHaveCount(2);
  const latest = deliveryHistorySection(page).locator('tr').filter({ hasText: secondOrder });
  await latest.getByRole('link', { name: 'プレビュー', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/reports/order/${secondOrder}/history/delivery-issued-1$`));
  await expect(sheet(page)).toContainText('550円');
  expect(state.presentationSaves).toHaveLength(0); expect(state.unexpectedWrites).toEqual([]);
});

test('保存済み納品書は発行時の日付と発行元を使い、履歴表示で再発行しない', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`/admin/reports/order/${firstOrder}/history/${deliveryHistory}`);
  await expect(page.getByRole('status').filter({ hasText: '発行履歴のプレビュー' })).toBeVisible();
  await expect(sheet(page)).toContainText('2026-10-20');
  await expect(sheet(page)).toContainText(oldIssuer); await expect(sheet(page)).not.toContainText(currentIssuer);
  await expect(sheet(page)).toContainText('2,420円');
  await expect(page.getByRole('button', { name: '表示内容を編集', exact: true })).toHaveCount(0);
  expect(state.deliverySaves).toHaveLength(0); expect(state.presentationSaves).toHaveLength(0); expect(state.companyInfoReads).toBe(0);
});

test('取消済み請求は履歴を閲覧でき、表示修正と納品書の新規発行を許可しない', async ({ page }) => {
  const state = await setup(page, { cancelled: true });
  state.histories.unshift({ ...state.histories[0], id: 'cancel-after-presentation', action_type: 'cancel', revision_type: 'presentation',
    snapshot_json: JSON.stringify({ ...state.snapshot, revision_type: 'presentation' }), cancel_reason: '表示修正後の請求取消' });
  await page.goto(previewPath);
  await expect(sheet(page)).toContainText('2,970円');
  await expect(page.getByRole('button', { name: '表示内容を編集', exact: true })).toHaveCount(0);
  await page.goto(`/admin/invoices/${invoiceId}`);
  const cancellation = invoiceHistorySection(page).locator('tr').filter({ hasText: '表示修正後の請求取消' });
  await expect(cancellation).toContainText('請求取消');
  await expect(cancellation).not.toContainText('表示内容の修正');
  await expect(page.getByRole('heading', { name: '納品書の発行履歴', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '納品書を発行', exact: true })).toBeDisabled();
  expect(state.presentationSaves).toHaveLength(0); expect(state.deliverySaves).toHaveLength(0);
});

for (const width of [390, 768, 1366]) test(`${width}pxで請求と納品の履歴・操作・プレビュー編集を画面内に表示する`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await setup(page);
  await page.goto(`/admin/invoices/${invoiceId}`);
  await expect(page.getByRole('heading', { name: '納品書の発行履歴', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  await startEditing(page);
  await expect(editor(page).getByRole('textbox', { name: '宛名', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
});
