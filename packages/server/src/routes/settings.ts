/**
 * routes/settings — 设置域的 HTTP 端点：搜索 key / 出题配比 / 配图开关 / 回答方式 / 词条朗读。
 *
 * ★ **为什么从 `routes.ts` 拆出来**：`routes.ts` 是本仓最大的集成点（会话 CRUD / 服务商 CRUD /
 *   反馈环 / 设置全在一处），本批加「词条朗读」三端点后触 `server/.ts ≤400` 红线。
 *   按仓规**拆文件、不压注释**（同 `chat/tools.ts → chat/tools/`、`db.ts → migrations.ts`、
 *   `search/index.ts` 的 `htmlToText` 先例）。判据＝**两块东西的修改频率或增长方向不同 → 拆**：
 *   设置域是「每加一个设置项就多一组 GET/PUT/DELETE」的独立增长块，与会话/服务商 CRUD 的
 *   节奏并不相干。
 * ★ `routes.ts` 改为 **re-export**（`export { settingsRouter } from './routes/settings.js'`），
 *   保住 `index.ts` 里 `app.use('/api/settings', settingsRouter)` 的既有调用方零改动
 *   ——同 `validateStepParams` 上提 shared 后服务端文件只 re-export 的既有手法。
 * ★ 本文件**零业务逻辑**（ADR-3）：只做参数校验与「调 storage / search / learning」，与拆分前逐字一致。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { searchWeb, listKeyStatus, saveProviderKey, KEYED_PROVIDERS } from '../search/index.js';
import { loadQuizMix, saveQuizMix, loadQuizImage, saveQuizImage } from '../learning/quiz.js';
import {
  loadAnswerStyle,
  saveAnswerStyle,
  resetAnswerStyle,
  isAnswerStyleConfigured,
} from '../storage/answer-style.js';
import { loadSpeechSettings, saveSpeechSettings, resetSpeechSettings } from '../storage/speech.js';
import { DEFAULT_ANSWER_STYLE, DEFAULT_SPEECH_SETTINGS, normalizeQuizMix } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';

// ── settings（搜索 key：密文落库，响应只回状态）──────────────
export const settingsRouter = Router();

settingsRouter.get('/search-keys', (req, res) => {
  res.json({ configured: listKeyStatus(ownerIdOf(req)) });
});

settingsRouter.put('/search-keys', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const patch: Array<{ key: (typeof KEYED_PROVIDERS)[number]; value: string }> = [];
  for (const key of KEYED_PROVIDERS) {
    const value = body[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 300) {
      res.status(400).json({ error: `${key} key 过长（上限 300 字符）` });
      return;
    }
    patch.push({ key, value: trimmed });
  }
  // 先全量校验再落库：避免一个字段超限导致半写状态
  for (const item of patch) saveProviderKey(item.key, item.value, ownerIdOf(req));
  res.json({ ok: true, configured: listKeyStatus(ownerIdOf(req)) });
});

// ── settings：出题题型配比（v30 起**每用户一份**，对话页「出题」与题库页「一键出题」共用）──
settingsRouter.get('/quiz-mix', (req, res) => {
  res.json({ mix: loadQuizMix(ownerIdOf(req)) });
});

settingsRouter.put('/quiz-mix', (req: Request, res: Response) => {
  // 入参一律过归一化（负数/小数/超上限/全 0 都有既定归宿），落库即干净值
  const mix = saveQuizMix(normalizeQuizMix((req.body as { mix?: unknown }).mix), ownerIdOf(req));
  res.json({ ok: true, mix });
});

// ── settings：出题配图开关（契约 docs/QUIZ-IMAGE-SPEC.md §2.2）──
settingsRouter.get('/quiz-image', (req, res) => {
  res.json({ on: loadQuizImage(ownerIdOf(req)) });
});

settingsRouter.put('/quiz-image', (req: Request, res: Response) => {
  // 只认真值，其余一律按关处理（saveQuizImage 内归一化）
  const on = saveQuizImage((req.body as { on?: unknown }).on === true, ownerIdOf(req));
  res.json({ ok: true, on });
});

// ── settings：回答方式偏好（契约 docs/ANSWER-STYLE-SPEC.md §2）──
settingsRouter.get('/answer-style', (req, res) => {
  // configured 是 L1 的开关量：没配过 与 配成默认值 在 style 上看不出区别
  res.json({ style: loadAnswerStyle(ownerIdOf(req)), configured: isAnswerStyleConfigured(ownerIdOf(req)) });
});

settingsRouter.put('/answer-style', (req: Request, res: Response) => {
  // 入参逐字段过归一化（非法/缺失各自回落默认，不 400），回读的是实际落库值
  const style = saveAnswerStyle((req.body as { style?: unknown }).style, ownerIdOf(req));
  res.json({ style, configured: true });
});

settingsRouter.delete('/answer-style', (req, res) => {
  // 删键＝回到「没配过」：下次点出题会重新弹一次选项卡
  resetAnswerStyle(ownerIdOf(req));
  res.json({ style: { ...DEFAULT_ANSWER_STYLE }, configured: false });
});

// ── settings：词条朗读（音色 / 语速；契约 shared/src/speech.ts）──
settingsRouter.get('/speech', (req, res) => {
  res.json({ settings: loadSpeechSettings(ownerIdOf(req)) });
});

settingsRouter.put('/speech', (req: Request, res: Response) => {
  // 入参一律过归一化（rate 钳到 0.5–2.0、voiceName 超长回落默认），回读的是实际落库值
  // ★ voiceName 的**合法性判定在客户端**：候选集是「这台机器装了什么语音包」的函数，
  //   服务端数不出来，故这里只做结构校验、永不 400（ADR-6 数据容错）
  const settings = saveSpeechSettings((req.body as { settings?: unknown }).settings, ownerIdOf(req));
  res.json({ ok: true, settings });
});

settingsRouter.delete('/speech', (req, res) => {
  // 删键＝回到「系统默认英文音色 + 正常语速」，即本功能引入前的行为
  resetSpeechSettings(ownerIdOf(req));
  res.json({ settings: { ...DEFAULT_SPEECH_SETTINGS } });
});

/** 搜索连通性自检：真发一次（国产网络可用性必须实测，不接受纸面判断；绕缓存才叫自检）。 */
settingsRouter.post('/search/test', async (req: Request, res: Response) => {
  const query = String((req.body as { query?: unknown }).query ?? '学习 方法').slice(0, 80);
  try {
    // ★ 自检必须用**请求者自己的** key：用别人的 key 自检，通过与否都不代表他的配置可用
    const { results, providers, failed } = await searchWeb(query, ownerIdOf(req), { skipCache: true });
    res.json({ ok: results.length > 0, count: results.length, providers, failed });
  } catch (err) {
    res.json({ ok: false, count: 0, providers: [], failed: [err instanceof Error ? err.message : String(err)] });
  }
});
