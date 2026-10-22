import { expect, test, type Page, type Route } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const companyId = 'line-chat-company';
const staffA = '11111111-1111-4111-8111-111111111111';
const staffB = '22222222-2222-4222-8222-222222222222';
const incomingA = '33333333-3333-4333-8333-333333333333';
const incomingB = '44444444-4444-4444-8444-444444444444';
const endpoint = `/api/admin/companies/${companyId}/line-messages`;
type Message = {
  id: string; line_user_id: string; direction: 'incoming' | 'outgoing'; text: string;
  status: 'received' | 'pending' | 'sent' | 'failed' | 'unknown'; created_at: string;
  sent_at: string | null; error_code: string | null; can_retry: boolean; request_id: string | null;
  sequence?: number;
};
type ThreadPage = { messages: Message[]; next_cursor: string | null };
function deferredReply<T>() {
  let capture!: (value: T) => void, release!: () => void;
  const received = new Promise<T>(resolve => { capture = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { received, release, reply: async (value: T) => { capture(structuredClone(value)); await released; return value; } };
}
const message = (id: string, user: string, text: string, extra: Partial<Message> = {}): Message => ({
  id, line_user_id: user, direction: 'incoming', text, status: 'received',
  created_at: '2026-10-22T10:00:00.000Z', sent_at: null, error_code: null, can_retry: false, request_id: null,
  ...extra,
});
type Options = { sendEnabled?: boolean; sendResult?: 'sent' | 'unknown' | 'pending'; firstText?: string; history?: boolean; sameNames?: boolean };
async function setup(page: Page, options: Options = {}) {
  const state = {
    messages: {
      [staffA]: [message(incomingA, staffA, options.firstText || '山田担当からの確認です')],
      [staffB]: [message(incomingB, staffB, '佐藤担当だけのメッセージ')],
    } as Record<string, Message[]>,
    sends: [] as { user: string; body: { text: string; request_id: string; retry?: boolean } }[],
    reads: [] as { user: string; body: { message_ids: string[] } }[],
    messageQueries: [] as { user: string; before: string | null }[],
    threadReplies: [] as ((value: ThreadPage) => Promise<ThreadPage>)[],
    sendReplies: [] as ((value: Message) => Promise<Message>)[],
  };
  await page.addInitScript(() => {
    (window as any).__chatNotificationEvents = 0;
    window.addEventListener('kojima-admin-notifications-changed', () => { (window as any).__chatNotificationEvents++; });
  });
  const send = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: status < 400 ? { data } : { error: data } });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/auth/me') return send(route, { actor: { type: 'admin', id: 'line-chat-admin', role: 'owner', name: '連絡テスト管理者' } });
    if (path === '/api/config') return send(route, { environment: 'production', demo_enabled: false, liff_id: '' });
    if (path === '/api/admin/notifications') return send(route, { items: [], total_unread: 0, counts: { orders: 0, companies: 0 } });
    if (path === `/api/admin/companies/${companyId}`) return send(route, { id: companyId, name: 'LINE連絡テスト商店', contact_name: '窓口担当者', status: 'active', addresses: [], invitations: [], contracts: [], prices: [], line_users: [] });
    if (path === '/api/admin/shipping-rules' || path === '/api/admin/products' || path === '/api/admin/orders') return send(route, []);
    if (path === endpoint) return send(route, {
      contacts: [
        { id: staffA, staff_name: '山田担当', line_display_name: '山田LINE', status: 'active', registered_at: '2026-10-21T10:00:00.000Z', last_message: state.messages[staffA].at(-1), unread_count: 1 },
        { id: staffB, staff_name: options.sameNames ? '山田担当' : '佐藤担当', line_display_name: '佐藤LINE', status: 'active', registered_at: '2026-10-22T10:00:00.000Z', last_message: state.messages[staffB].at(-1), unread_count: 1 },
      ], send_enabled: options.sendEnabled ?? true,
    });
    const match = path.match(new RegExp(`^${endpoint}/([^/]+)(/read)?$`));
    if (match && [staffA, staffB].includes(match[1])) {
      const user = match[1];
      if (match[2]) {
        const body = request.postDataJSON(); state.reads.push({ user, body });
        return send(route, { read: true, read_count: body.message_ids.length });
      }
      if (request.method() === 'GET') {
        const before = url.searchParams.get('before'); state.messageQueries.push({ user, before });
        const snapshot: ThreadPage = structuredClone(before
          ? { messages: [message('55555555-5555-4555-8555-555555555555', user, '前のページの確認メッセージ', { created_at: '2026-10-21T10:00:00.000Z' })], next_cursor: null }
          : { messages: state.messages[user], next_cursor: options.history ? incomingA : null });
        const reply = state.threadReplies.shift();
        return send(route, reply ? await reply(snapshot) : snapshot);
      }
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); state.sends.push({ user, body });
        const existing = state.messages[user].find(item => item.request_id === body.request_id);
        if (existing && body.retry) { existing.status = 'sent'; existing.can_retry = false; existing.error_code = null; existing.sent_at = '2026-10-22T10:01:00.000Z'; return send(route, existing); }
        if (existing) return send(route, existing);
        const status = options.sendResult || 'sent';
        const created = message(crypto.randomUUID(), user, body.text, { direction: 'outgoing', status, request_id: body.request_id,
          sent_at: status === 'sent' ? '2026-10-22T10:01:00.000Z' : null, can_retry: status === 'unknown', error_code: status === 'unknown' ? 'LINE_CHAT_CONNECTION_FAILED' : null });
        state.messages[user].push(created);
        const reply = state.sendReplies.shift();
        return send(route, reply ? await reply(created) : created, status === 'pending' ? 202 : 201);
      }
    }
    return send(route, { code: 'TEST_UNEXPECTED_API', message: path }, 404);
  });
  return state;
}
async function open(page: Page, user = staffA) {
  await page.goto(`/admin/companies/${companyId}?tab=line-messages&line_user_id=${user}`);
  await expect(page.getByRole('combobox', { name: 'LINEの担当者', exact: true })).toHaveValue(user);
}
async function submit(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'メッセージ', exact: true }).fill(text);
  await page.getByRole('button', { name: '送信内容を確認', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'LINEメッセージを送信しますか？', exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}

test('取引先の担当者ごとにLINE会話を開き、表示した受信だけ既読にして画面に収める', async ({ page }) => {
  const state = await setup(page);
  await open(page);
  await expect(page.getByText('山田担当からの確認です', { exact: true })).toBeVisible();
  await expect.poll(() => state.reads.some(value => value.user === staffA && value.body.message_ids.includes(incomingA))).toBe(true);
  expect(state.reads.every(value => !value.body.message_ids.includes(incomingB))).toBe(true);
  expect(state.sends).toHaveLength(0);
  await page.getByRole('combobox', { name: 'LINEの担当者', exact: true }).selectOption(staffB);
  await expect(page.getByText('佐藤担当だけのメッセージ', { exact: true })).toBeVisible();
  await expect(page.getByText('山田担当からの確認です', { exact: true })).toHaveCount(0);
  await expect.poll(() => state.reads.some(value => value.user === staffB && value.body.message_ids.includes(incomingB))).toBe(true);
  expect(await page.evaluate(() => (window as any).__chatNotificationEvents)).toBeGreaterThan(0);
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
});

test('送信前に宛先と本文を確認し、確定したときだけLINEへ1回送る', async ({ page }) => {
  const state = await setup(page); await open(page);
  const text = '納品日のご相談です。明日の午後でよろしいでしょうか。';
  const dialog = await submit(page, text);
  await expect(dialog).toContainText('山田担当'); await expect(dialog).toContainText(text);
  expect(state.sends).toHaveLength(0);
  await dialog.getByRole('button', { name: '戻る', exact: true }).click();
  expect(state.sends).toHaveLength(0);
  await page.getByRole('button', { name: '送信内容を確認', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  expect(state.sends[0]).toMatchObject({ user: staffA, body: { text } });
  expect(state.sends[0].body.request_id).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByText('送信済', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'メッセージ', exact: true })).toHaveValue('');
});

test('送信結果不明を成功扱いせず、再送確認後も同じ識別子と本文を使う', async ({ page }) => {
  const state = await setup(page, { sendResult: 'unknown' }); await open(page);
  await (await submit(page, '再送時も同じ本文です')).getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect(page.getByText('送信結果を確認できません', { exact: true })).toBeVisible();
  await expect(page.getByText('送信済', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '同じメッセージを再送', exact: true }).click();
  expect(state.sends).toHaveLength(1);
  await page.getByRole('dialog').getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(2);
  expect(state.sends[1]).toEqual({ user: staffA, body: { ...state.sends[0].body, retry: true } });
  await expect(page.getByText('送信済', { exact: true })).toBeVisible();
  expect(state.messages[staffA].filter(value => value.direction === 'outgoing')).toHaveLength(1);
});

test('LINEの本文をHTMLとして実行せず、過去の会話を追加で読み込める', async ({ page }) => {
  const text = '<img src="line-chat-xss" onerror="alert(1)">';
  const state = await setup(page, { firstText: text, history: true }); await open(page);
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.locator('img[src="line-chat-xss"]')).toHaveCount(0);
  await page.getByRole('button', { name: '以前のメッセージを表示', exact: true }).click();
  await expect(page.getByText('前のページの確認メッセージ', { exact: true })).toBeVisible();
  expect(state.messageQueries.some(value => value.before === incomingA)).toBe(true);
  expect(state.sends).toHaveLength(0);
});

test('開発環境では実LINE送信を停止し、処理中の結果を送信済みと表示しない', async ({ page }) => {
  const state = await setup(page, { sendEnabled: false }); await open(page);
  await expect(page.getByRole('button', { name: '送信内容を確認', exact: true })).toBeDisabled();
  expect(state.sends).toHaveLength(0);
  const pendingPage = await page.context().newPage();
  const pending = await setup(pendingPage, { sendResult: 'pending' }); await open(pendingPage);
  await (await submit(pendingPage, '送信処理中の検証')).getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect(pendingPage.getByText('送信処理中', { exact: true })).toBeVisible();
  await expect(pendingPage.getByText('送信済', { exact: true })).toHaveCount(0);
  expect(pending.sends).toHaveLength(1);
  await pendingPage.close();
});

test('同じ時刻のメッセージも受信順に並べ、更新後も入力中の本文とフォーカスを保持する', async ({ page }) => {
  const state = await setup(page);
  state.messages[staffA] = [
    message('z-first-message', staffA, '先に受信した本文', { sequence: 1 }),
    message('a-second-message', staffA, '次に受信した本文', { sequence: 2 }),
  ];
  await open(page);
  const bodies = page.locator('.company-line-message p');
  await expect(bodies).toHaveText(['先に受信した本文', '次に受信した本文']);
  const composer = page.getByRole('textbox', { name: 'メッセージ', exact: true });
  await composer.fill('入力中の内容を保持');
  await composer.focus();
  state.messages[staffA].push(message('b-third-message', staffA, '別の時計から後に届いた本文', { sequence: 3, created_at: '2026-10-22T09:59:59.999Z' }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(bodies).toHaveText(['先に受信した本文', '次に受信した本文', '別の時計から後に届いた本文']);
  await expect(composer).toHaveValue('入力中の内容を保持');
  await expect(composer).toBeFocused();
  await expect.poll(() => state.reads.some(value => value.body.message_ids.includes('b-third-message'))).toBe(true);
  expect(state.sends).toHaveLength(0);
});

test('同名の担当者は登録日で区別し、確認した登録先だけへ送信する', async ({ page }) => {
  const state = await setup(page, { sameNames: true });
  await open(page, staffB);
  const selector = page.getByRole('combobox', { name: 'LINEの担当者', exact: true });
  await expect(selector.locator(`option[value="${staffA}"]`)).toContainText('2026/10/21');
  await expect(selector.locator(`option[value="${staffB}"]`)).toContainText('2026/10/22');
  const dialog = await submit(page, '登録先を確認するテスト');
  await expect(dialog).toContainText('2026/10/22');
  expect(state.sends).toHaveLength(0);
  await dialog.getByRole('button', { name: '確認して実行', exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  expect(state.sends[0].user).toBe(staffB);
});

test('古い更新が遅れて届いても取り消し済み本文を戻さず、未取得の履歴は残す', async ({ page }) => {
  const state = await setup(page); await open(page);
  await expect(page.getByText('山田担当からの確認です', { exact: true })).toBeVisible();
  state.messages[staffA].push(message('late-history-message', staffA, '古い応答だけに含まれる履歴'));
  const stale = deferredReply<ThreadPage>(); state.threadReplies.push(stale.reply);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await stale.received;
  state.messages[staffA] = [message(incomingA, staffA, '送信が取り消されました')];
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByText('送信が取り消されました', { exact: true })).toBeVisible();
  stale.release();
  await expect(page.getByText('古い応答だけに含まれる履歴', { exact: true })).toBeVisible();
  await expect(page.getByText('送信が取り消されました', { exact: true })).toBeVisible();
  await expect(page.getByText('山田担当からの確認です', { exact: true })).toHaveCount(0);
  expect(state.sends).toHaveLength(0);
});

test('送信中に取得した古い応答が送信確定後に届いても処理中へ戻さない', async ({ page }) => {
  const state = await setup(page); await open(page);
  await expect(page.getByText('山田担当からの確認です', { exact: true })).toBeVisible();
  const sending = deferredReply<Message>();
  state.sendReplies.push(async value => {
    const final = structuredClone(value);
    value.status = 'pending'; value.sent_at = null;
    await sending.reply(value);
    Object.assign(value, final);
    return value;
  });
  await (await submit(page, '送信結果の順序を確認')).getByRole('button', { name: '確認して実行', exact: true }).click();
  await sending.received;
  state.messages[staffA].push(message('during-send-message', staffA, '送信中の応答に含まれる受信'));
  const stale = deferredReply<ThreadPage>(); state.threadReplies.push(stale.reply);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await stale.received).messages.some(value => value.status === 'pending')).toBe(true);
  sending.release();
  await expect(page.getByText('送信済', { exact: true })).toBeVisible();
  stale.release();
  await expect(page.getByText('送信中の応答に含まれる受信', { exact: true })).toBeVisible();
  await expect(page.getByText('送信済', { exact: true })).toBeVisible();
  await expect(page.getByText('送信処理中', { exact: true })).toHaveCount(0);
  expect(state.sends).toHaveLength(1);
});

test('新しい一覧の更新後に古い履歴ページが届いても履歴とページ送りを保持する', async ({ page }) => {
  const state = await setup(page, { history: true }); await open(page);
  await expect(page.getByText('山田担当からの確認です', { exact: true })).toBeVisible();
  const history = deferredReply<ThreadPage>(); state.threadReplies.push(history.reply);
  await page.getByRole('button', { name: '以前のメッセージを表示', exact: true }).click();
  await history.received;
  state.messages[staffA].push(message('new-while-paging', staffA, '履歴取得中に届いた新着'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('履歴取得中に届いた新着', { exact: true })).toBeVisible();
  history.release();
  await expect(page.getByText('前のページの確認メッセージ', { exact: true })).toBeVisible();
  await expect(page.getByText('履歴取得中に届いた新着', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '以前のメッセージを表示', exact: true })).toHaveCount(0);
  const requests = state.messageQueries.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => state.messageQueries.length).toBeGreaterThan(requests);
  await expect(page.getByText('前のページの確認メッセージ', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '以前のメッセージを表示', exact: true })).toHaveCount(0);
  expect(state.sends).toHaveLength(0);
});
