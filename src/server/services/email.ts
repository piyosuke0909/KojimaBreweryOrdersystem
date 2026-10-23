import { z } from 'zod';
import type { Actor, Bindings } from '../types';
import { assertChanges, atomic, audit, fail, now, one, type Row } from './common';
import { isSystemResetError, withSystemTask, type SystemTask } from '../system-state';

const gmailScope='https://www.googleapis.com/auth/gmail.send';
const encoder=new TextEncoder();
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
const b64url=(bytes:Uint8Array)=>b64(bytes).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const from64=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0));
const random=()=>b64url(crypto.getRandomValues(new Uint8Array(32)));
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
export type MailResult={status:'sent'|'disabled'|'failed';sent_count:number;failed_count:number;diagnostic?:string};
export type MailKind='create'|'edit'|'cancel';

async function encryptionKey(env:Bindings){
  if(!env.SESSION_SECRET || env.SESSION_SECRET.length<32)fail(503,'MAIL_ENCRYPTION_UNAVAILABLE','メール連携の暗号化設定を確認してください。');
  const material=await crypto.subtle.importKey('raw',encoder.encode(env.SESSION_SECRET),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('kojima-email-credentials-v1'),info:encoder.encode('mail-settings:aes-gcm')},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function encrypt(env:Bindings,value:string,field:string){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(`email-v1:${field}`)},await encryptionKey(env),encoder.encode(value));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(encrypted))}`;
}
async function decrypt(env:Bindings,value:string,field:string){
  try{
    const [version,iv,cipher,...rest]=value.split('.');
    if(version!=='v1'||!iv||!cipher||rest.length)throw new Error('invalid');
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(iv),additionalData:encoder.encode(`email-v1:${field}`)},await encryptionKey(env),from64(cipher));
    return new TextDecoder().decode(plaintext);
  }catch{fail(503,'MAIL_CREDENTIAL_UNAVAILABLE','保存したメール連携情報を読み取れません。連携設定を保存し直してください。');}
}
export const mailConfigRow=(env:Bindings)=>one(env.DB,'SELECT * FROM email_notification_config WHERE id=1');
function redirectUri(origin:string){return new URL('/admin/settings/mail/callback',origin).href;}
const email=z.string().trim().max(254).email();
function normalizeEmail(value:unknown,required=true){
  if(!required&&(value==null||value===''))return '';
  return email.parse(value).toLowerCase();
}
function recipients(value:unknown){
  return [...new Set(z.array(email).max(20).parse(value).map(item=>item.toLowerCase()))];
}
async function legacyConfig(env:Bindings,origin:string):Promise<Row>{
  const row=await one(env.DB,"SELECT value FROM settings WHERE key='notification_email'");
  let addresses:string[]=[];
  try{addresses=recipients(String(row?.value||'').split(/[,;\s]+/).filter(Boolean));}catch{/* An invalid legacy recipient disables delivery safely. */}
  const legacyEnabled=!!(addresses.length&&env.NOTIFICATION_EMAIL_API_KEY&&env.NOTIFICATION_FROM);
  return {id:1,provider:legacyEnabled?'resend':'gmail',enabled:legacyEnabled?1:0,recipients_json:JSON.stringify(addresses),sender_email:'',notify_created:1,notify_edited:1,notify_cancelled:1,gmail_client_id:'',gmail_client_secret_ciphertext:null,gmail_refresh_token_ciphertext:null,app_origin:origin,version:0};
}
export async function getMailSettings(env:Bindings,origin:string){
  const row=await mailConfigRow(env)||await legacyConfig(env,origin);
  return publicConfig(row,env,origin);
}
function publicConfig(row:Row,env:Bindings,origin:string){
  return {provider:row.provider,enabled:!!row.enabled,recipients:JSON.parse(row.recipients_json),sender_email:row.sender_email,notify_created:!!row.notify_created,notify_edited:!!row.notify_edited,notify_cancelled:!!row.notify_cancelled,gmail_client_id:row.gmail_client_id,gmail_client_secret_configured:!!row.gmail_client_secret_ciphertext,gmail_connected:!!row.gmail_refresh_token_ciphertext,redirect_uri:redirectUri(origin),resend_configured:!!(env.NOTIFICATION_EMAIL_API_KEY&&env.NOTIFICATION_FROM)};
}
export async function saveMailSettings(env:Bindings,who:Actor,input:Row,origin:string){
  const before=await mailConfigRow(env)||await legacyConfig(env,origin);
  const data=z.object({provider:z.enum(['gmail','resend']),enabled:z.boolean(),recipients:z.array(email).max(20),sender_email:z.string().max(254),notify_created:z.boolean(),notify_edited:z.boolean(),notify_cancelled:z.boolean(),gmail_client_id:z.string().trim().max(200),gmail_client_secret:z.string().trim().max(2000).optional()}).strict().parse(input);
  const addresses=recipients(data.recipients),sender=normalizeEmail(data.sender_email,false);
  if(data.enabled&&!addresses.length)fail(400,'MAIL_RECIPIENT_REQUIRED','通知先メールアドレスを1件以上登録してください。');
  if(data.gmail_client_id&&!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(data.gmail_client_id))fail(400,'INVALID_GMAIL_CLIENT_ID','GoogleのOAuthクライアントIDを入力してください。');
  if(data.enabled&&data.provider==='gmail'&&!sender)fail(400,'MAIL_SENDER_REQUIRED','送信元のGmailアドレスを入力してください。');
  if(data.enabled&&data.provider==='resend'&&!(env.NOTIFICATION_EMAIL_API_KEY&&env.NOTIFICATION_FROM))fail(409,'RESEND_NOT_CONFIGURED','Resendの送信元とAPIキーが未設定です。Gmail連携を利用するかWorkerの設定を確認してください。');
  const changedClient=data.gmail_client_id!==before.gmail_client_id||!!data.gmail_client_secret;
  const secret=data.gmail_client_secret?await encrypt(env,data.gmail_client_secret,'client-secret'):before.gmail_client_secret_ciphertext;
  const stamp=now();
  const next={provider:data.provider,enabled:data.enabled?1:0,recipients_json:JSON.stringify(addresses),sender_email:sender,notify_created:data.notify_created?1:0,notify_edited:data.notify_edited?1:0,notify_cancelled:data.notify_cancelled?1:0,gmail_client_id:data.gmail_client_id,gmail_client_secret_ciphertext:secret,gmail_refresh_token_ciphertext:changedClient?null:before.gmail_refresh_token_ciphertext,app_origin:origin,version:Number(before.version)+1,updated_at:stamp};
  const fields=Object.keys(next);
  await atomic(env.DB,[
    env.DB.prepare(`INSERT INTO email_notification_config(id,${fields.join(',')}) VALUES(1,${fields.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${fields.map(field=>`${field}=excluded.${field}`).join(',')} WHERE email_notification_config.version=?`).bind(...fields.map(field=>next[field as keyof typeof next]),before.version),
    assertChanges(env.DB,1,who,'MAIL_SETTINGS_UPDATE','email_notification_config','1',publicConfig(before,env,origin),publicConfig(next,env,origin)),
    ...(changedClient?[env.DB.prepare('DELETE FROM gmail_oauth_states')]:[]),
  ]);
  return publicConfig(next,env,origin);
}
export async function startGmailAuthorization(env:Bindings,who:Actor,origin:string){
  if(env.APP_ENV!=='production')fail(409,'MAIL_PRODUCTION_REQUIRED','Gmail連携は本番環境の管理画面から設定してください。');
  const row=await mailConfigRow(env);
  if(!row)return fail(409,'GMAIL_CLIENT_REQUIRED','先にGoogleのクライアントIDとクライアントシークレットを保存してください。');
  if(!row.gmail_client_id||!row.gmail_client_secret_ciphertext)fail(409,'GMAIL_CLIENT_REQUIRED','先にGoogleのクライアントIDとクライアントシークレットを保存してください。');
  const state=random(),verifier=random(),stamp=now(),expires=new Date(Date.now()+10*60000).toISOString(),uri=redirectUri(origin);
  const stateHash=await hash(state),challenge=b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier))));
  await atomic(env.DB,[env.DB.prepare('DELETE FROM gmail_oauth_states WHERE expires_at<=? OR admin_id=?').bind(stamp,who.id),env.DB.prepare('INSERT INTO gmail_oauth_states(state_hash,admin_id,code_verifier_ciphertext,client_id,redirect_uri,config_version,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(stateHash,who.id,await encrypt(env,verifier,'pkce:'+stateHash),row.gmail_client_id,uri,row.version,stamp,expires)]);
  const authorization=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [key,value] of Object.entries({client_id:row.gmail_client_id,redirect_uri:uri,response_type:'code',scope:gmailScope,state,code_challenge:challenge,code_challenge_method:'S256',access_type:'offline',prompt:'consent',include_granted_scopes:'false'}))authorization.searchParams.set(key,value);
  return {authorization_url:authorization.href,redirect_uri:uri};
}
async function providerJson(url:string,init:RequestInit,task?:SystemTask){
  await task?.checkpoint();
  let response:Response;
  try{response=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(10000)});}catch{fail(502,'GMAIL_CONNECTION_FAILED','Gmailへ接続できませんでした。時間をおいて再度お試しください。');}
  let value:Row={};try{value=await response!.json() as Row;}catch{/* Never include provider response data in errors. */}
  if(!response!.ok){
    if(value?.error==='invalid_grant')fail(409,'GMAIL_AUTHORIZATION_REQUIRED','Gmailの認可が切れています。もう一度Gmail連携を行ってください。');
    fail(502,'GMAIL_PROVIDER_REJECTED','Googleがメール連携を受け付けませんでした。クライアント設定と認可状態を確認してください。');
  }
  return value;
}
function verifiedToken(value:Row,requireRefresh=false){
  if(typeof value.access_token!=='string'||!value.access_token||value.access_token.length>10000||value.token_type?.toLowerCase()!=='bearer'||typeof value.expires_in!=='number'||value.expires_in<=0)fail(502,'GMAIL_INVALID_RESPONSE','Googleの認可結果を確認できませんでした。連携をやり直してください。');
  if((requireRefresh||value.scope!=null)&&(typeof value.scope!=='string'||!value.scope.split(/\s+/).includes(gmailScope)))fail(403,'GMAIL_SCOPE_REQUIRED','Gmailのメール送信権限が必要です。もう一度連携し、送信を許可してください。');
  if(requireRefresh&&(typeof value.refresh_token!=='string'||!value.refresh_token||value.refresh_token.length>10000))fail(409,'GMAIL_OFFLINE_ACCESS_REQUIRED','継続して通知する権限を取得できませんでした。Googleアカウントの連携を解除してから、もう一度連携してください。');
  return value.access_token as string;
}
export async function finishGmailAuthorization(env:Bindings,who:Actor,input:Row,origin:string){
  return withSystemTask(env,'gmail_authorization',async task=>{
  const {state,code}=z.object({state:z.string().min(20).max(256),code:z.string().min(1).max(4096)}).strict().parse(input);
  const stateHash=await hash(state),stamp=now(),pending=await one(env.DB,'SELECT * FROM gmail_oauth_states WHERE state_hash=? AND admin_id=? AND expires_at>?',stateHash,who.id,stamp);
  const row=await mailConfigRow(env);
  if(!pending||!row||pending.config_version!==row.version||pending.client_id!==row.gmail_client_id||pending.redirect_uri!==redirectUri(origin))fail(409,'GMAIL_AUTHORIZATION_EXPIRED','連携操作の期限が切れたか設定が変更されました。「Gmailと連携」からやり直してください。');
  const verifier=await decrypt(env,pending!.code_verifier_ciphertext,'pkce:'+stateHash),secret=await decrypt(env,row!.gmail_client_secret_ciphertext,'client-secret');
  await atomic(env.DB,[env.DB.prepare('DELETE FROM gmail_oauth_states WHERE state_hash=? AND admin_id=? AND expires_at>?').bind(stateHash,who.id,stamp),assertChanges(env.DB,1,who,'GMAIL_OAUTH_CONSUME','email_notification_config','1',null,{authorization_consumed:true})]);
  const result=await providerJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,client_id:row!.gmail_client_id,client_secret:secret!,redirect_uri:pending!.redirect_uri,code_verifier:verifier!})},task);
  verifiedToken(result,true);
  const refreshCipher=await encrypt(env,result.refresh_token,'refresh-token');
  await atomic(env.DB,[env.DB.prepare('UPDATE email_notification_config SET gmail_refresh_token_ciphertext=?,version=version+1,updated_at=? WHERE id=1 AND version=?').bind(refreshCipher,now(),row!.version),assertChanges(env.DB,1,who,'GMAIL_CONNECTED','email_notification_config','1',{gmail_connected:!!row!.gmail_refresh_token_ciphertext},{gmail_connected:true})]);
  return getMailSettings(env,origin);
  });
}
export async function disconnectGmail(env:Bindings,who:Actor,origin:string){
  await atomic(env.DB,[env.DB.prepare("UPDATE email_notification_config SET gmail_refresh_token_ciphertext=NULL,enabled=CASE WHEN provider='gmail' THEN 0 ELSE enabled END,version=version+1,updated_at=? WHERE id=1").bind(now()),env.DB.prepare('DELETE FROM gmail_oauth_states'),audit(env.DB,who,'GMAIL_DISCONNECTED','email_notification_config','1',null,{gmail_connected:false})]);
  return getMailSettings(env,origin);
}
function mime(from:string,to:string,subject:string,text:string){
  const content=b64(encoder.encode(text)).match(/.{1,76}/g)?.join('\r\n')||'';
  const raw=`From: ${from}\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${b64(encoder.encode(subject))}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}\r\n`;
  return b64url(encoder.encode(raw));
}
const diagnostic=(error:unknown)=>error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^GMAIL_[A-Z_]+$/.test(error.code)?error.code.toLowerCase():'email_connection_failed';
async function deliver(env:Bindings,row:Row,subject:string,text:string):Promise<MailResult>{
  if(env.APP_ENV!=='production')return {status:'disabled',sent_count:0,failed_count:0,diagnostic:'production_only'};
  let addresses:string[];
  try{addresses=recipients(JSON.parse(row.recipients_json));}catch{return {status:'failed',sent_count:0,failed_count:0,diagnostic:'invalid_email_recipients'};}
  if(!addresses.length)return {status:'disabled',sent_count:0,failed_count:0,diagnostic:'recipients_not_configured'};
  return withSystemTask(env,'email_delivery',async task=>{
  let access:string|undefined;
  try{
    if(row.provider==='gmail'){
      if(!row.gmail_client_id||!row.gmail_client_secret_ciphertext||!row.gmail_refresh_token_ciphertext||!row.sender_email)return {status:'failed',sent_count:0,failed_count:addresses.length,diagnostic:'gmail_not_connected'};
      const secret=await decrypt(env,row.gmail_client_secret_ciphertext,'client-secret'),refresh=await decrypt(env,row.gmail_refresh_token_ciphertext,'refresh-token');
      const token=await providerJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:row.gmail_client_id,client_secret:secret!,refresh_token:refresh!})},task);
      access=verifiedToken(token);
    }else if(!env.NOTIFICATION_EMAIL_API_KEY||!env.NOTIFICATION_FROM)return {status:'failed',sent_count:0,failed_count:addresses.length,diagnostic:'resend_not_configured'};
  }catch(error){if(isSystemResetError(error))throw error;return {status:'failed',sent_count:0,failed_count:addresses.length,diagnostic:diagnostic(error)};}
  // Each recipient receives a separate message; recipient addresses are never shared.
  const settled=await Promise.allSettled(addresses.map(async to=>{
    try{
      const request=row.provider==='gmail'?{url:'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',authorization:`Bearer ${access}`,data:{raw:mime(row.sender_email,to,subject,text)}}:{url:'https://api.resend.com/emails',authorization:`Bearer ${env.NOTIFICATION_EMAIL_API_KEY}`,data:{from:env.NOTIFICATION_FROM,to:[to],subject,text}};
      await task.checkpoint();
      const response=await fetch(request.url,{method:'POST',headers:{Authorization:request.authorization,'Content-Type':'application/json'},body:JSON.stringify(request.data),redirect:'manual',signal:AbortSignal.timeout(10000)});
      return response.ok?{sent:true}:{sent:false,diagnostic:`${row.provider}_http_${response.status}`};
    }catch(error){if(isSystemResetError(error))throw error;return {sent:false,diagnostic:'email_connection_failed'};}
  }));
  // Keep the lease until every accepted send finishes, including when another
  // recipient's checkpoint fails. Promise.all would release it too early.
  const rejected=settled.find(result=>result.status==='rejected');
  if(rejected?.status==='rejected')throw rejected.reason;
  const results=settled.map(result=>(result as PromiseFulfilledResult<{sent:boolean;diagnostic?:string}>).value);
  const sent=results.filter(result=>result.sent).length;
  return {status:sent===addresses.length?'sent':'failed',sent_count:sent,failed_count:addresses.length-sent,...(sent===addresses.length?{}:{diagnostic:results.find(result=>!result.sent)?.diagnostic})};
  });
}
export async function sendOrderEmail(env:Bindings,order:Row,kind:MailKind,subject:string,text:string):Promise<MailResult>{
  if(String(order.id).startsWith('TEST-O'))return {status:'disabled',sent_count:0,failed_count:0,diagnostic:'demo_order'};
  const row=await mailConfigRow(env)||await legacyConfig(env,'');
  const flag={create:'notify_created',edit:'notify_edited',cancel:'notify_cancelled'}[kind];
  if(!row.enabled||!row[flag])return {status:'disabled',sent_count:0,failed_count:0};
  let company:string='';
  if(order.company_id){const companyRow=await one(env.DB,'SELECT name FROM companies WHERE id=?',order.company_id);company=companyRow?.name||'';}
  const details=[company&&`お取引先: ${company}`,order.ordered_by_name&&`ご担当者: ${order.ordered_by_name}`,row.app_origin&&`管理画面: ${row.app_origin}/admin/orders/${encodeURIComponent(order.id)}`].filter(Boolean).join('\n');
  return deliver(env,row,subject,details?`${text}\n${details}`:text);
}
export async function testMailSettings(env:Bindings,who:Actor):Promise<MailResult>{
  const row=await mailConfigRow(env);
  if(!row)fail(409,'MAIL_SETTINGS_REQUIRED','先にメール設定を保存してください。');
  const result=await deliver(env,row!,'【小島醸造】通知メールの送信テスト','小島醸造注文システムの通知メール送信テストです。実際の注文・出荷・お支払いはありません。');
  await atomic(env.DB,[audit(env.DB,who,'MAIL_TEST_SEND','email_notification_config','1',null,{status:result.status,sent_count:result.sent_count,failed_count:result.failed_count,diagnostic:result.diagnostic||null})]);
  return result;
}
