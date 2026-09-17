/**
 * 服务入口：Express :18791 仅绑 127.0.0.1（纯本地单用户形态，ADR-1）。
 * routes/ 薄路由层 + SSE 广播；chat 域编排见 chat/flow.ts。
 */
import express from 'express';
import cors from 'cors';
import { securityHeaders, originCheck, isAllowedOrigin } from './security.js';
import { sessionsRouter, chatRouter, providersRouter, settingsRouter, initChatInfra } from './routes.js';
import { choiceRouter } from './routes/choice.js';
import { sweepStaleChoices } from './chat/choice.js';
import { quizRouter } from './routes/quiz.js';
import { notesRouter } from './routes/notes.js';
import { termsRouter } from './routes/terms.js';
import { memoryRouter } from './routes/memory.js';
import { documentRouter } from './routes/document.js';
import { activityRouter } from './routes/activity.js';
import { obsRouter } from './routes/obs.js';
import { previewRouter } from './routes/preview.js';
import { pkRouter } from './routes/pk.js';
import { studyFlowRouter } from './routes/study-flow.js';
import { scenarioRouter } from './routes/scenario.js';
import { registerDefaultExecutors } from './learning/flow-executors.js';
import { wireActivityEvents } from './learning/activity.js';
import { wireObsEvents } from './storage/obs.js';
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
    // 无 Origin（curl/同源）不设 CORS 头即可；跨源合法性由 originCheck 对写操作强制。
    // 非法 origin 返回 false 而不是抛错：抛错会让请求变成 500，授权判定应只由 originCheck 出
    origin: (origin, cb) => cb(null, origin === undefined || isAllowedOrigin(origin)),
    credentials: false,
  }),
);
// 防大 payload DoS（继承 v1）——但**只有发图那条路**需要放大：
// `/api/chat/send` 走 base64 内联（零依赖、零静态服务），一张截图 base64 就 2~5MB，
// 沿用 2mb 会让「点了发送没反应」——实测请求根本到不了路由就被 413 打回（v17 踩到）。
// 故按路径分流：其余端点仍是 2mb 原封不动，只把承载图片的这一条抬到 24mb
// （= 单张上限 5MB × 最多 4 张 + 余量，与 chat/vision.ts 的 MAX_DATAURL_CHARS 同一套账）。
const jsonSmall = express.json({ limit: '2mb' });
const jsonForImages = express.json({ limit: '24mb' });
app.use((req, res, next) => {
  const parser = req.path === '/api/chat/send' ? jsonForImages : jsonSmall;
  parser(req, res, next);
});
app.use('/api', originCheck);

app.get<never, StatusResponse>('/api/status', (_req, res) => {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number }).c;
  res.json({ hasProviders: count > 0, version: VERSION });
});

app.use('/api/sessions', sessionsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/providers', providersRouter);
app.use('/api/quiz', quizRouter);
app.use('/api/notes', notesRouter);
app.use('/api/terms', termsRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/doc', documentRouter);
app.use('/api/activity', activityRouter);
app.use('/api/obs', obsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/preview', previewRouter);
app.use('/api/pk', pkRouter);
app.use('/api/choices', choiceRouter);
app.use('/api/study-flow', studyFlowRouter);
app.use('/api/scenario', scenarioRouter);

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
  wireActivityEvents();
  wireObsEvents();
  // 学习流：注册六种「学习交互体验」的默认执行器（委派既有单轮编排，见 learning/flow-executors.ts）。
  // ★ 必须在服务开始接请求前注册完——否则第一步推进就会撞「尚未接入执行器」而失败。
  registerDefaultExecutors();
  // 逃生口③（启动清理）：重启后内存里挂起的 Promise 已随进程消失，库里遗留的 pending
  // 方案选择永远等不到答复——不清就会变成前端能捞到、却怎么点都没反应的死卡。
  const swept = sweepStaleChoices();
  // eslint-disable-next-line no-console -- 进程启动日志，与下面的启动横幅同类
  if (swept > 0) console.log(`[sb-server] 已作废 ${swept} 条重启前挂起的方案选择`);
  startServer();
  // eslint-disable-next-line no-console -- 启动横幅是进程日志，非调试输出
  console.log(`[sb-server] listening on http://${HOST}:${PORT} (v${VERSION})`);
}
