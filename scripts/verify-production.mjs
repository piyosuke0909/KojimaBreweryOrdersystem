import { readFileSync, writeFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const file=resolve(root,'.local/production-admin-credentials.json');
const owner=JSON.parse(readFileSync(file,'utf8'));
if(!owner.url?.startsWith('https://'))throw new Error('Confirmed HTTPS production URL is required.');
const check=(condition,message)=>{if(!condition)throw new Error(message);};
async function request(path,body,cookie){
 const response=await fetch(owner.url+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 let value;try{value=await response.json();}catch{value={};}
 return {status:response.status,data:value.data,error:value.error,cookie:response.headers.get('set-cookie')};
}
const health=await request('/api/health');check(health.status===200&&health.data?.database==='ok'&&health.data?.environment==='production','Live production health failed.');
const config=await request('/api/config');check(config.status===200&&config.data?.demo_enabled===false,'Production demo flag must be false.');
check((await request('/api/admin/dashboard')).status===401,'Anonymous admin access was not denied.');
check((await request('/api/auth/demo/admin',{})).status===403,'Admin demo login was not denied.');
check((await request('/api/auth/demo/customer',{})).status===403,'Customer demo login was not denied.');
check((await request('/api/auth/admin/login',{login_id:owner.login_id,password:'incorrect-production-password'})).status===401,'Invalid password was not denied.');
const login=await request('/api/auth/admin/login',{login_id:owner.login_id,password:owner.password});
check(login.status===200&&login.data?.actor?.type==='admin'&&login.data?.actor?.role==='owner','Owner password login failed.');
check(login.cookie?.includes('HttpOnly')&&login.cookie.includes('Secure')&&login.cookie.includes('SameSite=Strict'),'Secure session cookie attributes are missing.');
const cookie=login.cookie.split(';')[0];
const me=await request('/api/auth/me',null,cookie);check(me.status===200&&me.data?.actor?.id===login.data.actor.id,'Live admin session validation failed.');
const dashboard=await request('/api/admin/dashboard',null,cookie);check(dashboard.status===200&&dashboard.data?.new_orders===0,'Initial dashboard contains orders or is unavailable.');
const products=await request('/api/admin/products',null,cookie);check(products.status===200&&products.data.length===11&&products.data.every(product=>product.sales_status==='unavailable'),'Production products must start unavailable.');
const companies=await request('/api/admin/companies',null,cookie);check(companies.status===200&&companies.data.length===0,'Production must not contain fake customers.');
const publicProducts=await request('/api/public/products');check(publicProducts.status===200&&publicProducts.data.length===0,'Unavailable products must not be offered.');
const logout=await request('/api/auth/logout',{},cookie);check(logout.status===200&&logout.cookie?.includes('Max-Age=0'),'Logout did not clear the cookie.');
const page=await fetch(owner.url+'/admin',{signal:AbortSignal.timeout(20000)});check(page.status===200&&(await page.text()).includes('受注ポータル'),'Production admin HTML is unavailable.');
owner.verified_at=new Date().toISOString();writeFileSync(file,JSON.stringify(owner,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({status:'verified',url:owner.url,health:'ok',demo_logins:'blocked',anonymous_admin:'blocked',owner_login:'passed',secure_cookie:'passed',admin_products:products.data.length,fake_companies:companies.data.length,public_orderable_products:0,line_configured:!!config.data.liff_id,logout:'passed'},null,2));
