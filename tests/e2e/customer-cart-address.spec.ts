import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('配送先を変更してもカートへ戻り、数量と備考を保持して配送日と送料を確認し直せる', async ({ page }) => {
  expect((await page.request.post('/api/auth/demo/customer', { data: { company_id: 'company-a' } })).ok()).toBe(true);
  const addresses = [
    { id: 'cart-address-a', name: '本店', postal_code: '4840000', prefecture: '愛知県', city: '犬山市', address_line1: '検証用本店', phone: '0000000000', is_default: 1 },
    { id: 'cart-address-b', name: '支店', postal_code: '1000000', prefecture: '東京都', city: '千代田区', address_line1: '検証用支店', phone: '0000000001', is_default: 0 },
  ];
  const quoteAddresses: string[] = [];
  await page.route('**/api/customer/addresses', route => route.fulfill({ json: { data: addresses } }));
  await page.route('**/api/customer/delivery-dates?*', route => {
    const address = new URL(route.request().url()).searchParams.get('shipping_address_id');
    return route.fulfill({ json: { data: [address === 'cart-address-a' ? '2030-01-10' : '2030-02-12'] } });
  });
  await page.route('**/api/customer/quote', route => {
    const input = route.request().postDataJSON();
    quoteAddresses.push(input.shipping_address_id);
    const shipping = input.shipping_address_id === 'cart-address-a' ? 500 : 900;
    return route.fulfill({ json: { data: { items_subtotal: 2000, shipping_fee: shipping, tax_amount: 200 + shipping / 10, total_amount: 2200 + shipping * 1.1, packages: [], is_reference_tax: true } } });
  });
  await page.goto('/order');
  await page.locator('.ko-order-product').first().getByRole('button', { name: /を増やす$/ }).click({ clickCount: 2 });
  await page.getByRole('button', { name: 'カートを見る' }).click();
  await expect(page.getByRole('dialog', { name: 'カート', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: /ご要望・備考/ }).fill('変更後もこの備考を保持');
  const required = page.getByRole('dialog').locator('.ko-label em');
  await expect(required).toHaveText('必須');
  const color = await required.evaluate(node => getComputedStyle(node).color);
  const [red, green, blue] = color.match(/\d+/g)!.map(Number);
  expect(red).toBeGreaterThan(green * 2); expect(red).toBeGreaterThan(blue * 2);
  await page.locator('.ko-date-select').click();
  await page.locator('.ko-calendar-day:not(:disabled)').first().click();
  await expect(page.locator('.ko-date-select')).toContainText('2030');
  await page.locator('.ko-sheet-address').click();
  await page.getByRole('dialog', { name: '配送先を選択' }).getByRole('button', { name: /支店/ }).click();
  await expect(page.getByRole('dialog', { name: 'カート', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/order$/);
  await expect(page.locator('.ko-sheet-address')).toContainText('支店');
  await expect(page.locator('.ko-cart-item output')).toHaveText('2');
  await expect(page.getByRole('textbox', { name: /ご要望・備考/ })).toHaveValue('変更後もこの備考を保持');
  await expect(page.locator('.ko-date-select')).toContainText('お届け可能日から選択してください');
  await expect(page.getByRole('button', { name: '注文内容を確認する', exact: true })).toBeDisabled();
  await expect.poll(() => quoteAddresses.at(-1)).toBe('cart-address-b');
  await page.locator('.ko-date-select').click();
  await expect(page.locator('.ko-calendar-month')).toHaveText('2030年2月');
  await page.locator('.ko-calendar-day:not(:disabled)').first().click();
  await expect(page.getByRole('dialog', { name: 'カート', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '注文内容を確認する', exact: true })).toBeEnabled();
  await page.locator('.ko-sheet-address').click();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'カート', exact: true })).toBeVisible();
  await expect(page.locator('.ko-date-select')).toContainText('2030');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
