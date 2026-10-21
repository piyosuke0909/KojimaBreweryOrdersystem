import { expect, test, type Locator, type Page } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const driveId = 'testDriveFile_0123456789';
const resourceKey = '0-testResourceKey_012345';
const sharedUrl = `https://drive.google.com/file/d/${driveId}/view?usp=sharing&resourcekey=${resourceKey}`;
const thumbnailUrl = `https://drive.google.com/thumbnail?id=${driveId}&sz=w1200&resourcekey=${resourceKey}`;
const product = (id: string, name: string, image_url: string) => ({ id, name, image_url, volume_ml: 300, unit: '本', sales_status: 'on_sale', category: 'テスト商品' });

async function publicProducts(page: Page, products: ReturnType<typeof product>[]) {
  await page.route('**/api/config', route => route.fulfill({ json: { data: { liff_id: '', environment: 'development', demo_enabled: false } } }));
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: { code: 'HTTP_401', message: 'ログインが必要です。' } } }));
  await page.route('**/api/public/products', route => route.fulfill({ json: { data: products } }));
}

async function expectDecodedImage(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => {
    const element = node as HTMLImageElement;
    return element.complete && element.naturalWidth > 0;
  })).toBe(true);
}

test('商品紹介でGoogle Driveの共有リンクを画像へ変換し、サイト内の画像も表示する', async ({ page }) => {
  await publicProducts(page, [product('drive', 'Drive画像の商品', sharedUrl), product('asset', 'サイト内画像の商品', '/assets/test-product-image.png')]);
  const requested: string[] = [];
  await page.route('https://drive.google.com/**', route => {
    requested.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.route('**/assets/test-product-image.png', route => route.fulfill({ contentType: 'image/png', body: png }));

  await page.goto('/products');
  const drive = page.getByRole('img', { name: 'Drive画像の商品', exact: true });
  await expect(drive).toHaveAttribute('src', thumbnailUrl);
  await expectDecodedImage(drive);
  const asset = page.getByRole('img', { name: 'サイト内画像の商品', exact: true });
  await expect(asset).toHaveAttribute('src', '/assets/test-product-image.png');
  await expectDecodedImage(asset);
  expect(requested).toEqual([thumbnailUrl]);
});

test('画像の取得に失敗した後、同じ商品詳細画面で別の商品へ移動すると正常な画像を表示する', async ({ page }) => {
  const broken = 'https://images.example.invalid/unavailable.png';
  const working = 'https://images.example.invalid/available.png';
  await publicProducts(page, [product('broken', '画像が未取得の商品', broken), product('working', '画像を取得できる商品', working)]);
  await page.route(broken, route => route.fulfill({ status: 404, contentType: 'image/png', body: '' }));
  await page.route(working, route => route.fulfill({ contentType: 'image/png', body: png }));

  await page.goto('/products/broken');
  await expect(page.getByText('画像準備中', { exact: true })).toBeVisible();
  // React Router reuses ProductDetail/Bottle here; a full document reload would hide the stale error state.
  await page.evaluate(() => {
    history.pushState({}, '', '/products/working');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: '画像を取得できる商品', exact: true }).first()).toBeVisible();
  const image = page.getByRole('img', { name: '画像を取得できる商品', exact: true });
  await expect(image).toHaveAttribute('src', working);
  await expectDecodedImage(image);
  await expect(page.getByText('画像準備中', { exact: true })).toHaveCount(0);
});

test('管理者はDrive画像を保存前に確認でき、URL変更で古い確認画像を消し、非公開時の説明を表示する', async ({ page }) => {
  expect((await page.request.post('/api/auth/demo/admin', { data: {} })).ok()).toBe(true);
  const privateUrl = 'https://drive.google.com/file/d/privateDriveFile_012345/view?usp=sharing';
  const requests: string[] = [];
  const privateMessage = '画像を取得できませんでした。Google Driveの共有設定を「リンクを知っている全員」にしてください。';
  await page.route('**/api/admin/product-image-preview', route => {
    expect(route.request().method()).toBe('POST');
    const body = route.request().postDataJSON();
    requests.push(body.image_url);
    expect(Object.keys(body)).toEqual(['image_url']);
    return body.image_url === sharedUrl
      ? route.fulfill({ contentType: 'image/png', body: png })
      : route.fulfill({ status: 422, json: { error: { code: 'PRODUCT_IMAGE_NOT_PUBLIC', message: privateMessage } } });
  });

  await page.goto('/admin/products');
  await page.locator('tbody tr').filter({ hasText: '犬山忍冬酒：侍の酒' }).first().getByRole('button', { name: '編集', exact: true }).click();
  const form = page.getByRole('dialog', { name: '商品を編集', exact: true });
  const input = form.locator('#master-image_url');
  await expect(input).toHaveAttribute('placeholder', /drive\.google\.com/);
  await form.getByRole('button', { name: '商品画像URL / アセットパスの説明', exact: true }).click();
  const help = page.getByRole('note', { name: '商品画像URL / アセットパスの説明', exact: true });
  await expect(help).toContainText(/Google(?: Drive|ドライブ)/);
  await expect(help).toContainText('リンクを知っている全員');
  await page.getByRole('button', { name: '説明を閉じる', exact: true }).click();

  await input.fill(sharedUrl);
  await form.getByRole('button', { name: '画像を確認', exact: true }).click();
  const preview = form.getByRole('img', { name: '商品画像のプレビュー', exact: true });
  await expectDecodedImage(preview);
  await input.fill(privateUrl);
  await expect(preview).toHaveCount(0);
  await form.getByRole('button', { name: '画像を確認', exact: true }).click();
  await expect(form.getByText(privateMessage, { exact: true })).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(input).toHaveValue(privateUrl);
  expect(requests).toEqual([sharedUrl, privateUrl]);
  // Previewing must leave the editing form open; the image is not saved until the user saves the product.
  await expect(form.getByRole('button', { name: '保存する', exact: true })).toBeVisible();
});
