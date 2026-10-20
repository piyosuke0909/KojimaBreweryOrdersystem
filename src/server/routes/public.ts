import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../types';
import type { Context } from 'hono';
import { resolveActor, verifySession } from '../auth';
import { routerError, rows, settings } from '../services/common';
import { invitationLookup } from '../services/invitations';
export const publicRoutes=new Hono<AppEnv>();
publicRoutes.onError(routerError);
publicRoutes.get('/products',async c=>c.json({data:await rows(c.env.DB,"SELECT id,name,category,volume_ml,unit,image_url,short_description,description,commitment,taste,recommended_way,sales_status FROM products WHERE is_limited=0 AND sales_status!='unavailable' ORDER BY sort_order,name")}));
publicRoutes.get('/contact',async c=>{const config=await settings(c.env.DB);return c.json({data:{phone:config.contact_phone,email:config.contact_email,hours:config.contact_hours,note:config.contact_note||''}});});
async function lookup(c:Context<AppEnv>,token:string) {
  const invitation=await invitationLookup(c.env.DB,token,false);
  const payload=await verifySession(getCookie(c,'kojima_session')||'',c.env);
  const who=payload?await resolveActor(c.env,payload):null;
  const alreadyRegistered=who?.type==='customer' && who.company_id===invitation.company_id;
  const differentCompany=who?.type==='customer' && who.company_id!==invitation.company_id;
  const full=invitation.max_uses!=null && invitation.used_count>=invitation.max_uses;
  return c.json({data:{company_name:invitation.company_name,expires_at:invitation.expires_at,usable:!differentCompany && (!full || alreadyRegistered),full,already_registered:alreadyRegistered,different_company:differentCompany}});
}
publicRoutes.get('/invitations/lookup',c=>lookup(c,c.req.query('t')||''));
publicRoutes.get('/invitations/:token',c=>lookup(c,c.req.param('token')));
