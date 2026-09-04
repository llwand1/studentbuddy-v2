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
  SETTING_KEY_QUIZ_IMAGE,
  DEFAULT_QUIZ_IMAGE,
  normalizeQuizSvg,
  emptyQuizImageReport,
  buildAnswerStyleBlock,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { loadAnswerStyle } from '../storage/answer-style.js';
import { routeRole } from '../llm/router.js';
import { repairJsonBrackets, repairJsonEscapes } from './quiz-json-repair.js';

/**
 * 出题协议。v1.1 的关键修正：**svg 进字段清单、进示例**（四个题对象一个给真图、三个给 ""）。
 * v1.0 的示例里没有 svg，配图说明追加在末尾——flash 级模型照示例办事，压不过去，
 * 结果就是「题干写根据图示…结构①，但一个图也不产」（实测 0/4，详见契约 §2.7）。
 * 导出只为给单测钉住「示例里必须带 svg」这一条——它不是风格问题，而是配图 0 产率的直接根因。
 */
export const QUIZ_PROTOCOL = `你是一个出题引擎。根据给定材料出一组练习题，严格按以下 JSON 格式输出，输出外围包一对 [QUIZ]...[/QUIZ] 标记。
每个题目对象的字段固定为：type、question、options（只有选择题才给）、answer、explanation、svg。svg 是字符串，值为该题示意图的完整 SVG 源码；该题不需要示意图时给空字符串 ""，但不要省略这个字段。
[QUIZ]{"title":"标题","questions":[{"type":"single","question":"单选题干","options":["A","B","C","D"],"answer":[0],"explanation":"解析","svg":"<svg viewBox='0 0 120 90'><rect x='25' y='15' width='60' height='60' fill='none' stroke='#555'/><text x='18' y='12'>A</text></svg>"},{"type":"multiple","question":"多选题干","options":["A","B","C"],"answer":[0,2],"explanation":"解析","svg":""},{"type":"fill","question":"填空题干，空位用____","answer":["答案1"],"explanation":"解析","svg":""},{"type":"essay","question":"解答题干","answer":"参考要点","solution":"完整解答","svg":""}]}[/QUIZ]
规则：single 的 answer 是正确选项下标数组（一个元素）；multiple 可多元素；fill 的 answer 按空位顺序；essay 不判分只给参考。题目必须源于给定材料，不得编造。题目类型与数量严格按下文「本次出题数量要求」执行。svg 怎么写照下文「配图要求」，但上面格式示例里那个方框只是演示字段怎么写——照抄进题目等于没配图。除该 JSON 外不要输出任何其他文字。`;

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

/** 读设置；未配过/配置损坏都回退默认（数据容错，ADR-6） */
export function loadQuizMix(): QuizMix {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SETTING_KEY_QUIZ_MIX) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_QUIZ_MIX };
  try {
    return normalizeQuizMix(JSON.parse(row.value) as unknown);
  } catch {
    return { ...DEFAULT_QUIZ_MIX };
  }
}

/** 存设置；落库前先归一化，库里永远是干净值 */
export function saveQuizMix(mix: QuizMix): QuizMix {
  const clean = normalizeQuizMix(mix);
  getDb()
    .prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(SETTING_KEY_QUIZ_MIX, JSON.stringify(clean));
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
  const actual: QuizMix = { single: 0, multiple: 0, fill: 0, essay: 0 };
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
 * `report` 是可选出参：开关状态、丢图数、是否截断回填进去，路由据此如实上报（契约 §2.4）。
 */
export async function generateQuiz(
  topic: string,
  material?: string,
  mix?: QuizMix,
  report?: QuizImageReport,
  styleArg?: AnswerStyle, // 省略＝读库内回答方式偏好（契约 ANSWER-STYLE §3；本行不留余量，故不另起一段注释）
): Promise<QuizPayload | null> {
  const target = routeRole('quiz-generator');
  if (!target || !target.model) return null;
  let acc = '';
  const wanted = mix ?? loadQuizMix();
  // 开关只读一次：提示词与解析硬门必须同源，否则会出现「叫模型画、画完又剥掉」的自相矛盾
  const imageOn = loadQuizImage();
  if (report) report.on = imageOn;
  const prompt = `${QUIZ_PROTOCOL}\n${buildMixInstruction(wanted)}\n${buildImageInstruction(imageOn)}\n${buildAnswerStyleBlock(styleArg ?? loadAnswerStyle(), 'quiz')}\n\n材料：\n${material ? material.slice(0, 60000) : `主题：${topic}`}`;
  for await (const chunk of target.adapter.chat({
    model: target.model,
    apiKey: target.apiKey,
    baseUrl: target.baseUrl,
    messages: [{ role: 'user', content: prompt }],
  })) {
    acc += chunk.content;
    if (chunk.done) {
      // 适配器给出的权威截断信号：撞 max_tokens 时 finish_reason 是 length（不靠猜输出形状）
      if (report && chunk.finishReason === 'length') report.truncated = true;
      break;
    }
  }
  return parseQuizBlock(acc, report, imageOn);
}

// ── 出题配图开关（契约 docs/QUIZ-IMAGE-SPEC.md §2.2）──

/** 库里只认真值 true/'true'，其余一律按关处理（数据容错，ADR-6） */
function normalizeImageFlag(input: unknown): boolean {
  return input === true || input === 'true';
}

/** 读设置；未配过/配置损坏都回退默认（与 loadQuizMix 同一套路） */
export function loadQuizImage(): boolean {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SETTING_KEY_QUIZ_IMAGE) as { value: string } | undefined;
  if (!row) return DEFAULT_QUIZ_IMAGE;
  try {
    return normalizeImageFlag(JSON.parse(row.value) as unknown);
  } catch {
    return DEFAULT_QUIZ_IMAGE;
  }
}

/** 存设置；落库前先归一化，库里永远是干净值 */
export function saveQuizImage(on: boolean): boolean {
  const clean = normalizeImageFlag(on);
  getDb()
    .prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(SETTING_KEY_QUIZ_IMAGE, JSON.stringify(clean));
  return clean;
}

/**
 * 配图指令（v1.1 重写，实测结论见契约 §2.7）。
 * flash 级模型只认「正面强制 + 留合法出口」：v1.0 那套「只有当…才画 / 文字说得清不要配图 /
 * 不要为凑数画图」的劝说式负面措辞等于送模型免费逃逸口——同一模型同一材料，改前 0 图、改后 2~3 图/组。
 */
export function buildImageInstruction(on: boolean): string {
  if (!on) return '本次出题不配图：所有题目的 svg 一律给空字符串 ""，一题也不要画。';
  return [
    '配图要求：凡题干涉及「如图、见图、图形、图像、结构、装置、几何体、光路、受力、电路、流程」的题目，必须给 svg 字段画出对应的示意图，不能只在文字里写「如图」却不给图；',
    '确实不需要示意图的题，svg 给空字符串 ""。每组最多 3 道题配图，其余一律留空——图越多输出越长，越容易撞到模型单次输出的长度上限而被截断。',
    `SVG 写法：属性一律用单引号，例如 <svg viewBox='0 0 120 90'><circle cx='60' cy='45' r='30' fill='none' stroke='#555'/></svg>；这样 SVG 里不出现双引号，不必在 JSON 字符串里做转义。`,
    'SVG 硬约束：根标记必须带 viewBox，宽度不超过 680；禁止 <image> 外链与 <script>；线条与文字不要用纯黑纯白（会按主题替换）；图形元素控制在 20 个以内。',
    'SVG 内容要求：图要把该题给出的条件与所求画明白，标注用 <text>，坐标自己算准——学习软件里一张对不上的错图比没图更坏。',
  ].join('');
}

// ── 题库 ──
export function saveQuiz(data: QuizPayload, source: string, id?: string): string {
  const qid = id ?? randomUUID();
  getDb()
    .prepare('INSERT OR REPLACE INTO quiz_bank (id, title, source, data) VALUES (?, ?, ?, ?)')
    .run(qid, data.title ?? '练习题', source, JSON.stringify(data));
  return qid;
}

export function listQuiz(): Array<{ id: string; title: string; source: string; count: number; created_at: string }> {
  const rows = getDb()
    .prepare('SELECT id, title, source, data, created_at FROM quiz_bank ORDER BY created_at DESC')
    .all() as Array<{ id: string; title: string; source: string; data: string; created_at: string }>;
  return rows.map((r) => {
    let count = 0;
    try {
      count = (JSON.parse(r.data) as QuizPayload).questions.length;
    } catch {
      count = 0;
    }
    return { id: r.id, title: r.title, source: r.source, count, created_at: r.created_at };
  });
}

export function getQuiz(id: string): QuizPayload | null {
  const row = getDb().prepare('SELECT data FROM quiz_bank WHERE id = ?').get(id) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as QuizPayload;
  } catch {
    return null;
  }
}

export function deleteQuiz(id: string): void {
  getDb().prepare('DELETE FROM quiz_bank WHERE id = ?').run(id);
  getDb().prepare('DELETE FROM quiz_stats WHERE quiz_id = ?').run(id);
}

// ── 逐题统计（析环数据源）──
export function recordAnswer(quizId: string, index: number, correct: boolean): void {
  const db = getDb();
  const cur = db
    .prepare('SELECT attempts, correct, streak, best_streak FROM quiz_stats WHERE quiz_id = ? AND question_index = ?')
    .get(quizId, index) as { attempts: number; correct: number; streak: number; best_streak: number } | undefined;
  const attempts = (cur?.attempts ?? 0) + 1;
  const correctCount = (cur?.correct ?? 0) + (correct ? 1 : 0);
  const streak = correct ? (cur?.streak ?? 0) + 1 : 0;
  const best = Math.max(cur?.best_streak ?? 0, streak);
  db.prepare(
    `INSERT INTO quiz_stats (quiz_id, question_index, attempts, correct, streak, best_streak, last_answer)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(quiz_id, question_index) DO UPDATE SET attempts=excluded.attempts, correct=excluded.correct,
       streak=excluded.streak, best_streak=excluded.best_streak, last_answer=excluded.last_answer, updated_at=datetime('now')`,
  ).run(quizId, index, attempts, correctCount, streak, best, correct ? 'correct' : 'wrong');
}

export interface WeakPoint {
  topic: string;
  questionIndexes: number[];
  reason: string;
  suggestion: string;
}

/** 薄弱点分析：本地规则版（错题聚类）+ 可选 AI 报告（analyzer 角色），失败降级本地版。 */
export function analyzeWeakPoints(quizId: string): { weak: WeakPoint[]; fallback: boolean } {
  const quiz = getQuiz(quizId);
  const stats = getDb()
    .prepare('SELECT question_index, attempts, correct, streak FROM quiz_stats WHERE quiz_id = ?')
    .all(quizId) as Array<{ question_index: number; attempts: number; correct: number; streak: number }>;
  const wrong = stats.filter((s) => s.attempts > 0 && s.correct / s.attempts < 0.6);
  if (!quiz || wrong.length === 0) return { weak: [], fallback: true };
  const weak: WeakPoint[] = [
    {
      topic: quiz.title ?? '本题库',
      questionIndexes: wrong.map((w) => w.question_index),
      reason: '正确率低于 60% 的题目',
      suggestion: '针对这些题重新练习，并阅读解析',
    },
  ];
  return { weak, fallback: true };
}
