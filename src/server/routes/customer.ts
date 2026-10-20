import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { jstDate } from '../../domain';
import { actor, fail, one, routerError, rows, settings } from '../services/common';
import { deliveryDates } from '../services/orders';
import { orderRoutes } from './orders';

export const customerRoutes=new Hono<AppEnv>();
customerRoutes.onError(routerError);
customerRoutes.get('/me',async c=>{
  const who=actor(c);
  const [user,company,config]=await Promise.all([one(c.env.DB,"SELECT * FROM line_users WHERE line_user_id=? AND company_id=? AND status='active'",who.id,who.company_id),one(c.env.DB,'SELECT * FROM companies WHERE id=?',who.company_id),settings(c.env.DB)]);
  return c.json({data:{...user,company,contact:{phone:config.contact_phone,email:config.contact_email,hours:config.contact_hours}}});
});
customerRoutes.get('/catalog',async c=>{
  const today=jstDate(new Date());
  const products=await rows(c.env.DB,`SELECT p.*,COALESCE(cp.unit_price,p.standard_price) AS unit_price,COALESCE(cp.is_available,CASE WHEN p.is_limited=1 THEN 0 ELSE 1 END) AS is_available FROM products p LEFT JOIN company_product_prices cp ON cp.id=(SELECT cpp.id FROM company_product_prices cpp WHERE cpp.company_id=? AND cpp.product_id=p.id AND cpp.status='active' AND cpp.valid_from<=? AND (cpp.valid_to IS NULL OR cpp.valid_to>=?) ORDER BY cpp.valid_from DESC,cpp.id DESC LIMIT 1) WHERE p.sales_status!='unavailable' AND (p.is_limited=0 OR cp.is_available=1) ORDER BY p.sort_order,p.name`,actor(c).company_id,today,today);
  return c.json({data:products.map(({standard_price,note,company_price,...p})=>p)});
});
customerRoutes.get('/addresses',async c=>c.json({data:await rows(c.env.DB,"SELECT * FROM shipping_addresses WHERE company_id=? AND status='active' ORDER BY is_default DESC,name",actor(c).company_id)}));
customerRoutes.get('/delivery-dates',async c=>{
  const addressId=c.req.query('shipping_address_id');
  if(!addressId) fail(400,'INVALID_INPUT','配送先を指定してください。');
  const result=await deliveryDates(c.env.DB,actor(c).company_id!,addressId!);
  return c.json({data:result.dates});
});
orderRoutes(customerRoutes,false);
