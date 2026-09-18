/**
 * learning/trend 单测（`openIsolated` 隔离库，同 `memory-digest.test.ts` 手法）。
 * 钉契约 `docs/MEMORY-TREND-SPEC.md` §4 的两层：
 *  · **纯函数层** `toTrendData` / `trendFallbackSummary`——横轴有没有真的截成 `MM-DD`、
 *    回退摘要里的数字是不是**全部来自入参**；
 *  · **IO 层** `generateTrendCard`——三道闸门（今日已有→数据不足→出卡）、模型失败仍出卡、
 *    幂等、跨天、归属隔离、meta 坏值不毁卡、SSE 广播。
 *
 * ★ 本文件的 `NOW` 取**真实当前时间**（而 `mention.test.ts` 用的是固定日期），这是一处刻意的不同：
 *   趋势卡「当天是否已出过」是拿**库自己写的** `created_at = datetime('now')` 比出来的，而
 *   `appendCard` 不接注入时间 ⇒ 若把 `now` 固定成某个历史日期，`dup` 那条用例就会随日历漂
 *   （今天绿、明天红）。故这里以真实"今天"为原点，**窗口与跨天的边界全部用相对偏移 `at(±n)` 构造**，
 *   断言不依赖具体是几月几号。
 * ★ 造数一律走**真实 `countUsage`**（命中即计数 + 落一行流水），不直接 INSERT 流水表：
 *   直插会把「命中逻辑」与「计数口径」一起绕过，测出来只是我用 SQL 写进去的数（同 P1/P2/P3 的取舍）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coachChannel } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { countUsage, saveTerms } from './terms.js';
import { MENTION_WINDOW_DAYS, type MentionTrend } from './mention.js';
import { listCoachCards } from './coach.js';
import { snapshot } from '../chat/sse-bus.js';
import {
  TREND_MIN_MENTIONS,
  TREND_MIN_TICK_MS,
  TREND_TICK_MS,
  TREND_WINDOW_DAYS,
  generateTrendCard,
  startTrendScheduler,
  toTrendData,
  trendFallbackSummary,
  trendOwners,
} from './trend.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trend-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 真实"现在"（见文件头：`created_at` 是库自己写的，注入不了） */
const NOW = new Date();
/** 相对今天偏移若干天的正午——① 一定落在同一天，② 不受测试运行时刻影响 */
function at(dayOffset: number): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOffset, 12, 0, 0);
}

function seedLibrary(): void {
  saveTerms([
    { term: 'alpha', definition: 'a', domain: 'math', importance: 0.5 },
    { term: 'beta', definition: 'b', domain: 'math', importance: 0.5 },
    { term: 'gamma', definition: 'g', domain: 'english', importance: 0.5 },
  ]);
}

/** 在 `dayOffset` 那天提及 `term` `n` 次（走真实 `countUsage`，它会同时落流水） */
function mention(term: string, n: number, dayOffset = 0, ownerId: string | null = null): void {
  for (let i = 0; i < n; i++) countUsage(term, ownerId, at(dayOffset));
}

interface TrendRow {
  id: string;
  owner_id: string | null;
  content: string;
  meta: string | null;
}

const trendRows = (ownerId: string | null = null): TrendRow[] =>
  getDb()
    .prepare('SELECT id, owner_id, content, meta FROM coach_messages WHERE kind = ? AND owner_id IS ? ORDER BY rowid')
    .all('trend', ownerId) as TrendRow[];

/** 造 3 个领域 1 天的窗口数据（纯函数层的入参） */
const sample = (): MentionTrend => ({
  days: 3,
  labels: ['2026-09-16', '2026-09-17', '2026-09-18'],
  values: [0, 1, 2],
  total: 3,
  topDomains: [{ domain: 'math', count: 3 }],
  topTerms: [{ term: 'alpha', count: 2 }],
});

describe('toTrendData（纯函数：窗口 → 卡片数据）', () => {
  it('横轴截成 `MM-DD`（年份已由窗口表达），且 `labels` 与 `values` **严格等长**', () => {
    const d = toTrendData(sample());
    expect(d.labels).toEqual(['09-16', '09-17', '09-18']);
    expect(d.values).toEqual([0, 1, 2]);
    expect(d.values).toHaveLength(d.labels.length);
    expect(d.total).toBe(3);
    expect(d.windowDays).toBe(3);
  });

  it('榜单与总数**原样透传**（数字只能来自 SQL——本函数不做任何重算）', () => {
    const d = toTrendData(sample());
    expect(d.topDomains).toEqual([{ domain: 'math', count: 3 }]);
    expect(d.topTerms).toEqual([{ term: 'alpha', count: 2 }]);
  });
});

describe('trendFallbackSummary（纯函数：模型不可用时的确定性回退）', () => {
  it('点名**真实数据的头名**并带上次数与窗口——不是"你最近很努力"这类正确但无信息量的话', () => {
    expect(trendFallbackSummary(toTrendData(sample()))).toBe('近 3 天共提及 3 次，最活跃的是「math」（3 次）。');
  });

  it('没有领域榜时退到词条榜（两者都空才只剩总数）', () => {
    const noDomain = { ...toTrendData(sample()), topDomains: [] };
    expect(trendFallbackSummary(noDomain)).toContain('「alpha」');
    const noRank = { ...noDomain, topTerms: [] };
    expect(trendFallbackSummary(noRank)).toBe('近 3 天共提及 3 次。');
  });

  it('★ 摘要里的每个数字都来自入参（回退路径同样不许产出算出来的数）', () => {
    const t = { ...toTrendData(sample()), windowDays: 7, total: 42, topDomains: [{ domain: 'js', count: 9 }] };
    const line = trendFallbackSummary(t);
    expect(line).toContain('7 天');
    expect(line).toContain('42 次');
    expect(line).toContain('「js」（9 次）');
  });
});

describe('trend 常量不变量（改数前先读：这几个数决定"什么时候该出图"）', () => {
  it('窗口与流水同源、下限为 3、tick 为 6 小时且不低于 1 分钟下限', () => {
    expect(TREND_WINDOW_DAYS).toBe(MENTION_WINDOW_DAYS);
    expect(TREND_MIN_MENTIONS).toBe(3);
    expect(TREND_TICK_MS).toBe(6 * 60 * 60 * 1000);
    expect(TREND_MIN_TICK_MS).toBeLessThanOrEqual(TREND_TICK_MS);
  });
});

describe('generateTrendCard（IO：三道闸门 + 幂等 + 归属）', () => {
  it('数据不足（窗口内 < 3 次）⇒ **不出卡**：全 0 的图是负价值，用户会以为功能坏了', async () => {
    seedLibrary();
    mention('alpha', 2, 0);
    const r = await generateTrendCard({ now: NOW, broadcast: false });
    expect(r.reason).toBe('insufficient');
    expect(r.card).toBeNull();
    expect(trendRows()).toEqual([]);
  });

  it('★ 出卡：模型摘要进 `content`、图表数据进 `meta`，数值与流水逐项对得上', async () => {
    seedLibrary();
    mention('gamma', 2, -1); // 昨天：english 2 次
    mention('alpha', 3, 0); // 今天：math 3 次
    const r = await generateTrendCard({ now: NOW, broadcast: false, summarize: async () => '模型写的一句话' });
    expect(r.reason).toBe('ok');
    const card = r.card;
    expect(card?.kind).toBe('trend');
    if (card?.kind !== 'trend') throw new Error('unreachable');

    expect(card.summary).toBe('模型写的一句话');
    expect(card.summarySource).toBe('ai');
    expect(card.windowDays).toBe(TREND_WINDOW_DAYS);
    expect(card.labels).toHaveLength(TREND_WINDOW_DAYS);
    expect(card.values).toHaveLength(TREND_WINDOW_DAYS);
    expect(card.values.at(-1)).toBe(3); // 今天
    expect(card.values.at(-2)).toBe(2); // 昨天
    expect(card.values.reduce((a, b) => a + b, 0)).toBe(5);
    // 榜单按次数降序：math(3) 在前
    expect(card.topDomains.map((d) => d.domain)).toEqual(['math', 'english']);
    expect(card.topTerms.map((t) => t.term)).toEqual(['alpha', 'gamma']);
    // 库行：摘要落 content（与其它卡的 text 同语义）、owner 落 null
    const [row] = trendRows();
    expect(row?.content).toBe('模型写的一句话');
    expect(row?.owner_id).toBeNull();
  });

  it('★ 模型不可用（返回 null）⇒ **卡片照常生成**，摘要退确定性模板并标 `fallback`', async () => {
    seedLibrary();
    mention('alpha', 3, 0);
    const r = await generateTrendCard({ now: NOW, broadcast: false, summarize: async () => null });
    expect(r.reason).toBe('ok');
    if (r.card?.kind !== 'trend') throw new Error('unreachable');
    expect(r.card.summarySource).toBe('fallback');
    expect(r.card.summary).toBe('近 7 天共提及 3 次，最活跃的是「math」（3 次）。');
    expect(r.card.values.at(-1)).toBe(3);
  });

  it('★ 摘要器**抛错**也照样出卡（回退是结构性保证，不是"记得 catch"的约定）', async () => {
    seedLibrary();
    mention('alpha', 3, 0);
    const r = await generateTrendCard({
      now: NOW,
      broadcast: false,
      summarize: () => Promise.reject(new Error('上游 502')),
    });
    expect(r.reason).toBe('ok');
    if (r.card?.kind !== 'trend') throw new Error('unreachable');
    expect(r.card.summarySource).toBe('fallback');
    expect(r.card.summary).toContain('3 次');
  });

  it('★ 幂等：同一天再跑 ⇒ `dup` 且**不新增行**（重启/多跑一次 tick 都不该多一张图）', async () => {
    seedLibrary();
    mention('alpha', 3, 0);
    expect((await generateTrendCard({ now: NOW, broadcast: false, summarize: async () => 'x' })).reason).toBe('ok');
    const again = await generateTrendCard({ now: NOW, broadcast: false, summarize: async () => 'y' });
    expect(again.reason).toBe('dup');
    expect(again.card).toBeNull();
    expect(trendRows()).toHaveLength(1);
    expect(trendRows()[0]?.content).toBe('x'); // 旧卡一个字没动
  });

  it('跨天放行：明天再跑 ⇒ 出第二张（当日闸门只挡同一天，不锁死功能）', async () => {
    seedLibrary();
    mention('alpha', 3, 0);
    await generateTrendCard({ now: NOW, broadcast: false, summarize: async () => 'x' });
    const tomorrow = await generateTrendCard({ now: at(1), broadcast: false, summarize: async () => 'y' });
    expect(tomorrow.reason).toBe('ok');
    expect(trendRows()).toHaveLength(2);
  });

  it('★ 归属隔离：别人的提及不算进我的窗口（我数据不足就不出卡，且卡不串台）', async () => {
    seedLibrary();
    mention('alpha', 5, 0, 'u1');
    expect((await generateTrendCard({ ownerId: 'u2', now: NOW, broadcast: false })).reason).toBe('insufficient');
    expect(trendRows('u2')).toEqual([]);

    const mine = await generateTrendCard({ ownerId: 'u1', now: NOW, broadcast: false, summarize: async () => '我的' });
    expect(mine.reason).toBe('ok');
    expect(trendRows('u1')).toHaveLength(1);
    expect(mine.card?.id).toBe(trendRows('u1')[0]?.id);
  });

  it('★ 定时器不出无主卡：一旦有具名归属，`null` 那一份就不再出（避免把全体聚合算成匿名访客的趋势）', () => {
    expect(trendOwners()).toEqual([null]); // 空库：本地模式是唯一可能出图的人
    seedLibrary();
    mention('alpha', 3, 0, 'u1');
    expect(trendOwners()).toEqual(['u1']); // 有具名用户后，不再备 null 那一份
  });

  it('★ 库行 → 卡片 round-trip：结构化字段逐项还原（`toCard` 是唯一的库行解释点）', async () => {
    seedLibrary();
    mention('gamma', 2, -1);
    mention('alpha', 3, 0);
    const made = await generateTrendCard({ now: NOW, broadcast: false, summarize: async () => '回读' });
    const read = listCoachCards(null).find((c) => c.id === made.card?.id);
    expect(read).toEqual(made.card);
  });

  it('★ meta 坏值**不毁掉整张卡**：坏 JSON 退空图但摘要/窗口仍在，脏榜单行只丢自己', async () => {
    seedLibrary();
    mention('alpha', 3, 0);
    const made = await generateTrendCard({ now: NOW, broadcast: false, summarize: async () => '摘要还在' });
    const id = made.card?.id ?? '';
    const write = (meta: string) => getDb().prepare('UPDATE coach_messages SET meta = ? WHERE id = ?').run(meta, id);

    write('{ 这不是 JSON');
    const broken = listCoachCards(null).find((c) => c.id === id);
    if (broken?.kind !== 'trend') throw new Error('unreachable');
    expect(broken.summary).toBe('摘要还在'); // 正文独立于 meta，坏 meta 不该连正文一起吞
    expect(broken.labels).toEqual([]);
    expect(broken.values).toEqual([]);
    expect(broken.windowDays).toBe(TREND_WINDOW_DAYS); // 缺省取窗口常量（不是 0，0 天读作"没窗口"）
    expect(broken.topDomains).toEqual([]);

    write(JSON.stringify({ topDomains: [{ domain: 'math', count: 2 }, { nope: 1 }, 'x', { domain: 'eng' }] }));
    const partial = listCoachCards(null).find((c) => c.id === id);
    if (partial?.kind !== 'trend') throw new Error('unreachable');
    expect(partial.topDomains).toEqual([{ domain: 'math', count: 2 }]); // 只留形状对的那一行
  });

  it('★ 广播 `coach-card` 到 `coach:<owner>` 频道（前端据此冒气泡；气泡本身属 P5）', async () => {
    seedLibrary();
    mention('alpha', 3, 0);
    const r = await generateTrendCard({ now: NOW, summarize: async () => '推送' });
    const events = snapshot(coachChannel(null)).filter((e) => e.type === 'coach-card');
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev?.type !== 'coach-card') throw new Error('unreachable');
    expect(ev.card.id).toBe(r.card?.id);
    expect(ev.card.summarySource).toBe('ai');
  });
});

describe('startTrendScheduler（定时器可注入）', () => {
  it('起服**立刻先跑一次**（不等一个完整 tick），返回的句柄可清理', async () => {
    seedLibrary();
    mention('alpha', 3, 0);
    const timer = startTrendScheduler({ intervalMs: TREND_MIN_TICK_MS });
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 3000 && trendRows().length === 0) await new Promise((r) => setTimeout(r, 20));
      expect(trendRows()).toHaveLength(1);
    } finally {
      clearInterval(timer);
    }
  });

  it('间隔被钳到下限（误配成 0 会变成热循环，不停查库）', () => {
    seedLibrary();
    const timer = startTrendScheduler({ intervalMs: 0 });
    clearInterval(timer);
    expect(TREND_MIN_TICK_MS).toBeGreaterThanOrEqual(60_000);
  });
});
