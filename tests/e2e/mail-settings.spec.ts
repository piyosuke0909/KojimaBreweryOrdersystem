import { expect, test, type Page, type Route } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const endpoint = '/api/admin/mail-settings';
const clientId = '123456789-test.apps.googleusercontent.com';
const exampleSecret = 'test-only-google-client-secret';
const callbackCode = 'test-only-google-authorization-code';
const callbackState = 'test-only-long-oauth-state-value';
type MailSettings = {
  provider: 'gmail' | 'resend'; enabled: boolean; recipients: string[]; sender_email: string;
  notify_created: boolean; notify_edited: boolean; notify_cancelled: boolean;
  gmail_client_id: string; gmail_client_secret_configured: boolean; gmail_connected: boolean;
  redirect_uri: string; resend_configured: boolean;
};
type Options = { role?: 'owner' | 'staff'; loginRequired?: boolean; initial?: Partial<MailSettings>; authorizationUrl?: string; finishFailure?: boolean };
async function setup(page: Page, options: Options = {}) {
  let loggedIn = !options.loginRequired;
  const state = {
    settings: {
      provider: 'gmail' as const, enabled: false, recipients: ['orders@example.com'], sender_email: 'sender@example.com',
      notify_created: true, notify_edited: true, notify_cancelled: true, gmail_client_id: clientId,
      gmail_client_secret_configured: false, gmail_connected: false,
      redirect_uri: 'https://example.com/admin/settings/mail/callback', resend_configured: false,
      ...options.initial,
    } as MailSettings,
    settingsReads: 0, saves: [] as any[], starts: 0, finishes: [] as any[], tests: 0, disconnects: 0,
    authPageUrls: [] as string[], googleRequests: [] as string[],
  };
  const send = (route: Route, data: any, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: data } });
  await page.route('https://accounts.google.com/**', route => {
    state.googleRequests.push(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Google consent test boundary</body></html>' });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const actor = { type: 'admin', id: 'mail-test-admin', role: options.role || 'owner', name: 'メール設定テスト管理者' };
    if (path === '/api/auth/me') {
      state.authPageUrls.push(page.url());
      return loggedIn ? send(route, { actor }) : send(route, { code: 'HTTP_401', message: 'ログインが必要です。' }, 401);
    }
    if (path === '/api/config') return send(route, { environment: 'development', demo_enabled: true, liff_id: '' });
    if (path === '/api/auth/admin/login') { loggedIn = true; return send(route, { actor }); }
    if (path === endpoint) {
      if (request.method() === 'GET') { state.settingsReads++; return send(route, state.settings); }
      if (request.method() === 'PUT') {
        const input = request.postDataJSON(); state.saves.push(input);
        const changed = input.gmail_client_id !== state.settings.gmail_client_id || !!input.gmail_client_secret;
        const { gmail_client_secret, ...safe } = input;
        state.settings = { ...state.settings, ...safe, gmail_client_secret_configured: !!gmail_client_secret || state.settings.gmail_client_secret_configured, gmail_connected: changed ? false : state.settings.gmail_connected };
        return send(route, state.settings);
      }
    }
    if (path === `${endpoint}/gmail/start`) {
      state.starts++;
      return send(route, { authorization_url: options.authorizationUrl || `https://accounts.google.com/o/oauth2/v2/auth?state=${callbackState}&client_id=${clientId}`, redirect_uri: state.settings.redirect_uri });
    }
    if (path === `${endpoint}/gmail/finish`) {
      state.finishes.push(request.postDataJSON());
      if (options.finishFailure) return send(route, { code: 'GMAIL_AUTHORIZATION_EXPIRED', message: '連携操作の期限が切れたか設定が変更されました。Googleとの連携をやり直してください。' }, 409);
      state.settings = { ...state.settings, gmail_connected: true, gmail_client_secret_configured: true };
      return send(route, state.settings);
    }
    if (path === `${endpoint}/test`) { state.tests++; return send(route, { status: 'sent', sent_count: state.settings.recipients.length, failed_count: 0 }); }
    if (path === `${endpoint}/gmail/disconnect`) {
      state.disconnects++; state.settings = { ...state.settings, gmail_connected: false, enabled: false };
      return send(route, state.settings);
    }
    return send(route, { code: 'TEST_UNEXPECTED_API', message: path }, 404);
  });
  return state;
}
async function openSettings(page: Page) {
  await page.goto('/admin/settings?tab=email');
  await expect(page.getByRole('tab', { name: 'メール', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'メール通知', exact: true })).toBeVisible();
}
async function expectNoSecretsInStorage(page: Page) {
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(exampleSecret); expect(storage).not.toContain(callbackCode); expect(storage).not.toContain(callbackState);
}

test('通知先を複数追加・削除して保存でき、シークレットを再表示せずスマートフォンに収まる', async ({ page }) => {
  const state = await setup(page);
  await openSettings(page);
  await page.getByRole('button', { name: '通知先を追加', exact: true }).click();
  await page.getByRole('textbox', { name: '通知先メールアドレス 2', exact: true }).fill('second@example.com');
  await page.getByRole('button', { name: '通知先を追加', exact: true }).click();
  await page.getByRole('textbox', { name: '通知先メールアドレス 3', exact: true }).fill('unused@example.com');
  await page.getByRole('button', { name: '通知先 3 を削除', exact: true }).click();
  await page.getByLabel('Googleクライアントシークレット', { exact: true }).fill(exampleSecret);
  await expect(page.getByRole('button', { name: 'Googleで連携', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'メール設定を保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('メール設定を保存しました');
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]).toMatchObject({ recipients: ['orders@example.com', 'second@example.com'], gmail_client_secret: exampleSecret });
  await expect(page.getByLabel('Googleクライアントシークレット', { exact: true })).toHaveValue('');
  await expect(page.getByText('シークレットは保存済みです。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Googleで連携', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'メール設定を保存', exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves[1]).not.toHaveProperty('gmail_client_secret');
  await expectNoSecretsInStorage(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Googleからの戻りで認可情報をURLから消し、同じコードを一度だけ送信する', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`/admin/settings/mail/callback?code=${callbackCode}&state=${callbackState}&scope=gmail.send`);
  await expect(page).toHaveURL(/\/admin\/settings\?tab=email$/);
  await expect(page.getByRole('status')).toContainText('Googleとの連携が完了しました');
  await expect(page.getByText('接続済み', { exact: true })).toBeVisible();
  expect(state.finishes).toEqual([{ code: callbackCode, state: callbackState }]);
  expect(state.authPageUrls.every(value => !value.includes(callbackCode) && !value.includes(callbackState))).toBe(true);
  await expectNoSecretsInStorage(page);
  await page.getByRole('tab', { name: '会社情報・振込口座', exact: true }).click();
  await page.getByRole('tab', { name: 'メール', exact: true }).click();
  await expect(page.getByText('接続済み', { exact: true })).toBeVisible();
  expect(state.finishes).toHaveLength(1);
});

test('Googleから戻ったとき管理者セッションが切れていても、ログイン後にメール連携を続けられる', async ({ page }) => {
  const state = await setup(page, { loginRequired: true });
  await page.goto(`/admin/settings/mail/callback?code=${callbackCode}&state=${callbackState}`);
  await expect(page.getByRole('heading', { name: '管理者ログイン', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/settings\?tab=email$/);
  expect(state.finishes).toHaveLength(0);
  await page.getByPlaceholder('例：admin', { exact: true }).fill('test-admin');
  await page.getByPlaceholder('設定済みのパスワード', { exact: true }).fill('test-only-admin-password');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'メール通知', exact: true })).toBeVisible();
  await expect(page.getByText('接続済み', { exact: true })).toBeVisible();
  expect(state.finishes).toEqual([{ code: callbackCode, state: callbackState }]);
  await expectNoSecretsInStorage(page);
});

test('Googleの認可を取り消したときはコードを送らず、設定を読み込んで再連携を案内する', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`/admin/settings/mail/callback?error=access_denied&state=${callbackState}`);
  await expect(page).toHaveURL(/\/admin\/settings\?tab=email$/);
  await expect(page.getByRole('alert')).toContainText('Googleでの連携が取り消されました');
  await expect(page.getByRole('textbox', { name: '通知先メールアドレス 1', exact: true })).toHaveValue('orders@example.com');
  expect(state.finishes).toHaveLength(0);
  await expectNoSecretsInStorage(page);
});

test('無効な連携状態ではエラーを表示し、同じコードを再送せず手動での再連携を促す', async ({ page }) => {
  const state = await setup(page, { finishFailure: true });
  await page.goto(`/admin/settings/mail/callback?code=${callbackCode}&state=${callbackState}`);
  await expect(page.getByRole('alert')).toContainText('連携操作の期限が切れたか設定が変更されました');
  await expect(page.getByRole('textbox', { name: '通知先メールアドレス 1', exact: true })).toHaveValue('orders@example.com');
  expect(state.finishes).toHaveLength(1);
  await expectNoSecretsInStorage(page);
});

test('オーナー以外にはメール設定やGoogle連携操作を表示しない', async ({ page }) => {
  const state = await setup(page, { role: 'staff' });
  await openSettings(page);
  await expect(page.getByText('メールの設定・Google連携はオーナー権限の管理者で行ってください。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'GoogleクライアントID', exact: true })).toHaveCount(0);
  expect(state.settingsReads).toBe(0); expect(state.finishes).toHaveLength(0); expect(state.tests).toBe(0);
});

test('通常通知がオフでもテストメールは確認操作後だけ送信し、Google連携解除も確認する', async ({ page }) => {
  const state = await setup(page, { initial: { enabled: false, gmail_connected: true, gmail_client_secret_configured: true, recipients: ['orders@example.com', 'second@example.com'] } });
  await openSettings(page);
  expect(state.tests).toBe(0);
  await page.getByRole('button', { name: 'テストメールを送る', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'テストメールを送りますか？', exact: true });
  await expect(dialog).toContainText('orders@example.com'); await expect(dialog).toContainText('second@example.com');
  expect(state.tests).toBe(0);
  await dialog.getByRole('button', { name: '戻る', exact: true }).click();
  expect(state.tests).toBe(0);
  await page.getByRole('button', { name: 'テストメールを送る', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('テストメールを2件送信しました');
  expect(state.tests).toBe(1);
  await page.getByRole('button', { name: 'Googleとの連携を解除', exact: true }).click();
  expect(state.disconnects).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect(page.getByText('未接続', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'テストメールを送る', exact: true })).toBeDisabled();
  expect(state.disconnects).toBe(1);
});

test('Google連携は固定Googleドメインだけへ移動し、別の連携先URLを拒否する', async ({ page }) => {
  const state = await setup(page, { initial: { gmail_client_secret_configured: true } });
  await openSettings(page);
  await page.getByRole('button', { name: 'Googleで連携', exact: true }).click();
  await expect(page).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  expect(state.starts).toBe(1); expect(state.googleRequests).toHaveLength(1);

  const otherPage = await page.context().newPage();
  const other = await setup(otherPage, { initial: { gmail_client_secret_configured: true }, authorizationUrl: 'https://example.invalid/steal' });
  await openSettings(otherPage);
  await otherPage.getByRole('button', { name: 'Googleで連携', exact: true }).click();
  await expect(otherPage.getByRole('alert')).toContainText('Googleの連携先を確認できませんでした');
  await expect(otherPage).toHaveURL(/\/admin\/settings\?tab=email$/);
  expect(other.starts).toBe(1); expect(other.googleRequests).toHaveLength(0);
  await otherPage.close();
});


test('Resendでは既存の送信元を使い、Gmail送信元を入力せず通知をオンにできる', async ({ page }) => {
  const state = await setup(page, { initial: { provider: 'resend', sender_email: '', resend_configured: true } });
  await openSettings(page);
  await expect(page.getByText('Resendに登録済みの送信元とAPIキーを使用します。', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /^メール通知をオンにする/ }).check();
  await page.getByRole('button', { name: 'メール設定を保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('メール設定を保存しました');
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]).toMatchObject({ provider: 'resend', enabled: true, sender_email: '', recipients: ['orders@example.com'] });
  await expect(page.getByRole('button', { name: 'テストメールを送る', exact: true })).toBeEnabled();
  expect(state.tests).toBe(0);
});
