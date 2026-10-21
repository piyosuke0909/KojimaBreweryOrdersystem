import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { z, ZodError } from 'zod';
import type { AppEnv } from './types';
import { authRoutes, requireActor, demoEnabled, verifyLineCredentials, lineCredentialsSchema, clearCustomerSession, resolveActor, attachSession, verifySession } from './auth';
import { adminRoutes } from './routes/admin';
import { customerRoutes } from './routes/customer';
import { publicRoutes } from './routes/public';
import { ApiError } from './services/common';
import { registerInvitation } from './services/invitations';
import { notifyWelcome } from './notifications';
import { recordLineWebhookIdentityChecks } from './services/line-webhook-identity';

export const app = new Hono<AppEnv>();
app.use('/api/*',async(c,next)=>{
  const start=Date.now();
  c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');
  c.header('Referrer-Policy','no-referrer');
  c.header('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  c.header('X-Frame-Options','DENY');
  if(!['GET','HEAD','OPTIONS'].includes(c.req.method)){
    const origin=c.req.header('Origin'),url=new URL(c.req.url);
    const localDev=demoEnabled(c.env,c.req.url)&&origin&&['localhost','127.0.0.1'].includes(new URL(origin).hostname);
    if(c.req.header('Sec-Fetch-Site')==='cross-site'||(origin&&origin!==url.origin&&!localDev))throw new HTTPException(403,{message:'別のサイトからの操作は許可されていません。'});
  }
  await next();c.header('Server-Timing',`app;dur=${Date.now()-start}`);
});
app.use('/api/*',bodyLimit({maxSize:1024*1024,onError:c=>c.json({error:{code:'PAYLOAD_TOO_LARGE',message:'入力データが大きすぎます。'}},413)}));
app.get('/api/health',async c=>{
  await c.env.DB.prepare('SELECT 1').first();
  return c.json({data:{status:'ok',database:'ok',environment:c.env.APP_ENV??'production'}});
});
app.get('/api/config',c=>c.json({data:{liff_id:c.env.LIFF_ID??'',environment:c.env.APP_ENV??'production',demo_enabled:demoEnabled(c.env,c.req.url)}}));
app.route('/api/auth',authRoutes);
app.post('/api/public/invitations/register',async c=>{
  let verifiedSubject:string|undefined;
  try {
    const body=lineCredentialsSchema.extend({token:z.string().min(1).max(256),staff_name:z.string().trim().min(1).max(100)}).parse(await c.req.json());
    let line:{sub:string,name:string};
    if(body.id_token!==undefined||body.access_token!==undefined)line=await verifyLineCredentials(body,c.env);
    else if(demoEnabled(c.env,c.req.url)){
      const session=await verifySession(getCookie(c,'kojima_session')??'',c.env);
      if(!session||session.type!=='customer')throw new HTTPException(401,{message:'LINEでログインしてください。'});
      const current=await resolveActor(c.env,session);
      if(!current)throw new HTTPException(401,{message:'ログインが必要です。'});
      line={sub:current!.id,name:current!.name};
    } else line=await verifyLineCredentials(body,c.env);
    verifiedSubject=line.sub;
    const link=await registerInvitation(c.env.DB,line,body.token,body.staff_name);
    const actor=await resolveActor(c.env,{sub:line.sub,type:'customer'});
    if(!actor)throw new HTTPException(403,{message:'利用者登録を確認できませんでした。'});
    c.executionCtx.waitUntil(notifyWelcome(c.env,line.sub,link.staff_name));
    return await attachSession(c,actor!);
  } catch(error) {await clearCustomerSession(c,verifiedSubject);throw error;}
});
app.route('/api/public',publicRoutes);
app.use('/api/admin/*',requireActor('admin'));
app.use('/api/admin',requireActor('admin'));
app.route('/api/admin',adminRoutes);
app.use('/api/customer/*',requireActor('customer'));
app.use('/api/customer',requireActor('customer'));
app.route('/api/customer',customerRoutes);
app.post('/api/line/webhook',async c=>{
  // Channel secrets never include surrounding whitespace. Match token issuance normalization.
  const channelSecret=c.env.LINE_CHANNEL_SECRET?.trim();
  if(!channelSecret)throw new HTTPException(503,{message:'LINE Webhook は未設定です。'});
  const raw=await c.req.text(),signature=c.req.header('x-line-signature');
  if(!signature)throw new HTTPException(401,{message:'署名が必要です。'});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(channelSecret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(signature),x=>x.charCodeAt(0));}catch{throw new HTTPException(401);}
  if(!await crypto.subtle.verify('HMAC',key,bytes.slice().buffer as ArrayBuffer,new TextEncoder().encode(raw)))throw new HTTPException(401,{message:'署名が一致しません。'});
  // Only a precisely formatted, signed diagnostic message records a non-identifying match result.
  await recordLineWebhookIdentityChecks(c.env,raw);
  // Registration is performed only by the verified invitation flow. A follow event cannot bind a company.
  return c.json({data:{accepted:true}});
});
app.all('/api/*',c=>c.json({error:{code:'NOT_FOUND',message:'指定されたAPIが見つかりません。'}},404));
app.get('*',c=>c.env.ASSETS.fetch(c.req.raw));
app.onError((error,c)=>{
  if(error instanceof ApiError)return c.json({error:{code:error.code,message:error.message}},error.status as any);
  if(error instanceof HTTPException)return c.json({error:{code:`HTTP_${error.status}`,message:error.message}},error.status);
  if(error instanceof ZodError)return c.json({error:{code:'INVALID_INPUT',message:'入力内容を確認してください。',fields:error.issues.map(x=>({path:x.path.join('.'),message:x.message}))}},400);
  if(error instanceof SyntaxError)return c.json({error:{code:'INVALID_JSON',message:'JSON形式の入力が必要です。'}},400);
  const message=String(error);
  if(message.includes('UNIQUE constraint failed'))return c.json({error:{code:'CONFLICT',message:'同じデータが既に登録されています。再読み込みしてください。'}},409);
  if(message.includes('CHECK constraint failed')||message.includes('FOREIGN KEY constraint failed')||message.includes('NOT NULL constraint failed'))return c.json({error:{code:'INVALID_INPUT',message:'関連データまたは入力値を確認してください。'}},400);
  // Do not expose database statements, identity tokens, provider responses, or environment bindings.
  console.error(JSON.stringify({event:'request_error',path:new URL(c.req.url).pathname,kind:error.name}));
  return c.json({error:{code:'INTERNAL_ERROR',message:'処理できませんでした。時間をおいて再度お試しください。'}},500);
});
export default app;
