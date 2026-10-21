import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { actor, body, fail, routerError, string } from '../services/common';
import { previewGoogleDriveImage } from '../services/google-drive-image';

export const productImagePreviewRoutes = new Hono<AppEnv>();
productImagePreviewRoutes.onError(routerError);
productImagePreviewRoutes.post('/', async c => {
  if (actor(c)?.type !== 'admin') fail(403, 'ADMIN_REQUIRED', '管理者ログインが必要です。');
  c.header('Cache-Control', 'no-store');
  const input = await body(c);
  return previewGoogleDriveImage(string(input.image_url, '商品画像URL', true, 10000));
});
