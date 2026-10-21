import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Actor, AppEnv, Bindings } from './types';
import { ApiError } from './services/common';

const encoder = new TextEncoder();
const COOKIE = 'kojima_session';
const TOKEN_SECONDS = 60 * 60 * 8;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
const fail = (status: 400 | 401 | 403 | 409 | 429 | 503, message: string) => { throw new HTTPException(status, {message}); };
function sessionSecret(env: Bindings) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) fail(503, 'セッション署名キーが設定されていません。');
  return env.SESSION_SECRET!;
}
async function key(secret: string, usage: KeyUsage[]) { return crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, usage); }
export async function signSession(actor: Actor, env: Bindings) {
  const header = b64(encoder.encode(JSON.stringify({alg:'HS256',typ:'JWT'})));
  const body = b64(encoder.encode(JSON.stringify({sub:actor.id,type:actor.type,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+TOKEN_SECONDS})));
  const data = `${header}.${body}`;
  return `${data}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(sessionSecret(env),['sign']), encoder.encode(data))))}`;
}
export async function verifySession(token: string, env: Bindings): Promise<{sub:string,type:'admin'|'customer'} | null> {
  try {
    const parts=token.split('.'); if(parts.length!==3)return null;
    const header=JSON.parse(new TextDecoder().decode(unb64(parts[0])));
    if(header.alg!=='HS256'||header.typ!=='JWT')return null;
    if(!await crypto.subtle.verify('HMAC', await key(sessionSecret(env),['verify']), unb64(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`)))return null;
    const p=JSON.parse(new TextDecoder().decode(unb64(parts[1]))), now=Math.floor(Date.now()/1000);
    if(!Number.isFinite(p.exp)||!Number.isFinite(p.iat)||p.exp<=now||p.iat>now+30||p.exp-p.iat>TOKEN_SECONDS||typeof p.sub!=='string'||!['admin','customer'].includes(p.type))return null;
    return p;
  } catch { return null; }
}
export async function hashPassword(password:string) {
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const hash=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:100000,salt}, material,256));
  return `pbkdf2-sha256$100000$${b64(salt)}$${b64(hash)}`;
}
export async function checkPassword(password:string, encoded:string) {
  try {
    const [algorithm,iterations,salt,expected]=encoded.split('$');
    if(algorithm!=='pbkdf2-sha256'||Number(iterations)!==100000)return false;
    const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
    const hash=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:Number(iterations),salt:unb64(salt)},material,256));
    const bytes=unb64(expected);let diff=hash.length^bytes.length;for(let i=0;i<hash.length;i++)diff|=hash[i]^(bytes[i]??0);return diff===0;
  } catch {return false;}
}
export async function verifyLineToken(idToken:string,env:Bindings):Promise<{sub:string,name:string}> {
  if(!env.LINE_CHANNEL_ID)fail(503,'LINE Login チャネルIDが未設定です。');
  if(!idToken||idToken.length>10000)fail(401,'LINEでログインしてください。');
  const response=await lineIdentityRequest('https://api.line.me/oauth2/v2.1/verify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id_token:idToken,client_id:env.LINE_CHANNEL_ID!})});
  if(!response.ok)fail(401,'LINE認証の有効期限が切れています。再度ログインしてください。');
  const value=await lineIdentityJson(response) as {sub?:unknown,name?:unknown,aud?:unknown,exp?:unknown,iss?:unknown};
  if(value.iss!=='https://access.line.me'||value.aud!==env.LINE_CHANNEL_ID||typeof value.sub!=='string'||!value.sub||typeof value.exp!=='number'||!Number.isFinite(value.exp)||value.exp<=Date.now()/1000)fail(401,'LINE認証を確認できませんでした。');
  return {sub:value.sub as string,name:typeof value.name==='string'?value.name:''};
}
export const lineCredentialsSchema=z.object({id_token:z.string().min(1).max(10000).optional(),access_token:z.string().min(1).max(10000).optional()});
type LineCredentials=z.infer<typeof lineCredentialsSchema>;
async function lineIdentityRequest(url:string|URL,init:RequestInit={}) {
  try {return await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(10000)});}
  catch {throw new ApiError(502,'LINE_CONNECTION_FAILED','LINEの本人確認に接続できませんでした。時間をおいて再度お試しください。');}
}
async function lineIdentityJson(response:Response):Promise<Record<string,unknown>> {
  try {
    const value:unknown=await response.json();
    if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>;
  } catch { /* Provider responses and credentials must never appear in errors. */ }
  throw new ApiError(502,'LINE_INVALID_RESPONSE','LINEの本人確認結果を確認できませんでした。再度ログインしてください。');
}
/** Resolve only identities verified by the LINE Login channel, never client profile data. */
export async function verifyLineCredentials(credentials:LineCredentials,env:Bindings):Promise<{sub:string,name:string}> {
  // An invalid supplied ID token must not be bypassed with another credential.
  if(credentials.id_token!==undefined)return verifyLineToken(credentials.id_token,env);
  const accessToken=credentials.access_token;
  if(!accessToken)throw new ApiError(401,'LINE_AUTH_REQUIRED','LINEでログインしてから登録してください。');
  if(!env.LINE_CHANNEL_ID)fail(503,'LINE Login チャネルIDが未設定です。');
  const verifyUrl=new URL('https://api.line.me/oauth2/v2.1/verify');
  verifyUrl.searchParams.set('access_token',accessToken);
  const verified=await lineIdentityRequest(verifyUrl);
  if(!verified.ok)throw new ApiError(401,'LINE_ACCESS_TOKEN_INVALID','LINE認証の有効期限が切れています。再度ログインしてください。');
  const claims=await lineIdentityJson(verified);
  if(claims.client_id!==env.LINE_CHANNEL_ID||typeof claims.expires_in!=='number'||!Number.isFinite(claims.expires_in)||claims.expires_in<=0||typeof claims.scope!=='string'||!claims.scope.split(/\s+/).includes('profile')) {
    throw new ApiError(401,'LINE_ACCESS_TOKEN_INVALID','LINEの本人確認ができませんでした。LINEで再度ログインしてください。');
  }
  const profileResponse=await lineIdentityRequest('https://api.line.me/v2/profile',{headers:{Authorization:`Bearer ${accessToken}`}});
  if(!profileResponse.ok)throw new ApiError(401,'LINE_ACCESS_TOKEN_INVALID','LINEの本人確認ができませんでした。LINEで再度ログインしてください。');
  const profile=await lineIdentityJson(profileResponse);
  if(typeof profile.userId!=='string'||!profile.userId||profile.userId.length>256)throw new ApiError(401,'LINE_ACCESS_TOKEN_INVALID','LINEの本人確認ができませんでした。LINEで再度ログインしてください。');
  return {sub:profile.userId,name:typeof profile.displayName==='string'?profile.displayName:''};
}
/** A failed customer LINE identity must not leave another company's cookie active. */
export async function clearCustomerSession(c:any,verifiedSubject?:string) {
  const cookie=getCookie(c,COOKIE);
  if(!cookie)return;
  const session=await verifySession(cookie,c.env);
  if(session?.type==='admin')return;
  if(verifiedSubject&&session?.type==='customer'&&session.sub===verifiedSubject)return;
  deleteCookie(c,COOKIE,{path:'/',httpOnly:true,secure:new URL(c.req.url).protocol==='https:',sameSite:'Strict'});
}
export async function resolveActor(env:Bindings,payload:{sub:string,type:'admin'|'customer'}):Promise<Actor|null> {
  if(payload.type==='admin'){
    const row=await env.DB.prepare("SELECT id,name,role FROM admins WHERE id=? AND status='active'").bind(payload.sub).first<{id:string,name:string,role:string}>();
    return row?{...row,type:'admin'}:null;
  }
  const row=await env.DB.prepare("SELECT l.line_user_id id,l.company_id,l.staff_name,c.name company_name FROM line_users l JOIN companies c ON c.id=l.company_id WHERE l.line_user_id=? AND l.status='active' AND c.status='active' AND c.deleted_at IS NULL").bind(payload.sub).first<{id:string,company_id:string,staff_name:string,company_name:string}>();
  return row?{...row,type:'customer',name:row.staff_name}:null;
}
export const requireActor = (type?:'admin'|'customer') => createMiddleware<AppEnv>(async(c,next)=>{
  let payload = await verifySession(getCookie(c,COOKIE)??'',c.env);
  if(!payload && c.req.header('Authorization')?.startsWith('Bearer ') && type==='customer') {
    const line=await verifyLineToken(c.req.header('Authorization')!.slice(7),c.env);payload={sub:line.sub,type:'customer'};
  }
  if(!payload)fail(401,'ログインが必要です。');
  const actor=await resolveActor(c.env,payload!);
  if(!actor)fail(401,'利用者が無効か、取引先への登録が必要です。');
  if(type&&actor!.type!==type)fail(403,'この操作を行う権限がありません。');
  c.set('actor',actor!);await next();
});
export function demoEnabled(env:Bindings,url:string) {
  return env.APP_ENV==='development'&&env.ALLOW_DEMO_AUTH==='true'&&['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname);
}
export async function attachSession(c:any, actor:Actor) {
  setCookie(c,COOKIE,await signSession(actor,c.env),{path:'/',httpOnly:true,secure:new URL(c.req.url).protocol==='https:',sameSite:'Strict',maxAge:TOKEN_SECONDS});
  c.header('Cache-Control','no-store');return c.json({data:{actor}});
}
const attempts=new Map<string,{count:number,until:number}>();
const loginSchema=z.object({login_id:z.string().min(1).max(100),password:z.string().min(1).max(200)});
export const authRoutes=new Hono<AppEnv>();
authRoutes.post('/admin/login',async c=>{
  const {login_id,password}=loginSchema.parse(await c.req.json());
  const ip=c.req.header('CF-Connecting-IP')??'local', now=Date.now(), record=attempts.get(ip);
  if(record&&record.until>now&&record.count>=8)fail(429,'しばらく待ってからログインしてください。');
  const nextAttempt=record&&record.until>now?record:{count:0,until:now+15*60*1000};nextAttempt.count++;attempts.set(ip,nextAttempt);
  if(attempts.size>10000)for(const [k,v] of attempts)if(v.until<=now)attempts.delete(k);
  let admin=await c.env.DB.prepare('SELECT * FROM admins WHERE login_id=?').bind(login_id).first<any>();
  if(!admin&&login_id==='admin'&&c.env.ADMIN_BOOTSTRAP_PASSWORD){
    const demoOnly=demoEnabled(c.env,c.req.url);
    const count=await c.env.DB.prepare(demoOnly?"SELECT count(*) count FROM admins WHERE login_id!='demo-admin'":'SELECT count(*) count FROM admins').first<{count:number}>();
    const bootstrapHash=await hashPassword(c.env.ADMIN_BOOTSTRAP_PASSWORD);
    if(count?.count===0&&await checkPassword(password,bootstrapHash)){
      const id=crypto.randomUUID(),at=new Date().toISOString();
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO admins(id,login_id,password_hash,name,role,status,created_at) SELECT ?,?,?,?,'owner','active',? WHERE NOT EXISTS(SELECT 1 FROM admins${demoOnly?" WHERE login_id!='demo-admin'":''})`).bind(id,'admin',bootstrapHash,'管理者',at),
        c.env.DB.prepare("INSERT INTO audit_logs(id,acted_at,actor_type,actor_id,action,target_type,target_id) SELECT ?,?,'system',?,'ADMIN_BOOTSTRAP','admins',? WHERE EXISTS(SELECT 1 FROM admins WHERE id=?)").bind(crypto.randomUUID(),at,id,id,id),
      ]);admin=await c.env.DB.prepare('SELECT * FROM admins WHERE login_id=?').bind(login_id).first<any>();
    }
  }
  // A real hash is calculated for missing IDs as well, avoiding a cheap timing distinction.
  const valid=await checkPassword(password,admin?.password_hash??await hashPassword(crypto.randomUUID()));
  if(!admin||admin.status!=='active'||!valid)fail(401,'ログインIDまたはパスワードが違います。');
  attempts.delete(ip);
  return attachSession(c,{id:admin.id,type:'admin',name:admin.name,role:admin.role});
});
authRoutes.post('/line',async c=>{
  try {
    const body=lineCredentialsSchema.parse(await c.req.json());
    const line=await verifyLineCredentials(body,c.env), actor=await resolveActor(c.env,{sub:line.sub,type:'customer'});
    if(!actor)throw new ApiError(403,'LINE_USER_NOT_REGISTERED','LINEログインは完了しました。取引先の招待QRコードから担当者登録を行ってください。');
    return await attachSession(c,actor);
  } catch(error) {await clearCustomerSession(c);throw error;}
});
authRoutes.get('/me',requireActor(), c=>c.json({data:{actor:c.get('actor')}}));
authRoutes.post('/logout',c=>{deleteCookie(c,COOKIE,{path:'/'});return c.json({data:{logged_out:true}});});
authRoutes.post('/demo/admin',async c=>{
  if(!demoEnabled(c.env,c.req.url))fail(403,'デモログインは開発環境専用です。');
  let row=await c.env.DB.prepare("SELECT id,name,role FROM admins WHERE login_id='demo-admin' AND status='active'").first<any>();
  if(!row){
    await c.env.DB.prepare("INSERT OR IGNORE INTO admins(id,login_id,password_hash,name,role,status) VALUES('demo-admin','demo-admin',?,'デモ管理者','owner','active')").bind(await hashPassword(crypto.randomUUID())).run();
    row={id:'demo-admin',name:'デモ管理者',role:'owner'};
  }
  return attachSession(c,{...row,type:'admin'});
});
authRoutes.post('/demo/customer',async c=>{
  if(!demoEnabled(c.env,c.req.url))fail(403,'デモログインは開発環境専用です。');
  const body=z.object({company_id:z.string().max(100).optional()}).parse(await c.req.json().catch(()=>({})));
  const company=await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND status='active' AND deleted_at IS NULL").bind(body.company_id??'company-a').first<{id:string}>();
  if(!company)fail(400,'有効なデモ取引先がありません。');
  const sub=`DEMO_LINE_USER_${company!.id}`;
  await c.env.DB.prepare("INSERT INTO line_users(id,company_id,line_user_id,staff_name,line_display_name,status,note) VALUES(?,?,?,'デモ担当者','デモ利用者','active','開発環境専用') ON CONFLICT(line_user_id) DO UPDATE SET status='active'").bind(`demo-${company!.id}`,company!.id,sub).run();
  return attachSession(c,(await resolveActor(c.env,{sub,type:'customer'}))!);
});
