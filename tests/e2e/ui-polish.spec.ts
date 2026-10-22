import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.beforeAll(() => mkdir('.local/screenshots', { recursive: true }).then(() => {}));

async function expectNoPageOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
}

async function expectBordered(element: Locator) {
  await expect(element).toBeVisible();
  const sides = await element.evaluate(node => {
    const style = getComputedStyle(node);
    return ['Top', 'Right', 'Bottom', 'Left'].map(side => ({
      width: Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)),
      style: style.getPropertyValue(`border-${side.toLowerCase()}-style`),
    }));
  });
  for (const side of sides) {
    expect(side.width).toBeGreaterThanOrEqual(1);
    expect(side.style).not.toBe('none');
  }
}

for (const width of [390, 768, 1366]) {
  test(`${width}pxの注文者画面で管理者リンクや宣伝見出しを出さず、注文機能を枠内に表示する`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));

    // The login screen and registered customer must both have customer-only navigation.
    await page.goto('/order');
    await expect(page.getByRole('button', { name: 'テスト用取引先としてログイン', exact: true })).toBeVisible();
    await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
    await expect(page.getByText(/いつもの一献を|伝統を受け継ぐ、犬山の味/)).toHaveCount(0);
    expect((await page.request.post('/api/auth/demo/customer', { data: { company_id: 'company-a' } })).ok()).toBe(true);

    for (const path of ['/order', '/orders', '/orders/O202610190001', '/products', '/products/samurai-300', '/contact', '/invite', '/error']) {
      await page.goto(path);
      await expect(page.locator('main h1')).toBeVisible();
      const navigation = page.getByRole('navigation', { name: 'メインメニュー', exact: true });
      if (path === '/invite') await expect(navigation).toHaveCount(0);
      else await expect(navigation).toBeVisible();
      await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
      await expect(page.getByText(/犬山の地で|時を醸す|犬山の伝統を、ひと瓶に|ご縁を大切に、一献を丁寧に/)).toHaveCount(0);
      await expectNoPageOverflow(page);
      if (path === '/order') {
        await expect(page.locator('.ko-order-product').first().getByRole('button', { name: /を増やす$/ })).toBeVisible();
        await page.screenshot({ path: `.local/screenshots/ui-polish-customer-${width}.png`, fullPage: true });
      }
    }
    expect(errors).toEqual([]);
  });
}

test('管理表のセルと編集・削除の操作に枠があり、スマートフォンでもページを横にはみ出さない', async ({ page }) => {
  test.setTimeout(90_000);
  expect((await page.request.post('/api/auth/demo/admin', { data: {} })).ok()).toBe(true);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  for (const width of [390, 768, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/admin/orders', '/admin/companies', '/admin/products', '/admin/shipping', '/admin/invoices', '/admin/audit', '/admin/settings']) {
      await page.goto(path);
      await expect(page.locator('main h1')).toBeVisible();
      await expectNoPageOverflow(page);
    }

    await page.goto('/admin/companies/company-a');
    await page.getByRole('button', { name: '契約・請求条件', exact: true }).click();
    const row = page.locator('tbody tr').filter({ hasText: '標準契約（デモ）' });
    await expectBordered(row.locator('td').first());
    await expectBordered(page.locator('thead th').first());
    for (const button of [row.getByRole('button', { name: '編集', exact: true }), row.getByRole('button', { name: '標準契約（デモ）を削除', exact: true })]) {
      await expectBordered(button);
      expect(await button.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(36);
    }
    await expectNoPageOverflow(page);
    await page.screenshot({ path: `.local/screenshots/ui-polish-admin-contracts-${width}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
