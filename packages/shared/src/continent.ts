/**
 * shared/continent — 知识大陆（S6 游戏化）的**唯一事实源**：地图铺格 / 怪种派生 / 本地出题 / 图鉴计数。
 *
 * 为什么放 shared：铺格顺序、怪种、题数必须**前端算得和服务端存的一致**。本仓已有先例
 * （`ebbinghaus.ts` 头注）——判定逻辑双写就会出现「页面说这条有怪、点进去却没有题」。
 * 故本文件只放**纯函数**：不碰 IO、不读时钟、不含随机（见下条），server 与 web 都只调用。
 *
 * ── 三条硬口径（改码前必读）────────────────────────────────────────────────────
 *
 * 1. **零随机、零新表、数值全派生**（SPEC §4.2 / 老板拍板）：铺格按 `created_at` 升序从中心
 *    确定性螺旋展开；怪种由词条 id 的 **FNV-1a 稳定哈希**决定；等级由 `review_stage` 派生。
 *    同一份数据任何时候算出同一张地图——否则用户每次刷新都会看到大陆「重排」，那不是地图，
 *    是噪声。（故本文件**不许出现 `Math.random`/`Date.now`**，需要注入的一律由调用方传参。）
 *
 * 2. **怪 = 逾期词条本身**：某格有怪 ⟺ 该格词条 `review.status ∈ {due, overdue}` 且**在复习范围内**。
 *    ⇒ 「点击复习对应词条解除占领」是**自然结果**：答对 → `mark(id,true)` 推进阶段 →
 *    状态离开 due/overdue → 怪消失。**不新增任何状态位**。
 *    ★ 为什么必须带「在复习范围内」：解锁走的是既有 `POST /api/terms/:id/review`，而它对
 *    范围外的词条一律 **409**（`termScope` 闸门）。若把范围外的词条也画成怪，玩家点了必然报错。
 *    故范围外的词条只铺成**普通地块**（可查看、不冒怪）。
 *
 * 3. **题型词汇表与 `QuizQuestion.type` 不同源**（`content-blocks.ts`）：那边有 `single/multiple/
 *    essay`、**没有「连线」**；大陆要的是 judge/choice/fill/match 四型 + 情景题（桩）。
 *    两套词汇表刻意不合并——合并任一侧都会改对方的出题/判分链路。
 *
 * ── 图鉴槽位为什么是「派生的」而不是常数 84 ─────────────────────────────────────
 * 槽位数 = Σ |可用题型|^L (L=1..3)，某槽「已发现」⟺ 有词条映射到该怪种且该词条有复习记录。
 * 于是情景题落地时**只需**把 `scene` 加进 `CONTINENT_PLAYABLE_QTYPES`，图鉴自动扩到 155
 * （= 5+25+125），**不用改任何计数代码**。这也是老板「5 种类型排列组合作为图鉴依据」的直译。
 */
import type { ReviewStatus } from './ebbinghaus.js';

/** 大陆网格：14 列 × 10 行 = 140 格（与桌面 demo 同尺寸，逐格对齐过视觉） */
export const CONTINENT_COLS = 14;
export const CONTINENT_ROWS = 10;
export const CONTINENT_CELLS = CONTINENT_COLS * CONTINENT_ROWS;

/** 怪最高 3 级（1 级怪 = 1 道题 = 1 滴血） */
export const CONTINENT_MAX_LEVEL = 3;

/** 大陆题型（★ 见头注 3：与 `QuizQuestion.type` 不同源） */
export type ContinentQType = 'judge' | 'choice' | 'fill' | 'match' | 'scene';

/**
 * **出怪/出题的可用集**——只有这四种能本地造题。`scene`（情景题）登记在案但暂不参与：
 * 本地造题器对它返回 `null`（**显式空桩**，SPEC §4.2），故它不进这个数组。
 */
export const CONTINENT_PLAYABLE_QTYPES: readonly ContinentQType[] = ['judge', 'choice', 'fill', 'match'];

/** 全题型表（含桩）——标签/配色按它取，将来 scene 落地时只挪一个类型，不动配色 */
export const CONTINENT_QTYPES: readonly ContinentQType[] = ['judge', 'choice', 'fill', 'match', 'scene'];

export const CONTINENT_QLABEL: Record<ContinentQType, string> = {
  judge: '判断题',
  choice: '选择题',
  fill: '填空题',
  match: '连线题',
  scene: '情景题',
};

/** 图鉴里的小标签（一格一个汉字，避免长表换行） */
export const CONTINENT_QSHORT: Record<ContinentQType, string> = {
  judge: '判',
  choice: '选',
  fill: '填',
  match: '连',
  scene: '景',
};

/** 怪身上的色点 = 它的题型序列（一眼看出这只要打几道题、什么题） */
export const CONTINENT_QCOLOR: Record<ContinentQType, string> = {
  judge: '#6fb3ff',
  choice: '#7ee08f',
  fill: '#f2c14e',
  match: '#d98cff',
  scene: '#ff9a6b',
};

/**
 * 宝箱 / 抽卡 / 稀有度：**显式空桩**（SPEC §4.2 硬约束）。
 * ★ 禁建表、禁复制 `rarityOf`（唯一实现在未合分支 `feat/term-cards-game` 的 `shared/src/term-cards.ts`）、
 *   禁复制 v45 四表（`chest_keys`/`chest_open`/`study_task`/`term_pool_candidate`）。
 *   落地条件：该分支合入 main 后，在**订阅侧**接上（游戏化层不得反向依赖学习内核）。
 */
export const CONTINENT_CHEST_ENABLED = false;

/** 空桩的统一文案（UI 只读这一个常量，免得三处各写一句） */
export const CONTINENT_CHEST_NOTICE = '地图宝箱掉落尚未接入；后续复用卡牌奖励规则与账本。';

/** 铺格/出题只要求这几个字段（`ReviewTerm` 与 `ContinentMapTerm` 都满足） */
export interface ContinentTermLike {
  id: string;
  term: string;
  definition: string;
  /** 铺格排序键（`YYYY-MM-DD HH:MM:SS` UTC 文本，字典序 = 时间序）；缺省则退到 id */
  created_at?: string;
}

/** 图鉴派生还需要复习记录（判定「已发现」） */
export interface ContinentCodexTerm extends ContinentTermLike {
  review_stage: number;
  last_reviewed_at: string | null;
}

/** 铺好的一个地块 */
export interface ContinentTile<T extends ContinentTermLike = ContinentTermLike> {
  term: T;
  row: number;
  col: number;
}

/**
 * FNV-1a 32 位哈希——**确定性**（同输入恒同输出，跨进程/跨端一致）。
 * 为什么不用 `Math.random`：怪种必须每次刷新都一样，否则「图鉴」收集的就是幻觉。
 */
export function continentHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 确定性螺旋的格子次序：从网格中心起「右1 下1 左2 上2 右3 …」，越界丢弃，取前 `cols*rows` 格。
 * 词条按时间序填进来 ⇒ **越早入库的词条越靠中心**（知识从中心长出来），且永不重排。
 */
export function spiralCells(cols: number, rows: number): Array<{ row: number; col: number }> {
  const total = cols * rows;
  const out: Array<{ row: number; col: number }> = [];
  const push = (row: number, col: number): void => {
    if (row >= 0 && row < rows && col >= 0 && col < cols) out.push({ row, col });
  };
  let row = Math.floor(rows / 2);
  let col = Math.floor(cols / 2);
  push(row, col);
  let step = 1;
  while (out.length < total) {
    for (let i = 0; i < step; i += 1) push(row, ++col);
    for (let i = 0; i < step; i += 1) push(++row, col);
    step += 1;
    for (let i = 0; i < step; i += 1) push(row, --col);
    for (let i = 0; i < step; i += 1) push(--row, col);
    step += 1;
  }
  return out.slice(0, total);
}

/**
 * 把词条铺进大陆：`created_at` 升序（同值按 id）⇒ 螺旋次序；超出格数**截断**（140 格以外不显示）。
 * ★ 截断是刻意的：地图是「概览」，不是列表——第 141 条词条不该把地图撑爆。
 */
export function layoutTiles<T extends ContinentTermLike>(terms: readonly T[]): Array<ContinentTile<T>> {
  const cells = spiralCells(CONTINENT_COLS, CONTINENT_ROWS);
  const sorted = [...terms].sort((a, b) => {
    const ka = `${a.created_at ?? ''}\u0000${a.id}`;
    const kb = `${b.created_at ?? ''}\u0000${b.id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const out: Array<ContinentTile<T>> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const cell = cells[i];
    const term = sorted[i];
    if (!cell || !term) break;
    out.push({ term, row: cell.row, col: cell.col });
  }
  return out;
}

/** 等级 = 题数 = 血量 = `clamp(1 + floor(stage/2), 1, 3)`（stage 0/1→1、2/3→2、4+→3） */
export function monsterLevel(stage: number): number {
  const s = Math.max(0, Math.trunc(stage) || 0);
  return Math.min(1 + Math.floor(s / 2), CONTINENT_MAX_LEVEL);
}

/** 怪种 = 长度 level 的题型序列；每一滴血对应一道题，序列**有序**（图鉴据此定槽） */
export function speciesTypes(id: string, level: number): ContinentQType[] {
  const n = CONTINENT_PLAYABLE_QTYPES.length;
  const out: ContinentQType[] = [];
  for (let i = 0; i < level; i += 1) {
    out.push(CONTINENT_PLAYABLE_QTYPES[continentHash(`${id}#${i}`) % n] ?? 'judge');
  }
  return out;
}

/** 怪种 key（图鉴/调试用的可读标识，如 `judge+match`） */
export function speciesKey(types: readonly ContinentQType[]): string {
  return types.join('+');
}

/** 图鉴槽总数 = Σ |可用题型|^L (L=1..3) = 4+16+64 = 84（scene 落地后自动变 155） */
export const CONTINENT_CODEX_SLOTS = Array.from({ length: CONTINENT_MAX_LEVEL }, (_, i) =>
  Math.pow(CONTINENT_PLAYABLE_QTYPES.length, i + 1),
).reduce((a, b) => a + b, 0);

/**
 * 题型序列 → 图鉴槽下标（1~3 级各占一段，段内按 |可用题型| 进制编码）。
 * ★ 注意序列是**有序**的：`judge+match` 与 `match+judge` 是两个槽（老板要的「排列组合」）。
 */
export function codexSlot(types: readonly ContinentQType[]): number {
  const base = CONTINENT_PLAYABLE_QTYPES.length;
  let slot = 0;
  for (let l = 1; l < types.length; l += 1) slot += Math.pow(base, l);
  for (let i = 0; i < types.length; i += 1) {
    const idx = CONTINENT_PLAYABLE_QTYPES.indexOf(types[i] ?? 'judge');
    slot += (idx < 0 ? 0 : idx) * Math.pow(base, types.length - 1 - i);
  }
  return slot;
}

/** 槽下标 → 题型序列（`codexSlot` 的逆；图鉴面板据此显示每格是什么组合） */
export function codexSlotTypes(slot: number): ContinentQType[] {
  const base = CONTINENT_PLAYABLE_QTYPES.length;
  let rest = Math.max(0, Math.trunc(slot) || 0);
  let level = 1;
  while (level <= CONTINENT_MAX_LEVEL && rest >= Math.pow(base, level)) {
    rest -= Math.pow(base, level);
    level += 1;
  }
  const types: ContinentQType[] = [];
  for (let i = level - 1; i >= 0; i -= 1) {
    const p = Math.pow(base, i);
    const idx = Math.floor(rest / p);
    rest -= idx * p;
    types.push(CONTINENT_PLAYABLE_QTYPES[idx] ?? 'judge');
  }
  return types;
}

/** 该格该不该冒怪（头注 2）：**在复习范围内** 且 到期/逾期 */
export function monsterOccupies(status: ReviewStatus, inScope: boolean): boolean {
  return inScope && (status === 'due' || status === 'overdue');
}

/** 「已发现」= 有复习记录（`last_reviewed_at` 非空，或阶段已推进过）——纯派生、零存储 */
export function isDiscovered(reviewStage: number, lastReviewedAt: string | null): boolean {
  return (lastReviewedAt ?? '') !== '' || (Math.trunc(reviewStage) || 0) > 0;
}

/**
 * 一条词条贡献的图鉴槽。
 * ★ 取「当前等级及其**全部前缀**」而不是只取当前等级：怪升级时它的题型序列是**长出**来的
 *   （`speciesTypes` 的第 i 位只依赖 `${id}#${i}`，与 level 无关），前缀槽因此天然单调
 *   ——只取当前等级的话，词条一升级，上一等级的图鉴格会**凭空消失**（收集图鉴最忌这个）。
 */
export function codexSlotsForTerm(id: string, stage: number, discovered: boolean): number[] {
  if (!discovered) return [];
  const out: number[] = [];
  for (let l = 1; l <= monsterLevel(stage); l += 1) out.push(codexSlot(speciesTypes(id, l)));
  return out;
}

/** 全库图鉴进度：返回已发现的槽集合（UI 用 `has(slot)` 判断亮不亮） */
export function codexDiscovered(terms: readonly ContinentCodexTerm[]): Set<number> {
  const found = new Set<number>();
  for (const t of terms) {
    for (const slot of codexSlotsForTerm(t.id, t.review_stage, isDiscovered(t.review_stage, t.last_reviewed_at))) {
      found.add(slot);
    }
  }
  return found;
}

// ── 本地出题器（零 AI / 零成本 / 离线可用）─────────────────────────────────────
// 老板裁定①：大陆自带出题器，`term` + `definition` 本地造题。故本段**不依赖任何模型**。

/** 一道大陆题（四型联合；`scene` 无实现，故不在联合里——桩由调用方处理） */
export type ContinentQuestion =
  | { type: 'judge'; prompt: string; statement: string; answer: boolean }
  | { type: 'choice'; prompt: string; options: string[]; answerIndex: number }
  | { type: 'fill'; prompt: string; answer: string }
  /**
   * 连线题：`left` 固定序（题面），`right` 乱序（选项）；`answer[i]` = `left[i]` 应当连到的 `right` 下标。
   * 判分**要求全部连对**（连线题的语义就是「整张图连对」，允许部分对等于给了半分，用户会觉得赚了）。
   */
  | { type: 'match'; prompt: string; left: string[]; right: string[]; answer: number[] };

/** 用户的作答（形状随题型；判分统一走 `gradeAnswer`，UI 不自己比） */
export type ContinentAnswer = boolean | number | string | number[];

/** 判分归一化：去空白 / 去中英标点 / 全角转半角 / 转小写（照抄桌面 demo 的 `norm_text` 口径） */
export function normText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？“”‘’（）【】《》,.;:!?"'()[\]<>~`·\-—_/\\|]/g, '');
}

/** 从池子里按稳定哈希挑 n 条**别的**词条（当干扰项）；同哈希按 id 兜底，保证确定性 */
function pickOthers<T extends ContinentTermLike>(
  pool: readonly T[],
  selfId: string,
  seed: string,
  n: number,
): T[] {
  return pool
    .filter((t) => t.id !== selfId)
    .map((t) => ({ t, k: continentHash(`${seed}|${t.id}`) }))
    .sort((a, b) => (a.k === b.k ? (a.t.id < b.t.id ? -1 : 1) : a.k - b.k))
    .slice(0, n)
    .map((x) => x.t);
}

/** 按稳定哈希重排（选项乱序但不能每次刷新都变） */
function stableOrder<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => continentHash(key(a)) - continentHash(key(b)));
}

/**
 * 造一道题。**桩**：`scene`（或未知题型）返回 `null`——调用方负责退到 `fill` 兜底
 * （见 `buildMonsterQuestions`），从而「血条数 = 题数」这条永远成立。
 */
export function buildQuestion(
  type: ContinentQType,
  term: ContinentTermLike,
  pool: readonly ContinentTermLike[],
  seed: string = term.id,
): ContinentQuestion | null {
  switch (type) {
    case 'judge': {
      const wrong = pickOthers(pool, term.id, `${seed}|judge`, 1)[0];
      // 有干扰项时才可能出「错」题；池子里只有自己 ⇒ 只能出「对」题（不能让玩家无从判断）
      const makeTrue = !wrong || continentHash(`${seed}|judge|t`) % 2 === 0;
      const statement = makeTrue
        ? `${term.term} 的含义是：${term.definition}`
        : `${term.term} 的含义是：${wrong.definition}`;
      return { type: 'judge', prompt: '判断下面这句话对不对', statement, answer: makeTrue };
    }
    case 'choice': {
      const wrongs = pickOthers(pool, term.id, `${seed}|choice`, 3).map((t) => t.definition);
      const options = stableOrder([term.definition, ...wrongs], (d) => `${seed}|opt|${d}`);
      return {
        type: 'choice',
        prompt: `「${term.term}」的意思是？`,
        options,
        answerIndex: options.indexOf(term.definition),
      };
    }
    case 'fill': {
      // 释义里含词条名 ⇒ 挖空它（考「名 → 还原」）；不含 ⇒ 反过来由释义写出词条名
      const prompt = term.definition.includes(term.term)
        ? term.definition.split(term.term).join('____')
        : `根据释义写出词条：${term.definition}`;
      return { type: 'fill', prompt, answer: term.term };
    }
    case 'match': {
      const pairs = [term, ...pickOthers(pool, term.id, `${seed}|match`, 2)];
      if (pairs.length < 2) return null; // 连不起来（池子只有自己）⇒ 退到 fill 兜底
      const left = pairs.map((p) => p.term);
      const right = stableOrder(pairs.map((p) => p.definition), (d) => `${seed}|right|${d}`);
      return {
        type: 'match',
        prompt: '把词条与它的释义连起来',
        left,
        right,
        answer: pairs.map((p) => right.indexOf(p.definition)),
      };
    }
    default:
      // scene：显式空桩（SPEC §4.2）。返回 null 而不是造一道假题——假题会污染血条口径。
      return null;
  }
}

/**
 * 一只怪的完整题组：**一型一道，题数 = 等级 = 血量**。
 * ★ `scene`/`match` 建不出时退到 `fill`（后者只依赖词条自己，永远建得出）。
 */
export function buildMonsterQuestions(
  term: ContinentTermLike,
  level: number,
  pool: readonly ContinentTermLike[],
): ContinentQuestion[] {
  const types = speciesTypes(term.id, level);
  return types.map((type, i) => {
    const seed = `${term.id}#q${i}`;
    return (
      buildQuestion(type, term, pool, seed) ??
      buildQuestion('fill', term, pool, seed) ?? {
        type: 'fill' as const,
        prompt: `根据释义写出词条：${term.definition}`,
        answer: term.term,
      }
    );
  });
}

/** 判分（全仓唯一入口；UI 不自己比字符串——归一化口径只有这一份） */
export function gradeAnswer(q: ContinentQuestion, answer: ContinentAnswer): boolean {
  switch (q.type) {
    case 'judge':
      return typeof answer === 'boolean' && answer === q.answer;
    case 'choice':
      return typeof answer === 'number' && answer === q.answerIndex;
    case 'fill':
      return typeof answer === 'string' && normText(answer) !== '' && normText(answer) === normText(q.answer);
    case 'match': {
      if (!Array.isArray(answer) || answer.length !== q.answer.length) return false;
      return q.answer.every((v, i) => answer[i] === v);
    }
  }
}