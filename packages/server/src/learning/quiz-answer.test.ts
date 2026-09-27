/**
 * learning/quiz-answer —— 答题留痕的域层用例（issue #56，2026-09-27）。
 *
 * ★ 本文件最该锁的**不是**"答对写一行"，而是四件写错也不会立刻看出来的事：
 *  ① **发布点存在**（`quiz_answered`）。这个事件类型自 `fc55b7e`（2026-08-23 M4 反馈环）起
 *    就只有声明与消费、没有任何发布者（`git log -S` 只命中引入那一条）⇒
 *    XP=3 与「答题算学习日」这两条一直在等一个发布者。
 *    所以本文件末尾那两条不是装饰：**把 `quiz-answer.ts` 里的 `publishEvent` 删掉必定变红**，
 *    而红的位置在 XP 与连签上，不在流水行数上——这正是 issue #56 描述的那种"只红在下游"的错。
 *  ② **不判不落流水**（essay／缺答案钥匙／畸形作答）。落进去就是假负样本，
 *     而假负样本在统计上长得跟"这人真不会"一模一样，事后无从分离。
 *  ③ **首答唯一**：重答不新增流水、**也不再发一次事件**（第二次发就是刷新刷 XP）。
 *  ④ **别人的题卡记不进去，且不区分"不存在"与"不是你的"**：
 *     能区分就成了一支猜 UUID 探别人的答题记录的探针。
 *
 * ★ 手法：真库（`SB_DATA_DIR` 指临时目录）+ `subscribeEvents` 收事件，不 mock 总线——
 *   这条链的故障形状是"订阅者收不到"，mock 掉总线就等于把要测的那一段测没了。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuizQuestion } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-answer-'));
const { announceQuizToSession } = await import('./quiz-announce.js');
const { reportQuizAnswer } = await import('./quiz-answer.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { subscribeEvents } = await import('../events/bus.js');
const { snapshot } = await import('../chat/sse-bus.js');
const { wireActivityEvents } = await import('./activity.js');
const { createUser } = await import('../auth/users.js');

afterAll(() => {
  closeDb();
});

/** 收进来的事件（按序）。每条用例开头清空，断言"发了几笔"才是硬的 */
const seen: Array<{ type: string; correct?: boolean; quizId?: string }> = [];
let unsubscribe: () => void = () => {};

function newSession(userId: string | null = null): string {
  const id = `sess-answer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  getDb().prepare('INSERT INTO sessions (id, title, user_id) VALUES (?, ?, ?)').run(id, '答题留痕', userId);
  return id;
}

/** 出一张卡进会话，返回前端会拿到的那个 quizId（= blockId 去掉 `quiz-` 前缀） */
function announce(questions: QuizQuestion[], sessionId: string, quizId?: string): string {
  announceQuizToSession(sessionId, { title: '留痕测试', questions }, quizId);
  return quizId ?? String(Date.now());
}

function logs(): Array<{ quiz_id: string; question_index: number; qtype: string; correct: number; answered_day: string }> {
  return getDb()
    .prepare('SELECT quiz_id, question_index, qtype, correct, answered_day FROM quiz_answer_log ORDER BY rowid')
    .all() as ReturnType<typeof logs>;
}

const SINGLE: QuizQuestion[] = [{ type: 'single', question: '1+1=?', options: ['1', '2', '3'], answer: [1] }];
const MIXED: QuizQuestion[] = [
  { type: 'single', question: '1+1=?', options: ['1', '2', '3'], answer: [1] },
  { type: 'judge', question: '2 是偶数', options: ['正确', '错误'], answer: [0] },
  { type: 'fill', question: '水化学式____', answer: ['H2O'] },
  { type: 'essay', question: '说明为什么', answer: '要点', solution: '完整解答' },
];

beforeAll(() => {
  unsubscribe = subscribeEvents((ev) => {
    if (ev.type === 'quiz_answered') seen.push({ type: ev.type, correct: ev.correct, quizId: ev.quizId });
  });
  // ★ 活动账的订阅者（XP/连签）本来由 `index.ts` 启动时接上；域层测试要自己接，
  //   否则下面「XP 真的涨了」那两条测的是空气
  wireActivityEvents();
});
afterAll(() => {
  unsubscribe();
});
beforeEach(() => {
  seen.length = 0;
  getDb().prepare('DELETE FROM quiz_answer_log').run();
  getDb().prepare('DELETE FROM quiz_block').run();
  getDb().prepare("DELETE FROM user_stats WHERE key = 'xp'").run();
  getDb().prepare('DELETE FROM daily_activity').run();
});

describe('出卡即登记答案钥匙（服务端复判的前提）', () => {
  it('announce 一行 quiz_block，`quiz_id` 就是前端从 blockId 反解出来的那一个', () => {
    const sid = newSession();
    announceQuizToSession(sid, { title: 'T', questions: SINGLE }, 'qa-1');
    const row = getDb().prepare('SELECT session_id, questions FROM quiz_block WHERE quiz_id = ?').get('qa-1') as
      | { session_id: string; questions: string }
      | undefined;
    expect(row?.session_id).toBe(sid);
    // 钥匙必须在：没有它，`/report` 只能回 404，整条链退化成"答了不记账"
    expect(JSON.parse(row?.questions ?? '[]')[0].answer).toEqual([1]);
  });

  it('没显式给 quizId 时（聊天工具/老调用点），登记用的 id 与 blockId 里那个是同一个串', () => {
    const sid = newSession();
    // 步进假钟：blockId 与登记行若各算一次 `Date.now()`，这里就会登记到一个查不到的 id 上
    const real = Date.now;
    let tick = real();
    Date.now = () => ++tick;
    try {
      announceQuizToSession(sid, { title: 'T', questions: SINGLE });
    } finally {
      Date.now = real;
    }
    const stored = getDb().prepare('SELECT quiz_id FROM quiz_block WHERE session_id = ?').all(sid) as Array<{ quiz_id: string }>;
    expect(stored).toHaveLength(1);
    // ★ 前端拿到的只有帧上的 `blockId`（live 路径不读登记行）⇒ 用它反解出来的串必须命中登记行，
    //   否则这张卡在界面上答得了、服务端永远查不到钥匙（= 静默不留痕）。
    const frame = snapshot(sid).filter((e) => e.type === 'block').at(-1) as { blockId: string };
    const clientSideId = frame.blockId.replace(/^quiz-/, '');
    expect(clientSideId).toBe(stored[0]!.quiz_id);
    expect(reportQuizAnswer(clientSideId, 0, { picked: [1] }, null)).toMatchObject({ ok: true, correct: true });
  });

  it('三份产物同一个 id：帧的 blockId、登记行的 `quizId` 键、`quiz_block` 主键', () => {
    // ★ 刷新前后必须是同一张卡：还原路径只读登记行的顶层 `quizId` 键（`chat-blocks.ts::restoreQuizBlock`），
    //   原先未显式给 id 时那一行**没有这个键** ⇒ 刷新一次，卡就从"能记账"变成"不记账"。
    //   用步进假钟跑（同上一条的理由：真钟在一次调用里跨毫秒的概率极低，会偶然通过）。
    const sid = newSession();
    const real = Date.now;
    let tick = real();
    Date.now = () => ++tick;
    try {
      announceQuizToSession(sid, { title: 'T', questions: SINGLE });
    } finally {
      Date.now = real;
    }
    const frame = snapshot(sid).filter((e) => e.type === 'block').at(-1) as { blockId: string };
    const row = getDb()
      .prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(sid) as { content: string };
    const body = JSON.parse(row.content.slice('[QUIZ]'.length, -'[/QUIZ]'.length)) as { quizId?: string };
    const stored = getDb().prepare('SELECT quiz_id FROM quiz_block WHERE session_id = ?').get(sid) as { quiz_id: string };
    expect(body.quizId).toBe(frame.blockId.replace(/^quiz-/, ''));
    expect(body.quizId).toBe(stored.quiz_id);
  });
});

describe('复判落流水', () => {
  it('答对：一行流水、correct=1、按本地日历日记日', () => {
    const sid = newSession();
    const qid = announce(SINGLE, sid, 'qa-ok');
    const r = reportQuizAnswer(qid, 0, { picked: [1] }, null);
    expect(r).toEqual({ ok: true, correct: true, recorded: true });
    const rows = logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quiz_id: qid, question_index: 0, qtype: 'single', correct: 1 });
    expect(rows[0]!.answered_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('答错照样留痕（correct=0）——留痕不是为了记录成功，是为了有分母', () => {
    const sid = newSession();
    const qid = announce(SINGLE, sid, 'qa-bad');
    expect(reportQuizAnswer(qid, 0, { picked: [0] }, null)).toEqual({ ok: true, correct: false, recorded: true });
    expect(logs()[0]!.correct).toBe(0);
  });

  it('judge / fill 与 single 同路：三种题型各留一行', () => {
    const sid = newSession();
    const qid = announce(MIXED, sid, 'qa-types');
    expect(reportQuizAnswer(qid, 1, { picked: [0] }, null)).toMatchObject({ correct: true });
    expect(reportQuizAnswer(qid, 2, { text: 'H2O 是水' }, null)).toMatchObject({ correct: true });
    expect(logs().map((x) => x.qtype)).toEqual(['judge', 'fill']);
  });
});

describe('不判的三种成因 ⇒ 零流水零事件', () => {
  it('essay 免检（`collect.ts` 既有口径）', () => {
    const sid = newSession();
    const qid = announce(MIXED, sid, 'qa-essay');
    expect(reportQuizAnswer(qid, 3, { text: '我写了一整段' }, null)).toEqual({ ok: true, correct: null, recorded: false });
    expect(logs()).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it('题面缺答案钥匙', () => {
    const sid = newSession();
    const qid = announce([{ type: 'single', question: '没有答案的题', options: ['a', 'b'] }], sid, 'qa-nokey');
    expect(reportQuizAnswer(qid, 0, { picked: [0] }, null)).toEqual({ ok: true, correct: null, recorded: false });
    expect(logs()).toHaveLength(0);
  });

  it('作答形状不合（选项题给了空 picked）', () => {
    const sid = newSession();
    const qid = announce(SINGLE, sid, 'qa-empty');
    expect(reportQuizAnswer(qid, 0, { picked: [] }, null)).toMatchObject({ correct: null });
    expect(logs()).toHaveLength(0);
  });
});

describe('首答唯一：重答不改流水也不重发事件', () => {
  it('第二次答同一题 ⇒ recorded:false、流水仍 1 行、事件仍 1 笔', () => {
    const sid = newSession();
    const qid = announce(SINGLE, sid, 'qa-twice');
    expect(reportQuizAnswer(qid, 0, { picked: [1] }, null)).toMatchObject({ recorded: true });
    const second = reportQuizAnswer(qid, 0, { picked: [0] }, null);
    // ★ `ok:true` 而 `recorded:false`：刷新重答是正常操作，不能报失败（前端文案会误导）
    expect(second).toEqual({ ok: true, correct: false, recorded: false });
    expect(logs()).toHaveLength(1);
    expect(logs()[0]!.correct).toBe(1); // 首答不被改写成后一次的错
    expect(seen).toHaveLength(1);
  });

  it('同一题组的两道不同题各记一行（唯一键是「题」不是「组」）', () => {
    const sid = newSession();
    const qid = announce(MIXED, sid, 'qa-two');
    reportQuizAnswer(qid, 0, { picked: [1] }, null);
    reportQuizAnswer(qid, 1, { picked: [0] }, null);
    expect(logs().map((x) => x.question_index)).toEqual([0, 1]);
    expect(seen).toHaveLength(2);
  });
});

describe('归属', () => {
  it('别人的题卡 ⇒ not-found，且与"根本不存在"回同一个 reason', () => {
    const owner = newSession();
    const qid = announce(SINGLE, owner, 'qa-other');
    const mine = 'user-me';
    const theirs = reportQuizAnswer(qid, 0, { picked: [1] }, mine);
    const nonexistent = reportQuizAnswer('no-such-quiz', 0, { picked: [1] }, mine);
    expect(theirs).toEqual({ ok: false, reason: 'not-found' });
    expect(nonexistent).toEqual(theirs); // ★ 分不开 = 不是探针
    expect(logs()).toHaveLength(0);
  });

  it('登录用户答自己会话里的卡 ⇒ 记上，且 XP 进的是**这个人**的账而不是无主行', async () => {
    const u = await createUser('qa-owner@example.com', 'good-password-1', undefined);
    const sid = newSession(u.id);
    const qid = announce(SINGLE, sid, 'qa-logged');
    expect(reportQuizAnswer(qid, 0, { picked: [1] }, u.id)).toMatchObject({ recorded: true });
    expect(seen).toHaveLength(1);
    // ★ 两条都要查：owner_id 落错行（记进无主行）的表现是"用户今天明明答了题，XP 却没涨"，
    //   而事件条数与流水行数**都照常绿**——本仓为这类"静默进无主行"写过专规，见 activity.ts 头注。
    expect(xpOf(u.id)).toBe(3);
    expect(xpOf('')).toBe(0);
  });

  it('未登录（单人本地模式，会话无主）⇒ 照样留痕，ownerId 传 null', () => {
    const sid = newSession(null);
    const qid = announce(SINGLE, sid, 'qa-anon');
    expect(reportQuizAnswer(qid, 0, { picked: [1] }, null)).toMatchObject({ recorded: true });
  });

  it('index 越界 ⇒ bad-index（与"卡不存在"是两回事，前端要能分开说）', () => {
    const sid = newSession();
    const qid = announce(SINGLE, sid, 'qa-oob');
    expect(reportQuizAnswer(qid, 9, { picked: [1] }, null)).toEqual({ ok: false, reason: 'bad-index' });
    expect(logs()).toHaveLength(0);
  });
});

describe('★ 回归锁：`quiz_answered` 的第一个发布者（删掉 publishEvent 这两条必红）', () => {
  /**
   * issue #56 的原始症状是「事件类型有声明、有消费者（XP=3）、零发布者」，
   * 且 `quiz_answered` 还在 `activity.ts:32` 的 `STREAK_TYPES` 里 ⇒
   * 没有发布者时「答完一套题但没聊过天」这一天**不算学习日**，连签撑不住。
   * 所以这里断言的是下游那两本账，不是流水行数——流水写上了而事件没发，本批照样算没做完。
   */
  it('一次真判分 ⇒ XP +3（答对）、答题那一档计数 +1', () => {
    const sid = newSession();
    const qid = announce(SINGLE, sid, 'qa-xp');
    const before = xpOf('');
    reportQuizAnswer(qid, 0, { picked: [1] }, null);
    expect(xpOf('')).toBe(before + 3);
    const day = getDb()
      .prepare("SELECT count AS c FROM daily_activity WHERE owner_id = '' AND type = 'quiz_answered'")
      .get() as { c: number } | undefined;
    expect(day?.c).toBe(1);
  });

  it('答错也涨 XP（这一档数的是「答过」，不是「答对」）；重答不涨第二次', () => {
    const sid = newSession();
    const qid = announce(SINGLE, sid, 'qa-xp2');
    const before = xpOf('');
    reportQuizAnswer(qid, 0, { picked: [0] }, null);
    expect(xpOf('')).toBe(before + 3);
    reportQuizAnswer(qid, 0, { picked: [0] }, null);
    expect(xpOf('')).toBe(before + 3); // ★ 第二行：去掉 `recorded` 闸门就红
  });

  it('不判的作答不涨 XP（essay 免检不能变成免费的分）', () => {
    const sid = newSession();
    const qid = announce(MIXED, sid, 'qa-xp3');
    const before = xpOf('');
    reportQuizAnswer(qid, 3, { text: '写了一段' }, null);
    expect(xpOf('')).toBe(before);
  });
});

function xpOf(owner: string): number {
  const row = getDb().prepare("SELECT value FROM user_stats WHERE owner_id = ? AND key = 'xp'").get(owner) as
    | { value: string }
    | undefined;
  return Number(row?.value ?? 0);
}
