import { DatabaseSync } from 'node:sqlite';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import type { Actor,Bindings } from '../src/server/types';
import { migrateTestDatabase } from './helpers/migrate';

const TOKEN='mock-diagnostic-access-token-do-not-expose';
const BOT_ID='U'+'0'.repeat(32);
const userId=(index:number)=>'U'+index.toString(16).padStart(32,'0');
class ReadOnlyD1{
  sqlite=new DatabaseSync(':memory:');
  prepare(sql:string){return new Statement(this,sql);}
  binding(){return this as unknown as D1Database;}
}
class Statement{
  constructor(private db:ReadOnlyD1,private sql:string,private args:unknown[]=[]){ }
  bind(...args:unknown[]){return new Statement(this.db,this.sql,args);}
  async first(){return this.db.sqlite.prepare(this.sql).get(...this.args as any[])??null;}
  async all(){return {success:true,results:this.db.sqlite.prepare(this.sql).all(...this.args as any[])};}
}
let db:ReadOnlyD1,env:Bindings,ownerCookie:string,staffCookie:string;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
beforeEach(async()=>{
  db=new ReadOnlyD1();migrateTestDatabase(db.sqlite);
  db.sqlite.exec("INSERT INTO companies(id,name) VALUES('a','検証企業'); INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('owner','owner','unused','所有者','owner'),('staff','staff','unused','担当者','staff');");
  const insert=db.sqlite.prepare("INSERT INTO line_users(id,company_id,line_user_id,staff_name,status,registered_at) VALUES(?,'a',?,?,'active',?)");
  for(let index=0;index<12;index++)insert.run('row-'+index,index===1?'invalid-member-id':userId(index),'PRIVATE-MEMBER-NAME-'+index,'2026-10-21T00:'+String(index).padStart(2,'0')+':00Z');
  env={DB:db.binding(),APP_ENV:'production',SESSION_SECRET:'diagnostic-test-session-secret-longer-than-32-characters',LINE_CHANNEL_ACCESS_TOKEN:TOKEN} as Bindings;
  const cookie=async(actor:Actor)=>'kojima_session='+await signSession(actor,env);
  ownerCookie=await cookie({id:'owner',type:'admin',role:'owner',name:'所有者'});
  staffCookie=await cookie({id:'staff',type:'admin',role:'staff',name:'担当者'});
});
afterEach(()=>{vi.unstubAllGlobals();db.sqlite.close();});
async function request(cookie=ownerCookie){
  const response=await app.request('https://orders.example/api/admin/line/notification-diagnostics?company_id=a',{headers:cookie?{Cookie:cookie}:{}},env);
  return {response,body:await response.json() as any};
}

describe('owner-only LINE notification diagnostics',()=>{
  it('reads at most ten members, records no writes, and returns only safe statuses and counters',async()=>{
    const operations:{url:string;method:string}[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);operations.push({url,method:init?.method??'GET'});
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer '+TOKEN);
      expect(init?.redirect).toBe('manual');expect(init?.signal).toBeInstanceOf(AbortSignal);
      const path=new URL(url).pathname;
      if(path==='/v2/bot/info')return json({basicId:'@060ucble',userId:BOT_ID,displayName:'PRIVATE-BOT-NAME',access_token:TOKEN});
      if(path==='/v2/bot/channel/webhook/endpoint')return json({endpoint:'https://kojima-brewery-v2-a6577637.crossover-616.workers.dev/api/line/webhook',active:true,debug:TOKEN});
      if(path==='/v2/bot/message/quota')return json({type:'limited',value:200,debug:TOKEN});
      if(path==='/v2/bot/message/quota/consumption')return json({totalUsage:3,debug:TOKEN});
      if(path.endsWith(userId(2)))return json({message:TOKEN+' '+userId(2)+' PRIVATE-ERROR'},404);
      if(path.startsWith('/v2/bot/profile/'))return json({userId:path.split('/').at(-1),displayName:'PRIVATE-PROFILE-NAME'});
      throw new Error('Unexpected provider operation');
    }));
    const {response,body}=await request();
    expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.data).toMatchObject({read_only:true,active_member_count:12,checked_member_count:10,member_limit:10,truncated:true,bot:{http_status:200,expected_basic_id_match:true,user_id_format_valid:true},quota:{http_status:200,type:'limited',limit:200,consumption_http_status:200,consumed:3},webhook:{http_status:200,active:true,expected_endpoint_match:true}});
    expect(body.data.members[0]).toMatchObject({member_index:1,line_id_length:33,line_id_format_valid:true,equals_bot_user_id:true,profile_http_status:200,profile_accessible:true});
    expect(body.data.members[1]).toMatchObject({line_id_format_valid:false,profile_http_status:null,profile_check:'skipped_invalid_id'});
    expect(body.data.members[2]).toMatchObject({profile_http_status:404,profile_accessible:false});
    expect(operations.filter(x=>x.url.includes('/profile/'))).toHaveLength(9);
    expect(operations.every(x=>x.method==='GET')).toBe(true);
    const serialized=JSON.stringify(body);
    for(const sensitive of [TOKEN,BOT_ID,'PRIVATE-','invalid-member-id',...Array.from({length:12},(_,i)=>userId(i))])expect(serialized).not.toContain(sensitive);
    expect(db.sqlite.prepare('SELECT count(*) count FROM audit_logs').get()).toMatchObject({count:0});
  });

  it('rejects non-owner access and missing credentials without provider requests',async()=>{
    const external=vi.fn();vi.stubGlobal('fetch',external);
    const denied=await request(staffCookie);expect(denied.response.status).toBe(403);expect(denied.body.error.code).toBe('OWNER_REQUIRED');
    const anonymous=await request('');expect(anonymous.response.status).toBe(401);
    env.LINE_CHANNEL_ACCESS_TOKEN=undefined;
    const missing=await request();expect(missing.response.status).toBe(503);expect(missing.body.error.code).toBe('LINE_TOKEN_NOT_CONFIGURED');expect(missing.response.headers.get('Cache-Control')).toBe('no-store');
    expect(external).not.toHaveBeenCalled();
  });

  it('does not query member profiles for a mismatched bot or reflect provider errors and malformed quota values',async()=>{
    const paths:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const path=new URL(String(input)).pathname;paths.push(path);
      if(path==='/v2/bot/info')return json({basicId:'@wrong-private-account',userId:BOT_ID,displayName:TOKEN});
      if(path==='/v2/bot/channel/webhook/endpoint')return json({endpoint:'https://private.example.com/'+TOKEN,active:false});
      if(path==='/v2/bot/message/quota')return json({message:TOKEN+' PRIVATE-PROVIDER-ERROR'},403);
      if(path==='/v2/bot/message/quota/consumption')return json({totalUsage:'PRIVATE-COUNTER'});
      throw new Error('Member profiles must not be requested for another bot');
    }));
    const {response,body}=await request();expect(response.status).toBe(200);
    expect(body.data.bot.expected_basic_id_match).toBe(false);
    expect(body.data.members.every((member:any)=>member.profile_http_status===null&&!member.profile_accessible)).toBe(true);
    expect(body.data.quota).toMatchObject({http_status:403,limit:null,consumption_http_status:200,consumed:null});
    expect(paths).toHaveLength(4);
    expect(body.data.webhook).toEqual({http_status:200,active:false,expected_endpoint_match:false});
    const serialized=JSON.stringify(body);for(const sensitive of [TOKEN,BOT_ID,'@wrong-private-account','PRIVATE-'])expect(serialized).not.toContain(sensitive);
  });
});
