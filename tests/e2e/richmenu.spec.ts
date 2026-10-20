import { expect, test } from '@playwright/test';

const menu = {
  size: { width: 2500, height: 1686 }, selected: true, name: `kojima-menu-test-${'a'.repeat(64)}`, chatBarText: 'メニュー',
  areas: [
    { bounds: { x: 0, y: 0, width: 1250, height: 843 }, action: { type: 'uri', label: '注文', uri: 'https://liff.line.me/2012094093-ApA0tjfW/order' } },
    { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: { type: 'uri', label: '注文履歴', uri: 'https://liff.line.me/2012094093-ApA0tjfW/orders' } },
    { bounds: { x: 0, y: 843, width: 1250, height: 843 }, action: { type: 'uri', label: 'お問い合わせ', uri: 'https://liff.line.me/2012094093-ApA0tjfW/contact' } },
    { bounds: { x: 1250, y: 843, width: 1250, height: 843 }, action: { type: 'uri', label: '商品紹介', uri: 'https://liff.line.me/2012094093-ApA0tjfW/products' } },
  ],
};
const bot = { display_name: '小島醸造 注文受付', basic_id: '@060ucble' };

test('リッチメニューの4リンクを確認し、反映結果を表示できる', async ({ page }) => {
  expect((await page.request.post('/api/auth/demo/admin', { data: {} })).ok()).toBe(true);
  let installations = 0;
  await page.route('**/api/admin/line/rich-menu', route => route.fulfill({ json: { data: { configured: true, expected_basic_id: bot.basic_id, bot, default_rich_menu_id: installations ? 'richmenu-test' : null, current_menu: installations ? menu : null, desired_menu: menu, image_url: '/richmenu/kojima-richmenu.jpg' } } }));
  await page.route('**/api/admin/line/rich-menu/install', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({});
    installations++;
    return route.fulfill({ json: { data: { rich_menu_id: 'richmenu-test', previous_rich_menu_id: null, image_verified: true, bot, menu, already_installed: false } } });
  });
  await page.goto('/admin/settings?tab=line-rich-menu');
  await expect(page.getByRole('heading', { name: 'LINEリッチメニュー', exact: true })).toBeVisible();
  await expect(page.getByText(bot.display_name, { exact: true })).toBeVisible();
  for (const area of menu.areas) {
    await expect(page.locator('.rich-menu-links').getByRole('link', { name: area.action.label, exact: true })).toHaveAttribute('href', area.action.uri);
  }
  await expect(page.getByText('メニュー未設定', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'LINEに反映する', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('リッチメニューをLINEに反映しました');
  await expect(page.getByText('このメニューを配信中', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '状態を更新', exact: true }).click();
  await expect(page.getByText('このメニューを配信中', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'このメニューを再反映', exact: true })).toBeEnabled();
  expect(installations).toBe(1);
});

test('LIFFの初期化に必要なURL情報を設定取得前に消さない', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/api/config', async route => {
    requested = true;
    await pending;
    await route.fulfill({ json: { data: { liff_id: '', environment: 'development', demo_enabled: false } } });
  });
  await page.goto('/?liff.state=%2Forders&liff.referrer=richmenu');
  try {
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByRole('status')).toContainText('読み込んでいます');
    expect(new URL(page.url()).searchParams.get('liff.state')).toBe('/orders');
    expect(new URL(page.url()).searchParams.get('liff.referrer')).toBe('richmenu');
  } finally { release(); }
  await expect(page).toHaveURL(/\/order$/);
});
