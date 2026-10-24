import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { hashPassword, resolveActor, signSession, verifySession } from '../src/server/auth';
import { notifyOrder, notifyWelcome } from '../src/server/notifications';
import { ApiError, assertChanges } from '../src/server/services/common';
import { sendOrderEmail, testMailSettings } from '../src/server/services/email';
import { guardDatabase, getSystemGeneration, readSystemState, systemStateMiddleware, unwrapSystemDatabase, withSystemTask } from '../src/server/system-state';
import type { Actor, AppEnv, Bindings } from '../src/server/types';
import { migrateTestDatabase } from './helpers/migrate';

class SqliteD1 {
  sqlite=new DatabaseSync(':memory:');
  prepare(sql:string){return new Statement(this,sql);}
  async batch(statements:Statement[]){
    this.sqlite.exec('BEGIN IMMEDIATE');
    try{const result=statements.map(statement=>statement.execute());this.sqlite.exec('COMMIT');return result;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
  binding(){return this as unknown as D1Database;}
}
class Statement {
  constructor(private db:SqliteD1,private sql:string,private values:any[]=[]){ }
  bind(...values:any[]){return new Statement(this.db,this.sql,values);}
  execute(){
    const statement=this.db.sqlite.prepare(this.sql),result=statement.columns().length?statement.all(...this.values):statement.run(...this.values);
    return {success:true,results:Array.isArray(result)?result:[],meta:{changes:Number((this.db.sqlite.prepare('SELECT changes() AS count').get() as any).count)}};
  }
  async first(column?:string){const result=this.db.sqlite.prepare(this.sql).get(...this.values);return column?result?.[column]??null:result??null;}
  async all(){return this.execute();}
  async run(){return this.execute();}
}
let native:SqliteD1,env:Bindings;
const owner:Actor={id:'reset-runtime-owner',name:'管理者',type:'admin',role:'owner'};
const customer:Actor={id:'RESET-RUNTIME-CUSTOMER',name:'担当者',type:'customer',company_id:'runtime-company'};
const secret='reset-runtime-only-signing-key-with-at-least-32-characters';
beforeEach(()=>{
  native=new SqliteD1();migrateTestDatabase(native.sqlite);
  native.sqlite.exec("INSERT INTO companies(id,name) VALUES('runtime-company','旧取引先');INSERT INTO line_users(id,company_id,line_user_id,staff_name) VALUES('runtime-member','runtime-company','RESET-RUNTIME-CUSTOMER','担当者');INSERT INTO settings(key,value) VALUES('notification_email','unit@example.test');");
  env={DB:guardDatabase(native.binding(),0),APP_ENV:'production',SESSION_SECRET:secret,LINE_CHANNEL_ACCESS_TOKEN:'runtime-fixed-token',NOTIFICATION_EMAIL_API_KEY:'runtime-mail-token',NOTIFICATION_FROM:'unit@example.test'} as Bindings;
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();native.sqlite.close();});
const advance=()=>native.sqlite.exec('UPDATE system_state SET generation=generation+1,data_revision=data_revision+1 WHERE id=1');
const state=()=>readSystemState(native.binding());
const logs=()=>native.sqlite.prepare('SELECT * FROM audit_logs').all();
const leases=()=>native.sqlite.prepare('SELECT * FROM system_task_leases').all() as any[];

describe('database reset generation fence',()=>{
  it('preserves caller result positions and adjacent SQLite changes() assertions',async()=>{
    const results=await env.DB.batch([
      env.DB.prepare("UPDATE companies SET name='更新後' WHERE id='runtime-company'"),
      assertChanges(env.DB,1,owner,'COMPANY_UPDATE','companies','runtime-company',null,{updated:true}),
    ]);
    expect(results).toHaveLength(2);expect(results[0].meta.changes).toBe(1);expect(logs()).toHaveLength(1);
    expect(await state()).toEqual({generation:0,data_revision:1});
  });
  it('rolls back the complete batch and revision if a business invariant fails',async()=>{
    await expect(env.DB.batch([
      env.DB.prepare("UPDATE companies SET name='失敗した変更' WHERE id='runtime-company'"),
      assertChanges(env.DB,2,owner,'COMPANY_UPDATE','companies','runtime-company',null,{}),
    ])).rejects.toThrow();
    expect((native.sqlite.prepare('SELECT name FROM companies').get() as any).name).toBe('旧取引先');
    expect(await state()).toEqual({generation:0,data_revision:0});expect(logs()).toHaveLength(0);
  });
  it.each(['run','all','first'] as const)('rejects a stale standalone %s write without resurrecting data',async method=>{
    const stale=env.DB.prepare("INSERT INTO settings(key,value) VALUES('old-background','private old value') RETURNING value");
    advance();
    await expect(stale[method]()).rejects.toMatchObject({code:'SYSTEM_RESET_CHANGED',status:409});
    expect(native.sqlite.prepare("SELECT * FROM settings WHERE key='old-background'").get()).toBeUndefined();
    expect(await state()).toEqual({generation:1,data_revision:1});
  });
  it('fences native statements included in an otherwise wrapped batch',async()=>{
    const nativeStatement=native.binding().prepare("INSERT INTO settings(key,value) VALUES('native-write','old')");
    advance();await expect(env.DB.batch([nativeStatement])).rejects.toMatchObject({code:'SYSTEM_RESET_CHANGED'});
    expect(native.sqlite.prepare("SELECT * FROM settings WHERE key='native-write'").get()).toBeUndefined();
  });
  it('returns INSERT RETURNING rows for all() and first(column)',async()=>{
    const first=await env.DB.prepare("INSERT INTO settings(key,value) VALUES('return-first','one') RETURNING value").first('value');
    const all=await env.DB.prepare("INSERT INTO settings(key,value) VALUES('return-all','two') RETURNING key,value").all();
    expect(first).toBe('one');expect(all.results).toEqual([{key:'return-all',value:'two'}]);
    expect((await state()).data_revision).toBe(2);
  });
  it('does not change revision for SELECT or the company unread read-only WITH query',async()=>{
    expect(await env.DB.prepare('WITH messages AS (SELECT id FROM companies) SELECT COUNT(*) AS count FROM messages').first('count')).toBe(1);
    await env.DB.batch([env.DB.prepare("SELECT 'UPDATE DELETE INSERT' AS words"),env.DB.prepare('WITH data AS (SELECT id FROM companies) SELECT * FROM data')]);
    expect(await state()).toEqual({generation:0,data_revision:0});
  });
  it('captures request-local generations without mutating the shared Worker bindings',async()=>{
    const originalEnv={...env,DB:native.binding()};let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    const app=new Hono<AppEnv>();app.use('*',systemStateMiddleware);
    app.get('/slow',async c=>{entered();await gate;await c.env.DB.prepare("INSERT INTO settings(key,value) VALUES('late-request','old')").run();return c.json({ok:true});});
    app.get('/epoch',async c=>c.json({generation:await getSystemGeneration(c.env)}));
    app.onError((error,c)=>c.json({code:(error as any).code},409));
    const slow=app.request('https://reset.example/slow',{},originalEnv);await started;
    expect(originalEnv.DB).toBe(native.binding());advance();
    const fresh=await app.request('https://reset.example/epoch',{},originalEnv);expect(await fresh.json()).toEqual({generation:1});
    release();expect((await slow).status).toBe(409);expect(originalEnv.DB).toBe(native.binding());
    expect(unwrapSystemDatabase(env.DB)).toBe(native.binding());
  });
  it('rejects a slow authorized read whose result belongs to the next generation',async()=>{
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const app=new Hono<AppEnv>();app.use('*',systemStateMiddleware);
    app.get('/',async c=>{entered();await gate;return c.json(await c.env.DB.prepare('SELECT name FROM companies').first());});
    app.onError((error,c)=>c.json({code:(error as ApiError).code},409));
    const request=app.request('https://reset.example/',{},env);await started;advance();
    native.sqlite.exec("UPDATE companies SET name='次世代の非公開データ'");release();
    const response=await request;expect(response.status).toBe(409);expect(await response.json()).toEqual({code:'SYSTEM_RESET_CHANGED'});
  });
});

describe('sessions cannot revive after reset',()=>{
  it('invalidates old customer sessions even when the same LINE account registers again',async()=>{
    const token=await signSession(customer,env),payload=await verifySession(token,env);
    expect(payload?.reset_generation).toBe(0);expect(await resolveActor(env,payload!)).toMatchObject({id:customer.id});
    native.sqlite.exec("DELETE FROM line_users;DELETE FROM companies;UPDATE system_state SET generation=1;INSERT INTO companies(id,name) VALUES('new-company','新取引先');INSERT INTO line_users(id,company_id,line_user_id,staff_name) VALUES('new-member','new-company','RESET-RUNTIME-CUSTOMER','新担当者');");
    const fresh={...env,DB:guardDatabase(native.binding(),1)};
    expect(await resolveActor(fresh,payload!)).toBeNull();
    // A freshly verified LINE identity can register and obtain a generation-1 cookie.
    const current=await resolveActor(fresh,{sub:customer.id,type:'customer'});
    expect(current).toMatchObject({company_id:'new-company'});
    expect((await verifySession(await signSession(current!,fresh),fresh))?.reset_generation).toBe(1);
  });
  it('requires fresh LINE authentication for legacy customer JWTs and rejects malformed generation claims',async()=>{
    const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
    async function signed(generation:unknown,include=true){
      const seconds=Math.floor(Date.now()/1000),payload={sub:customer.id,type:'customer',iat:seconds,exp:seconds+3600,...(include?{reset_generation:generation}:{})};
      const unsigned=encode({alg:'HS256',typ:'JWT'})+'.'+encode(payload),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
      return unsigned+'.'+Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(unsigned))).toString('base64url');
    }
    expect(await verifySession(await signed(undefined,false),env)).toBeNull();
    for(const bad of [-1,1.5,'1',null])expect(await verifySession(await signed(bad),env)).toBeNull();
  });
  it('preserves the per-admin session version check in addition to the reset generation',async()=>{
    native.sqlite.prepare('INSERT INTO admins(id,login_id,password_hash,name,role,session_version) VALUES(?,?,?,?,?,?)').run(owner.id,'runtime-owner',await hashPassword('runtime password'),owner.name,'owner',2);
    const token=await signSession({...owner,session_version:2},env);
    expect(await resolveActor(env,(await verifySession(token,env))!)).toMatchObject({id:owner.id});
    native.sqlite.exec('UPDATE admins SET session_version=3');expect(await resolveActor(env,(await verifySession(token,env))!)).toBeNull();
  });
});

describe('provider task leases and old background work',()=>{
  it('holds a renewable lease through the work, then releases it on success and failure',async()=>{
    await withSystemTask(env,'unit-send',async task=>{
      expect(leases()).toHaveLength(1);expect(leases()[0]).toMatchObject({generation:0,kind:'unit-send'});
      native.sqlite.exec("UPDATE system_task_leases SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 seconds')");
      const first=leases()[0].expires_at;await task.checkpoint();expect(leases()[0].expires_at>first).toBe(true);
      // Bookkeeping never invalidates the user's reviewed business-data revision.
      expect((await state()).data_revision).toBe(0);
    });
    expect(leases()).toHaveLength(0);
    await expect(withSystemTask(env,'unit-failure',async()=>{throw new Error('provider rejected');})).rejects.toThrow('provider rejected');
    expect(leases()).toHaveLength(0);
  });
  it('never invokes work when its request generation was reset before acquiring the lease',async()=>{
    const send=vi.fn(async()=>true);advance();
    await expect(withSystemTask(env,'old-send',send)).rejects.toMatchObject({code:'SYSTEM_RESET_CHANGED'});
    expect(send).not.toHaveBeenCalled();expect(leases()).toHaveLength(0);
  });
  it('refuses expired work and requires a generation check immediately before the next send',async()=>{
    await expect(withSystemTask(env,'expired-send',async task=>{native.sqlite.exec("UPDATE system_task_leases SET expires_at='2000-01-01T00:00:00Z'");await task.checkpoint();})).rejects.toMatchObject({code:'SYSTEM_TASK_EXPIRED'});
    expect(leases()).toHaveLength(0);
    await expect(withSystemTask(env,'changed-send',async task=>{advance();await task.checkpoint();})).rejects.toMatchObject({code:'SYSTEM_RESET_CHANGED'});
    expect(leases()).toHaveLength(0);
  });
  it('rejects an excessively delayed checkpoint response before invoking the provider',async()=>{
    vi.useFakeTimers({toFake:['Date']});let batches=0;
    const delayed=new Proxy(native.binding(),{get(target,key){
      if(key==='batch')return async(items:Statement[])=>{const result=await native.batch(items);if(++batches===2)vi.setSystemTime(Date.now()+60_001);return result;};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const provider=vi.fn();
    await expect(withSystemTask({...env,DB:guardDatabase(delayed,0)},'delayed-send',async task=>{await task.checkpoint();provider();})).rejects.toMatchObject({code:'SYSTEM_TASK_EXPIRED'});
    expect(provider).not.toHaveBeenCalled();expect(leases()).toHaveLength(0);
  });
  it('silently discards stale welcome/order waitUntil work without sending or recreating audits',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);advance();
    expect(await notifyWelcome(env,customer.id,'旧担当者')).toEqual({status:'disabled',channels:[]});
    expect(await notifyOrder(env,customer,{id:'OLD-ORDER',company_id:'runtime-company',desired_delivery_date:'2030-01-01',total_amount:100},'create')).toEqual({status:'disabled',channels:[]});
    expect(fetcher).not.toHaveBeenCalled();expect(logs()).toHaveLength(0);expect(leases()).toHaveLength(0);
  });
  it('rechecks the generation after obtaining a LINE token before disclosing a message',async()=>{
    const fetcher=vi.fn(async(_input:RequestInfo|URL)=>{advance();return Response.json({access_token:'reset-runtime-issued-token',token_type:'Bearer',expires_in:900});});
    vi.stubGlobal('fetch',fetcher);
    const automatic={...env,LINE_MESSAGING_CHANNEL_ID:'2011903727',LINE_CHANNEL_SECRET:'runtime-reset-secret-for-this-test'};
    expect(await notifyWelcome(automatic,customer.id,'旧担当者')).toEqual({status:'disabled',channels:[]});
    expect(fetcher).toHaveBeenCalledTimes(1);expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('/message/push');
    expect(logs()).toHaveLength(0);expect(leases()).toHaveLength(0);
  });
  it('fences both direct order email and administrator mail-test send operations',async()=>{
    native.sqlite.exec("INSERT INTO email_notification_config(id,provider,enabled,recipients_json,sender_email,app_origin,updated_at) VALUES(1,'resend',1,'[\"unit@example.test\"]','','https://reset.example','2030-01-01T00:00:00Z')");
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);advance();
    await expect(sendOrderEmail(env,{id:'OLD-ORDER',company_id:'runtime-company'},'create','old subject','old private body')).rejects.toMatchObject({code:'SYSTEM_RESET_CHANGED'});
    await expect(testMailSettings(env,owner)).rejects.toMatchObject({code:'SYSTEM_RESET_CHANGED'});
    expect(fetcher).not.toHaveBeenCalled();expect(logs()).toHaveLength(0);
  });
  it('keeps the mail lease until every in-flight recipient finishes after a parallel checkpoint fails',async()=>{
    native.sqlite.exec("INSERT INTO email_notification_config(id,provider,enabled,recipients_json,sender_email,app_origin,updated_at) VALUES(1,'resend',1,'[\"one@example.test\",\"two@example.test\"]','','https://reset.example','2030-01-01T00:00:00Z')");
    let batches=0,release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    const base=new Proxy(native.binding(),{get(target,key){
      if(key==='batch')return async(items:Statement[])=>{if(++batches===3)throw new ApiError(409,'SYSTEM_TASK_EXPIRED','期限切れ');return native.batch(items);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    vi.stubGlobal('fetch',vi.fn(async()=>{entered();await gate;return Response.json({id:'accepted'});}));
    const sending=sendOrderEmail({...env,DB:guardDatabase(base,0)},{id:'CURRENT-ORDER',company_id:'runtime-company'},'create','subject','private text');
    // Attach the rejection handler immediately, while one recipient is held open.
    const completed=sending.then(()=>null,error=>error);await started;
    expect(leases()).toHaveLength(1);release();
    expect(await completed).toMatchObject({code:'SYSTEM_TASK_EXPIRED'});expect(leases()).toHaveLength(0);
  });
});

it('preserves native D1 prepared statements and transaction guards in workerd',async()=>{
  const source=`
    import {guardDatabase,readSystemState,withSystemTask} from './src/server/system-state';
    import {assertChanges} from './src/server/services/common';
    export default {async fetch(request,env){
      const db=env.DB;
      await db.batch([
        db.prepare('CREATE TABLE system_state(id INTEGER PRIMARY KEY,generation INTEGER NOT NULL,data_revision INTEGER NOT NULL)'),
        db.prepare('INSERT INTO system_state VALUES(1,0,0)'),
        db.prepare('CREATE TABLE business(id TEXT PRIMARY KEY,value TEXT)'),
        db.prepare("INSERT INTO business VALUES('old','before')"),
        db.prepare('CREATE TABLE audit_logs(id TEXT PRIMARY KEY,acted_at TEXT,actor_type TEXT,actor_id TEXT,company_id TEXT,action TEXT NOT NULL,target_type TEXT,target_id TEXT,before_json TEXT,after_json TEXT)'),
        db.prepare('CREATE TABLE system_task_leases(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,kind TEXT,expires_at TEXT)'),
      ]);
      const guarded=guardDatabase(db,0),who={id:'owner',type:'admin'};
      const result=await guarded.batch([
        guarded.prepare("UPDATE business SET value='after' WHERE id='old'"),
        assertChanges(guarded,1,who,'UPDATE','business','old',null,{changed:true}),
      ]);
      const returned=await guarded.prepare("INSERT INTO business VALUES('returning','value') RETURNING value").first('value');
      await withSystemTask({...env,DB:guarded},'workerd-check',async task=>{await task.checkpoint();});
      await guarded.batch([guarded.prepare('WITH rows AS (SELECT id FROM business) SELECT * FROM rows')]);
      const before=await readSystemState(db),leaseCount=await db.prepare('SELECT COUNT(*) AS count FROM system_task_leases').first('count');
      await db.prepare('UPDATE system_state SET generation=1,data_revision=data_revision+1').run();
      let staleCode=null;try{await guarded.prepare("INSERT INTO business VALUES('late','private')").run();}catch(error){staleCode=error.code;}
      return Response.json({results:result.length,changes:result[0].meta.changes,returned,before,leaseCount,staleCode,late:await db.prepare("SELECT COUNT(*) AS count FROM business WHERE id='late'").first('count')});
    }};
  `;
  const bundled=await build({stdin:{contents:source,loader:'ts',resolveDir:fileURLToPath(new URL('../',import.meta.url))},write:false,bundle:true,format:'esm',platform:'browser',target:'es2022'});
  const worker=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-19',d1Databases:['DB'],script:bundled.outputFiles[0].text}));
  try{
    const response=await worker.dispatchFetch('https://reset.example/runtime');expect(response.status).toBe(200);
    expect(await response.json()).toEqual({results:2,changes:1,returned:'value',before:{generation:0,data_revision:2},leaseCount:0,staleCode:'SYSTEM_RESET_CHANGED',late:0});
  }finally{await worker.dispose();}
},10_000);
