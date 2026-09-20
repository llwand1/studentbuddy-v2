/**
 * 服务入口：Express :18791 仅绑 127.0.0.1（纯本地单用户形态，ADR-1）。
 * routes/ 薄路由层 + SSE 广播；chat 域编排见 chat/flow.ts。
 */
import express from 'express';
import cors from 'cors';
import { securityHeaders, originCheck, isAllowedOrigin } from './security.js';
import { sessionsRouter, providersRouter, settingsRouter, initChatInfra } from './routes.js';
import { chatRouter } from './routes/chat.js';
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
import { imagesRouter } from './routes/images.js';
import { pkRouter } from './routes/pk.js';
import { pkScenarioRouter } from './routes/pk-scenario.js';
import { authRouter } from './routes/auth.js';
import { githubAuthRouter } from './routes/auth-github.js';
import { studyFlowRouter } from './routes/study-flow.js';
import { scenarioRouter } from './routes/scenario.js';
import { coachRouter } from './routes/coach.js';
import { toolsRouter } from './routes/tools.js';
import { searchRouter } from './routes/search.js';
import { ensureSearchIndex } from './search/fts-index.js';
import { registerDefaultExecutors } from './learning/flow-executors.js';
import { startTrendScheduler } from './learning/trend.js';
import { wireActivityEvents } from './learning/activity.js';
import { wireObsEvents } from './storage/obs.js';
import { wireToolStats } from './storage/tool-stats.js';
import { getDb } from './storage/db.js';
import { requireAuth, attachUser } from './auth/middleware.js';
import { REQUIRE_AUTH } from './auth/form.js';
import { purgeExpiredSessions } from './auth/session.js';
import { purgeExpiredCodes } from './auth/codes.js';
import { CHAT_BODY_LIMIT } from '@sb/shared';
import type { StatusResponse } from '@sb/shared';
import { VERSION } from './version.js';

const PORT = Number(process.env.SB_PORT ?? 18791);
/**
 * ★ M2 收口（launch-plan §3.1 闸门 3）：`SB_HOST` 可配。改前硬编码 `'127.0.0.1'` ⇒
 *   容器内只监听回环、Caddy 连不上后端（本机开发无感，上线即挂）。
 */
const HOST = process.env.SB_HOST ?? '127.0.0.1';

const app = express();
export { app };

/**
 * ★ M2 收口（launch-plan §3.1 闸门 1）：`SB_TRUST_PROXY` 打开 Express 的反代信任。
 * 不配时 `req.ip` 恒为 socket 对端（本机部署即真实 IP，行为不变）；反代（Caddy）后必须配，
 * 否则 `req.ip` 恒为反代自身地址 ⇒ 全站共用一个 IP 桶 ⇒ `send-code` 的 IP 限流
 * **静默退化成全站上限**（AUTH-SPEC §4.6 末段的现场证据在 `routes/auth.ts#clientIp`）。
 * ★ 取值透传 Express 语义：`'1'`（＝信任最近 1 跳，单层 Caddy 的标准配法）或
 *   `'loopback'` 等 Express 认的字符串原样生效。**缺省不信任**——盲信
 *   `X-Forwarded-For` 等于把限流的键交给请求方可任意伪造的头。
 */
const TRUST_PROXY = process.env.SB_TRUST_PROXY;
if (TRUST_PROXY) {
  app.set('trust proxy', TRUST_PROXY === '1' ? 1 : TRUST_PROXY);
}

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
// 故按路径分流：其余端点仍是 2mb 原封不动，只把承载图片的这一条抬到 `CHAT_BODY_LIMIT`。
// ★ 该限额与「单张大小 / 张数」是一套账，三个数字同住 `@sb/shared` 的 chat-limits
//   （2026-09-20 收敛）：此前三处各写一遍、靠注释互指，实测已经不平——单张 700 万字符 × 4 张
//   ≈ 28MB > 24mb body ⇒ 4 张各自合法的图一起发会撞 413。改限额去 chat-limits.ts，
//   改完跑 `chat-limits.test.ts` 的「满额请求必须装得进 body」那条，它会告诉你账平不平。
const jsonSmall = express.json({ limit: '2mb' });
const jsonForImages = express.json({ limit: CHAT_BODY_LIMIT });
app.use((req, res, next) => {
  const parser = req.path === '/api/chat/send' ? jsonForImages : jsonSmall;
  parser(req, res, next);
});
app.use('/api', originCheck);

/**
 * 身份**软解析**（契约 docs/TENANCY-SPEC.md §4）：有会话就把用户挂到 `req.authUser`，从不 401。
 *
 * ★ 无条件挂载、且与下面的 `requireAuth` **刻意分开**：数据隔离（`ownerIdOf`）依赖这里解析出的
 *   身份，而它必须在「强制登录开关未开」时也一样工作——否则登录用户的请求 owner 恒为 null，
 *   归属过滤被整体跳过 ⇒ **隔离形同虚设**。强制登录只是部署形态的选择，不影响「我是谁」的解析。
 */
app.use('/api', attachUser);

/**
 * 可选强制鉴权（契约 docs/AUTH-SPEC.md §3）。
 *
 * ★ 默认**关**（`SB_REQUIRE_AUTH` 未设）——只有账号、没有数据隔离时贸然强制鉴权，
 *   会让「所有登录用户互相看到全部数据」（现有 sessions/messages/题库/笔记全是全局表）。
 *   等 M2 把 `user_id` 隔离做完，两者**同一批打开**。
 * ★ 豁免是「必须公开」的白名单：登录端点自身不能要求登录；status/health 是探活。
 * ★ 只管 `/api/*`——非 api 路径（静态/未知路由）放行给各自的处理器，不在这里 401。
 */
function isAuthProtected(path: string): boolean {
  if (!path.startsWith('/api/')) return false;
  return !/^\/api\/(auth(\/|$)|status$|health$)/.test(path);
}

app.use((req, res, next) => {
  if (!REQUIRE_AUTH || !isAuthProtected(req.path)) {
    next();
    return;
  }
  requireAuth(req, res, next);
});

app.get<never, StatusResponse>('/api/status', (_req, res) => {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number }).c;
  res.json({ hasProviders: count > 0, version: VERSION });
});

app.use('/api/auth', authRouter);
// GitHub OAuth（契约 docs/AUTH-SPEC.md §2.8）：与邮箱通道同挂 /api/auth，产出同一种会话
app.use('/api/auth', githubAuthRouter);
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
app.use('/api/images', imagesRouter);
app.use('/api/pk', pkRouter);
// §15.4 B4 情景题两端口（回传判分 / demo 页）：独立路由文件，错误映射仍引 routes/pk.ts 同一份
app.use('/api/pk', pkScenarioRouter);
app.use('/api/choices', choiceRouter);
app.use('/api/study-flow', studyFlowRouter);
app.use('/api/scenario', scenarioRouter);
// v25 复习督促小窗（B+C+E，契约 docs/COACH-SPEC.md）：独立链路，不挂在 /api/chat 上
app.use('/api/coach', coachRouter);
// P3 设置页「工具」卡（契约 TOOL-ECOSYSTEM-SPEC §6.3-4/§4.5）：阈值 + 30 天统计；P4 grants 同挂这里
app.use('/api/tools', toolsRouter);
// 全站全文搜索（契约 docs/FTS-SPEC.md §3.4）：本地库 fts5 检索。
// ★ 与 `/api/settings/search-keys` 无关——那两条管联网搜索，这条查本地数据。
app.use('/api/search', searchRouter);

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
  // 工具统计（P3 §4.5）：订阅 tool_called 落 tool_stats，与 obs 同一订阅位（发布方零感知，ADR-3/4）
  wireToolStats();
  // 学习流：注册六种「学习交互体验」的默认执行器（委派既有单轮编排，见 learning/flow-executors.ts）。
  // ★ 必须在服务开始接请求前注册完——否则第一步推进就会撞「尚未接入执行器」而失败。
  registerDefaultExecutors();
  // 逃生口③（启动清理）：重启后内存里挂起的 Promise 已随进程消失，库里遗留的 pending
  // 方案选择永远等不到答复——不清就会变成前端能捞到、却怎么点都没反应的死卡。
  const swept = sweepStaleChoices();
  // eslint-disable-next-line no-console -- 进程启动日志，与下面的启动横幅同类
  if (swept > 0) console.log(`[sb-server] 已作废 ${swept} 条重启前挂起的方案选择`);
  // 账号：启动兜底清理过期会话（除惰性清理外，保证长跑实例的 auth_sessions 不被过期行撑大）
  purgeExpiredSessions();
  // 账号（M1.5）：同理清理**过期且未消费**的验证码行。
  // ★ 只删"过期且未消费"的——**已消费的行留着**（审计），它们不是垃圾（见 auth/codes.ts）。
  purgeExpiredCodes();
  // 全站搜索（契约 docs/FTS-SPEC.md §3.3）：v37 只建了**空的** `search_index` 表，
  // 老库的历史数据要靠这一步进索引。策略是「索引为空就灌一遍、非空则跳过」——
  // 每次启动都全量重建纯属浪费，而"空则灌"正好覆盖唯一必须灌的那次（升级后首次启动）。
  // ★ 必须在 `startServer()` 之前跑完：索引没灌完时 `/api/search` 会静默返回空，
  //   用户看到的是"搜索功能坏了"，而不是"索引还没建好"（本函数是同步的，天然先于接请求）。
  const indexed = ensureSearchIndex();
  // eslint-disable-next-line no-console -- 进程启动日志，与下面的启动横幅同类
  if (indexed > 0) console.log(`[sb-server] 已为 ${indexed} 条记录建立搜索索引`);
  startServer();
  // 记忆联动 P4（契约 docs/MEMORY-TREND-SPEC.md §4.2）：督促趋势定时器。
  // ★ 放在启动链**最后**：它起服即先跑一次（否则首张图要等 6 小时），但全程 fire-and-forget，
  //   绝不挡在「开始接请求」之前——一段慢查询不该让端口晚半秒可用。
  startTrendScheduler();
  // eslint-disable-next-line no-console -- 启动横幅是进程日志，非调试输出
  console.log(`[sb-server] listening on http://${HOST}:${PORT} (v${VERSION})`);
}
