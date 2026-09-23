/**
 * chat/tools/generate-quiz — `generate_quiz`：**把「出题」这件能力接到聊天模型手里**。
 *
 * ★ 起因（2026-09-23 老板口述，线上取证坐实）：体验号会话 `7923283f` 里模型先用 `ask_choice`
 *   问「你想做几个题？」、学习者选了「入门级测试（5题）」，随后它**只能在正文里打字出练习题**，
 *   还补一句「准备好了就告诉我，我来批改你的答案」。根因不是解析或模型能力，而是
 *   `chat/tools/` 的注册表里**没有出题**（出题是 `routes/quiz.ts` 那条 REST 引擎），
 *   而 `chat/system-prompt.ts` 只留了一句「给出题时遵循协议」——模型手里没有工具，只能退回文字。
 *   ⇒ 症状：没有题卡、点选不了作答、不进题库、没有正确率与错题回流。
 *
 * ★ 本工具**不新做引擎**：跑的就是设置页那个「出题」按钮跑的同一道管道
 *   （`generateBlendedQuiz` → AI 配比 + 真题合流 + 配图闸门），出卡走同一个门面
 *   （`announceQuizToSession`）。两条入口的差异只在**谁发起**（人点 vs 模型调）。
 *
 * ★ 纯文本层（配比缩放 + 回灌/失败文案）住在 `generate-quiz-format.ts`，本文件只留「注册 +
 *   两阶段写」。分文件的理由不是行数，是可测性——见那边头注（一句话：import 本文件 = 顺手
 *   触发注册，那条「工具到底有没有进下发清单」的锁就废了）。
 *
 * 三条口径（都是本批拍板，写清楚免得后人当"默认"）：
 * 1. **参数默认读用户设置**，模型只可带 `count`（学习者说"来 3 道"就用 3 道）与 `search`；
 *    带了 `count` 时**真题与情景档本次归零**——「3 道题」指的是这次一共 3 道，
 *    不是「3 道 AI 题 + 设置里另配的真题」。★ 代价：设置页配了真题的人，在聊天里点名要题量时
 *    拿到的是纯 AI 题（摘要里如实写明，不静默）。
 * 2. **回灌给模型的只有题干清单与统计，不含答案与解析**（老板拍板）：模型要能报菜名、
 *    能针对题干讲评，但不需要重抄一遍判分依据；出题是本仓最贵的调用之一，别再把整份 JSON
 *    第二次塞进上下文。★ 判分归题卡（`/api/quiz/stats/record`），不归模型。
 * 3. `affected` 记 **1**（一个 `quiz_bank` 行），不记题数：确认门 `by_size` 比的是条数，
 *    记成 8 道会让每次出题都弹一张批准卡，而「出题」正是学习者自己开口要的动作。
 *    ★ 更狠的一面：没有会话上下文时写门面是**保守拒绝** ⇒ 记成题数的症状恰好是本批修的那个线上症状。
 *
 * kind = `write`（有写库副作用）＋ `planWrite` 两阶段（契约 TOOL-ECOSYSTEM-SPEC §4.2/§4.6）：
 * plan 只生成不落库，apply 才 `saveQuiz` + 出卡。★ 超时必须显式给 `TOOL_LLM_INNER_TIMEOUT_MS`：
 * 本工具内部是一次完整出题模型调用，`KIND_TIMEOUT_MS.write` 的 30s 档会把它掐死，
 * 症状是「AI 说它出了题，屏幕上却没有卡」（同 `tidy_terms` 的 120s 先例）。
 */
import type { QuizMix, QuizSourceMix } from '@sb/shared';
import {
  DEFAULT_QUIZ_SOURCE_MIX,
  MAX_QUIZ_TOTAL,
  emptyQuizImageReport,
  mixTotal,
  sourceMixTotal,
  TOOL_LLM_INNER_TIMEOUT_MS,
} from '@sb/shared';
import { generateBlendedQuiz } from '../../learning/quiz-blend.js';
import { loadQuizMix, saveQuiz } from '../../learning/quiz.js';
import { loadQuizSourceMix } from '../../learning/quiz-source-mix.js';
import { announceQuizToSession } from '../../learning/quiz-announce.js';
import { buildDocMaterial, getSessionDoc } from '../../learning/document.js';
import { publishEvent } from '../../events/bus.js';
import { registerTool } from './registry.js';
import { quizToolFailureHint, quizToolSummary, scaleMixToCount } from './generate-quiz-format.js';

function zeroSourceMix(): QuizSourceMix {
  return { ...DEFAULT_QUIZ_SOURCE_MIX };
}

registerTool('generate_quiz', {
  definition: {
    type: 'function',
    function: {
      name: 'generate_quiz',
      // description 是写给模型的提示词（同 `web-search.ts` 的 B-006 教训：正面陈述 + 触发场景 + 边界）
      description:
        '给学习者**出真题**：生成一组可点选作答、自动判分、进题库与错题统计的练习题，题卡直接出现在对话里。' +
        '适用：学习者要「出题／考我／来几道练习题／做测试／巩固一下／来套题」，或你判断该让他练一轮时。' +
        '★ **要出题就必须调本工具**——在正文里用文字写题目（哪怕写成 1.2.3. 的练习样子）等于没出：' +
        '没有题卡、他点选不了、系统不记对错、错题也不回流，而这些都是本产品出题的意义所在。' +
        '参数：`topic` 说清出什么主题的题；`count` 只在学习者点名题量时给（省略＝用他在设置页配的题型配比）；' +
        '`material` 可选，把你刚讲过、要针对它出题的要点原文放进来（省略时用本会话载入的资料，都没有就按主题出）；' +
        '`search` 要时效性题目时才开。返回题干清单与统计（**不含答案**），题面不要再抄一遍。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '出题主题（如「高一数学 正弦定理」「词根 spect 的衍生词」）' },
          count: { type: 'integer', minimum: 1, maximum: MAX_QUIZ_TOTAL, description: '本次题数；省略＝用设置里的配比' },
          material: { type: 'string', description: '可选：出题依据的材料原文（你刚讲过的要点、公式、课文片段）' },
          search: { type: 'boolean', description: '可选：本次是否联网检索真题材料，默认关' },
        },
        required: ['topic'],
      },
    },
  },
  kind: 'write',
  timeoutMs: TOOL_LLM_INNER_TIMEOUT_MS,
  // 场景裁剪（§4.4）：本工具只该在**主对话**里被调。★ 如实记：`flow.ts` 调的是
  // `toolDefinitions()`（不带 role）⇒ 这条今天**不产生裁剪**，是写给"哪天按角色下发"的意图声明。
  // 真正常见的递归担心已实测排除：出题引擎 `learning/quiz.ts` 的模型调用不带 tools，
  // 所以出题角色里拿不到本工具，不存在「出题触发出题」。
  scenes: ['explain'],
  async planWrite(args, ctx) {
    const topic = String(args.topic ?? '').trim().slice(0, 200);
    const owner = ctx.ownerId ?? null;
    if (!topic) {
      return {
        affected: 0,
        actionSummary: '本次调用未产生改动',
        items: [],
        apply: async () => ({ content: '出题失败：topic 为空。请带上明确的主题再调一次。', meta: { affected: 0 } }),
      };
    }
    // 材料三级回退（与 `routes/quiz.ts` 同口径）：显式给的 > 本会话载入的资料 > 只有主题
    // ★ 资料带归属：别人会话的资料取不到（拿别人的资料出题＝泄露，2026-09-21 闸门 #2）
    const given = String(args.material ?? '').trim();
    const doc = given || !ctx.sessionId ? null : getSessionDoc(ctx.sessionId, owner);
    const material = given || (doc ? buildDocMaterial(doc, topic) : undefined);

    const saved = loadQuizMix(owner);
    const countArg = Number(args.count);
    const byCount = Number.isFinite(countArg) && countArg >= 1 ? Math.trunc(countArg) : 0;
    // 拍板口径 1：点名了题量 ⇒ 这次总数就是它，真题与情景档本次归零
    const aiMix = byCount > 0 ? scaleMixToCount(saved, byCount) : saved;
    const realMix = byCount > 0 ? zeroSourceMix() : loadQuizSourceMix(owner);
    // 情景档恒不进本工具（它走 `generateScenario` 那台独立引擎，一套＝一整个可玩 demo），
    // 但设置里配了就要在摘要里如实说一声——不然学习者觉得「我配的档被偷了」
    const scenarioSkipped = saved.scenario > 0;
    const runMix: QuizMix = { ...aiMix, scenario: 0 };
    const images = emptyQuizImageReport();
    const blended = await generateBlendedQuiz(
      topic,
      material,
      runMix,
      realMix,
      images,
      undefined, // 风格：不显式给 ⇒ 引擎自己读库内偏好（与 REST 入口同语义）
      args.search === true,
      owner,
    );
    const quiz = blended.quiz;
    if (!quiz) {
      return {
        affected: 0,
        actionSummary: '本次调用未产生改动',
        items: [],
        apply: async () => ({
          content: quizToolFailureHint(images, runMix, realMix, mixTotal(runMix) > 0),
          meta: { affected: 0 },
        }),
      };
    }
    const hasReal = sourceMixTotal(blended.report.real.actual) > 0;
    return {
      // 口径 3：affected 数的是**入库对象**（一行 quiz_bank），不是题数
      affected: 1,
      actionSummary: `生成 ${quiz.questions.length} 道练习题并入题库（主题：${topic}）`,
      items: quiz.questions.map((q) => q.question),
      apply: async () => {
        const quizId = saveQuiz(quiz, hasReal ? 'blend' : 'ai', owner);
        publishEvent({ type: 'quiz_generated', quizId, ownerId: owner });
        if (ctx.sessionId) announceQuizToSession(ctx.sessionId, quiz, quizId);
        return {
          content: quizToolSummary(quiz, images, {
            realRequested: sourceMixTotal(realMix),
            scenarioSkipped,
          }),
          meta: { affected: 1 },
        };
      },
    };
  },
});
