import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import { ApiError } from '../src/server/services/common';
import { installLineRichMenu, lineRichMenuStatus, richMenuDefinition, richMenuJpegDimensions, withRichMenuInstallAudit, type RichMenu } from '../src/server/services/line-rich-menu';
import type { Actor, Bindings } from '../src/server/types';

const OLD='richmenu-11111111111111111111111111111111';
const NEW='richmenu-22222222222222222222222222222222';
const EXTERNAL='richmenu-33333333333333333333333333333333';
const LIFF='2012094093-ApA0tjfW';
const TOKEN='test-line-token-never-exposed';
const image=new Uint8Array(readFileSync(new URL('../public/richmenu/kojima-richmenu.jpg',import.meta.url)));
const owner:Actor={id:'owner',type:'admin',role:'owner',name:'管理者'};
const json=(value:any,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const picture=()=>new Response(image.slice().buffer,{headers:{'Content-Type':'image/jpeg'}});
function environment():Bindings {
  return {APP_ENV:'production',LINE_CHANNEL_ACCESS_TOKEN:TOKEN,LIFF_ID:LIFF,SESSION_SECRET:'a-unit-test-session-key-longer-than-32-characters',ASSETS:{fetch:vi.fn(async()=>picture())}} as unknown as Bindings;
}
function provider(options:{wrongBot?:boolean;failUpload?:boolean;failSetAfterApply?:boolean;corruptAfterSwitch?:boolean;externalChangeDuringUpload?:boolean;emptyDefault403?:string;foreignDefault?:boolean;clearDefaultDuringUpload?:boolean}={}) {
  const state={defaultId:OLD as string|null,menus:new Map<string,RichMenu>([[OLD,{...richMenuDefinition(LIFF),name:'以前のリッチメニュー'}]]),images:new Map<string,Uint8Array>(),calls:[] as {url:string;method:string;body:any}[]};
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input),method=init?.method??'GET',path=new URL(url).pathname.replace('/v2/bot','');
    expect((init?.headers as Record<string,string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
    state.calls.push({url,method,body:init?.body});
    if(path==='/info')return json({basicId:options.wrongBot?'@other-account':'@060ucble',displayName:'小島醸造'});
    if(path==='/user/all/richmenu'&&method==='GET'){
      if(options.foreignDefault&&state.defaultId===OLD)return json({message:'the richmenu is owned by another channel'},403);
      return state.defaultId?json({richMenuId:state.defaultId}):json({message:options.emptyDefault403??'not found'},options.emptyDefault403?403:404);
    }
    if(path==='/user/all/richmenu'&&method==='DELETE'){state.defaultId=null;return json({});}
    if(path.startsWith('/user/all/richmenu/')&&method==='POST'){
      state.defaultId=path.split('/').at(-1)!;
      if(options.failSetAfterApply&&state.defaultId===NEW)return json({message:TOKEN},500);
      return json({});
    }
    if(path==='/richmenu'&&method==='POST'){
      state.menus.set(NEW,JSON.parse(String(init?.body)));
      return json({richMenuId:NEW});
    }
    const match=path.match(/^\/richmenu\/(richmenu-[a-f0-9]{32})(\/content)?$/);
    if(match){
      const [,id,content]=match;
      if(content){
        expect(new URL(url).hostname).toBe('api-data.line.me');
        if(method==='POST'){
          expect((init?.headers as Record<string,string>)['Content-Type']).toBe('image/jpeg');
          if(options.failUpload)return json({message:TOKEN},400);
          state.images.set(id,new Uint8Array(init!.body as ArrayBuffer));
          if(options.externalChangeDuringUpload)state.defaultId=EXTERNAL;
          if(options.clearDefaultDuringUpload)state.defaultId=null;
          return json({});
        }
        return state.images.has(id)?new Response(state.images.get(id)!.slice().buffer,{headers:{'Content-Type':'image/jpeg'}}):json({},404);
      }
      if(method==='DELETE'){state.menus.delete(id);state.images.delete(id);return json({});}
      const menu=state.menus.get(id);
      return menu?json(options.corruptAfterSwitch&&id===NEW&&state.defaultId===NEW?{...menu,chatBarText:'unexpected'}:menu):json({},404);
    }
    throw new Error(`Unexpected LINE request ${method} ${path}`);
  });
  vi.stubGlobal('fetch',fetcher);
  return {...state,fetcher,state};
}
afterEach(()=>vi.unstubAllGlobals());

describe('LINE rich menu registration uses fixed destinations and verified images',()=>{
  it('covers all four quadrants with the intended LIFF destinations and validates the actual JPEG',()=>{
    const menu=richMenuDefinition(LIFF);
    expect(menu.size).toEqual({width:2500,height:1686});
    expect(menu.areas.map(area=>area.action.uri)).toEqual(['order','orders','contact','products'].map(path=>`https://liff.line.me/${LIFF}/${path}`));
    expect(menu.areas.map(area=>area.bounds)).toEqual([{x:0,y:0,width:1250,height:843},{x:1250,y:0,width:1250,height:843},{x:0,y:843,width:1250,height:843},{x:1250,y:843,width:1250,height:843}]);
    expect(richMenuJpegDimensions(image)).toEqual(menu.size);
    expect(image.length).toBeLessThanOrEqual(1_000_000);
    expect(richMenuJpegDimensions(new Uint8Array([0xff,0xd8,0xff,0xc0,0,255]))).toBeNull();
    expect(()=>richMenuDefinition('https://attacker.example')).toThrow();
  });
  it('verifies uploaded bytes, switches the default, reports matching status, and reuses an unchanged installation',async()=>{
    const env=environment(),line=provider();
    const installed=await installLineRichMenu(env,'https://orders.example');
    expect(installed).toMatchObject({rich_menu_id:NEW,previous_rich_menu_id:OLD,image_verified:true,already_installed:false});
    expect(line.state.defaultId).toBe(NEW);
    expect(line.state.menus.has(OLD)).toBe(true);
    expect(line.state.images.get(NEW)).toEqual(image);
    const status=await lineRichMenuStatus(env,'https://orders.example');
    expect(status.desired_menu).toEqual(installed.menu);
    expect(status.current_menu).toEqual(status.desired_menu);
    const second=await installLineRichMenu(env,'https://orders.example');
    expect(second).toMatchObject({rich_menu_id:NEW,image_verified:true,already_installed:true});
    expect(line.calls.filter(call=>new URL(call.url).pathname==='/v2/bot/richmenu'&&call.method==='POST')).toHaveLength(1);
  });
  it('rejects an access token for another official account before creating or changing a menu',async()=>{
    const line=provider({wrongBot:true});
    await expect(installLineRichMenu(environment(),'https://orders.example')).rejects.toMatchObject({status:409,code:'LINE_ACCOUNT_MISMATCH'});
    expect(line.calls.every(call=>call.method==='GET')).toBe(true);
    expect(line.state.defaultId).toBe(OLD);
  });
  it('installs the first default when the account has no existing rich menu',async()=>{
    const line=provider();line.state.defaultId=null;
    const result=await installLineRichMenu(environment(),'https://orders.example');
    expect(result).toMatchObject({rich_menu_id:NEW,previous_rich_menu_id:null,image_verified:true});
    expect(line.state.defaultId).toBe(NEW);
    expect(line.calls.some(call=>call.method==='DELETE')).toBe(false);
  });
  it('accepts an explicitly missing default on 403 but does not bypass a permission failure',async()=>{
    const missing=provider({emptyDefault403:'There is no default richmenu'});missing.state.defaultId=null;
    await expect(installLineRichMenu(environment(),'https://orders.example')).resolves.toMatchObject({rich_menu_id:NEW,previous_rich_menu_id:null});
    const forbidden=provider({emptyDefault403:'This API is not available for stateless tokens. '+TOKEN});forbidden.state.defaultId=null;
    let failure:any;
    try {await installLineRichMenu(environment(),'https://orders.example');}catch(error){failure=error;}
    expect(failure).toMatchObject({code:'LINE_AUTH_FAILED'});
    expect(failure.message).toContain('TOKEN_SCOPE');
    expect(failure.message).not.toContain(TOKEN);
    expect(forbidden.calls.every(call=>call.method==='GET')).toBe(true);
  });
  it('reports a foreign default distinctly and replaces it without reading or deleting its menu',async()=>{
    const env=environment(),line=provider({foreignDefault:true});
    const before=await lineRichMenuStatus(env,'https://orders.example');
    expect(before).toMatchObject({configured:true,default_rich_menu_id:null,default_menu_inaccessible:true,current_menu:null});
    const result=await installLineRichMenu(env,'https://orders.example');
    expect(result).toMatchObject({rich_menu_id:NEW,previous_rich_menu_id:null,previous_default_inaccessible:true,image_verified:true});
    expect(line.state.defaultId).toBe(NEW);
    expect(line.state.menus.has(OLD)).toBe(true);
    expect(line.calls.filter(call=>new URL(call.url).pathname.includes(`/richmenu/${OLD}`))).toHaveLength(0);
    const after=await lineRichMenuStatus(env,'https://orders.example');
    expect(after.default_menu_inaccessible).toBe(false);
    expect(after.current_menu).toEqual(after.desired_menu);
  });
  it('preserves an inaccessible foreign default and removes only the new menu if image upload fails',async()=>{
    const line=provider({foreignDefault:true,failUpload:true});
    await expect(installLineRichMenu(environment(),'https://orders.example')).rejects.toMatchObject({code:'LINE_API_FAILED'});
    expect(line.state.defaultId).toBe(OLD);
    expect(line.state.menus.has(OLD)).toBe(true);
    expect(line.state.menus.has(NEW)).toBe(false);
    expect(line.calls.filter(call=>call.method==='DELETE').map(call=>new URL(call.url).pathname)).toEqual([`/v2/bot/richmenu/${NEW}`]);
  });
  it('distinguishes a foreign default from an empty default when checking for concurrent changes',async()=>{
    const line=provider({foreignDefault:true,clearDefaultDuringUpload:true});
    await expect(installLineRichMenu(environment(),'https://orders.example')).rejects.toMatchObject({code:'LINE_MENU_CHANGED'});
    expect(line.state.defaultId).toBeNull();
    expect(line.state.menus.has(OLD)).toBe(true);
    expect(line.state.menus.has(NEW)).toBe(false);
    expect(line.calls.some(call=>call.method==='POST'&&call.url.includes('/user/all/richmenu/'))).toBe(false);
  });
  it('keeps a new active menu if switching from an unknown foreign default commits before an API error',async()=>{
    const line=provider({foreignDefault:true,failSetAfterApply:true});
    await expect(installLineRichMenu(environment(),'https://orders.example')).rejects.toMatchObject({code:'LINE_MENU_STATE_UNCONFIRMED'});
    expect(line.state.defaultId).toBe(NEW);
    expect(line.state.menus.has(NEW)).toBe(true);
    expect(line.state.menus.has(OLD)).toBe(true);
    expect(line.calls.some(call=>call.method==='DELETE')).toBe(false);
  });
  it('keeps a verified image active if post-switch verification fails and the foreign predecessor cannot be restored',async()=>{
    const line=provider({foreignDefault:true,corruptAfterSwitch:true});
    await expect(installLineRichMenu(environment(),'https://orders.example')).rejects.toMatchObject({code:'LINE_MENU_STATE_UNCONFIRMED'});
    expect(line.state.defaultId).toBe(NEW);
    expect(line.state.images.get(NEW)?.length).toBe(image.length);
    expect(line.calls.some(call=>call.method==='DELETE')).toBe(false);
  });
  it('cleans up only the newly created menu if image upload fails and never exposes provider errors',async()=>{
    const line=provider({failUpload:true});
    let failure:any;
    try{await installLineRichMenu(environment(),'https://orders.example');}catch(error){failure=error;}
    expect(failure).toMatchObject({code:'LINE_API_FAILED'});
    expect(String(failure)).not.toContain(TOKEN);
    expect(line.state.defaultId).toBe(OLD);
    expect(line.state.menus.has(OLD)).toBe(true);
    expect(line.state.menus.has(NEW)).toBe(false);
    expect(line.calls.filter(call=>call.method==='DELETE').map(call=>new URL(call.url).pathname)).toEqual([`/v2/bot/richmenu/${NEW}`]);
  });
  it('restores the previous default when LINE reports an error after applying the new default',async()=>{
    const line=provider({failSetAfterApply:true});
    await expect(installLineRichMenu(environment(),'https://orders.example')).rejects.toMatchObject({code:'LINE_API_FAILED'});
    expect(line.state.defaultId).toBe(OLD);
    expect(line.state.menus.has(OLD)).toBe(true);
    expect(line.state.menus.has(NEW)).toBe(false);
  });
  it('restores the previous default if the saved menu payload does not match',async()=>{
    const line=provider({corruptAfterSwitch:true});
    await expect(installLineRichMenu(environment(),'https://orders.example')).rejects.toMatchObject({code:'LINE_MENU_VERIFICATION_FAILED'});
    expect(line.state.defaultId).toBe(OLD);
    expect(line.state.menus.has(OLD)).toBe(true);
    expect(line.state.menus.has(NEW)).toBe(false);
  });
  it('preserves a default changed in Official Account Manager during preparation',async()=>{
    const line=provider({externalChangeDuringUpload:true});
    await expect(installLineRichMenu(environment(),'https://orders.example')).rejects.toMatchObject({code:'LINE_MENU_CHANGED'});
    expect(line.state.defaultId).toBe(EXTERNAL);
    expect(line.state.menus.has(OLD)).toBe(true);
    expect(line.calls.filter(call=>call.method==='POST'&&call.url.includes('/user/all/richmenu/'))).toHaveLength(0);
  });
  it('rejects missing production credentials or invalid image assets without contacting LINE',async()=>{
    const line=provider(),env=environment();
    await expect(installLineRichMenu({...env,LINE_CHANNEL_ACCESS_TOKEN:undefined},'https://orders.example')).rejects.toMatchObject({code:'LINE_TOKEN_NOT_CONFIGURED'});
    await expect(installLineRichMenu({...env,APP_ENV:'development'},'https://orders.example')).rejects.toMatchObject({code:'LINE_PRODUCTION_REQUIRED'});
    env.ASSETS={fetch:async()=>new Response('<html>SPA fallback</html>',{headers:{'Content-Type':'text/html'}})} as unknown as Fetcher;
    await expect(installLineRichMenu(env,'https://orders.example')).rejects.toMatchObject({code:'RICH_MENU_IMAGE_MISSING'});
    expect(line.calls).toHaveLength(0);
  });
});

class SQLiteBinding {
  sqlite=new DatabaseSync(':memory:');
  constructor(){this.sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));}
  prepare(sql:string){
    const statement=(args:any[]=[])=>({bind:(...next:any[])=>statement(next),run:async()=>({meta:{changes:Number(this.sqlite.prepare(sql).run(...args).changes)}}),first:async()=>this.sqlite.prepare(sql).get(...args)??null});
    return statement();
  }
  binding(){return this as unknown as D1Database;}
}
describe('LINE rich menu authorization and operation audit',()=>{
  it('rejects anonymous callers and staff before any LINE request',async()=>{
    const db=new SQLiteBinding(),line=provider(),env={...environment(),DB:db.binding()};
    try {
      db.sqlite.exec("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('staff','staff','unused','担当者','staff')");
      const anonymous=await app.request('https://orders.example/api/admin/line/rich-menu/install',{method:'POST'},env);
      expect(anonymous.status).toBe(401);
      const session=await signSession({id:'staff',type:'admin',role:'staff',name:'担当者'},env);
      const staff=await app.request('https://orders.example/api/admin/line/rich-menu/install',{method:'POST',headers:{Cookie:`kojima_session=${session}`}},env);
      expect(staff.status).toBe(403);
      expect((await staff.json() as any).error.code).toBe('OWNER_REQUIRED');
      expect(line.calls).toHaveLength(0);
    }finally{db.sqlite.close();}
  });
  it('atomically excludes simultaneous installations, releases the lease, and records no credentials',async()=>{
    const db=new SQLiteBinding();
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const result={rich_menu_id:NEW,previous_rich_menu_id:OLD,previous_default_inaccessible:false,image_verified:true as const,bot:{display_name:'小島醸造',basic_id:'@060ucble'},menu:richMenuDefinition(LIFF),already_installed:false};
    try {
      const first=withRichMenuInstallAudit(db.binding(),owner,async()=>{await gate;return result;});
      await expect(withRichMenuInstallAudit(db.binding(),owner,async()=>result)).rejects.toMatchObject({code:'LINE_MENU_INSTALL_BUSY'});
      release();await first;
      await expect(withRichMenuInstallAudit(db.binding(),owner,async()=>result)).resolves.toEqual(result);
      await expect(withRichMenuInstallAudit(db.binding(),owner,async()=>{throw new ApiError(502,'LINE_API_FAILED',TOKEN);})).rejects.toMatchObject({code:'LINE_API_FAILED'});
      const logs=db.sqlite.prepare('SELECT * FROM audit_logs ORDER BY acted_at').all();
      expect(logs.filter((log:any)=>log.action==='LINE_RICHMENU_INSTALL_STARTED')).toHaveLength(3);
      expect(logs.filter((log:any)=>log.action==='LINE_RICHMENU_INSTALL_COMPLETED')).toHaveLength(2);
      expect(logs.filter((log:any)=>log.action==='LINE_RICHMENU_INSTALL_FAILED')).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(TOKEN);
    }finally{release?.();db.sqlite.close();}
  });
  it('reports a distinct audit failure after successful LINE registration without undoing the verified menu',async()=>{
    const db=new SQLiteBinding();
    const result={rich_menu_id:NEW,previous_rich_menu_id:null,previous_default_inaccessible:false,image_verified:true as const,bot:{display_name:'小島醸造',basic_id:'@060ucble'},menu:richMenuDefinition(LIFF),already_installed:false};
    const operation=vi.fn(async()=>result);
    const failingDb={prepare:(sql:string)=>{
      if(sql.includes('VALUES')&&sql.includes("'LINE_RICHMENU_INSTALL_COMPLETED'"))return {bind:()=>({run:async()=>{throw new Error('database temporarily unavailable');}})};
      return db.prepare(sql);
    }} as unknown as D1Database;
    try {
      await expect(withRichMenuInstallAudit(failingDb,owner,operation)).rejects.toMatchObject({code:'LINE_MENU_AUDIT_UNCONFIRMED',status:503});
      expect(operation).toHaveBeenCalledTimes(1);
      const logs=db.sqlite.prepare('SELECT action,note FROM audit_logs').all();
      expect(logs.some((log:any)=>log.action==='LINE_RICHMENU_INSTALL_FAILED')).toBe(false);
      expect(logs.some((log:any)=>log.action==='LINE_RICHMENU_INSTALL_AUDIT_UNCONFIRMED')).toBe(true);
      await expect(withRichMenuInstallAudit(db.binding(),owner,async()=>result)).resolves.toEqual(result);
    }finally{db.sqlite.close();}
  });
});
