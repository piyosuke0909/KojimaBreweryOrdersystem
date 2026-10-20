import type { Bindings } from './types';
import { fail } from './services/common';

const TOKEN_ENDPOINT = 'https://api.line.me/oauth2/v3/token';
const REFRESH_EARLY_MS = 60_000;
const MAX_CACHE_ENTRIES = 8;
type CachedToken = { token?: string; refreshAt: number; expiresAt: number; pending?: Promise<string> };
// Stateless tokens are held only in the current Worker isolate. Cold starts issue
// a fresh token; this LINE token type has no maximum active-token count.
const cache = new Map<string, CachedToken>();

function automaticCredentials(env: Bindings) {
  const channelId = env.LINE_MESSAGING_CHANNEL_ID?.trim();
  const secret = env.LINE_CHANNEL_SECRET?.trim();
  return channelId && secret ? { channelId, secret } : null;
}

export function lineAccessTokenConfigured(env: Bindings): boolean {
  const credentials = automaticCredentials(env);
  if (env.LINE_MESSAGING_CHANNEL_ID?.trim()) return !!(credentials && /^\d{8,12}$/.test(credentials.channelId));
  return !!env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
}

async function issueStatelessToken(channelId: string, secret: string) {
  const issuedAfter = Date.now();
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: channelId, client_secret: secret }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail(502, 'LINE_TOKEN_CONNECTION_FAILED', 'LINE認証との通信が完了しませんでした。時間をおいてお試しください。');
  }
  if (!response!.ok) {
    if (response!.status === 429) fail(502, 'LINE_TOKEN_RATE_LIMIT', 'LINE認証の呼出し上限に達しました。時間をおいてお試しください。');
    // Never include provider response bodies: they may repeat request credentials.
    fail(502, 'LINE_TOKEN_ISSUE_FAILED', 'LINEの自動認証に失敗しました。Messaging APIのチャネルIDとシークレットを確認してください。');
  }
  let value: unknown;
  try { value = await response!.json(); }
  catch { fail(502, 'LINE_TOKEN_INVALID_RESPONSE', 'LINEの認証応答を確認できませんでした。'); }
  const token = value as { access_token?: unknown; token_type?: unknown; expires_in?: unknown } | null;
  if (!token || typeof token.access_token !== 'string' || token.access_token.length > 16_384 || !/^[A-Za-z0-9._~+/=-]+$/.test(token.access_token)
    || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
    || typeof token.expires_in !== 'number' || !Number.isInteger(token.expires_in) || token.expires_in <= 60 || token.expires_in > 900) {
    fail(502, 'LINE_TOKEN_INVALID_RESPONSE', 'LINEの認証応答を確認できませんでした。');
  }
  // Starting the lifetime before the request also covers response transit time.
  return { token: token!.access_token as string, expiresAt: issuedAfter + (token!.expires_in as number) * 1000 };
}

/** Resolve a token server-side without returning credentials from any admin API. */
export async function resolveLineAccessToken(env: Bindings): Promise<string> {
  if (env.APP_ENV !== 'production') fail(409, 'LINE_PRODUCTION_REQUIRED', 'LINE認証は本番環境でのみ実行します。');
  const credentials = automaticCredentials(env);
  if (env.LINE_MESSAGING_CHANNEL_ID?.trim() && !credentials) fail(503, 'LINE_TOKEN_NOT_CONFIGURED', 'LINEの自動認証に必要なチャネルシークレットが未設定です。');
  if (!credentials) {
    const fixed = env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    if (!fixed) fail(503, 'LINE_TOKEN_NOT_CONFIGURED', 'LINEの認証設定が未完了です。');
    return fixed!;
  }
  if (!/^\d{8,12}$/.test(credentials.channelId)) fail(503, 'LINE_MESSAGING_CHANNEL_INVALID', 'Messaging APIのチャネルIDが正しく設定されていません。');
  // Credentials participate in the in-memory key so rotating a secret or using a
  // different channel cannot accidentally reuse another channel's token.
  const key = credentials.channelId + '\0' + credentials.secret;
  const now = Date.now();
  for (const [cachedKey, entry] of cache) {
    if (!entry.pending && entry.expiresAt <= now) cache.delete(cachedKey);
  }
  let entry = cache.get(key);
  if (entry?.token && now < entry.refreshAt) return entry.token;
  if (entry?.pending) return entry.pending;
  if (!entry) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldestIdle = [...cache].find(([, candidate]) => !candidate.pending)?.[0];
      if (!oldestIdle) fail(503, 'LINE_TOKEN_ISSUE_BUSY', 'LINE認証の処理中です。少し待ってからお試しください。');
      cache.delete(oldestIdle!);
    }
    entry = { refreshAt: 0, expiresAt: 0 };
    cache.set(key, entry);
  }
  const current = entry;
  current.pending = issueStatelessToken(credentials.channelId, credentials.secret).then(issued => {
    current.token = issued.token;
    current.expiresAt = issued.expiresAt;
    current.refreshAt = current.expiresAt - REFRESH_EARLY_MS;
    return issued.token;
  }).finally(() => {
    current.pending = undefined;
    if (!current.token && cache.get(key) === current) cache.delete(key);
  });
  return current.pending;
}
