import { expect, test, type Page } from '@playwright/test';
test.setTimeout(15000);

const orderId='CONSENT-ORDER',companyId='consent-company',productId='consent-product';
async function setup(page:Page, options:{createMode?:'ok'|'changed'|'unknown'|'conflict';editMode?:'ok'|'changed'|'unknown';quoteTtl?:number}={}) {
 const address={id:'consent-address',name:'本店',prefecture:'愛知県',city:'犬山市',address_line1:'検証用住所',postal_code:'4840000',phone:'0000000000',status:'active',is_default:1};
 const product={id:productId,name:'検証用商品',category:'検証',volume_ml:500,unit:'本',standard_price:1000,sales_status:'on_sale'};
 const original={id:orderId,company_id:companyId,company_name:'検証用商店',status:'received',version:1,ordered_at:'2026-10-24T00:00:00Z',ordered_by_name:'管理者',shipping_address_id:address.id,desired_delivery_date:'2030-01-10',snap_recipient_name:address.name,snap_postal_code:address.postal_code,snap_address:'愛知県犬山市検証用住所',snap_phone:address.phone,snap_shipping_method:'自社配達',snap_tax_rate:10,items_subtotal:1000,shipping_fee:0,tax_amount:100,total_amount:1100,is_invoice_locked:0,is_shipping_fee_manual:0,can_edit:true,can_cancel:true,items:[{id:'line-1',product_id:productId,snap_product_name:product.name,snap_volume_ml:500,unit_price:1000,quantity:1,subtotal:1000}],packages:[],revisions:[]};
 const state={price:2000,quotes:[] as any[],creates:[] as any[],edits:[] as any[],lookups:0,lookupFound:false,order:structuredClone(original),createMode:options.createMode||'ok',editMode:options.editMode||'ok',quoteTtl:options.quoteTtl??600000};
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  const send=(data:unknown,status=200)=>route.fulfill({status,json:{data,meta:{total:Array.isArray(data)?data.length:0}}});
  const fail=(code:string,status=409)=>route.fulfill({status,json:{error:{code,message:'確認した内容が変わりました。もう一度確認してください。'}}});
  if(path==='/api/auth/me')return send({actor:{type:'admin',id:'consent-admin',name:'管理者',role:'owner'}});
  if(path==='/api/config')return send({environment:'production',demo_enabled:false});
  if(path==='/api/admin/notifications')return send({items:[],total_unread:0,counts:{orders:0,companies:0}});
  if(path==='/api/admin/companies')return send([{id:companyId,name:'検証用商店',status:'active'}]);
  if(path===`/api/admin/companies/${companyId}`)return send({id:companyId,name:'検証用商店',addresses:[address],prices:[],line_users:[]});
  if(path==='/api/admin/products')return send([product]);
  if(path==='/api/admin/settings')return send({packing_enabled:'true',yamato_sizes_enabled:'true',yamato_rates_enabled:'true'});
  if(path==='/api/admin/orders/quote'){
   const input=request.postDataJSON();state.quotes.push(input);
   const items=input.items.map((i:any)=>({...i,snap_product_name:product.name,snap_volume_ml:500,unit_price:state.price,subtotal:state.price*i.quantity})),subtotal=items.reduce((n:number,i:any)=>n+i.subtotal,0);
   return send({items,items_subtotal:subtotal,shipping_fee:0,tax_amount:subtotal/10,total_amount:subtotal*1.1,shipping_address:address,shipping_features:{packing_enabled:true},packages:[],quote_token:'quote-'+state.quotes.length,quote_expires_at:new Date(Date.now()+state.quoteTtl).toISOString()});
  }
  if(path.startsWith('/api/admin/order-requests/')){state.lookups++;return send({processed:state.lookupFound,order:state.lookupFound?state.order:null});}
  if(path==='/api/admin/orders'&&method==='POST'){
   const input=request.postDataJSON();state.creates.push(input);
   if(state.createMode==='changed')return fail('QUOTE_CHANGED');
   if(state.createMode==='conflict'){state.lookupFound=true;return fail('REQUEST_CONTENT_CHANGED');}
   state.order={...state.order,...input,items:input.items.map((i:any)=>({...i,snap_product_name:product.name,snap_volume_ml:500,unit_price:state.price,subtotal:state.price*i.quantity})),items_subtotal:input.items.reduce((n:number,i:any)=>n+state.price*i.quantity,0)};
   state.order.tax_amount=state.order.items_subtotal/10;state.order.total_amount=state.order.items_subtotal*1.1;
   if(state.createMode==='unknown')return route.abort('connectionreset');
   return send(state.order,201);
  }
  if(path===`/api/admin/orders/${orderId}/lock`)return send(method==='DELETE'?{unlocked:true}:{version:state.order.version,expires_at:new Date(Date.now()+600000).toISOString()});
  if(path===`/api/admin/orders/${orderId}`&&method==='PUT'){
   const input=request.postDataJSON();state.edits.push(input);
   if(state.editMode==='changed')return fail('QUOTE_CHANGED');
   state.order={...state.order,...input,version:state.order.version+1};
   if(state.editMode==='unknown')return route.abort('connectionreset');
   return send(state.order);
  }
  if(path===`/api/admin/orders/${orderId}`)return send(state.order);
  if(path==='/api/admin/orders')return send([]);
  return send({});
 });
 return state;
}
async function openCreate(page:Page) {
 await page.goto('/admin/orders?create=1');const dialog=page.getByRole('dialog',{name:'注文を登録',exact:true});
 await dialog.getByRole('combobox',{name:'注文する取引先',exact:true}).selectOption(companyId);
 await dialog.locator('input[type="date"]').fill('2030-01-10');
 await dialog.getByRole('spinbutton',{name:'検証用商品 500mlの注文数量',exact:true}).fill('1');
 return dialog;
}
async function confirmCreate(page:Page) {
 const dialog=page.getByRole('dialog',{name:'注文を登録',exact:true});await dialog.getByRole('button',{name:'送料・合計を確認',exact:true}).click();
 await dialog.getByRole('button',{name:'注文を登録する',exact:true}).click();return dialog;
}

test('管理者の確認明細と合計を最新見積でそろえ、確認したトークンだけで登録する',async({page})=>{
 const state=await setup(page);const dialog=await openCreate(page);await dialog.getByRole('button',{name:'送料・合計を確認',exact:true}).click();
 await expect(dialog.locator('.admin-create-products table')).toContainText('￥2,000');await expect(dialog.locator('.admin-create-quote')).toContainText('￥2,200');
 await dialog.getByRole('button',{name:'注文を登録する',exact:true}).click();expect(state.creates).toHaveLength(0);
 await dialog.getByRole('button',{name:'確認して注文を登録',exact:true}).click();await expect(page).toHaveURL(new RegExp('/admin/orders/'+orderId+'$'));
 expect(state.creates).toHaveLength(1);expect(state.creates[0].quote_token).toBe('quote-1');
});
test('入力変更と見積失効で登録を止め、金額変更エラーの後は明示的な再確認を求める',async({page})=>{
 const state=await setup(page,{createMode:'changed'});const dialog=await openCreate(page);await confirmCreate(page);
 await dialog.getByRole('button',{name:'確認して注文を登録',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('価格・送料・条件が変更されました');
 expect(state.creates).toHaveLength(1);await expect(dialog.getByRole('button',{name:'注文を登録する',exact:true})).toBeDisabled();
 await dialog.getByRole('button',{name:'送料・合計を確認',exact:true}).click();await dialog.getByRole('spinbutton',{name:'検証用商品 500mlの注文数量',exact:true}).fill('2');
 await expect(dialog.getByRole('button',{name:'注文を登録する',exact:true})).toBeDisabled();expect(state.creates).toHaveLength(1);
});
test('通信結果不明のUUIDだけを管理者ごとに保持し、再読込後も新規注文を作らず受付結果を確認する',async({page})=>{
 const state=await setup(page,{createMode:'unknown'});await openCreate(page);await confirmCreate(page);await page.getByRole('button',{name:'確認して注文を登録',exact:true}).click();
 const pending=page.getByRole('dialog',{name:'注文の受付結果を確認',exact:true});await expect(pending).toBeVisible();expect(state.creates).toHaveLength(1);
 const storage=await page.evaluate(()=>Object.fromEntries(Object.entries(sessionStorage)));expect(storage['kojima-admin-order-pending:consent-admin']).toBe(state.creates[0].request_id);expect(JSON.stringify(storage)).not.toContain('quote-1');
 await page.reload();await expect(pending).toBeVisible();expect(state.creates).toHaveLength(1);
 state.lookupFound=true;await pending.getByRole('button',{name:'受付結果を確認する',exact:true}).click();await expect(page).toHaveURL(new RegExp('/admin/orders/'+orderId+'$'));expect(state.creates).toHaveLength(1);
 expect(await page.evaluate(()=>sessionStorage.getItem('kojima-admin-order-pending:consent-admin'))).toBeNull();
});
test('内容の違う再送で旧注文が見つかっても、新しい内容の成功とは表示しない',async({page})=>{
 const state=await setup(page,{createMode:'conflict'});await openCreate(page);await confirmCreate(page);await page.getByRole('button',{name:'確認して注文を登録',exact:true}).click();
 const pending=page.getByRole('dialog',{name:'注文の受付結果を確認',exact:true});await expect(pending).toContainText('今回の変更内容を受け付けたという意味ではありません');
 await expect(pending.getByRole('button',{name:'同じ内容で再送する',exact:true})).toHaveCount(0);expect(state.creates).toHaveLength(1);
});
test('管理者の注文編集も見積確認を必須とし、確認ダイアログと保存要求に同じ金額のトークンを使う',async({page})=>{
 const state=await setup(page);state.price=1000;await page.goto('/admin/orders/'+orderId);await page.getByRole('button',{name:'注文内容を編集',exact:true}).click();
 await page.getByRole('spinbutton',{name:'検証用商品の数量',exact:true}).fill('2');await expect(page.getByRole('button',{name:'変更を保存する',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'変更後の送料・合計を確認',exact:true}).click();await page.getByRole('button',{name:'変更を保存する',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'注文の変更を保存しますか？',exact:true});await expect(dialog).toContainText('￥2,200');expect(state.edits).toHaveLength(0);
 await dialog.getByRole('button',{name:'確認して実行',exact:true}).click();await expect(page.getByText('注文内容を更新しました。',{exact:true})).toBeVisible();expect(state.edits[0].quote_token).toBe('quote-1');
});
test('編集の見積変更と保存応答の通信断では自動保存・再送せず現在の内容を確認する',async({page})=>{
 const state=await setup(page,{editMode:'changed'});state.price=1000;await page.goto('/admin/orders/'+orderId);await page.getByRole('button',{name:'注文内容を編集',exact:true}).click();
 await page.getByRole('button',{name:'変更後の送料・合計を確認',exact:true}).click();await page.getByRole('button',{name:'変更を保存する',exact:true}).click();await page.getByRole('button',{name:'確認して実行',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('価格・送料・条件が変更されました');await expect(page.getByRole('button',{name:'変更を保存する',exact:true})).toBeDisabled();expect(state.edits).toHaveLength(1);
 state.editMode='unknown';await page.getByRole('button',{name:'変更後の送料・合計を確認',exact:true}).click();await page.getByRole('button',{name:'変更を保存する',exact:true}).click();await page.getByRole('button',{name:'確認して実行',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('自動では再送しません');await expect(page.getByRole('button',{name:'注文内容を編集',exact:true})).toBeVisible();expect(state.edits).toHaveLength(2);
});
test('管理者の見積が期限切れになったら確定操作を止め、再確認を求める',async({page})=>{
 const state=await setup(page,{quoteTtl:1500});const dialog=await openCreate(page);
 await dialog.getByRole('button',{name:'送料・合計を確認',exact:true}).click();
 await expect(dialog.getByRole('button',{name:'注文を登録する',exact:true})).toBeEnabled();
 await expect(dialog.getByRole('alert')).toContainText('見積の有効時間が切れました');
 await expect(dialog.getByRole('button',{name:'注文を登録する',exact:true})).toBeDisabled();expect(state.creates).toHaveLength(0);
});
test('通信断後の照会で別内容の注文が見つかったら自動で成功へ進めない',async({page})=>{
 const state=await setup(page,{createMode:'unknown'});await openCreate(page);await confirmCreate(page);
 await page.getByRole('button',{name:'確認して注文を登録',exact:true}).click();
 const pending=page.getByRole('dialog',{name:'注文の受付結果を確認',exact:true});await expect(pending).toBeVisible();
 await expect.poll(()=>state.lookups).toBeGreaterThan(0);
 state.order.items[0].quantity=9;state.order.total_amount=19800;state.lookupFound=true;
 await pending.getByRole('button',{name:'受付結果を確認する',exact:true}).click();
 await expect(pending).toContainText('今回の変更内容を受け付けたという意味ではありません');
 await expect(pending.getByRole('button',{name:'同じ内容で再送する',exact:true})).toHaveCount(0);
 await expect(page).toHaveURL(/\/admin\/orders\?create=1$/);expect(state.creates).toHaveLength(1);
});
