/**
 * 服务入口：Express :18791 仅绑 127.0.0.1（纯本地单用户形态，ADR-1）。
 * routes/ 薄路由层 + SSE 广播；chat 域编排见 chat/flow.ts。
 */
import express from 'express';
import cors from 'cors';
import { securityHeaders, originCheck, isAllowedOrigin } from './security.js';
import { sessionsRouter, chatRouter, providersRouter, initChatInfra } from './routes.js';
import { getDb } from './storage/db.js';
import type { StatusResponse } from '@sb/shared';
import { VERSION } from './version.js';

const PORT = Number(process.env.SB_PORT ?? 18791);
const HOST = '127.0.0.1';

const app = express();
export { app };

app.disable('x-powered-by');
app.use(securityHeaders);
app.use(
  cors({
    // 无 Origin（curl/同源）不设 CORS 头即可；跨源合法性由 originCheck 对写操作强制
    origin: (origin, cb) => {
      if (origin === undefined || isAllowedOrigin(origin)) cb(null, true);
      else cb(new Error('Not allowed by CORS'));
    },
    credentials: false,
  }),
);
app.use(express.json({ limit: '2mb' })); // 防大 payload DoS（继承 v1）
app.use('/api', originCheck);

app.get<never, StatusResponse>('/api/status', (_req, res) => {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number }).c;
  res.json({ hasProviders: count > 0, version: VERSION });
});

app.use('/api/sessions', sessionsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/providers', providersRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

export function startServer(port = PORT) {
  return app.listen(port, HOST);
}

// 直接运行时启动（tsx src/index.ts）；测试导入时不自动监听
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  initChatInfra();
  startServer();
  // eslint-disable-next-line no-console -- 启动横幅是进程日志，非调试输出
  console.log(`[sb-server] listening on http://${HOST}:${PORT} (v${VERSION})`);
}
