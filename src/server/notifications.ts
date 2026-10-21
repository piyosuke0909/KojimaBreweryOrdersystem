import type { Actor, Bindings } from './types';
import { lineAccessTokenConfigured, resolveLineAccessToken } from './line-access-token';
type Result = { status: 'sent'|'disabled'|'failed'; channels: string[] };
type PushResult = { status:Result['status']; diagnostic?:string };
async function record(env:Bindings,kind:string,target:string,status:string) {
  await env.DB.prepare("INSERT INTO audit_logs(id,acted_at,actor_type,actor_id,action,target_type,target_id,note) VALUES(?,?,'system','notifications',?,'notifications',?,?)").bind(crypto.randomUUID(),new Date().toISOString(),kind,target,status).run();
}
/** Classify provider failures without storing text that might repeat a recipient or credential. */
async function pushFailure(response:Response):Promise<string>{
  let source='';
  try{const value=await response.json() as {message?:unknown};if(typeof value.message==='string')source=value.message.toLowerCase();}catch{/* HTTP status is sufficient when the provider body is not JSON. */}
  let category='request_rejected';
  if(response.status===401)category='authentication_failed';
  else if(response.status===403)category='permission_denied';
  else if(response.status===429)category=/month|quota/.test(source)?'monthly_quota_exceeded':'rate_limited';
  else if(response.status>=500)category='line_unavailable';
  else if(/invalid.*user|user.*invalid|user.*not.*found|does not exist|property.*to.*invalid/.test(source))category='invalid_recipient';
  else if(/failed to send|cannot send|not.*friend|blocked/.test(source))category='recipient_unreachable';
  else if(response.status===400)category='invalid_request';
  return `failed:http_${response.status}:${category}`;
}
async function push(env:Bindings,to:string,text:string):Promise<PushResult> {
  if(!lineAccessTokenConfigured(env)||env.APP_ENV!=='production')return {status:'disabled'};
  let token:string;
  try{token=await resolveLineAccessToken(env);}catch(error){
    const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^LINE_[A-Z_]{1,70}$/.test(error.code)?error.code:'LINE_AUTHENTICATION_FAILED';
    return {status:'failed',diagnostic:`failed:${code}`};
  }
  try{
    const response=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Line-Retry-Key':crypto.randomUUID()},body:JSON.stringify({to,messages:[{type:'text',text}]}),redirect:'manual',signal:AbortSignal.timeout(10000)});
    return response.ok?{status:'sent'}:{status:'failed',diagnostic:await pushFailure(response)};
  }catch{return {status:'failed',diagnostic:'failed:line_connection_failed'};}
}
export async function notifyWelcome(env:Bindings,lineUserId:string,name:string):Promise<Result> {
  // Registration state already identifies the member; notification logs never repeat their LINE ID.
  const target='line-registration';
  try{const result=await push(env,lineUserId,`${name}様、小島醸造へのご登録ありがとうございます。リッチメニューの「注文」からご注文いただけます。`);await record(env,'NOTIFICATION_WELCOME',target,result.diagnostic??result.status);return {status:result.status,channels:result.status==='sent'?['line']:[]};}
  catch{await record(env,'NOTIFICATION_WELCOME',target,'failed:notification_recording_failed');return {status:'failed',channels:[]};}
}
export async function notifyOrder(env:Bindings,actor:Actor,order:any,kind:'create'|'edit'|'cancel'):Promise<Result> {
  const isTest=String(order.id).startsWith('TEST-O');
  const label={create:'注文受付',edit:'注文変更',cancel:'注文キャンセル'}[kind],text=`${isTest?'【動作確認・デモ注文】\n実際の出荷・お支払いは不要です。\n':''}小島醸造 ${label}\n注文番号: ${order.id}\n到着希望日: ${order.desired_delivery_date}\n合計: ${Number(order.total_amount).toLocaleString('ja-JP')}円`;
  const statuses:string[]=[],channels:string[]=[],diagnostics:string[]=[];
  try {
    const to=order.ordered_by_line_user_id??(actor.type==='customer'?actor.id:undefined);
    if(to&&kind!=='edit'){const result=await push(env,to,text);statuses.push(result.status);if(result.diagnostic)diagnostics.push(result.diagnostic);if(result.status==='sent')channels.push('line');}
    if(!isTest&&env.APP_ENV==='production'&&env.NOTIFICATION_EMAIL_API_KEY&&env.NOTIFICATION_FROM){
      const email=await env.DB.prepare("SELECT value FROM settings WHERE key='notification_email'").first<{value:string}>();
      if(email?.value){const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.NOTIFICATION_EMAIL_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.NOTIFICATION_FROM,to:[email.value],subject:`【小島醸造】${label} ${order.id}`,text}),signal:AbortSignal.timeout(10000)});statuses.push(response.ok?'sent':'failed');if(response.ok)channels.push('email');else diagnostics.push(`failed:email_http_${response.status}`);}
    }
    const status=statuses.includes('failed')?'failed':channels.length?'sent':'disabled';await record(env,`NOTIFICATION_ORDER_${kind.toUpperCase()}`,order.id,diagnostics[0]??status);return {status,channels};
  } catch {await record(env,`NOTIFICATION_ORDER_${kind.toUpperCase()}`,order.id,'failed:notification_connection_failed');return {status:'failed',channels};}
}
