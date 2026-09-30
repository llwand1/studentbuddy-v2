import express, { type Express } from 'express';
import path from 'node:path';

function isApiPath(value: string): boolean {
  try { return /^\/api(?:\/|$)/i.test(decodeURIComponent(value)); }
  catch { return false; }
}

/** 可选同源网页入口：桌面安装包使用，API-only 部署保持原行为。 */
export function mountStaticWeb(app: Express, directory = process.env.SB_WEB_DIST): void {
  if (!directory) return;
  const root = path.resolve(directory);
  const serve = express.static(root);
  app.use((req, res, next) => {
    if (isApiPath(req.path)) next();
    else serve(req, res, next);
  });
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD')
      || isApiPath(req.path) || path.extname(req.path)) {
      next();
      return;
    }
    res.sendFile(path.join(root, 'index.html'));
  });
}
