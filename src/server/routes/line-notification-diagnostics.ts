import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { actor,fail,routerError,string } from '../services/common';
import { lineNotificationDiagnostics } from '../services/line-notification-diagnostics';

export const lineNotificationDiagnosticRoutes=new Hono<AppEnv>();
lineNotificationDiagnosticRoutes.onError(routerError);
lineNotificationDiagnosticRoutes.use('*',async(c,next)=>{
  c.header('Cache-Control','no-store');
  const who=actor(c);
  if(!who||who.type!=='admin'||who.role!=='owner')fail(403,'OWNER_REQUIRED','LINE通知の診断はオーナー管理者のみ利用できます。');
  await next();
});
lineNotificationDiagnosticRoutes.get('/',async c=>{
  const companyId=string(c.req.query('company_id'),'取引先',true,128);
  return c.json({data:await lineNotificationDiagnostics(c.env,companyId)});
});
