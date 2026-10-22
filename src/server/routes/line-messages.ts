import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { actor, body } from '../services/common';
import { lineConversation, lineMessageContacts, readLineMessages, sendLineMessage } from '../services/line-messages';

export const lineMessagesRoutes=new Hono<AppEnv>();
lineMessagesRoutes.get('/companies/:id/line-messages',async c=>c.json({data:await lineMessageContacts(c.env,actor(c),c.req.param('id'))}));
lineMessagesRoutes.get('/companies/:id/line-messages/:lineUserId',async c=>c.json({data:await lineConversation(c.env,c.req.param('id'),c.req.param('lineUserId'),c.req.query('before'),c.req.query('limit'))}));
lineMessagesRoutes.post('/companies/:id/line-messages/:lineUserId',async c=>{
  const result=await sendLineMessage(c.env,actor(c),c.req.param('id'),c.req.param('lineUserId'),await body(c));
  return c.json({data:result.message},result.message.status==='pending'?202:result.created?201:200);
});
lineMessagesRoutes.post('/companies/:id/line-messages/:lineUserId/read',async c=>c.json({data:await readLineMessages(c.env,actor(c),c.req.param('id'),c.req.param('lineUserId'),await body(c))}));
