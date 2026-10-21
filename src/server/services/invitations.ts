import { assertChanges, atomic, audit, fail, insert, now, one, settings, string, uid, update, type Row } from './common';

export async function hashToken(token: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function invitationLookup(db: D1Database, token: string, checkCapacity = true) {
  string(token,'招待トークン',true,256);
  const invitation=await one(db,`SELECT i.*,c.name AS company_name,c.status AS company_status FROM invitations i JOIN companies c ON c.id=i.company_id WHERE token_hash=? AND i.deleted_at IS NULL AND c.deleted_at IS NULL`,await hashToken(token));
  if(!invitation || invitation.status!=='active' || invitation.company_status!=='active' || (invitation.expires_at && Date.parse(invitation.expires_at)<=Date.now())) fail(410,'INVITATION_EXPIRED','この招待は無効、または有効期限を過ぎています。');
  if(checkCapacity && invitation!.max_uses!=null && invitation!.used_count>=invitation!.max_uses) fail(409,'INVITATION_FULL','この招待の登録上限に達しています。管理者へお問い合わせください。');
  return invitation!;
}
export async function registerInvitation(db: D1Database, verifiedLine: {sub:string;name?:string}, token: string, staffName: string) {
  const name=string(staffName,'担当者名',true,100);
  const invitation=await invitationLookup(db,token,false);
  const existing=await one(db,'SELECT * FROM line_users WHERE line_user_id=?',verifiedLine.sub);
  if(existing?.status==='active' && existing.company_id!==invitation.company_id) fail(409,'ALREADY_REGISTERED','このLINEアカウントは別の取引先に登録されています。');
  if(existing?.status==='active') return existing;
  const stamp=now(),id=existing?.id||uid();
  const lineUser={id,company_id:invitation.company_id,line_user_id:verifiedLine.sub,staff_name:name,line_display_name:verifiedLine.name||null,invitation_id:invitation.id,registered_at:stamp,status:'active'};
  const who={id:verifiedLine.sub,type:'customer',company_id:invitation.company_id};
  const statements=[db.prepare("UPDATE invitations SET used_count=used_count+1 WHERE id=? AND deleted_at IS NULL AND status='active' AND EXISTS(SELECT 1 FROM companies c WHERE c.id=invitations.company_id AND c.status='active' AND c.deleted_at IS NULL) AND (expires_at IS NULL OR expires_at>?) AND (max_uses IS NULL OR used_count<max_uses)").bind(invitation.id,stamp),assertChanges(db,1,who,'LINE_USER_REGISTER','line_users',id,existing,lineUser,invitation.company_id)];
  if(existing) statements.push(update(db,'line_users',lineUser,"id=? AND status='unlinked'",id),assertChanges(db,1,who,'LINE_USER_RELINK','line_users',id,existing,lineUser,invitation.company_id));
  else statements.push(insert(db,'line_users',lineUser));
  try { await atomic(db,statements); }
  catch(error) {
    const concurrent=await one(db,"SELECT * FROM line_users WHERE line_user_id=? AND company_id=? AND status='active'",verifiedLine.sub,invitation.company_id);
    if(concurrent && (String(error).includes('UNIQUE constraint failed: line_users.line_user_id') || (error instanceof Error && 'code' in error && error.code==='CONFLICT'))) return concurrent;
    throw error;
  }
  return lineUser;
}
export async function issueInvitation(db: D1Database, who: Row, companyId: string, input: Row, origin: string, liffId?: string) {
  const configuredLiffId=liffId?.trim();
  if(liffId&&!/^\d{8,12}-[A-Za-z0-9]{1,64}$/.test(configuredLiffId!))fail(503,'LINE_LIFF_NOT_CONFIGURED','LIFF IDが正しく設定されていません。招待QRの発行前に設定を確認してください。');
  if(!await one(db,"SELECT id FROM companies WHERE id=? AND status='active' AND deleted_at IS NULL",companyId))fail(409,'COMPANY_INACTIVE','有効な取引先にのみ招待を発行できます。');
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const token=Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
  const id=uid(), stamp=now();
  const config=await settings(db);
  const maxUses=input.max_uses===undefined ? Number(config.invite_default_max_uses || 5) : input.max_uses;
  if(maxUses!=null && (!Number.isSafeInteger(maxUses) || maxUses<1 || maxUses>10000)) fail(400,'INVALID_INPUT','登録上限は1〜10000で指定してください。');
  const rawExpiry=input.expires_at ? string(input.expires_at,'有効期限',true,40) : new Date(Date.now()+Number(config.invite_valid_days || 30)*86400000).toISOString();
  if(!Number.isFinite(Date.parse(rawExpiry)) || Date.parse(rawExpiry)<=Date.now()) fail(400,'INVALID_INPUT','有効期限は未来の日時を指定してください。');
  const expiresAt=new Date(rawExpiry).toISOString();
  const invitation={id,company_id:companyId,token_hash:await hashToken(token),max_uses:maxUses,used_count:0,expires_at:expiresAt,status:'active',created_by:who.id,created_at:stamp,note:input.note?string(input.note,'備考',false,2000):null};
  const {token_hash,...safe}=invitation;
  await atomic(db,[insert(db,'invitations',invitation),audit(db,who,'INVITE_ISSUE','invitations',id,null,safe,companyId)]);
  // Enter through LIFF so the LINE app's signed-in identity is used consistently.
  const entry=configuredLiffId?`https://liff.line.me/${configuredLiffId}`:origin;
  return {...safe,token,url:`${entry}/invite?t=${token}`};
}
