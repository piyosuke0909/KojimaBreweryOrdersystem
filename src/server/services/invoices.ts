import { computePricing, jstDate } from '../../domain';
import { actor, assertChanges, atomic, audit, date, fail, insert, insertMany, now, one, rows, settings, string, uid, update, type Row } from './common';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

export async function findInvoice(c:Context<AppEnv>,id:string) {
  const invoice=await one(c.env.DB,'SELECT i.*,c.name AS company_name FROM invoices i JOIN companies c ON c.id=i.company_id WHERE i.id=?',id);
  if(!invoice) fail(404,'NOT_FOUND','請求書が見つかりません。');
  return invoice!;
}
export async function invoiceDetail(c:Context<AppEnv>,invoice:Row) {
  const [items,history]=await Promise.all([rows(c.env.DB,'SELECT ii.*,o.snap_recipient_name,o.desired_delivery_date,o.status AS order_status FROM invoice_items ii JOIN orders o ON o.id=ii.order_id WHERE ii.invoice_id=? ORDER BY line_no',invoice.id),rows(c.env.DB,'SELECT * FROM invoice_histories WHERE invoice_id=? ORDER BY version DESC,acted_at DESC',invoice.id)]);
  const latest=history.find(h=>h.action_type!=='cancel');
  return {...invoice,items,history,histories:history,snapshot:latest?JSON.parse(latest.snapshot_json):null};
}
export async function issueInvoice(c:Context<AppEnv>,input:Row,previous?:Row) {
  if(previous && previous.status!=='cancelled') fail(409,'INVOICE_NOT_CANCELLED','再発行するには先に請求を取り消してください。');
  const companyId=previous?.company_id || string(input.company_id,'取引先');
  const start=date(input.period_start || previous?.period_start,'対象期間開始'), end=date(input.period_end || previous?.period_end,'対象期間終了');
  if(start>end) fail(400,'INVALID_PERIOD','対象期間が不正です。');
  const company=await one(c.env.DB,"SELECT * FROM companies WHERE id=? AND status='active'",companyId);
  if(!company) fail(404,'NOT_FOUND','有効な取引先が見つかりません。');
  let orderIds:string[]|undefined=input.order_ids;
  if(orderIds && (!Array.isArray(orderIds) || orderIds.length<1 || orderIds.length>500 || orderIds.some(id=>typeof id!=='string') || new Set(orderIds).size!==orderIds.length)) fail(400,'INVALID_INPUT','請求対象の注文を正しく指定してください。');
  if(previous && !orderIds) orderIds=(await rows(c.env.DB,'SELECT order_id FROM invoice_items WHERE invoice_id=?',previous.id)).map(i=>i.order_id);
  const query=`SELECT * FROM orders WHERE company_id=? AND desired_delivery_date>=? AND desired_delivery_date<=? AND status!='cancelled' AND is_invoice_locked=0${orderIds?' AND id IN (SELECT value FROM json_each(?))':''} ORDER BY desired_delivery_date,id`;
  const orders=await rows(c.env.DB,query,companyId,start,end,...(orderIds?[JSON.stringify(orderIds)]:[]));
  if(!orders.length || (orderIds && orderIds.length!==orders.length)) fail(422,'INVALID_INVOICE_ORDERS','対象期間内の未請求注文を選択してください。キャンセル済み・請求済みの注文は含められません。');
  const [config,issuer,report,contract]=await Promise.all([settings(c.env.DB),one(c.env.DB,'SELECT * FROM company_info WHERE id=1'),one(c.env.DB,'SELECT * FROM report_settings WHERE id=1'),one(c.env.DB,"SELECT * FROM contracts WHERE company_id=? AND status='active' ORDER BY start_date DESC LIMIT 1",companyId)]);
  const details=await rows(c.env.DB,'SELECT * FROM order_items WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY order_id,line_no',JSON.stringify(orders.map(o=>o.id)));
  const subtotal=orders.reduce((sum,o)=>sum+o.items_subtotal+o.shipping_fee,0);
  // Invoice-level rounding is applied once to each tax rate; order/item modes preserve their recorded tax.
  let tax=0;
  if(config.tax_calc_unit==='invoice') {
    const groups=new Map<number,Row[]>();
    for(const order of orders) groups.set(order.snap_tax_rate,[...(groups.get(order.snap_tax_rate)||[]),order]);
    for(const [rate,group] of groups) {
      const ids=new Set(group.map(o=>o.id));
      const lines=details.filter(d=>ids.has(d.order_id));
      tax+=computePricing(lines.map(l=>({unit_price:Number(l.unit_price),quantity:Number(l.quantity)})),{...config,tax_rate:rate,tax_calc_unit:'invoice',shipping_fee:group.reduce((s,o)=>s+o.shipping_fee,0)} as any).tax_amount;
    }
  } else tax=orders.reduce((sum,o)=>sum+o.tax_amount,0);
  const stamp=now(),today=jstDate(new Date()),id=previous?.id || `INV${today.replaceAll('-','').slice(0,6)}${uid().replaceAll('-','').slice(0,8).toUpperCase()}`,version=previous?previous.latest_version+1:1;
  const dueDate=input.due_date ? date(input.due_date,'支払期日') : previous?.due_date || null;
  const invoice={id,company_id:companyId,contract_id:contract?.id||null,period_start:start,period_end:end,subtotal_excl_tax:subtotal,tax_amount:tax,total_incl_tax:subtotal+tax,issued_date:today,due_date:dueDate,status:'issued',latest_version:version,snap_company_info_json:JSON.stringify(issuer||{}),note:input.note ? string(input.note,'備考',false,4000) : previous?.note||null};
  const snapshot={kind:'invoice',version,invoice,issuer:issuer||{},company,contract,report_settings:report||{},tax_settings:config,orders:orders.map(o=>({...o,items:details.filter(d=>d.order_id===o.id)})),items:details,subtotal_excl_tax:subtotal,tax_amount:tax,total_incl_tax:subtotal+tax,issued_at:stamp,issued_by:actor(c).name};
  const statements:D1PreparedStatement[]=[];
  if(previous) {
    statements.push(update(c.env.DB,'invoices',invoice,"id=? AND status='cancelled' AND latest_version=?",id,previous.latest_version),assertChanges(c.env.DB,1,actor(c),'INVOICE_REISSUE','invoices',id,previous,invoice,companyId),c.env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id=?').bind(id));
  } else statements.push(insert(c.env.DB,'invoices',invoice));
  const versions=JSON.stringify(orders.map(o=>({id:o.id,version:o.version})));
  statements.push(c.env.DB.prepare("UPDATE orders SET is_invoice_locked=1,version=version+1,updated_at=?,edit_locked_by=NULL,edit_locked_at=NULL,edit_lock_expires_at=NULL,edit_lock_status='unlocked' WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND version=(SELECT json_extract(value,'$.version') FROM json_each(?) WHERE json_extract(value,'$.id')=orders.id) AND is_invoice_locked=0 AND status!='cancelled' AND (edit_locked_by IS NULL OR edit_lock_expires_at<=?)").bind(stamp,versions,versions,stamp),assertChanges(c.env.DB,orders.length,actor(c),'INVOICE_ORDER_LOCK','invoices',id,null,{order_ids:orders.map(o=>o.id),is_invoice_locked:1},companyId));
  statements.push(...insertMany(c.env.DB,'invoice_items',orders.map((o,index)=>({id:uid(),invoice_id:id,line_no:index+1,order_id:o.id,order_date:jstDate(o.ordered_at),delivery_date:o.desired_delivery_date,amount_excl_tax:o.items_subtotal+o.shipping_fee,tax_amount:o.tax_amount,amount_incl_tax:o.total_amount}))));
  statements.push(insert(c.env.DB,'invoice_histories',{id:uid(),invoice_id:id,version,action_type:previous?'reissue':'issue',acted_at:stamp,acted_by:actor(c).id,snapshot_json:JSON.stringify(snapshot),note:invoice.note}),audit(c.env.DB,actor(c),previous?'INVOICE_REISSUE':'INVOICE_ISSUE','invoices',id,previous||null,invoice,companyId));
  await atomic(c.env.DB,statements);
  return invoiceDetail(c,invoice);
}
export async function cancelInvoice(c:Context<AppEnv>,invoice:Row,input:Row) {
  if(invoice.status!=='issued') fail(409,'INVOICE_NOT_CANCELLABLE','発行済みの請求書のみ取り消せます。');
  const reason=string(input.reason,'取消理由',true,2000),stamp=now();
  const latest=await one(c.env.DB,"SELECT * FROM invoice_histories WHERE invoice_id=? AND version=? AND action_type IN ('issue','reissue')",invoice.id,invoice.latest_version);
  if(!latest) fail(409,'SNAPSHOT_MISSING','発行履歴が見つかりません。');
  await atomic(c.env.DB,[update(c.env.DB,'invoices',{status:'cancelled'},"id=? AND status='issued' AND latest_version=?",invoice.id,invoice.latest_version),assertChanges(c.env.DB,1,actor(c),'INVOICE_CANCEL','invoices',invoice.id,invoice,{status:'cancelled',reason},invoice.company_id),c.env.DB.prepare('UPDATE orders SET is_invoice_locked=0,version=version+1,updated_at=? WHERE id IN (SELECT order_id FROM invoice_items WHERE invoice_id=?)').bind(stamp,invoice.id),insert(c.env.DB,'invoice_histories',{id:uid(),invoice_id:invoice.id,version:invoice.latest_version,action_type:'cancel',acted_at:stamp,acted_by:actor(c).id,snapshot_json:latest!.snapshot_json,cancelled_at:stamp,cancelled_by:actor(c).id,cancel_reason:reason})]);
  return invoiceDetail(c,await findInvoice(c,invoice.id));
}
