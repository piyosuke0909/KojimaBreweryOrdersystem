// Initial owner deployment. Cloudflare API token is read only from the process environment.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
if(!process.env.CLOUDFLARE_API_TOKEN){console.error('Secure CLOUDFLARE_API_TOKEN binding is required.');process.exit(2);}
const checked=spawnSync(process.execPath,['scripts/check-production.mjs','--admin-only'],{stdio:'inherit'});
if(checked.status!==0)process.exit(checked.status??1);
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
const production=config.env.production,account=config.account_id??process.env.CLOUDFLARE_ACCOUNT_ID;
const db=production.d1_databases.find(binding=>binding.binding==='DB');
mkdirSync('.local',{recursive:true});
const credentialFile=resolve('.local/production-admin-credentials.json');
let owner;
if(existsSync(credentialFile)){
 owner=JSON.parse(readFileSync(credentialFile,'utf8'));
 if(owner.account_id!==account||owner.database_id!==db.database_id)throw new Error('Existing private credentials belong to another deployment.');
}else{
 owner={account_id:account,database_id:db.database_id,worker_name:production.name,login_id:'admin',password:randomBytes(24).toString('base64url'),created_at:new Date().toISOString()};
 writeFileSync(credentialFile,JSON.stringify(owner,null,2)+'\n',{mode:0o600,flag:'wx'});
}
chmodSync(credentialFile,0o600);
const secrets={SESSION_SECRET:randomBytes(48).toString('base64url'),ADMIN_BOOTSTRAP_PASSWORD:owner.password};
// The OS pipe contains the secret upload; there is no secret upload file on disk.
const child=spawn('/bin/bash',['-c','set -o pipefail; cat | node scripts/wrangler.mjs deploy --env production --secrets-file /dev/stdin'],{cwd:root,env:process.env,stdio:['pipe','inherit','inherit']});
child.stdin.end(JSON.stringify(secrets));
const exit=await new Promise(resolve=>child.on('exit',code=>resolve(code??1)));
if(exit!==0)process.exit(exit);
const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,{headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`},signal:AbortSignal.timeout(20000)});
const result=await response.json();
if(response.ok&&result.success&&result.result?.subdomain){
 owner.url=`https://${production.name}.${result.result.subdomain}.workers.dev`;
 writeFileSync(credentialFile,JSON.stringify(owner,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'admin_deployed',url:owner.url,private_credentials_file:'.local/production-admin-credentials.json',line_ordering_ready:false}));
}else console.log(JSON.stringify({status:'worker_uploaded',private_credentials_file:'.local/production-admin-credentials.json',workers_subdomain_verified:false,line_ordering_ready:false}));
