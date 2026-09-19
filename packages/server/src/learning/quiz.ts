/**
 * learning/quiz — 出题引擎 + 题库 + 逐题统计（练+析两环服务）。
 * 协议：[QUIZ] JSON（shared/content-blocks QuizPayload）；normalize 校验后入库；
 * 出题走 quiz-generator 角色模型（演进①），失败降级纯文本不崩（ADR-4）。
 * 题型配比：设置页把「单选/多选/填空/解答各几道」存 app_settings，出题时拼进提示词；
 * 模型多出的裁掉、少出的如实报（ADR-4 降级不崩 + ADR-5 三态反馈），绝不静默改配比。
 */
import { randomUUID } from 'node:crypto';
import type { QuizPayload, QuizQuestion, QuizMix, QuizType, QuizMixReport, QuizImageReport, AnswerStyle } from '@sb/shared';
import {
  QUIZ_TYPES,
  QUIZ_TYPE_LABELS,
  DEFAULT_QUIZ_MIX,
  SETTING_KEY_QUIZ_MIX,
  normalizeQuizMix,
  mixTotal,
  normalizeQuizSvg,
  emptyQuizImageReport,
  emptyQuizSearchReport,
  buildAnswerStyleBlock,
  MAX_DOC_CHARS,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { loadAnswerStyle } from '../storage/answer-style.js';
import { routeRole } from '../llm/router.js';
import { QUIZ_TEMPERATURE, getQuizMaxOutputTokens } from '../llm/model-limits.js';
import { repairJsonBrackets, repairJsonEscapes } from './quiz-json-repair.js';
import { loadQuizImage, buildImageInstruction } from './quiz-image.js';
import { buildQuizSearchBlock, mapQuizSources } from './quiz-search.js';

// 配图三件的实现已搬到 quiz-image.ts（本文件行数红线所迫，见该文件头注）。
// 这里原样转出，既有调用方 routes.ts / quiz.test.ts / quiz-image.test.ts 的 import 路径零改动。
export { loadQuizImage, saveQuizImage, buildImageInstruction } from './quiz-image.js';

/**
 * 出题协议。v1.1 的关键修正：**svg 进字段清单、进示例**（四个题对象一个给真图、三个给 ""）。
 * v1.0 的示例里没有 svg，配图说明追加在末尾——flash 级模型照示例办事，压不过去，
 * 结果就是「题干写根据图示…结构①，但一个图也不产」（实测 0/4，详见契约 §2.7）。
 * 2026-09-13 同法加 `refs`（来源标注，契约 QUIZ-SEARCH-SPEC §2.8）：字段进清单、进示例，
 * 否则弱模型同样不产出。refs 只填编号——**网址由 quiz-search.ts 按编号翻译**，模型写网址一律丢弃。
 * 导出只为给单测钉住「示例里必须带 svg」这一条——它不是风格问题，而是配图 0 产率的直接根因。
 */
export const QUIZ_PROTOCOL = `你是一个出题引擎。根据给定材料出一组练习题，严格按以下 JSON 格式输出，输出外围包一对 [QUIZ]...[/QUIZ] 标记。
每个题目对象的字段固定为：type、question、options（只有选择题才给）、answer、explanation、svg、refs。svg 是字符串，值为该题示意图的完整 SVG 源码；该题不需要示意图时给空字符串 ""，但不要省略这个字段。refs 是数组，填本题参考到的资料编号（只有下文给了「互联网参考资料」时才有编号可填），没参考就填 []。
[QUIZ]{"title":"标题","questions":[{"type":"single","question":"单选题干","options":["A","B","C","D"],"answer":[0],"explanation":"解析","svg":"<svg viewBox='0 0 120 90'><rect x='25' y='15' width='60' height='60' fill='none' stroke='#555'/><text x='18' y='12'>A</text></svg>","refs":[1]},{"type":"multiple","question":"多选题干","options":["A","B","C"],"answer":[0,2],"explanation":"解析","svg":"","refs":[]},{"type":"fill","question":"填空题干，空位用____","answer":["答案1"],"explanation":"解析","svg":"","refs":[]},{"type":"essay","question":"解答题干","answer":"参考要点","solution":"完整解答","svg":"","refs":[]}]}[/QUIZ]
规则：single 的 answer 是正确选项下标数组（一个元素）；multiple 可多元素；fill 的 answer 按空位顺序；essay 不判分只给参考。题目必须源于给定材料，不得编造。题目类型与数量严格按下文「本次出题数量要求」执行。svg 怎么写照下文「配图要求」，但上面格式示例里那个方框只是演示字段怎么写——照抄进题目等于没配图。refs 只填编号数字，**绝不要填网址或标题**（网址由系统按编号补全，你写的网址一律作废）。除该 JSON 外不要输出任何其他文字。`;

/**
 * 定位 svg 字段的整个值（含值内未转义的裸引号）——漏转义时值里会有 `"`，
 * 故不能「吃到下一个引号就停」，否则残留内容仍让 JSON 非法。
 * 用 lookahead 找真正的字段边界：引号后面紧跟 `,` / `}` / `]` 才是值的结束。
 * 非贪婪 + 有界输入（见 MAX_RESCUE_CHARS），避开 v1 那类正则回溯把线程钉死的事故。
 */
const SVG_FIELD = /"svg"\s*:\s*"[\s\S]*?"(?=\s*[,\]}])/g;

/** 超过这个长度就不再抢救：几 MB 的畸形输出不值得赌一次回溯 */
const MAX_RESCUE_CHARS = 500_000;

/**
 * 截断逐题回退（v1.1，契约 §2.6 更正）：撞 max_tokens 的输出总是「最后一个元素残缺」，
 * 故从头单遍扫括号，记住「刚闭合完一道完整题」的位置，把残缺尾巴整段砍掉再补 `]}`。
 * 刻意线性扫描而不用正则：这里曾是 `[\s\S]*?` 回溯钉死线程的事故点（见 SVG_FIELD 注释）。
 * 返回 null 表示连一道完整题都没抠出来（没救，交回上层走降级）。
 */
function salvageTruncatedQuiz(json: string): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let cut = -1;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i] ?? '';
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      // 栈为 { → [ → { ：弹出后深度恰为 2 且闭合的是 `}`，说明刚收尾一道完整的题对象
      if (depth === 2 && ch === '}') cut = i + 1;
    }
  }
  return cut < 0 ? null : `${json.slice(0, cut)}]}`;
}

/**
 * 解析模型输出中的 [QUIZ] JSON（容错：多行/围栏/前后杂质；失败返回 null 走降级）。
 * 进阶梯前先补模型漏写的 `]`（真机复验抓到的第四种失败，见 quiz-json-repair.ts）——那条无损，不必占一次尝试。
 * **四次尝试，代价从低到高**：原样 → 剥 svg 值 → 截断逐题回退 → 回退后再剥 svg。
 * 前两道治「SVG 里漏转义双引号」（图可以没有，题不能丢）；后两道治「撞 max_tokens 被截断」——
 * v1.0 在截断这条路上直接整组 null → 502，实测五档截断无一幸存（契约 §2.6 更正）。
 * 每次尝试单独计数，只有成功那次的结果写回 report，失败尝试不污染统计。
 * 走了逐题回退就报 truncated：上面的 `\{[\s\S]*\}` 抽取已经把残缺尾巴吃掉了，
 * 在解析器里分不开「撞长度上限」与「模型漏写收尾括号」——两者都是输出没写完，如实报就是了。
 * `stripped` 记住该次尝试在 JSON 文本里清掉了几个 svg 值：那些图根本没进到 normalizeQuiz，
 * 不算上去就会漏报「模型画了坏图」——恰好是最该说的一种损失。
 */
export function parseQuizBlock(text: string, report?: QuizImageReport, allowSvg = true): QuizPayload | null {
  const m = text.match(/\[QUIZ\]([\s\S]*?)\[\/QUIZ\]/);
  let raw = m ? m[1] : '';
  if (!raw && text.includes('"questions"')) raw = text;
  if (!raw) return null;
  // 容错：剥离围栏后仍可能有前后杂质——提取首个完整 JSON 对象
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  // 两道修复在合法 JSON 上永不触发，故直接当所有尝试的基底（转义先修，不修好它括号扫描连串边界都错）
  const json = repairJsonBrackets(repairJsonEscapes(objMatch[0]).text).text;
  const attempts = [{ body: json, rescued: false, stripped: 0 }];
  // 超过上限的畸形输出不做救援：几 MB 的垃圾不值得赌一次回溯
  if (json.length <= MAX_RESCUE_CHARS) {
    attempts.push({
      body: json.replace(SVG_FIELD, '"svg":""'),
      rescued: false,
      stripped: (json.match(SVG_FIELD) ?? []).length,
    });
    const prefix = salvageTruncatedQuiz(json);
    if (prefix) {
      attempts.push({ body: prefix, rescued: true, stripped: 0 });
      attempts.push({
        body: prefix.replace(SVG_FIELD, '"svg":""'),
        rescued: true,
        stripped: (prefix.match(SVG_FIELD) ?? []).length,
      });
    }
  }
  for (const attempt of attempts) {
    const draft = emptyQuizImageReport(allowSvg);
    let quiz: QuizPayload | null;
    try {
      quiz = normalizeQuiz(JSON.parse(attempt.body) as QuizPayload, { allowSvg, report: draft });
    } catch {
      continue;
    }
    if (!quiz) continue;
    if (report) {
      report.droppedSvg += draft.droppedSvg + attempt.stripped;
      if (attempt.rescued) report.truncated = true;
    }
    return quiz;
  }
  return null;
}

/** normalizeQuiz 的可选入参（v1.1） */
export interface NormalizeQuizOptions {
  /** 配图总开关：false = **硬门**，模型给了 svg 也无条件剥掉（契约 §2.2 修正①） */
  allowSvg?: boolean;
  /** 出参：丢了几张图写这里（契约 §2.4：丢了要如实说，不静默） */
  report?: QuizImageReport;
}

/**
 * 校验规范化：丢弃无题干/无选项的 single/multiple；fill answer 转数组。
 * 配图单独过 `normalizeQuizSvg`：**图不合法只丢图，题照留**（契约 §2.3 丢图保题）。
 * `allowSvg: false` 同样丢图，但**不计进 droppedSvg**——开关关着不出图是预期，不是损失。
 */
export function normalizeQuiz(data: QuizPayload, opts?: NormalizeQuizOptions): QuizPayload | null {
  const allowSvg = opts?.allowSvg !== false;
  const questions: QuizQuestion[] = [];
  for (const q of data.questions ?? []) {
    if (!q.question?.trim()) continue;
    if ((q.type === 'single' || q.type === 'multiple') && (!Array.isArray(q.options) || q.options.length < 2)) continue;
    const svg = allowSvg ? normalizeQuizSvg(q.svg) : undefined;
    if (svg) {
      questions.push({ ...q, svg });
      continue;
    }
    // 图不合法（截断/非源码/超长）或开关关着：**整字段拿掉**，不能留着原值——留着等于把坏图塞给前端
    const { svg: _dropped, ...rest } = q;
    if (allowSvg && opts?.report && typeof q.svg === 'string' && q.svg.trim()) opts.report.droppedSvg += 1;
    questions.push(rest);
  }
  return questions.length > 0 ? { title: data.title || '练习题', questions } : null;
}

// ── 题型配比（用户可配：每种题型 0..10 道）──
//
// ★ M2d（2026-09-18，契约 TENANCY-SPEC §8.2）：`app_settings` 归主（v30，主键 `(owner_id, key)`）。
//   改前这是**全局写口**——A 在设置页改一次出题配比，**全站所有人的出题都跟着变**。
//   `ownerId` 一律必填：读侧漏传读到别人的配比、写侧漏传写进无主行（用户自己读不回），
//   两种都**不会让任何测试变红**，只能靠类型挡住。

/** 读设置；未配过/配置损坏都回退默认（数据容错，ADR-6） */
export function loadQuizMix(ownerId: string | null): QuizMix {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_QUIZ_MIX) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_QUIZ_MIX };
  try {
    return normalizeQuizMix(JSON.parse(row.value) as unknown);
  } catch {
    return { ...DEFAULT_QUIZ_MIX };
  }
}

/** 存设置；落库前先归一化，库里永远是干净值 */
export function saveQuizMix(mix: QuizMix, ownerId: string | null): QuizMix {
  const clean = normalizeQuizMix(mix);
  getDb()
    .prepare(
      // ★ 冲突目标跟着主键改（v30）：仍写 `ON CONFLICT(key)` 会运行时 500。
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_QUIZ_MIX, JSON.stringify(clean));
  return clean;
}

/** 配比指令：拼进出题提示词，明说「总共几道、各题型几道、哪种不要出」 */
export function buildMixInstruction(mix: QuizMix): string {
  const wanted = QUIZ_TYPES.filter((t) => mix[t] > 0).map((t) => `${QUIZ_TYPE_LABELS[t]} ${mix[t]} 道`);
  const zero = QUIZ_TYPES.filter((t) => mix[t] === 0).map((t) => QUIZ_TYPE_LABELS[t]);
  const lines = [`本次出题数量要求：总共恰好 ${mixTotal(mix)} 道题，其中 ${wanted.join('、')}。`];
  if (zero.length > 0) lines.push(`不要出${zero.join('、')}（该题型数量为 0）。`);
  lines.push('questions 数组按上述题型顺序排列，不多不少。');
  return lines.join('');
}

/**
 * 按配比裁剪模型输出：多出的题丢掉（顺序保持），少出的如实记进 report。
 * 模型自造题型（不在四类之内）一律丢弃——配比是精确契约，宁缺勿乱。
 * 裁完 0 题返回 null（调用方走 502 降级，不返回空题组）。
 */
export function applyQuizMix(
  quiz: QuizPayload,
  mix: QuizMix,
): { quiz: QuizPayload | null; report: QuizMixReport } {
  const actual: QuizMix = { single: 0, multiple: 0, fill: 0, essay: 0, scenario: 0 };
  const kept: QuizQuestion[] = [];
  for (const q of quiz.questions) {
    const t = q.type as QuizType;
    if (!QUIZ_TYPES.includes(t)) continue;
    if (actual[t] >= mix[t]) continue;
    actual[t] += 1;
    kept.push(q);
  }
  const report: QuizMixReport = {
    requested: mix,
    actual,
    matched: QUIZ_TYPES.every((t) => actual[t] === mix[t]),
  };
  return { quiz: kept.length > 0 ? { title: quiz.title, questions: kept } : null, report };
}

/**
 * 一键出题（基于主题/对话材料），返回 QuizPayload 或 null（降级由调用方处理）。
 * `report` 是可选出参：开关状态、丢图数、是否截断、**联网检索结果**都回填进去，路由据此如实上报
 * （配图契约 §2.4；联网部分见 docs/QUIZ-SEARCH-SPEC.md §2.2/§2.4）。
 * `online` 是本次是否联网。**默认 false**——历史调用点不传即行为不变；三条面向用户的入口才显式开。
 * 联网失败绝不阻断出题（ADR-4）：搜不到、没 key、超时都退回模型知识，照常出题。
 */
export async function generateQuiz(
  topic: string,
  material?: string,
  mix?: QuizMix,
  report?: QuizImageReport,
  styleArg?: AnswerStyle, // 省略＝读库内回答方式偏好（契约 ANSWER-STYLE §3；本行不留余量，故不另起一段注释）
  online = false,
  ownerId?: string | null, // M2c 归属（契约 TENANCY-SPEC §8.1.4）；尾参可选，见下
): Promise<QuizPayload | null> {
  // ★ M2c：出题是**本仓最贵的 LLM 调用之一**（还带联网检索），归属不能含糊。
  //   尾参放最后且可选：本函数的调用点有 6 处（chat 工具循环 / REST / PK 人出题 / PK AI 出题 /
  //   裁判类似题 / 单测），中间插参会把 `styleArg`、`online` 两个位置参数全部错位——
  //   那是最容易"改完能编译、语义全错"的一类改动。生产路径全部显式传值。
  const owner = ownerId ?? null; // 归一化一次：下面 4 处读设置/检索/路由全用它，避免各处 `?? null` 写法分叉
  const target = routeRole('quiz-generator', undefined, owner);
  if (!target || !target.model) {
    // 真因写进 report（契约 QUIZ-SEARCH-SPEC §2.5）：路由据此报「去设置页绑模型」而不是「可重试」
    if (report) report.failure = 'no-model';
    return null;
  }
  let acc = '';
  const wanted = mix ?? loadQuizMix(owner);
  // 开关只读一次：提示词与解析硬门必须同源，否则会出现「叫模型画、画完又剥掉」的自相矛盾
  const imageOn = loadQuizImage(owner);
  if (report) report.on = imageOn;
  // 联网只由 online 决定；report 只是「要不要记账」的可选出参。★ 别再写成 `online && report`——
  // 那样 PK 这类不传 report 的入口会静默退化成不联网（2026-09-13 真机核查抓到的实际 bug）。
  const searchReport = online ? emptyQuizSearchReport(true) : undefined;
  if (report && searchReport) report.search = searchReport;
  // 检索先于出题（拿到资料才可能出时效题）；失败返回空段，下面的提示词与旧版逐字一致
  const found = searchReport
    ? await buildQuizSearchBlock(topic, material, searchReport, owner)
    : { block: '', refs: [] };
  const refsBlock = found.block;
  const prompt = `${QUIZ_PROTOCOL}\n${buildMixInstruction(wanted)}\n${buildImageInstruction(imageOn)}\n${buildAnswerStyleBlock(styleArg ?? loadAnswerStyle(owner), 'quiz')}\n${refsBlock}${refsBlock ? '\n' : ''}\n材料：\n${material ? material.slice(0, MAX_DOC_CHARS) : `主题：${topic}`}`;
  for await (const chunk of target.adapter.chat({
    model: target.model,
    apiKey: target.apiKey,
    baseUrl: target.baseUrl,
    messages: [{ role: 'user', content: prompt }],
    // 出题专用参数：温度低于聊天的 0.7（题目与 JSON 都要稳），输出上限单列（一次十题+SVG 常撞通用表）
    temperature: QUIZ_TEMPERATURE,
    maxTokens: getQuizMaxOutputTokens(target.model),
  })) {
    acc += chunk.content;
    if (chunk.done) {
      // 适配器给出的权威截断信号：撞 max_tokens 时 finish_reason 是 length（不靠猜输出形状）
      if (report && chunk.finishReason === 'length') report.truncated = true;
      break;
    }
  }
  const parsed = parseQuizBlock(acc, report, imageOn);
  // 走到这儿还解不出＝模型确有输出但不成题组（含配比裁剪后为空的上游情形），与「没配模型」是两条路
  if (!parsed && report) report.failure = 'parse';
  // 来源标注（契约 QUIZ-SEARCH-SPEC §2.8）：把模型给的编号翻译成真实 title/url 填 source。
  // 网址一律取自 found.refs（真实检索结果），模型写什么都丢——这是「来源不可幻觉」的唯一保证。
  return parsed ? mapQuizSources(parsed, found.refs) : null;
}

// ── 题库 ──
// ★ M2d-3（迁移 v33）：quiz_bank 加 owner_id，归属值口径照抄 M2d-1/M2d-2（'' = 无主 = 谁都看不见）。
//   读写两侧同用 ownerForWrite——listQuiz 虽是"一批行"，但登录用户只许见自己的题库、
//   未登录只许见无主行，"null 豁免过滤"会把别人的题列进来（契约 §8.2 第 2 条口径）。
export function saveQuiz(data: QuizPayload, source: string, ownerId: string | null, id?: string): string {
  const qid = id ?? randomUUID();
  getDb()
    .prepare('INSERT OR REPLACE INTO quiz_bank (id, title, source, data, owner_id) VALUES (?, ?, ?, ?, ?)')
    .run(qid, data.title ?? '练习题', source, JSON.stringify(data), ownerForWrite(ownerId));
  return qid;
}

export function listQuiz(ownerId: string | null): Array<{ id: string; title: string; source: string; count: number; created_at: string }> {
  const rows = getDb()
    .prepare('SELECT id, title, source, data, created_at FROM quiz_bank WHERE owner_id = ? ORDER BY created_at DESC')
    .all(ownerForWrite(ownerId)) as Array<{ id: string; title: string; source: string; data: string; created_at: string }>;
  return rows.map((r) => {
    let count = 0;
    try {
      // 情景题（契约 docs/SCENARIO-SPEC.md）的 data 是 ScenarioPayload：有 tasks 键按任务数计，
      // 其余仍按传统题组的 questions 计——一份列表两种形状，解析只看键不猜 source。
      const parsed = JSON.parse(r.data) as QuizPayload & { tasks?: unknown[] };
      count = Array.isArray(parsed.tasks) ? parsed.tasks.length : (parsed.questions?.length ?? 0);
    } catch {
      count = 0;
    }
    return { id: r.id, title: r.title, source: r.source, count, created_at: r.created_at };
  });
}

export function getQuiz(id: string, ownerId: string | null): QuizPayload | null {
  const row = getDb()
    .prepare('SELECT data FROM quiz_bank WHERE id = ? AND owner_id = ?')
    .get(id, ownerForWrite(ownerId)) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as QuizPayload;
  } catch {
    return null;
  }
}

export function deleteQuiz(id: string, ownerId: string | null): void {
  getDb().prepare('DELETE FROM quiz_bank WHERE id = ? AND owner_id = ?').run(id, ownerForWrite(ownerId));
  getDb().prepare('DELETE FROM quiz_stats WHERE quiz_id = ? AND owner_id = ?').run(id, ownerForWrite(ownerId));
}

// ── 逐题统计已迁出（2026-09-19 M2d-3）──
// recordAnswer 移到 `learning/quiz-record.ts`：本文件加归属参数后触 400 行红线，按仓规拆文件不压注释。
// quiz_stats 的读形状是聚合（薄弱点分析/判分统计），归属口径同 ownerForWrite（见该文件头注）。
export { recordAnswer } from './quiz-record.js';

// ── 薄弱点分析已迁出（2026-09-15）──
// 旧实现在此：纯本地规则，产出两句硬编码文案（'正确率低于 60% 的题目' / '针对这些题重新练习，并阅读解析'），
// 且 fallback 恒为 true；函数上方注释写的「+ 可选 AI 报告（analyzer 角色）」从未实现过。
// 现移到 `learning/quiz-weak.ts`（契约 docs/QUIZ-WEAK-SPEC.md）：AI 实时分析为主路径、本地规则为降级。
// 迁出理由有二：① 本文件当时 383/400 行，触 AGENTS.md「再加任何逻辑前必须先开新文件」红线；
// ② 分析要接 analyzer 角色调模型，与「出题引擎」是两种生命周期。
// ★ 刻意**不在本文件 re-export**（`quiz-image.ts` 那套做法在这里会构成循环依赖：
//   quiz-weak.ts 反过来 import 本文件的 getQuiz）。调用方 routes/quiz.ts 已直接改指新路径。
