import type { Bindings } from '../types';
import { lineAccessTokenConfigured, resolveLineAccessToken } from '../line-access-token';
import { fail, one, rows } from './common';
import { EXPECTED_LINE_BASIC_ID } from './line-rich-menu';

const LINE_API='https://api.line.me/v2/bot';
const EXPECTED_WEBHOOK='https://kojima-brewery-v2-a6577637.crossover-616.workers.dev/api/line/webhook';
const LINE_USER_PATTERN=/^U[0-9a-fA-F]{32}$/;
const MAX_MEMBERS=10;
type JsonObject=Record<string,unknown>;
type DiagnosticReply={http_status:number|null;body:JsonObject|null};
async function readOnlyLineGet(token:string,path:string,signal:AbortSignal):Promise<DiagnosticReply>{
  try{
    const response=await fetch(LINE_API+path,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'manual',signal});
    if(!response.ok)return {http_status:response.status,body:null};
    let body:JsonObject|null=null;
    // A failed or malformed body never becomes part of diagnostics.
    try{const parsed:unknown=await response.json();if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))body=parsed as JsonObject;}catch{/* Status remains useful. */}
    return {http_status:response.status,body};
  }catch{return {http_status:null,body:null};}
}
const counter=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;

/** Owner-only, read-only checks. Never return recipient IDs, names, tokens or provider error text. */
export async function lineNotificationDiagnostics(env:Bindings,companyId:string){
  const company=await one(env.DB,"SELECT id FROM companies WHERE id=? AND status='active' AND deleted_at IS NULL",companyId);
  if(!company)fail(404,'COMPANY_NOT_FOUND','有効な取引先が見つかりません。');
  if(env.APP_ENV!=='production')fail(409,'LINE_PRODUCTION_REQUIRED','LINE通知の診断は本番環境で実行してください。');
  if(!lineAccessTokenConfigured(env))fail(503,'LINE_TOKEN_NOT_CONFIGURED','LINEの認証設定が未完了です。');
  let token:string;
  try{token=await resolveLineAccessToken(env);}catch{fail(503,'LINE_TOKEN_UNAVAILABLE','LINEの認証情報を確認できませんでした。設定を確認してください。');}
  const [members,total]=await Promise.all([
    rows(env.DB,"SELECT line_user_id FROM line_users WHERE company_id=? AND status='active' ORDER BY registered_at,id LIMIT 10",companyId),
    one(env.DB,"SELECT count(*) AS total FROM line_users WHERE company_id=? AND status='active'",companyId),
  ]);
  // All LINE requests share one deadline and use only fixed-host GET endpoints.
  const signal=AbortSignal.timeout(10000);
  const bot=await readOnlyLineGet(token!,'/info',signal);
  const basicIdMatches=bot.http_status===200&&bot.body?.basicId===EXPECTED_LINE_BASIC_ID;
  const botId=typeof bot.body?.userId==='string'?bot.body.userId:null;
  const profiles=members.map(async(member,index)=>{
    const id=typeof member.line_user_id==='string'?member.line_user_id:'';
    const valid=LINE_USER_PATTERN.test(id);
    let response:DiagnosticReply|null=null;
    if(basicIdMatches&&valid)response=await readOnlyLineGet(token!,`/profile/${encodeURIComponent(id)}`,signal);
    return {
      member_index:index+1,
      line_id_length:id.length,
      line_id_format_valid:valid,
      equals_bot_user_id:botId===null?null:id===botId,
      profile_http_status:response?.http_status??null,
      profile_accessible:response?.http_status===200,
      profile_check:!valid?'skipped_invalid_id':!basicIdMatches?'skipped_bot_unverified':response?.http_status===null?'connection_failed':'checked',
    };
  });
  const [membersResult,quota,consumption,webhook]=await Promise.all([
    Promise.all(profiles),
    readOnlyLineGet(token!,'/message/quota',signal),
    readOnlyLineGet(token!,'/message/quota/consumption',signal),
    readOnlyLineGet(token!,'/channel/webhook/endpoint',signal),
  ]);
  return {
    checked_at:new Date().toISOString(),read_only:true,
    secret_has_outer_whitespace:typeof env.LINE_CHANNEL_SECRET==='string'&&env.LINE_CHANNEL_SECRET!==env.LINE_CHANNEL_SECRET.trim(),
    active_member_count:Number(total?.total??members.length),checked_member_count:membersResult.length,
    member_limit:MAX_MEMBERS,truncated:Number(total?.total??members.length)>MAX_MEMBERS,
    bot:{http_status:bot.http_status,expected_basic_id_match:basicIdMatches,user_id_format_valid:botId===null?false:LINE_USER_PATTERN.test(botId)},
    members:membersResult,
    webhook:{http_status:webhook.http_status,active:typeof webhook.body?.active==='boolean'?webhook.body.active:null,expected_endpoint_match:webhook.http_status===200&&webhook.body?.endpoint===EXPECTED_WEBHOOK},
    quota:{http_status:quota.http_status,type:quota.body?.type==='limited'||quota.body?.type==='none'?quota.body.type:null,limit:counter(quota.body?.value),consumption_http_status:consumption.http_status,consumed:counter(consumption.body?.totalUsage)},
  };
}
