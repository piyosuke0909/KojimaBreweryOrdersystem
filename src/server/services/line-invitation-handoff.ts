import { assertChanges, atomic, fail, now, one, string, uid, type Row } from './common';
import { hashToken, invitationById, invitationLookup, registerInvitationById, type InvitationRegistration } from './invitations';
import type { Bindings } from '../types';

type Identity = { sub:string; name?:string };
const duration = 24 * 60 * 60 * 1000;
async function subjectHash(env:Bindings,identity:Identity) {
  return hashToken(`line-invitation-handoff:v1:${env.LINE_CHANNEL_ID}\0${identity.sub}`);
}
async function existingMember(db:D1Database,identity:Identity,invitation:Row) {
  const existing=await one(db,"SELECT company_id FROM line_users WHERE line_user_id=? AND status='active'",identity.sub);
  if(existing && existing.company_id!==invitation.company_id)fail(409,'ALREADY_REGISTERED','このLINEアカウントは別の取引先に登録されています。');
  return !!existing;
}
function view(invitation:Row,handoffId:string|null,registered=false) {
  return {pending:!registered,handoff_id:handoffId,company_id:invitation.company_id,company_name:invitation.company_name,already_registered:registered};
}
function requireCapacity(invitation:Row) {
  if(invitation.max_uses!=null && invitation.used_count>=invitation.max_uses)fail(409,'INVITATION_FULL','この招待の登録上限に達しています。管理者へお問い合わせください。');
}
export async function prepareInvitationHandoff(env:Bindings,identity:Identity,token:string) {
  const invitation=await invitationLookup(env.DB,token,false);
  const registered=await existingMember(env.DB,identity,invitation);
  const hash=await subjectHash(env,identity),stamp=now();
  if(registered) {
    await env.DB.prepare('DELETE FROM line_invitation_handoffs WHERE subject_hash=?').bind(hash).run();
    return view(invitation,null,true);
  }
  requireCapacity(invitation);
  // Reopening the same QR preserves its nonce, whereas a different company/QR
  // rotates it so a previously displayed registration form cannot bind silently.
  const old=await one(env.DB,'SELECT * FROM line_invitation_handoffs WHERE subject_hash=?',hash);
  const handoffId=old && old.invitation_id===invitation.id && old.expires_at>stamp ? old.handoff_id : uid();
  const expires=new Date(Date.now()+duration).toISOString();
  await atomic(env.DB,[
    env.DB.prepare('DELETE FROM line_invitation_handoffs WHERE expires_at<=?').bind(stamp),
    env.DB.prepare(`INSERT INTO line_invitation_handoffs(subject_hash,handoff_id,invitation_id,created_at,expires_at) VALUES(?,?,?,?,?)
      ON CONFLICT(subject_hash) DO UPDATE SET handoff_id=excluded.handoff_id,invitation_id=excluded.invitation_id,created_at=excluded.created_at,expires_at=excluded.expires_at`).bind(hash,handoffId,invitation.id,stamp,expires),
  ]);
  return view(invitation,handoffId);
}
export async function resumeInvitationHandoff(env:Bindings,identity:Identity) {
  const hash=await subjectHash(env,identity),stamp=now();
  const pending=await one(env.DB,'SELECT * FROM line_invitation_handoffs WHERE subject_hash=?',hash);
  if(!pending || pending.expires_at<=stamp) {
    if(pending)await env.DB.prepare('DELETE FROM line_invitation_handoffs WHERE subject_hash=? AND handoff_id=? AND expires_at<=?').bind(hash,pending.handoff_id,stamp).run();
    return {pending:false};
  }
  const invitation=await invitationById(env.DB,pending.invitation_id,false);
  if(await existingMember(env.DB,identity,invitation))return view(invitation,null,true);
  requireCapacity(invitation);
  return view(invitation,pending.handoff_id);
}
export async function registerPendingInvitation(env:Bindings,identity:Identity,handoffId:string,staffName:string):Promise<InvitationRegistration> {
  const hash=await subjectHash(env,identity),stamp=now(),name=string(staffName,'担当者名',true,100);
  // A receipt belongs to this Login channel, verified person and exact request.
  // Store only its digest on the membership so unlink/relink can revoke it together.
  const receiptHash=await hashToken(`line-registration-receipt:v1:${env.LINE_CHANNEL_ID}\0${identity.sub}\0${handoffId}`);
  const completed=async():Promise<InvitationRegistration|null>=>{
    const row=await one(env.DB,"SELECT l.* FROM line_users l JOIN companies c ON c.id=l.company_id WHERE l.line_user_id=? AND l.registration_handoff_hash=? AND l.status='active' AND c.status='active' AND c.deleted_at IS NULL",identity.sub,receiptHash);
    if(row&&row.staff_name!==name)fail(409,'REGISTRATION_REQUEST_CHANGED','登録済みの要求と担当者名が異なります。LINEでログインし直して登録内容を確認してください。');
    return row?{...row,registration_created:false}:null;
  };
  const receipt=await completed();
  if(receipt)return receipt;
  const pending=await one(env.DB,'SELECT * FROM line_invitation_handoffs WHERE subject_hash=? AND handoff_id=? AND expires_at>?',hash,handoffId,stamp);
  if(!pending)fail(409,'INVITATION_HANDOFF_EXPIRED','登録の引き継ぎ情報が更新されたか、期限を過ぎています。招待QRから開き直してください。');
  const invitation=await invitationById(env.DB,pending!.invitation_id,false);
  if(!await existingMember(env.DB,identity,invitation))requireCapacity(invitation);
  const guards=[
    env.DB.prepare("DELETE FROM line_invitation_handoffs WHERE subject_hash=? AND handoff_id=? AND invitation_id=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(hash,handoffId,pending!.invitation_id),
    assertChanges(env.DB,1,{id:'line-invitation-handoff',type:'system'},'LINE_INVITATION_HANDOFF_CONSUME','line_invitation_handoffs',handoffId,null,{completed:true}),
  ];
  try{return await registerInvitationById(env.DB,identity,pending!.invitation_id,name,guards,receiptHash);}
  catch(error){
    // Two simultaneous confirmations may both read the pending row. Only one
    // consumes it; the other may return only that exact committed registration.
    const concurrent=await completed();
    if(concurrent)return concurrent;
    throw error;
  }
}
