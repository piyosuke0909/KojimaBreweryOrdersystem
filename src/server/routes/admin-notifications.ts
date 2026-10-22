import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { actor } from '../services/common';
import { listAdminNotifications,readAdminNotification,readAllAdminNotifications } from '../services/admin-notifications';

export const adminNotificationRoutes=new Hono<AppEnv>();
adminNotificationRoutes.get('/',async c=>c.json({data:await listAdminNotifications(c.env.DB,actor(c).id)}));
adminNotificationRoutes.post('/read-all',async c=>{await readAllAdminNotifications(c.env.DB,actor(c).id);return c.json({data:await listAdminNotifications(c.env.DB,actor(c).id)});});
adminNotificationRoutes.post('/:id/read',async c=>{await readAdminNotification(c.env.DB,actor(c).id,c.req.param('id'));return c.json({data:await listAdminNotifications(c.env.DB,actor(c).id)});});
