import { DatabaseSync } from 'node:sqlite';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { app } from '../src/server';
import type { Bindings } from '../src/server/types';
import { migrateTestDatabase } from './helpers/migrate';

const SECRET='test-only-line-webhook-signing-secret';
const MATCHED='U'+'a'.repeat(32),UNKNOWN='U'+'b'.repeat(32),INACTIVE='U'+'c'.repeat(32);
class SqliteD1{
  sqlite=new DatabaseSync(':memory:');
  prepare(sql:string){return new Statement(this,sql);}
  binding(){return this as unknown as D1Database;}
}
class Statement{
  constructor(private db:SqliteD1,private sql:string,private args:any[]=[]){ }
  bind(...args:any[]){return new Statement(this.db,this.sql,args);}
  async first(){return this.db.sqlite.prepare(this.sql).get(...this.args)??null;}
  async run(){const result=this.db.sqlite.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(result.changes)}};}
}
let db:SqliteD1,env:Bindings;
beforeEach(()=>{
  db=new SqliteD1();migrateTestDatabase(db.sqlite);
  db.sqlite.exec("INSERT INTO companies(id,name,status) VALUES('a','登録企業','active'),('inactive','無効企業','inactive');");
  const insert=db.sqlite.prepare("INSERT INTO line_users(id,company_id,line_user_id,staff_name,status) VALUES(?,?,?,?,?)");
  insert.run('linked','a',MATCHED,'PRIVATE-NAME','active');insert.run('inactive-member','inactive',INACTIVE,'PRIVATE-INACTIVE-NAME','active');
  env={DB:db.binding(),APP_ENV:'production',LINE_CHANNEL_SECRET:SECRET}as Bindings;
});
afterEach(()=>db.sqlite.close());
const event=(code:string,userId=MATCHED,extra:Record<string,any>={})=>({type:'message',webhookEventId:'private-event-'+code,message:{type:'text',id:'private-message-'+code,text:'通知確認-'+code},source:{type:'user',userId},timestamp:1792540800000,...extra});
const logs=()=>db.sqlite.prepare("SELECT * FROM audit_logs WHERE action='LINE_NOTIFICATION_IDENTITY_CHECK' ORDER BY target_id").all() as any[];
async function signature(raw:string){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);const digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(raw));return btoa(String.fromCharCode(...new Uint8Array(digest)));}
async function request(events:any[],mode:'valid'|'missing'|'invalid'='valid'){
  const raw=JSON.stringify({events});const signed=mode==='valid'?await signature(raw):mode==='invalid'?'invalid-signature':undefined;
  const response=await app.request('https://orders.example/api/line/webhook',{method:'POST',headers:{'Content-Type':'application/json',...(signed?{'x-line-signature':signed}:{})},body:raw},env);
  return {response,body:await response.json() as any};
}

describe('signed LINE webhook identity checks',()=>{
  it('rejects missing or invalid signatures without recording a check',async()=>{
    expect((await request([event('ABC123')],'missing')).response.status).toBe(401);
    expect((await request([event('ABC123')],'invalid')).response.status).toBe(401);
    expect(logs()).toHaveLength(0);
  });

  it('ignores normal text, follow events, group sources, malformed IDs and non-exact codes',async()=>{
    const candidates=[event('ABC123',MATCHED,{message:{type:'text',text:'普通のお問い合わせ'}}),event('ABC123',MATCHED,{type:'follow'}),event('ABC123',MATCHED,{source:{type:'group',userId:MATCHED}}),event('ABC123','invalid-user-id'),event('ABC123',MATCHED,{message:{type:'text',text:'通知確認-ABC123\n'}}),event('ABC123',MATCHED,{message:{type:'text',text:'通知確認-abc123'}})];
    const result=await request(candidates);expect(result.response.status).toBe(200);expect(result.body).toEqual({data:{accepted:true}});expect(logs()).toHaveLength(0);
    expect((await request([])).response.status).toBe(200);
  });

  it('records only a matching company or a non-match boolean and never alters account bindings',async()=>{
    const before=db.sqlite.prepare('SELECT * FROM line_users ORDER BY id').all();
    const result=await request([event('ABC123'),event('DEF456',UNKNOWN),event('GHI789',INACTIVE)]);
    expect(result.response.status).toBe(200);expect(result.body).toEqual({data:{accepted:true}});
    const records=logs();expect(records).toHaveLength(3);
    expect(records.map(record=>JSON.parse(record.after_json))).toEqual([
      {matched:true,company_id:'a',check_code:'ABC123',received_at:expect.any(String)},
      {matched:false,company_id:null,check_code:'DEF456',received_at:expect.any(String)},
      {matched:false,company_id:null,check_code:'GHI789',received_at:expect.any(String)},
    ]);
    expect(records.map(record=>record.company_id)).toEqual(['a',null,null]);
    expect(records.every(record=>record.target_type==='line_notification_check'&&record.actor_type==='system')).toBe(true);
    expect(db.sqlite.prepare('SELECT * FROM line_users ORDER BY id').all()).toEqual(before);
    const serialized=JSON.stringify({records,response:result.body});
    for(const sensitive of [MATCHED,UNKNOWN,INACTIVE,SECRET,'PRIVATE-','通知確認-','private-event-','private-message-'])expect(serialized).not.toContain(sensitive);
  });

  it('deduplicates signed redelivery using hashes with and without webhook event IDs',async()=>{
    const first=event('ABC123');
    await request([first]);await request([{...first,deliveryContext:{isRedelivery:true}}]);
    const fallback=event('DEF456',MATCHED,{webhookEventId:undefined});
    await request([fallback]);await request([{...fallback,deliveryContext:{isRedelivery:true}}]);
    const records=logs();expect(records).toHaveLength(2);expect(records.every(record=>/^line-identity-[0-9a-f]{64}$/.test(record.id))).toBe(true);
    expect(records.map(record=>record.target_id)).toEqual(['ABC123','DEF456']);
  });
});
