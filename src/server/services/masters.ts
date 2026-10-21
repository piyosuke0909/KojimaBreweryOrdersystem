import { actor, asJson, atomic, audit, body, date, fail, insert, integer, number, now, one, paginated, string, uid, update, type Row } from './common';
import type { Hono, Context } from 'hono';
import type { AppEnv } from '../types';

const fields: Record<string,string[]>={
  companies:['name','contact_name','phone','postal_code','address','status','note'],
  products:['name','category','volume_ml','unit','standard_price','tax_type','weight_kg','image_url','short_description','description','commitment','taste','recommended_way','is_limited','sales_status','sort_order','note'],
  shipping_rules:['name','target_condition_json','delivery_method','allowed_periods_json','is_free_shipping','status','note'],
  delivery_calendar:['date','is_deliverable','reason','note'],
  packaging_boxes:['name','supported_volumes_json','max_bottles','length_cm','width_cm','height_cm','box_weight_kg','target_condition','allow_mixed','priority','valid_from','valid_to','status','note'],
  yamato_sizes:['size_code','max_three_sides_cm','max_weight_kg','valid_from','valid_to','status'],
  yamato_rates:['origin_region','dest_region','size_code','shipping_fee','rate_type','valid_from','valid_to','status','note'],
  shipping_addresses:['name','postal_code','prefecture','city','address_line1','address_line2','phone','contact_name','is_default','shipping_rule_id','status','note'],
  contracts:['contract_name','start_date','end_date','closing_day','payment_terms','status','note'],
  company_info:['company_name','display_name','postal_code','address','tel','fax','email','contact_person','invoice_reg_no','bank_name','bank_branch_name','bank_account_type','bank_account_number','bank_account_holder','note'],
  report_settings:['delivery_note_title','invoice_title','numbering_rule','show_issuer_info','show_invoice_reg_no','show_contact_person','show_fax','show_email','delivery_note_template','invoice_note_template']
};
const required:Record<string,string[]>={companies:['name'],products:['name','volume_ml','weight_kg'],shipping_rules:['name','delivery_method'],delivery_calendar:['date','is_deliverable'],packaging_boxes:['name','supported_volumes_json','max_bottles','length_cm','width_cm','height_cm','box_weight_kg'],yamato_sizes:['size_code','max_three_sides_cm','max_weight_kg'],yamato_rates:['dest_region','size_code','shipping_fee'],shipping_addresses:['name','postal_code','prefecture','city','address_line1','phone'],contracts:['contract_name'],company_info:['company_name','display_name']};
const defaults:Record<string,Row>={companies:{status:'active'},products:{unit:'本',tax_type:'excl',is_limited:0,sales_status:'unavailable',sort_order:0},shipping_rules:{target_condition_json:'{}',allowed_periods_json:'[]',is_free_shipping:0,status:'active'},packaging_boxes:{allow_mixed:1,priority:0,status:'active'},yamato_sizes:{status:'active'},yamato_rates:{origin_region:'中部',rate_type:'standard',status:'active'},shipping_addresses:{is_default:0,status:'active'},contracts:{status:'active',closing_day:31}};
const actions:Record<string,string>={companies:'COMPANY',products:'PRODUCT',shipping_rules:'SHIPPING_RULE',delivery_calendar:'CALENDAR',packaging_boxes:'PACKAGING',yamato_sizes:'PACKAGING',yamato_rates:'YAMATO_RATE',shipping_addresses:'ADDRESS',contracts:'CONTRACT',company_info:'COMPANY_INFO',report_settings:'SETTINGS',invitations:'INVITE',company_product_prices:'COMPANY_PRICE'};
const numeric=new Set(['volume_ml','standard_price','max_bottles','priority','shipping_fee','sort_order','closing_day']);
const decimals=new Set(['weight_kg','length_cm','width_cm','height_cm','box_weight_kg','max_three_sides_cm','max_weight_kg']);
const boolean=new Set(['is_limited','is_free_shipping','is_deliverable','allow_mixed','is_default','show_issuer_info','show_invoice_reg_no','show_contact_person','show_fax','show_email']);

const softDeleteTables=new Set(['companies','products','shipping_rules','delivery_calendar','packaging_boxes','yamato_sizes','yamato_rates','shipping_addresses','contracts','company_product_prices','invitations']);
/** Retain foreign keys, document snapshots and actor history while hiding operational data. */
export async function softDeleteMaster(c:Context<AppEnv>,table:string,id:string,companyId?:string){
  if(!softDeleteTables.has(table))fail(400,'DELETE_UNSUPPORTED','この設定は削除できません。');
  const key=table==='delivery_calendar'?'date':table==='yamato_sizes'?'size_code':'id';
  const row=await one(c.env.DB,`SELECT * FROM ${table} WHERE ${key}=?${companyId?' AND company_id=?':''}`,id,...(companyId?[companyId]:[]));
  if(!row)fail(404,'NOT_FOUND','データが見つかりません。');
  if(!row!.deleted_at){
    const stamp=now(),data:Row={deleted_at:stamp};
    if(table==='products')data.sales_status='unavailable';
    else if(table==='invitations')data.status='revoked';
    else if(table==='company_product_prices')data.status='archived';
    else if(table==='delivery_calendar')data.is_deliverable=0;
    else data.status='inactive';
    if(table==='shipping_addresses')data.is_default=0;
    if(table==='companies')data.updated_at=stamp;
    const {token_hash,...safe}=row!;
    await atomic(c.env.DB,[update(c.env.DB,table,data,`${key}=? AND deleted_at IS NULL${companyId?' AND company_id=?':''}`,id,...(companyId?[companyId]:[])),audit(c.env.DB,actor(c),`${actions[table]||table.toUpperCase()}_DELETE`,table,id,safe,{...safe,...data},companyId??(table==='companies'?id:row!.company_id))]);
  }
  return {id,deleted:true,mode:'soft_deleted',message:table==='invitations'?'招待QRを削除しました。登録済みのLINE利用者は引き続き利用できます。':'一覧から削除しました。過去の注文・請求・監査履歴は保持されます。'};
}

export function cleanMaster(table:string,input:Row,existing?:Row):Row {
  const data:Row=existing?{}:{...(defaults[table]||{})};
  for(const key of fields[table]||[]) if(input[key]!==undefined) {
    let value=input[key];
    if(value==null) { data[key]=null; continue; }
    if(numeric.has(key)) value=integer(value,key,key==='volume_ml'||key==='max_bottles'?1:0);
    else if(decimals.has(key)) value=number(value,key,key==='box_weight_kg'?0:0.001,10000);
    else if(boolean.has(key)) { if(typeof value==='boolean') value=value?1:0; value=integer(value,key,0,1); }
    else if(key.endsWith('_json')) {
      try { const parsed=typeof value==='string'?JSON.parse(value):value; value=JSON.stringify(parsed); } catch { fail(400,'INVALID_JSON',`${key}のJSONが不正です。`); }
    } else { value=string(value,key,false,10000); }
    if(key==='shipping_rule_id' && value==='') value=null;
    data[key]=value;
  }
  const merged={...existing,...data};
  for(const key of required[table]||[]) if(merged[key]==null || merged[key]==='') fail(400,'INVALID_INPUT',`${key}は必須です。`);
  if(merged.status && !['active','inactive'].includes(merged.status)) fail(400,'INVALID_INPUT','状態が不正です。');
  if(merged.sales_status && !['on_sale','suspended','unavailable'].includes(merged.sales_status)) fail(400,'INVALID_INPUT','販売状態が不正です。');
  if(merged.tax_type && merged.tax_type!=='excl') fail(400,'INVALID_INPUT','税抜価格を指定してください。');
  if(merged.delivery_method && !['own_delivery','yamato'].includes(merged.delivery_method)) fail(400,'INVALID_INPUT','配送方式が不正です。');
  if(table==='shipping_rules' && merged.delivery_method==='own_delivery' && merged.is_free_shipping!==1) fail(400,'INVALID_INPUT','自社便は送料無料で設定してください。');
  if(table==='shipping_rules') {
    const periods=JSON.parse(merged.allowed_periods_json||'[]');
    if(!Array.isArray(periods) || periods.some((p:Row)=>!p || !Number.isInteger(p.start_day) || !Number.isInteger(p.end_day) || p.start_day<1 || p.end_day>31 || p.start_day>p.end_day)) fail(400,'INVALID_INPUT','配送可能期間は開始日・終了日を1〜31で指定してください。');
    const target=JSON.parse(merged.target_condition_json||'{}');
    if(!target || (typeof target!=='object')) fail(400,'INVALID_INPUT','配送対象条件が不正です。');
    if(target.cities && (!Array.isArray(target.cities)||target.cities.some((v:any)=>typeof v!=='string'))) fail(400,'INVALID_INPUT','対象市区町村は文字列の一覧で指定してください。');
  }
  if(table==='packaging_boxes') {
    const volumes=JSON.parse(merged.supported_volumes_json);
    if(!Array.isArray(volumes)||!volumes.length||volumes.some(v=>!Number.isSafeInteger(v)||v<1||v>100000)) fail(400,'INVALID_INPUT','対応容量は正の整数の一覧で指定してください。');
  }
  for(const k of ['date','start_date','end_date','valid_from','valid_to']) if(merged[k]) date(merged[k],k);
  if(merged.valid_from && merged.valid_to && merged.valid_from>merged.valid_to) fail(400,'INVALID_INPUT','適用終了日は開始日以降を指定してください。');
  if(merged.closing_day!=null) integer(merged.closing_day,'締日',1,31);
  if(merged.image_url && !/^(https:\/\/|\/[^/])/.test(merged.image_url)) fail(400,'INVALID_INPUT','画像URLはHTTPSまたはサイト内のパスを指定してください。');
  if(merged.invoice_reg_no && !/^T\d{13}$/.test(merged.invoice_reg_no)) fail(400,'INVALID_INPUT','登録番号はTと13桁の数字で指定してください。');
  if(merged.bank_account_number) {
    if(!/^\d{6,7}$/.test(merged.bank_account_number)) fail(400,'INVALID_INPUT','口座番号は6〜7桁の数字で指定してください。');
    data.bank_account_number=merged.bank_account_number.padStart(7,'0');
  }
  return data;
}
export async function saveMaster(c:Context<AppEnv>,table:string,input:Row,id?:string,companyId?:string) {
  const key=table==='delivery_calendar'?'date':table==='yamato_sizes'?'size_code':'id';
  const before=id?await one(c.env.DB,`SELECT * FROM ${table} WHERE ${key}=?${companyId?' AND company_id=?':''}${softDeleteTables.has(table)?' AND deleted_at IS NULL':''}`,id,...(companyId?[companyId]:[])):null;
  if(id&&!before) fail(404,'NOT_FOUND','データが見つかりません。');
  const data=cleanMaster(table,input,before||undefined);
  if(before && !Object.keys(data).length) fail(400,'INVALID_INPUT','変更する項目を指定してください。');
  if(id && data[key] && data[key]!==id) fail(400,'INVALID_INPUT','識別子は変更できません。');
  if(companyId) data.company_id=companyId;
  if(table==='companies') { data.updated_at=now(); if(!before) data.created_at=now(); }
  const recordId=id||data[key]||uid();
  if(table==='shipping_addresses'&&data.shipping_rule_id&&!await one(c.env.DB,"SELECT id FROM shipping_rules WHERE id=? AND status='active' AND deleted_at IS NULL",data.shipping_rule_id))fail(422,'SHIPPING_RULE_INACTIVE','有効な配送ルールを選択してください。');
  if(table==='yamato_rates'&&!await one(c.env.DB,"SELECT size_code FROM yamato_sizes WHERE size_code=? AND status='active' AND deleted_at IS NULL",data.size_code??before?.size_code))fail(422,'SIZE_INACTIVE','有効な配送サイズを選択してください。');
  const statements:D1PreparedStatement[]=[];
  let restored:Row|null=null;
  if(!id&&(table==='delivery_calendar'||table==='yamato_sizes')){
    restored=await one(c.env.DB,`SELECT * FROM ${table} WHERE ${key}=?`,recordId);
    if(restored&&!restored.deleted_at)fail(409,'MASTER_EXISTS','同じ日付・サイズは登録済みです。既存の設定を編集してください。');
    if(restored)data.deleted_at=null;
  }
  if(table==='shipping_addresses' && data.is_default===1) statements.push(c.env.DB.prepare('UPDATE shipping_addresses SET is_default=0 WHERE company_id=?').bind(companyId));
  if(!before) data[key]=recordId;
  statements.push(before||restored?update(c.env.DB,table,data,`${key}=?`,recordId):insert(c.env.DB,table,data));
  statements.push(audit(c.env.DB,actor(c),`${actions[table]||table}_${before?'UPDATE':restored?'RESTORE':'CREATE'}`,table,String(recordId),before??restored,{...restored,...before,...data},companyId));
  await atomic(c.env.DB,statements);
  return one(c.env.DB,`SELECT * FROM ${table} WHERE ${key}=?`,recordId);
}
export function masterRoutes(router:Hono<AppEnv>) {
  for(const [path,table,order] of [['companies','companies','name'],['products','products','sort_order,name'],['shipping-rules','shipping_rules','name'],['calendar','delivery_calendar','date'],['boxes','packaging_boxes','priority,name'],['sizes','yamato_sizes','max_three_sides_cm'],['rates','yamato_rates','dest_region,size_code']] as const) {
    router.get(`/${path}`,async c=>{
      const conditions=['deleted_at IS NULL'],args:any[]=[];
      if(c.req.query('q') && (table==='products'||table==='companies')) {conditions.push(table==='companies'?'(name LIKE ? OR contact_name LIKE ? OR note LIKE ?)':'(name LIKE ? OR note LIKE ?)');args.push(`%${c.req.query('q')}%`,`%${c.req.query('q')}%`);if(table==='companies')args.push(`%${c.req.query('q')}%`);}
      if(c.req.query('status') && table!=='delivery_calendar') {conditions.push(`${table==='products'?'sales_status':'status'}=?`);args.push(c.req.query('status'));}
      if(table==='delivery_calendar') for(const [q,op] of [['from','>='],['to','<=']]) if(c.req.query(q)) {conditions.push(`date${op}?`);args.push(c.req.query(q));}
      const select=table==='companies'?"companies.*,(SELECT count(*) FROM line_users lu WHERE lu.company_id=companies.id AND lu.status='active') AS line_user_count,(SELECT count(*) FROM shipping_addresses sa WHERE sa.company_id=companies.id AND sa.status='active' AND sa.deleted_at IS NULL) AS address_count":'*';
      return paginated(c,table,conditions.join(' AND '),args,order,select,table==='companies'?50:1000);
    });
    router.post(`/${path}`,async c=>c.json({data:await saveMaster(c,table,await body(c))},201));
    router.put(`/${path}/:id`,async c=>c.json({data:await saveMaster(c,table,await body(c),c.req.param('id'))}));
    router.delete(`/${path}/:id`,async c=>c.json({data:await softDeleteMaster(c,table,c.req.param('id'))}));
    if(path!=='companies') router.get(`/${path}/:id`,async c=>{
      const key=table==='delivery_calendar'?'date':table==='yamato_sizes'?'size_code':'id';
      const result=await one(c.env.DB,`SELECT * FROM ${table} WHERE ${key}=? AND deleted_at IS NULL`,c.req.param('id'));
      if(!result) fail(404,'NOT_FOUND','データが見つかりません。');
      return c.json({data:result});
    });
  }
}
