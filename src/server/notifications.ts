import type { Actor, Bindings } from './types';
import { lineAccessTokenConfigured, resolveLineAccessToken } from './line-access-token';
type Result = { status: 'sent'|'disabled'|'failed'; channels: string[] };
async function record(env:Bindings,kind:string,target:string,status:string) {
  await env.DB.prepare("INSERT INTO audit_logs(id,acted_at,actor_type,actor_id,action,target_type,target_id,note) VALUES(?,?,'system','notifications',?,'notifications',?,?)").bind(crypto.randomUUID(),new Date().toISOString(),kind,target,status).run();
}
async function push(env:Bindings,to:string,text:string) {
  if(!lineAccessTokenConfigured(env)||env.APP_ENV!=='production')return 'disabled';
  const token=await resolveLineAccessToken(env);
  const result=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Line-Retry-Key':crypto.randomUUID()},body:JSON.stringify({to,messages:[{type:'text',text}]}),redirect:'manual',signal:AbortSignal.timeout(10000)});
  return result.ok?'sent':'failed';
}
export async function notifyWelcome(env:Bindings,lineUserId:string,name:string):Promise<Result> {
  try {const status=await push(env,lineUserId,`${name}様、小島醸造へのご登録ありがとうございます。リッチメニューの「注文」からご注文いただけます。`);await record(env,'NOTIFICATION_WELCOME',lineUserId,status);return {status,channels:status==='sent'?['line']:[]};}
  catch {await record(env,'NOTIFICATION_WELCOME',lineUserId,'failed');return {status:'failed',channels:[]};}
}
export async function notifyOrder(env:Bindings,actor:Actor,order:any,kind:'create'|'edit'|'cancel'):Promise<Result> {
  const label={create:'注文受付',edit:'注文変更',cancel:'注文キャンセル'}[kind],text=`小島醸造 ${label}\n注文番号: ${order.id}\n到着希望日: ${order.desired_delivery_date}\n合計: ${Number(order.total_amount).toLocaleString('ja-JP')}円`;
  const statuses:string[]=[],channels:string[]=[];
  try {
    const to=order.ordered_by_line_user_id??(actor.type==='customer'?actor.id:undefined);
    if(to&&kind!=='edit'){const state=await push(env,to,text);statuses.push(state);if(state==='sent')channels.push('line');}
    if(env.APP_ENV==='production'&&env.NOTIFICATION_EMAIL_API_KEY&&env.NOTIFICATION_FROM){
      const email=await env.DB.prepare("SELECT value FROM settings WHERE key='notification_email'").first<{value:string}>();
      if(email?.value){const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.NOTIFICATION_EMAIL_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.NOTIFICATION_FROM,to:[email.value],subject:`【小島醸造】${label} ${order.id}`,text}),signal:AbortSignal.timeout(10000)});statuses.push(response.ok?'sent':'failed');if(response.ok)channels.push('email');}
    }
    const status=statuses.includes('failed')?'failed':channels.length?'sent':'disabled';await record(env,`NOTIFICATION_ORDER_${kind.toUpperCase()}`,order.id,status);return {status,channels};
  } catch {await record(env,`NOTIFICATION_ORDER_${kind.toUpperCase()}`,order.id,'failed');return {status:'failed',channels};}
}
