import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

it('uses workerd-compatible request options and rejects redirects without following them',async()=>{
  // Run the real service in workerd. The local LINE stub constructs workerd Requests,
  // which rejects redirect:'error' even though Node's Request accepts that value.
  const source=`
    import { lineRichMenuStatus } from './src/server/services/line-rich-menu';
    const jpeg = new Uint8Array([255,216,255,192,0,11,8,6,150,9,196,1,1,17,0,255,217]);
    let returnRedirect = false, calls = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      calls++;
      if (request.redirect !== 'manual') throw new Error('Automatic redirects are forbidden');
      if (returnRedirect) return new Response(null, {status:302, headers:{Location:'https://untrusted.example/'}});
      return new URL(request.url).pathname.endsWith('/info')
        ? Response.json({basicId:'@060ucble', displayName:'小島醸造'})
        : Response.json({}, {status:404});
    };
    export default {
      async fetch(request) {
        calls = 0;
        returnRedirect = new URL(request.url).pathname === '/redirect';
        try {
          const data = await lineRichMenuStatus({
            APP_ENV:'production', LINE_CHANNEL_ACCESS_TOKEN:'unit-test-only-token',
            LIFF_ID:'2012094093-ApA0tjfW',
            ASSETS:{fetch:async()=>new Response(jpeg,{headers:{'Content-Type':'image/jpeg'}})}
          }, new URL(request.url).origin);
          return Response.json({data, calls});
        } catch(error) {
          return Response.json({error:{code:error.code}, calls}, {status:error.status ?? 500});
        }
      }
    };
  `;
  const bundled=await build({stdin:{contents:source,loader:'ts',resolveDir:fileURLToPath(new URL('../',import.meta.url))},write:false,bundle:true,format:'esm',platform:'browser',target:'es2022'});
  const worker=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-19',script:bundled.outputFiles[0].text}));
  try {
    const status=await worker.dispatchFetch('https://orders.example/status');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({data:{configured:true,bot:{basic_id:'@060ucble'},default_rich_menu_id:null},calls:2});
    const redirected=await worker.dispatchFetch('https://orders.example/redirect');
    expect(redirected.status).toBe(502);
    expect(await redirected.json()).toMatchObject({error:{code:'LINE_API_FAILED'},calls:1});
  } finally {await worker.dispose();}
},10000);
