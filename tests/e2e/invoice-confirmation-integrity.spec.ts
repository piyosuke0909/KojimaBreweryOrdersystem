import { expect, test } from '@playwright/test';

test('古い金額の入金確認を再送せず、最新版の版と金額を確認し直してから更新する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let invoice = { id: 'invoice-confirmation-check', company_name: '入金確認商店', status: 'issued', latest_version: 1,
    subtotal_excl_tax: 1800, tax_amount: 180, total_incl_tax: 1980, period_start: '2026-10-01', period_end: '2026-10-31',
    issued_date: '2026-10-20', due_date: '2026-11-30', items: [], history: [] };
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (data: unknown) => route.fulfill({ json: { data } });
    if (path === '/api/auth/me') return send({ actor: { id: 'invoice-confirmation-owner', type: 'admin', role: 'owner', name: '確認管理者' } });
    if (path === '/api/config') return send({ environment: 'production', demo_enabled: false });
    if (path === '/api/admin/notifications') return send({ items: [], total_unread: 0, counts: { orders: 0, companies: 0 } });
    if (path === '/api/admin/invoices/' + invoice.id) return send(invoice);
    if (path.endsWith('/delivery-notes')) return send({ items: [], orders: [], can_issue: false, invoice_version: invoice.latest_version });
    if (path.endsWith('/pay')) {
      const input = request.postDataJSON(); writes.push(input);
      if (input.expected_version !== invoice.latest_version || input.expected_total !== invoice.total_incl_tax || input.expected_status !== invoice.status)
        return route.fulfill({ status: 409, json: { error: { code: 'INVOICE_CONFIRMATION_CHANGED', message: '確認後に請求書の版・金額・状態が変わりました。最新版を読み直し、もう一度確認してください。' } } });
      invoice = { ...invoice, status: 'paid' }; return send(invoice);
    }
    return send({});
  });
  await page.goto('/admin/invoices/' + invoice.id);
  await page.getByRole('button', { name: '入金済みにする', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '入金済みに更新しますか？' });
  await expect(dialog).toContainText('1,980'); await expect(dialog).toContainText('第1版');
  invoice = { ...invoice, latest_version: 2, subtotal_excl_tax: 2800, tax_amount: 280, total_incl_tax: 3080 };
  await dialog.getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('確認後に請求書の版・金額・状態が変わりました');
  expect(writes).toEqual([{ expected_version: 1, expected_total: 1980, expected_status: 'issued' }]); expect(invoice.status).toBe('issued');
  await expect(page.locator('.admin-total-grand')).toContainText('3,080');
  await page.getByRole('button', { name: '入金済みにする', exact: true }).click();
  await expect(dialog).toContainText('3,080'); await expect(dialog).toContainText('第2版');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText('入金済みに更新しました。', { exact: true })).toBeVisible();
  expect(writes).toEqual([{ expected_version: 1, expected_total: 1980, expected_status: 'issued' }, { expected_version: 2, expected_total: 3080, expected_status: 'issued' }]);
});
