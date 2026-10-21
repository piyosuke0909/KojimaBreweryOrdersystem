import type { Bindings } from '../types';
import { one } from './common';

const ID_PATTERN=/^U[0-9a-fA-F]{32}$/;
const CODE_PATTERN=/^通知確認-([A-Z0-9]{6})$/;
const encoder=new TextEncoder();
const scalar=(value:unknown)=>typeof value==='string'&&value.length<=256?value:null;
const object=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
async function eventKey(event:Record<string,any>,sourceId:string,code:string){
  const explicit=scalar(event.webhookEventId);
  const value=explicit?'event:'+explicit:'fallback:'+JSON.stringify({message_id:scalar(object(event.message)?.id),timestamp:typeof event.timestamp==='number'&&Number.isFinite(event.timestamp)?event.timestamp:null,source_id:sourceId,check_code:code});
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(value));
  return 'line-identity-'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Call only after verifying the LINE signature. No account is linked, changed or replied to. */
export async function recordLineWebhookIdentityChecks(env:Bindings,verifiedBody:string){
  let envelope:Record<string,any>|null;
  try{envelope=object(JSON.parse(verifiedBody));}catch{return;}
  if(!Array.isArray(envelope?.events))return;
  for(const candidate of envelope.events.slice(0,100)){
    const event=object(candidate),message=object(event?.message),source=object(event?.source);
    if(event?.type!=='message'||message?.type!=='text'||typeof message.text!=='string'||source?.type!=='user'||typeof source.userId!=='string'||!ID_PATTERN.test(source.userId))continue;
    const match=message.text.match(CODE_PATTERN);
    // JS $ may precede a final newline; compare the full match to enforce exact text.
    if(!match||match[0]!==message.text)continue;
    const code=match[1],receivedAt=new Date().toISOString();
    const member=await one(env.DB,"SELECT c.id AS company_id FROM line_users l JOIN companies c ON c.id=l.company_id WHERE l.line_user_id=? AND l.status='active' AND c.status='active' AND c.deleted_at IS NULL LIMIT 1",source.userId);
    const companyId=typeof member?.company_id==='string'?member.company_id:null;
    const id=await eventKey(event,source.userId,code);
    const result={matched:companyId!==null,company_id:companyId,check_code:code,received_at:receivedAt};
    await env.DB.prepare("INSERT OR IGNORE INTO audit_logs(id,acted_at,actor_type,actor_id,company_id,action,target_type,target_id,after_json) VALUES(?,?,'system','line-identity-check',?,'LINE_NOTIFICATION_IDENTITY_CHECK','line_notification_check',?,?)").bind(id,receivedAt,companyId,code,JSON.stringify(result)).run();
  }
}
