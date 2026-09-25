/**
 * learning/trend — 督促趋势卡（契约 `docs/MEMORY-TREND-SPEC.md` §4）。
 *
 * 老板点单那件事的最后一段：「督促功能本身就会自动调用模型，去生成一个 svg 近期学习趋势图，
 * 然后汇报给用户」——本文件是它的**服务端一半**（前端画图与胶囊气泡是 P5）。
 *
 * 四件事，按依赖序：
 *  ① **算窗口**（`mentionTrend`，走流水表＝只覆盖建表之后，故 UI 必须标窗口，§1.5）；
 *  ② **让模型只写一句话摘要**（`summarizeTrend`）——坐标轴/数值/标签**一律来自 SQL**，
 *     模型无权产出（§4.3：它一旦拿到"生成数字"的权力，就会写出好看但与事实不符的曲线，
 *     而趋势图的全部价值就在数字是真的）；
 *  ③ **失败必须能回退**（`trendFallbackSummary`）：模型超时/未绑定/答非所问时用确定性模板，
 *     卡片**照常生成**——主产物是图不是那句摘要，因为模型不可用就让整个功能消失，
 *     等于把功能绑死在可选依赖上；
 *  ④ **幂等**：同一天最多一张（`lastTrendDayKey`），重启或多跑一次 tick 都不会多出图。
 *
 * ★ 定时器是**进程内的**（`startTrendScheduler`）：多实例部署会各跑一份，本仓是本地单实例
 *   应用故现状可接受；将来多实例得换成"抢占式落卡"（靠库里的当日卡去重兜底，本文件已具备）。
 * ★ 一个 tick 做两件事：**刷新词条库驱动的偏好画像**（P3 挂在压缩之后，但轻度用户可能很久
 *   不触发一次压缩 ⇒ 画像长期不刷新，test-plan §6 已挂此账）+ 出当日趋势卡。两者都幂等。
 */
import { coachChannel, localDayKey, type CoachCard } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { publish } from '../chat/sse-bus.js';
import { refreshTermDigest } from '../chat/memory-digest.js';
import { MENTION_WINDOW_DAYS, mentionTrend, shortDayLabel, type MentionTrend } from './mention.js';
import { appendCard, lastTrendDayKey, resolveCoachTarget } from './coach.js';
import { runGameTick } from './game-tick.js';
import type { ChatMessage } from '../llm/types.js';

/** 趋势窗口（天）。与流水窗口同源——两个数一旦各写一份，图上标的天数就会跟曲线对不上 */
export const TREND_WINDOW_DAYS = MENTION_WINDOW_DAYS;
/**
 * 数据不足的下限：窗口内总提及数低于此值**不出卡**。
 * ★ 给一个全是 0 的图是**负价值**（用户会以为功能坏了），不如安静地不出。
 */
export const TREND_MIN_MENTIONS = 3;
/** 检查间隔（6 小时）。天级功能，跑得再勤也不会多出图（当日闸门挡着），只是白花查询 */
export const TREND_TICK_MS = 6 * 60 * 60 * 1000;
/** 间隔下限（1 分钟）：防误配成 0 或负数变成热循环 */
export const TREND_MIN_TICK_MS = 60_000;
/** 摘要字数上限：小窗是一行摘要位，写成长文会把卡片撑开（同 COACH_MAX_REPLY_CHARS 的取舍） */
export const TREND_SUMMARY_MAX_CHARS = 120;
/** 摘要温度：要的是"照着数据说人话"，不是创作——比聊天更低 */
const TREND_SUMMARY_TEMPERATURE = 0.4;
/** 摘要 token 上限（一句话，给足余量又不至于让模型写成小作文） */
const TREND_SUMMARY_MAX_TOKENS = 200;

/**
 * 卡片用的趋势数据：`MentionTrend` 把横轴换成 `MM-DD`（图表横轴塞不下年份，年份已由窗口表达）。
 * **纯数据**，前端再转 SVG（老板拍板「模型出数据、代码出图」）。
 */
export interface TrendData {
  windowDays: number;
  labels: string[];
  values: number[];
  total: number;
  topDomains: Array<{ domain: string; count: number }>;
  topTerms: Array<{ term: string; count: number }>;
}

/**
 * 纯函数：窗口数据 → 卡片数据。
 * ★ 单独成函数是为了**能单测**（无 DB、无时钟）：`labels` 有没有真的截成 `MM-DD`、
 *   `values` 有没有与它等长，这两条错了图就是错的，而在 IO 层很难断言得干净。
 */
export function toTrendData(t: MentionTrend): TrendData {
  return {
    windowDays: t.days,
    labels: t.labels.map(shortDayLabel),
    values: t.values.slice(),
    total: t.total,
    topDomains: t.topDomains.map((d) => ({ domain: d.domain, count: d.count })),
    topTerms: t.topTerms.map((x) => ({ term: x.term, count: x.count })),
  };
}

/**
 * 确定性回退摘要（**模型不可用时照常出卡**的唯一保证，契约 §4.3）。
 * ★ 点名的是**真实数据里的第一名**，不是"你最近很努力"这类正确但无信息量的话；
 *   且数字全部来自入参——回退路径也不许出现任何算出来的数。
 */
export function trendFallbackSummary(t: TrendData): string {
  const head = `近 ${t.windowDays} 天共提及 ${t.total} 次`;
  const top = t.topDomains[0];
  if (top) return `${head}，最活跃的是「${top.domain}」（${top.count} 次）。`;
  const term = t.topTerms[0];
  if (term) return `${head}，提及最多的是「${term.term}」（${term.count} 次）。`;
  return `${head}。`;
}

/** 摘要提示词：只让它写一句话，并**明令禁止造数**（数值权在 SQL 手里） */
const TREND_SUMMARY_PROMPT = [
  '你是学习助手。下面给出用户最近的学习数据。',
  '只做一件事：用**一句话**（不超过 60 字）总结这个趋势，点出最活跃的领域或词条。',
  '★ 只允许引用给定数据里的数字，绝不要自己编造、推算或估算任何数字。',
  '直接输出那句话，不要前缀、不要标题、不要解释、不要 Markdown。',
].join('\n');

/** 把窗口数据摊成模型可读的事实表（**只有事实，没有结论**——结论是模型那一句话的事） */
function trendFacts(t: TrendData): string {
  const daily = t.labels.map((label, i) => `${label}=${t.values[i] ?? 0}`).join(' ');
  const domains = t.topDomains.map((d) => `${d.domain}(${d.count} 次)`).join('、') || '无';
  const terms = t.topTerms.map((x) => `${x.term}(${x.count} 次)`).join('、') || '无';
  return [
    `窗口：近 ${t.windowDays} 天`,
    `每日提及次数：${daily}`,
    `窗口内总提及：${t.total} 次`,
    `提及最多的领域：${domains}`,
    `提及最多的词条：${terms}`,
  ].join('\n');
}

/**
 * 让模型写一句摘要。**返回 null 表示不可用**（未绑定/调用失败/返回空），
 * 由调用方回退到确定性模板——本函数**从不抛**（它跑在后台定时任务里，
 * 抛出去只会变成一条谁也没看见的 unhandled rejection）。
 */
export async function summarizeTrend(
  data: TrendData,
  signal?: AbortSignal,
  ownerId?: string | null,
): Promise<string | null> {
  // ★ `resolveCoachTarget()` 也在 try 里：它读 `role_bindings`/`providers` 两张表，
  //   坏配置（半个 provider 行、解不开的密文）都可能让它抛——而**它抛不该等于卡出不来**。
  try {
    // ★ M2c：定时器是**逐 owner 跑**的（`trendOwners()` 的循环），ownerId 现成在手 ⇒ 直接传下去。
    //   这不是"顺手加的"：不带归属的话，给 A 生成的趋势摘要烧的是平台（或恰好第一个绑定）的额度。
    const target = resolveCoachTarget(ownerId ?? null);
    if (!target?.model) return null;
    const messages: ChatMessage[] = [
      { role: 'system', content: TREND_SUMMARY_PROMPT },
      { role: 'user', content: trendFacts(data) },
    ];
    let acc = '';
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages,
      temperature: TREND_SUMMARY_TEMPERATURE,
      maxTokens: TREND_SUMMARY_MAX_TOKENS,
      streamMode: 'once',
      // 后台任务：排队时给用户正在等的对话让路（同 extractTerms / compactIfNeeded）
      purpose: 'background',
      signal,
    })) {
      if (chunk.content) acc += chunk.content;
      if (chunk.done) break;
    }
    // 换行折成空格：卡片上只有一行摘要位，模型爱分行会把卡片撑高
    const text = acc.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, TREND_SUMMARY_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

/** 一次生成的结果：`reason` 是**正常结果码**（不足/今日已有都不算错误，同 `pushNudge` 的取舍） */
export interface TrendGenerateResult {
  card: CoachCard | null;
  reason: 'ok' | 'dup' | 'insufficient';
}

/**
 * 有流水记录的归属者（含 `null`＝**匿名桶**），定时器按人各出一张。
 *
 * ★ v31（M2d-2）：流水表的"无主"哨兵从 SQL `NULL` 改成 **`''`**（迁移 v31 把该列
 *   改成 `NOT NULL DEFAULT ''`）。故**具名归属 = 非空串**——若沿用原来的 `!== null`，
 *   `''` 会被当成一个"用户"，于是本地单人模式会被派去出一张 `ownerId = ''` 的卡，
 *   而 `appendCard('', …)` 落的是**空串**、`trendRows(null)` 查的是 `IS NULL` ⇒
 *   卡落了但谁读不到（"图出了却看不见"）。
 * ★ 对外契约仍是 `null` = 匿名桶：`ownerForWrite(null)` 正好把它折回 `''`，
 *   于是 `mentionTrend(days, null)` 读的就是这一桶——两套哨兵在**这一个函数里**完成换算。
 */
export function trendOwners(): Array<string | null> {
  const rows = getDb().prepare('SELECT DISTINCT owner_id FROM term_mention_log').all() as Array<{ owner_id: string }>;
  const named = rows.map((r) => r.owner_id).filter((o) => o !== '');
  // ★ 匿名桶**只在库里没有任何具名归属时**才出一份。
  //   理由：`mentionTrend(days, null)` 此时读的就是无主桶，一旦已经有了登录用户，
  //   再为它出一张卡就是把这**所有人**的提及算成"这个匿名访客的趋势"。
  //   本地单人部署里两者等价（库里只有无主行），故这条短路不损失任何真实场景，
  //   只挡住多租户下的错误聚合——注册之后老的无主行不再产卡，与 M2a「孤儿行」同一处置。
  if (named.length === 0) return [null];
  return named;
}

/**
 * 生成（并落库 + 广播）当日趋势卡。
 *
 * 三个闸门，顺序即优先级：
 *  1. `dup` —— 今天已经出过一张 ⇒ 什么都不做（幂等的唯一实现，**不靠内存里的"今天跑过了"标记**
 *     ——那是进程态，重启就没了，而库是事实）；
 *  2. `insufficient` —— 窗口内提及不足 ⇒ 不出卡（全 0 的图是负价值）；
 *  3. 出卡：模型写摘要（失败退模板）→ `appendCard` → 广播 `coach-card`。
 *
 * `now` / `summarize` / `broadcast` 都可注入：跨天边界与"模型挂了"这两条路径
 * 只有把依赖变成参数才测得了（同 `mentionTrend` 的 `now`）。
 */
export async function generateTrendCard(
  opts: {
    ownerId?: string | null;
    now?: Date;
    summarize?: (data: TrendData) => Promise<string | null>;
    broadcast?: boolean;
  } = {},
): Promise<TrendGenerateResult> {
  const ownerId = opts.ownerId ?? null;
  const now = opts.now ?? new Date();
  if (lastTrendDayKey(ownerId) === localDayKey(now)) return { card: null, reason: 'dup' };

  const data = toTrendData(mentionTrend(TREND_WINDOW_DAYS, ownerId, now));
  if (data.total < TREND_MIN_MENTIONS) return { card: null, reason: 'insufficient' };

  // ★ 末尾再兜一层 `.catch(() => null)`：`summarize` 是**可注入**的，注入方（测试、将来的
  //   别的摘要实现）抛错不该把整张卡带走——"回退是硬要求"在这里是**结构性**保证，不是靠约定。
  // ★ M2c：默认实现要带上本轮的 `ownerId`，但**不改可注入签名**（`(data) => …`）——
  //   否则每个注入点都得跟着改一遍，而注入方根本不关心归属。用一层闭包把 ownerId 绑进去。
  const summarize = opts.summarize ?? ((d: TrendData) => summarizeTrend(d, undefined, ownerId));
  const ai = await summarize(data).catch(() => null);
  // ★ 摘要存 `content`（它是这张卡"说给用户的那句话"），图表数据存 `meta`（只给前端渲染）——
  //   两者刻意不同列：`content` 与其它卡的 `text` 同语义，将来要检索/列流水都读得到。
  const card = appendCard(ownerId, 'trend', ai ?? trendFallbackSummary(data), {
    windowDays: data.windowDays,
    labels: data.labels,
    values: data.values,
    topDomains: data.topDomains,
    topTerms: data.topTerms,
    summarySource: ai ? 'ai' : 'fallback',
  });
  if (opts.broadcast !== false && card.kind === 'trend') {
    // ★ 用判别式收窄而不是 `as` 断言：万一 `appendCard` 的解释点将来改坏（返回了别的 kind），
    //   这里会**安静地不广播**而不是把一个形状不对的载荷推给前端。
    const channel = coachChannel(ownerId);
    publish(channel, { type: 'coach-card', sessionId: channel, card });
  }
  return { card, reason: 'ok' };
}

/**
 * 起定时器（**唯一**的生产接线点，`index.ts` 调用）。返回值即定时器句柄，便于测试/停机清理。
 *
 * `intervalMs` 可注入 ⇒「定时器可注入」这条交付判据由签名本身保证。
 * ★ 起服**立刻先跑一次**：否则首张图要等一个完整 tick（6 小时）才可能出现，
 *   而"我刚聊了几轮、重启一下就该看到趋势"才是人的预期。
 * ★ 一个人失败不影响其他人：每人各自 fire-and-forget + 吞错（一个用户的坏数据
 *   不该让另一个用户的图永远不出）。
 */
export function startTrendScheduler(opts: { intervalMs?: number } = {}): ReturnType<typeof setInterval> {
  const tick = () => {
    for (const ownerId of trendOwners()) {
      try {
        // 先刷画像再出图：画像反映的是**总口径**（`usage_count`），图是**窗口口径**，两者独立，
        // 但同属"把词条库的事实沉淀下来"这一件事，放同一个 tick 省一个调度器。
        // ★ 它失败不该连坐出图（两条链的失败原因完全不同），故单独吞在这里。
        refreshTermDigest(ownerId);
      } catch {
        /* 吞掉：见上 */
      }
      void generateTrendCard({ ownerId }).catch(() => undefined);
    }
    // ★ 卡牌侧的三件主动事（派单／对账／提醒开箱）挂在**同一个 tick** 上：契约
    //   `TERM-CARDS-SPEC` §5 点名"不新建调度器"。★ 放在 owner 循环**外面**是有意的——
    //   `runGameTick` 自己按 `term_library` 遍历 owner，那一份 owner 名单与这里的
    //   `trendOwners()`（按提及流水）**不是同一批人**：只存了词、还没聊过天的新用户在这里，
    //   循环里那个 list 会把他漏掉（契约 §0 的立项理由正是"新用户从没被产品主动找过"）。
    try {
      runGameTick();
    } catch {
      /* 吞掉：与本文件那两条同判据——一条链坏不该连坐其余链 */
    }
  };
  tick();
  const every = Math.max(TREND_MIN_TICK_MS, opts.intervalMs ?? TREND_TICK_MS);
  const timer = setInterval(tick, every);
  // 定时器不该把进程钉住（服务自身的 listen 才是保活的那个）
  timer.unref?.();
  return timer;
}
