/**
 * learning/collect-quality — 现场搜集的**辨别层**（契约 `docs/QUIZ-TIER-SPEC.md` §3）。
 *
 * 搜集管道原来只有一道闸：题干前 20 字在页面原文里命中（`collect.ts` 的 `verbatimHit`）。
 * 线上体感的三类漏洞，这一层各补一道：
 *   ① **「首句抄、后半编」**——弱模型把页面上一道题的开头抄来，后半段与选项自己续。
 *      ⇒ `strongVerbatim`：再加**尾锚点**与**选项命中率**两道校验，只在题干够长、选项够多时启用（短题不误杀）。
 *   ② **「练习题当真题」**——搜到的是某博客随手写的练习，题面无从判断是不是考试真题。
 *      ⇒ `classifyExamSource`：按页面标题 / URL / 正文里的考试信号（年份 + 高考/中考/期末/考研/四六级…）判「真题页」，
 *      判不出的**仍是真题档但不加考试标签**——摘录本身经过 verbatim 锁，只是没证据说它上过考场。
 *   ③ **搜索结果乱序**——随手搜「XX 练习题」，排前面的常是内容农场。
 *      ⇒ `KNOWN_QUESTION_SOURCES` 题源登记表 + `rankPicks`：已登记题源与带考试信号的页**先抓**；
 *      抓页上限不变（3 页），只是把好页往前挪。登记表是配置，不是白名单——不在表上的页照抓。
 *
 * 全部纯函数、零 IO，`collect.ts` 只调用不实现（那边 318/400 行，仓规不许再塞逻辑）。
 */
import type { QuizQuestion } from '@sb/shared';

/** 锚点长度：normalize 后取题干前 N 字（再长会因网页排版差异提高误杀，再短则满页皆命中失去校验意义） */
const ANCHOR_CHARS = 20;
/** 题干 normalize 后不足这个字数不设防（短锚点在哪页都能撞见，视为不可校验） */
const MIN_ANCHOR_CHARS = 8;

/**
 * 锚点 normalize：NFKC 折叠全半角（真题页混排 `Ｆ＝ｍａ` 与 `F=ma` 是常态）后
 * 只留字母数字并小写——空白/标点/公式转义差异全部不参与比对。
 * （2026-09-29 自 `collect.ts` 迁入：加强校验要复用同一把尺子，且那边已贴 400 行红线；`collect.ts` 原路径 re-export 保持旧调用点不动。）
 */
export function normalizeForAnchor(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 取题干锚点（normalize 后前 ANCHOR_CHARS 字）。过短返回空串＝不可校验，调用方按未命中处理。 */
export function pickAnchor(question: string): string {
  const n = normalizeForAnchor(question);
  return n.length < MIN_ANCHOR_CHARS ? '' : n.slice(0, ANCHOR_CHARS);
}

/**
 * verbatim 命中判定（契约核心不变量）：锚点必须在某页 normalize 后的原文里存在。
 * 返回命中页下标，未命中 -1。**模型自报的 anchor/page 一律不信**——服务端拿题干自己重算。
 */
export function verbatimHit(question: string, normPages: string[]): number {
  const a = pickAnchor(question);
  if (!a) return -1;
  return normPages.findIndex((p) => p.includes(a));
}

/** 已登记的公开题源（按域名后缀匹配）。`exam` 表示该站以整卷/真题为主，命中即视为考试信号之一。 */
export interface KnownSource {
  host: string;
  label: string;
  exam: boolean;
}

/**
 * 题源登记表——**配置，可增删**，每一行都应能在 `tools/eval/` 里单独跑一遍摘录成功率。
 * 入选标准：公开可访问、页面正文含完整题干与答案（否则 verbatim 锁必挂）、不是纯 SPA 壳。
 * ⚠️ 这里没有做「只抓表内站」：搜索命中什么就抓什么，表只影响**先抓谁**与**考试标签**。
 */
export const KNOWN_QUESTION_SOURCES: readonly KnownSource[] = [
  { host: 'zujuan.xkw.com', label: '组卷网（学科网）', exam: true },
  { host: 'zujuan.21cnjy.com', label: '21 世纪教育网组卷', exam: true },
  { host: 'jyeoo.com', label: '菁优网', exam: true },
  { host: 'tiku.baidu.com', label: '百度题库', exam: false },
  { host: 'zybang.com', label: '作业帮', exam: false },
  { host: 'ppkao.com', label: '考试资料网', exam: true },
  { host: 'shangxueba.com', label: '上学吧', exam: false },
  { host: 'khanacademy.org', label: 'Khan Academy', exam: false },
];

export function knownSourceOf(url: string): KnownSource | null {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return KNOWN_QUESTION_SOURCES.find((s) => host === s.host || host.endsWith(`.${s.host}`)) ?? null;
}

/** 考试信号词（标题/URL/正文首段里出现即计一票；年份单独计一票） */
const EXAM_WORDS = [
  '真题', '高考', '中考', '考研', '期末', '期中', '模拟卷', '模拟题', '联考', '会考', '学业水平',
  '四级', '六级', 'CET', '托福', 'TOEFL', '雅思', 'IELTS', 'GRE', 'SAT', 'ACT',
  '教师资格', '公务员', '国考', '省考', '事业单位', '司法考试', '法考', '注册会计', 'CPA', '一建', '二建',
  '历年', '统考', '统招', '专升本', '自考', '期终', 'past paper', 'past exam', 'exam paper',
];
const YEAR_RE = /(?:19|20)\d{2}\s*(?:年|届|学年)?/;

export interface ExamVerdict {
  /** 是否判为「考试真题页」 */
  exam: boolean;
  /** 命中的证据（如实回显给报告，方便人看着调登记表） */
  signals: string[];
  /** 已登记题源名，未登记则 undefined */
  sourceLabel?: string;
}

/**
 * 判「真题页」：≥ 2 票才算（一个「期末」两个字满网都是），已登记 exam 题源自带一票。
 * 正文只看前 400 字——考试信息通常在页首（卷名/年份），全文扫会被页脚导航条误命中。
 */
export function classifyExamSource(page: { title: string; url: string; text?: string }): ExamVerdict {
  const head = `${page.title} ${(page.text ?? '').slice(0, 400)}`;
  const signals: string[] = [];
  const known = knownSourceOf(page.url);
  if (known?.exam) signals.push(`题源:${known.label}`);
  for (const w of EXAM_WORDS) {
    if (head.toLowerCase().includes(w.toLowerCase())) {
      signals.push(w);
      if (signals.length >= 4) break;
    }
  }
  const year = head.match(YEAR_RE);
  if (year) signals.push(year[0].trim());
  const out: ExamVerdict = { exam: signals.length >= 2, signals };
  if (known) out.sourceLabel = known.label;
  return out;
}

/** 抓页顺序重排：已登记题源 → 标题带考试信号 → 其余；组内保持搜索引擎原序（稳定排序） */
export function rankPicks<T extends { url: string; title: string }>(picks: T[]): T[] {
  const score = (p: T): number => {
    let s = 0;
    if (knownSourceOf(p.url)) s += 2;
    if (classifyExamSource(p).signals.length >= 1) s += 1;
    return s;
  };
  return picks
    .map((p, i) => ({ p, i, s: score(p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.p);
}

/** 题干 normalize 后不足这个长度不做尾锚点校验（短题首尾重叠，校验无意义） */
const TAIL_MIN_CHARS = 40;
const TAIL_CHARS = 16;
/** 选择题至少要有这个比例的选项在页面上命中（4 选项 ⇒ 至少 2 个） */
const OPTION_HIT_RATIO = 0.5;

export interface VerbatimVerdict {
  ok: boolean;
  /** 未过时的真因（进候选 reason） */
  reason?: string;
  /** 选项命中数 / 选项数（无选项时 0/0） */
  optionHits: number;
  optionTotal: number;
}

/**
 * 加强版 verbatim（在 `verbatimHit` 判定出命中页**之后**调用，只对那一页比对）：
 *   · 尾锚点：题干 normalize 后取**末 16 字**，必须也在页面里——挡「首句抄、后半编」；
 *   · 选项命中：选择题的选项去掉「A.」前缀后 normalize，命中率 < 50% 拒——挡「题干抄、选项编」。
 * 两条都只在样本够长时启用；不够长就只信头锚点（保守方向是**少杀**，误杀真题比漏一道更伤信任）。
 */
export function strongVerbatim(q: QuizQuestion, normPage: string, verify: { strict?: boolean } = {}): VerbatimVerdict {
  const opts = q.options ?? [];
  const normOpts = opts
    .map((o) => normalizeForAnchor(o.replace(/^[A-Ha-h][.、．:：)）]\s*/, '')))
    .filter((o) => o.length >= 2);
  const optionHits = normOpts.filter((o) => normPage.includes(o)).length;
  const optionTotal = normOpts.length;
  const base = { optionHits, optionTotal };
  if (!pickAnchor(q.question ?? '')) return { ok: false, reason: '题干过短，无法做原文比对', ...base };

  const n = normalizeForAnchor(q.question ?? '');
  if (verify.strict) {
    const at = normPage.indexOf(n);
    if (at < 0) return { ok: false, reason: '完整题干未在原文连续命中', ...base };
    if (q.type === 'single' || q.type === 'multiple') {
      const values = optsOf(q);
      const plain = values.join('');
      const labeled = values.map((v, i) => `${String.fromCharCode(97 + i)}${v}`).join('');
      const near = normPage.slice(at + n.length, at + n.length + Math.max(256, labeled.length * 3));
      if (values.length < 2 || values.some((v) => !v) || (!near.includes(labeled) && !near.includes(plain))) {
        return { ok: false, reason: '选项未在题干附近成组命中（不可把填空题改写为原题选择题）', ...base };
      }
    }
  }
  if (n.length >= TAIL_MIN_CHARS && !normPage.includes(n.slice(-TAIL_CHARS))) {
    return { ok: false, reason: '题干后半段未在页面原文命中（疑似只抄了开头、后半自行续写）', ...base };
  }
  if (optionTotal >= 2 && optionHits / optionTotal < OPTION_HIT_RATIO) {
    return { ok: false, reason: `选项在页面原文命中过少（${optionHits}/${optionTotal}，疑似选项系自行编写）`, ...base };
  }
  return { ok: true, ...base };
}

function optsOf(q: QuizQuestion): string[] {
  return (q.options ?? []).map((o) => normalizeForAnchor(o.replace(/^(?:[A-Ha-h][.、．:：)）]\s*|[（(][A-Ha-h][)）]\s*)/, '')));
}
