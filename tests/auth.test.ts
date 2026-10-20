import { describe,expect,it,vi } from 'vitest';
import { checkPassword,demoEnabled,hashPassword,signSession,verifyLineToken,verifySession } from '../src/server/auth';
import type { Bindings } from '../src/server/types';
const env={SESSION_SECRET:'test-secret-longer-than-thirty-two-characters',APP_ENV:'development',ALLOW_DEMO_AUTH:'true'} as Bindings;
describe('認証の署名と開発モード境界',()=>{
  it('salt付きPBKDF2で正しいパスワードだけを検証する',async()=>{
    const first=await hashPassword('a-long-test-password'),second=await hashPassword('a-long-test-password');
    expect(first).not.toBe(second);expect(await checkPassword('a-long-test-password',first)).toBe(true);expect(await checkPassword('wrong',first)).toBe(false);
  });
  it('改ざんされたセッションと異なる署名鍵を拒否する',async()=>{
    const token=await signSession({id:'admin',type:'admin',name:'test'},env);
    expect((await verifySession(token,env))?.sub).toBe('admin');
    expect(await verifySession(token.replace('admin','customer')+'x',env)).toBe(null);
    expect(await verifySession(token,{...env,SESSION_SECRET:'a-different-secret-longer-than-thirty-two'})).toBe(null);
  });
  it('本番や外部ホストではデモ認証を有効にしない',()=>{
    expect(demoEnabled(env,'http://127.0.0.1:8787')).toBe(true);
    expect(demoEnabled({...env,APP_ENV:'production'},'http://127.0.0.1:8787')).toBe(false);
    expect(demoEnabled(env,'https://orders.example.com')).toBe(false);
  });
  it('LINEサーバーが検証したaudienceと期限を確認する',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({sub:'U123',name:'test',aud:'wrong',iss:'https://access.line.me',exp:Math.floor(Date.now()/1000)+1000}),{status:200})));
    await expect(verifyLineToken('id-token',{...env,LINE_CHANNEL_ID:'expected'})).rejects.toThrow();vi.unstubAllGlobals();
  });
});
