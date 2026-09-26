/**
 * learning/streak — 连签（**周结算**）与「一本账」的锁。契约 `docs/GAMIFIED-AGENT-SPEC.md` §8。
 *
 * ★ 本文件是本仓**第一批**连签测试：改前 `computeStreak` / 已退役的 `reviewStreak` 零覆盖
 *   （2026-09-25 现查：全仓没有一条断言碰过连签数字）。所以这里钉的不是"回归"，
 *   是新口径的第一版地基——三条规则各一锁，外加两把结构锁（聊天不涨、coach 与 activity 同源）。
 *
 * ★ 为什么到处传假钟 `NOW`：周结算判「哪一周」完全取决于今天在周几，
 *   用真时钟 ⇒ **同一份代码周一红、周五绿**。`NOW` 钉在 2026-09-25（**周五**，本周一＝09-21），
 *   于是"本周已过 5 格（周一~周五）"是常量，铺数据与预期都能写死。
 *   （`vitest.config.ts` 已把 `TZ` 钉在 Asia/Shanghai，故 `new Date(y, m, d)` 的本地日键唯一。）
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import { addDays, AUTH_COOKIE_NAME, localDayKey } from '@sb/shared';

const { app, request, getDb, closeDb } = await boot('streak-test');
const origin = TEST_ORIGIN;

const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const { computeStreak, wireActivityEvents } = await import('../learning/activity.js');

// 事件订阅只在"直接跑 index.ts"时自动接线 ⇒ 走真链路（复习打卡 → 活动账）的锁必须自己接一次
wireActivityEvents();

const NOW = new Date(2026, 8, 25); // 2026-09-25 周五
/** `NOW` 所在周的周一 */
const WEEK_MONDAY = (() => {
  const dow = (NOW.getDay() + 6) % 7;
  return addDays(localDayKey(NOW), -dow);
})();

/** 铺一笔活动：`weeksBack` 周前的第 `weekday` 天（0=周一…6=周日） */
function seed(owner: string, weeksBack: number, weekday: number, type: string): void {
  const day = addDays(WEEK_MONDAY, -7 * weeksBack + weekday);
  getDb()
    .prepare(
      `INSERT INTO daily_activity (owner_id, day, type, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(owner_id, day, type) DO UPDATE SET count = count + 1`,
    )
    .run(owner, day, type);
}

/** 每人独立账号：连签与 XP 都是按人算的，共用 owner 会让用例互相污染 */
let userSeq = 0;
async function newUser(): Promise<{ cookie: string; id: string }> {
  const seq = String(userSeq++);
  const user = await createUser(`streak-${seq}@example.com`, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return { cookie: `${AUTH_COOKIE_NAME}=${token}`, id: user.id };
}

const streakOf = (owner: string | null): number => computeStreak(owner, getDb(), NOW);

describe('learning/streak — §8.1 什么算「今天学了」', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM daily_activity').run();
  });

  it('★ 只聊天：本周 5 天全有 chat_done ⇒ 连签仍是 0（老板定案「聊天不打卡」）', async () => {
    const { id } = await newUser();
    for (const weekday of [0, 1, 2, 3, 4]) seed(id, 0, weekday, 'chat_done');
    expect(streakOf(id)).toBe(0);
  });

  it('★ 四种打卡级各自单独成立（逐条过，防"漏配一种"）', async () => {
    for (const type of ['quiz_answered', 'quiz_generated', 'term_added', 'review_completed']) {
      getDb().prepare('DELETE FROM daily_activity').run();
      const { id } = await newUser();
      seed(id, 0, 2, type);
      expect(streakOf(id), type).toBe(1);
    }
  });

  it('无主行（未登录单人模式）自成一本账，不沾登录用户的行', async () => {
    const { id } = await newUser();
    seed(id, 0, 1, 'quiz_answered');
    seed('', 0, 1, 'quiz_answered');
    seed('', 0, 2, 'term_added');
    expect(streakOf(null)).toBe(2);
    expect(streakOf(id)).toBe(1);
  });
});

describe('learning/streak — §8.2 周结算', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM daily_activity').run();
  });

  it('★ 空洞不断签：上周只学周一/三/五/六/日（凑够 5 天但中间有空洞）、本周学周一/二 ⇒ 7', async () => {
    const { id } = await newUser();
    // ★ 用例的"空洞"必须是**达标周内的空洞**：已结束的周 <5 天会直接断链（见下一条），那样测不到宽限。
    for (const weekday of [0, 2, 4, 5, 6]) seed(id, 1, weekday, 'quiz_answered');
    for (const weekday of [0, 1]) seed(id, 0, weekday, 'term_added');
    expect(streakOf(id)).toBe(7);
  });

  it('★ 已结束的周不足 5 天 ⇒ 链断在那一周，只留本周已有的 2 天', async () => {
    const { id } = await newUser();
    for (const weekday of [0, 1, 2, 3]) seed(id, 1, weekday, 'quiz_answered'); // 上周 4 天 < 5 ⇒ 断
    for (const weekday of [0, 1]) seed(id, 0, weekday, 'quiz_answered');
    expect(streakOf(id)).toBe(2);
  });

  it('★ 达标周累加：上周满 5、本周已 2 ⇒ 7（数字＝学习日个数，不是自然日跨度）', async () => {
    const { id } = await newUser();
    for (const weekday of [0, 1, 2, 3, 4]) seed(id, 1, weekday, 'quiz_answered');
    for (const weekday of [0, 1]) seed(id, 0, weekday, 'quiz_answered');
    expect(streakOf(id)).toBe(7);
  });

  it('★ 本周一天没学也不回退：连着两周各自满 7 天 ⇒ 14（"今天还没学不该归零"的周版推广）', async () => {
    const { id } = await newUser();
    for (const weeksBack of [1, 2]) for (let w = 0; w < 7; w++) seed(id, weeksBack, w, 'term_added');
    expect(streakOf(id)).toBe(14);
  });

  it('隔了一整周没学 ⇒ 归零（断链只认"已结束的周未达标"这一种情形）', async () => {
    const { id } = await newUser();
    for (let w = 0; w < 7; w++) seed(id, 2, w, 'term_added'); // 两周前满周
    for (let w = 0; w < 7; w++) seed(id, 3, w, 'term_added'); // 三周前满周
    expect(streakOf(id)).toBe(0);
  });
});

describe('learning/streak — §8.1/§8.3 真链路与一本账', () => {
  /** 建一条词条并勾进复习范围（默认全不选，见 `coach.test.ts` 同处注释） */
  async function addTerm(cookie: string, term: string): Promise<string> {
    const res = await request(app).post('/api/terms').set('Origin', origin).set('Cookie', cookie).send({
      term,
      definition: `${term} 的释义`,
      domain: 'math',
    }).expect(201);
    const id = (res.body as { id: string }).id;
    await request(app).put('/api/terms/review/scope').set('Origin', origin).set('Cookie', cookie)
      .send({ termId: id, enabled: true })
      .expect(200);
    return id;
  }

  const activityToday = async (cookie: string): Promise<{ xp: number; streak: number; activities: Array<{ type: string; count: number }> }> =>
    ((await request(app).get('/api/activity/today').set('Origin', origin).set('Cookie', cookie).expect(200))
      .body as { xp: number; streak: number; activities: Array<{ type: string; count: number }> });

  it('★ 复习打卡真的进活动账：POST /terms/:id/review ⇒ XP +2、连签 +1（改前复习根本不留痕）', async () => {
    const { cookie } = await newUser();
    const termId = await addTerm(cookie, '连签锁-复习项');
    expect((await activityToday(cookie)).streak).toBe(0);
    await request(app).post(`/api/terms/${termId}/review`).set('Origin', origin).set('Cookie', cookie)
      .send({ remembered: true })
      .expect(200);
    const body = await activityToday(cookie);
    expect(body.xp).toBe(2);
    expect(body.streak).toBe(1);
    expect(body.activities).toEqual([{ type: 'review_completed', count: 1 }]);
  });

  it('★ 一本账守门：coach 快照的 streak 与 /api/activity/today 的 streak 是同一个数', async () => {
    const { cookie } = await newUser();
    const termId = await addTerm(cookie, '连签锁-同源项');
    await request(app).post(`/api/terms/${termId}/review`).set('Origin', origin).set('Cookie', cookie)
      .send({ remembered: true })
      .expect(200);
    const activity = await activityToday(cookie);
    const coach = (await request(app).get('/api/coach/state').set('Origin', origin).set('Cookie', cookie).expect(200))
      .body as { snapshot: { streak: number } };
    expect(coach.snapshot.streak).toBe(activity.streak);
    expect(coach.snapshot.streak).toBe(1);
  });

  it('纯聊天：涨 XP 但不涨连签（走真事件总线，同 settings-tenancy 的口径）', async () => {
    const { cookie, id } = await newUser();
    const { publishEvent } = await import('../events/bus.js');
    publishEvent({ type: 'chat_done', sessionId: 's-streak', ownerId: id });
    const body = await activityToday(cookie);
    expect(body.xp).toBe(2);
    expect(body.streak).toBe(0);
  });
});

afterAll(() => {
  closeDb();
});
