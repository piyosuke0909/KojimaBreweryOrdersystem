import { readFileSync } from 'node:fs';
const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const production=config.env?.production;
const adminOnly=process.argv.includes('--admin-only');
const database=production?.d1_databases?.find(db=>db.binding==='DB');
const errors=[];
if(!database?.database_id||/^0+-/.test(database.database_id))errors.push('wrangler.jsonc の env.production.d1_databases に本番DB（binding=DB）を設定してください。');
if(production?.vars?.APP_ENV!=='production'||production?.vars?.ALLOW_DEMO_AUTH!=='false')errors.push('本番の APP_ENV=production、ALLOW_DEMO_AUTH=false が必要です。');
if(!adminOnly&&(!production?.vars?.LIFF_ID||!production?.vars?.LINE_CHANNEL_ID))errors.push('本番varsに LIFF_ID と LINE_CHANNEL_ID を設定してください。');
if(errors.length){for(const error of errors)console.error(error);process.exit(1);}
console.log(adminOnly?'Admin setup deployment configuration verified. Customer LINE ordering remains unavailable until LINE configuration is completed.':'Production configuration structure verified. Check Workers secrets and real LINE connectivity before publication.');
