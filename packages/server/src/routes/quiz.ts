/**
 * routes/quiz — 出题薄路由（只剩 `/generate` 一条）。
 *
 * ★ 2026-09-26 题库整族下线（老板判决：线上实测无人使用，且它是依附对话核的派生产品线）：
 *   `/bank*`（列表/读取/删组/逐题剔除）、`/collect/*`（现场搜集两段）、`/analyze/:id`（薄弱点分析）、
 *   `/stats/record`（逐题统计）四条随页面一起断线，契约面见 `docs/QUIZ-WEAK-SPEC.md` 与
 *   `docs/RESOURCE-SPEC.md` 的墓碑。**留下的只有「出题」这一个动作**，因为它是聊天内核与
 *   对战共用的出口（`chat/tools/generate-quiz.ts` 与 `pk/match.ts` 走的是同一台引擎）。
 * ★ 随之下线的是**落库**，不是题卡：本路由出卡仍走 `announceQuizToSession`（会话里看得见、
 *   刷新可还原），只是 `quizId` 从 2026-09-26 起是**本次调用的临时 id**，不再有 `quiz_bank` 行。
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadQuizMix } from '../learning/quiz.js';
import { loadQuizSourceMix } from '../learning/quiz-source-mix.js';
import { generateBlendedQuiz } from '../learning/quiz-blend.js';
import { announceQuizToSession } from '../learning/quiz-announce.js';
import { announceScenarioToSession, generateScenario } from '../learning/scenario.js';
import { emptyScenarioGenReport } from '../learning/scenario-protocol.js';
import {
  normalizeQuizMix,
  normalizeQuizSourceMix,
  normalizeAnswerStyle,
  mixTotal,
  sourceMixTotal,
  emptyQuizImageReport,
  countQuizImages,
  type ScenarioMixResult,
} from '@sb/shared';
import { roleReady } from '../llm/router.js';
import { getSessionDoc, buildDocMaterial } from '../learning/document.js';
import { publishEvent } from '../events/bus.js';
import { ownerIdOf } from '../auth/ownership.js';

export const quizRouter = Router();

/**
 * 一键出题：{ topic, material?, sessionId?, mix?, style? } → 生成→裁剪→（可选）入会话消息流→返回题目。
 * mix 省略 = 用设置页存的全局配比；传了按传的归一化（两处出题共用一套语义）。
 * style 同理：本次显式传了就覆盖库内偏好（L1 选项卡选完那一次出题靠它）。
 * 出不够不静默补题、图没出也不静默：响应带 mix / images 两份报告，UI 如实告知（ADR-5）。
 * ★ `save` 参数随题库下线一并摘除——它曾是「这次要不要写进题库」的开关，现在没有人能翻题库。
 */
quizRouter.post('/generate', async (req: Request, res: Response) => {
  const { topic, material, sessionId, mix, style, search, sourceMix } = req.body as {
    topic?: string;
    material?: string;
    sessionId?: string;
    mix?: unknown;
    style?: unknown;
    /** 本次是否联网检索（省略＝不联网；两条 UI 入口与 PK 显式传，契约 docs/QUIZ-SEARCH-SPEC.md §2.2） */
    search?: boolean;
    /**
     * 本次的**真题**配比（省略＝用设置页存的那份；契约 docs/QUIZ-BLEND-SPEC.md §3.1）。
     * 纯加法：省略即旧行为（不出真题）。
     */
    sourceMix?: unknown;
  };
  // 文档模式回退（契约 5.0 §5.1-5 + §5.1.1）：未显式给材料时用本会话载入的资料出题，
  // 故必须在校验前算——否则「只传 sessionId、对话还是空的」会被误判为无材料。
  // 长资料按出题主题检索相关段落（出题拿得到 topic 作查询，§3.4）；短资料仍是全文。
  // `generateQuiz` 自带的材料上限仍是堆叠安全网，不靠它截正确内容。
  // ★ 带归属：别人的会话取不到资料 ⇒ 回退链自然断开（拿别人的资料出题＝泄露，2026-09-21 闸门 #2）
  const docFallback = material?.trim() || !sessionId ? null : getSessionDoc(sessionId, ownerIdOf(req));
  const effectiveMaterial =
    material?.trim() || (docFallback ? buildDocMaterial(docFallback, topic ?? '') : undefined);
  if (!topic && !effectiveMaterial) {
    res.status(400).json({ error: 'topic 或 material 必填' });
    return;
  }
  try {
    // 真题配比（契约 docs/QUIZ-BLEND-SPEC.md §3.1）：省略＝读设置页存的那份。
    // ★ 两遍归一（顺序不能省）：AI 配比的「纯真题组例外」（显式全 0 + 真题配了题 ⇒ 不回退默认）
    //   要拿真题总额当输入；真题的**联合钳位**又要拿 AI 配比当输入——先用零 AI 配比出真题
    //   **形状**（只当例外判据，0 就是 0、正数经单档钳位还是正数），再定 AI 配比，最后对真题做正式钳位。
    const savedReal = sourceMix === undefined ? loadQuizSourceMix(ownerIdOf(req)) : undefined;
    const realShape =
      savedReal ?? normalizeQuizSourceMix(sourceMix, { single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 });
    const requested = mix === undefined ? loadQuizMix(ownerIdOf(req)) : normalizeQuizMix(mix, realShape);
    const requestedReal = savedReal ?? normalizeQuizSourceMix(sourceMix, requested);
    // 情景档（SCENARIO-SPEC §6.1）：五档一张配比卡，但传统四类走一道引擎、情景题走独立引擎
    const scenarioCount = requested.scenario;
    const tradTotal = mixTotal(requested) - scenarioCount;

    /** 逐套生成情景题：每套成功即广播+进会话流，失败如实记账不整体作废（ADR-5） */
    const genScenarios = async (count: number): Promise<ScenarioMixResult[]> => {
      const results: ScenarioMixResult[] = [];
      for (let i = 0; i < count; i++) {
        const report = emptyScenarioGenReport();
        // M2c：情景题生成是一次 LLM 调用，归属取当前用户（未登录 ⇒ null = 平台通道）
        const gen = await generateScenario(topic ?? '综合', effectiveMaterial, report, ownerIdOf(req));
        if (!gen) {
          results.push({ ok: false, failure: report.failure ?? 'parse' });
          continue;
        }
        publishEvent({ type: 'quiz_generated', quizId: gen.quizId, ownerId: ownerIdOf(req) });
        if (sessionId) announceScenarioToSession(sessionId, gen);
        results.push({ ok: true, quizId: gen.quizId, demoId: gen.demoId });
      }
      return results;
    };

    // 纯情景配比：传统四档全 0 **且没配真题**时不跑传统引擎——喂全 0 配比只会得到空题组 → 假 502
    // （配了真题就必须走下面的合流，否则用户按题型配的真题会被整段跳过）
    if (tradTotal === 0 && sourceMixTotal(requestedReal) === 0) {
      const scenarios = await genScenarios(scenarioCount);
      const zeros = { single: 0, multiple: 0, fill: 0, essay: 0, judge: 0 };
      res.json({
        scenarios,
        images: emptyQuizImageReport(),
        mix: { requested: { ...zeros }, actual: { ...zeros }, matched: true },
      });
      return;
    }

    const images = emptyQuizImageReport();

    // 未显式给风格时传 undefined，由 generateQuiz 自己读库内偏好（只读一处，不在此提前定级）
    const styleArg = style === undefined ? undefined : normalizeAnswerStyle(style);
    // 来源**合流**（契约 docs/QUIZ-BLEND-SPEC.md §3.3）：AI 侧仍是既有的 generateQuiz，真题侧走
    // collectQuiz（检索→抓页→逐字摘录→verbatim 锁），两层各自尽力后在 blend 层拼成一个题组。
    // 真题侧任何失败都**不阻断**出题（ADR-4），缺口如实写进报告（拍板 D3：报缺不补）。
    const blended = await generateBlendedQuiz(
      topic ?? '综合',
      effectiveMaterial,
      requested,
      requestedReal,
      images,
      styleArg,
      search === true,
      ownerIdOf(req),
    );
    // 502 按**真因**分开说：v1.0 把「模型不可用 / JSON 解不出 / 配比裁空」混成一句，照着重试永远调不对（契约 §2.4）
    if (!blended.quiz) {
      // 2026-09-13 再拆一层：「出题模型压根没配」与「配了但输出没解析出来」是两条完全不同的行动指引。
      // 2026-09-20 合流后第三层的判定**不能再用 images.failure 猜**：老桩/异常路径下引擎返回 null
      // 却没回填 failure，会把「解析不出」误报成「配比裁空」（全量回归抓过）。改用 blend 报告精确区分——
      // 引擎返回 null 时 report.ai 还是空报告（matched=true）；返回了但被裁空时 report.ai.matched=false。
      const notConfigured = images.failure === 'no-model';
      const aiRan = mixTotal(requested) > 0;
      const trimmedEmpty = aiRan && !notConfigured && images.failure !== 'parse' && !blended.report.ai.matched;
      // 纯真题组（AI 侧一档没配）一道都没摘到：题目全无，但真因是「网上没摘到」——
      // 说「模型解析不出」是指鹿为马（模型根本没被调用）
      const pureRealEmpty = !aiRan && sourceMixTotal(requestedReal) > 0;
      res.status(502).json({
        error: notConfigured
          ? `出题失败：${roleReady('quiz-generator', ownerIdOf(req)).reason || '出题模型没配好'}——请到「设置」→「角色模型绑定」为「出题」绑定模型后再试`
          : trimmedEmpty
            ? `出题失败：模型出的题经配比裁剪后一题不剩（要求共 ${mixTotal(requested)} 道，可重试或到设置页改配比）`
            : pureRealEmpty
              ? '出题失败：真题一道都没摘到（网上没有可逐字摘录的可用题），本次也未要求 AI 出题——可到设置页把题型配回 AI 侧'
              : '出题失败：模型输出没能解析成题目（可重试；若反复失败，到设置页给「出题」换一个更强的模型）',
      });
      return;
    }
    const quiz = blended.quiz;
    // 交付图数在裁剪**后**数：模型画了 3 张、被配比裁剩 1 张带图的题，就只报 1
    images.delivered = countQuizImages(quiz);
    // ★ 临时 id（2026-09-26 题库下线）：它只用于两处——SSE 的 `blockId` 与 `quiz_generated` 事件，
    //   不再对应任何 `quiz_bank` 行。留着它的理由不是「以后要查」，是**删键要撞现网在途会话**：
    //   `quiz-announce.ts` 的 blockId 形状与事件契约都带它，那属 SSE 契约两侧同改，另批走。
    const quizId = randomUUID();
    publishEvent({ type: 'quiz_generated', quizId, ownerId: ownerIdOf(req) });
    // 出卡走唯一门面（`learning/quiz-announce.ts`）：聊天侧 `generate_quiz` 工具用的是同一个函数，
    // 两处各写一份就是 blockId / 登记行 content / 前端还原解析三口径漂移的来源（2026-09-23 收口）
    if (sessionId) announceQuizToSession(sessionId, quiz, quizId);
    // 情景档在传统题之后逐套出（顺序即 MIX_KINDS 档位序）；每套成败如实进响应
    const scenarios = scenarioCount > 0 ? await genScenarios(scenarioCount) : undefined;
    // `mix` 仍是 AI 侧报告（前端既有 shortfallText 读的就是它，**向后兼容零改动**）；
    // `blend` 是本次新增的合流报告（真题侧要/摘/缺 + 逐页抓取记录），前端读它渲染报缺文案。
    res.json({ quizId, quiz, mix: blended.report.ai, images, blend: blended.report, ...(scenarios ? { scenarios } : {}) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
