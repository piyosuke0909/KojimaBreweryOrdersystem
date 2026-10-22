import { calculatePackages, computePricing, getDeliveryDates, getShippingFeatures, canEditOrder, cancellationDeadline, jstDate, type PackagingBox, type YamatoSize, type YamatoRate } from '../../domain';
import { actor, ApiError, assertChanges, atomic, audit, date, fail, insert, insertMany, integer, now, one, rows, settings, string, uid, update, type Row } from './common';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { normalizeOrderStatus } from '../../shared/order-status';
import { orderNotificationStatement } from './admin-notifications';

export async function findOrder(c: Context<AppEnv>, id: string) {
  const who=actor(c);
  const order=await one(c.env.DB,`SELECT o.*,c.name AS company_name FROM orders o JOIN companies c ON c.id=o.company_id WHERE o.id=?${who.type==='customer'?' AND o.company_id=?':''}`,id,...(who.type==='customer'?[who.company_id]:[]));
  if (!order) fail(404,'NOT_FOUND','注文が見つかりません。');
  return order!;
}
export async function orderDetail(c: Context<AppEnv>, order: Row) {
  const [items,packages,revisions,calendar,config]=await Promise.all([
    rows(c.env.DB,'SELECT * FROM order_items WHERE order_id=? ORDER BY line_no',order.id),
    rows(c.env.DB,'SELECT * FROM order_packages WHERE order_id=? ORDER BY package_no',order.id),
    rows(c.env.DB,'SELECT * FROM order_revisions WHERE order_id=? ORDER BY revision_no DESC',order.id),
    rows(c.env.DB,'SELECT * FROM delivery_calendar WHERE deleted_at IS NULL'),settings(c.env.DB)
  ]);
  const lockActive=order.edit_locked_by && order.edit_lock_expires_at > now() && order.edit_locked_by!==actor(c).id;
  let deadline: string|null=null;
  try { deadline=cancellationDeadline(order.desired_delivery_date,calendar as any,config); } catch { /* Invalid historic settings must not prevent reading the order. */ }
  const status=normalizeOrderStatus(order.status);
  let unavailableReason:string|null=null;
  if(status==='shipped')unavailableReason='発送済みの注文は編集・キャンセルできません。';
  else if(status==='cancelled')unavailableReason='キャンセル済みの注文は編集・キャンセルできません。';
  else if(status!=='received')unavailableReason='この注文のステータスでは編集・キャンセルできません。';
  else if(order.is_invoice_locked)unavailableReason='請求書発行済みのため編集・キャンセルできません。';
  else if(lockActive)unavailableReason='現在、別の利用者が編集中です。';
  else if(actor(c).type==='customer') {
    try { if(!canEditOrder(order as any,new Date(),calendar as any,config))unavailableReason='変更・キャンセル期限を過ぎています。'; }
    catch { unavailableReason='期限設定を確認できないため編集・キャンセルできません。'; }
  }
  return {...order,status,items,packages,revisions,can_edit:unavailableReason===null,can_cancel:unavailableReason===null,edit_unavailable_reason:unavailableReason,cancel_unavailable_reason:unavailableReason,edit_deadline:deadline};
}
export async function editable(c: Context<AppEnv>, order: Row, requireLock = false) {
  if (normalizeOrderStatus(order.status)!=='received') fail(409,'ORDER_NOT_EDITABLE','受付済みの注文だけを編集・キャンセルできます。');
  if (order.is_invoice_locked) fail(409,'INVOICE_LOCKED','請求書発行済みのため変更できません。先に請求を取り消してください。');
  if (actor(c).type==='customer') {
    const [calendar,config]=await Promise.all([rows(c.env.DB,'SELECT * FROM delivery_calendar WHERE deleted_at IS NULL'),settings(c.env.DB)]);
    if (!canEditOrder(order as any,new Date(),calendar as any,config)) fail(409,'EDIT_DEADLINE','変更・キャンセル期限を過ぎています。');
  }
  const lockActive=order.edit_locked_by && order.edit_lock_expires_at>now();
  if (lockActive && order.edit_locked_by!==actor(c).id) fail(409,'ORDER_LOCKED','現在別の利用者が編集中です。');
  if (requireLock && (!lockActive || order.edit_locked_by!==actor(c).id)) fail(409,'LOCK_REQUIRED','編集ロックの有効期限が切れました。編集画面を開き直してください。');
}
export async function deliveryDates(db: D1Database, companyId: string, addressId: string) {
  const address=await one(db,"SELECT * FROM shipping_addresses WHERE id=? AND company_id=? AND status='active' AND deleted_at IS NULL",addressId,companyId);
  if (!address) fail(404,'ADDRESS_NOT_FOUND','配送先が見つかりません。');
  let rule=address!.shipping_rule_id ? await one(db,"SELECT * FROM shipping_rules WHERE id=? AND status='active' AND deleted_at IS NULL",address!.shipping_rule_id) : null;
  if(address!.shipping_rule_id && !rule) fail(422,'SHIPPING_RULE_INACTIVE','配送先に設定された配送ルールが無効です。管理者にお問い合わせください。');
  if (!rule) {
    const rules=await rows(db,"SELECT * FROM shipping_rules WHERE status='active' AND deleted_at IS NULL");
    rule=rules.find(r=>{
      if(r.delivery_method!=='own_delivery') return false;
      try { const v=JSON.parse(r.target_condition_json||'{}'); return (Array.isArray(v)?v:(v.cities||v.city||[])).includes(address!.city); } catch { return false; }
    }) || rules.find(r=>r.delivery_method==='yamato') || null;
  }
  if (!rule) fail(422,'SHIPPING_RULE_MISSING','配送ルールが未設定です。管理者にお問い合わせください。');
  const [calendar,config]=await Promise.all([rows(db,'SELECT * FROM delivery_calendar WHERE deleted_at IS NULL'),settings(db)]);
  const dates=getDeliveryDates(new Date(),rule as any,calendar as any,config);
  return {address:address!,rule:rule!,calendar,config,dates};
}
export async function quote(c: Context<AppEnv>, input: Row, companyId: string, oldOrder?: Row) {
  const company=await one(c.env.DB,"SELECT * FROM companies WHERE id=? AND status='active' AND deleted_at IS NULL",companyId);
  if (!company) fail(404,'COMPANY_NOT_FOUND','有効な取引先が見つかりません。');
  const addressId=string(input.shipping_address_id,'配送先');
  const delivery=await deliveryDates(c.env.DB,companyId,addressId);
  if (input.desired_delivery_date) {
    date(input.desired_delivery_date,'到着希望日');
    const retainOriginal=input.desired_delivery_date===oldOrder?.desired_delivery_date && addressId===oldOrder?.shipping_address_id && (actor(c).type==='admin' || getDeliveryDates(new Date(),delivery.rule,delivery.calendar as any,{...delivery.config,min_lead_business_days:0}).includes(input.desired_delivery_date));
    if (!delivery.dates.includes(input.desired_delivery_date) && !retainOriginal) fail(422,'INVALID_DELIVERY_DATE','選択できない到着希望日です。配送カレンダーをご確認ください。');
  }
  if (!Array.isArray(input.items) || input.items.length<1 || input.items.length>100) fail(400,'INVALID_ITEMS','商品を1〜100種類選択してください。');
  const originals=new Map<string,Row>();
  if(oldOrder) {
    const revisions=await rows(c.env.DB,'SELECT before_json,after_json FROM order_revisions WHERE order_id=? ORDER BY revision_no',oldOrder.id);
    for(const revision of revisions) {
      for(const serialized of [revision.before_json,revision.after_json]) {
        try { for(const item of JSON.parse(serialized).items || []) if(!originals.has(item.product_id)) originals.set(item.product_id,item); } catch { /* Historic data may not have item snapshots. */ }
      }
    }
    for(const item of await rows(c.env.DB,'SELECT * FROM order_items WHERE order_id=?',oldOrder.id)) if(!originals.has(item.product_id)) originals.set(item.product_id,item);
  }
  const today=jstDate(new Date());
  const products=await rows(c.env.DB,`SELECT p.*,cpp.unit_price AS company_price,cpp.is_available AS company_available FROM products p LEFT JOIN company_product_prices cpp ON cpp.id=(SELECT cp.id FROM company_product_prices cp WHERE cp.product_id=p.id AND cp.company_id=? AND cp.status='active' AND cp.deleted_at IS NULL AND cp.valid_from<=? AND (cp.valid_to IS NULL OR cp.valid_to>=?) ORDER BY cp.valid_from DESC,cp.id DESC LIMIT 1) WHERE p.deleted_at IS NULL OR p.id IN (SELECT value FROM json_each(?))`,companyId,today,today,JSON.stringify([...originals.keys()]));
  const seen=new Set<string>();
  const items=input.items.map((item: Row,index: number)=>{
    const productId=string(item.product_id,'商品');
    if(seen.has(productId)) fail(400,'DUPLICATE_PRODUCT','同じ商品は1行にまとめてください。');
    seen.add(productId);
    const quantity=integer(item.quantity,'数量',1,9999);
    const product=products.find(p=>p.id===productId);
    if(!product) fail(422,'PRODUCT_UNAVAILABLE','存在しない商品が含まれています。');
    const original=originals.get(productId);
    if(!original && (product!.sales_status!=='on_sale' || product!.company_available===0 || (product!.is_limited && product!.company_available!==1))) fail(422,'PRODUCT_UNAVAILABLE',`${product!.name}は現在ご注文いただけません。`);
    const price=original?.unit_price ?? product!.company_price ?? product!.standard_price;
    if(price==null) fail(422,'PRICE_NOT_SET',`${product!.name}の単価が未設定です。`);
    return {product_id:productId,line_no:index+1,snap_product_name:original?.snap_product_name || product!.name,snap_category:original?.snap_category || product!.category,snap_volume_ml:original?.snap_volume_ml || product!.volume_ml,snap_unit:original?.snap_unit || product!.unit,unit_price:price,quantity,subtotal:price*quantity,weight_kg:product!.weight_kg};
  });
  const sameAddress=oldOrder?.shipping_address_id===addressId;
  const shippingMethod=sameAddress ? (oldOrder.snap_shipping_method==='自社配達'?'own_delivery':'yamato') : delivery.rule.delivery_method;
  const shippingFeatures=getShippingFeatures(delivery.config);
  const manualOverride=actor(c).type==='admin' && input.shipping_fee!=null ? integer(input.shipping_fee,'配送料',0,1000000) : null;
  // An explicit per-order fee is a financial snapshot and survives quantity-only edits.
  const resetManualFee=actor(c).type==='admin' && input.is_shipping_fee_manual===0;
  const savedManualFee=sameAddress && oldOrder.is_shipping_fee_manual && !resetManualFee ? Number(oldOrder.shipping_fee) : null;
  const freeShipping=shippingMethod==='own_delivery'||(sameAddress && oldOrder.shipping_fee_source ? oldOrder.shipping_fee_source==='free' : Boolean(delivery.rule.is_free_shipping));
  let shippingFee:number|null=null,shippingFeeSource:'automatic'|'fixed'|'manual'|'free'='automatic';
  if(manualOverride!==null || savedManualFee!==null) { shippingFee=manualOverride??savedManualFee;shippingFeeSource=manualOverride===null && oldOrder?.shipping_fee_source==='fixed'?'fixed':'manual'; }
  else if(freeShipping) { shippingFee=0;shippingFeeSource='free'; }
  else if(!shippingFeatures.yamato_rates_enabled) {
    const fixed=delivery.config.manual_shipping_fee;
    if(fixed==null || String(fixed).trim()==='') fail(422,'SHIPPING_FEE_REQUIRED','送料の自動計算が無効です。管理者が設定で固定送料を登録するか、この注文の配送料を指定してください。');
    const amount=Number(fixed);
    if(!/^\d+$/.test(String(fixed))||!Number.isSafeInteger(amount)||amount<0||amount>1000000) fail(422,'INVALID_SHIPPING_FEE','固定送料の設定が不正です。管理者にお問い合わせください。');
    shippingFee=amount;shippingFeeSource='fixed';
  }
  const calculateRates=shippingFeatures.yamato_rates_enabled && shippingFee===null;
  const [boxes,sizes,rates]=await Promise.all([
    shippingFeatures.packing_enabled && shippingMethod!=='own_delivery' ? rows(c.env.DB,"SELECT * FROM packaging_boxes WHERE status='active' AND deleted_at IS NULL") : [],
    shippingFeatures.yamato_sizes_enabled && shippingMethod!=='own_delivery' ? rows(c.env.DB,"SELECT * FROM yamato_sizes WHERE status='active' AND deleted_at IS NULL") : [],
    calculateRates ? rows(c.env.DB,"SELECT * FROM yamato_rates WHERE status='active' AND deleted_at IS NULL") : []
  ]);
  // Quantity-only edits retain the ordered destination, even after the address master is moved.
  const originalPrefecture=sameAddress ? String(oldOrder.snap_address).match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/)?.[1] : null;
  let packing: any;
  try { packing=calculatePackages(items.map((i: Row)=>({product_id:i.product_id,volume_ml:i.snap_volume_ml,quantity:i.quantity,weight_kg:i.weight_kg,line_no:i.line_no})),boxes as PackagingBox[],sizes as YamatoSize[],rates as YamatoRate[],{...delivery.config,dest_region:originalPrefecture||delivery.address.prefecture,date:input.desired_delivery_date || today,delivery_method:shippingMethod,yamato_rates_enabled:calculateRates} as any); }
  catch(error) { fail(422,'PACKAGING_UNAVAILABLE',error instanceof Error ? error.message : '梱包・送料を計算できませんでした。'); }
  shippingFee??=packing.shipping_fee;
  const taxConfig=oldOrder ? {...delivery.config,tax_rate:oldOrder.snap_tax_rate,tax_calc_unit:oldOrder.snap_tax_calc_unit,tax_rounding:oldOrder.snap_tax_rounding} : delivery.config;
  const totals=computePricing(items,{...taxConfig,shipping_fee:shippingFee} as any);
  const originalAddress=sameAddress ? {snap_recipient_name:oldOrder.snap_recipient_name,snap_postal_code:oldOrder.snap_postal_code,snap_address:oldOrder.snap_address,snap_phone:oldOrder.snap_phone} : null;
  return {...totals,items,packages:packing.packages,shipping_address:delivery.address,shipping_snapshot:originalAddress,delivery_method:shippingMethod,delivery_dates:delivery.dates,config:taxConfig,company,shipping_fee:shippingFee,is_shipping_fee_manual:['manual','fixed'].includes(shippingFeeSource)?1:0,shipping_features:shippingFeatures,shipping_fee_source:shippingFeeSource};
}
export function itemStatements(db: D1Database, orderId: string, q: Row) {
  const itemRows:Row[]=[],packageRows:Row[]=[],packageItems:Row[]=[];
  for(const item of q.items) {
    const {weight_kg,...snapshot}=item;
    itemRows.push({id:uid(),order_id:orderId,...snapshot});
  }
  for(const [index,p] of (q.packages as Row[]).entries()) {
    const id=uid();
    packageRows.push({id,order_id:orderId,package_no:p.package_no||index+1,packaging_box_id:p.packaging_box_id||p.box_id,size_code:p.size_code,three_sides_cm:p.three_sides_cm,total_weight_kg:p.total_weight_kg,shipping_fee:p.shipping_fee,rate_type:p.rate_type,note:p.note||null});
    for(const i of p.items || []) packageItems.push({id:uid(),order_package_id:id,order_id:orderId,line_no:i.line_no||q.items.find((x:Row)=>x.product_id===i.product_id)?.line_no,product_id:i.product_id,quantity:i.quantity});
  }
  return [...insertMany(db,'order_items',itemRows),...insertMany(db,'order_packages',packageRows),...insertMany(db,'order_package_items',packageItems)];
}
function snapshotFields(input: Row, q: Row) {
  const a=q.shipping_address;
  return {shipping_address_id:a.id,desired_delivery_date:input.desired_delivery_date,snap_recipient_name:a.name,snap_postal_code:a.postal_code,snap_address:[a.prefecture,a.city,a.address_line1,a.address_line2].filter(Boolean).join(''),snap_phone:a.phone,...q.shipping_snapshot,snap_shipping_method:q.delivery_method==='own_delivery'?'自社配達':'ヤマト宅急便',snap_carrier_name:q.delivery_method==='own_delivery'?'自社便':'ヤマト運輸',items_subtotal:q.items_subtotal,shipping_fee:q.shipping_fee,is_shipping_fee_manual:q.is_shipping_fee_manual,shipping_fee_source:q.shipping_fee_source,snap_tax_rate:Number(q.config.tax_rate??10),snap_tax_calc_unit:q.config.tax_calc_unit||'invoice',snap_tax_rounding:q.config.tax_rounding||'floor',tax_amount:q.tax_amount,total_amount:q.total_amount,note:input.note ? string(input.note,'備考',false,4000) : null};
}
export async function createOrder(c: Context<AppEnv>, input: Row) {
  const who=actor(c), companyId=who.type==='customer'?who.company_id!:string(input.company_id,'取引先');
  const requestId=string(input.request_id,'リクエストID',true,64);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) fail(400,'INVALID_REQUEST_ID','リクエストIDはUUIDで指定してください。');
  const existing=await one(c.env.DB,'SELECT * FROM orders WHERE request_id=?',requestId);
  if(existing) {
    if(existing.company_id!==companyId) fail(409,'REQUEST_ID_USED','このリクエストIDは使用できません。');
    return {order:await orderDetail(c,existing),created:false};
  }
  date(input.desired_delivery_date,'到着希望日');
  const q=await quote(c,input,companyId);
  let notificationRecipient:string|null=null;
  if(who.type==='customer'&&(input.ordered_by_line_user_id!=null||input.is_test_order!==undefined))fail(403,'ADMIN_ONLY','管理者専用の注文設定です。');
  if(input.is_test_order!==undefined&&typeof input.is_test_order!=='boolean')fail(400,'INVALID_INPUT','テスト注文の指定が不正です。');
  if(who.type==='admin'&&input.ordered_by_line_user_id){
    notificationRecipient=string(input.ordered_by_line_user_id,'LINE通知先',true,256);
    if(!await one(c.env.DB,"SELECT id FROM line_users WHERE line_user_id=? AND company_id=? AND status='active'",notificationRecipient,companyId))fail(422,'INVALID_NOTIFICATION_RECIPIENT','同じ取引先に登録された有効なLINE利用者を選択してください。');
  }
  const isTest=who.type==='admin'&&input.is_test_order===true;
  const stamp=now(), id=`${isTest?'TEST-':''}O${jstDate(new Date()).replaceAll('-','')}${uid().replaceAll('-','').slice(0,8).toUpperCase()}`;
  const contract=await one(c.env.DB,"SELECT id FROM contracts WHERE company_id=? AND status='active' AND deleted_at IS NULL AND (start_date IS NULL OR start_date<=?) AND (end_date IS NULL OR end_date>=?) ORDER BY start_date DESC LIMIT 1",companyId,jstDate(new Date()),jstDate(new Date()));
  const order={id,request_id:requestId,company_id:companyId,contract_id:contract?.id||null,ordered_by_line_user_id:who.type==='customer'?who.id:notificationRecipient,ordered_by_name:who.name,ordered_at:stamp,updated_at:stamp,status:'received',...snapshotFields(input,q),version:1,is_invoice_locked:0,edit_lock_status:'unlocked'};
  try {
    await atomic(c.env.DB,[insert(c.env.DB,'orders',order),...itemStatements(c.env.DB,id,q),insert(c.env.DB,'order_requests',{request_id:requestId,line_user_id:who.id,company_id:companyId,issued_at:stamp,processed_at:stamp,order_id:id,status:'completed'}),audit(c.env.DB,who,'ORDER_CREATE','orders',id,null,{...order,items:q.items},companyId),orderNotificationStatement(c.env.DB,{...order,company_name:q.company?.name},'create')]);
  } catch(error) {
    if(!String(error).includes('UNIQUE constraint failed')) throw error;
    const duplicate=await one(c.env.DB,'SELECT * FROM orders WHERE request_id=? AND company_id=?',requestId,companyId);
    if(!duplicate) fail(409,'REQUEST_ID_USED','このリクエストIDは使用できません。');
    return {order:await orderDetail(c,duplicate!),created:false};
  }
  return {order:await orderDetail(c,order),created:true};
}
export async function editOrder(c: Context<AppEnv>, order: Row, input: Row) {
  await editable(c,order,true);
  const version=integer(input.version,'バージョン',1);
  if(order.version!==version) fail(409,'VERSION_CONFLICT','別の操作で更新されています。再読み込みしてください。');
  date(input.desired_delivery_date,'到着希望日');
  const q=await quote(c,input,order.company_id,order);
  const before=await orderDetail(c,order), stamp=now();
  const data={...snapshotFields(input,q),updated_at:stamp,version:version+1,edit_lock_status:'unlocked',edit_locked_by:null,edit_locked_at:null,edit_lock_expires_at:null};
  const statements=[update(c.env.DB,'orders',data,"id=? AND version=? AND status IN ('received','confirmed','preparing') AND is_invoice_locked=0 AND edit_locked_by=? AND edit_lock_expires_at>?",order.id,version,actor(c).id,stamp),assertChanges(c.env.DB,1,actor(c),'ORDER_EDIT','orders',order.id,before,{...order,...data,items:q.items},order.company_id),c.env.DB.prepare('DELETE FROM order_package_items WHERE order_id=?').bind(order.id),c.env.DB.prepare('DELETE FROM order_packages WHERE order_id=?').bind(order.id),c.env.DB.prepare('DELETE FROM order_items WHERE order_id=?').bind(order.id),...itemStatements(c.env.DB,order.id,q),insert(c.env.DB,'order_revisions',{id:uid(),order_id:order.id,revision_no:version,changed_at:stamp,changer_type:actor(c).type,changer_id:actor(c).id,before_json:JSON.stringify(before),after_json:JSON.stringify({...order,...data,items:q.items}),before_total:order.total_amount,after_total:q.total_amount,note:input.note||null}),orderNotificationStatement(c.env.DB,{...order,...data},'edit')];
  await atomic(c.env.DB,statements);
  return orderDetail(c,await findOrder(c,order.id));
}
export async function lockOrder(c: Context<AppEnv>, order: Row) {
  await editable(c,order);
  const config=await settings(c.env.DB);
  const stamp=now(), expires=new Date(Date.now()+Number(config.edit_lock_minutes||10)*60*1000).toISOString();
  const result=await update(c.env.DB,'orders',{edit_locked_by:actor(c).id,edit_locked_at:stamp,edit_lock_expires_at:expires,edit_lock_status:'locked'},"id=? AND status IN ('received','confirmed','preparing') AND is_invoice_locked=0 AND version=? AND (edit_locked_by IS NULL OR edit_locked_by=? OR edit_lock_expires_at<=?)",order.id,order.version,actor(c).id,stamp).run();
  if(!result.meta.changes) fail(409,'ORDER_LOCKED','現在別の利用者が編集中です。');
  return {locked_by:actor(c).id,expires_at:expires,version:order.version};
}
export async function cancelOrder(c: Context<AppEnv>, order: Row, input: Row) {
  if(normalizeOrderStatus(order.status)!=='received') fail(409,'ORDER_NOT_CANCELLABLE','受付済みの注文だけをキャンセルできます。');
  await editable(c,order);
  const version=integer(input.version,'バージョン',1), stamp=now();
  const reason=string(input.reason,'取消理由',actor(c).type==='admin',2000);
  await atomic(c.env.DB,[update(c.env.DB,'orders',{status:'cancelled',cancelled_at:stamp,updated_at:stamp,version:version+1,edit_lock_status:'unlocked',edit_locked_by:null,edit_locked_at:null,edit_lock_expires_at:null},"id=? AND version=? AND status IN ('received','confirmed','preparing') AND is_invoice_locked=0 AND (edit_locked_by IS NULL OR edit_locked_by=? OR edit_lock_expires_at<=?)",order.id,version,actor(c).id,stamp),assertChanges(c.env.DB,1,actor(c),'ORDER_CANCEL','orders',order.id,order,{status:'cancelled',reason},order.company_id),orderNotificationStatement(c.env.DB,{...order,version:version+1,updated_at:stamp},'cancel')]);
  return orderDetail(c,await findOrder(c,order.id));
}
