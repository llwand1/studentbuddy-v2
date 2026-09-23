/**
 * learning/quiz-announce —— 出卡门面的两份产物锁（2026-09-23 出题工具化批新建）。
 *
 * ★ 本文件锁的是「REST 出题」与「聊天工具出题」共用的那一处出口，三条判据都有对应事故形状：
 * ① `blockId` 在帧与 payload 里必须是**同一个串**（原先 `quiz-${quizId ?? Date.now()}` 在同一段
 *    代码里写了两遍，两次 `Date.now()` 可以不同 ⇒ 前端从 blockId 反解出的 quizId 与实际不符，
 *    答完题记到不存在的题组上）；
 * ② 登记行的 content 必须带**顶层 `quizId` 键**（前端 `restoreQuizBlock` 只能从这里拿回 quizId，
 *    缺了就是一张「答了不记账」的死卡）。⇒ 与 `packages/web/src/features/chat/chat-blocks.test.ts`
 *    的 `restoreQuizBlock` 那组是**一把锁的两半**：本文件锁写出形状，那半边锁读回形状，
 *    键名漂了必红一边（跨包 import 不成立，故用同一份字面量 JSON 对接）。
 * ③ 无订阅者（学习者没开这个会话页 / 后台跑）时 `publish` 空转不炸，落库照旧。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-announce-'));
const { quizRowContent, announceQuizToSession } = await import('./quiz-announce.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { snapshot } = await import('../chat/sse-bus.js');
const { emptyQuizImageReport } = await import('@sb/shared');

afterAll(() => {
  closeDb();
});

const QUIZ = {
  title: '词根 spect',
  questions: [
    { type: 'single' as const, question: 'aspect 的本义最接近哪一项？', options: ['外表', '旁观', '观点'], answer: [2] },
    { type: 'fill' as const, question: '_____ 表示「 retrospect 回顾 」的空格应填什么', answer: 'retrospect' },
  ],
};

/** messages.session_id 有外键：真实链路里出卡的会话必存在，测试照同一前提补会话行 */
function newSession(title = '出卡测试'): string {
  const id = `sess-announce-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  getDb().prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(id, title);
  return id;
}

function quizRows(sessionId: string): Array<{ role: string; content: string }> {
  return getDb()
    .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid')
    .all(sessionId) as Array<{ role: string; content: string }>;
}

function blockFrames(sessionId: string) {
  return snapshot(sessionId).filter((e) => e.type === 'block') as Array<
    Extract<ReturnType<typeof snapshot>[number], { type: 'block' }>
  >;
}

describe('quizRowContent（登记行 content = 前端还原的唯一输入）', () => {
  it('带 quizId → 顶层登记键，且 payload 原样在内', () => {
    const raw = quizRowContent(QUIZ, 'q-77');
    expect(raw.startsWith('[QUIZ]')).toBe(true);
    expect(raw.endsWith('[/QUIZ]')).toBe(true);
    // 与 chat-blocks.test.ts 的 `restoreQuizBlock` 对接的字面量形状：顶层 quizId + title + questions
    expect(raw).toContain('"quizId":"q-77"');
    const body = JSON.parse(raw.slice('[QUIZ]'.length, -'[/QUIZ]'.length)) as Record<string, unknown>;
    expect(body.quizId).toBe('q-77');
    expect(body.questions).toHaveLength(2);
    expect(body.title).toBe('词根 spect');
  });

  it('不带 quizId（未落库/落库失败）→ 不写空键，老形状仍然合法', () => {
    const body = JSON.parse(quizRowContent(QUIZ).slice('[QUIZ]'.length, -'[/QUIZ]'.length)) as Record<string, unknown>;
    expect('quizId' in body).toBe(false);
  });
});

describe('announceQuizToSession（block 帧 + 登记行，一次调用两份产物）', () => {
  it('帧与 payload 的 blockId 是同一个串，且等于 `quiz-<quizId>`', () => {
    const sid = newSession();
    announceQuizToSession(sid, QUIZ, 'q-88');
    const frames = blockFrames(sid);
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    expect(f.blockId).toBe('quiz-q-88');
    expect(f.done).toBe(true);
    // 这一条就是双写 Date.now() 的回归锁：payload 内层 blockId 与外层必须一致
    expect((f.payload as { blockId: string }).blockId).toBe(f.blockId);
    expect((f.payload as { kind: string }).kind).toBe('quiz');
    expect((f.payload as { payload: { questions: unknown[] } }).payload.questions).toHaveLength(2);
  });

  it('没给 quizId 时用时间戳兜底：两次 `Date.now()` 必须收成一次（帧与 payload 内层仍是同一个串）', () => {
    const sid = newSession();
    // ★ 换步进假钟：真钟在一次函数调用里跨毫秒的概率极低，双写 `Date.now()` 会**偶然通过**这条锁。
    //   每调一次就走一步 ⇒ 谁把 blockId 现算两遍，两个值必定不等。
    const real = Date.now;
    let tick = real();
    Date.now = () => ++tick;
    try {
      announceQuizToSession(sid, QUIZ);
    } finally {
      Date.now = real;
    }
    const frames = blockFrames(sid);
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    // 这一条才是双写 Date.now() 的真正靶子：没有 quizId 时 blockId 由时钟现算，
    // 写两遍就是两个可能不同的串（跨毫秒即不等），前端反解出的 quizId 与帧上的对不上
    expect(f.blockId).toMatch(/^quiz-\d+$/);
    expect((f.payload as { blockId: string }).blockId).toBe(f.blockId);
  });

  it('登记行：一条 assistant 行，content 可被 JSON 解析回题组（重开会话能还原卡片）', () => {
    const sid = newSession();
    announceQuizToSession(sid, QUIZ, 'q-99');
    const rows = quizRows(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('assistant');
    const body = JSON.parse(rows[0]!.content.slice('[QUIZ]'.length, -'[/QUIZ]'.length)) as {
      quizId?: string;
      questions: unknown[];
    };
    expect(body.quizId).toBe('q-99');
    expect(body.questions).toHaveLength(2);
  });

  it('无订阅者不炸（publish 空转是安全路径：卡照旧落库）', () => {
    // 本文件从头到尾没 subscribe 过 ⇒ 这一条不是特例，是前几条的共同前提；
    // 单列一条是为了让「后台出卡」这条真实形状有个名字
    const sid = newSession('无订阅者');
    expect(() => announceQuizToSession(sid, QUIZ, 'q-100')).not.toThrow();
    expect(quizRows(sid)).toHaveLength(1);
    expect(blockFrames(sid)).toHaveLength(1);
  });

  it('配图闸门与登记行无关：报告侧字段不进 content（题组保持纯契约形状）', () => {
    const report = emptyQuizImageReport(true);
    report.delivered = 1;
    const sid = newSession();
    announceQuizToSession(sid, QUIZ, 'q-101');
    const content = quizRows(sid)[0]!.content;
    expect(content).not.toContain('delivered');
    expect(content).not.toContain('"on":true');
  });
});
