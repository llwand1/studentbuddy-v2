/**
 * chat/memory-digest — 长期记忆的**第三条写入路径**：由词条库（行为证据）驱动。
 * 契约 `docs/MEMORY-TREND-SPEC.md` §3。
 *
 * ★ **为什么需要一条新路径**：`memory.ts` 的文件头写着「本层**只由压缩过程写入**」。
 *   压缩沉淀的是**对话里说过的话**；而「用户真正反复在学的领域 / 术语」这个事实，
 *   **词条库比对话更权威**——它是 `usage_count` 数出来的**行为证据**，
 *   不是模型从对话里总结出来的**自我陈述**。两者互补、**并存不替代**：
 *   `profile`/`goal` 仍来自压缩，本文件只写 `preference`。
 *
 * ★ **为什么不新开调度器**：本文件只提供**被调用**的入口，触发点挂在既有 fire-and-forget
 *   链上（`compact.ts` 压缩之后；P4 的督促定时器也会调它）。新增一套调度就要处理
 *   「何时跑 / 跑多少 / 从哪段跑」三个问题，而这两个触发点都已经是天然的「该沉淀了」信号。
 *
 * ★★ **幂等是硬要求，而它反过来约束了 `content` 的写法**（本文件最关键的一处设计）：
 *   `user_memory` 的唯一键是 `(user_id, kind, content)`，冲突时**只刷** `importance` 与
 *   `updated_at`、不新增行。若把提及次数写进 `content`（如 `常学「数学」（累计提及 42 次）`），
 *   那么**次数每变一次就新增一行**，而旧行**再也无法被更新、也永远不会消失**
 *   ⇒ 注入段里会同时出现「累计提及 3 次」与「累计提及 42 次」两条**互相打脸**的记录。
 *   故拆成两件事：
 *     · **身份**（学的是谁）→ 写进 `content`，**必须稳定**；
 *     · **强度**（学得多频）→ 写进 `importance`（`mentionsToImportance`），次数本就该去那儿。
 *   代价是记忆页看不到那个数字——但**领域栏已经显示了**（`GET /api/terms/domains` 的
 *   `mentionCount`），两边都不缺它。真把它搬进画像页的正确做法是给 `user_memory` 加一列
 *   指标（属独立批次），**不是**把它塞进 `content`。
 */
import {
  MEMORY_DIGEST_TOP_DOMAINS,
  MEMORY_DIGEST_TOP_TERMS,
  mentionsToImportance,
} from '@sb/shared';
import type { MemoryDraft } from '@sb/shared';
import { domainStats } from '../learning/domains.js';
import { topMentionedTerms } from '../learning/mention.js';
import { pruneMemoryItems, upsertMemoryItems } from './memory.js';

/** 建草稿的输入：两个已排序的榜（`domainStats().preferred` 与 `topMentionedTerms()`）。 */
export interface DigestInput {
  domains: Array<{ domain: string; mentionCount: number }>;
  terms: Array<{ term: string; count: number }>;
}

/** 三级比较器的名字那一级（`sort` 的比较器必须自洽：`a===b` 时不能返回 1）。 */
function byName(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * 榜单 → 画像草稿（**纯函数**：不碰库、不读时钟，故可单测）。
 *
 * ★ 与 IO 分开的理由：映射规则（谁算偏好、`importance` 怎么算、各取几个）才是回归锁要钉的
 *   东西；混进 DB 读写就只能靠建库来测，而建库测不出边界（先例：`mix-report.ts` 从组件里
 *   把判定逻辑搬出来）。`refreshTermDigest` 只负责「取数 + 落库」，规则全在这里。
 *
 * ★ **内部自己排序**，不信任调用方：纯函数要对自己的输出负责。`domainStats().preferred`
 *   与 `topMentionedTerms()` 都已是全序，但一旦将来有人传进来一个没排过的数组，
 *   「取 top 3」就会变成「取随机的 3 个」——这种 bug 在真实数据下**几乎看不出来**。
 */
export function buildPreferenceDrafts(input: DigestInput): MemoryDraft[] {
  const domains = [...input.domains]
    .filter((d) => d.mentionCount > 0)
    .sort((a, b) => b.mentionCount - a.mentionCount || byName(a.domain, b.domain))
    .slice(0, MEMORY_DIGEST_TOP_DOMAINS);
  const terms = [...input.terms]
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || byName(a.term, b.term))
    .slice(0, MEMORY_DIGEST_TOP_TERMS);

  // 两种前缀刻意不同：注入段是 `【学习偏好】常学领域：X；高频术语：Y`，
  // 「在学哪个方向」与「在抠哪个概念」是两件事，混成一种说法模型就只能读出一半信息。
  const drafts: MemoryDraft[] = [
    ...domains.map((d) => ({
      kind: 'preference' as const,
      content: `常学领域：${d.domain}`,
      importance: mentionsToImportance(d.mentionCount),
    })),
    ...terms.map((t) => ({
      kind: 'preference' as const,
      content: `高频术语：${t.term}`,
      importance: mentionsToImportance(t.count),
    })),
  ];
  // `mentionsToImportance` 对 `count ≤ 0` 返回 0 ⇒ 这里已是二次保险（上面 filter 过）。
  // 保留它是因为**过滤与映射的判定必须一致**：两处口径一旦分叉，就会写进 0 分的记忆
  // ——既不注入、又占 `MEMORY_MAX_ITEMS` 的名额，是纯垃圾。
  return drafts.filter((d) => d.importance > 0);
}

/**
 * 读库 → 建草稿 → **幂等**入库 → 淘汰。返回处理的条数（同 `upsertMemoryItems` 口径，
 * 是**处理数**不是新增行数——重复触发只是刷新 `updated_at`，这正是幂等的表现）。
 *
 * ★ 归属一律走 `ownerId`：本函数会在 `compactIfNeeded` 的 fire-and-forget 里跑，
 *   那时 HTTP 请求早已结束，只能靠调用方显式传下来（同 `compact.ts` 的既有纪律）。
 *   「漏传」的后果是退回本地单人模式（与现状相同），**不是串台**。
 * ★ 词条库目前是**全局表**（无归属列）⇒ 榜单本身不分人，如实写在契约 §6：
 *   多租户下「偏好画像」会取自全库词条，要等 `term_library` 归主之后才精确。
 */
export function refreshTermDigest(ownerId?: string | null): number {
  const drafts = buildPreferenceDrafts({
    domains: domainStats().preferred,
    terms: topMentionedTerms(MEMORY_DIGEST_TOP_TERMS),
  });
  if (drafts.length === 0) return 0;
  const written = upsertMemoryItems(drafts, null, ownerId);
  // 名额是**每人一份**的硬上限（`MEMORY_MAX_ITEMS`）：写进来就要顺手淘汰超出的，
  // 否则偏好画像只增不减，最终会把对话沉淀出来的 `profile` 挤出去——那是本批次最不想要的副作用。
  pruneMemoryItems(ownerId);
  return written;
}
