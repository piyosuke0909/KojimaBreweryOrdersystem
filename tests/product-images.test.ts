import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import type { Bindings } from '../src/server/types';
import { MAX_DRIVE_IMAGE_BYTES } from '../src/server/services/google-drive-image';
import { isGoogleDriveUrl, parseGoogleDriveImage, resolveProductImageUrl } from '../src/shared/product-image';
import { migrateTestDatabase } from './helpers/migrate';

const ID = 'sample_file-id_12345';
const SHARED = `https://drive.google.com/file/d/${ID}/view?usp=sharing&resourcekey=0-example_key`;
const THUMBNAIL = `https://drive.google.com/thumbnail?id=${ID}&sz=w1200&resourcekey=0-example_key`;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const image = (body: Uint8Array = PNG, headers: HeadersInit = {}) => new Response(body.slice().buffer, { headers: { 'Content-Type': 'image/png', ...headers } });

describe('shared product image URL resolution', () => {
  it('normalizes supported Drive file links and retains resource keys without storing new values', () => {
    for (const url of [SHARED, `https://drive.google.com/open?id=${ID}&resourcekey=0-example_key`, `https://drive.google.com/uc?export=view&id=${ID}&resourcekey=0-example_key`, `https://drive.google.com/thumbnail?id=${ID}&sz=w400&resourcekey=0-example_key`]) {
      expect(parseGoogleDriveImage(url)).toEqual({ fileId: ID, resourceKey: '0-example_key' });
      expect(resolveProductImageUrl(url)).toBe(THUMBNAIL);
    }
    expect(resolveProductImageUrl(`https://drive.google.com/file/d/${ID}/preview`)).toBe(`https://drive.google.com/thumbnail?id=${ID}&sz=w1200`);
    expect(resolveProductImageUrl(' https://images.example.com/image.png ')).toBe('https://images.example.com/image.png');
    expect(resolveProductImageUrl(' /assets/products/example.png ')).toBe('/assets/products/example.png');
    expect(resolveProductImageUrl(null)).toBe('');
    expect(resolveProductImageUrl(undefined)).toBe('');
  });

  it('does not recognize credentials, lookalike hosts, folders, encoded separators, or ambiguous IDs as a Drive file', () => {
    for (const url of [`http://drive.google.com/file/d/${ID}/view`, `https://drive.google.com.evil.example/file/d/${ID}/view`, `https://drive.google.com@evil.example/file/d/${ID}/view`, `https://user:pass@drive.google.com/file/d/${ID}/view`, `https://drive.google.com:8443/file/d/${ID}/view`, `https://drive.google.com/drive/folders/${ID}`, `https://drive.google.com/file/d/${ID}%2fother/view`, `https://drive.google.com/open?id=${ID}&id=another_file_id`, SHARED + '&resourcekey=another', SHARED.replace('0-example_key', 'bad%2fkey')]) {
      expect(parseGoogleDriveImage(url)).toBeNull();
      expect(resolveProductImageUrl(url)).toBe(url);
    }
    expect(isGoogleDriveUrl(`https://drive.google.com/drive/folders/${ID}`)).toBe(true);
    expect(isGoogleDriveUrl(`https://drive.google.com.evil.example/open?id=${ID}`)).toBe(false);
  });
});

class SqliteD1 {
  sqlite = new DatabaseSync(':memory:');
  prepare(sql: string) { return new Statement(this, sql); }
  binding() { return this as unknown as D1Database; }
}
class Statement {
  constructor(private db: SqliteD1, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.db, this.sql, args); }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) ?? null; }
}
let db: SqliteD1, env: Bindings, adminCookie: string, customerCookie: string;
beforeEach(async () => {
  db = new SqliteD1(); migrateTestDatabase(db.sqlite);
  db.sqlite.exec("INSERT INTO admins(id,login_id,password_hash,name) VALUES('image-admin','image-admin','unused','画像担当者'); INSERT INTO companies(id,name) VALUES('image-company','画像検証企業'); INSERT INTO line_users(id,company_id,line_user_id,staff_name,status) VALUES('image-member','image-company','IMAGE_TEST_CUSTOMER','画像担当者','active');");
  env = { DB: db.binding(), APP_ENV: 'production', SESSION_SECRET: 'product-images-session-secret-longer-than-32-characters' } as Bindings;
  adminCookie = 'kojima_session=' + await signSession({ id: 'image-admin', type: 'admin', role: 'staff', name: '画像担当者' }, env);
  customerCookie = 'kojima_session=' + await signSession({ id: 'IMAGE_TEST_CUSTOMER', type: 'customer', company_id: 'image-company', name: '画像担当者' }, env);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); db.sqlite.close(); });
const request = (cookie = adminCookie, imageUrl = SHARED) => app.request('https://orders.example/api/admin/product-image-preview', {
  method: 'POST', headers: { Cookie: cookie, Authorization: 'Bearer private-inbound-token', Origin: 'https://orders.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ image_url: imageUrl }),
}, env);

describe('administrative Google Drive image preview', () => {
  it('requires active admin authentication and refuses arbitrary source URLs before external fetch', async () => {
    const external = vi.fn(); vi.stubGlobal('fetch', external);
    expect((await request('')).status).toBe(401);
    expect((await request(customerCookie)).status).toBe(403);
    for (const url of ['https://internal.example/private', 'http://127.0.0.1/secret', `https://drive.google.com/drive/folders/${ID}`]) expect((await request(adminCookie, url)).status).toBe(400);
    db.sqlite.prepare("UPDATE admins SET status='inactive' WHERE id='image-admin'").run();
    expect((await request()).status).toBe(401);
    expect(external).not.toHaveBeenCalled();
  });

  it('follows only verified Google redirects and returns raw image bytes without forwarding cookies or tokens', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('Cookie')).toBeNull(); expect(headers.get('Authorization')).toBeNull();
      if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: 'https://work.fife.usercontent.google.com/public-thumbnail' } });
      if (calls.length === 2) return new Response(null, { status: 302, headers: { Location: 'https://lh3.googleusercontent.com/sample-image' } });
      return image();
    }));
    const response = await request();
    expect(calls).toEqual([THUMBNAIL, 'https://work.fife.usercontent.google.com/public-thumbnail', 'https://lh3.googleusercontent.com/sample-image']);
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png'); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(db.sqlite.prepare('SELECT count(*) count FROM audit_logs').get()).toMatchObject({ count: 0 });
  });

  it('accepts the supported raster image formats without passing through provider headers', async () => {
    const examples: [string, Uint8Array][] = [
      ['image/jpeg', new Uint8Array([255, 216, 255, 224])],
      ['image/gif', new TextEncoder().encode('GIF89a')],
      ['image/webp', new TextEncoder().encode('RIFF0000WEBP')],
      ['image/avif', new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 97, 118, 105, 102, 0, 0, 0, 0, 109, 105, 102, 49])],
    ];
    for (const [type, bytes] of examples) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes.slice().buffer, { headers: { 'Content-Type': type, 'Set-Cookie': 'private-provider-cookie=secret', 'X-Private-Provider': 'private-header' } })));
      const response = await request(); expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe(type);
      expect(response.headers.get('Set-Cookie')).toBeNull(); expect(response.headers.get('X-Private-Provider')).toBeNull();
    }
  });

  it.each(['http://lh3.googleusercontent.com/image', 'https://lh3.googleusercontent.com.evil.example/image', 'https://127.0.0.1/image', 'https://accounts.google.com/login', 'https://user:pass@lh3.googleusercontent.com/image', 'https://lh3.googleusercontent.com:8443/image'])('blocks untrusted redirect %s before fetching it', async location => {
    const external = vi.fn(async () => new Response(null, { status: 302, headers: { Location: location } })); vi.stubGlobal('fetch', external);
    const response = await request(); expect(response.status).toBe(422); expect(external).toHaveBeenCalledTimes(1);
    const result = await response.json() as any;
    expect(result.error.code).toBe(location === 'https://accounts.google.com/login' ? 'DRIVE_IMAGE_LOGIN_REQUIRED' : 'DRIVE_IMAGE_REDIRECT_UNSUPPORTED');
    const text = JSON.stringify(result); expect(text).toContain('リンクを知っている全員'); expect(text).not.toContain(location);
  });

  it('limits redirect chains to three hops and never reflects provider error contents', async () => {
    const external = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://lh3.googleusercontent.com/loop' } })); vi.stubGlobal('fetch', external);
    const limited = await request(); expect(limited.status).toBe(422); expect(external).toHaveBeenCalledTimes(4);
    expect((await limited.json() as any).error.code).toBe('DRIVE_IMAGE_REDIRECT_LIMIT');
    for (const location of [undefined, 'http://[']) {
      external.mockImplementation(async () => new Response(null, { status: 302, headers: location === undefined ? {} : { Location: location } }));
      const invalid = await request(); expect(invalid.status).toBe(422);
      expect((await invalid.json() as any).error.code).toBe('DRIVE_IMAGE_REDIRECT_INVALID');
    }
    external.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'https://lh3.google.com/private-image-location' } }));
    const alternateGoogle = await request(); expect(alternateGoogle.status).toBe(422);
    const alternateResult = await alternateGoogle.json() as any;
    expect(alternateResult.error.code).toBe('DRIVE_IMAGE_REDIRECT_GOOGLE_LH_HOST');
    expect(JSON.stringify(alternateResult)).not.toContain('lh3.google.com');
    expect(JSON.stringify(alternateResult)).not.toContain('private-image-location');
    external.mockImplementation(async () => new Response('PRIVATE-GOOGLE-BODY', { status: 403 }));
    const denied = await request(); expect(denied.status).toBe(422);
    const result = await denied.json() as any; expect(result.error.code).toBe('DRIVE_IMAGE_HTTP_403');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-GOOGLE-BODY');
  });

  it.each([['text/html', '<html>PRIVATE-GOOGLE-BODY</html>'], ['image/svg+xml', '<svg>PRIVATE-GOOGLE-BODY</svg>'], ['image/png', '<html>NOT-AN-IMAGE</html>']])('rejects %s responses and mislabeled non-images', async (type, data) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(data, { headers: { 'Content-Type': type } })));
    const response = await request(); expect(response.status).toBe(422);
    const result = await response.text(); expect(result).not.toContain('PRIVATE-GOOGLE-BODY'); expect(result).not.toContain('NOT-AN-IMAGE');
  });

  it('caps image bytes using both Content-Length and incremental reads', async () => {
    const external = vi.fn(async () => image(PNG, { 'Content-Length': String(MAX_DRIVE_IMAGE_BYTES + 1) })); vi.stubGlobal('fetch', external);
    expect((await request()).status).toBe(413);
    let chunks = 0, canceled = false;
    external.mockImplementation(async () => new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { canceled = true; },
    }), { headers: { 'Content-Type': 'image/png' } }));
    expect((await request()).status).toBe(413); expect(canceled).toBe(true); expect(chunks).toBeLessThanOrEqual(10);
  });

  it('enforces one ten-second deadline and does not disclose fetch exceptions', async () => {
    vi.useFakeTimers();
    const external = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', external);
    const pending = request();
    await vi.waitFor(() => expect(external).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending; expect(response.status).toBe(504); expect((external.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
    vi.useRealTimers();
    external.mockImplementation(async () => { throw new Error('PRIVATE-FETCH-EXCEPTION'); });
    const failed = await request(); expect(failed.status).toBe(502); expect(await failed.text()).not.toContain('PRIVATE-FETCH-EXCEPTION');
  });

  it('keeps the same ten-second deadline while reading a slow image stream', async () => {
    vi.useFakeTimers();
    let reading = false, canceled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(PNG); },
      pull() { reading = true; return new Promise<void>(() => {}); },
      cancel() { canceled = true; },
    }), { headers: { 'Content-Type': 'image/png' } })));
    const pending = request();
    await vi.waitFor(() => expect(reading).toBe(true));
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending; expect(response.status).toBe(504); expect(canceled).toBe(true);
  });
});
