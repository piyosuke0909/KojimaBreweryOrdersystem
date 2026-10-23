import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { attachSession } from '../auth';
import { actor, body } from '../services/common';
import { executeSystemReset, prepareSystemReset, resetOverview } from '../services/system-reset';
import { guardDatabase } from '../system-state';

const prepareInput = z.object({ current_password: z.string().min(1).max(200) }).strict();
const executeInput = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('初期リセット') }).strict();
export const systemResetRoutes = new Hono<AppEnv>();
systemResetRoutes.get('/', async c => c.json({ data: await resetOverview(c.env, actor(c)) }));
systemResetRoutes.post('/prepare', async c => {
  const input = prepareInput.parse(await body(c));
  return c.json({ data: await prepareSystemReset(c.env, actor(c), input.current_password) });
});
systemResetRoutes.post('/execute', async c => {
  const input = executeInput.parse(await body(c));
  const result = await executeSystemReset(c.env, actor(c), input.token);
  // The preserved owner receives a cookie for the new generation; every earlier cookie is revoked.
  c.env = { ...c.env, DB: guardDatabase(c.env.DB, result.generation) };
  await attachSession(c, result.current);
  return c.json({ data: { reset: result.reset, counts: result.counts, generation: result.generation } });
});
