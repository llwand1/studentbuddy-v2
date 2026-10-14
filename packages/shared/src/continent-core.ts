/** continent-core: split domain module; compatible exports remain at continent.ts. */


/**
 * **视口**格数：14 列 × 10 行 ＝ 140 格（672×480 像素，与桌面 demo 同尺寸、逐格对齐过视觉）。
 *
 * ★★ 2026-09-27 起，「视口」与「世界」是**两件事**：
 *   · 视口 ＝ 屏幕看得见的那一块（就是这三个常量，canvas 像素尺寸与命中换算用它）；
 *   · 世界 ＝ 有符号坐标 `(row, col)`、中心 `(0,0)`、半径 `radius`（`worldRadiusFor` 派生，只增不减）。
 *   ⇒ 旧名 `CONTINENT_COLS/ROWS/CELLS` **已删**：它们此前被当成"世界尺寸"用，留着就是名字骗人。
 *   详见 `docs/KNOWLEDGE-CONTINENT-SPEC.md`「开放世界与视口」段。
 */
export const CONTINENT_VIEW_COLS = 14;

export const CONTINENT_VIEW_ROWS = 10;

export const CONTINENT_VIEW_CELLS = CONTINENT_VIEW_COLS * CONTINENT_VIEW_ROWS;

/**
 * 世界半径的上下界（世界共 `(2*radius+1)²` 格）。
 * ★ MIN 取 7 ⇒ 初始世界 15×15＝225 格，**一开始就比视口大**：一眼看得出"视野只是一部分"。
 * ★ MAX 取 40 ⇒ 81×81＝6561 格；真到这个量级才会再出现"铺不下"，那是另一个数量级的词条库。
 */
export const WORLD_MIN_RADIUS = 7;

export const WORLD_MAX_RADIUS = 40;

/** 世界格数（半径 → 格数）。★ 唯一实现：别在别处再写一遍 `(2R+1)**2` */
export function worldCells(radius: number): number {
  const r = Math.max(Math.trunc(radius) || 0, 0);
  return (2 * r + 1) ** 2;
}

/**
 * 词条数 → 世界半径：`clamp(ceil((sqrt(n) - 1) / 2), 7, 40)`。
 *
 * ★★ **必须只增不减**（`sqrt` 单调 ⇒ 天然成立）：这是"加词不挪旧格"的前提——半径只往外扩，
 *   铺格序列是稳定前缀（见 `spiralCells`），已落位的词条与伙伴（`npc:<termId>`）**永不换格**。
 * ★ 为什么按词条数而不是别的：地图是**用户自己词汇量的可见形状**，加词＝开疆。
 *   实测本机数字：`n=0/140 ⇒ R=7`（225 格）、`n=327 ⇒ R=9`（361 格）。
 */
export function worldRadiusFor(termCount: number): number {
  const n = Math.max(0, Math.trunc(termCount) || 0);
  const need = Math.ceil((Math.sqrt(n) - 1) / 2);
  return Math.min(Math.max(need, WORLD_MIN_RADIUS), WORLD_MAX_RADIUS);
}

/** 怪最高 3 级（1 级怪 = 1 道题 = 1 滴血） */
export const CONTINENT_MAX_LEVEL = 3;

/** 大陆题型（★ 见头注 3：与 `QuizQuestion.type` 不同源） */
export type ContinentQType = 'judge' | 'choice' | 'fill' | 'match' | 'scene';

/**
 * **出怪/出题的可用集**——这五种都能本地造题（`scene` 于 2026-09-26 落地）。
 * ★ 这个数组既决定怪的题型序列（`speciesTypes`），也决定图鉴槽总数（`CONTINENT_CODEX_SLOTS`）：
 *   往这里加一个类型，图鉴会**自动**扩容，计数代码一行都不用改。
 */
export const CONTINENT_PLAYABLE_QTYPES: readonly ContinentQType[] = ['judge', 'choice', 'fill', 'match', 'scene'];

/** 全题型表——标签/配色按它取（当前与可用集相同；保留这个别名是为了将来「登记但未开放」的题型） */
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

/** 格子的稳定 key（领地/可通行判定共用，避免两处各拼一次字符串拼法不一致） */
export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * 确定性螺旋的格子次序：**从世界中心 `(0,0)` 起**「右1 下1 左2 上2 右3 …」，超出半径丢弃。
 * 词条按时间序填进来 ⇒ **越早入库的词条越靠中心**（知识从中心长出来），且永不重排。
 *
 * ★★ **为什么把中心钉死成 `(0,0)` 而不像旧版那样取 `floor(rows/2), floor(cols/2)`**：
 *   旧写法下**世界尺寸一变、中心就跟着漂**（10 行→第 5 行、14 行→第 7 行）⇒ 全世界重排，
 *   而开放世界恰恰要求"世界只增不减"。钉死中心后，生成序列**与半径无关**（越界只丢弃）
 *   ⇒ **前 k 格恒同**：加词只在外面续圈，已落位的格一个都不动（`docs/KNOWLEDGE-CONTINENT-SPEC`
 *   「铺格前缀必须稳定」那条）。
 * ★ 返回的是**有符号坐标**（可为负）：世界范围是 `[-radius, radius]²`，中心 `(0,0)`。
 */
export function spiralCells(radius: number): Array<{ row: number; col: number }> {
  const r = Math.max(Math.trunc(radius) || 0, 0);
  const total = worldCells(r);
  const out: Array<{ row: number; col: number }> = [];
  const push = (row: number, col: number): void => {
    if (row >= -r && row <= r && col >= -r && col <= r) out.push({ row, col });
  };
  let row = 0;
  let col = 0;
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
