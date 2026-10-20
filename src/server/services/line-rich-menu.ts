import type { Actor, Bindings } from '../types';
import { ApiError, fail, now, uid } from './common';
import { lineAccessTokenConfigured, resolveLineAccessToken } from '../line-access-token';

export const RICH_MENU_IMAGE_PATH = '/richmenu/kojima-richmenu.jpg';
export const EXPECTED_LINE_BASIC_ID = '@060ucble';
const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';
const WIDTH = 2500, HEIGHT = 1686, MAX_IMAGE_BYTES = 1_000_000;
const ID_PATTERN = /^richmenu-[a-f0-9]{32}$/;
const MENU_NAME = '小島醸造 注文メニュー v1';
type Bot = {display_name:string;basic_id:string;picture_url?:string};
export type RichMenu = {
  size:{width:number;height:number};selected:boolean;name:string;chatBarText:string;
  areas:{bounds:{x:number;y:number;width:number;height:number};action:{type:string;label?:string;uri?:string}}[];
};
type DefaultMenuState = {id:string|null;inaccessible:boolean};
type RichMenuInstall = {rich_menu_id:string;previous_rich_menu_id:string|null;previous_default_inaccessible:boolean;image_verified:true;bot:Bot;menu:RichMenu;already_installed:boolean};

export function richMenuDefinition(liffId:string, imageHash?:string):RichMenu {
  if(!/^\d{8,12}-[a-zA-Z0-9]+$/.test(liffId))fail(503,'LINE_LIFF_NOT_CONFIGURED','LIFF IDが正しく設定されていません。');
  const links=[['注文','order'],['注文履歴','orders'],['お問い合わせ','contact'],['商品紹介','products']];
  return {
    size:{width:WIDTH,height:HEIGHT},selected:true,name:MENU_NAME+(imageHash?` ${imageHash}`:''),chatBarText:'メニュー',
    areas:links.map(([label,path],index)=>({bounds:{x:index%2*1250,y:Math.floor(index/2)*843,width:1250,height:843},action:{type:'uri',label,uri:`https://liff.line.me/${liffId}/${path}`}})),
  };
}

async function requireConfiguration(env:Bindings) {
  if(env.APP_ENV!=='production')fail(409,'LINE_PRODUCTION_REQUIRED','LINEへの登録は本番環境から実行してください。');
  if(!lineAccessTokenConfigured(env))fail(503,'LINE_TOKEN_NOT_CONFIGURED','LINEの認証設定が未完了です。');
  if(!env.LIFF_ID)fail(503,'LINE_LIFF_NOT_CONFIGURED','LIFF IDが未設定です。');
  return resolveLineAccessToken(env);
}

async function lineFailureCategory(response:Response) {
  try {
    const value=await response.clone().json() as {message?:unknown};
    const message=typeof value.message==='string'?value.message.toLowerCase():'';
    if(/^the richmenu is owned by another channel[.!]?$/.test(message.trim()))return 'DEFAULT_FOREIGN';
    if(/there is no default rich\s?menu|default rich\s?menu (?:is not (?:set|found)|has not been set|does not exist)/.test(message))return 'DEFAULT_NOT_SET';
    if(/stateless|not (?:available|allowed|supported).*token|token.*not (?:available|allowed|supported)/.test(message))return 'TOKEN_SCOPE';
    if(/consent|agree|terms/.test(message))return 'CONSENT_REQUIRED';
    if(/not (?:available|allowed|supported).*(?:account|channel|region)/.test(message))return 'ACCOUNT_RESTRICTION';
    if(/expired/.test(message))return 'TOKEN_EXPIRED';
    if(/invalid|authentication/.test(message))return 'AUTHENTICATION';
    if(/permission|forbidden|not allowed|access denied/.test(message))return 'PERMISSION';
  } catch { /* Never expose provider bodies, including non-JSON responses. */ }
  return 'PROVIDER_REJECTED';
}

async function safeLineFailureDetail(response:Response,token:string) {
  let detail='';
  try {
    if(response.headers.get('Content-Type')?.includes('json')) {
      const value=await response.clone().json() as {message?:unknown};
      detail=typeof value.message==='string'?value.message:'JSON_ERROR';
    } else {
      const text=await response.clone().text();
      detail=text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]??'NON_JSON_ERROR';
    }
  } catch {return 'UNREADABLE_ERROR';}
  // Return only a short diagnostic with credential-shaped values removed.
  return detail.split(token).join('[redacted]').split(encodeURIComponent(token)).join('[redacted]')
    .replace(/[A-Za-z0-9+_\/=~-]{24,}/g,'[redacted]').replace(/[\r\n\t]/g,' ').slice(0,240);
}

async function lineRequest(token:string,path:string,init:RequestInit={},dataApi=false,allow404=false) {
  let response:Response;
  try {
    // workerd supports follow/manual, not error. Reject returned redirects via the !ok check below.
    response=await fetch((dataApi?LINE_DATA_API:LINE_API)+path,{...init,headers:{...init.headers,Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(15000)});
  } catch {
    fail(502,'LINE_CONNECTION_FAILED','LINEとの通信が完了しませんでした。状態を再取得してからお試しください。');
  }
  if(allow404&&response!.status===404)return null;
  if(!response!.ok){
    const category=await lineFailureCategory(response!);
    if(allow404&&!dataApi&&path==='/user/all/richmenu'&&response!.status===403&&category==='DEFAULT_NOT_SET')return null;
    if(allow404&&!dataApi&&path==='/user/all/richmenu'&&response!.status===403&&category==='DEFAULT_FOREIGN')fail(409,'LINE_DEFAULT_MENU_FOREIGN','現在の標準メニューは別チャネルの所有で設定を取得できません。');
    // Do not expose provider bodies or credentials. Owner errors get only a redacted diagnostic.
    if(response!.status===401||response!.status===403){
      const operation=path==='/info'?'公式アカウント確認':path==='/user/all/richmenu'?'標準メニュー取得':dataApi?'メニュー画像':'メニュー設定';
      const detail=await safeLineFailureDetail(response!,token);
      fail(502,'LINE_AUTH_FAILED',`LINEの認証に失敗しました（${operation}、HTTP ${response!.status}、${category}）。${detail}`);
    }
    if(response!.status===429)fail(502,'LINE_RATE_LIMIT','LINEの呼出し上限に達しました。時間をおいてお試しください。');
    fail(502,'LINE_API_FAILED','LINE側の操作が完了しませんでした。状態を再取得してからお試しください。');
  }
  return response!;
}
async function lineJson(token:string,path:string,init?:RequestInit,allow404=false):Promise<any> {
  const response=await lineRequest(token,path,init,false,allow404);
  if(!response)return null;
  try{return await response.json();}catch{fail(502,'LINE_INVALID_RESPONSE','LINEからの応答を確認できませんでした。');}
}
async function botInfo(token:string):Promise<Bot> {
  const bot=await lineJson(token,'/info');
  if(bot?.basicId!==EXPECTED_LINE_BASIC_ID)fail(409,'LINE_ACCOUNT_MISMATCH',`接続先のLINE公式アカウントが小島醸造（${EXPECTED_LINE_BASIC_ID}）と一致しません。アクセストークンを確認してください。`);
  return {display_name:String(bot.displayName??'小島醸造'),basic_id:bot.basicId,...(typeof bot.pictureUrl==='string'?{picture_url:bot.pictureUrl}:{})};
}
function validMenuId(value:unknown):string {
  if(typeof value!=='string'||!ID_PATTERN.test(value))fail(502,'LINE_INVALID_RESPONSE','LINEのリッチメニューIDを確認できませんでした。');
  return value as string;
}
async function defaultMenuState(token:string):Promise<DefaultMenuState> {
  try {
    const value=await lineJson(token,'/user/all/richmenu',undefined,true);
    return {id:value===null?null:validMenuId(value.richMenuId),inaccessible:false};
  } catch(error) {
    if(error instanceof ApiError&&error.code==='LINE_DEFAULT_MENU_FOREIGN')return {id:null,inaccessible:true};
    throw error;
  }
}
function sameDefault(a:DefaultMenuState,b:DefaultMenuState) {return a.id===b.id&&a.inaccessible===b.inaccessible;}
function safeMenu(value:any):RichMenu {
  if(!value?.size||!Array.isArray(value.areas)||typeof value.name!=='string')fail(502,'LINE_INVALID_RESPONSE','LINEのリッチメニュー設定を確認できませんでした。');
  return {size:{width:Number(value.size.width),height:Number(value.size.height)},selected:value.selected===true,name:value.name,chatBarText:String(value.chatBarText??''),areas:value.areas.map((area:any)=>({bounds:{x:Number(area.bounds?.x),y:Number(area.bounds?.y),width:Number(area.bounds?.width),height:Number(area.bounds?.height)},action:{type:String(area.action?.type??''),...(typeof area.action?.label==='string'?{label:area.action.label}:{}),...(typeof area.action?.uri==='string'?{uri:area.action.uri}:{})}}))};
}
async function menuInfo(token:string,id:string) {return safeMenu(await lineJson(token,`/richmenu/${validMenuId(id)}`));}
function sameMenu(a:RichMenu,b:RichMenu) {return JSON.stringify(a)===JSON.stringify(b);}
async function sha256(bytes:Uint8Array) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer as ArrayBuffer)),value=>value.toString(16).padStart(2,'0')).join('');}

/** Read JPEG SOF dimensions, rather than trusting the response header or extension. */
export function richMenuJpegDimensions(bytes:Uint8Array) {
  if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)return null;
  let offset=2;
  while(offset+3<bytes.length){
    if(bytes[offset++]!==0xff)return null;
    while(bytes[offset]===0xff)offset++;
    const marker=bytes[offset++];
    if(marker===0xd9||marker===0xda)return null;
    if(marker===0x01||(marker>=0xd0&&marker<=0xd8))continue;
    if(offset+2>bytes.length)return null;
    const length=bytes[offset]*256+bytes[offset+1];
    if(length<2||offset+length>bytes.length)return null;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(length<8)return null;
      return {width:bytes[offset+5]*256+bytes[offset+6],height:bytes[offset+3]*256+bytes[offset+4]};
    }
    offset+=length;
  }
  return null;
}
async function imageAsset(env:Bindings,origin:string) {
  const response=await env.ASSETS.fetch(new Request(new URL(RICH_MENU_IMAGE_PATH,origin)));
  if(!response.ok||!response.headers.get('Content-Type')?.toLowerCase().startsWith('image/jpeg'))fail(503,'RICH_MENU_IMAGE_MISSING','リッチメニュー画像が配置されていません。');
  const bytes=new Uint8Array(await response.arrayBuffer());
  const dimensions=richMenuJpegDimensions(bytes);
  if(bytes.length>MAX_IMAGE_BYTES||dimensions?.width!==WIDTH||dimensions.height!==HEIGHT)fail(503,'RICH_MENU_IMAGE_INVALID','リッチメニュー画像は2500×1686px、1MB以下のJPEGにしてください。');
  return {bytes,hash:await sha256(bytes)};
}
async function imageMatches(token:string,id:string,hash:string) {
  const response=await lineRequest(token,`/richmenu/${validMenuId(id)}/content`,undefined,true,true);
  if(!response)return false;
  const bytes=new Uint8Array(await response.arrayBuffer());
  return bytes.length<=MAX_IMAGE_BYTES&&await sha256(bytes)===hash;
}

export async function lineRichMenuStatus(env:Bindings,origin:string) {
  const desired=env.LIFF_ID?richMenuDefinition(env.LIFF_ID,(await imageAsset(env,origin)).hash):null;
  const base={configured:lineAccessTokenConfigured(env)&&!!env.LIFF_ID&&env.APP_ENV==='production',expected_basic_id:EXPECTED_LINE_BASIC_ID,bot:null as Bot|null,default_rich_menu_id:null as string|null,default_menu_inaccessible:false,current_menu:null as RichMenu|null,desired_menu:desired,image_url:RICH_MENU_IMAGE_PATH};
  if(!base.configured)return base;
  const token=await requireConfiguration(env),bot=await botInfo(token),current=await defaultMenuState(token);
  return {...base,bot,default_rich_menu_id:current.id,default_menu_inaccessible:current.inaccessible,current_menu:current.id?await menuInfo(token,current.id):null};
}

export async function installLineRichMenu(env:Bindings,origin:string):Promise<RichMenuInstall> {
  const token=await requireConfiguration(env),definition=richMenuDefinition(env.LIFF_ID!);
  const image=await imageAsset(env,origin),menu={...definition,name:`${MENU_NAME} ${image.hash}`};
  const bot=await botInfo(token),previous=await defaultMenuState(token),previousId=previous.id;
  if(previousId&&sameMenu(await menuInfo(token,previousId),menu)&&await imageMatches(token,previousId,image.hash))return {rich_menu_id:previousId,previous_rich_menu_id:previousId,previous_default_inaccessible:false,image_verified:true,bot,menu,already_installed:true};
  let createdId:string|undefined;
  try {
    const created=await lineJson(token,'/richmenu',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(menu)});
    createdId=validMenuId(created?.richMenuId);
    await lineRequest(token,`/richmenu/${createdId}/content`,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:image.bytes.slice().buffer as ArrayBuffer},true);
    if(!await imageMatches(token,createdId,image.hash))fail(502,'LINE_IMAGE_VERIFICATION_FAILED','LINEに保存された画像が一致しませんでした。');
    // Do not overwrite a menu changed in Official Account Manager while this request was preparing its image.
    if(!sameDefault(await defaultMenuState(token),previous))fail(409,'LINE_MENU_CHANGED','LINE側のメニューが変更されました。状態を再取得してからお試しください。');
    await lineRequest(token,`/user/all/richmenu/${createdId}`,{method:'POST'});
    if((await defaultMenuState(token)).id!==createdId||!sameMenu(await menuInfo(token,createdId),menu))fail(502,'LINE_MENU_VERIFICATION_FAILED','LINEの既定メニュー反映を確認できませんでした。');
    return {rich_menu_id:createdId,previous_rich_menu_id:previousId,previous_default_inaccessible:previous.inaccessible,image_verified:true,bot,menu,already_installed:false};
  } catch(error) {
    if(createdId){
      let retainedActiveMenu=false;
      try {
        let current=await defaultMenuState(token);
        if(current.id===createdId){
          if(previous.inaccessible){
            // The foreign default's ID is unavailable, so it cannot be safely restored.
            // Keep the new active menu whose image was already verified; never unset it.
            retainedActiveMenu=true;
          } else {
            await lineRequest(token,previousId?`/user/all/richmenu/${previousId}`:'/user/all/richmenu',{method:previousId?'POST':'DELETE'});
            current=await defaultMenuState(token);
            if(!sameDefault(current,previous))throw new Error('rollback-not-confirmed');
          }
        }
        // No existing menu or per-user assignment is deleted. Only this request's new menu is removable.
        if(!retainedActiveMenu&&current.id!==createdId)await lineRequest(token,`/richmenu/${createdId}`,{method:'DELETE'});
      } catch {
        fail(502,'LINE_MENU_STATE_UNCONFIRMED','処理後のLINEメニュー状態を確認できませんでした。状態を再取得してください。既存メニューは削除していません。');
      }
      if(retainedActiveMenu)fail(502,'LINE_MENU_STATE_UNCONFIRMED','新しいメニューが標準に設定されていますが、処理結果を完全に確認できませんでした。以前のメニューは別チャネル所有で復元できないため、新しいメニューを保持しています。状態を再取得してください。');
    }
    throw error;
  }
}

/** Atomic D1 lease using append-only audit entries; simultaneous installations cannot race. */
export async function withRichMenuInstallAudit<T extends RichMenuInstall>(db:D1Database,who:Actor,operation:()=>Promise<T>) {
  const operationId=uid(),startedAt=now(),cutoff=new Date(Date.now()-10*60*1000).toISOString();
  const lock=await db.prepare(`INSERT INTO audit_logs(id,acted_at,actor_type,actor_id,action,target_type,target_id)
    SELECT ?,?,'admin',?,'LINE_RICHMENU_INSTALL_STARTED','line_rich_menu_install',?
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_logs started WHERE started.action='LINE_RICHMENU_INSTALL_STARTED' AND started.acted_at>?
      AND NOT EXISTS (SELECT 1 FROM audit_logs finished WHERE finished.target_type='line_rich_menu_install' AND finished.target_id=started.id AND finished.action IN ('LINE_RICHMENU_INSTALL_COMPLETED','LINE_RICHMENU_INSTALL_FAILED','LINE_RICHMENU_INSTALL_AUDIT_UNCONFIRMED'))
    )`).bind(operationId,startedAt,who.id,operationId,cutoff).run();
  if(lock.meta.changes!==1)fail(409,'LINE_MENU_INSTALL_BUSY','リッチメニューの登録処理中です。少し待ってから状態を再取得してください。');
  let result:T;
  try {result=await operation();}
  catch(error) {
    // Record only the application error code, never provider response bodies or credentials.
    try {
      await db.prepare("INSERT INTO audit_logs(id,acted_at,actor_type,actor_id,action,target_type,target_id,note) VALUES(?,?,'admin',?,'LINE_RICHMENU_INSTALL_FAILED','line_rich_menu_install',?,?)").bind(uid(),now(),who.id,operationId,error instanceof ApiError?error.code:'INTERNAL_ERROR').run();
    } catch { /* A lost DB connection must not hide the original provider result. The lease expires. */ }
    throw error;
  }
  try {
    await db.prepare("INSERT INTO audit_logs(id,acted_at,actor_type,actor_id,action,target_type,target_id,before_json,after_json) VALUES(?,?,'admin',?,'LINE_RICHMENU_INSTALL_COMPLETED','line_rich_menu_install',?,?,?)").bind(uid(),now(),who.id,operationId,JSON.stringify({rich_menu_id:result.previous_rich_menu_id,default_inaccessible:result.previous_default_inaccessible}),JSON.stringify({rich_menu_id:result.rich_menu_id,bot_basic_id:result.bot.basic_id,image_verified:result.image_verified,already_installed:result.already_installed})).run();
  } catch {
    try {
      await db.prepare("INSERT INTO audit_logs(id,acted_at,actor_type,actor_id,action,target_type,target_id,note) VALUES(?,?,'admin',?,'LINE_RICHMENU_INSTALL_AUDIT_UNCONFIRMED','line_rich_menu_install',?,'LINE_MENU_AUDIT_UNCONFIRMED')").bind(uid(),now(),who.id,operationId).run();
    } catch { /* Keep the verified LINE menu; the unavailable database lease expires. */ }
    fail(503,'LINE_MENU_AUDIT_UNCONFIRMED','LINE側のメニュー反映は確認できましたが、監査記録を保存できませんでした。登録を繰り返す前に状態を再取得してください。');
  }
  return result;
}
