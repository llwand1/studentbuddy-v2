/**
 * @sb/shared/npc — 地图学习伙伴（NPC）的派生公式／名字池／降级台词（契约 `docs/NPC-PARTNER-SPEC.md`）。
 *
 * ★ 为什么放 shared 而不是 server：NPC 的**数量／位置／遇险**三件事必须"跨端一致"
 *   （同一份库在任何端算出同一位伙伴），这是 `continent.ts` 那条 FNV-1a 确定性哈希的同一条判据。
 *   前端要画他、服务端要派单，两处若各算一遍，就会出现"图上画着伙伴遇险、任务清单里没有那单"。
 *   ⇒ **唯一实现放这里**，两端只调用，不复制（同 `term-cards.ts` 的 `starOf`/`rarityOf`）。
 *
 * ★★ 零随机：本文件不许出现 `Math.random` / `Date.now`。伙伴的位置与名字一旦随机，刷新一次就换人，
 *   「他」这个身份（以及用户给他起的名字）立刻失去意义——这是全册最重要的一条实现纪律。
 */
import { continentHash, worldCells, worldRadiusFor } from './continent.js';

/**
 * 伙伴数量上限的**上下界**（2026-09-27 开放世界批改：上限不再写死，跟世界半径涨）。
 * ★ `NPC_MAX_MIN = 6`：世界再小也"看得出多了人"的密度底（也是旧口径的那个 6）。
 * ★ `NPC_MAX_CAP = 24`：硬上限——再多就"人挤人"，且地图本身也装不下。
 * ⚠️ 密度口径（每 40 格站 1 位）是**产品感受值**，把握度中；要调只改 `npcCapFor` 一处。
 */
export const NPC_MAX_MIN = 6;
export const NPC_MAX_CAP = 24;

/** 世界半径 → 伙伴上限：`clamp(floor(世界格数 / 40), 6, 24)` ≈ 每 40 格站 1 位 */
export function npcCapFor(radius: number): number {
  const r = Math.max(Math.trunc(radius) || 0, 0);
  const byArea = Math.floor(worldCells(r) / 40);
  return Math.min(Math.max(byArea, NPC_MAX_MIN), NPC_MAX_CAP);
}

/** 每 8 条词条解锁一位伙伴（★ 按「词条数」不按「领地格数」，理由见 SPEC §2.1） */
export const NPC_TERMS_PER_NPC = 8;

/** 「遇险」的判定半径（曼哈顿距离），与「靠近才开打」同一条判据 */
export const NPC_DANGER_RANGE = 1;

/** 伙伴名字长度上限（按码点截断，避免劈裂代理对） */
export const NPC_NAME_MAX = 12;

/** 伙伴身份的 `app_settings` 键（`{ name: string }`；空串 = 删键回默认） */
export const SETTING_KEY_NPC_PARTNER = 'npc_partner';

/** 每天可交换次数（卡是读数不是道具、信物无法消耗 ⇒ 日闸门是唯一真实代价，见 SPEC §6.3） */
export const NPC_TRADES_PER_DAY = 2;

/** 信物门槛：卡数至少这么多才拿得出手（★1 以上 = "我熟"，不是"我刚记下来"） */
export const NPC_TRADE_MIN_CARDS = 2;

/** 求救单的 `kind`（`study_task` 第 4 种，ASCII 键，同三条既有 kind 的判据） */
export const NPC_RESCUE_KIND = 'npc_rescue';

/** 交换来源标记（`chest_open.source_kind` 第 3 种） */
export const NPC_TRADE_SOURCE = 'npc';

/** ★ 交换代价的**逐字**文案（SPEC §6.3 明令不许改写成"消耗一张卡"） */
export const NPC_TRADE_COST_LINE =
  '换一次要挑一条你熟的词条（★1 以上）当信物——卡本身不会少，但每天只换得动两次。';

/** ★ 降级说明的**逐字**文案（"降级可以，假装没降级不行"） */
export const NPC_FALLBACK_NOTICE =
  '伙伴现在靠固定台词应答——到设置里给他绑一个模型，他就能真的聊起来。';

/** 默认名字池（主伙伴由用户命名覆盖；其余伙伴从这里按哈希取） */
export const NPC_NAME_POOL: readonly string[] = [
  '阿问',
  '小路',
  '灯塔',
  '小满',
  '阿忆',
  '青苔',
  '守夜人',
  '卷卷',
  '拾光',
  '墨点',
  '海螺',
  '豆苗',
];

/**
 * 降级台词池（无 key / 未绑模型时用）。
 * ★ 只谈他守的那条词条与其领域，**不编造用户进度**——编了就会与卡墙／任务清单的数字打架
 *   （`TERM-CARDS-SPEC` §5 那条"两条记录互相打脸"的学费）。
 * `{{term}}` 会被替换成他守的词条名。
 */
export const NPC_FALLBACK_LINES: readonly string[] = [
  '我在这片守「{{term}}」呢，你今天要路过它吗？',
  '「{{term}}」我盯了好些天了，还没把它嚼透。',
  '想聊「{{term}}」的话我随时在——这块地是我的。',
  '我手上「{{term}}」这条最熟，别的地我不敢乱说。',
  '「{{term}}」那头的怪偶尔凑过来，我不太打得过，得靠你。',
  '「{{term}}」的卡你要是攒够了，咱们可以换点新花样。',
  '我记性一般，但「{{term}}」这条记牢了。',
  '路过帮我瞅一眼，「{{term}}」还在不在？',
];

/**
 * 伙伴数量：`clamp(floor(词条数 / 8), 1, npcCapFor(世界半径))`。
 * ★ 下限 1：空大陆也该有一位伙伴在场（宣传点是「创建你的 AI 学习伙伴」）。
 * ★★ 上限**跟世界半径涨**（老板 2026-09-27 裁定「跟着世界涨」）：世界开放后地图不再封在 140 格，
 *   若上限写死，327 条词条就顶死、"开疆拓土"没有奖励感（与 ⑦ 那条相悖）。
 * ★ `radius` **可省**：省了就用 `worldRadiusFor(termCount)` —— 单一入口，调用方传不出"配不上词条数"
 *   的半径（要测边界就显式传，那就是刻意的）。
 */
export function npcCountFor(termCount: number, radius: number = worldRadiusFor(termCount)): number {
  const n = Math.max(0, Math.trunc(termCount) || 0);
  return Math.min(Math.max(Math.floor(n / NPC_TERMS_PER_NPC), 1), npcCapFor(radius));
}

/** 还差几条词条才多一位伙伴；已封顶 ⇒ `null`（UI 用它说 ⑦ 那句激励，不自己算） */
export function npcTermsToNext(termCount: number, radius: number = worldRadiusFor(termCount)): number | null {
  const n = Math.max(0, Math.trunc(termCount) || 0);
  if (npcCountFor(n, radius) >= npcCapFor(radius)) return null;
  const target = (npcCountFor(n, radius) + 1) * NPC_TERMS_PER_NPC;
  return Math.max(target - n, 1);
}

/** 伙伴 id：锚在词条 id 上（跨端稳定，且自带"他懂哪块知识"的语义） */
export function npcIdOf(termId: string): string {
  return `npc:${termId}`;
}

/** 默认名字：`NPC_NAME_POOL[hash % len]`（确定性；同一条词条任何端同名） */
export function npcNameFor(termId: string): string {
  if (NPC_NAME_POOL.length === 0) return '';
  const idx = continentHash(`npcname|${termId}`) % NPC_NAME_POOL.length;
  return NPC_NAME_POOL[idx] ?? NPC_NAME_POOL[0] ?? '';
}

/** 可落脚的候选格（服务端从 `continentMap` + `layoutTiles` 产出，**已过滤掉有怪的格**） */
export interface NpcCandidate {
  termId: string;
  term: string;
  domain: string;
  row: number;
  col: number;
}

/** 一位伙伴（落位结果；`name` 是默认名，主伙伴由服务端用用户命名覆盖） */
export interface NpcPlacement {
  id: string;
  name: string;
  termId: string;
  term: string;
  domain: string;
  row: number;
  col: number;
}

/**
 * 落位：候选格按 `continentHash('npc|' + termId)` 升序（同值按 termId 升序，稳定）取前 `count` 个。
 * ⚠️ 调用方必须**先过滤 `!hasMonster`**：不过滤会出现"伙伴和怪站在同一格"。
 */
export function placeNpcs(candidates: readonly NpcCandidate[], count: number): NpcPlacement[] {
  const want = Math.min(Math.max(Math.trunc(count) || 0, 0), NPC_MAX_CAP);
  if (want <= 0) return [];
  const ranked = [...candidates].sort((a, b) => {
    const ha = continentHash(`npc|${a.termId}`);
    const hb = continentHash(`npc|${b.termId}`);
    if (ha !== hb) return ha - hb;
    return a.termId < b.termId ? -1 : a.termId > b.termId ? 1 : 0;
  });
  const out: NpcPlacement[] = [];
  const seen = new Set<string>();
  for (const c of ranked) {
    if (out.length >= want) break;
    if (seen.has(c.termId)) continue;
    seen.add(c.termId);
    out.push({
      id: npcIdOf(c.termId),
      name: npcNameFor(c.termId),
      termId: c.termId,
      term: c.term,
      domain: c.domain,
      row: c.row,
      col: c.col,
    });
  }
  return out;
}

/** 一个格子（伙伴站位） */
export interface NpcSpot {
  row: number;
  col: number;
}

/** 一只怪的本体格（★ 领地格不算威胁源：那是"地丢了"，不是"被围住"，见 SPEC §5.1） */
export interface NpcMonster {
  termId: string;
  term: string;
  row: number;
  col: number;
}

/** 威胁：最近那只怪的本体 */
export interface NpcThreat {
  termId: string;
  term: string;
  distance: number;
}

/** 曼哈顿距离（★ 只在 shared 里算一次，前端不重算遇险结论） */
export function npcDistance(a: NpcSpot, b: NpcSpot): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

/**
 * 遇险判定：半径 `range` 内最近的一只怪即威胁；同距按 termId 升序取（确定性）。
 * ★ 距离取 1（正相邻）与 `canStrike` 同判据：伙伴喊"救命"的位置，就是用户**一步能打到**的位置。
 */
export function npcDistress(
  npc: NpcSpot,
  monsters: readonly NpcMonster[],
  range: number = NPC_DANGER_RANGE,
): NpcThreat | null {
  const cap = Math.max(0, Math.trunc(range) || 0);
  let best: NpcThreat | null = null;
  for (const m of monsters) {
    const d = npcDistance(npc, m);
    if (d > cap) continue;
    if (!best || d < best.distance || (d === best.distance && m.termId < best.termId)) {
      best = { termId: m.termId, term: m.term, distance: d };
    }
  }
  return best;
}

/** 求救单的去重键（★ 不含会变的数：同一位伙伴始终同一键，见 SPEC §5.2） */
export function npcRescueDedupeKey(npcId: string): string {
  return `npc_rescue:${npcId}`;
}

/** 今天还能换几次（按当天已落账的 `source_kind='npc'` 行数算） */
export function npcTradesLeft(usedToday: number): number {
  const used = Math.max(0, Math.trunc(usedToday) || 0);
  return Math.max(NPC_TRADES_PER_DAY - used, 0);
}

/**
 * 名字归一化：丢控制符 + 去首尾空白 + 按码点截断到 12 字；**空串 = 恢复默认**（调用方删键）。
 * ★ 控制符用码点过滤而不是正则：`[\u0000-\u001f]` 会踩 eslint 的 `no-control-regex`
 *   （那条规则防的是"看不见的字符溜进正则"，这里确实是刻意要滤掉它们，故改成显式判断）。
 * ★ 截断按码点（`Array.from`）而不是 `slice`：后者按 UTF-16 单元切，会把 emoji 劈成半个。
 */
export function normalizeNpcName(input: string): string {
  const kept: string[] = [];
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    kept.push(ch);
  }
  return Array.from(kept.join('').trim()).slice(0, NPC_NAME_MAX).join('');
}

/**
 * 降级台词：按 `continentHash(npcId|轮次)` 在池里确定性选一条，替换 `{{term}}`。
 * ★ 永不空回（词条名缺失时退成一句通用话），因为 NPC 是**常驻元素**，不是一次模型调用。
 */
export function npcFallbackLine(npcId: string, seed: number, term: string): string {
  if (NPC_FALLBACK_LINES.length === 0) return '';
  const label = term.trim() || '你那条词条';
  const idx = continentHash(`${npcId}|${seed}`) % NPC_FALLBACK_LINES.length;
  const line = NPC_FALLBACK_LINES[idx] ?? NPC_FALLBACK_LINES[0] ?? '';
  return line.split('{{term}}').join(label);
}