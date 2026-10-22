import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { actor,body,fail } from '../services/common';
import { disconnectGmail,finishGmailAuthorization,getMailSettings,saveMailSettings,startGmailAuthorization,testMailSettings } from '../services/email';

export const emailRoutes=new Hono<AppEnv>();
emailRoutes.use('*',async(c,next)=>{if(actor(c)?.role!=='owner')fail(403,'OWNER_REQUIRED','メール連携の設定はオーナー管理者のみ操作できます。');await next();});
emailRoutes.get('/',async c=>c.json({data:await getMailSettings(c.env,new URL(c.req.url).origin)}));
emailRoutes.put('/',async c=>c.json({data:await saveMailSettings(c.env,actor(c),await body(c),new URL(c.req.url).origin)}));
emailRoutes.post('/gmail/start',async c=>c.json({data:await startGmailAuthorization(c.env,actor(c),new URL(c.req.url).origin)}));
emailRoutes.post('/gmail/finish',async c=>c.json({data:await finishGmailAuthorization(c.env,actor(c),await body(c),new URL(c.req.url).origin)}));
emailRoutes.post('/gmail/disconnect',async c=>c.json({data:await disconnectGmail(c.env,actor(c),new URL(c.req.url).origin)}));
emailRoutes.post('/test',async c=>c.json({data:await testMailSettings(c.env,actor(c))}));
