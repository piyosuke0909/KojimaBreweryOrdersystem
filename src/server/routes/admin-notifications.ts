import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { actor } from '../services/common';
import { listAdminNotifications,listCompanyUnreadNotifications,readAdminNotification,readAllAdminNotifications } from '../services/admin-notifications';

export const adminNotificationRoutes=new Hono<AppEnv>();
adminNotificationRoutes.get('/',async c=>c.json({data:await listAdminNotifications(c.env.DB,actor(c).id)}));
adminNotificationRoutes.get('/companies',async c=>c.json({data:await listCompanyUnreadNotifications(c.env.DB,actor(c).id,c.req.query('company_ids'))}));
adminNotificationRoutes.post('/read-all',async c=>{await readAllAdminNotifications(c.env.DB,actor(c).id);return c.json({data:await listAdminNotifications(c.env.DB,actor(c).id)});});
adminNotificationRoutes.post('/:id/read',async c=>{await readAdminNotification(c.env.DB,actor(c).id,c.req.param('id'));return c.json({data:await listAdminNotifications(c.env.DB,actor(c).id)});});
