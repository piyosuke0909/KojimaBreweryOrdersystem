import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { actor, fail, routerError } from '../services/common';
import { installLineRichMenu, lineRichMenuStatus, withRichMenuInstallAudit } from '../services/line-rich-menu';

export const lineRichMenuRoutes=new Hono<AppEnv>();
lineRichMenuRoutes.onError(routerError);
lineRichMenuRoutes.use('*',async(c,next)=>{
  const who=actor(c);
  if(!who||who.type!=='admin'||who.role!=='owner')fail(403,'OWNER_REQUIRED','LINEリッチメニューの設定はオーナー管理者のみ操作できます。');
  await next();
});
lineRichMenuRoutes.get('/',async c=>c.json({data:await lineRichMenuStatus(c.env,new URL(c.req.url).origin)}));
lineRichMenuRoutes.post('/install',async c=>c.json({data:await withRichMenuInstallAudit(c.env.DB,actor(c),()=>installLineRichMenu(c.env,new URL(c.req.url).origin))}));
