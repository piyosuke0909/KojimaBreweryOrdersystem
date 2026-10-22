import { expect, test, type Page, type Route } from '@playwright/test';

// Exercise the application with the official SDK boundary replaced in Vite.
// Native LINE consent, friendship and browser switching remain device tests.
test.use({ baseURL: process.env.TEST_LIFF_BASE_URL || 'http://127.0.0.1:5173' });
const invitationToken = 'test-invitation-token-for-company-a';
const otherInvitationToken = 'test-invitation-token-for-company-b';
const idToken = 'test-line-id-token';
const accessToken = 'test-line-login-access-token';
const customer = { type: 'customer', id: 'line-user-b', company_id: 'company-a', company_name: 'A商店', name: '登録担当者' };
type Customer = typeof customer;
type Handoff = { pending: true; handoff_id: string; company_id: string; company_name: string; already_registered: false };
type Server = { accounts: Map<string, Customer>; handoffs: Map<string, Handoff>; used: number; nextId: number };
const serverState = (): Server => ({ accounts: new Map(), handoffs: new Map(), used: 0, nextId: 0 });
type Options = {
  id?: string | null; access?: string | null; profileFailure?: boolean; loggedIn?: boolean;
  registered?: boolean; staleCookie?: boolean; full?: boolean; loginCallback?: boolean; loginDenied?: boolean;
  account?: Customer; profileName?: string; staleAccount?: Customer; server?: Server;
  friendFlag?: boolean; friendshipFailure?: boolean; initFailure?: boolean; waitForAuth?: Promise<void>;
};
async function setup(page: Page, options: Options = {}) {
  const account = options.account || customer;
  const server = options.server || serverState();
  if (options.registered) server.accounts.set(account.id, account);
  const state = {
    get linked() { return server.accounts.has(account.id); }, authenticated: false, lookups: 0,
    authBodies: [] as any[], prepareBodies: [] as any[], resumeBodies: [] as any[], registrationBodies: [] as any[],
  };
  const validCredentials = (body: any) => options.id
    ? body.id_token === options.id && !body.access_token
    : !!options.access && body.access_token === options.access && !body.id_token;
  const module = `
    let loggedIn = ${JSON.stringify(options.loggedIn ?? true)} || sessionStorage.getItem('line-test-callback') === 'yes';
    const calls = JSON.parse(sessionStorage.getItem('line-test-login-calls') || '[]');
    globalThis.__lineTest = { logoutCount: 0, loginCalls: calls, initOptions: [], friendFlag: sessionStorage.getItem('line-test-friend') === 'yes' || ${JSON.stringify(options.friendFlag ?? true)}, friendshipFailure: ${JSON.stringify(!!options.friendshipFailure)} };
    function login({ redirectUri = location.href } = {}) {
      calls.push(redirectUri); sessionStorage.setItem('line-test-login-calls', JSON.stringify(calls));
      if (${JSON.stringify(!!options.loginDenied)} && sessionStorage.getItem('line-test-consent-granted') !== 'yes') {
        const target = new URL(redirectUri); target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', 'The user denied the authorization request');
        target.searchParams.set('liffOAuth2Error', 'true');
        location.assign(target.href);
      } else if (${JSON.stringify(!!options.loginCallback)}) {
        sessionStorage.setItem('line-test-callback', 'yes');
        const target = new URL(redirectUri);
        location.assign(target.origin + '/?liff.state=' + encodeURIComponent(target.pathname + target.search));
      }
    }
    export default {
      async init(options = {}) {
        globalThis.__lineTest.initOptions.push(options);
        if (${JSON.stringify(!!options.initFailure)}) throw new Error('LINE初期化を確認できませんでした');
        const query = new URL(location.href).searchParams;
        if (query.has('error') && query.has('liffOAuth2Error')) throw new Error(query.get('error') + ': ' + query.get('error_description'));
        const state = new URL(location.href).searchParams.get('liff.state');
        if (state) { location.replace(new URL(state, location.origin).href); await new Promise(() => {}); }
        if (options.withLoginOnExternalBrowser && !loggedIn) { login({ redirectUri: location.href }); await new Promise(() => {}); }
      },
      isLoggedIn() { return loggedIn; },
      getIDToken() { return loggedIn ? ${JSON.stringify(options.id ?? null)} : null; },
      getAccessToken() { return loggedIn ? ${JSON.stringify(options.access ?? null)} : null; },
      async getProfile() {
        if (${JSON.stringify(!!options.profileFailure)}) throw new Error('Optional profile lookup failed');
        return { userId: ${JSON.stringify(account.id)}, displayName: ${JSON.stringify(options.profileName || 'LINE担当者')} };
      },
      async getFriendship() {
        if (globalThis.__lineTest.friendshipFailure) throw new Error('Friendship lookup failed');
        return { friendFlag: globalThis.__lineTest.friendFlag };
      },
      logout() { globalThis.__lineTest.logoutCount++; loggedIn = false; }, login,
      isInClient() { return false; }, closeWindow() {}
    };
  `;
  await page.route('**/node_modules/.vite/deps/@line_liff.js*', route => route.fulfill({ contentType: 'application/javascript', body: module }));
  const send = (route: Route, data: any, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: data } });
  const unauthorized = (route: Route) => send(route, { code: 'LINE_AUTH_FAILED', message: 'このLINEアカウントの認証情報ではありません。' }, 401);
  const companyFor = (token: string) => token === invitationToken ? { company_id: 'company-a', company_name: 'A商店' } : token === otherInvitationToken ? { company_id: 'company-b', company_name: 'B商店' } : null;
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/config') return send(route, { liff_id: '2011901973-juZ5QTYX', line_official_account_id: '@060ucble', environment: 'production', demo_enabled: false });
    if (url.pathname === '/api/auth/me') {
      if (state.linked) return send(route, { actor: server.accounts.get(account.id) });
      if (options.staleCookie) return send(route, { actor: options.staleAccount || { ...customer, id: 'old-line-user-a', name: '以前の利用者', company_name: '以前の会社' } });
      return send(route, { code: 'HTTP_401', message: 'ログインが必要です。' }, 401);
    }
    if (url.pathname === '/api/auth/line') {
      state.authBodies.push(request.postDataJSON());
      if (options.waitForAuth) await options.waitForAuth;
      if (!validCredentials(request.postDataJSON())) return unauthorized(route);
      state.authenticated = true;
      return state.linked ? send(route, { actor: server.accounts.get(account.id) }) : send(route, { code: 'LINE_USER_NOT_REGISTERED', message: '取引先への登録が必要です。' }, 403);
    }
    if (url.pathname === '/api/public/invitations/lookup') {
      state.lookups++;
      const company = companyFor(url.searchParams.get('t') || '');
      if (!company) return send(route, { code: 'INVITATION_EXPIRED', message: 'この招待は利用できません。' }, 410);
      const member = server.accounts.get(account.id);
      return send(route, { ...company, usable: true, full: !!options.full, already_registered: !!member && member.company_id === company.company_id, different_company: !!member && member.company_id !== company.company_id });
    }
    if (url.pathname === '/api/public/invitations/prepare') {
      const body = request.postDataJSON(); state.prepareBodies.push(body);
      if (!validCredentials(body)) return unauthorized(route);
      const company = companyFor(body.token);
      if (!company) return send(route, { code: 'INVITATION_EXPIRED', message: 'この招待は利用できません。' }, 410);
      const member = server.accounts.get(account.id);
      if (member && member.company_id !== company.company_id) return send(route, { code: 'ALREADY_REGISTERED', message: '別のお取引先で登録されています。' }, 409);
      if (member) return send(route, { pending: false, handoff_id: null, ...company, already_registered: true });
      if (options.full) return send(route, { code: 'INVITATION_FULL', message: '招待の登録人数が上限に達しています。' }, 409);
      const previous = server.handoffs.get(account.id);
      const handoff: Handoff = previous?.company_id === company.company_id ? previous : { pending: true, handoff_id: `handoff-${++server.nextId}`, ...company, already_registered: false };
      server.handoffs.set(account.id, handoff);
      return send(route, handoff);
    }
    if (url.pathname === '/api/public/invitations/resume') {
      const body = request.postDataJSON(); state.resumeBodies.push(body);
      if (!validCredentials(body)) return unauthorized(route);
      return send(route, server.handoffs.get(account.id) || { pending: false });
    }
    if (url.pathname === '/api/public/invitations/register-pending') {
      const body = request.postDataJSON(); state.registrationBodies.push(body);
      if (!validCredentials(body)) return unauthorized(route);
      const pending = server.handoffs.get(account.id);
      if (!pending || pending.handoff_id !== body.handoff_id) return send(route, { code: 'INVITATION_HANDOFF_EXPIRED', message: '招待内容が変更されたため、招待QRコードからやり直してください。' }, 409);
      const existing = server.accounts.get(account.id);
      if (existing && existing.company_id !== pending.company_id) return send(route, { code: 'ALREADY_REGISTERED', message: '別のお取引先で登録されています。' }, 409);
      server.accounts.set(account.id, { ...account, company_id: pending.company_id, company_name: pending.company_name, name: body.staff_name });
      server.handoffs.delete(account.id); server.used++;
      return send(route, { actor: server.accounts.get(account.id) });
    }
    if (url.pathname === '/api/customer/addresses') return send(route, [{ id: 'address-a', name: 'A商店', prefecture: '愛知県', city: '犬山市', address_line1: '検証用配送先', is_default: 1 }]);
    if (url.pathname === '/api/customer/delivery-dates') return send(route, ['2030-01-01']);
    if (['/api/customer/catalog', '/api/customer/orders', '/api/public/products'].includes(url.pathname)) return send(route, []);
    if (url.pathname === '/api/public/contact') return send(route, {});
    return send(route, { code: 'TEST_UNEXPECTED_API', message: url.pathname }, 404);
  });
  return Object.assign(state, { server });
}

async function expectChatStep(page: Page) {
  await expect(page.getByRole('heading', { name: 'LINEのトークから登録を続けます', exact: true })).toBeVisible();
  await expect(page.getByLabel('ご担当者名')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'メインメニュー', exact: true })).toHaveCount(0);
}
async function openRichMenuOrder(page: Page) {
  // Model the official application's friend-add operation, then its static rich-menu URL.
  await page.evaluate(() => sessionStorage.setItem('line-test-friend', 'yes'));
  await page.goto('/order');
  await expect(page.getByRole('heading', { name: 'お取引先のご登録', exact: true })).toBeVisible();
}
async function confirmName(page: Page, name: string) {
  await page.getByLabel('ご担当者名').fill(name);
  await page.getByRole('button', { name: '登録して注文へ進む', exact: true }).click();
  await expect(page).toHaveURL(/\/order$/);
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '登録が完了しました', exact: true })).toHaveCount(0);
}

// Access/id-token authenticity is checked at every mock server endpoint just as in the backend.
test('QRから友だち追加とトークへ進み、名前確定時だけ登録して注文へ移動する', async ({ page }) => {
  const state = await setup(page, { access: accessToken, friendFlag: false });
  await page.goto(`/invite?t=${invitationToken}`);
  await expectChatStep(page);
  await expect(page.getByRole('link', { name: '小島醸造を友だち追加', exact: true })).toHaveAttribute('href', /line\.me\/R\/ti\/p\/.*060ucble/);
  expect(state.server.used).toBe(0); expect(state.linked).toBe(false); expect(state.registrationBodies).toHaveLength(0);
  await page.evaluate(() => { (globalThis as any).__lineTest.friendFlag = true; });
  await page.getByRole('button', { name: '追加状態を確認', exact: true }).click();
  await expect(page.getByRole('link', { name: '小島醸造のトークを開く', exact: true })).toHaveAttribute('href', /line\.me\/R\/oaMessage\/.*060ucble/);
  await openRichMenuOrder(page);
  await confirmName(page, '登録担当者');
  expect(state.authBodies).toEqual([{ access_token: accessToken }, { access_token: accessToken }]);
  expect(state.prepareBodies).toEqual([{ token: invitationToken, access_token: accessToken }]);
  expect(state.registrationBodies).toEqual([{ handoff_id: 'handoff-1', staff_name: '登録担当者', access_token: accessToken }]);
  expect(state.server.used).toBe(1);
});

test('QRを開くとログイン案内を挟まず自動認証し、LIFF戻り先と招待を維持する', async ({ page }) => {
  const state = await setup(page, { access: accessToken, loggedIn: false, loginCallback: true });
  await page.goto(`/invite?t=${invitationToken}`);
  await expectChatStep(page);
  const calls = await page.evaluate(() => (globalThis as any).__lineTest.loginCalls as string[]);
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]).searchParams.get('t')).toBe(invitationToken);
  await expect(page.getByRole('button', { name: 'LINEでログインして登録', exact: true })).toHaveCount(0);
  expect(state.prepareBodies).toEqual([{ token: invitationToken, access_token: accessToken }]);
  expect(state.server.used).toBe(0);
});

test('Safari相当とLINE相当の別ブラウザー間で、同じ本人の招待だけを復元する', async ({ page, browser, baseURL }) => {
  const server = serverState();
  const first = await setup(page, { id: idToken, server, friendFlag: false });
  await page.goto(`/invite?t=${invitationToken}`);
  await expectChatStep(page);
  expect(first.prepareBodies).toHaveLength(1);
  expect(server.used).toBe(0);
  const native = await browser.newContext({ baseURL });
  const other = await browser.newContext({ baseURL });
  try {
    expect(await native.cookies()).toEqual([]);
    const nativePage = await native.newPage();
    const current = await setup(nativePage, { access: accessToken, server, friendFlag: true });
    await nativePage.goto('/order');
    await expect(nativePage.getByLabel('ご担当者名')).toBeVisible();
    expect(current.resumeBodies.length).toBeGreaterThan(0);
    for (const body of current.resumeBodies) expect(body).toEqual({ access_token: accessToken });
    expect(new URL(nativePage.url()).searchParams.has('t')).toBe(false);
    expect(await nativePage.evaluate(() => localStorage.length)).toBe(0);

    const otherPage = await other.newPage();
    const stranger = await setup(otherPage, { id: 'other-person-id', account: { ...customer, id: 'other-person' }, server });
    await otherPage.goto('/order');
    await expect(otherPage.getByText(/招待QRコード/).first()).toBeVisible();
    await expect(otherPage.getByLabel('ご担当者名')).toHaveCount(0);
    expect(stranger.resumeBodies.length).toBeGreaterThan(0);
    for (const body of stranger.resumeBodies) expect(body).toEqual({ id_token: 'other-person-id' });
    expect(stranger.registrationBodies).toHaveLength(0);

    await confirmName(nativePage, 'LINEアプリで登録した担当者');
    expect(current.registrationBodies[0]).toEqual({ handoff_id: 'handoff-1', staff_name: 'LINEアプリで登録した担当者', access_token: accessToken });
    expect(server.used).toBe(1);
    expect(server.accounts.get(customer.id)?.name).toBe('LINEアプリで登録した担当者');
  } finally { await native.close(); await other.close(); }
});

test('友だち状態が未追加または確認失敗の場合、名前登録へ進めない', async ({ page }) => {
  const state = await setup(page, { id: idToken, friendFlag: false });
  await page.goto(`/invite?t=${invitationToken}`);
  await expectChatStep(page);
  await page.goto('/order');
  await expect(page.getByLabel('ご担当者名')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '小島醸造を友だち追加', exact: true })).toBeVisible();
  await page.evaluate(() => { (globalThis as any).__lineTest.friendshipFailure = true; });
  await page.getByRole('button', { name: '追加状態を確認', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('ご担当者名')).toHaveCount(0);
  expect(state.server.used).toBe(0); expect(state.registrationBodies).toHaveLength(0);
});

test('プロフィール取得に失敗してもIDトークンの本人確認を完了する', async ({ page }) => {
  const state = await setup(page, { id: idToken, access: accessToken, registered: true, profileFailure: true });
  await page.goto('/order');
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
  expect(state.authBodies).toEqual([{ id_token: idToken }]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('以前の企業Cookieがあっても現在のLINE認証完了前に招待を引き継がない', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(page, { access: accessToken, staleCookie: true, waitForAuth: pending });
  await page.goto(`/invite?t=${invitationToken}`);
  try {
    await expect.poll(() => state.authBodies.length).toBe(1);
    expect(state.prepareBodies).toHaveLength(0); expect(state.lookups).toBe(0);
    expect(new URL(page.url()).searchParams.get('t')).toBe(invitationToken);
  } finally { release(); }
  await expectChatStep(page);
  await expect(page.getByText('以前の会社 様', { exact: true })).toHaveCount(0);
  expect(state.prepareBodies).toHaveLength(1);
});

test('古いCookieの登録済み判定を使わず、初回QRでは自動認証を一度だけ開始する', async ({ page }) => {
  const state = await setup(page, { loggedIn: false, staleCookie: true, full: true });
  await page.goto(`/invite?t=${invitationToken}`);
  await expect.poll(() => page.evaluate(() => (globalThis as any).__lineTest?.loginCalls.length || 0)).toBe(1);
  await expect(page.getByRole('button', { name: 'LINEでログインして登録', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('ご担当者名')).toHaveCount(0);
  expect(state.authBodies).toHaveLength(0); expect(state.prepareBodies).toHaveLength(0);
  const calls = await page.evaluate(() => (globalThis as any).__lineTest);
  expect(calls.logoutCount).toBe(0);
  expect(new URL(calls.loginCalls[0]).searchParams.get('t')).toBe(invitationToken);
});

test('認証を取り消した場合は自動リダイレクトを繰り返さず、明示的に再試行できる', async ({ page }) => {
  const state = await setup(page, { id: idToken, loggedIn: false, loginDenied: true, loginCallback: true });
  await page.goto(`/invite?t=${invitationToken}`);
  await expect(page.getByRole('alert')).toContainText('access_denied');
  await expect(page.getByRole('button', { name: 'LINEの認証をやり直す', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('liffOAuth2Error')).toBe('true');
  const count = await page.evaluate(() => JSON.parse(sessionStorage.getItem('line-test-login-calls') || '[]').length);
  expect(count).toBe(1);
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('line-test-login-calls') || '[]').length)).toBe(1);
  expect(state.prepareBodies).toHaveLength(0); expect(state.registrationBodies).toHaveLength(0);

  // The official SDK rejects init on its error callback. Explicit retry must
  // remove those fields before reinitializing, while preserving the invite.
  await page.evaluate(() => sessionStorage.setItem('line-test-consent-granted', 'yes'));
  await page.getByRole('button', { name: 'LINEの認証をやり直す', exact: true }).click();
  await expectChatStep(page);
  const calls = await page.evaluate(() => (globalThis as any).__lineTest.loginCalls as string[]);
  expect(calls).toHaveLength(2);
  for (const target of calls) {
    const query = new URL(target).searchParams;
    expect(query.get('t')).toBe(invitationToken);
    expect(query.has('error')).toBe(false);
    expect(query.has('error_description')).toBe(false);
    expect(query.has('liffOAuth2Error')).toBe(false);
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.prepareBodies).toEqual([{ token: invitationToken, id_token: idToken }]);
  expect(state.server.used).toBe(0);
});

test('LINE SDK初期化が失敗したときは登録せず、エラーと再試行を表示する', async ({ page }) => {
  const state = await setup(page, { id: idToken, loggedIn: false, initFailure: true });
  await page.goto(`/invite?t=${invitationToken}`);
  await expect(page.getByRole('alert')).toContainText('LINE初期化を確認できませんでした');
  await expect(page.getByRole('button', { name: 'LINEの認証をやり直す', exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (globalThis as any).__lineTest);
  expect(calls.initOptions).toHaveLength(1); expect(calls.loginCalls).toHaveLength(0);
  expect(state.authBodies).toHaveLength(0); expect(state.prepareBodies).toHaveLength(0); expect(state.registrationBodies).toHaveLength(0);
});

test('認証情報がない場合は企業に紐づけず、招待URLを保って再認証できる', async ({ page }) => {
  const state = await setup(page, { staleCookie: true });
  await page.goto(`/invite?t=${invitationToken}`);
  await expect(page.getByRole('alert')).toContainText('LINEの認証情報を取得できませんでした');
  await expect(page.getByLabel('ご担当者名')).toHaveCount(0);
  await page.getByRole('button', { name: 'LINEの認証をやり直す', exact: true }).click();
  const calls = await page.evaluate(() => (globalThis as any).__lineTest);
  expect(calls.logoutCount).toBe(1);
  expect(new URL(calls.loginCalls[0]).searchParams.get('t')).toBe(invitationToken);
  expect(state.authBodies).toHaveLength(0); expect(state.registrationBodies).toHaveLength(0);
});

test('公開の商品紹介と問い合わせではLINEログインを強制しない', async ({ page }) => {
  await setup(page, { loggedIn: false });
  await page.goto('/?liff.state=%2Fproducts');
  await expect(page.getByRole('heading', { name: '商品紹介', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).__lineTest.loginCalls)).toEqual([]);
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: 'お問い合わせ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'お問い合わせ', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).__lineTest.loginCalls)).toEqual([]);
});

test('独立した別LINE利用者が同じ招待を保持し、それぞれの名前で登録できる', async ({ page, browser, baseURL }) => {
  const secondContext = await browser.newContext({ baseURL });
  try {
    const server = serverState();
    const firstAccount = { ...customer, id: 'independent-line-user-a' }, secondAccount = { ...customer, id: 'independent-line-user-b' };
    const [first, second] = await Promise.all([
      setup(page, { id: 'independent-id-a', account: firstAccount, profileName: 'A担当', server }),
      setup(await secondContext.newPage(), { access: 'independent-access-b', account: secondAccount, profileName: 'B担当', server }),
    ]);
    const secondPage = secondContext.pages()[0];
    await Promise.all([page.goto(`/invite?t=${invitationToken}`), secondPage.goto(`/invite?t=${invitationToken}`)]);
    await Promise.all([expectChatStep(page), expectChatStep(secondPage)]);
    expect(server.handoffs.size).toBe(2); expect(server.used).toBe(0);
    const firstHandoff = server.handoffs.get(firstAccount.id)!.handoff_id;
    await openRichMenuOrder(page); await openRichMenuOrder(secondPage);
    await expect(page.getByLabel('ご担当者名')).toHaveValue('A担当');
    await expect(secondPage.getByLabel('ご担当者名')).toHaveValue('B担当');
    await confirmName(page, '独立ブラウザーA担当');
    await expect(secondPage.getByLabel('ご担当者名')).toHaveValue('B担当');
    expect(second.linked).toBe(false);
    await confirmName(secondPage, '独立ブラウザーB担当');
    expect(first.registrationBodies[0]).toMatchObject({ handoff_id: firstHandoff, id_token: 'independent-id-a' });
    expect(second.registrationBodies[0]).toMatchObject({ access_token: 'independent-access-b' });
    expect(server.used).toBe(2);
    expect(server.accounts.get(firstAccount.id)?.name).toBe('独立ブラウザーA担当');
    expect(server.accounts.get(secondAccount.id)?.name).toBe('独立ブラウザーB担当');
  } finally { await secondContext.close(); }
});

test('同じブラウザーでLINEアカウントが変わっても、以前の担当者や保留招待を引き継がない', async ({ page }) => {
  const server = serverState();
  const firstAccount = { ...customer, id: 'switched-line-user-a' }, secondAccount = { ...customer, id: 'switched-line-user-b' };
  const first = await setup(page, { id: 'switched-id-a', account: firstAccount, profileName: '切替前の担当者', server });
  await page.goto(`/invite?t=${invitationToken}`); await expectChatStep(page); await openRichMenuOrder(page); await confirmName(page, '切替前の担当者');
  await page.unroute('**/api/**'); await page.unroute('**/node_modules/.vite/deps/@line_liff.js*');
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const second = await setup(page, { access: 'switched-access-b', account: secondAccount, profileName: '切替後の担当者', staleCookie: true, staleAccount: server.accounts.get(firstAccount.id), server, waitForAuth: pending });
  await page.goto(`/invite?t=${invitationToken}`);
  try { await expect.poll(() => second.authBodies.length).toBe(1); expect(second.prepareBodies).toHaveLength(0); await expect(page.getByText('切替前の担当者', { exact: false })).toHaveCount(0); } finally { release(); }
  await expectChatStep(page); await openRichMenuOrder(page); await confirmName(page, '切替後の担当者');
  expect(first.authBodies[0]).toEqual({ id_token: 'switched-id-a' });
  expect(second.registrationBodies[0]).toMatchObject({ access_token: 'switched-access-b', staff_name: '切替後の担当者' });
  expect(server.accounts.get(firstAccount.id)?.name).toBe('切替前の担当者');
  expect(server.accounts.get(secondAccount.id)?.name).toBe('切替後の担当者');
});

test('既存利用者もQRではトークへ案内し、通常の注文は直接開ける', async ({ page }) => {
  const state = await setup(page, { id: idToken, registered: true });
  await page.goto(`/invite?t=${invitationToken}`); await expectChatStep(page);
  expect(state.prepareBodies).toHaveLength(1); expect(state.server.used).toBe(0);
  await expect(page.getByRole('link', { name: '小島醸造のトークを開く', exact: true })).toBeVisible();
  await page.goto('/order');
  await expect(page.getByRole('heading', { name: 'ご注文', exact: true })).toBeVisible();
  await expect(page.getByLabel('ご担当者名')).toHaveCount(0);
  expect(state.registrationBodies).toHaveLength(0);
});

test('別会社に登録済みの本人が招待QRを開いても会社を上書きしない', async ({ page }) => {
  const server = serverState(); const member = { ...customer, company_id: 'company-b', company_name: 'B商店' };
  const state = await setup(page, { id: idToken, registered: true, account: member, server });
  await page.goto(`/invite?t=${invitationToken}`);
  await expect(page.getByText(/別のお取引先/).first()).toBeVisible();
  await expect(page.getByLabel('ご担当者名')).toHaveCount(0);
  expect(server.accounts.get(member.id)?.company_id).toBe('company-b');
  expect(server.handoffs.size).toBe(0); expect(state.registrationBodies).toHaveLength(0);
});
