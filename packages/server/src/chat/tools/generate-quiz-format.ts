/**
 * chat/tools/generate-quiz-format —— `generate_quiz` 的**纯文本层**（配比缩放 + 回灌文案）。
 *
 * ★ 为什么从 `generate-quiz.ts` 里分出来（不是审美）：那份文件是「注册 + 两阶段写」，带模块
 *   副作用（`registerTool`）。测试要验「工具到底在不在下发清单里」时，只要顺手 import 它，
 *   注册副作用就自己发生了 ⇒ **撤掉 `chat/tools/index.ts` 里那行 `import './generate-quiz.js'`
 *   也不会红**——而"模型拿不到工具"正是本批最初那个线上症状本身。分出来之后，测试可以只走
 *   `./index.js` 这一条路，那条漏点才真的抓得住。
 *
 * 两层口径各一条，漂了都会静默：
 * · 缩放（拍板口径 1）：点名题量时按题型**相对比例**缩，情景档恒 0，单档上限可让总数少给（如实少给，不补题）；
 * · 回灌（拍板口径 2）：只给题干与统计，**不给答案/解析/要点**——判分归题卡，模型重抄一遍等于把上下文烧两次。
 */
import type { QuizImageReport, QuizMix, QuizPayload, QuizSourceMix } from '@sb/shared';
import {
  DEFAULT_QUIZ_MIX,
  MAX_QUIZ_TOTAL,
  MIX_KIND_LABELS,
  QUIZ_TYPES,
  countQuizImages,
  mixKindCap,
  mixTotal,
  sourceMixTotal,
} from '@sb/shared';

/** 单条题干回灌上限（清单是给模型报菜名用的，不是让它重抄题面） */
const STEMS_MAX = 20;
const STEM_CHARS = 80;

function zeroAiMix(): QuizMix {
  return { single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 };
}

/**
 * 把设置里那份配比**按题型相对比例**缩放到 `count` 道（最大余额法，同额按档位序补，可复现）。
 * 情景档恒为 0（本工具不出情景套题）；设置里 AI 侧全 0（纯真题配置）时回落默认配比。
 * ★ 单档上限（`mixKindCap`）可能让总数够不到 `count`（例如 20 道全要单选 ⇒ 只能给 10），
 *   那属于**如实交付**：题组的实际题数走摘要，不静默补题（ADR-5）。
 */
export function scaleMixToCount(saved: QuizMix, count: number): QuizMix {
  const wanted = Math.max(1, Math.min(MAX_QUIZ_TOTAL, Math.trunc(count)));
  const aiTotal = QUIZ_TYPES.reduce((s, t) => s + (saved[t] || 0), 0);
  const base = aiTotal > 0 ? saved : DEFAULT_QUIZ_MIX;
  const denom = QUIZ_TYPES.reduce((s, t) => s + (base[t] || 0), 0) || 1;
  const alloc = QUIZ_TYPES.map((t) => {
    const exact = ((base[t] || 0) * wanted) / denom;
    const n = Math.floor(exact);
    return { kind: t, n, rem: exact - n };
  });
  let left = wanted - alloc.reduce((s, a) => s + a.n, 0);
  for (const a of [...alloc].sort((x, y) => y.rem - x.rem)) {
    if (left <= 0) break;
    if (a.n < mixKindCap(a.kind)) {
      a.n += 1;
      left -= 1;
    }
  }
  const out: QuizMix = zeroAiMix();
  for (const a of alloc) out[a.kind] = Math.min(mixKindCap(a.kind), a.n);
  return out;
}

/** 题型统计（只列非零档，按档位序）：`单选3／判断2` */
function mixText(mix: QuizMix): string {
  const parts = QUIZ_TYPES.filter((t) => mix[t] > 0).map((t) => `${MIX_KIND_LABELS[t].replace(/题$/, '')}${mix[t]}`);
  return parts.length > 0 ? parts.join('／') : '无';
}

function stemLines(quiz: QuizPayload): string {
  return quiz.questions
    .slice(0, STEMS_MAX)
    .map((q, i) => {
      const stem = q.question.length > STEM_CHARS ? `${q.question.slice(0, STEM_CHARS - 1)}…` : q.question;
      return `${i + 1}.【${MIX_KIND_LABELS[q.type] ?? q.type}】${stem}`;
    })
    .join('\n');
}

/** 从成品题组反推题型计数（配比报告裁完可能不等于实际交付数，摘要以实际为准） */
function countByType(quiz: QuizPayload): QuizMix {
  const out: QuizMix = zeroAiMix();
  for (const q of quiz.questions) out[q.type] += 1;
  return out;
}

/**
 * 出卡成功后的回灌文本（拍板口径 2）：题干清单 + 统计 + 缺口如实报 + 行为约束。
 * 报告侧一律**照实念**（ADR-5）：配比没出齐、真题没摘到、图被丢掉，都要让模型知道并说出来。
 */
export function quizToolSummary(
  quiz: QuizPayload,
  images: QuizImageReport,
  opts: { realRequested: number; scenarioSkipped: boolean },
): string {
  const n = quiz.questions.length;
  const realGot = quiz.questions.filter((q) => q.source?.kind === 'collect').length;
  const svg = countQuizImages(quiz);
  const head = [
    `已出题 ${n} 道（${mixText(countByType(quiz))}）` +
      (realGot > 0 ? `，其中真题 ${realGot} 道` : '') +
      (svg > 0 ? `，含配图 ${svg} 道` : '') +
      '。题卡已经直接展示给学习者了——**他点卡片作答，对错与统计由系统判分**（另有错题本）。',
    '★ 不要在正文里重复抄这些题目，也不要自己批改（那等于把刚给的题卡作废）。',
    '要讲评就针对下面的题干讲；学习者作答后你可以解释错因。',
  ].join('\n');
  const notes: string[] = [];
  if (images.droppedSvg > 0) notes.push(`有 ${images.droppedSvg} 张图未通过校验被丢弃（题面保留）`);
  if (images.truncated) notes.push('模型输出撞到长度上限，尾部不完整题已丢弃 ⇒ 题数偏少是这么来的');
  if (opts.scenarioSkipped) notes.push(`设置里的「${MIX_KIND_LABELS.scenario}」档本次未出——那一档走出题页的独立引擎，聊天里暂不含`);
  if (opts.realRequested > 0 && realGot === 0) notes.push(`设置里配了 ${opts.realRequested} 道真题，这次一道都没摘到（AI 题不受影响）`);
  return `${head}\n\n题干清单：\n${stemLines(quiz)}${notes.length > 0 ? `\n\n（如实告知学习者：${notes.join('；')}）` : ''}`;
}

/** 出题失败的四条真因（与 `routes/quiz.ts` 的 502 文案同源，不各写一套） */
export function quizToolFailureHint(
  images: QuizImageReport,
  aiMix: QuizMix,
  realMix: QuizSourceMix,
  aiRan: boolean,
): string {
  if (images.failure === 'no-model') {
    return '出题失败：**出题角色没有可用的模型**。请告诉学习者到「设置 → 角色模型绑定」给「出题」绑一个模型，重试没有用。';
  }
  if (images.failure === 'parse') {
    return '出题失败：模型这次的输出没能解析成题目。可以重试一次；反复失败就建议学习者到设置页给「出题」换一个更强的模型。';
  }
  if (aiRan && !images.truncated) {
    return `出题失败：模型出的题按配比（共 ${mixTotal(aiMix)} 道）裁剪后一题不剩。可重试，或建议学习者到设置页改配比。`;
  }
  if (!aiRan && sourceMixTotal(realMix) > 0) {
    return '出题失败：这次只配了真题、而网上没摘到可逐字摘录的题。建议学习者把题型配回 AI 侧再来一次。';
  }
  return '出题失败：没有产出任何题目（原因未知，可重试一次再判断）。';
}
