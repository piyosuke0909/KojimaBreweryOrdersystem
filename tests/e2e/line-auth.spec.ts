import { expect, test, type Page, type Route } from '@playwright/test';

// Intercept the SDK's ESM module in Vite, never add a test hook to production code.
test.use({ baseURL: process.env.TEST_LIFF_BASE_URL || 'http://127.0.0.1:5173' });
const invitationToken = 'test-invitation-token-for-company-a';
const idToken = 'test-line-id-token';
const accessToken = 'test-line-login-access-token';
const customer = { type: 'customer', id: 'line-user-b', company_id: 'company-a', company_name: 'A商店', name: '登録担当者' };
type Customer = typeof customer;
type Options = {
  id?: string | null; access?: string | null; profileFailure?: boolean; loggedIn?: boolean;
  registered?: boolean; staleCookie?: boolean; full?: boolean; loginCallback?: boolean;
  account?: Customer; profileName?: string; staleAccount?: Customer; accounts?: Map<string, Customer>;
  waitForAuth?: Promise<void>;
};
async function setup(page: Page, options: Options = {}) {
  const account = options.account || customer;
  const accounts = options.accounts || new Map<string, Customer>();
  if (options.registered) accounts.set(account.id, account);
  const state = { linked: accounts.has(account.id), authenticated: false, lookups: 0, authBodies: [] as any[], registrationBodies: [] as any[] };
  const validCredentials = (body: any) => options.id
    ? body.id_token === options.id && !body.access_token
    : !!options.access && body.access_token === options.access && !body.id_token;
  const module = `
    let loggedIn = ${JSON.stringify(options.loggedIn ?? true)} || sessionStorage.getItem('line-test-callback') === 'yes';
    globalThis.__lineTest = { logoutCount: 0, redirectUri: null };
    export default {
      async init() {
        const state = new URL(location.href).searchParams.get('liff.state');
        if (state) { location.replace(new URL(state, location.origin).href); await new Promise(() => {}); }
      },
      isLoggedIn() { return loggedIn; },
      getIDToken() { return loggedIn ? ${JSON.stringify(options.id ?? null)} : null; },
      getAccessToken() { return loggedIn ? ${JSON.stringify(options.access ?? null)} : null; },
      async getProfile() {
        if (${JSON.stringify(!!options.profileFailure)}) throw new Error('Optional profile lookup failed');
        return { userId: ${JSON.stringify(account.id)}, displayName: ${JSON.stringify(options.profileName || 'LINE担当者')} };
      },
      logout() { globalThis.__lineTest.logoutCount++; loggedIn = false; },
      login({ redirectUri }) {
        globalThis.__lineTest.redirectUri = redirectUri;
        if (${JSON.stringify(!!options.loginCallback)}) {
          sessionStorage.setItem('line-test-callback', 'yes');
          const target = new URL(redirectUri);
          location.assign(target.origin + '/?liff.state=' + encodeURIComponent(target.pathname + target.search));
        }
      },
      isInClient() { return false; }, closeWindow() {}
    };
  `;
  await page.route('**/node_modules/.vite/deps/@line_liff.js*', route => route.fulfill({ contentType: 'application/javascript', body: module }));
  const send = (route: Route, data: any, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: data } });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/config') return send(route, { liff_id: '2012094093-ApA0tjfW', environment: 'production', demo_enabled: false });
    if (url.pathname === '/api/auth/me') {
      if (state.linked) return send(route, { actor: accounts.get(account.id) });
      if (options.staleCookie) return send(route, { actor: options.staleAccount || { ...customer, id: 'old-line-user-a', name: '以前の利用者', company_name: '以前の会社' } });
      return send(route, { code: 'HTTP_401', message: 'ログインが必要です。' }, 401);
    }
    if (url.pathname === '/api/auth/line') {
      state.authBodies.push(request.postDataJSON());
      if (options.waitForAuth) await options.waitForAuth;
      if (!validCredentials(request.postDataJSON())) return send(route, { code: 'LINE_AUTH_FAILED', message: 'このLINEアカウントの認証情報ではありません。' }, 401);
      state.authenticated = true;
      return state.linked ? send(route, { actor: accounts.get(account.id) }) : send(route, { code: 'LINE_USER_NOT_REGISTERED', message: '取引先への登録が必要です。' }, 403);
    }
    if (url.pathname === '/api/public/invitations/lookup') {
      state.lookups++;
      expect(url.searchParams.get('t')).toBe(invitationToken);
      return send(route, { company_id: 'company-a', company_name: 'A商店', usable: true, full: !!options.full, already_registered: state.linked || (!!options.staleCookie && !state.authenticated), different_company: false });
    }
    if (url.pathname === '/api/public/invitations/register') {
      state.registrationBodies.push(request.postDataJSON());
      if (!validCredentials(request.postDataJSON())) return send(route, { code: 'LINE_AUTH_FAILED', message: 'このLINEアカウントの認証情報ではありません。' }, 401);
      accounts.set(account.id, { ...account, name: request.postDataJSON().staff_name });
      state.linked = true;
      return send(route, { actor: accounts.get(account.id) });
    }
    if (url.pathname === '/api/customer/addresses') return send(route, [{ id: 'address-a', name: 'A商店', prefecture: '愛知県', city: '犬山市', address_line1: '検証用配送先', is_default: 1 }]);
    if (url.pathname === '/api/customer/delivery-dates') return send(route, ['2030-01-01']);
    if (['/api/customer/catalog', '/api/customer/orders'].includes(url.pathname)) return send(route, []);
    if (url.pathname === '/api/public/contact') return send(route, {});
    return send(route, { code: 'TEST_UNEXPECTED_API', message: url.pathname }, 404);
  });
  return state;
}

test('IDトークンがなくても検証対象のアクセストークンで招待先へ登録できる', async ({ page }) => {
  const state = await setup(page, { access: accessToken });
  await page.goto(`/invite?t=${invitationToken}`);
  await expect(page.getByRole('heading', { name: 'お取引先のご登録', exact: true })).toBeVisible();
  await expect(page.getByLabel('ご担当者名')).toBeVisible();
  await page.getByLabel('ご担当者名').fill('登録担当者');
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登録が完了しました', exact: true })).toBeVisible();
  expect(state.authBodies).toEqual([{ access_token: accessToken }]);
  expect(state.registrationBodies).toEqual([{ token: invitationToken, staff_name: '登録担当者', access_token: accessToken }]);
  expect(state.linked).toBe(true);
  await page.getByRole('link', { name: '続けて注文する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
});

test('プロフィール取得に失敗してもIDトークンの本人確認を完了する', async ({ page }) => {
  const state = await setup(page, { id: idToken, access: accessToken, registered: true, profileFailure: true });
  await page.goto('/order');
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
  expect(state.authBodies).toEqual([{ id_token: idToken }]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('以前の企業Cookieがあっても現在のLINE認証完了前に招待判定しない', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(page, { access: accessToken, staleCookie: true, waitForAuth: pending });
  await page.goto(`/invite?t=${invitationToken}`);
  try {
    await expect.poll(() => state.authBodies.length).toBe(1);
    expect(state.lookups).toBe(0);
    expect(new URL(page.url()).searchParams.get('t')).toBe(invitationToken);
  } finally { release(); }
  await expect(page.getByLabel('ご担当者名')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/invite\\?t=${invitationToken}$`));
  await expect(page.getByText('以前の会社 様', { exact: true })).toHaveCount(0);
  expect(state.lookups).toBe(1);
});

test('古いCookieの登録済み判定を信用せず、未ログイン利用者に招待先の認証を案内する', async ({ page }) => {
  await setup(page, { loggedIn: false, staleCookie: true, full: true });
  await page.goto(`/invite?t=${invitationToken}`);
  await expect(page.getByRole('button', { name: 'LINEでログインして登録', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '招待の登録人数が上限に達しています', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'LINEでログインして登録', exact: true }).click();
  const calls = await page.evaluate(() => (globalThis as any).__lineTest);
  expect(calls.logoutCount).toBe(0);
  expect(new URL(calls.redirectUri).searchParams.get('t')).toBe(invitationToken);
});

test('認証情報がない場合は企業に紐づけず、招待URLを保って再認証できる', async ({ page }) => {
  const state = await setup(page, { staleCookie: true });
  await page.goto(`/invite?t=${invitationToken}`);
  await expect(page.getByRole('alert')).toContainText('LINEの認証情報を取得できませんでした');
  await expect(page.getByLabel('ご担当者名')).toHaveCount(0);
  await page.getByRole('button', { name: 'LINEの認証をやり直す', exact: true }).click();
  const calls = await page.evaluate(() => (globalThis as any).__lineTest);
  expect(calls.logoutCount).toBe(1);
  expect(new URL(calls.redirectUri).searchParams.get('t')).toBe(invitationToken);
  expect(state.authBodies).toHaveLength(0);
  expect(state.registrationBodies).toHaveLength(0);
});

test('LINE認証からLIFFコールバックへ戻っても招待先と登録トークンを維持する', async ({ page }) => {
  const state = await setup(page, { access: accessToken, loggedIn: false, loginCallback: true });
  await page.goto(`/invite?t=${invitationToken}`);
  await page.getByRole('button', { name: 'LINEでログインして登録', exact: true }).click();
  await expect(page.getByLabel('ご担当者名')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/invite\\?t=${invitationToken}$`));
  await page.getByLabel('ご担当者名').fill('戻り先確認担当者');
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登録が完了しました', exact: true })).toBeVisible();
  expect(state.registrationBodies[0]).toMatchObject({ token: invitationToken, access_token: accessToken });
});

test('独立したブラウザーの別LINE利用者が同じ企業の招待からそれぞれ登録できる', async ({ page, browser, baseURL }) => {
  const secondContext = await browser.newContext({ baseURL });
  try {
    const secondPage = await secondContext.newPage();
    const accounts = new Map<string, Customer>();
    const firstAccount = { ...customer, id: 'independent-line-user-a' };
    const secondAccount = { ...customer, id: 'independent-line-user-b' };
    const firstName = '独立ブラウザーA担当';
    const secondName = '独立ブラウザーB担当';
    const [first, second] = await Promise.all([
      setup(page, { id: 'independent-id-a', account: firstAccount, profileName: firstName, accounts }),
      setup(secondPage, { access: 'independent-access-b', account: secondAccount, profileName: secondName, accounts }),
    ]);
    await Promise.all([page.goto(`/invite?t=${invitationToken}`), secondPage.goto(`/invite?t=${invitationToken}`)]);
    for (const [currentPage, name] of [[page, firstName], [secondPage, secondName]] as const) {
      await expect(currentPage.getByRole('heading', { name: 'A商店 様', exact: true })).toBeVisible();
      await expect(currentPage.getByLabel('ご担当者名')).toHaveValue(name);
    }

    await page.getByRole('button', { name: '登録する', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登録が完了しました', exact: true })).toBeVisible();
    await expect(page.locator('.ko-success')).toContainText(firstName);
    await expect(page.locator('.ko-success')).not.toContainText(secondName);
    // One account joining the company must not register the other browser's account.
    await expect(secondPage.getByRole('heading', { name: 'お取引先のご登録', exact: true })).toBeVisible();
    await expect(secondPage.getByLabel('ご担当者名')).toHaveValue(secondName);
    expect(second.linked).toBe(false);
    expect(second.registrationBodies).toHaveLength(0);

    await secondPage.getByRole('button', { name: '登録する', exact: true }).click();
    await expect(secondPage.getByRole('heading', { name: '登録が完了しました', exact: true })).toBeVisible();
    await expect(secondPage.locator('.ko-success')).toContainText('A商店');
    await expect(secondPage.locator('.ko-success')).toContainText(secondName);
    await expect(secondPage.locator('.ko-success')).not.toContainText(firstName);
    expect(first.registrationBodies).toEqual([{ token: invitationToken, staff_name: firstName, id_token: 'independent-id-a' }]);
    expect(second.registrationBodies).toEqual([{ token: invitationToken, staff_name: secondName, access_token: 'independent-access-b' }]);
    expect([...accounts.values()].map(({ id, company_id, name }) => ({ id, company_id, name }))).toEqual([
      { id: firstAccount.id, company_id: 'company-a', name: firstName },
      { id: secondAccount.id, company_id: 'company-a', name: secondName },
    ]);
    for (const currentPage of [page, secondPage]) {
      await currentPage.getByRole('link', { name: '続けて注文する', exact: true }).click();
      await expect(currentPage.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
      await expect(currentPage.locator('.ko-company')).toHaveText('A商店 様');
    }
  } finally {
    await secondContext.close();
  }
});

test('同じブラウザーで別LINEアカウントへ切り替えても以前の担当者を引き継がず登録できる', async ({ page }) => {
  const accounts = new Map<string, Customer>();
  const firstAccount = { ...customer, id: 'switched-line-user-a' };
  const secondAccount = { ...customer, id: 'switched-line-user-b' };
  const firstName = '切替前の担当者';
  const secondName = '切替後の担当者';
  const first = await setup(page, { id: 'switched-id-a', account: firstAccount, profileName: firstName, accounts });
  await page.goto(`/invite?t=${invitationToken}`);
  await expect(page.getByLabel('ご担当者名')).toHaveValue(firstName);
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登録が完了しました', exact: true })).toBeVisible();
  await expect(page.locator('.ko-success')).toContainText(firstName);

  await page.unroute('**/api/**');
  await page.unroute('**/node_modules/.vite/deps/@line_liff.js*');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const second = await setup(page, {
    access: 'switched-access-b', account: secondAccount, profileName: secondName,
    staleCookie: true, staleAccount: accounts.get(firstAccount.id), accounts, waitForAuth: pending,
  });
  await page.goto(`/invite?t=${invitationToken}`);
  try {
    await expect.poll(() => second.authBodies.length).toBe(1);
    expect(second.lookups).toBe(0);
    await expect(page.getByText(firstName, { exact: false })).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole('heading', { name: 'お取引先のご登録', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A商店 様', exact: true })).toBeVisible();
  await expect(page.getByLabel('ご担当者名')).toHaveValue(secondName);
  await expect(page).toHaveURL(new RegExp(`/invite\\?t=${invitationToken}$`));
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登録が完了しました', exact: true })).toBeVisible();
  await expect(page.locator('.ko-success')).toContainText('A商店');
  await expect(page.locator('.ko-success')).toContainText(secondName);
  await expect(page.getByText(firstName, { exact: false })).toHaveCount(0);
  expect(first.authBodies).toEqual([{ id_token: 'switched-id-a' }]);
  expect(second.authBodies).toEqual([{ access_token: 'switched-access-b' }]);
  expect(second.registrationBodies).toEqual([{ token: invitationToken, staff_name: secondName, access_token: 'switched-access-b' }]);
  expect(accounts.get(firstAccount.id)?.name).toBe(firstName);
  expect(accounts.get(secondAccount.id)).toMatchObject({ company_id: 'company-a', name: secondName });
});
