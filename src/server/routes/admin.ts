import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { jstDate } from '../../domain';
import { actor, assertChanges, atomic, audit, body, date, fail, insert, integer, now, one, paginated, routerError, rows, settings, string, uid, update, type Row } from '../services/common';
import { masterRoutes, saveMaster, softDeleteMaster } from '../services/masters';
import { invitationTokenKey, issueInvitation, publicInvitation, restoreInvitationQr, savedInvitationQr } from '../services/invitations';
import { assertInvoiceConfirmation, cancelInvoice, findInvoice, invoiceDetail, issueInvoice, publicInvoiceHistory } from '../services/invoices';
import { orderRoutes } from './orders';
import { deliveryDates } from '../services/orders';
import { lineRichMenuRoutes } from './line-rich-menu';
import { lineNotificationDiagnosticRoutes } from './line-notification-diagnostics';
import { productImagePreviewRoutes } from './product-image-preview';
import { normalizeOrderStatus } from '../../shared/order-status';

export const adminRoutes=new Hono<AppEnv>();
adminRoutes.onError(routerError);
adminRoutes.route('/line/rich-menu',lineRichMenuRoutes);
adminRoutes.route('/line/notification-diagnostics',lineNotificationDiagnosticRoutes);
adminRoutes.route('/product-image-preview',productImagePreviewRoutes);
adminRoutes.get('/me',c=>c.json({data:{type:'admin',admin:actor(c)}}));
adminRoutes.get('/dashboard',async c=>{
  const today=jstDate(new Date()),yesterday=jstDate(new Date(Date.now()-86400000));
  const [counts,recent]=await Promise.all([
    one(c.env.DB,`SELECT SUM(CASE WHEN date(ordered_at,'+9 hours')=? THEN 1 ELSE 0 END) AS new_orders,SUM(CASE WHEN status IN ('received','confirmed','preparing') THEN 1 ELSE 0 END) AS pending_confirmation,SUM(CASE WHEN desired_delivery_date=? AND status!='cancelled' THEN 1 ELSE 0 END) AS arriving_today,SUM(CASE WHEN status IN ('shipped','completed') THEN 1 ELSE 0 END) AS shipped,SUM(CASE WHEN date(ordered_at,'+9 hours')=? THEN 1 ELSE 0 END) AS yesterday_new_orders FROM orders`,today,today,yesterday),
    rows(c.env.DB,'SELECT o.*,c.name AS company_name,(SELECT count(*) FROM order_items i WHERE i.order_id=o.id) AS item_count FROM orders o JOIN companies c ON c.id=o.company_id ORDER BY ordered_at DESC LIMIT 5')
  ]);
  return c.json({data:{...Object.fromEntries(Object.entries(counts||{}).map(([k,v])=>[k,Number(v||0)])),recent_orders:recent.map(order=>({...order,status:normalizeOrderStatus(order.status)}))}});
});
masterRoutes(adminRoutes);
orderRoutes(adminRoutes,true);

function publicLineUser(user:Row){const {registration_handoff_hash:_receipt,session_version:_version,...safe}=user;return safe;}
async function companyExists(c:any) {
  const company=await one(c.env.DB,'SELECT * FROM companies WHERE id=? AND deleted_at IS NULL',c.req.param('id'));
  if(!company) fail(404,'NOT_FOUND','取引先が見つかりません。');
  return company!;
}
adminRoutes.get('/companies/:id',async c=>{
  const company=await companyExists(c),id=company.id;
  const [addresses,prices,contracts,invitations,users]=await Promise.all([
    rows(c.env.DB,'SELECT * FROM shipping_addresses WHERE company_id=? AND deleted_at IS NULL ORDER BY is_default DESC,name',id),
    rows(c.env.DB,'SELECT cp.*,p.name AS product_name,p.volume_ml FROM company_product_prices cp JOIN products p ON p.id=cp.product_id WHERE company_id=? AND cp.deleted_at IS NULL ORDER BY cp.valid_from DESC',id),
    rows(c.env.DB,'SELECT * FROM contracts WHERE company_id=? AND deleted_at IS NULL ORDER BY start_date DESC',id),
    rows(c.env.DB,'SELECT * FROM invitations WHERE company_id=? AND deleted_at IS NULL ORDER BY created_at DESC',id),
    rows(c.env.DB,'SELECT * FROM line_users WHERE company_id=? ORDER BY registered_at DESC',id)
  ]);
  return c.json({data:{...company,addresses,prices,contracts,invitations:invitations.map(row=>publicInvitation({...row,company_status:company.status})),line_users:users.map(publicLineUser)}});
});
for(const [resource,table] of [['addresses','shipping_addresses'],['contracts','contracts']] as const) {
  adminRoutes.get(`/companies/:id/${resource}`,async c=>{await companyExists(c);return c.json({data:await rows(c.env.DB,`SELECT * FROM ${table} WHERE company_id=? AND deleted_at IS NULL`,c.req.param('id'))});});
  adminRoutes.post(`/companies/:id/${resource}`,async c=>{await companyExists(c);return c.json({data:await saveMaster(c,table,await body(c),undefined,c.req.param('id'))},201);});
  adminRoutes.put(`/companies/:id/${resource}/:childId`,async c=>{await companyExists(c);return c.json({data:await saveMaster(c,table,await body(c),c.req.param('childId'),c.req.param('id'))});});
  adminRoutes.delete(`/companies/:id/${resource}/:childId`,async c=>{await companyExists(c);return c.json({data:await softDeleteMaster(c,table,c.req.param('childId'),c.req.param('id'))});});
}
adminRoutes.get('/companies/:id/delivery-dates',async c=>{
  await companyExists(c);const addressId=string(c.req.query('shipping_address_id'),'配送先');
  const result=await deliveryDates(c.env.DB,c.req.param('id'),addressId);return c.json({data:result.dates});
});
adminRoutes.get('/companies/:id/prices',async c=>{await companyExists(c);return c.json({data:await rows(c.env.DB,'SELECT cp.*,p.name AS product_name FROM company_product_prices cp JOIN products p ON p.id=cp.product_id WHERE cp.company_id=? AND cp.deleted_at IS NULL ORDER BY valid_from DESC',c.req.param('id'))});});
async function savePrices(c:any,input:Row) {
  const company=await companyExists(c),today=jstDate(new Date());
  const priceRows=Array.isArray(input.prices)?input.prices:[input];
  if(priceRows.length<1 || priceRows.length>100) fail(400,'INVALID_INPUT','単価を1〜100件指定してください。');
  const statements:D1PreparedStatement[]=[], saved:Row[]=[];
  const seen=new Set<string>();
  for(const row of priceRows) {
    const productId=string(row.product_id,'商品');
    if(seen.has(productId)) fail(400,'INVALID_INPUT','同じ商品が重複しています。');seen.add(productId);
    if(!await one(c.env.DB,'SELECT id FROM products WHERE id=? AND deleted_at IS NULL',productId)) fail(404,'NOT_FOUND','商品が見つかりません。');
    const validFrom=date(row.valid_from||input.valid_from||today,'適用開始日');
    const validTo=row.valid_to?date(row.valid_to,'適用終了日'):null;
    if(validTo && validTo<validFrom) fail(400,'INVALID_INPUT','適用期間が不正です。');
    const available=typeof row.is_available==='boolean'?(row.is_available?1:0):row.is_available??1;
    const reset=row.unit_price===null && available===1;
    const product=await one(c.env.DB,'SELECT standard_price FROM products WHERE id=? AND deleted_at IS NULL',productId);
    const data={id:uid(),company_id:company.id,product_id:productId,unit_price:reset?null:integer(row.unit_price??product?.standard_price??0,'販売単価',0,10000000),tax_type:'excl',is_available:integer(available,'取扱可否',0,1),valid_from:validFrom,valid_to:validTo,status:'active',note:row.note||input.note||null};
    const old=await rows(c.env.DB,"SELECT * FROM company_product_prices WHERE company_id=? AND product_id=? AND status='active' AND deleted_at IS NULL",company.id,productId);
    // Keep earlier intervals usable when a future price is scheduled. Same-day replacements remain archived history.
    const previousDay=new Date(new Date(validFrom+'T00:00:00Z').getTime()-86400000).toISOString().slice(0,10);
    statements.push(c.env.DB.prepare("UPDATE company_product_prices SET status='archived' WHERE company_id=? AND product_id=? AND status='active' AND deleted_at IS NULL AND valid_from>=?").bind(company.id,productId,validFrom));
    statements.push(c.env.DB.prepare("UPDATE company_product_prices SET valid_to=? WHERE company_id=? AND product_id=? AND status='active' AND deleted_at IS NULL AND valid_from<? AND (valid_to IS NULL OR valid_to>=?)").bind(previousDay,company.id,productId,validFrom,validFrom));
    if(!reset) statements.push(insert(c.env.DB,'company_product_prices',data));
    statements.push(audit(c.env.DB,actor(c),'COMPANY_PRICE_UPDATE','company_product_prices',data.id,old,{...data,reset_to_standard:reset},company.id));saved.push({...data,reset_to_standard:reset});
  }
  await atomic(c.env.DB,statements);return saved;
}
adminRoutes.post('/companies/:id/prices',async c=>{const data=await savePrices(c,await body(c));return c.json({data:data[0]},201);});
adminRoutes.put('/companies/:id/prices',async c=>c.json({data:await savePrices(c,await body(c))}));
adminRoutes.put('/companies/:id/prices/:childId',async c=>{
  await companyExists(c);const before=await one(c.env.DB,'SELECT * FROM company_product_prices WHERE id=? AND company_id=? AND deleted_at IS NULL',c.req.param('childId'),c.req.param('id'));
  if(!before)fail(404,'NOT_FOUND','販売単価が見つかりません。');
  const input=await body(c),data:Row={};
  if(input.product_id!==undefined&&input.product_id!==before!.product_id)fail(400,'INVALID_INPUT','商品の変更は新しい販売単価として登録してください。');
  if(input.unit_price!==undefined)data.unit_price=integer(input.unit_price,'販売単価',0,10000000);
  if(input.is_available!==undefined)data.is_available=integer(typeof input.is_available==='boolean'?(input.is_available?1:0):input.is_available,'取扱可否',0,1);
  if(input.valid_from!==undefined)data.valid_from=date(input.valid_from,'適用開始日');
  if(input.valid_to!==undefined)data.valid_to=input.valid_to?date(input.valid_to,'適用終了日'):null;
  if(input.note!==undefined)data.note=input.note===null?null:string(input.note,'備考',false,2000);
  const merged={...before,...data};
  if(merged.valid_to&&merged.valid_to<merged.valid_from)fail(400,'INVALID_INPUT','適用期間が不正です。');
  if(!Object.keys(data).length)fail(400,'INVALID_INPUT','変更する項目を指定してください。');
  if(merged.status==='active'&&await one(c.env.DB,"SELECT id FROM company_product_prices WHERE company_id=? AND product_id=? AND id!=? AND deleted_at IS NULL AND status='active' AND (valid_to IS NULL OR valid_to>=?) AND (? IS NULL OR valid_from<=?)",merged.company_id,merged.product_id,before!.id,merged.valid_from,merged.valid_to,merged.valid_to))fail(409,'PRICE_OVERLAP','他の販売単価と適用期間が重なっています。');
  await atomic(c.env.DB,[update(c.env.DB,'company_product_prices',data,'id=? AND company_id=? AND deleted_at IS NULL',before!.id,before!.company_id),audit(c.env.DB,actor(c),'COMPANY_PRICE_EDIT','company_product_prices',before!.id,before,merged,before!.company_id)]);
  return c.json({data:merged});
});
for(const [resource,table]of [['prices','company_product_prices'],['invitations','invitations']]as const)adminRoutes.delete(`/companies/:id/${resource}/:childId`,async c=>{
  await companyExists(c);return c.json({data:await softDeleteMaster(c,table,c.req.param('childId'),c.req.param('id'))});
});
adminRoutes.get('/companies/:id/invitations',async c=>{const company=await companyExists(c);return c.json({data:(await rows(c.env.DB,'SELECT * FROM invitations WHERE company_id=? AND deleted_at IS NULL ORDER BY created_at DESC',c.req.param('id'))).map(row=>publicInvitation({...row,company_status:company.status}))});});
adminRoutes.post('/companies/:id/invitations',async c=>{const company=await companyExists(c);if(company.status!=='active')fail(409,'COMPANY_INACTIVE','無効な取引先の招待は作成できません。');c.header('Cache-Control','no-store');return c.json({data:await issueInvitation(c.env.DB,actor(c),company.id,await body(c),new URL(c.req.url).origin,c.env.LIFF_ID,invitationTokenKey(c.env))},201);});
adminRoutes.get('/companies/:id/invitations/:childId/qr',async c=>{
  await companyExists(c);c.header('Cache-Control','no-store');
  return c.json({data:await savedInvitationQr(c.env.DB,c.req.param('id'),c.req.param('childId'),new URL(c.req.url).origin,c.env.LIFF_ID,invitationTokenKey(c.env))});
});
adminRoutes.put('/companies/:id/invitations/:childId/qr',async c=>{
  const who=actor(c);
  if(who?.role!=='owner')fail(403,'OWNER_REQUIRED','既存の招待QRの保存はオーナー管理者のみ操作できます。');
  await companyExists(c);c.header('Cache-Control','no-store');
  return c.json({data:await restoreInvitationQr(c.env.DB,who,c.req.param('id'),c.req.param('childId'),await body(c),new URL(c.req.url).origin,c.env.LIFF_ID,invitationTokenKey(c.env))});
});
adminRoutes.put('/companies/:id/invitations/:childId',async c=>{
  const before=await one(c.env.DB,'SELECT * FROM invitations WHERE id=? AND company_id=? AND deleted_at IS NULL',c.req.param('childId'),c.req.param('id'));
  if(!before) fail(404,'NOT_FOUND','招待が見つかりません。');
  const input=await body(c),data:Row={};
  if(input.max_uses!==undefined) data.max_uses=input.max_uses===null?null:integer(input.max_uses,'登録上限',Math.max(1,before!.used_count),10000);
  if(input.expires_at!==undefined) {if(input.expires_at===null||input.expires_at==='')data.expires_at='';else{const expiry=string(input.expires_at,'有効期限',true,40);if(!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry)<=Date.now())fail(400,'INVALID_INPUT','有効期限は未来の日時を指定してください。');data.expires_at=new Date(expiry).toISOString();}}
  if(input.note!==undefined) data.note=input.note===null?null:string(input.note,'備考',false,2000);
  if(!Object.keys(data).length) fail(400,'INVALID_INPUT','変更する項目を指定してください。');
  const safe=publicInvitation(before!),merged=publicInvitation({...before,...data});
  // Registration may consume a slot after the initial read; check the current count atomically.
  const capped=data.max_uses!=null;
  await atomic(c.env.DB,[
    update(c.env.DB,'invitations',data,`id=? AND company_id=? AND deleted_at IS NULL${capped?' AND used_count<=?':''}`,before!.id,before!.company_id,...(capped?[data.max_uses]:[])),
    assertChanges(c.env.DB,1,actor(c),'INVITE_UPDATE','invitations',before!.id,safe,merged,before!.company_id),
  ]);
  return c.json({data:merged});
});
adminRoutes.post('/companies/:id/invitations/:childId/revoke',async c=>{
  const invitation=await one(c.env.DB,'SELECT id,company_id,status FROM invitations WHERE id=? AND company_id=? AND deleted_at IS NULL',c.req.param('childId'),c.req.param('id'));
  if(!invitation) fail(404,'NOT_FOUND','招待が見つかりません。');
  await atomic(c.env.DB,[update(c.env.DB,'invitations',{status:'revoked'},'id=?',invitation!.id),audit(c.env.DB,actor(c),'INVITE_REVOKE','invitations',invitation!.id,invitation,{status:'revoked'},invitation!.company_id)]);
  return c.json({data:{id:invitation!.id,status:'revoked'}});
});
adminRoutes.get('/companies/:id/line-users',async c=>{await companyExists(c);return c.json({data:(await rows(c.env.DB,'SELECT * FROM line_users WHERE company_id=?',c.req.param('id'))).map(publicLineUser)});});
adminRoutes.post('/companies/:id/line-users/:childId/unlink',async c=>{
  const user=await one(c.env.DB,'SELECT * FROM line_users WHERE id=? AND company_id=?',c.req.param('childId'),c.req.param('id'));
  if(!user) fail(404,'NOT_FOUND','LINE利用者が見つかりません。');
  await atomic(c.env.DB,[update(c.env.DB,'line_users',{status:'unlinked',session_version:Number(user!.session_version)+1,registration_handoff_hash:null},'id=? AND company_id=? AND status=? AND session_version=?',user!.id,user!.company_id,user!.status,user!.session_version),assertChanges(c.env.DB,1,actor(c),'LINE_USER_UNLINK','line_users',user!.id,publicLineUser(user!),{status:'unlinked'},user!.company_id)]);
  return c.json({data:publicLineUser({...user,status:'unlinked'})});
});

adminRoutes.get('/invoices',async c=>{
  const conditions=['1=1'],args:any[]=[];
  for(const key of ['status','company_id']) if(c.req.query(key)) {conditions.push(`i.${key}=?`);args.push(c.req.query(key));}
  if(c.req.query('q')) {conditions.push('(i.id LIKE ? OR co.name LIKE ?)');args.push(`%${c.req.query('q')}%`,`%${c.req.query('q')}%`);}
  return paginated(c,'invoices i JOIN companies co ON co.id=i.company_id',conditions.join(' AND '),args,'i.issued_date DESC,i.id DESC','i.*,co.name AS company_name');
});
adminRoutes.post('/invoices',async c=>c.json({data:await issueInvoice(c,await body(c))},201));
adminRoutes.get('/invoices/:id',async c=>c.json({data:await invoiceDetail(c,await findInvoice(c,c.req.param('id')))}));
adminRoutes.post('/invoices/:id/cancel',async c=>c.json({data:await cancelInvoice(c,await findInvoice(c,c.req.param('id')),await body(c))}));
adminRoutes.post('/invoices/:id/reissue',async c=>c.json({data:await issueInvoice(c,await body(c),await findInvoice(c,c.req.param('id')))}));
adminRoutes.post('/invoices/:id/pay',async c=>{
  const invoice=await findInvoice(c,c.req.param('id')),input=await body(c);
  assertInvoiceConfirmation(invoice,input,'issued');
  if(invoice.status!=='issued') fail(409,'INVALID_INVOICE_STATUS','発行済みの請求書のみ入金済みにできます。');
  await atomic(c.env.DB,[update(c.env.DB,'invoices',{status:'paid'},"id=? AND status='issued' AND latest_version=? AND total_incl_tax=?",invoice.id,input.expected_version,input.expected_total),assertChanges(c.env.DB,1,actor(c),'INVOICE_PAID','invoices',invoice.id,invoice,{status:'paid'},invoice.company_id)]);
  return c.json({data:await invoiceDetail(c,await findInvoice(c,invoice.id))});
});
adminRoutes.get('/invoices/:id/history',async c=>{await findInvoice(c,c.req.param('id'));return c.json({data:(await rows(c.env.DB,'SELECT * FROM invoice_histories WHERE invoice_id=? ORDER BY version DESC,acted_at DESC',c.req.param('id'))).map(publicInvoiceHistory)});});
adminRoutes.get('/invoices/:id/history/:historyId',async c=>{
  const history=await one(c.env.DB,'SELECT * FROM invoice_histories WHERE id=? AND invoice_id=?',c.req.param('historyId'),c.req.param('id'));
  if(!history) fail(404,'NOT_FOUND','発行履歴が見つかりません。');
  return c.json({data:{...publicInvoiceHistory(history!),snapshot:JSON.parse(history!.snapshot_json)}});
});

adminRoutes.get('/audit',async c=>{
  const conditions=['1=1'],args:any[]=[];
  for(const key of ['action','company_id','target_type','actor_id']) if(c.req.query(key)) {conditions.push(`${key}=?`);args.push(c.req.query(key));}
  if(c.req.query('q')) {conditions.push('(target_id LIKE ? OR action LIKE ? OR actor_id LIKE ?)');const q=`%${c.req.query('q')}%`;args.push(q,q,q);}
  return paginated(c,'audit_logs',conditions.join(' AND '),args,'acted_at DESC');
});
adminRoutes.get('/settings',async c=>c.json({data:await settings(c.env.DB)}));
adminRoutes.put('/settings',async c=>{
  const before=await settings(c.env.DB),input=await body(c),data:Row={};
  for(const key of Object.keys(input)) {
    if(!(key in before)) fail(400,'UNKNOWN_SETTING',`未対応の設定です: ${key}`);
    const value=String(input[key]);
    if(['tax_rate'].includes(key) && (!/^\d+$/.test(value)||Number(value)>100)) fail(400,'INVALID_INPUT','税率は0〜100の整数で指定してください。');
    const limits:Record<string,[number,number]>={cancel_business_days:[0,365],min_lead_business_days:[0,365],invite_valid_days:[1,3650],invite_default_max_uses:[1,10000],edit_lock_minutes:[1,60],multi_parcel_discount_amount:[0,1000000]};
    if(limits[key] && (!/^\d+$/.test(value)||Number(value)<limits[key]![0]||Number(value)>limits[key]![1])) fail(400,'INVALID_INPUT',`${key}の値が不正です。`);
    if(key==='tax_calc_unit'&&!['invoice','order','item'].includes(value)) fail(400,'INVALID_INPUT','税計算単位が不正です。');
    if(key==='tax_rounding'&&!['floor','ceil','round'].includes(value)) fail(400,'INVALID_INPUT','端数処理が不正です。');
    if(['shipping_taxable','multi_parcel_discount_enabled','packing_enabled','yamato_sizes_enabled','yamato_rates_enabled'].includes(key)&&!['true','false'].includes(value)) fail(400,'INVALID_INPUT','真偽値が不正です。');
    if(key==='manual_shipping_fee'&&value!==''&&(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>1000000)) fail(400,'INVALID_INPUT','固定送料は空欄または0〜1000000円の整数で指定してください。');
    if(key==='price_tax_type'&&value!=='excl') fail(400,'INVALID_INPUT','税抜を指定してください。');
    if(key==='cancel_cutoff_time'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(400,'INVALID_INPUT','締切時刻が不正です。');
    if(value.length>2000) fail(400,'INVALID_INPUT','設定値が長すぎます。');data[key]=value;
  }
  const statements=Object.entries(data).map(([key,value])=>c.env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,value));
  statements.push(audit(c.env.DB,actor(c),'SETTINGS_UPDATE','settings','system',before,{...before,...data}));
  await atomic(c.env.DB,statements);return c.json({data:{...before,...data}});
});
for(const [resource,table] of [['company-info','company_info'],['report-settings','report_settings']] as const) {
  adminRoutes.get(`/${resource}`,async c=>c.json({data:await one(c.env.DB,`SELECT * FROM ${table} WHERE id=1`)}));
  adminRoutes.put(`/${resource}`,async c=>c.json({data:await saveMaster(c,table,await body(c),'1')}));
}
