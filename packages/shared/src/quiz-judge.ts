/**
 * shared/quiz-judge — 题卡判分的**唯一事实源**（issue #56「答题留痕」，2026-09-27）。
 *
 * ★ 为什么必须在 shared 而不在 server 或 web 各写一份（规划 §4.1 同一条原则）：
 *   判分结果现在要**落库**，于是同一个对错判断同时出现在两个地方——
 *   ① 前端翻解析时当场给的红/勾（要即时），② 服务端复判写进流水的 `correct`（要可信）。
 *   两份实现只要有一条容错规则不一致（fill 的截断长度、multiple 的乱序、judge 是否算选项题），
 *   表现就是「屏幕上打了勾、流水里记了错」，而这种偏差**没有任何用例能自动发现**——
 *   它只在用户肉眼与统计口径之间出现。⇒ 函数只留这一个，两侧都 import 它。
 *
 * ★★ 为什么判分归服务端（老板 2026-09-27 拍板，逐字见 issue #56）：
 *   采「前端回报对错」的话，这条数据永远写不进对外叙述（改包 / 刷新丢帧 / 多端各判各的都能伪造）。
 *   答案钥匙本来就在服务端手里（出卡时 `[QUIZ]` 登记行连 `answer` 一起落 `messages.content`，
 *   见 `learning/quiz-announce.ts`），复判的边际成本是零。前端这份调用只用于**即时反馈**，
 *   最终记账以服务端响应为准。
 *
 * ⚠️ 与 `pk/match.ts` 的关系：**不复用、不合并**。那边是对战判分，
 *   形状是「一次一个 `rawChoice` 与 `q.answer` 直接比」（`match.ts:274`），没有多选、没有填空容错，
 *   也没有"不判"这一支。把两套强扭在一起会让对战多背一个它不需要的返回值。
 */
import type { QuizQuestion } from './content-blocks.js';

/**
 * 一次作答的线上形状。
 *
 * ★ 刻意是**两个可选字段**而不是判别联合（`{kind:'choice'}｜{kind:'text'}`）：
 *   路由侧要对**任意畸形输入**给出确定的「不判」，而判别联合在 JSON.parse 之后
 *   仍然要靠一串 in 判定来收窄，写出来比现在这份更短也更容易漏分支。
 *   `picked` 只可能来自选项题、`text` 只可能来自填空——题型本身决定读哪一个，见下。
 */
export interface QuizAnswerInput {
  picked?: number[];
  text?: string;
}

/**
 * 是否按「选项下标集合」判分。
 *
 * ★★ `judge` 必须与 `single`/`multiple` 同列，这是 `content-blocks.ts:31` 那句
 *   「一切按选项判分的链路零特判」的**兑现处**。⚠️ 而这条判据在 2026-09-27 之前**没有被任何
 *   聊天侧代码兑现过**：`QuizCard.tsx` 的选项渲染与判分都只写了 `single｜multiple`，
 *   于是设置页把判断题配进配比之后，聊天题卡上的判断题是**一张答不了的死卡**
 *   （没有选项按钮 ⇒ `picked` 恒空 ⇒ 提交按钮永远 disabled ⇒ 连旧的下线版都记不到它）。
 *   本函数把判据收成一处，前端渲染与两侧判分从此只能一起错、不会各错一半。
 */
export function isChoiceQuestion(q: QuizQuestion): boolean {
  return q.type === 'single' || q.type === 'multiple' || q.type === 'judge';
}

/**
 * 判一道题的作答。返回 `null` = **不判**（不判就不是一个对错，不许折成 `false`）。
 *
 * 三种 `null`：
 *  1. `essay`——免检。这是本仓既有口径（`learning/collect.ts:92`「essay 不判分只给参考」），
 *     不因为现在有了流水表就给开放题硬造对错。⚠️ 免检 ⇒ **不进流水**，
 *     所以「答题留痕」的口径是**可判分题**的留痕，不是"所有作答"；引用这个数时必须带这句限定。
 *  2. 题面缺 `answer`（模型没给答案钥匙 / 老行还原出来的坏题）——没有钥匙就没有对错可说。
 *  3. 作答形状不合（选项题没给 `picked`、填空没给 `text`）——把"输入畸形"记成"答错"
 *     是往统计里灌假负样本，比不记更坏。
 */
export function judgeQuizAnswer(q: QuizQuestion, input: QuizAnswerInput): boolean | null {
  if (q.type === 'essay') return null;

  if (isChoiceQuestion(q)) {
    const picked = input.picked;
    if (!Array.isArray(picked) || picked.length === 0) return null;
    const expected = normalizeIndexKey(q.answer);
    if (expected === null) return null;
    // 集合相等：**顺序无关、不许重复计分**。多选只勾对一个 ⇒ 错（不做部分给分，
    // 因为部分给分要选一个阈值，而那个阈值一旦进流水就再也解释不清了）。
    const uniq = [...new Set(picked.map(Number))];
    if (uniq.length !== picked.length) return null;
    return uniq.length === expected.length && uniq.every((i) => expected.includes(i));
  }

  if (q.type === 'fill') {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) return null;
    const expects = normalizeFillKey(q.answer);
    if (expects.length === 0) return null;
    // 容错口径**逐字照抄被 `a087e67` 删掉的旧前端实现**（`git show a087e67^:...QuizCard.tsx` 的
    // `submit()`）：取期望答案的前 `max(4, len-2)` 个字符做子串命中。
    // ★ 不"顺手改进"它：这是本仓上线期间唯一被真人用过的填空口径（旧前端实现原样搬来），
    //   改了等于改了历史题的通过率。它确实偏松（"北京"能命中"北京市"），代价写在 issue #56。
    return expects.some((e) => text.includes(e.slice(0, Math.max(4, e.length - 2))));
  }

  return null;
}

/** `answer` 当选项下标数组读：非数组 / 空 / 有非整数 ⇒ null（= 缺答案钥匙，不判） */
function normalizeIndexKey(answer: QuizQuestion['answer']): number[] | null {
  if (!Array.isArray(answer) || answer.length === 0) return null;
  const out: number[] = [];
  for (const v of answer) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return null;
    out.push(n);
  }
  return [...new Set(out)];
}

/** `answer` 当填空字符串数组读：容错单串（`fill` 的 answer 模型可能给 `"答案"` 也可能给 `["答案"]`） */
function normalizeFillKey(answer: QuizQuestion['answer']): string[] {
  if (Array.isArray(answer)) return answer.map((v) => String(v).trim()).filter((v) => v.length > 0);
  if (typeof answer === 'string') {
    const s = answer.trim();
    // essay 的参考要点也走这条，但 essay 在上面已经返回 null，永不会读到这里。
    return s ? [s] : [];
  }
  return [];
}
