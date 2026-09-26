/**
 * routes/term-review 端到端（supertest，同 notes.test.ts 手法）。
 *
 * 钉五件事：① 到期/逾期的判定与队列排序（先还旧账）；② 打卡的推进与归零；
 * ③ 入参校验与 404；④ 写接口吃同一道跨源闸门；⑤ **复习范围**（v28 选择式复习，契约 §9）。
 * ★ 造「逾期」的办法是直接改 `last_reviewed_at`（`datetime('now','-N days')`），
 *   不是改系统时间——天数判定与真实时钟同源，改时钟会让用例与 CI 时区纠缠。
 * ★ v28 起**新词条默认不在复习范围**（默认全不选，老板 2026-09-18 拍板）⇒ `addTerm`
 *   默认顺手把词条勾进范围，否则本文件前半部分会集体"看不见自己造的词条"。
 *   范围本身的默认值由 `describe('复习范围')` 单独钉，不靠改这个 helper 表达。
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';

const { app, request, getDb, closeDb } = await boot('term-review-test');
const origin = TEST_ORIGIN;

interface ReviewBody {
  id: string;
  term: string;
  review_stage: number;
  last_reviewed_at: string | null;
  review: { stage: number; daysSince: number; overdueDays: number; status: string; intervalDays: number };
}

/** 队列条目（v1.2 起每条多一个 `segment`，标明它来自三段里的哪一段，契约 §10.3） */
interface QueueItemBody extends ReviewBody {
  segment: 'due' | 'extra' | 'repeat';
}

/** 队列响应（v1.2 起是**对象**：条目 + 目标 + 进度 + 池子大小，契约 §10.7） */
interface QueueResult {
  items: QueueItemBody[];
  goal: { count: number; domains: string[] };
  doneCards: number;
  doneTerms: number;
  poolSize: number;
}

/** 设复习范围（领域级 / 词条级同一端点，靠 body 里的键区分） */
/**
 * 范围写口。★ `enabled` **刻意是可选的**：本 helper 的职责之一就是发**故意畸形**的请求体
 * （验「缺字段 → 400」那一格）。写成必填会让「不传 `enabled`」这条用例**编译不过**——
 * 而那正是它要测的东西。
 */
const scope = (body: { domain?: string; termId?: string; enabled?: unknown }) =>
  request(app).put('/api/terms/review/scope').set('Origin', origin).send(body);

const scopeTerm = (termId: string, enabled: boolean) => scope({ termId, enabled });
const scopeDomain = (domain: string, enabled: boolean) => scope({ domain, enabled });

/** 建词条；`inScope` 默认 true（把词条勾进复习范围），传 false 造"范围外"的词条 */
const addTerm = async (term: string, domain = 'math', inScope = true): Promise<string> => {
  const res = await request(app)
    .post('/api/terms')
    .set('Origin', origin)
    .send({ term, definition: `${term} 的释义`, domain })
    .expect(201);
  const id = (res.body as { id: string }).id;
  if (inScope) await scopeTerm(id, true).expect(200);
  return id;
};

/** 把某词条的上次复习时间往回拨 N 天（造欠账） */
const age = (id: string, days: number): void => {
  getDb()
    .prepare(`UPDATE term_library SET last_reviewed_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${days} days`, id);
};

const overview = async () => {
  const res = await request(app).get('/api/terms/review/overview').expect(200);
  return res.body as {
    total: number;
    due: number;
    overdue: number;
    fresh: number;
    todayDone: number;
    /** v1.2：今日**张数**（含重复打卡）——日目标进度的分子（契约 §10.6） */
    todayCards: number;
    mastered: number;
    maxOverdueDays: number;
    recent: Array<{ day: string; done: number }>;
  };
};

/**
 * 今日队列的**条目**。
 * ★ v1.2 起响应是对象（多了目标与进度），本 helper 只取 `items`——**老用例不关心目标**，
 *   让它们继续拿数组，是为了把本批的改动面压在"新增"上，而不是顺手改二十处调用点。
 */
const queue = async (limit?: number) => {
  const res = await request(app).get(limit ? `/api/terms/review/queue?limit=${limit}` : '/api/terms/review/queue').expect(200);
  return (res.body as QueueResult).items;
};

/** 队列的**完整响应**（目标 + 进度 + 池子大小）——v1.2 的用例用它 */
const queueFull = async (limit?: number, domain?: string) => {
  const p = new URLSearchParams();
  if (limit !== undefined) p.set('limit', String(limit));
  if (domain) p.set('domain', domain);
  const qs = p.toString();
  const res = await request(app).get(`/api/terms/review/queue${qs ? `?${qs}` : ''}`).expect(200);
  return res.body as QueueResult;
};

/** 读目标（未配过回默认 `{count:0,domains:[]}`） */
const readGoal = async () => {
  const res = await request(app).get('/api/terms/review/goal').expect(200);
  return res.body as { count: number; domains: string[] };
};

/** 写目标（v1.2）。★ body **刻意是可选的/可以是畸形值**：本 helper 也用来验"坏输入被归一" */
const writeGoal = (body: unknown) =>
  request(app).put('/api/terms/review/goal').set('Origin', origin).send(body as object);

const mark = (id: string, remembered: boolean) =>
  request(app).post(`/api/terms/${id}/review`).set('Origin', origin).send({ remembered });

afterAll(() => closeDb());

describe('词条复习 — 到期判定与队列', () => {
  it('刚入库的词条：fresh 计 1、不进队列（第一次复习在 1 天后）', async () => {
    await addTerm('闭包');
    const ov = await overview();
    expect(ov.total).toBeGreaterThanOrEqual(1);
    expect(ov.fresh).toBeGreaterThanOrEqual(1);
    expect((await queue()).map((t) => t.term)).not.toContain('闭包');
  });

  it('欠账 3 天（stage0 间隔 1 天）→ 进队列、逾期 2 天、status=overdue', async () => {
    const id = await addTerm('柯里化');
    age(id, 3);
    const q = await queue();
    const hit = q.find((t) => t.id === id);
    // 状态由服务端算好返回：前端不再自己判一次，两边不可能打脸
    expect(hit?.review).toMatchObject({ stage: 0, daysSince: 3, overdueDays: 2, status: 'overdue', intervalDays: 1 });
    const ov = await overview();
    expect(ov.overdue).toBeGreaterThanOrEqual(1);
    expect(ov.maxOverdueDays).toBeGreaterThanOrEqual(2);
  });

  it('★ 先还旧账：逾期 10 天排在逾期 2 天之前', async () => {
    const old = await addTerm('单调栈');
    const recent = await addTerm('并查集');
    age(old, 10);
    age(recent, 2);
    const q = await queue();
    expect(q.findIndex((t) => t.id === old)).toBeLessThan(q.findIndex((t) => t.id === recent));
  });

  it('limit 归一（0 / 负数 / 巨大值都不炸，且不超过队列长度）', async () => {
    await queue(0);
    await queue(-5);
    const q = await queue(1);
    expect(q.length).toBeLessThanOrEqual(1);
  });
});

describe('词条复习 — 打卡', () => {
  it('记住了 → 推进一个节点（0→1），并立刻离开队列；忘了 → 归零', async () => {
    const id = await addTerm('记忆化搜索');
    age(id, 5);
    const done = await mark(id, true).expect(200);
    expect((done.body as ReviewBody).review_stage).toBe(1);
    expect((done.body as ReviewBody).review.intervalDays).toBe(2); // 阶段 1 = 2 天后
    expect((await queue()).map((t) => t.id)).not.toContain(id);

    const forgot = await mark(id, false).expect(200);
    expect((forgot.body as ReviewBody).review_stage).toBe(0); // 经典重来
    expect((forgot.body as ReviewBody).review.daysSince).toBe(0);
  });

  it('今日已复习按词条去重（同一条复习三次只算一个）', async () => {
    const id = await addTerm('汉诺塔');
    age(id, 9);
    const before = await overview();
    await mark(id, true).expect(200);
    await mark(id, true).expect(200);
    const after = await overview();
    expect(after.todayDone - before.todayDone).toBe(1);
    expect(after.recent.at(-1)?.done).toBeGreaterThanOrEqual(1);
  });

  it('校验与 404：remembered 非布尔 400；词条不存在 404', async () => {
    const id = await addTerm('拓扑排序');
    await mark(id, 'true' as unknown as boolean).expect(400);
    await request(app).post(`/api/terms/${id}/review`).set('Origin', origin).send({}).expect(400);
    await mark('no-such-term-id', true).expect(404);
  });

  it('写操作无 Origin → 403（与其余写接口同一道闸门）', async () => {
    await request(app).post('/api/terms/x/review').send({ remembered: true }).expect(403);
  });
});

/**
 * ★ v28 复习范围（契约 EBBINGHAUS-SPEC §9）：本仓最容易被写歪的是"范围判定有两份"
 *   ——概览说欠 3 条、队列里 0 条。故本组**每个用例都同时断言概览与队列**，
 *   只断言一边的话，另一边的过滤漏写也照样绿。
 * ★ 各用例用**独立领域**（`scope-a` / `scope-b` …）且查询都带 `?domain=`：
 *   领域开关与复习池是全局状态，用全量查询会让用例互相污染（实测：前一组用例攒下的
 *   逾期词条会把队列的 20 条上限占满，新勾的词条根本挤不进去，断言失败但代码是对的）。
 * ★ 另有一条**必须记住的时序**：勾进范围会触发「清零重来」（见下 §清零重来用例），
 *   所以「造欠账（`age`）→ 再勾选」的顺序会把刚造的欠账抹掉。凡是要断言"进队列"的用例，
 *   `age` 必须排在勾选**之后**。
 */
describe('词条复习 — 复习范围（v28 选择式复习）', () => {
  const overviewOf = async (domain: string) => {
    const res = await request(app).get(`/api/terms/review/overview?domain=${encodeURIComponent(domain)}`).expect(200);
    return res.body as { total: number; due: number; overdue: number; fresh: number };
  };
  const queueOf = async (domain: string) => {
    const res = await request(app).get(`/api/terms/review/queue?domain=${encodeURIComponent(domain)}`).expect(200);
    // v1.2：响应是对象，这里取条目（老用例不关心目标与进度）
    return (res.body as QueueResult).items;
  };

  it('★ 默认全不选：新词条不进概览、不进队列；勾选后才进（且按清零重来算作"从未复习"）', async () => {
    const id = await addTerm('未选词条', 'scope-a', false);
    age(id, 5); // 造一笔逾期：若范围过滤漏写，它就会冒出来
    expect((await overviewOf('scope-a')).total).toBe(0);
    expect((await overviewOf('scope-a')).overdue).toBe(0);
    expect(await queueOf('scope-a')).toHaveLength(0);

    await scopeTerm(id, true).expect(200);
    const ov = await overviewOf('scope-a');
    expect(ov.total).toBe(1);
    // 纳入即清零（老板拍板「清零重来」）⇒ 它变成"从未复习"的 fresh，故**不立刻进队列**
    // （第一次复习在 1 天后）。这条同时证明了清零规则真的生效。
    expect(ov.fresh).toBe(1);
    expect(await queueOf('scope-a')).toHaveLength(0);
  });

  it('★ 词条级反选：领域开着也能把单条移出（反选后概览与队列同步消失）', async () => {
    const id = await addTerm('单条反选', 'scope-b'); // 先勾上
    age(id, 5);
    expect((await queueOf('scope-b')).map((t) => t.id)).toContain(id);
    expect((await overviewOf('scope-b')).overdue).toBe(1);

    await scopeTerm(id, false).expect(200);
    // ★ 两条断言缺一不可：只查队列的话，"概览漏过滤"这个 bug 照样绿。
    expect(await queueOf('scope-b')).toHaveLength(0);
    expect((await overviewOf('scope-b')).total).toBe(0);
    expect((await overviewOf('scope-b')).overdue).toBe(0);
  });

  it('★ 领域级一键纳入：该域全部词条进来，且**将来新增的词条自动跟随**', async () => {
    const a = await addTerm('域内甲', 'scope-c', false);
    const b = await addTerm('域内乙', 'scope-c', false);
    expect((await overviewOf('scope-c')).total).toBe(0);

    const r = await scopeDomain('scope-c', true).expect(200);
    expect((r.body as { enabled: boolean }).enabled).toBe(true);
    expect((await overviewOf('scope-c')).total).toBe(2);

    age(a, 5);
    age(b, 5);
    expect((await queueOf('scope-c')).map((t) => t.id).sort()).toEqual([a, b].sort());

    // ★ 这条是本设计（领域开关持久 + 词条覆盖位 NULL = 继承）的**唯一理由**：
    //   AI 每轮对话都会往已选领域里抽新词，新词必须自动进复习池，
    //   否则复习池会静默漏词——那种缺陷几个月后才发现，且用户完全无从察觉。
    await addTerm('域内新词', 'scope-c', false); // 新建时**不写任何范围字段**
    expect((await overviewOf('scope-c')).total).toBe(3);
  });

  it('★ 领域级一键移出：整域出范围（含被显式勾进来的词条），概览与队列同步清零', async () => {
    const id = await addTerm('域内丙', 'scope-d'); // 显式 1（不是继承）
    age(id, 5);
    expect((await queueOf('scope-d')).map((t) => t.id)).toContain(id);

    await scopeDomain('scope-d', false).expect(200);
    expect(await queueOf('scope-d')).toHaveLength(0);
    expect((await overviewOf('scope-d')).total).toBe(0);
  });

  it('★ 清零重来：移出再纳入 → stage 与 last_reviewed_at 打回原形（流水不抹）', async () => {
    const id = await addTerm('清零重来', 'scope-e');
    age(id, 5);
    await mark(id, true).expect(200); // stage 0 → 1

    await scopeTerm(id, false).expect(200); // 移出（进度保留，只是不催）
    const kept = getDb().prepare('SELECT review_stage FROM term_library WHERE id = ?').get(id) as {
      review_stage: number;
    };
    expect(kept.review_stage).toBe(1); // ★ 移出**不清零**——"移出"不等于"忘了"

    const back = await scopeTerm(id, true).expect(200); // 再纳入 ⇒ 清零重来（老板拍板）
    expect((back.body as { resetCount: number }).resetCount).toBe(1);
    const row = getDb()
      .prepare('SELECT review_stage, last_reviewed_at FROM term_library WHERE id = ?')
      .get(id) as { review_stage: number; last_reviewed_at: string | null };
    expect(row.review_stage).toBe(0);
    expect(row.last_reviewed_at).toBeNull();
    // ★ 流水**不抹**：清零清的是"进度"，不是"历史"——那条打卡确实发生过，
    //   抹掉它等于篡改曲线图的横坐标（契约 §9.4 已登记这条边界）。
    expect(
      (getDb().prepare('SELECT COUNT(*) AS c FROM term_review_log WHERE term_id = ?').get(id) as { c: number }).c,
    ).toBe(1);
  });

  it('★ 覆盖位不冗余：目标与领域开关一致时写 NULL（回归继承），不一致才写显式值', async () => {
    const id = await addTerm('覆盖位', 'scope-f', false);
    const raw = () =>
      (getDb().prepare('SELECT review_enabled FROM term_library WHERE id = ?').get(id) as {
        review_enabled: number | null;
      }).review_enabled;

    // 领域关（0）+ 目标关（0）⇒ 一致 ⇒ NULL（没必要把"跟默认一样"固化成一列）
    await scopeTerm(id, false).expect(200);
    expect(raw()).toBeNull();
    // 领域关 + 目标开（1）⇒ 不一致 ⇒ 显式 1
    await scopeTerm(id, true).expect(200);
    expect(raw()).toBe(1);
    // 打开领域 ⇒ 覆盖位被一并清掉（一键全开），此后该词条跟随领域
    await scopeDomain('scope-f', true).expect(200);
    expect(raw()).toBeNull();
    await scopeTerm(id, false).expect(200);
    expect(raw()).toBe(0);
    await scopeTerm(id, true).expect(200);
    expect(raw()).toBeNull(); // 与领域值一致 ⇒ 回归继承
  });

  it('★ 未纳入范围的词条拒绝打卡（409），不存在的词条仍是 404', async () => {
    const id = await addTerm('范围外打卡', 'scope-g', false);
    age(id, 5);
    // 409 与 404 必须分开：前者是"去勾选范围"，后者是"词条没了，刷新列表"——
    // 压成一个码，前端就没法给出正确的下一步。
    const res = await mark(id, true).expect(409);
    expect((res.body as { error: string }).error).toContain('未纳入复习范围');
    await mark('no-such-term-id', true).expect(404);
    // 打卡被拒 ⇒ 库里不得留下任何痕迹（否则出现"记了一次复习但页面上看不到"的静默错账）
    expect(
      (getDb().prepare('SELECT COUNT(*) AS c FROM term_review_log WHERE term_id = ?').get(id) as { c: number }).c,
    ).toBe(0);
  });

  it('范围写口的入参校验：enabled 非布尔 400；domain/termId 必须恰好给一个；领域不存在 404', async () => {
    await scope({ termId: 'x', enabled: 'true' }).expect(400);
    await scope({ termId: 'x' }).expect(400);
    await scope({ enabled: true }).expect(400);
    await scope({ domain: 'a', termId: 'b', enabled: true }).expect(400); // 两个都给：不接受猜测
    await scope({ domain: '   ', enabled: true }).expect(400); // 空白串等于没给
    await scope({ domain: 'no-such-domain', enabled: true }).expect(404);
    await scope({ termId: 'no-such-term', enabled: true }).expect(404);
  });

  it('范围写口吃同一道跨源闸门（无 Origin → 403）', async () => {
    await request(app).put('/api/terms/review/scope').send({ domain: 'math', enabled: true }).expect(403);
  });
});

/**
 * ★ v1.2 自定义复习目标（契约 EBBINGHAUS-SPEC §10）：本组钉四件事——
 *   ① 三段补位的**顺序与来源**（真账 → 提前背 → 重复巩固，§10.3）；
 *   ② ★★ **同日只推进一次**（§10.5，本节的 P0：不做这个闸门，用户一天刷 7 遍就能从
 *      stage 0 直接毕业，60 天的曲线计划 20 分钟刷完——整个复习体系的价值归零）；
 *   ③ 两个计数各司其职（`todayCards` 含重复 / `todayDone` 去重，§10.6）；
 *   ④ **`count = 0` 时退回 v1.1 行为**（§10.2 的向后兼容承诺：不设目标 = 什么都没变）。
 * ★ 目标是 `app_settings` 里**按用户**的全局配置（不分领域）⇒ 每个用例结束都要重置，
 *   否则"设了目标 3 条"会漏进后面的用例，让它们看到意料之外的队列长度。
 * ★ 造"未到期"的词条不需要任何操作：新建即 `upcoming`（stage 0 的间隔是 1 天，
 *   入库当天 `daysSince = 0 < 1`）。
 */
describe('词条复习 — 自定义目标（v1.2）', () => {
  afterEach(async () => {
    await writeGoal({ count: 0, domains: [] }).expect(200);
  });

  const lastReviewedAt = (id: string): string | null =>
    (
      getDb().prepare('SELECT last_reviewed_at FROM term_library WHERE id = ?').get(id) as {
        last_reviewed_at: string | null;
      }
    ).last_reviewed_at;

  it('默认关闭：未配过时 GET 回 {count:0,domains:[]}，且队列只放真账（＝ v1.1 行为）', async () => {
    expect(await readGoal()).toEqual({ count: 0, domains: [] });

    const overdue = await addTerm('目标默认-欠账', 'goal-a');
    age(overdue, 5);
    const fresh = await addTerm('目标默认-未到期', 'goal-a');
    const res = await queueFull(undefined, 'goal-a');
    expect(res.goal.count).toBe(0);
    // ★ 未设目标 ⇒ **不补位**：未到期的词条不该被塞进来
    expect(res.items.map((t) => t.id)).toEqual([overdue]);
    expect(res.items.map((t) => t.id)).not.toContain(fresh);
  });

  it('设了目标就补位：真账 + 提前背凑够条数，segment 如实标出它来自哪一段', async () => {
    const overdue = await addTerm('补位-欠账', 'goal-b');
    age(overdue, 5);
    await addTerm('补位-未到期甲', 'goal-b');
    await addTerm('补位-未到期乙', 'goal-b');

    expect((await writeGoal({ count: 3, domains: [] }).expect(200)).body).toEqual({ count: 3, domains: [] });
    const res = await queueFull(undefined, 'goal-b');
    expect(res.items).toHaveLength(3);
    expect(res.items[0]?.segment).toBe('due'); // 真账永远排最前
    expect(res.items.slice(1).every((t) => t.segment === 'extra')).toBe(true);
  });

  it('★ 凑不满目标就如实短，且**不重复同一条词条充数**', async () => {
    await addTerm('稀缺词条', 'goal-c');
    await writeGoal({ count: 30, domains: [] }).expect(200);
    const res = await queueFull(undefined, 'goal-c');
    expect(res.items).toHaveLength(1);
    expect(res.poolSize).toBe(1); // 池子大小如实回报，前端据此说明"只有 N 条可补"
  });

  it('★★ 同日只推进一次：第二次打卡不推进 stage、也不刷新基准日', async () => {
    const id = await addTerm('同日闸门', 'goal-d');
    age(id, 5);

    const first = await mark(id, true).expect(200);
    expect((first.body as ReviewBody).review_stage).toBe(1);

    // ★ 把基准日改成一个**可识别的旧值**，这样"重复打卡有没有刷新它"才测得出来：
    //   若直接比较两次响应的 `last_reviewed_at`，`datetime('now')` 只精确到秒，
    //   同一秒内的两次打卡值相同 ⇒ 断言恒真、等于没测（本仓在 `thinkingMs` 上踩过同款坑）。
    age(id, 7);
    const before = lastReviewedAt(id);

    const second = await mark(id, true).expect(200);
    expect((second.body as ReviewBody).review_stage).toBe(1); // 不推进
    expect(lastReviewedAt(id)).toBe(before); // 基准日原封不动
  });

  it('★ 同日重复但"忘了" → 仍然归零（忘了是硬事实，不因今天已推进过就装作没忘）', async () => {
    const id = await addTerm('同日忘了', 'goal-e');
    age(id, 5);
    await mark(id, true).expect(200);
    const forgot = await mark(id, false).expect(200);
    expect((forgot.body as ReviewBody).review_stage).toBe(0);
    expect((forgot.body as ReviewBody).review.daysSince).toBe(0);
  });

  it('两个计数各司其职：todayCards 含重复、todayDone 去重', async () => {
    const id = await addTerm('计数口径', 'goal-f');
    age(id, 5);
    const before = await overview();
    await mark(id, true).expect(200);
    await mark(id, true).expect(200);
    await mark(id, true).expect(200);
    const after = await overview();
    expect(after.todayCards - before.todayCards).toBe(3); // 刷了 3 张
    expect(after.todayDone - before.todayDone).toBe(1); // 只碰过 1 个词条
  });

  it('★ 目标归零 ⇒ 队列退回"只真账"（向后兼容承诺：不设目标 = 什么都没变）', async () => {
    const overdue = await addTerm('回退-欠账', 'goal-g');
    age(overdue, 5);
    await addTerm('回退-未到期', 'goal-g');

    await writeGoal({ count: 5, domains: [] }).expect(200);
    expect((await queueFull(undefined, 'goal-g')).items).toHaveLength(2); // 补位：真账 + 提前背

    await writeGoal({ count: 0, domains: [] }).expect(200);
    const back = await queueFull(undefined, 'goal-g');
    expect(back.goal.count).toBe(0);
    expect(back.items.map((t) => t.id)).toEqual([overdue]);
  });

  it('写口归一：坏输入归一后落库，且**回写归一结果**（客户端拿到的是服务端实际存的）', async () => {
    const r = await writeGoal({ count: '30', domains: ['cs', 'cs', '  ', 3] }).expect(200);
    // 字符串 '30' 不猜（猜错的方向恰好是"把关闭读成开启"）、去重、丢空串、丢非字符串
    expect(r.body).toEqual({ count: 0, domains: ['cs'] });
    expect(await readGoal()).toEqual({ count: 0, domains: ['cs'] });

    const big = await writeGoal({ count: 9999, domains: 'bad' }).expect(200);
    expect(big.body).toEqual({ count: 200, domains: [] }); // 超上限钳到 200（**不是**队列上限 100）
  });

  it('目标写口吃同一道跨源闸门（无 Origin → 403）', async () => {
    await request(app).put('/api/terms/review/goal').send({ count: 5 }).expect(403);
  });
});
