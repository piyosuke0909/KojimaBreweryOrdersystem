import { DatabaseSync } from 'node:sqlite';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { app } from '../src/server';
import { checkPassword,hashPassword,signSession } from '../src/server/auth';
import type { Actor,Bindings } from '../src/server/types';
import { migrateTestDatabase } from './helpers/migrate';

class SqliteD1{
  sqlite=new DatabaseSync(':memory:');beforeBatch:(()=>void)|null=null;
  prepare(sql:string){return new Statement(this,sql);}
  async batch(statements:Statement[]){const hook=this.beforeBatch;this.beforeBatch=null;hook?.();this.sqlite.exec('BEGIN IMMEDIATE');try{const results=statements.map(value=>value.execute());this.sqlite.exec('COMMIT');return results;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
  binding(){return this as unknown as D1Database;}
}
class Statement{
  constructor(private db:SqliteD1,private sql:string,private args:any[]=[]){ }
  bind(...args:any[]){return new Statement(this.db,this.sql,args);}
  async first(){return this.db.sqlite.prepare(this.sql).get(...this.args)??null;}
  async all(){return {success:true,results:this.db.sqlite.prepare(this.sql).all(...this.args)};}
  execute(){const result=this.db.sqlite.prepare(this.sql).run(...this.args);return {success:true,results:[],meta:{changes:Number(result.changes)}};}
  async run(){return this.execute();}
}
const origin='https://account.example',oldPassword='account-current-password-2026',newPassword='account-new-password-2026';
let db:SqliteD1,env:Bindings,owner:Actor,other:Actor,cookie:string,otherCookie:string,oldHash:string;
beforeEach(async()=>{
  db=new SqliteD1();migrateTestDatabase(db.sqlite);
  owner={id:'account-owner-'+crypto.randomUUID(),name:'アカウント管理者',type:'admin',role:'owner'};
  other={id:'account-staff-'+crypto.randomUUID(),name:'別の管理者',type:'admin',role:'staff'};
  oldHash=await hashPassword(oldPassword);
  db.sqlite.prepare("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES(?,?,?,?,?)").run(owner.id,'account-owner',oldHash,owner.name,'owner');
  db.sqlite.prepare("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES(?,?,?,?,?)").run(other.id,'account-staff',oldHash,other.name,'staff');
  db.sqlite.exec("INSERT INTO companies(id,name) VALUES('account-company','取引先');INSERT INTO line_users(id,company_id,line_user_id,staff_name) VALUES('account-member','account-company','ACCOUNT-CUSTOMER','担当者');");
  env={DB:db.binding(),APP_ENV:'production',SESSION_SECRET:'test-account-only-session-key-longer-than-32-characters'} as Bindings;
  cookie='kojima_session='+await signSession(owner,env);otherCookie='kojima_session='+await signSession(other,env);
});
afterEach(()=>db.sqlite.close());
async function request(path='/api/admin/account',input?:unknown,session:string|null=cookie,extraHeaders:Record<string,string>={}){
  const response=await app.request(origin+path,{method:input===undefined?'GET':'PUT',headers:{Origin:origin,'Content-Type':'application/json',...(session?{Cookie:session}:{}),...extraHeaders},...(input===undefined?{}:{body:JSON.stringify(input)})},env);
  return {status:response.status,data:await response.json() as any,cookie:response.headers.get('set-cookie')?.split(';')[0]??null};
}
const change=(extra:Record<string,unknown>={})=>({login_id:'updated-admin',current_password:oldPassword,...extra});
const row=()=>db.sqlite.prepare('SELECT * FROM admins WHERE id=?').get(owner.id) as any;
const receipts=()=>db.sqlite.prepare("SELECT * FROM audit_logs WHERE action='ADMIN_ACCOUNT_UPDATE'").all() as any[];
async function legacyCookie(){
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const stamp=Math.floor(Date.now()/1000),unsigned=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:owner.id,type:'admin',iat:stamp,exp:stamp+3600});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SESSION_SECRET!),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(unsigned))).toString('base64url');
  return 'kojima_session='+unsigned+'.'+signature;
}

describe('own administrator login credentials',()=>{
  it('requires an authenticated administrator and rejects customers',async()=>{
    expect((await request(undefined,undefined,null)).status).toBe(401);
    const customer='kojima_session='+await signSession({id:'ACCOUNT-CUSTOMER',name:'担当者',type:'customer'},env);
    expect((await request(undefined,undefined,customer)).status).toBe(403);
    expect((await request(undefined,change(),customer)).status).toBe(403);
    expect(receipts()).toHaveLength(0);
  });
  it('returns only safe fields for the current account, ignoring a requested target',async()=>{
    const response=await request('/api/admin/account?id='+other.id);
    expect(response.status).toBe(200);expect(response.data.data).toEqual({id:owner.id,login_id:'account-owner',name:owner.name,role:'owner',can_change_credentials:true});
    expect(JSON.stringify(response.data)).not.toMatch(/password|session_version/);
  });
  it('rejects cross-site account updates before checking or changing credentials',async()=>{
    expect((await request(undefined,change(),cookie,{Origin:'https://attacker.example','Sec-Fetch-Site':'cross-site'})).status).toBe(403);
    expect(row().login_id).toBe('account-owner');expect(receipts()).toHaveLength(0);
  });
  it('requires the current password even for a username-only change',async()=>{
    const response=await request(undefined,change({current_password:'wrong-private-password'}));
    expect(response.status).toBe(400);expect(response.data.error.code).toBe('CURRENT_PASSWORD_INCORRECT');
    expect(row().password_hash).toBe(oldHash);expect(row().session_version).toBe(0);expect(receipts()).toHaveLength(0);
    expect(JSON.stringify(response.data)).not.toContain('wrong-private-password');
  });
  it('changes username only and replaces the current session while invalidating both old sessions',async()=>{
    const secondSession='kojima_session='+await signSession(owner,env);
    const response=await request(undefined,change({login_id:'  revised.owner  '}));
    expect(response.status).toBe(200);expect(response.cookie).toBeTruthy();expect(response.data.data.login_id).toBe('revised.owner');
    expect(row().password_hash).toBe(oldHash);expect(row().session_version).toBe(1);
    expect((await request('/api/auth/me',undefined,cookie)).status).toBe(401);expect((await request('/api/auth/me',undefined,secondSession)).status).toBe(401);
    expect((await request('/api/auth/me',undefined,response.cookie)).status).toBe(200);expect((await request('/api/auth/me',undefined,otherCookie)).status).toBe(200);
    expect(JSON.parse(receipts()[0].after_json)).toEqual({username_changed:true,password_changed:false,sessions_revoked:true});
  });
  it('changes a password with salt and keeps every password/hash out of the response and audit',async()=>{
    const response=await request(undefined,change({login_id:'account-owner',new_password:newPassword,confirm_password:newPassword}));
    expect(response.status).toBe(200);expect(await checkPassword(newPassword,row().password_hash)).toBe(true);expect(await checkPassword(oldPassword,row().password_hash)).toBe(false);
    expect(row().password_hash).not.toBe(oldHash);
    const exposed=JSON.stringify({response:response.data,audit:receipts()});
    for(const secret of [oldPassword,newPassword,oldHash,row().password_hash,'pbkdf2-sha256'])expect(exposed).not.toContain(secret);
  });
  it('allows login with changed credentials and retains the new session version after another login',async()=>{
    await request(undefined,change({new_password:newPassword,confirm_password:newPassword}));
    const login=async(login_id:string,password:string)=>{
      const response=await app.request(origin+'/api/auth/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':crypto.randomUUID()},body:JSON.stringify({login_id,password})},env);
      return {status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0]??null};
    };
    expect((await login('account-owner',oldPassword)).status).toBe(401);
    const fresh=await login('updated-admin',newPassword);expect(fresh.status).toBe(200);expect((await request('/api/auth/me',undefined,fresh.cookie)).status).toBe(200);
  });
  it('does not affect customer sessions when administrator credentials change',async()=>{
    const customer='kojima_session='+await signSession({id:'ACCOUNT-CUSTOMER',name:'担当者',type:'customer'},env);
    await request(undefined,change());expect((await request('/api/auth/me',undefined,customer)).status).toBe(200);
  });
  it('accepts old tokens without a version only until the first credential change',async()=>{
    const old=await legacyCookie();expect((await request('/api/auth/me',undefined,old)).status).toBe(200);
    await request(undefined,change(),old);expect((await request('/api/auth/me',undefined,old)).status).toBe(401);
  });
  it('rejects duplicate usernames without changing any account or session version',async()=>{
    expect((await request(undefined,change({login_id:'account-staff'}))).status).toBe(409);
    expect(row().login_id).toBe('account-owner');expect(row().session_version).toBe(0);expect(receipts()).toHaveLength(0);
  });
  it('validates password strength, confirmation, unsupported fields and unchanged values',async()=>{
    const invalid=[change({new_password:'short',confirm_password:'short'}),change({new_password:newPassword,confirm_password:'different'}),change({role:'owner'}),change({id:other.id}),change({login_id:'bad user'}),change({login_id:'account-owner'}),change({new_password:oldPassword,confirm_password:oldPassword})];
    for(const input of invalid)expect((await request(undefined,input)).status).toBe(400);
    expect(row().login_id).toBe('account-owner');expect(receipts()).toHaveLength(0);
  });
  it('lets a staff administrator update only their own credentials and preserves their role',async()=>{
    const response=await request(undefined,change({login_id:'updated-staff'}),otherCookie);
    expect(response.status).toBe(200);expect(response.data.data).toMatchObject({id:other.id,role:'staff'});
    expect(row().login_id).toBe('account-owner');expect(db.sqlite.prepare('SELECT login_id,role FROM admins WHERE id=?').get(other.id)).toMatchObject({login_id:'updated-staff',role:'staff'});
  });
  it('rolls the credential update back if the audit cannot be persisted',async()=>{
    db.sqlite.exec("CREATE TRIGGER stop_account_audit BEFORE INSERT ON audit_logs WHEN NEW.action='ADMIN_ACCOUNT_UPDATE' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    expect((await request(undefined,change())).status).toBe(500);expect(row().login_id).toBe('account-owner');expect(row().session_version).toBe(0);expect(row().password_hash).toBe(oldHash);
  });
  it('rejects an update when credentials change between checking the password and saving',async()=>{
    db.beforeBatch=()=>db.sqlite.prepare('UPDATE admins SET session_version=1 WHERE id=?').run(owner.id);
    expect((await request(undefined,change())).status).toBe(409);expect(row().login_id).toBe('account-owner');expect(row().session_version).toBe(1);expect(receipts()).toHaveLength(0);
  });
  it('limits repeated incorrect current-password checks for one administrator',async()=>{
    for(let index=0;index<8;index++)expect((await request(undefined,change({current_password:'wrong'}))).status).toBe(400);
    expect((await request(undefined,change())).status).toBe(429);
    expect((await request(undefined,change({login_id:'other-staff'}),otherCookie)).status).toBe(200);
  });
  it('explains the generated-password demo account without providing a reset bypass',async()=>{
    db.sqlite.prepare("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('demo-admin','demo-admin',?,'デモ管理者','owner')").run(await hashPassword(crypto.randomUUID()));env.APP_ENV='development';
    const demo='kojima_session='+await signSession({id:'demo-admin',name:'デモ管理者',role:'owner',type:'admin'},env);
    expect((await request(undefined,undefined,demo)).data.data.can_change_credentials).toBe(false);
    expect((await request(undefined,change({current_password:'unknown'}),demo)).status).toBe(400);
  });
});
