/**
 * learning/quiz-completeness — 题目**自包含**审查（契约 `docs/QUIZ-COMPLETE-SPEC.md` §2）。
 *
 * 要拦的是这种题：题干写着「阅读材料可知…」「如图所示…」「根据下表…」，可**材料 / 图 / 表并没有跟着题一起出现**。
 * 学生看到只会毫无头绪——而且这种题在**判分链路上是「合法」的**（有题干、有选项、有答案），
 * 所以此前没有任何一道闸会拦它。
 *
 * 本文件只做一件事：**纯函数、零 IO**地回答「这道题引用了什么外部内容？那东西现在在不在题上？」
 *   · `findDependencies(q)`：题干/选项里有哪几类悬空引用（passage 文段 / figure 图 / table 表）；
 *   · `assessQuestion(q)`：引用的东西**是否已随题给出**（material 字段 / svg / photo / 题干内联材料）。
 * 补救（改写补全、找图补全、剔除）在 `quiz-selfcontained.ts`；搜集侧的原图搬运在 `collect-figures.ts`。
 *
 * ★ 设计取舍：**宁可放过、不要误杀**。正则只认「指向外部内容」的固定说法（根据材料 / 如图 / 下表 / the passage），
 *   而不是泛泛的「材料」「图」二字；命中之后还要过一道「给没给」——题干内联了足够长的材料就放行。
 *   `need=none` 对照组（概念题）在评测里专门量误杀率。
 */
import type { QuizPhoto, QuizQuestion } from '@sb/shared';
import { isImageName } from '../storage/image-cache.js';

export type Dependency = 'passage' | 'figure' | 'table';

export interface DependencyFinding {
  kind: Dependency;
  /** 命中的原文片段（给日志和改写提示词用） */
  phrase: string;
}

/** 引用动词（「根据/阅读/由/据……」）——单独把它们拎出来是为了不把「材料」二字本身当引用 */
const V = '(?:阅读|根据|依据|据|结合|读|分析|对照|参照|仔细阅读|认真阅读)';
const DET = '(?:下面|下列|以下|上面|上述|所给|给定|该|这|此|上|下)?(?:的)?';

const PASSAGE_PATTERNS: RegExp[] = [
  new RegExp(`${V}${DET}(?:材料|文段|语段|短文|文章|文字|选文|课文|对话|原文|文言文|诗句|诗歌|资料|案例|文本)`),
  /(?:上述|以上|上面)(?:材料|文字|内容|信息|情境|资料)/,
  /由(?:此|上述|上面)?(?:材料|文段|语段|短文|选文|原文)(?:可知|可见|可以看出)/,
  // 「下列材料中导电性最好的是」这类物理材料题的「材料中」不是引用——lookbehind 排除常见的非引用搭配
  /(?<!下列|以下|这些|常见|各种|以上|哪种|哪些|何种|某种|该种|建筑|保温|绝缘|导电|金属)(?:材料|文段|语段|短文|选文|上文|原文|文本)\s*(?:一|二|三|四|五|[1-5１-５])?\s*(?:中|可知|所述|所示|表明|反映|说明|提到|显示|指出|认为|体现)/,
  /文中|文段中|上文|下文(?!列)|本文(?:中|的)/,
  /\b(?:the|this|above|following)\s+(?:passage|text|article|dialogue|conversation|story|letter|email|notice|paragraph)\b/i,
  /\b(?:according to|based on|from|in)\s+(?:the\s+)?(?:passage|text|article|dialogue|paragraph)\b/i,
  // 英语阅读理解的固定问法（评测里真抓到：「The writer thinks that ____」没有 passage 字样却依赖整篇文章）
  /\b(?:the|this)\s+(?:writer|author)\s+(?:thinks|says|suggests|believes|means|wants|implies|tells|mentions|describes|explains|argues|feels|hopes|intends|advises)\b/i,
  /\bparagraph\s+(?:one|two|three|four|five|\d+)\b|\bthe\s+(?:first|second|third|fourth|last)\s+paragraph\b/i,
  // 语文/英语「画线句」「加点字」——指向被标记的原文
  /(?:画|划)线(?:的|句|部分|处|词语)|加点(?:的|字|词)|下划线(?:的|部分|处)|波浪线/,
];

const FIGURE_PATTERNS: RegExp[] = [
  /如图(?![书馆案])|如下图|如上图|如右图|如左图|见图|图中|图示|图所示|所示图|下图|上图|左图|右图|该图|此图/,
  /图\s*[甲乙丙丁ABCDabcd0-9一二三四五]|读图|看图|据图|观察图|根据图|依据图|由图|结合图|分析图/,
  /(?:漫画|图片|照片|示意图|统计图|柱状图|折线图|扇形图|坐标图|电路图|装置图|曲线图|地图|图像|图象)(?:中|所示|显示|反映|表明|说明)/,
  /(?:观察|阅读|分析|根据|依据|结合|读|看)(?:下面|下列|以下|所给|该|这|此)?(?:的)?(?:漫画|图片|照片|示意图|统计图|柱状图|折线图|扇形图|电路图|装置图|曲线图|地图|图像|图象|图表)/,
  /\b(?:the|this|above|following)\s+(?:figure|picture|diagram|graph|chart|map|photo|image|cartoon)\b/i,
  /\b(?:as shown in|in|from)\s+(?:the\s+)?(?:figure|picture|diagram|graph|chart|map)\b/i,
];

const TABLE_PATTERNS: RegExp[] = [
  /上述数据|以上数据|所给数据|如下数据|上述统计|以上统计|表中数据/,
  /如下表|如上表|见下表|见上表|下表|上表|表中|表格|数据表|统计表|频数分布表|表所示|所给表/,
  /\b(?:the|this|above|following)\s+table\b/i,
];

const PATTERNS: Array<[Dependency, RegExp[]]> = [
  ['passage', PASSAGE_PATTERNS],
  ['figure', FIGURE_PATTERNS],
  ['table', TABLE_PATTERNS],
];

/** 参与匹配的文本：题干 + 选项（「材料中提到的是……」这类引用常出现在选项里）；material 不参与——它是被引用方 */
function surfaceOf(q: Pick<QuizQuestion, 'question' | 'options'>): string {
  return [q.question ?? '', ...(Array.isArray(q.options) ? q.options.map(String) : [])].join('\n');
}

/** 题干里有哪几类悬空引用（同一类只报第一处命中，够改写提示词用了） */
export function findDependencies(q: Pick<QuizQuestion, 'question' | 'options'>): DependencyFinding[] {
  const text = surfaceOf(q);
  const out: DependencyFinding[] = [];
  for (const [kind, pats] of PATTERNS) {
    for (const p of pats) {
      const m = text.match(p);
      if (m) {
        out.push({ kind, phrase: m[0] });
        break;
      }
    }
  }
  return out;
}

const CJK = /[\u3400-\u9fff]/g;
const NUM = /\d+(?:\.\d+)?/g;

/** 文本「实质长度」：汉字算 1，其余非空白字符按 1/3 折算（英文材料 120 个字母≈40 汉字） */
function weight(s: string): number {
  const cjk = (s.match(CJK) ?? []).length;
  const other = s.replace(CJK, '').replace(/\s+/g, '').length;
  return cjk + other / 3;
}

/** 去掉所有含引用短语的句子后，题干还剩多少实质内容——剩得多，说明材料就内联在题干里 */
export function inlineMaterialWeight(q: Pick<QuizQuestion, 'question'>, phrases: string[]): number {
  // 网页摘录常把选项黏在题干后面（「…why did X go to Y? -A. … -B. … -C. …」）；选项不是材料，先切掉，免得把它们算作内联材料
  const stem = (q.question ?? '').replace(/[\s\-–—]*\bA[.．、]\s[\s\S]*?\bB[.．、]\s[\s\S]*$/, '');
  const sentences = stem.split(/(?<=[。？！?!\n])/);
  const rest = sentences.filter((s) => !phrases.some((p) => s.includes(p))).join('');
  return weight(rest);
}

/** 题干内联材料的门槛：约 40 个汉字（或 120 个英文字符）。低于它的「材料」顶多是一句引语，撑不起「根据材料」 */
export const INLINE_MATERIAL_MIN = 40;
/** material 字段的最小长度：太短（如「见上」）不算给了材料 */
export const MATERIAL_MIN_CHARS = 12;

/** material 以「图/漫画/示意图……：」开头＝这是对图的文字转述 */
const FIGURE_DESC = /^\s*[【[]?(?:图|图片|图中|漫画|示意图|图表|图示|图像|图表)[^：:\n]{0,8}[：:】\]]/;

function hasMaterial(q: Pick<QuizQuestion, 'material'>): boolean {
  return (q.material ?? '').trim().length >= MATERIAL_MIN_CHARS;
}

/** material 里是不是表格/数据形状（≥3 个数字，或有竖线/多行） */
function looksTabular(text: string): boolean {
  const nums = (text.match(NUM) ?? []).length;
  return nums >= 3 || /\|/.test(text) || text.split('\n').filter((l) => l.trim()).length >= 2;
}

/** 该类依赖是否**已随题给出** */
export function isSupplied(q: QuizQuestion, kind: Dependency, phrases: string[]): boolean {
  const inline = inlineMaterialWeight(q, phrases) >= INLINE_MATERIAL_MIN;
  const mat = (q.material ?? '').trim();
  switch (kind) {
    case 'passage':
      return hasMaterial(q) || inline;
    case 'figure':
      // 图：svg / 真图 / 以「图……：」「漫画描述：」开头、用文字把图讲清楚的 material。
      // 一段普通文段**不算**图（防「补了篇短文就宣称图有了」）
      return !!q.svg || !!q.photo || (mat.length >= 20 && FIGURE_DESC.test(mat)) || inline;
    case 'table':
      return (hasMaterial(q) && looksTabular(mat)) || !!q.svg || !!q.photo || (inline && looksTabular(q.question ?? ''));
  }
}

export interface Assessment {
  complete: boolean;
  /** 悬空的依赖（引用了、但没给）；complete 时为空 */
  missing: DependencyFinding[];
  /** 全部检出的引用（含已给出的），统计与提示词用 */
  found: DependencyFinding[];
}

/** 一道题的自包含判定：所有检出的引用都已给出 ⇒ complete */
export function assessQuestion(q: QuizQuestion): Assessment {
  const found = findDependencies(q);
  const phrases = found.map((f) => f.phrase);
  const missing = found.filter((f) => !isSupplied(q, f.kind, phrases));
  return { complete: missing.length === 0, missing, found };
}

/** 缺失依赖的人话（进报告 reasons 与改写提示词） */
export function describeMissing(missing: DependencyFinding[]): string {
  const label: Record<Dependency, string> = { passage: '阅读材料', figure: '图', table: '表格数据' };
  return missing.map((m) => `${label[m.kind]}（题干写着“${m.phrase}”）`).join('、');
}

/**
 * 校验并规范一个 photo：src 必须是本站缓存图（`/api/images/<hash>.<ext>`）——外链图/跟踪像素/`javascript:` 一律拒。
 * 用在 commit 复校验：客户端传来的 photo 不可信。不合格返回 undefined（题留着，只丢图）。
 */
export function sanitizePhoto(p: unknown): QuizPhoto | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const o = p as Record<string, unknown>;
  const src = typeof o.src === 'string' ? o.src : '';
  const m = src.match(/^\/api\/images\/([\w.-]+)$/);
  if (!m || !isImageName(m[1]!)) return undefined;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const pageUrl = str(o.pageUrl, 500);
  return {
    src,
    alt: str(o.alt, 200),
    credit: str(o.credit, 200),
    ...(/^https?:\/\//i.test(pageUrl) ? { pageUrl } : {}),
    ...(o.essential === true ? { essential: true } : {}),
  };
}
