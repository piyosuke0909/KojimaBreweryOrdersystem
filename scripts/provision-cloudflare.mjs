// Run with Node.js 24's environment proxy support so scoped platform credentials stay in the proxy.
// Does not log tokens, modify existing databases, delete resources, or publish the application.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token){
  console.error('Cloudflare は未認証です。環境設定の CLOUDFLARE_API_TOKEN に、アカウント情報の読取り・D1編集・Workers Scripts編集を許可したAPIトークンを安全に登録してください。値をチャットには貼らないでください。');
  process.exit(2);
}
const apply=process.argv.includes('--apply');
async function api(path,body){
  const response=await fetch(`https://api.cloudflare.com/client/v4${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  let result;try{result=await response.json();}catch{throw new Error(`Cloudflare API ${response.status}: 読み取れる応答がありません。`);}
  if(!response.ok||!result.success){
    const codes=(result.errors??[]).map(error=>error.code).join(',');
    throw new Error(`Cloudflare API ${response.status}（code: ${codes||'unknown'}）。トークンの権限と宛先の許可を確認してください。`);
  }
  return result.result;
}
try{
  const accounts=await api('/accounts?per_page=50');
  let accountId=process.env.CLOUDFLARE_ACCOUNT_ID;
  if(accountId&&!accounts.some(account=>account.id===accountId))throw new Error('指定されたアカウントは、このトークンで参照できません。');
  if(!accountId){
    if(accounts.length!==1){
      console.log(JSON.stringify({accounts:accounts.map(({id,name})=>({id,name}))},null,2));
      throw new Error('アカウントを一意に特定できません。対象の CLOUDFLARE_ACCOUNT_ID を指定してください。');
    }
    accountId=accounts[0].id;
  }
  mkdirSync(resolve(root,'.local'),{recursive:true});
  const file=resolve(root,'.local/cloudflare-resource-plan.json');
  const plan=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{account_id:accountId,name:`kojima-brewery-v2-${randomBytes(4).toString('hex')}`,created_at:new Date().toISOString()};
  if(plan.account_id!==accountId)throw new Error('既存のローカル作成計画とアカウントが異なります。計画を確認してください。');
  if(!apply){console.log(JSON.stringify({status:'planned',...plan,next:'npm run cloudflare:provision -- --apply'},null,2));process.exit(0);}
  writeFileSync(file,JSON.stringify(plan,null,2)+'\n',{mode:0o600});
  if(!plan.database_id){
    const matching=await api(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(plan.name)}`);
    const database=matching.find(database=>database.name===plan.name)??await api(`/accounts/${accountId}/d1/database`,{name:plan.name});
    if(!database.uuid)throw new Error('作成したD1のIDを確認できませんでした。');
    plan.database_id=database.uuid;writeFileSync(file,JSON.stringify(plan,null,2)+'\n',{mode:0o600});
  }
  const configFile=resolve(root,'wrangler.jsonc'),config=JSON.parse(readFileSync(configFile,'utf8'));
  config.account_id=accountId;
  config.env.production.name=plan.name;
  config.env.production.d1_databases=[{binding:'DB',database_name:plan.name,database_id:plan.database_id,migrations_dir:'migrations'}];
  writeFileSync(configFile,JSON.stringify(config,null,2)+'\n');
  console.log(JSON.stringify({status:'database_created_and_configured',account_id:accountId,database_name:plan.name,database_id:plan.database_id,worker_name:plan.name,next:['npm run db:migrate:remote','node scripts/wrangler.mjs d1 execute DB --remote --env production --file seeds/production.sql','Register the new LINE Login/LIFF settings and Workers secrets, then npm run deploy.'],application_published:false},null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
