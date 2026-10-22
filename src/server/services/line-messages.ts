import { z } from 'zod';
import type { Actor, Bindings } from '../types';
import { lineAccessTokenConfigured, resolveLineAccessToken } from '../line-access-token';
import { lineMessageNotificationStatement, readLineConversationNotifications } from './admin-notifications';
import { ApiError, assertChanges, atomic, fail, now, one, rows, uid, type Row } from './common';

const claimLifetime=120_000;
// LINE keeps retry keys for 24 hours. The margin prevents retries near expiry.
const retryLifetime=23*60*60*1000;
const scalar=(value:unknown)=>typeof value==='string'&&value.length<=256?value:null;
const object=(value:unknown):Row|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:null;
const validProviderUser=/^U[0-9a-fA-F]{32}$/;
const diagnostic=/^通知確認-[A-Z0-9]{6}$/;
const placeholders:Record<string,string>={image:'画像を受信（内容はLINE公式管理画面で確認）',video:'動画を受信（内容はLINE公式管理画面で確認）',audio:'音声を受信（内容はLINE公式管理画面で確認）',file:'ファイルを受信（内容はLINE公式管理画面で確認）',location:'位置情報を受信（内容はLINE公式管理画面で確認）',sticker:'スタンプを受信（内容はLINE公式管理画面で確認）'};

async function company(env:Bindings,id:string){
  const row=await one(env.DB,'SELECT id,name,status FROM companies WHERE id=? AND deleted_at IS NULL',id);
  if(!row)fail(404,'NOT_FOUND','取引先が見つかりません。');
  return row!;
}
async function member(env:Bindings,companyId:string,id:string,active=false){
  const business=await company(env,companyId);
  const row=await one(env.DB,'SELECT * FROM line_users WHERE id=? AND company_id=?',id,companyId);
  if(!row)fail(404,'NOT_FOUND','この取引先のLINE担当者が見つかりません。');
  if(active&&(business.status!=='active'||row!.status!=='active'))fail(409,'LINE_CONTACT_INACTIVE','無効な取引先・解除済みのLINE担当者には送信できません。');
  return row!;
}
function publicMessage(row:Row){
  const stamp=Date.now();
  const stale=row.status==='pending'&&Date.parse(row.send_claimed_at||row.created_at)<=stamp-claimLifetime;
  const status=stale?'unknown':row.status;
  return {id:row.id,sequence:Number(row.sequence),line_user_id:row.line_user_id,direction:row.direction,message_type:row.message_type,text:row.text,status,created_at:row.created_at,sent_at:row.sent_at||null,error_code:stale?'LINE_DELIVERY_UNCONFIRMED':row.error_code||null,can_retry:row.direction==='outgoing'&&['failed','unknown'].includes(status)&&Date.parse(row.created_at)>stamp-retryLifetime,request_id:row.request_id||null};
}

export async function lineMessageContacts(env:Bindings,who:Actor,companyId:string){
  const business=await company(env,companyId);
  const contacts=await rows(env.DB,`SELECT l.id,l.staff_name,l.line_display_name,l.status,l.registered_at,
    m.id AS message_id,m.rowid AS message_sequence,m.text,m.direction,m.status AS message_status,m.created_at,m.sent_at,m.message_type,m.request_id,m.error_code,m.send_claimed_at,
    (SELECT COUNT(*) FROM admin_notifications n WHERE n.kind='line_message' AND n.company_id=l.company_id AND n.line_user_id=l.id
      AND NOT EXISTS(SELECT 1 FROM admin_notification_reads r WHERE r.notification_id=n.id AND r.admin_id=?)) AS unread_count
    FROM line_users l LEFT JOIN line_messages m ON m.rowid=(SELECT rowid FROM line_messages lm WHERE lm.company_id=l.company_id AND lm.line_user_id=l.id ORDER BY rowid DESC LIMIT 1)
    WHERE l.company_id=? ORDER BY CASE WHEN l.status='active' THEN 0 ELSE 1 END,CASE WHEN m.id IS NULL THEN 1 ELSE 0 END,m.rowid DESC,l.registered_at DESC,l.id`,who.id,companyId);
  return {contacts:contacts.map(row=>({id:row.id,staff_name:row.staff_name,line_display_name:row.line_display_name,status:row.status,registered_at:row.registered_at,unread_count:Number(row.unread_count||0),last_message:row.message_id?publicMessage({...row,id:row.message_id,sequence:row.message_sequence,line_user_id:row.id,status:row.message_status}):null})),send_enabled:env.APP_ENV==='production'&&business.status==='active'&&lineAccessTokenConfigured(env)};
}
export async function lineConversation(env:Bindings,companyId:string,lineUserId:string,before?:string,limitValue?:string){
  await member(env,companyId,lineUserId);
  const limit=limitValue===undefined?30:z.coerce.number().int().min(1).max(100).parse(limitValue);
  let cursor:Row|null=null;
  if(before){cursor=await one(env.DB,'SELECT rowid AS sequence FROM line_messages WHERE id=? AND company_id=? AND line_user_id=?',z.string().max(256).parse(before),companyId,lineUserId);if(!cursor)fail(400,'INVALID_MESSAGE_CURSOR','メッセージの読込位置を確認してください。');}
  const selected=await rows(env.DB,`SELECT rowid AS sequence,* FROM line_messages WHERE company_id=? AND line_user_id=?${cursor?' AND rowid<?':''} ORDER BY rowid DESC LIMIT ?`,companyId,lineUserId,...(cursor?[cursor.sequence]:[]),limit+1);
  const page=selected.slice(0,limit);
  return {messages:page.reverse().map(publicMessage),next_cursor:selected.length>limit?page[0]?.id??null:null};
}
export async function readLineMessages(env:Bindings,who:Actor,companyId:string,lineUserId:string,input:Row){
  await member(env,companyId,lineUserId);
  const data=z.object({message_ids:z.array(z.string().min(1).max(256)).max(100)}).strict().parse(input);
  const selected=await rows(env.DB,"SELECT notification_event_key FROM line_messages WHERE company_id=? AND line_user_id=? AND direction='incoming' AND id IN(SELECT value FROM json_each(?))",companyId,lineUserId,JSON.stringify([...new Set(data.message_ids)]));
  const eventKeys=selected.map(row=>row.notification_event_key).filter((value):value is string=>typeof value==='string');
  await readLineConversationNotifications(env.DB,who.id,companyId,lineUserId,eventKeys);
  return {read:true,read_count:eventKeys.length};
}

/** Only the signature-verified webhook may call this. No registration is performed. */
export async function receiveLineMessages(env:Bindings,verifiedBody:string){
  let envelope:Row|null;try{envelope=object(JSON.parse(verifiedBody));}catch{return;}
  if(!Array.isArray(envelope?.events))return;
  const events=envelope.events.map(object).filter((value):value is Row=>!!value);
  const providerIds=[...new Set(events.map(event=>object(event.source)).filter(source=>source?.type==='user'&&validProviderUser.test(source.userId)).map(source=>source!.userId))];
  if(!providerIds.length)return;
  const known=await rows(env.DB,"SELECT l.*,c.name AS company_name,c.status AS company_status,c.deleted_at AS company_deleted_at FROM line_users l JOIN companies c ON c.id=l.company_id WHERE l.line_user_id IN(SELECT value FROM json_each(?))",JSON.stringify(providerIds));
  const byProvider=new Map(known.map(row=>[row.line_user_id,row]));
  let statements:D1PreparedStatement[]=[];
  const flush=async()=>{if(statements.length){await atomic(env.DB,statements);statements=[];}};
  for(const event of events){
    const source=object(event.source),contact=source?.type==='user'?byProvider.get(source.userId):null;
    if(!contact)continue;
    const stamp=now();
    if(event.type==='unsend'){
      const removed=scalar(object(event.unsend)?.messageId);if(!removed)continue;
      statements.push(env.DB.prepare('INSERT INTO line_message_unsends(line_message_id,line_user_id,created_at) VALUES(?,?,?) ON CONFLICT(line_message_id,line_user_id) DO NOTHING').bind(removed,contact.id,stamp),env.DB.prepare("UPDATE line_messages SET text='送信が取り消されました',message_type='unsent' WHERE line_message_id=? AND line_user_id=? AND direction='incoming'").bind(removed,contact.id));
    }else if(event.type==='message'){
      if(contact.status!=='active'||contact.company_status!=='active'||contact.company_deleted_at)continue;
      const message=object(event.message),providerMessage=scalar(message?.id),explicitEvent=scalar(event.webhookEventId);
      if(!message||!providerMessage)continue;
      const type=typeof message.type==='string'?message.type:'unknown';
      if(type==='text'&&(typeof message.text!=='string'||!message.text.trim()||message.text.length>5000))continue;
      if(type==='text'){const match=message.text.match(diagnostic);if(match&&match[0]===message.text)continue;}
      const text=type==='text'?message.text:placeholders[type]||'メッセージを受信（内容はLINE公式管理画面で確認）';
      const id=uid(),eventId=explicitEvent||`message:${providerMessage}`,key=`line-message:${eventId}`;
      statements.push(env.DB.prepare(`INSERT INTO line_messages(id,company_id,line_user_id,direction,message_type,text,status,webhook_event_id,line_message_id,notification_event_key,created_at)
        SELECT ?,?,?,'incoming',?,?,'received',?,?,?,?
        WHERE NOT EXISTS(SELECT 1 FROM line_message_unsends WHERE line_message_id=? AND line_user_id=?)
        AND EXISTS(SELECT 1 FROM line_users l JOIN companies c ON c.id=l.company_id WHERE l.id=? AND l.company_id=? AND l.status='active' AND c.status='active' AND c.deleted_at IS NULL)
        ON CONFLICT DO NOTHING`).bind(id,contact.company_id,contact.id,type,text,eventId,providerMessage,key,stamp,providerMessage,contact.id,contact.id,contact.company_id),lineMessageNotificationStatement(env.DB,{event_key:key,company_id:contact.company_id,line_user_id:contact.id,company_name:contact.company_name,staff_name:contact.staff_name,created_at:stamp,persisted_message_id:id}));
    }
    if(statements.length>=40)await flush();
  }
  await flush();
}

function validateExisting(row:Row,companyId:string,lineUserId:string,text:string){
  if(row.company_id!==companyId||row.line_user_id!==lineUserId||row.text!==text)fail(409,'LINE_REQUEST_CONFLICT','同じ送信番号で異なるメッセージは送信できません。');
}
async function outcome(env:Bindings,who:Actor,row:Row,claim:string,status:'sent'|'failed'|'unknown',errorCode:string|null){
  try{
    await atomic(env.DB,[env.DB.prepare("UPDATE line_messages SET status=?,sent_at=?,error_code=? WHERE id=? AND status='pending' AND send_claim_id=?").bind(status,status==='sent'?now():null,errorCode,row.id,claim),assertChanges(env.DB,1,who,'LINE_MESSAGE_SEND_RESULT','line_messages',row.id,null,{status,error_code:errorCode},row.company_id)]);
    return publicMessage((await one(env.DB,'SELECT rowid AS sequence,* FROM line_messages WHERE id=?',row.id))!);
  }catch{return {...publicMessage(row),status:'unknown',error_code:'LINE_DELIVERY_RECORDING_FAILED',can_retry:false};}
}
export async function sendLineMessage(env:Bindings,who:Actor,companyId:string,lineUserId:string,input:Row){
  const data=z.object({text:z.string().trim().min(1).max(5000),request_id:z.string().uuid(),retry:z.boolean().optional()}).strict().parse(input);
  const contact=await member(env,companyId,lineUserId,true);
  if(env.APP_ENV!=='production')fail(409,'LINE_CHAT_PRODUCTION_REQUIRED','LINEメッセージの送信は本番環境でのみ利用できます。');
  if(!lineAccessTokenConfigured(env))fail(503,'LINE_CHAT_NOT_CONFIGURED','LINEメッセージの送信設定が未完了です。');
  let existing=await one(env.DB,'SELECT rowid AS sequence,* FROM line_messages WHERE request_id=?',data.request_id);
  if(existing){
    validateExisting(existing,companyId,lineUserId,data.text);
    if(!data.retry||existing.status==='sent')return {message:publicMessage(existing),created:false};
    if(!publicMessage(existing).can_retry)fail(409,'LINE_RETRY_UNAVAILABLE','送信処理中か、再試行できる期間を過ぎています。送信結果をご確認ください。');
  }else if(data.retry)fail(404,'NOT_FOUND','再試行するメッセージが見つかりません。');
  const stamp=now(),claim=uid(),id=existing?.id||uid();
  try{
    const statement=existing
      ?env.DB.prepare("UPDATE line_messages SET status='pending',send_claim_id=?,send_claimed_at=?,attempt_count=attempt_count+1,error_code=NULL WHERE id=? AND created_at>? AND (status IN('failed','unknown') OR (status='pending' AND send_claimed_at<=?)) AND EXISTS(SELECT 1 FROM line_users l JOIN companies c ON c.id=l.company_id WHERE l.id=? AND l.company_id=? AND l.status='active' AND c.status='active' AND c.deleted_at IS NULL)").bind(claim,stamp,id,new Date(Date.now()-retryLifetime).toISOString(),new Date(Date.now()-claimLifetime).toISOString(),lineUserId,companyId)
      :env.DB.prepare(`INSERT INTO line_messages(id,company_id,line_user_id,direction,message_type,text,status,request_id,created_at,send_claim_id,send_claimed_at,attempt_count)
        SELECT ?,?,?,'outgoing','text',?,'pending',?,?,?,?,1
        WHERE EXISTS(SELECT 1 FROM line_users l JOIN companies c ON c.id=l.company_id WHERE l.id=? AND l.company_id=? AND l.status='active' AND c.status='active' AND c.deleted_at IS NULL)
        ON CONFLICT(request_id) DO NOTHING`).bind(id,companyId,lineUserId,data.text,data.request_id,stamp,claim,stamp,lineUserId,companyId);
    await atomic(env.DB,[statement,assertChanges(env.DB,1,who,'LINE_MESSAGE_SEND_REQUEST','line_messages',id,null,{status:'pending'},companyId)]);
  }catch(error){
    if(!(error instanceof ApiError&&error.code==='CONFLICT'))throw error;
    existing=await one(env.DB,'SELECT rowid AS sequence,* FROM line_messages WHERE request_id=?',data.request_id);
    if(!existing)throw error;
    validateExisting(existing,companyId,lineUserId,data.text);
    return {message:publicMessage(existing),created:false};
  }
  const row=(await one(env.DB,'SELECT rowid AS sequence,* FROM line_messages WHERE id=?',id))!;
  let token:string;
  try{token=await resolveLineAccessToken(env);await member(env,companyId,lineUserId,true);}
  catch(error){const code=error instanceof ApiError&&/^LINE_[A-Z_]+$/.test(error.code)?error.code:'LINE_AUTHENTICATION_FAILED';return {message:await outcome(env,who,row,claim,'failed',code),created:!existing};}
  try{
    const response=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Line-Retry-Key':data.request_id},body:JSON.stringify({to:contact.line_user_id,messages:[{type:'text',text:data.text}]}),redirect:'manual',signal:AbortSignal.timeout(10000)});
    const sent=response.ok||(response.status===409&&!!response.headers.get('x-line-accepted-request-id'));
    return {message:await outcome(env,who,row,claim,sent?'sent':response.status>=500?'unknown':'failed',sent?null:`LINE_HTTP_${response.status}`),created:!existing};
  }catch{return {message:await outcome(env,who,row,claim,'unknown','LINE_DELIVERY_UNCONFIRMED'),created:!existing};}
}
