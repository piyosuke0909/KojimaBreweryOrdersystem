import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

it('issues and caches stateless tokens with workerd Request and URLSearchParams', async () => {
  const source = `
    import { resolveLineAccessToken } from './src/server/line-access-token';
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== 'https://api.line.me/oauth2/v3/token' || request.redirect !== 'manual') throw new Error('Unexpected provider request');
      const form = new URLSearchParams(await request.text());
      if (request.method !== 'POST' || request.headers.has('Authorization') || form.get('grant_type') !== 'client_credentials'
          || form.get('client_id') !== '2011903727' || form.get('client_secret') !== 'runtime-only-secret') throw new Error('Invalid token request');
      calls++;
      return Response.json({access_token:'runtime-only-issued-token',token_type:'Bearer',expires_in:900});
    };
    export default {
      async fetch() {
        const env = {APP_ENV:'production',LINE_MESSAGING_CHANNEL_ID:'2011903727',LINE_CHANNEL_SECRET:'runtime-only-secret',LINE_CHANNEL_ACCESS_TOKEN:'invalid-old-token'};
        const values = await Promise.all([resolveLineAccessToken(env), resolveLineAccessToken(env), resolveLineAccessToken(env)]);
        return Response.json({issued:values.every(value=>value==='runtime-only-issued-token'), calls});
      }
    };
  `;
  const bundled = await build({ stdin: { contents: source, loader: 'ts', resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
  const worker = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-19', script: bundled.outputFiles[0].text }));
  try {
    const first = await worker.dispatchFetch('https://orders.example/resolve');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ issued: true, calls: 1 });
    const cached = await worker.dispatchFetch('https://orders.example/resolve');
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual({ issued: true, calls: 1 });
  } finally { await worker.dispose(); }
}, 10000);
