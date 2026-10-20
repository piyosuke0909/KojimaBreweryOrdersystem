// Small idempotent production seed over the documented D1 query API, without bulk object uploads.
import { readFileSync } from 'node:fs';
const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const id=config.env?.production?.d1_databases?.find(binding=>binding.binding==='DB')?.database_id;
const account=config.account_id??process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(!token||!account||!id||id.startsWith('00000000-')){console.error('Authenticated production D1 configuration is required.');process.exit(2);}
const source=readFileSync(new URL('../seeds/production.sql',import.meta.url),'utf8');
// SQL strings may contain semicolons and doubled quotes; strip only real line comments.
const statements=[];let part='',quote=null,comment=false;
for(let i=0;i<source.length;i++){
 const char=source[i],next=source[i+1];
 if(comment){if(char==='\n'){comment=false;part+='\n';}continue;}
 if(quote){part+=char;if(char===quote){if(next===quote){part+=next;i++;}else quote=null;}continue;}
 if(char==='-'&&next==='-'){comment=true;i++;continue;}
 if(char==='\''||char==='"'){quote=char;part+=char;continue;}
 if(char===';'){if(part.trim())statements.push(part.trim());part='';}else part+=char;
}
if(part.trim())statements.push(part.trim());
let applied=0;
for(const sql of statements){
 if(/^PRAGMA\s/i.test(sql))continue;
 if(!/^INSERT OR IGNORE INTO\s/i.test(sql))throw new Error('Production seed must use non-overwriting INSERT OR IGNORE statements.');
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${id}/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({sql}),signal:AbortSignal.timeout(20000)});
 const result=await response.json();
 if(!response.ok||!result.success||result.result?.some(item=>item.success===false)){console.error(JSON.stringify({status:'seed_failed',http:response.status,error_codes:result.errors?.map(error=>error.code),completed_statements:applied}));process.exit(1);}
 applied++;
}
console.log(JSON.stringify({status:'production_seed_applied',statements:applied,database_id:id,existing_records:'preserved'}));
