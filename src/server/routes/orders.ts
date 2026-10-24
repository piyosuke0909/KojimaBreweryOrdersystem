import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import { notifyOrder } from '../notifications';
import { actor, assertChanges, atomic, audit, body, fail, integer, now, one, paginated, rows, update } from '../services/common';
import { cancelOrder, createOrder, editOrder, findOrder, lockOrder, orderDetail, quote } from '../services/orders';
import { normalizeOrderStatus, orderStatusValues } from '../../shared/order-status';
import { quoteConsent } from '../services/quote-consent';

export function orderRoutes(router:Hono<AppEnv>,admin:boolean) {
  router.get('/orders',async c=>{
    const filters=['1=1'],args:any[]=[];
    if(!admin) {filters.push('o.company_id=?');args.push(actor(c).company_id);}
    else if(c.req.query('company_id')) {filters.push('o.company_id=?');args.push(c.req.query('company_id'));}
    if(c.req.query('status')) {const values=orderStatusValues(c.req.query('status')!);filters.push(`o.status IN (${values.map(()=>'?').join(',')})`);args.push(...values);}
    if(admin && ['0','1'].includes(c.req.query('is_invoice_locked')||'')) {filters.push('o.is_invoice_locked=?');args.push(Number(c.req.query('is_invoice_locked')));}
    if(c.req.query('q')) {filters.push('(o.id LIKE ? OR co.name LIKE ?)');args.push(`%${c.req.query('q')}%`,`%${c.req.query('q')}%`);}
    for(const [q,op] of [['from','>='],['to','<=']]) if(c.req.query(q)) {filters.push(`o.desired_delivery_date${op}?`);args.push(c.req.query(q));}
    const response=await paginated(c,'orders o JOIN companies co ON co.id=o.company_id',filters.join(' AND '),args,'o.ordered_at DESC','o.*,co.name AS company_name');
    const result=await response.json() as {data:Record<string,any>[];meta:Record<string,any>};
    return c.json({...result,data:result.data.map(order=>{const {request_hash:_requestHash,...safe}=order;return {...safe,status:normalizeOrderStatus(order.status)};})});
  });
  router.get('/order-requests/:requestId',async c=>{
    const requestId=c.req.param('requestId');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))fail(400,'INVALID_REQUEST_ID','リクエストIDはUUIDで指定してください。');
    const who=actor(c),order=await one(c.env.DB,`SELECT * FROM orders WHERE request_id=?${admin?'':' AND company_id=?'}`,requestId,...(admin?[]:[who.company_id]));
    return c.json({data:{processed:!!order,order:order?await orderDetail(c,order):null}});
  });
  router.post('/orders',async c=>{
    const result=await createOrder(c,await body(c));
    if(result.created) c.executionCtx.waitUntil(notifyOrder(c.env,actor(c),result.order,'create'));
    return c.json({data:result.order},result.created?201:200);
  });
  router.post('/quote',async c=>{
    const input=await body(c),old=input.order_id?await findOrder(c,input.order_id):undefined;
    const companyId=admin ? old?.company_id || input.company_id : actor(c).company_id;
    if(!companyId) fail(400,'INVALID_INPUT','取引先を指定してください。');
    const result=await quote(c,input,companyId,old);
    const {config,company,...safe}=result;
    return c.json({data:{...safe,...await quoteConsent(c,input,companyId,result,old)}});
  });
  if(admin) router.post('/orders/quote',async c=>{
    const input=await body(c),old=input.order_id?await findOrder(c,input.order_id):undefined;
    const result=await quote(c,input,old?.company_id || input.company_id,old);
    const {config,company,...safe}=result;return c.json({data:{...safe,...await quoteConsent(c,input,old?.company_id || input.company_id,result,old)}});
  });
  router.get('/orders/:id',async c=>c.json({data:await orderDetail(c,await findOrder(c,c.req.param('id')))}));
  router.post('/orders/:id/lock',async c=>c.json({data:await lockOrder(c,await findOrder(c,c.req.param('id')))}));
  router.delete('/orders/:id/lock',async c=>{
    const order=await findOrder(c,c.req.param('id'));
    const force=admin && c.req.query('force')==='true';
    const statement=update(c.env.DB,'orders',{edit_lock_status:'unlocked',edit_locked_by:null,edit_locked_at:null,edit_lock_expires_at:null},`id=?${force?'':' AND edit_locked_by=?'}`,order.id,...(force?[]:[actor(c).id]));
    if(force) await atomic(c.env.DB,[statement,audit(c.env.DB,actor(c),'ORDER_FORCE_UNLOCK','orders',order.id,{edit_locked_by:order.edit_locked_by},{edit_locked_by:null},order.company_id)]);
    else await statement.run();
    return c.json({data:{unlocked:force || !order.edit_locked_by || order.edit_locked_by===actor(c).id}});
  });
  router.put('/orders/:id',async c=>{
    const result=await editOrder(c,await findOrder(c,c.req.param('id')),await body(c));
    c.executionCtx.waitUntil(notifyOrder(c.env,actor(c),result,'edit'));
    return c.json({data:result});
  });
  router.post('/orders/:id/cancel',async c=>{
    const result=await cancelOrder(c,await findOrder(c,c.req.param('id')),await body(c));
    c.executionCtx.waitUntil(notifyOrder(c.env,actor(c),result,'cancel'));
    return c.json({data:result});
  });
  if(admin) {
    router.post('/orders/:id/status',async c=>{
      const order=await findOrder(c,c.req.param('id')),input=await body(c),version=integer(input.version,'バージョン',1);
      const previous=normalizeOrderStatus(order.status);
      if(!['received','shipped'].includes(input.status) || !['received','shipped'].includes(previous) || input.status===previous) fail(409,'INVALID_TRANSITION','受付済みと発送済みの間だけ変更できます。キャンセルは取消操作から行ってください。');
      if(order.version!==version)fail(409,'VERSION_CONFLICT','別の操作で更新されています。再読み込みしてください。');
      const stamp=now();
      await atomic(c.env.DB,[update(c.env.DB,'orders',{status:input.status,version:version+1,updated_at:stamp,edit_lock_status:'unlocked',edit_locked_by:null,edit_locked_at:null,edit_lock_expires_at:null},'id=? AND version=? AND status=? AND (edit_locked_by IS NULL OR edit_locked_by=? OR edit_lock_expires_at<=?)',order.id,version,order.status,actor(c).id,stamp),assertChanges(c.env.DB,1,actor(c),'ORDER_STATUS_CHANGE','orders',order.id,order,{status:input.status},order.company_id)]);
      return c.json({data:await orderDetail(c,await findOrder(c,order.id))});
    });
    router.get('/orders/:id/delivery-note',async c=>{
      const order=await orderDetail(c,await findOrder(c,c.req.param('id')));
      const [issuer,report]=await Promise.all([one(c.env.DB,'SELECT * FROM company_info WHERE id=1'),one(c.env.DB,'SELECT * FROM report_settings WHERE id=1')]);
      return c.json({data:{kind:'delivery-note',order,items:order.items,issuer,report_settings:report}});
    });
  }
}
