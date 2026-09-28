/**
 * @sb/shared/npc — 地图学习伙伴（NPC）的跨端口径：遇险判断标准／今日交换余额／名字与台词池／花名册容错解析
 * （契约 `docs/NPC-PARTNER-SPEC.md`）。
 *
 * ★ 为什么放 shared 而不是 server：伙伴的**遇险结论**与**今日还能换几次**必须"跨端一致"
 *   （同一份库在任何端算出同一位伙伴的处境），这是 `continent.ts` 那条 FNV-1a 确定性哈希的同一条判断标准。
 *   前端要画他、服务端要派单，两处若各算一遍，就会出现"图上画着伙伴遇险、任务清单里没有那单"。
 *   ⇒ **唯一实现放这里**，两端只调用，不复制（同 `term-cards.ts` 的 `starOf`/`rarityOf`）。
 *
 * ★★ 2026-09-27（玩家创建制）**改口径**：伙伴不再由词条数自动派生——旧口径
 *   `npcCountFor(词条数)`／`npcTermsToNext`／`placeNpcs(candidates, n)` 那一整套自动派位**退役**
 *   （伙伴不宜太多，由玩家来创建比较好）。现在是**玩家在地图上点一格创建**，
 *   花名册落在 `app_settings` 的 `npc_party` 键上（见 `NpcPartyMember`／`parseNpcParty`）。
 *   ⇒ 本文件只剩四件仍然跨端的事：**遇险判断标准**、**今日交换余额**、**名字与台词池**、**花名册解析**，
 *   外加两条纯公式（名额上限 `npcCapFor`、门票 `npcTasksRequiredFor`）。
 *
 * ★★ 零随机：本文件不许出现 `Math.random` / `Date.now`。伙伴的位置与名字一旦随机，刷新一次就换人，
 *   「他」这个身份（以及用户给他起的名字）立刻失去意义——这是全册最重要的一条实现纪律。
 */
import { continentHash, worldCells } from './continent.js';

/**
 * 伙伴**名额上限**的上下界（上限不再写死，跟世界半径涨）。
 * ★ `NPC_MAX_MIN = 6`：世界再小也"站得下几个人"的密度底（也是旧口径的那个 6）。
 * ★ `NPC_MAX_CAP = 24`：硬上限——再多就"人挤人"，且地图本身也装不下。
 * ⚠️ 密度口径（每 40 格站 1 位）是**产品感受值**，把握度中；要调只改 `npcCapFor` 一处。
 */
export const NPC_MAX_MIN = 6;
export const NPC_MAX_CAP = 24;

/** 世界半径 → 伙伴**名额上限**：`clamp(floor(世界格数 / 40), 6, 24)` ≈ 每 40 格站 1 位 */
export function npcCapFor(radius: number): number {
  const r = Math.max(Math.trunc(radius) || 0, 0);
  const byArea = Math.floor(worldCells(r) / 40);
  return Math.min(Math.max(byArea, NPC_MAX_MIN), NPC_MAX_CAP);
}

/**
 * 创建**第 N 位**伙伴所需的**已完成任务数**（门票：完成一定量的任务等条件）。
 *
 * ★ 第 1 位无条件（`0`）：宣传点是「创建你的 AI 学习伙伴」，用户第一眼必须创建得出来——
 *   一上来就要 3 单任务，他看到的是一枚永远灰着的钮，"这个功能是坏的"。
 * ★ 第 N≥2 位＝`3 × (N-1)`（3／6／9…）：每多一位都要真的做过几单任务，数量自然长不起来。
 * ★★ 口径按**名册序号**算，不按"历史创建次数"：否则"让他回家再重建"就是免费刷位，
 *   门票当场作废（这也是 `removePartner` 必须真的从名册里删掉、而不是打个标记的原因）。
 * ★ 账本用既有 `study_task` 的 `status='done'` 行数（零新表，见 SPEC §2.3）——
 *   它天然把"救伙伴""补池""推进""破停滞"四类单都算进来：**做过的事都算**。
 */
export const NPC_TASKS_PER_PARTNER = 3;

/** 创建第 `ordinal` 位（1 起）所需的已完成任务数：第 1 位 0，第 N≥2 位 `3×(N-1)` */
export function npcTasksRequiredFor(ordinal: number): number {
  const n = Math.max(Math.trunc(ordinal) || 0, 1);
  return NPC_TASKS_PER_PARTNER * (n - 1);
}

/** 「遇险」的判定半径（曼哈顿距离），与「靠近才开打」同一条判断标准 */
export const NPC_DANGER_RANGE = 1;

/** 伙伴名字长度上限（按码点截断，避免劈裂代理对） */
export const NPC_NAME_MAX = 12;

/** 伙伴人设（一句自我介绍）长度上限（按码点截断，同上） */
export const NPC_BIO_MAX = 40;

/** 伙伴花名册的 `app_settings` 键（值 = `{ members: NpcPartyMember[] }`） */
export const SETTING_KEY_NPC_PARTY = 'npc_party';

/** 每天可交换次数（卡是读数不是道具、信物无法消耗 ⇒ 日闸门是唯一真实代价，见 SPEC §6.3） */
export const NPC_TRADES_PER_DAY = 2;

/** 信物门槛：卡数至少这么多才拿得出手（★1 以上 = "我熟"，不是"我刚记下来"） */
export const NPC_TRADE_MIN_CARDS = 2;

/** 求救单的 `kind`（`study_task` 第 4 种，ASCII 键，同三条既有 kind 的判断标准） */
export const NPC_RESCUE_KIND = 'npc_rescue';

/** 交换来源标记（`chest_open.source_kind` 第 3 种） */
export const NPC_TRADE_SOURCE = 'npc';

/** ★ 交换代价的**逐字**文案（SPEC §6.3 明令不许改写成"消耗一张卡"） */
export const NPC_TRADE_COST_LINE =
  '换一次要挑一条你熟的词条（★1 以上）当信物——卡本身不会少，但每天只换得动两次。';

/** ★ 降级说明的**逐字**文案（"降级可以，假装没降级不行"） */
export const NPC_FALLBACK_NOTICE =
  '伙伴现在靠固定台词应答——到设置里给他绑一个模型，他就能真的聊起来。';

/** 默认名字池（创建时 AI 不可用 ⇒ 从这里按哈希取一位；也是"AI 起的名字"的兜底） */
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
 * 花名册里的一位伙伴（**这就是落库的形状**，见 `SETTING_KEY_NPC_PARTY`）。
 * ★ `id` 锚在 `termId` 上（`npc:<termId>`）：他"守哪条知识"是他这个人的定义，
 *   而位置是玩家点的（`row`/`col`），两者都要存 —— 位置不存，刷新一次他就挪窝了。
 * ★★ 位置**存得起**得益于有符号固定中心坐标：世界半径只增不减 ⇒ 已存坐标**永不失效**。
 *   换成"旧坐标 = 世界左上角起算"的老口径，这张表一加词就得整体迁移（这就是它必须存下来的代价）。
 */
export interface NpcPartyMember {
  /** `npc:<termId>` */
  id: string;
  /** 显示名（创建时 AI 起，可被用户改名；两者都归一化到 `NPC_NAME_MAX`） */
  name: string;
  /** 一句人设（创建时 AI 写，降级时用 `npcTemplateBio`） */
  bio: string;
  /** 他守的词条 = 玩家安置他时点的那一格上的词条（★ 身份锚，**不随走位变**） */
  termId: string;
  /** 他**此刻**站的格（伙伴会游走，这两个数会被服务端的走位推进改写） */
  row: number;
  col: number;
  /**
   * 家（玩家当初点的那一格）。游走以它为圆心、`NPC_WANDER_RADIUS` 为半径。
   * ★ 老花名册没有这两个字段 ⇒ 解析时用 `row/col` 补齐（他就站在家门口，语义正确）。
   */
  homeRow: number;
  homeCol: number;
  /** 上次挪步的时刻（毫秒）。0 ⇒ 还没走过，下一次读地图时就地起步 */
  lastStepAt: number;
  /** 已走过的步序：走位的随机种子之一，**必须存**——不存的话每次补步都从 0 开始，路径会重复 */
  stepSeq: number;
}

/**
 * 名额与门票的读数（契约 SPEC §2.3）。
 * ★ 放 shared 而不是 server：**两端都要读它**——地图页用它说"能不能创建"，任务清单用它说
 *   "还差几单"。若只在服务端定义，web 就得再写一份镜像（本册唯一一处不值当的复制）。
 * ★ `blockedBy` 是**服务端算好的一句话**，UI 直接显示它，不许自己按 count/max 再编理由
 *   （两处各编一遍，就会出现"面板说名额满了、地图说还差单据"）。
 */
export interface NpcQuota {
  /** 已在册的伙伴数 */
  count: number;
  /** 名额上限（`npcCapFor(世界半径)`，跟世界涨） */
  max: number;
  /** 已完成任务数（既有 `study_task` 的 `status='done'` 行数，零新表） */
  doneTasks: number;
  /** 创建**下一位**所需的已完成任务数（第 1 位＝0） */
  needTasks: number;
  /** 现在能不能创建（名额／门票／"有没有地可守"三条都过） */
  canCreate: boolean;
  /** 不能创建时的一句人话（能创建时 `''`）；★ 禁静默：钮灰着也要说清为什么 */
  blockedBy: string;
}

/** 一个格子（伙伴站位／可落位格） */
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

/** 伙伴 id：锚在词条 id 上（跨端稳定，且自带"他懂哪块知识"的语义） */
export function npcIdOf(termId: string): string {
  return `npc:${termId}`;
}

/**
 * 名字归一化：丢控制符 + 去首尾空白 + 按码点截断到 12 字；空串表示"没有名字"（调用方自行决定）。
 * ★ 控制符用码点过滤而不是正则：`[\u0000-\u001f]` 会踩 eslint 的 `no-control-regex`
 *   （那条规则防的是"看不见的字符溜进正则"，这里确实是刻意要滤掉它们，故改成显式判断）。
 * ★ 截断按码点（`Array.from`）而不是 `slice`：后者按 UTF-16 单元切，会把 emoji 劈成半个。
 */
function clampText(input: string, max: number): string {
  const kept: string[] = [];
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    kept.push(ch);
  }
  return Array.from(kept.join('').trim()).slice(0, max).join('');
}

export function normalizeNpcName(input: string): string {
  return clampText(input, NPC_NAME_MAX);
}

/** 人设归一化：与名字同一条清洗规则，上限 `NPC_BIO_MAX`（AI 写长了就截，不静默丢整句） */
export function normalizeNpcBio(input: string): string {
  return clampText(input, NPC_BIO_MAX);
}

/** AI 不可用时的兜底名字：`NPC_NAME_POOL[hash % len]`（确定性 ⇒ 同一个词条每次都同一位） */
export function npcNameFromPool(seed: string): string {
  if (NPC_NAME_POOL.length === 0) return '';
  const idx = continentHash(`npcname|${seed}`) % NPC_NAME_POOL.length;
  return NPC_NAME_POOL[idx] ?? NPC_NAME_POOL[0] ?? '';
}

/** AI 不可用时的兜底人设（★ 只说他守的那条词条，不编造用户进度，同降级台词那条判断标准） */
export function npcTemplateBio(term: string): string {
  const label = term.trim() || '自己那块地';
  return normalizeNpcBio(`守着「${label}」的伙伴，聊它最在行。`);
}

/**
 * 花名册容错解析（数据容错 ADR-6）：坏 JSON／坏条目一律**跳过而不抛**，其余照常返回。
 * ★ 逐条校验四样：`termId`／`name` 非空、`row`／`col` 是有限数——缺任一样就丢这一位。
 *   "宁可少一位伙伴，也不要一位没有名字、没有坐标的伙伴"：后者会在画布上变成幽灵节点。
 * ★ 去重按 `id`（= `npc:<termId>`）与 `row,col` 两把尺子：同一条词条不能被两位伙伴守
 *   （否则"他守哪条"这句话就说不清），同一格也不能站两个人。
 * ★ 空串／`{}`／`{members:[]}` 都是合法的"还没有伙伴"，返回 `[]`。
 */
export function parseNpcParty(raw: string): NpcPartyMember[] {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!value || typeof value !== 'object') return [];
  const list = (value as { members?: unknown }).members;
  if (!Array.isArray(list)) return [];
  const out: NpcPartyMember[] = [];
  const seenId = new Set<string>();
  // ★★ 2026-09-28 伙伴会游走那次改动：**去掉了按当前格去重**。
  //   旧口径把 `row,col` 当第二把尺子，是因为那时位置=安置点、一格一人天经地义。
  //   伙伴一旦会走，两位擦肩而过就会短暂同格 —— 再按格去重就会**当场把一位伙伴从名册里删掉**
  //   （连同他的会话与记忆）。位置冲突是**瞬时状态，不是数据错误**：
  //   真正的约束改由走位自己保证（`npcWanderStep` 不迈进已被占的格），
  //   而"一条词条只许一位"仍由 `id`（= `npc:<termId>`）这把尺子守着。
  const seenHome = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as Record<string, unknown>;
    const termId = typeof m.termId === 'string' ? m.termId.trim() : '';
    const name = normalizeNpcName(typeof m.name === 'string' ? m.name : '');
    const row = Math.trunc(Number(m.row));
    const col = Math.trunc(Number(m.col));
    if (!termId || !name || !Number.isFinite(row) || !Number.isFinite(col)) continue;
    const id = typeof m.id === 'string' && m.id ? m.id : npcIdOf(termId);
    // 家的坐标：老记录没有 ⇒ 用当前格补齐（升级前他本就没走过，站的就是家）
    const homeRow = Number.isFinite(Number(m.homeRow)) ? Math.trunc(Number(m.homeRow)) : row;
    const homeCol = Number.isFinite(Number(m.homeCol)) ? Math.trunc(Number(m.homeCol)) : col;
    const home = `${homeRow},${homeCol}`;
    // ★ 去重只剩两把尺子：`id`（一条词条一位）与 `home`（一格只许安置一位）。
    //   当前格不参与——它会变。
    if (seenId.has(id) || seenHome.has(home)) continue;
    seenId.add(id);
    seenHome.add(home);
    out.push({
      id,
      name,
      bio: normalizeNpcBio(typeof m.bio === 'string' ? m.bio : ''),
      termId,
      row,
      col,
      homeRow,
      homeCol,
      lastStepAt: Number.isFinite(Number(m.lastStepAt)) ? Math.trunc(Number(m.lastStepAt)) : 0,
      stepSeq: Number.isFinite(Number(m.stepSeq)) ? Math.trunc(Number(m.stepSeq)) : 0,
    });
    if (out.length >= NPC_MAX_CAP) break;
  }
  return out;
}

/** 曼哈顿距离（★ 只在 shared 里算一次，前端不重算遇险结论） */
export function npcDistance(a: NpcSpot, b: NpcSpot): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

/**
 * 遇险判定：半径 `range` 内最近的一只怪即威胁；同距按 termId 升序取（确定性）。
 * ★ 距离取 1（正相邻）与 `canStrike` 同判断标准：伙伴喊"救命"的位置，就是用户**一步能打到**的位置。
 * ★★ 距离 **0 是合法威胁**（怪就站在他那一格上）：玩家创建时那一格是空的，但之后逾期词条冒出的怪
 *   可能正好压在他身上——这正是"他的地被夺走了"，也是本玩法最想被看见的一幕。
 *   ⇒ 落位规则改由「创建时校验」承担（见 SPEC §2.2），`npcDistress` 本身不再假设"他和怪不同格"。
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