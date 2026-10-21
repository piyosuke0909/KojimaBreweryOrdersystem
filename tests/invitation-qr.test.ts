import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import { issueInvitation, registerInvitation } from '../src/server/services/invitations';
import type { Bindings } from '../src/server/types';
import { migrateTestDatabase } from './helpers/migrate';

class SqliteD1 {
  sqlite=new DatabaseSync(':memory:');
  beforeBatch?:()=>Promise<void>;
  prepare(sql:string){return new Statement(this,sql);}
  async batch(statements:Statement[]){const before=this.beforeBatch;this.beforeBatch=undefined;await before?.();this.sqlite.exec('BEGIN IMMEDIATE');try{const result=statements.map(statement=>statement.execute());this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
  binding(){return this as unknown as D1Database;}
}
class Statement {
  constructor(private db:SqliteD1,private sql:string,private args:any[]=[]){ }
  bind(...args:any[]){return new Statement(this.db,this.sql,args);}
  async first(){return this.db.sqlite.prepare(this.sql).get(...this.args)||null;}
  async all(){return{success:true,results:this.db.sqlite.prepare(this.sql).all(...this.args)};}
  execute(){const result=this.db.sqlite.prepare(this.sql).run(...this.args);return{success:true,results:[],meta:{changes:Number(result.changes)}};}
  async run(){return this.execute();}
}
const owner={id:'qr-owner',type:'admin' as const,role:'owner',name:'管理者'};
const KEY='saved-qr-test-only-32-byte-minimum-encryption-key';
let db:SqliteD1,env:Bindings,ownerCookie:string,staffCookie:string,customerCookie:string;
beforeEach(async()=>{
  db=new SqliteD1();migrateTestDatabase(db.sqlite);
  db.sqlite.exec(`INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('qr-owner','qr-owner','unused','管理者','owner'),('qr-staff','qr-staff','unused','担当者','staff'); INSERT INTO companies(id,name) VALUES('a','A商店'),('b','B商店'); INSERT INTO settings(key,value) VALUES('invite_default_max_uses','5'),('invite_valid_days','30'); INSERT INTO line_users(id,company_id,line_user_id,staff_name) VALUES('customer','a','QR_TEST_CUSTOMER','顧客');`);
  env={DB:db.binding(),APP_ENV:'production',ALLOW_DEMO_AUTH:'false',SESSION_SECRET:'qr-session-test-only-longer-than-32-characters',INVITATION_TOKEN_ENCRYPTION_KEY:KEY,LIFF_ID:'2011901973-juZ5QTYX'} as Bindings;
  ownerCookie=`kojima_session=${await signSession(owner,env)}`;
  staffCookie=`kojima_session=${await signSession({id:'qr-staff',type:'admin',role:'staff',name:'担当者'},env)}`;
  customerCookie=`kojima_session=${await signSession({id:'QR_TEST_CUSTOMER',type:'customer',company_id:'a',name:'顧客'},env)}`;
});
afterEach(()=>db.sqlite.close());
async function request(method:string,path:string,input?:unknown,cookie=ownerCookie){
  const response=await app.request('https://orders.example'+path,{method,headers:{Origin:'https://orders.example',...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})},env);
  const json=await response.json() as any;return{status:response.status,headers:response.headers,data:json.data,error:json.error,json};
}
async function issue(input:Record<string,unknown>={}){const result=await request('POST','/api/admin/companies/a/invitations',input);expect(result.status).toBe(201);return result.data;}
const path=(id:string)=>`/api/admin/companies/a/invitations/${id}`;
const stored=(id:string)=>db.sqlite.prepare('SELECT * FROM invitations WHERE id=?').get(id) as any;
const audit=()=>JSON.stringify(db.sqlite.prepare('SELECT * FROM audit_logs').all());

describe('saved invitation QR through real admin routes and SQLite',()=>{
  it('persists encrypted QR without expiry and redisplays the same URL even when its registration limit is full',async()=>{
    const invitation=await issue({max_uses:1});
    expect(invitation).toMatchObject({expires_at:null,qr_available:true,used_count:0,max_uses:1});
    const row=stored(invitation.id);
    expect(row.expires_at).toBe('');expect(row.token_ciphertext).toMatch(/^v1\./);
    expect(row.token_ciphertext).not.toContain(invitation.token);
    const lookup=await request('GET',`/api/public/invitations/lookup?t=${invitation.token}`,undefined,'');
    expect(lookup.data.expires_at).toBeNull();
    await registerInvitation(db.binding(),{sub:'NEW_QR_MEMBER'},invitation.token,'注文担当者');
    for(let count=0;count<3;count++){
      const shown=await request('GET',path(invitation.id)+'/qr');
      expect(shown.status).toBe(200);expect(shown.headers.get('cache-control')).toBe('no-store');
      expect(shown.data).toMatchObject({url:invitation.url,used_count:1,max_uses:1,expires_at:null});
    }
    expect(stored(invitation.id).used_count).toBe(1);
    await expect(registerInvitation(db.binding(),{sub:'SECOND_QR_MEMBER'},invitation.token,'次の担当者')).rejects.toMatchObject({status:409});
    expect((await request('PUT',path(invitation.id),{max_uses:2,expires_at:null})).status).toBe(200);
    await registerInvitation(db.binding(),{sub:'SECOND_QR_MEMBER'},invitation.token,'次の担当者');
    expect(stored(invitation.id)).toMatchObject({used_count:2,max_uses:2});
    expect((await request('GET',path(invitation.id)+'/qr')).data.url).toBe(invitation.url);
    expect((await request('PUT',path(invitation.id),{max_uses:1})).status).toBe(400);
  });

  it('never exposes raw/hash/encrypted token in lists, company detail, update responses or audit history',async()=>{
    const invitation=await issue(),row=stored(invitation.id);
    const responses=[await request('GET','/api/admin/companies/a/invitations'),await request('GET','/api/admin/companies/a'),await request('PUT',path(invitation.id),{max_uses:7,expires_at:null,note:'担当者用QR'})];
    for(const response of responses){
      expect(response.status).toBe(200);
      const body=JSON.stringify(response.json);
      for(const forbidden of [invitation.token,row.token_hash,row.token_ciphertext])expect(body).not.toContain(forbidden);
    }
    expect(responses[0].data[0]).toMatchObject({qr_available:true,expires_at:null});
    expect((await request('DELETE',path(invitation.id))).status).toBe(200);
    for(const forbidden of [invitation.token,row.token_hash,row.token_ciphertext])expect(audit()).not.toContain(forbidden);
  });

  it('conflicts when registration races a lower cap, rolls back its edit and audit, and still allows an unlimited cap',async()=>{
    const invitation=await issue({max_uses:3,note:'元の設定'});
    // The admin has read used_count=0; two independently committed registrations then win the race.
    db.beforeBatch=async()=>{
      await registerInvitation(db.binding(),{sub:'RACING_QR_MEMBER_ONE'},invitation.token,'担当者1');
      await registerInvitation(db.binding(),{sub:'RACING_QR_MEMBER_TWO'},invitation.token,'担当者2');
    };
    const conflicting=await request('PUT',path(invitation.id),{max_uses:1,note:'保存されない変更'});
    expect(conflicting).toMatchObject({status:409,error:{code:'CONFLICT'}});
    expect(stored(invitation.id)).toMatchObject({used_count:2,max_uses:3,note:'元の設定'});
    expect(db.sqlite.prepare("SELECT count(*) count FROM audit_logs WHERE action='INVITE_UPDATE' AND target_id=?").get(invitation.id)).toMatchObject({count:0});
    expect((await request('GET',path(invitation.id)+'/qr')).data.url).toBe(invitation.url);

    db.beforeBatch=()=>registerInvitation(db.binding(),{sub:'RACING_QR_MEMBER_THREE'},invitation.token,'担当者3').then(()=>{});
    const unlimited=await request('PUT',path(invitation.id),{max_uses:null});
    expect(unlimited.status).toBe(200);
    expect(stored(invitation.id)).toMatchObject({used_count:3,max_uses:null});
    expect(db.sqlite.prepare("SELECT count(*) count FROM audit_logs WHERE action='INVITE_UPDATE' AND target_id=?").get(invitation.id)).toMatchObject({count:1});
  });

  it('requires an administrator for retrieval and an owner for legacy QR restoration, with matching company scope',async()=>{
    const invitation=await issue();
    expect((await request('GET',path(invitation.id)+'/qr',undefined,'')).status).toBe(401);
    expect((await request('GET',path(invitation.id)+'/qr',undefined,customerCookie)).status).toBe(403);
    expect((await request('GET',path(invitation.id)+'/qr',undefined,staffCookie)).status).toBe(200);
    expect((await request('GET',`/api/admin/companies/b/invitations/${invitation.id}/qr`)).status).toBe(404);
    expect((await request('PUT',path(invitation.id)+'/qr',{token:invitation.token},staffCookie)).status).toBe(403);
  });

  it('does not return revoked, deleted, expired or inactive-company QR codes',async()=>{
    for(const mode of ['revoked','deleted','expired','company'] as const){
      const invitation=await issue();
      if(mode==='revoked')await request('POST',path(invitation.id)+'/revoke',{});
      if(mode==='deleted')await request('DELETE',path(invitation.id));
      if(mode==='expired')db.sqlite.prepare("UPDATE invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(invitation.id);
      if(mode==='company')db.sqlite.prepare("UPDATE companies SET status='inactive' WHERE id='a'").run();
      expect((await request('GET',path(invitation.id)+'/qr')).status).toBe(mode==='deleted'?404:410);
      expect((await request('PUT',path(invitation.id)+'/qr',{token:invitation.token})).status).toBe(mode==='deleted'?404:410);
      db.sqlite.prepare("UPDATE companies SET status='active' WHERE id='a'").run();
    }
  });

  it('restores only a matching legacy token while preserving registration counts, IDs, hash and expiry',async()=>{
    const legacy=await issueInvitation(db.binding(),owner,'a',{max_uses:2,expires_at:'2099-01-01T00:00:00.000Z'},'https://orders.example',env.LIFF_ID);
    await registerInvitation(db.binding(),{sub:'LEGACY_QR_MEMBER'},legacy.token,'既存担当者');
    expect((await request('GET','/api/admin/companies/a/invitations')).data[0].qr_available).toBe(false);
    expect((await request('GET',path(legacy.id)+'/qr')).status).toBe(409);
    const before=stored(legacy.id);
    expect((await request('PUT',path(legacy.id)+'/qr',{token:'0'.repeat(64)})).status).toBe(400);
    const restored=await request('PUT',path(legacy.id)+'/qr',{token:legacy.token});
    expect(restored.status).toBe(200);expect(restored.data.url).toBe(legacy.url);
    expect(stored(legacy.id)).toMatchObject({id:before.id,token_hash:before.token_hash,max_uses:2,used_count:1,expires_at:before.expires_at,status:'active'});
    expect(stored(legacy.id).token_ciphertext).toMatch(/^v1\./);
    expect(db.sqlite.prepare('SELECT count(*) count FROM invitations').get()).toMatchObject({count:1});
    const logs=audit();for(const forbidden of [legacy.token,before.token_hash,stored(legacy.id).token_ciphertext])expect(logs).not.toContain(forbidden);
    expect((await request('PUT',path(legacy.id),{expires_at:null})).data.expires_at).toBeNull();
    expect(stored(legacy.id).expires_at).toBe('');
  });

  it('rejects tampered envelopes, different keys and swapped row ciphertext without leaking it',async()=>{
    const first=await issue(),second=await issue();
    const firstRow=stored(first.id),secondRow=stored(second.id);
    env.INVITATION_TOKEN_ENCRYPTION_KEY='another-encryption-key-at-least-32-characters';
    const wrongKey=await request('GET',path(first.id)+'/qr');expect(wrongKey.status).toBe(503);
    env.INVITATION_TOKEN_ENCRYPTION_KEY=KEY;
    db.sqlite.prepare('UPDATE invitations SET token_ciphertext=? WHERE id=?').run(secondRow.token_ciphertext,first.id);
    const swapped=await request('GET',path(first.id)+'/qr');expect(swapped.status).toBe(503);
    db.sqlite.prepare("UPDATE invitations SET token_ciphertext='v1.invalid.invalid' WHERE id=?").run(first.id);
    const tampered=await request('GET',path(first.id)+'/qr');expect(tampered.status).toBe(503);
    for(const response of [wrongKey,swapped,tampered])for(const forbidden of [first.token,second.token,firstRow.token_ciphertext,secondRow.token_ciphertext])expect(JSON.stringify(response.json)).not.toContain(forbidden);
    expect(stored(first.id).used_count).toBe(0);
  });

  it('fails before issuing anything when the production persistence secret is unavailable',async()=>{
    delete env.INVITATION_TOKEN_ENCRYPTION_KEY;
    const result=await request('POST','/api/admin/companies/a/invitations',{});
    expect(result).toMatchObject({status:503,error:{code:'INVITATION_QR_NOT_CONFIGURED'}});
    expect(db.sqlite.prepare('SELECT count(*) count FROM invitations').get()).toMatchObject({count:0});
    expect(db.sqlite.prepare('SELECT count(*) count FROM audit_logs').get()).toMatchObject({count:0});
  });
});
