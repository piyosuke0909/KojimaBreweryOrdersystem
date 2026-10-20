const base=process.env.TEST_BASE_URL||'http://127.0.0.1:8787';
async function request(path,body,cookie){
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const value=await response.json();if(!response.ok)throw new Error(`${path}: ${response.status} ${value.error?.message||''}`);
 return {data:value.data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const health=await request('/api/health'),config=await request('/api/config');
if(health.data.status!=='ok')throw new Error('Database health failed');
const publicProducts=await request('/api/public/products');
if(!Array.isArray(publicProducts.data)||publicProducts.data.some(p=>'standard_price'in p||'unit_price'in p))throw new Error('Public catalog exposes pricing or has invalid shape');
if(!config.data.demo_enabled){console.log('Health and anonymous price isolation verified; demo smoke is disabled on this host.');process.exit(0);}
const admin=await request('/api/auth/demo/admin',{}),customer=await request('/api/auth/demo/customer',{});
const dashboard=await request('/api/admin/dashboard',null,admin.cookie),catalog=await request('/api/customer/catalog',null,customer.cookie),addresses=await request('/api/customer/addresses',null,customer.cookie);
if(!Array.isArray(catalog.data)||!catalog.data.length)throw new Error('No customer products');
const address=addresses.data[0];if(!address)throw new Error('No shipping addresses');
const dates=await request(`/api/customer/delivery-dates?shipping_address_id=${encodeURIComponent(address.id)}`,null,customer.cookie);
const allowed=Array.isArray(dates.data)?dates.data:dates.data.dates;
if(!allowed?.length)throw new Error('No valid delivery dates');
const first=typeof allowed[0]==='string'?allowed[0]:allowed[0].date;
const quote=await request('/api/customer/quote',{shipping_address_id:address.id,desired_delivery_date:first,items:[{product_id:catalog.data[0].id,quantity:2}]},customer.cookie);
if(quote.data.total_amount<=0||!Number.isSafeInteger(quote.data.total_amount))throw new Error('Invalid quote');
const times=[];for(let i=0;i<30;i++){const start=performance.now();await request('/api/admin/dashboard',null,admin.cookie);times.push(performance.now()-start);}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({health:'ok',public_products:publicProducts.data.length,customer_products:catalog.data.length,delivery_dates:allowed.length,quote_total:quote.data.total_amount,dashboard_new_orders:dashboard.data.new_orders,local_dashboard_latency_ms:{requests:times.length,p50:Math.round(times[14]*10)/10,p95:Math.round(times[28]*10)/10},scope:'Local Workers/D1 emulator, seeded development data; not a production or GAS comparison.'},null,2));
