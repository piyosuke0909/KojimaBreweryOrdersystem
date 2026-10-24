import { assertChanges, atomic, audit, fail, insert, now, one, settings, string, uid, update, type Row } from './common';
import type { Bindings } from '../types';

const TOKEN_PATTERN=/^[0-9a-f]{64}$/;
const encoder=new TextEncoder();
export type InvitationRegistration = Row & { registration_created:boolean };
function registrationAudit(row:Row|null|undefined) {
  if(!row)return null;
  const {registration_handoff_hash:_receipt,session_version:_version,...business}=row;
  return business;
}
function base64url(bytes:Uint8Array) {return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function bytes(value:string) {
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('Invalid envelope');
  return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),character=>character.charCodeAt(0));
}
export function invitationTokenKey(env:Bindings) {
  // Production QR persistence uses a stable, dedicated secret, independent of session rotation.
  const key=env.INVITATION_TOKEN_ENCRYPTION_KEY||(env.APP_ENV==='development'?env.SESSION_SECRET:undefined);
  if(typeof key!=='string'||key.length<32)fail(503,'INVITATION_QR_NOT_CONFIGURED','招待QRの保存設定が未完了です。管理者へお問い合わせください。');
  return key!;
}
async function encryptionKey(secret:string) {
  if(secret.length<32)fail(503,'INVITATION_QR_NOT_CONFIGURED','招待QRの保存設定が未完了です。');
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(secret));
  return crypto.subtle.importKey('raw',digest,'AES-GCM',false,['encrypt','decrypt']);
}
function additionalData(companyId:string,id:string) {return encoder.encode(`invitation-qr:v1:${companyId}\0${id}`);}
async function sealToken(token:string,secret:string,companyId:string,id:string) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:additionalData(companyId,id)},await encryptionKey(secret),encoder.encode(token));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}
async function openToken(envelope:string,secret:string,companyId:string,id:string) {
  try{
    const parts=envelope.split('.');
    if(parts.length!==3||parts[0]!=='v1')throw new Error('Invalid envelope');
    const iv=bytes(parts[1]),ciphertext=bytes(parts[2]);
    if(iv.length!==12||ciphertext.length!==80)throw new Error('Invalid envelope');
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:additionalData(companyId,id)},await encryptionKey(secret),ciphertext);
    const token=new TextDecoder().decode(plaintext);
    if(!TOKEN_PATTERN.test(token))throw new Error('Invalid token');
    return token;
  }catch{fail(503,'INVITATION_QR_UNAVAILABLE','保存済みの招待QRを表示できません。管理者へお問い合わせください。');}
}
function entryUrl(origin:string,liffId?:string) {
  const id=liffId?.trim();
  if(liffId&&!/^\d{8,12}-[A-Za-z0-9]{1,64}$/.test(id!))fail(503,'LINE_LIFF_NOT_CONFIGURED','LIFF IDが正しく設定されていません。招待QRの発行前に設定を確認してください。');
  return id?`https://liff.line.me/${id}`:origin;
}
export function publicInvitation(row:Row) {
  return {id:row.id,company_id:row.company_id,max_uses:row.max_uses,used_count:row.used_count,expires_at:row.expires_at||null,status:row.status,created_by:row.created_by,created_at:row.created_at,note:row.note,
    qr_available:!!row.token_ciphertext&&row.status==='active'&&!row.deleted_at&&row.company_status!=='inactive'&&!row.company_deleted_at&&(!row.expires_at||Date.parse(row.expires_at)>Date.now())};
}
async function savedInvitation(db:D1Database,companyId:string,id:string) {
  const row=await one(db,'SELECT i.*,c.status AS company_status,c.deleted_at AS company_deleted_at FROM invitations i JOIN companies c ON c.id=i.company_id WHERE i.id=? AND i.company_id=? AND i.deleted_at IS NULL',id,companyId);
  if(!row)fail(404,'NOT_FOUND','招待が見つかりません。');
  if(row!.status!=='active'||row!.company_status!=='active'||row!.company_deleted_at||(row!.expires_at&&Date.parse(row!.expires_at)<=Date.now()))fail(410,'INVITATION_EXPIRED','この招待は無効、または有効期限を過ぎています。');
  return row!;
}
export async function savedInvitationQr(db:D1Database,companyId:string,id:string,origin:string,liffId:string|undefined,secret:string) {
  const row=await savedInvitation(db,companyId,id);
  if(!row.token_ciphertext)fail(409,'INVITATION_QR_NOT_SAVED','この招待QRは保存機能の追加前に発行されています。新しいQRを作成してください。');
  const token=await openToken(row.token_ciphertext,secret,companyId,id);
  if(await hashToken(token!)!==row.token_hash)fail(503,'INVITATION_QR_UNAVAILABLE','保存済みの招待QRを表示できません。管理者へお問い合わせください。');
  return {...publicInvitation(row),url:`${entryUrl(origin,liffId)}/invite?t=${token}`};
}
export async function restoreInvitationQr(db:D1Database,who:Row,companyId:string,id:string,input:Row,origin:string,liffId:string|undefined,secret:string) {
  entryUrl(origin,liffId);
  const row=await savedInvitation(db,companyId,id);
  const token=typeof input.token==='string'?input.token:'';
  if(!TOKEN_PATTERN.test(token)||await hashToken(token)!==row.token_hash)fail(400,'INVALID_INVITATION_TOKEN','招待情報を確認できません。');
  const ciphertext=await sealToken(token,secret,companyId,id);
  await atomic(db,[
    db.prepare("UPDATE invitations SET token_ciphertext=? WHERE id=? AND company_id=? AND deleted_at IS NULL AND status='active' AND (expires_at IS NULL OR expires_at='' OR expires_at>?) AND EXISTS(SELECT 1 FROM companies c WHERE c.id=invitations.company_id AND c.status='active' AND c.deleted_at IS NULL)").bind(ciphertext,id,companyId,now()),
    assertChanges(db,1,who,'INVITE_QR_SAVE','invitations',id,null,{id,company_id:companyId,qr_available:true},companyId),
  ]);
  return savedInvitationQr(db,companyId,id,origin,liffId,secret);
}

export async function hashToken(token: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function validateInvitation(invitation:Row|null, checkCapacity:boolean):Row {
  if(!invitation || invitation.status!=='active' || invitation.company_status!=='active' || (invitation.expires_at && Date.parse(invitation.expires_at)<=Date.now())) fail(410,'INVITATION_EXPIRED','この招待は無効、または有効期限を過ぎています。');
  if(checkCapacity && invitation!.max_uses!=null && invitation!.used_count>=invitation!.max_uses) fail(409,'INVITATION_FULL','この招待の登録上限に達しています。管理者へお問い合わせください。');
  return {...invitation!,expires_at:invitation!.expires_at||null};
}
export async function invitationLookup(db: D1Database, token: string, checkCapacity = true):Promise<Row> {
  string(token,'招待トークン',true,256);
  return validateInvitation(await one(db,`SELECT i.*,c.name AS company_name,c.status AS company_status FROM invitations i JOIN companies c ON c.id=i.company_id WHERE token_hash=? AND i.deleted_at IS NULL AND c.deleted_at IS NULL`,await hashToken(token)),checkCapacity);
}
/** Resolve only a server-stored invitation ID; public registration still needs a token or owned handoff. */
export async function invitationById(db:D1Database,id:string,checkCapacity=true):Promise<Row> {
  return validateInvitation(await one(db,`SELECT i.*,c.name AS company_name,c.status AS company_status FROM invitations i JOIN companies c ON c.id=i.company_id WHERE i.id=? AND i.deleted_at IS NULL AND c.deleted_at IS NULL`,id),checkCapacity);
}
export async function registerInvitation(db: D1Database, verifiedLine: {sub:string;name?:string}, token: string, staffName: string):Promise<InvitationRegistration> {
  return registerVerifiedInvitation(db,verifiedLine,await invitationLookup(db,token,false),staffName);
}
export async function registerInvitationById(db:D1Database,verifiedLine:{sub:string;name?:string},id:string,staffName:string,guards:D1PreparedStatement[],handoffHash?:string):Promise<InvitationRegistration> {
  return registerVerifiedInvitation(db,verifiedLine,await invitationById(db,id,false),staffName,guards,handoffHash);
}
async function registerVerifiedInvitation(db:D1Database,verifiedLine:{sub:string;name?:string},invitation:Row,staffName:string,guards:D1PreparedStatement[] = [],handoffHash?:string):Promise<InvitationRegistration> {
  const name=string(staffName,'担当者名',true,100);
  const existing=await one(db,'SELECT * FROM line_users WHERE line_user_id=?',verifiedLine.sub);
  if(existing?.status==='active' && existing.company_id!==invitation.company_id) fail(409,'ALREADY_REGISTERED','このLINEアカウントは別の取引先に登録されています。');
  if(existing?.status==='active') { if(guards.length)await atomic(db,guards);return {...existing,registration_created:false}; }
  const stamp=now(),id=existing?.id||uid();
  const lineUser={id,company_id:invitation.company_id,line_user_id:verifiedLine.sub,staff_name:name,line_display_name:verifiedLine.name||null,invitation_id:invitation.id,registered_at:stamp,status:'active',session_version:existing?Number(existing.session_version)+1:0,registration_handoff_hash:handoffHash??null};
  const who={id:verifiedLine.sub,type:'customer',company_id:invitation.company_id};
  const statements=[...guards,db.prepare("UPDATE invitations SET used_count=used_count+1 WHERE id=? AND deleted_at IS NULL AND status='active' AND EXISTS(SELECT 1 FROM companies c WHERE c.id=invitations.company_id AND c.status='active' AND c.deleted_at IS NULL) AND (expires_at IS NULL OR expires_at='' OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (max_uses IS NULL OR used_count<max_uses)").bind(invitation.id),assertChanges(db,1,who,'LINE_USER_REGISTER','line_users',id,registrationAudit(existing),registrationAudit(lineUser),invitation.company_id)];
  if(existing) statements.push(update(db,'line_users',lineUser,"id=? AND status='unlinked' AND session_version=?",id,existing.session_version),assertChanges(db,1,who,'LINE_USER_RELINK','line_users',id,registrationAudit(existing),registrationAudit(lineUser),invitation.company_id));
  else statements.push(insert(db,'line_users',lineUser));
  try { await atomic(db,statements); }
  catch(error) {
    const concurrent=await one(db,"SELECT * FROM line_users WHERE line_user_id=? AND company_id=? AND status='active'",verifiedLine.sub,invitation.company_id);
    if(!guards.length && concurrent && (String(error).includes('UNIQUE constraint failed: line_users.line_user_id') || (error instanceof Error && 'code' in error && error.code==='CONFLICT'))) return {...concurrent,registration_created:false};
    throw error;
  }
  return {...lineUser,registration_created:true};
}
export async function issueInvitation(db: D1Database, who: Row, companyId: string, input: Row, origin: string, liffId?: string, secret?:string) {
  const entry=entryUrl(origin,liffId);
  if(!await one(db,"SELECT id FROM companies WHERE id=? AND status='active' AND deleted_at IS NULL",companyId))fail(409,'COMPANY_INACTIVE','有効な取引先にのみ招待を発行できます。');
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const token=Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
  const id=uid(), stamp=now();
  const config=await settings(db);
  const maxUses=input.max_uses===undefined ? Number(config.invite_default_max_uses || 5) : input.max_uses;
  if(maxUses!=null && (!Number.isSafeInteger(maxUses) || maxUses<1 || maxUses>10000)) fail(400,'INVALID_INPUT','登録上限は1〜10000で指定してください。');
  // Existing D1 schema is NOT NULL; empty string is the compatible no-expiry value.
  let expiresAt='';
  if(input.expires_at!=null&&input.expires_at!==''){
    const rawExpiry=string(input.expires_at,'有効期限',true,40);
    if(!Number.isFinite(Date.parse(rawExpiry))||Date.parse(rawExpiry)<=Date.now())fail(400,'INVALID_INPUT','有効期限は未来の日時を指定してください。');
    expiresAt=new Date(rawExpiry).toISOString();
  }
  const invitation={id,company_id:companyId,token_hash:await hashToken(token),token_ciphertext:secret?await sealToken(token,secret,companyId,id):null,max_uses:maxUses,used_count:0,expires_at:expiresAt,status:'active',created_by:who.id,created_at:stamp,note:input.note?string(input.note,'備考',false,2000):null};
  const safe=publicInvitation(invitation);
  await atomic(db,[insert(db,'invitations',invitation),audit(db,who,'INVITE_ISSUE','invitations',id,null,safe,companyId)]);
  // Enter through LIFF so the LINE app's signed-in identity is used consistently.
  return {...safe,token,url:`${entry}/invite?t=${token}`};
}
