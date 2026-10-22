import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateTestDatabase } from './helpers/migrate';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import { adminNotificationStatement,lineMessageNotificationStatement,readLineConversationNotifications } from '../src/server/services/admin-notifications';
import type { Actor,Bindings } from '../src/server/types';

class SqliteD1 {
  sqlite=new DatabaseSync(':memory:');
  prepare(sql:string){return new Statement(this,sql);}
  async batch(statements:Statement[]){this.sqlite.exec('BEGIN IMMEDIATE');try{const result=statements.map(statement=>statement.execute());this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
  binding(){return this as unknown as D1Database;}
}
class Statement {
  constructor(private db:SqliteD1,private sql:string,private args:any[]=[]){ }
  bind(...args:any[]){return new Statement(this.db,this.sql,args);}
  async first(){return this.db.sqlite.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:this.db.sqlite.prepare(this.sql).all(...this.args),success:true};}
  execute(){const result=this.db.sqlite.prepare(this.sql).run(...this.args);return {success:true,results:[],meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}
  async run(){return this.execute();}
}
const owner:Actor={id:'notice-owner',name:'管理者',type:'admin',role:'owner'};
const other:Actor={id:'notice-other',name:'別管理者',type:'admin',role:'staff'};
const customer:Actor={id:'NOTICE_LINE_A',name:'担当者',type:'customer',company_id:'a'};
const origin='https://orders.example';
let db:SqliteD1,env:Bindings,pending:Promise<unknown>[];

beforeEach(()=>{
  db=new SqliteD1();migrateTestDatabase(db.sqlite);
  db.sqlite.exec(`
    INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('notice-owner','notice-owner','unused','管理者','owner'),('notice-other','notice-other','unused','別管理者','staff');
    INSERT INTO companies(id,name) VALUES('a','A商店'),('b','Bホテル');
    INSERT INTO line_users(id,company_id,line_user_id,staff_name) VALUES('member-a','a','NOTICE_LINE_A','担当者A'),('member-a2','a','NOTICE_LINE_A2','担当者A2'),('member-b','b','NOTICE_LINE_B','担当者B');
    INSERT INTO shipping_rules(id,name,delivery_method,is_free_shipping) VALUES('notice-rule','検証用自社便','own_delivery',1);
    INSERT INTO shipping_addresses(id,company_id,name,postal_code,prefecture,city,address_line1,phone,shipping_rule_id) VALUES('notice-address','a','検証用配送先','4840000','愛知県','犬山市','架空住所','0000000000','notice-rule');
    INSERT INTO products(id,name,category,volume_ml,standard_price,weight_kg) VALUES('notice-product','通知確認用商品','その他',300,1000,1);
  `);
  env={DB:db.binding(),APP_ENV:'development',ALLOW_DEMO_AUTH:'false',SESSION_SECRET:'admin-notification-tests-only-secret-longer-than-32-characters'} as Bindings;pending=[];
});
afterEach(async()=>{await Promise.allSettled(pending);db.sqlite.close();});
async function request(path:string,body?:unknown,who:Actor|null=owner,method=body===undefined?'GET':'POST'){
  const cookie=who?'kojima_session='+await signSession(who,env):null;
  const response=await app.request(origin+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},env,{waitUntil:(promise:Promise<unknown>)=>pending.push(promise),passThroughOnException(){}} as unknown as ExecutionContext);
  return {status:response.status,value:await response.json() as any};
}
const notices=(who:Actor=owner)=>request('/api/admin/notifications',undefined,who);
function order(id='O-NOTICE',company='a'){
  const row={id,request_id:crypto.randomUUID(),company_id:company,ordered_by_name:'担当者',ordered_at:'2026-10-22T00:00:00.000Z',updated_at:'2026-10-22T00:00:00.000Z',desired_delivery_date:'2099-12-20',status:'received',snap_recipient_name:'A商店',snap_postal_code:'4840000',snap_address:'架空住所',items_subtotal:1000,shipping_fee:0,snap_tax_rate:10,snap_tax_calc_unit:'order',snap_tax_rounding:'floor',tax_amount:100,total_amount:1100};
  const fields=Object.keys(row);db.sqlite.prepare(`INSERT INTO orders(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...Object.values(row));return row;
}
async function orderEvent(index=0){
  const current=order('O-NOTICE-'+index);
  await adminNotificationStatement(env.DB,{event_key:'order-event-'+index,kind:'order_created',company_id:'a',order_id:current.id,title:'A商店：新しい注文',created_at:`2026-10-22T00:00:${String(index).padStart(2,'0')}.000Z`}).run();
}
async function lineEvent(key='line-a',company='a',member='member-a'){
  await lineMessageNotificationStatement(env.DB,{event_key:key,company_id:company,line_user_id:member,company_name:company==='a'?'A商店':'Bホテル',staff_name:'担当者',created_at:'2026-10-22T01:00:00.000Z'}).run();
}

describe('administrator notification API and transaction integration',()=>{
  it('requires an administrator and does not expose notifications to customers',async()=>{
    expect((await request('/api/admin/notifications',undefined,null)).status).toBe(401);
    expect((await request('/api/admin/notifications',undefined,customer)).status).toBe(403);
    expect((await request('/api/admin/notifications/read-all',{},customer)).status).toBe(403);
  });
  it('rejects cross-site read mutations without creating any receipt',async()=>{
    await orderEvent();const id=(await notices()).value.data.items[0].id;
    const cookie='kojima_session='+await signSession(owner,env);
    for(const path of [`/api/admin/notifications/${id}/read`,'/api/admin/notifications/read-all']){
      const response=await app.request(origin+path,{method:'POST',headers:{Cookie:cookie,Origin:'https://other.example','Content-Type':'application/json','Sec-Fetch-Site':'cross-site'},body:'{}'},env);
      expect(response.status).toBe(403);
    }
    expect((await notices()).value.data.total_unread).toBe(1);
    expect(db.sqlite.prepare('SELECT COUNT(*) count FROM admin_notification_reads').get()).toMatchObject({count:0});
  });
  it('starts empty without treating historical orders as new arrivals',async()=>{
    order();
    expect((await notices()).value.data).toEqual({items:[],total_unread:0,counts:{orders:0,companies:0}});
  });
  it('returns only the latest five events while counting every unread event by sidebar category',async()=>{
    for(let i=0;i<7;i++)await orderEvent(i);
    await lineEvent();
    const result=(await request('/api/admin/notifications?limit=1000')).value.data;
    expect(result.total_unread).toBe(8);expect(result.counts).toEqual({orders:7,companies:1});expect(result.items).toHaveLength(5);
    expect(result.items[0]).toMatchObject({kind:'line_message',category:'companies',is_read:false,line_user_id:'member-a',href:'/admin/companies/a?tab=line-messages&line_user_id=member-a'});
    expect(result.items[1]).toMatchObject({order_id:'O-NOTICE-6',href:'/admin/orders/O-NOTICE-6'});
    expect(JSON.stringify(result)).not.toContain('NOTICE_LINE_A');expect(JSON.stringify(result)).not.toContain('event_key');
  });
  it('keeps insertion order for same-timestamp events and returns the latest inserted five',async()=>{
    for(let index=0;index<7;index++){
      const current=order('O-SAME-STAMP-'+index);
      await adminNotificationStatement(env.DB,{event_key:'same-stamp-'+index,kind:'order_created',company_id:'a',order_id:current.id,title:'同時刻の通知',created_at:'2026-10-22T02:00:00.000Z'}).run();
    }
    const result=(await notices()).value.data;
    expect(result.total_unread).toBe(7);
    expect(result.items.map((item:any)=>item.order_id)).toEqual([6,5,4,3,2].map(index=>'O-SAME-STAMP-'+index));
  });
  it('does not mark an event as read merely because the notification menu was fetched',async()=>{
    await orderEvent();await notices();await notices();
    expect((await notices()).value.data.total_unread).toBe(1);expect(db.sqlite.prepare('SELECT COUNT(*) count FROM admin_notification_reads').get()).toMatchObject({count:0});
  });
  it('marks one event read idempotently for the current administrator only',async()=>{
    await orderEvent();await lineEvent();const id=(await notices()).value.data.items[0].id;
    for(let i=0;i<2;i++){const response=await request(`/api/admin/notifications/${id}/read`,{});expect(response.status).toBe(200);expect(response.value.data.total_unread).toBe(1);}
    expect((await notices()).value.data.counts).toEqual({orders:1,companies:0});
    expect((await notices(other)).value.data.total_unread).toBe(2);
    expect(db.sqlite.prepare('SELECT COUNT(*) count FROM admin_notification_reads').get()).toMatchObject({count:1});
  });
  it('does not let a read request select a different administrator through its payload',async()=>{
    await orderEvent();const id=(await notices()).value.data.items[0].id;
    expect((await request(`/api/admin/notifications/${id}/read`,{admin_id:other.id})).status).toBe(200);
    expect((await notices()).value.data.total_unread).toBe(0);
    expect((await notices(other)).value.data.total_unread).toBe(1);
    const receipts=db.sqlite.prepare('SELECT admin_id FROM admin_notification_reads').all();
    expect(receipts).toEqual([{admin_id:owner.id}]);
  });
  it('rejects a nonexistent event without altering any read receipt',async()=>{
    await orderEvent();expect((await request('/api/admin/notifications/unknown/read',{})).status).toBe(404);expect((await notices()).value.data.total_unread).toBe(1);
  });
  it('marks all current events read only for the acting administrator and leaves later arrivals unread',async()=>{
    for(let i=0;i<7;i++)await orderEvent(i);
    const response=await request('/api/admin/notifications/read-all',{});expect(response.value.data.total_unread).toBe(0);expect(response.value.data.items.every((event:any)=>event.is_read)).toBe(true);
    expect((await notices(other)).value.data.total_unread).toBe(7);
    await lineEvent();expect((await notices()).value.data).toMatchObject({total_unread:1,counts:{orders:0,companies:1}});
  });
  it('deduplicates the same LINE webhook event without changing the existing notification',async()=>{
    await lineEvent();const first=(await notices()).value.data.items[0];await lineEvent();
    const response=(await notices()).value.data;expect(response.total_unread).toBe(1);expect(response.items).toEqual([first]);
  });
  it('requires the exact persisted incoming message before creating its notification',async()=>{
    const event={event_key:'persisted-message-event',company_id:'a',line_user_id:'member-a',company_name:'A商店',persisted_message_id:'incoming-persisted'};
    await lineMessageNotificationStatement(env.DB,event).run();
    expect((await notices()).value.data.total_unread).toBe(0);
    db.sqlite.prepare("INSERT INTO line_messages(id,company_id,line_user_id,direction,message_type,text,status,created_at) VALUES('incoming-persisted','a','member-a','incoming','text','本文は通知へ複製しません','received','2026-10-22T01:00:00.000Z')").run();
    await lineMessageNotificationStatement(env.DB,{...event,line_user_id:'member-a2'}).run();
    expect((await notices()).value.data.total_unread).toBe(0);
    db.sqlite.prepare("UPDATE line_messages SET direction='outgoing',status='pending',request_id=? WHERE id='incoming-persisted'").run(crypto.randomUUID());
    await lineMessageNotificationStatement(env.DB,event).run();
    expect((await notices()).value.data.total_unread).toBe(0);
    db.sqlite.prepare("UPDATE line_messages SET direction='incoming',status='received' WHERE id='incoming-persisted'").run();
    await lineMessageNotificationStatement(env.DB,event).run();
    const result=(await notices()).value.data;
    expect(result.total_unread).toBe(1);expect(JSON.stringify(result)).not.toContain('本文は通知へ複製しません');
    db.sqlite.prepare("UPDATE line_messages SET message_type='unsent',text='送信が取り消されました' WHERE id='incoming-persisted'").run();
    await lineMessageNotificationStatement(env.DB,{...event,event_key:'unsent-message-event'}).run();
    expect((await notices()).value.data.total_unread).toBe(1);
  });
  it('limits conversation receipts to the exact company and member for the acting administrator',async()=>{
    await lineEvent('a');await lineEvent('a2','a','member-a2');await lineEvent('b','b','member-b');await orderEvent();
    await readLineConversationNotifications(env.DB,owner.id,'a','member-a');
    expect((await notices()).value.data).toMatchObject({total_unread:3,counts:{orders:1,companies:2}});expect((await notices(other)).value.data.total_unread).toBe(4);
  });
  it('keeps a newer unseen message unread when a visible conversation snapshot is acknowledged',async()=>{
    await lineEvent('line-visible');await lineEvent('line-new-after-get');
    await readLineConversationNotifications(env.DB,owner.id,'a','member-a',['line-visible']);
    expect((await notices()).value.data.total_unread).toBe(1);
    const read=db.sqlite.prepare('SELECT n.event_key FROM admin_notification_reads r JOIN admin_notifications n ON n.id=r.notification_id WHERE r.admin_id=?').all(owner.id);
    expect(read).toEqual([{event_key:'line-visible'}]);
    await readLineConversationNotifications(env.DB,owner.id,'a','member-a',[]);expect((await notices()).value.data.total_unread).toBe(1);
  });
  it('does not expose an arbitrary external link from event text',async()=>{
    const current=order('O-LINK?next=https://example.invalid');
    await adminNotificationStatement(env.DB,{event_key:'link-test',kind:'order_created',company_id:'a',order_id:current.id,title:'https://example.invalid/steal'}).run();
    const href=(await notices()).value.data.items[0].href;expect(href).toBe('/admin/orders/O-LINK%3Fnext%3Dhttps%3A%2F%2Fexample.invalid');expect(href.startsWith('/admin/orders/')).toBe(true);
  });
  it('creates, edits and cancels orders with one durable event each and no event on an idempotent create retry',async()=>{
    const input={company_id:'a',shipping_address_id:'notice-address',items:[{product_id:'notice-product',quantity:1}]};
    const quoted=await request('/api/admin/orders/quote',input);expect(quoted.status,JSON.stringify(quoted.value)).toBe(200);
    const payload={...input,desired_delivery_date:quoted.value.data.delivery_dates.at(-1),request_id:crypto.randomUUID()};
    const created=await request('/api/admin/orders',payload);expect(created.status,JSON.stringify(created.value)).toBe(201);
    const id=created.value.data.id;
    const duplicate=await request('/api/admin/orders',payload);expect(duplicate.status).toBe(200);expect(duplicate.value.data.id).toBe(id);expect((await notices()).value.data.total_unread).toBe(1);
    const lock=await request(`/api/admin/orders/${id}/lock`,{});expect(lock.status).toBe(200);
    const edited=await request(`/api/admin/orders/${id}`,{...payload,version:1,items:[{product_id:'notice-product',quantity:2}]},owner,'PUT');expect(edited.status,JSON.stringify(edited.value)).toBe(200);
    const cancelled=await request(`/api/admin/orders/${id}/cancel`,{version:2,reason:'通知テスト終了'});expect(cancelled.status,JSON.stringify(cancelled.value)).toBe(200);
    const events=(await notices()).value.data;expect(events.total_unread).toBe(3);expect(events.counts).toEqual({orders:3,companies:0});expect(events.items.map((event:any)=>event.kind).sort()).toEqual(['order_cancelled','order_created','order_updated']);
    const again=await request(`/api/admin/orders/${id}/cancel`,{version:3,reason:'再送'});expect(again.status).toBe(409);expect((await notices()).value.data.total_unread).toBe(3);
  });
  it('rolls order creation back when its durable notification cannot be saved',async()=>{
    const input={company_id:'a',shipping_address_id:'notice-address',items:[{product_id:'notice-product',quantity:1}]};
    const quoted=await request('/api/admin/orders/quote',input);
    db.sqlite.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON admin_notifications BEGIN SELECT RAISE(ABORT,'test notification unavailable'); END;");
    const result=await request('/api/admin/orders',{...input,desired_delivery_date:quoted.value.data.delivery_dates.at(-1),request_id:crypto.randomUUID()});expect(result.status).toBe(500);
    expect(db.sqlite.prepare('SELECT COUNT(*) count FROM orders').get()).toMatchObject({count:0});expect(db.sqlite.prepare('SELECT COUNT(*) count FROM order_requests').get()).toMatchObject({count:0});
  });
});
