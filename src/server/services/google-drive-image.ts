import { parseGoogleDriveImage, resolveProductImageUrl } from '../../shared/product-image';
import { ApiError, fail } from './common';

export const MAX_DRIVE_IMAGE_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 10_000;
const MAX_REDIRECTS = 3;
const HOSTS = new Set(['drive.google.com', 'drive.usercontent.google.com', 'work.fife.usercontent.google.com', 'lh3.googleusercontent.com', 'lh4.googleusercontent.com', 'lh5.googleusercontent.com', 'lh6.googleusercontent.com']);
const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const SHARING_HELP = 'Googleドライブの共有を「リンクを知っている全員」「閲覧者」に設定し、画像ファイルの共有リンクを入力してください。';

function allowedTarget(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && HOSTS.has(url.hostname);
}

/** Bound both fetch and streamed reads, including runtimes/mocks that ignore abort. */
async function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Deadline exceeded');
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error('Deadline exceeded')); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function matchesImageSignature(bytes: Uint8Array, type: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (type === 'image/avif' && ascii(4, 8) === 'ftyp') {
    const end = Math.min(bytes.length, 128, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0));
    for (let offset = 8; offset + 4 <= end; offset += 4) if (['avif', 'avis'].includes(ascii(offset, offset + 4))) return true;
  }
  return false;
}

async function readImage(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_DRIVE_IMAGE_BYTES) {
    void response.body?.cancel().catch(() => {});
    fail(413, 'DRIVE_IMAGE_TOO_LARGE', '画像は8MB以下のファイルを使用してください。');
  }
  if (!response.body) fail(422, 'DRIVE_IMAGE_NOT_SUPPORTED', '画像データを取得できませんでした。' + SHARING_HELP);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await withinDeadline(reader.read(), signal);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_DRIVE_IMAGE_BYTES) fail(413, 'DRIVE_IMAGE_TOO_LARGE', '画像は8MB以下のファイルを使用してください。');
      chunks.push(result.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const image = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { image.set(chunk, offset); offset += chunk.byteLength; }
  return image;
}

/** Admin-only caller; fetches public Drive thumbnails without forwarding credentials. */
export async function previewGoogleDriveImage(input: string): Promise<Response> {
  if (!parseGoogleDriveImage(input)) fail(400, 'DRIVE_IMAGE_URL_INVALID', 'Googleドライブの画像ファイルの共有リンクを入力してください。フォルダのリンクは使用できません。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    let target = new URL(resolveProductImageUrl(input));
    for (let redirects = 0; ; redirects++) {
      if (!allowedTarget(target)) {
        const code = /^lh[0-9]+\.google\.com$/.test(target.hostname) ? 'DRIVE_IMAGE_REDIRECT_GOOGLE_LH_HOST'
          : target.hostname === 'accounts.google.com' ? 'DRIVE_IMAGE_LOGIN_REQUIRED' : 'DRIVE_IMAGE_REDIRECT_UNSUPPORTED';
        fail(422, code, SHARING_HELP);
      }
      const response = await withinDeadline(fetch(target.toString(), {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'image/jpeg,image/png,image/gif,image/webp,image/avif' },
      }), controller.signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) fail(422, 'DRIVE_IMAGE_REDIRECT_INVALID', SHARING_HELP);
        if (redirects >= MAX_REDIRECTS) fail(422, 'DRIVE_IMAGE_REDIRECT_LIMIT', SHARING_HELP);
        try { target = new URL(location!, target); } catch { fail(422, 'DRIVE_IMAGE_REDIRECT_INVALID', SHARING_HELP); }
        continue;
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); fail(422, `DRIVE_IMAGE_HTTP_${response.status}`, '画像を表示できません。' + SHARING_HELP); }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
      if (!TYPES.has(type)) { void response.body?.cancel().catch(() => {}); fail(422, 'DRIVE_IMAGE_NOT_SUPPORTED', 'JPEG・PNG・GIF・WebP・AVIFの画像ファイルを使用してください。' + SHARING_HELP); }
      const image = await readImage(response, controller.signal);
      if (!matchesImageSignature(image, type)) fail(422, 'DRIVE_IMAGE_NOT_SUPPORTED', '画像として読み込めませんでした。画像ファイルの共有リンクを確認してください。');
      return new Response(image.slice().buffer as ArrayBuffer, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) return fail(504, 'DRIVE_IMAGE_TIMEOUT', '画像の取得に時間がかかっています。時間をおいて再確認してください。' + SHARING_HELP);
    return fail(502, 'DRIVE_IMAGE_UNAVAILABLE', '画像を取得できませんでした。' + SHARING_HELP);
  } finally { clearTimeout(timer); }
}
