/**
 * 方案选择框服务端测试（契约 docs/ASK-CHOICE-SPEC.md）。
 *
 * 覆盖四类不可回归的行为：
 * ① 挂起语义 —— ask 返回的是「等答复」的 Promise，answer 才唤醒它；
 * ② 条件更新 —— 并发双端点击的第二只手必须被 409 拒掉，不覆盖首答；
 * ③ 逃生口 —— 停止生成 / 删会话 / 进程重启三条路都能解除挂起（不解除 = 工具永久悬挂）；
 * ④ 校验边界 —— 不合法入参返回可回灌的错误文本，而不是异常或半截落库。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, openIsolated } from '../storage/db.js';
import { snapshot } from './sse-bus.js';
import {
  answerChoice,
  askChoice,
  cancelChoice,
  cancelChoicesBySession,
  choiceToolHint,
  listPendingChoices,
  sweepStaleChoices,
} from './choice.js';

let tmpDir = '';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-choice-'));
  openIsolated(tmpDir);
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 发起一次提问并立刻拿到它的 id（askChoice 在首个 await 之前已同步落库） */
function askAndGetId(sessionId: string, question = '这次怎么复习？'): string {
  void askChoice({
    sessionId,
    question,
    options: [{ label: '先补基础' }, { label: '直接刷题' }],
  });
  const list = listPendingChoices(sessionId);
  expect(list).toHaveLength(1);
  return list[0]!.id;
}

describe('挂起与唤醒（核心语义）', () => {
  it('ask 落库 + 广播 choice-asked + 挂起不返回', async () => {
    const sessionId = 's-ask-1';
    const pending = askChoice({
      sessionId,
      question: '按概念还是按题型整理？',
      options: [{ label: '按概念' }, { label: '按题型' }],
    });

    // 尚未有人答复：列表里有它，且事件已广播（工具侧此刻正挂在 waiter 上）
    const list = listPendingChoices(sessionId);
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('pending');
    expect(list[0]?.options.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(snapshot(sessionId).some((e) => e.type === 'choice-asked')).toBe(true);

    // 答复 → 挂起的 Promise 被唤醒，拿到 answered 记录
    const answered = answerChoice(list[0]!.id, { optionId: 'o1' });
    expect(answered.ok).toBe(true);

    const settled = await pending;
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.record.status).toBe('answered');
    expect(settled.record.reply?.optionId).toBe('o1');
    expect(settled.record.reply?.ts).toBeGreaterThan(0);
    // 答复后不再是挂起项
    expect(listPendingChoices(sessionId)).toHaveLength(0);
    expect(snapshot(sessionId).some((e) => e.type === 'choice-replied')).toBe(true);
  });

  it('自由输入答复：optionId 归 null、custom 原样保留', async () => {
    const sessionId = 's-ask-2';
    const id = askAndGetId(sessionId);
    const pending = Promise.resolve(); // 占位，避免 lint 抱怨未使用
    void pending;

    const r = answerChoice(id, { custom: '先看错题本' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.reply?.optionId).toBeNull();
    expect(r.record.reply?.custom).toBe('先看错题本');
  });
});

describe('条件更新（并发双端点击）', () => {
  it('第二次答复被 409 拒掉，不覆盖首答', async () => {
    const sessionId = 's-ask-3';
    const id = askAndGetId(sessionId);

    const first = answerChoice(id, { optionId: 'o1' });
    expect(first.ok).toBe(true);
    const second = answerChoice(id, { optionId: 'o2' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);

    // 库里留的是首答
    expect(listPendingChoices(sessionId)).toHaveLength(0);
  });

  it('已作废的提问再答复同样 409（不留复活口子）', async () => {
    const sessionId = 's-ask-4';
    const id = askAndGetId(sessionId);
    expect(cancelChoice(id, '用户已停止生成')).not.toBeNull();

    const r = answerChoice(id, { optionId: 'o1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
  });

  it('答复不存在的提问 → 404', () => {
    const r = answerChoice('ghost-id', { optionId: 'o1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
  });
});

describe('校验边界（错误必须可回灌，不抛异常）', () => {
  it('选项不足 2 个 → ok:false 且一条都不落库', async () => {
    const sessionId = 's-bad-1';
    const r = await askChoice({ sessionId, question: '只有一个选项', options: [{ label: '唯一' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('至少');
    expect(listPendingChoices(sessionId)).toHaveLength(0);
  });

  it('question 为空 → ok:false；模型给了非数组 options → 同样 ok:false（不炸）', async () => {
    const sessionId = 's-bad-2';
    expect((await askChoice({ sessionId, question: '', options: [{ label: 'A' }, { label: 'B' }] })).ok).toBe(false);
    expect((await askChoice({ sessionId, question: '选', options: 'A,B' })).ok).toBe(false);
    expect(listPendingChoices(sessionId)).toHaveLength(0);
  });

  it('答复选项不属于本条提问 → 400，且提问仍是 pending（可继续点）', () => {
    const sessionId = 's-bad-3';
    const id = askAndGetId(sessionId);
    const r = answerChoice(id, { optionId: 'o9' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(listPendingChoices(sessionId)).toHaveLength(1); // 没被误终结
  });
});

describe('逃生口（不解除挂起 = 工具永久悬挂）', () => {
  it('① 作废单条：挂起的 ask 被唤醒为 cancelled，而不是一直等', async () => {
    const sessionId = 's-esc-1';
    const pending = askChoice({ sessionId, question: '选一个', options: [{ label: 'A' }, { label: 'B' }] });
    const id = listPendingChoices(sessionId)[0]!.id;

    expect(cancelChoice(id, '用户已停止生成')).not.toBeNull();
    const settled = await pending;
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.record.status).toBe('cancelled');
    expect(settled.record.cancelReason).toBe('用户已停止生成');
    expect(snapshot(sessionId).some((e) => e.type === 'choice-cancelled')).toBe(true);
  });

  it('作废是幂等的：已终结的再作废返回 null，不炸', () => {
    const sessionId = 's-esc-2';
    const id = askAndGetId(sessionId);
    expect(cancelChoice(id, '第一次')).not.toBeNull();
    expect(cancelChoice(id, '第二次')).toBeNull();
  });

  it('② 按会话批量作废（删会话 / 中止本轮），返回条数且只影响本会话', async () => {
    const a = 's-esc-3a';
    const b = 's-esc-3b';
    const pa = askChoice({ sessionId: a, question: 'A 选', options: [{ label: 'A1' }, { label: 'A2' }] });
    const pb = askChoice({ sessionId: b, question: 'B 选', options: [{ label: 'B1' }, { label: 'B2' }] });

    expect(cancelChoicesBySession(a, '会话已删除')).toBe(1);
    const settledA = await pa;
    expect(settledA.ok && settledA.record.status === 'cancelled').toBe(true);
    // b 不受牵连
    expect(listPendingChoices(b)).toHaveLength(1);
    expect(cancelChoicesBySession(b, '会话已删除')).toBe(1);
    await pb;
  });

  it('③ 进程重启清理：库里挂起项统一作废（清完不再出现在 pending 列表）', async () => {
    const sessionId = 's-esc-4';
    const p1 = askChoice({ sessionId, question: '问题一', options: [{ label: 'A' }, { label: 'B' }] });
    const p2 = askChoice({ sessionId, question: '问题二', options: [{ label: 'A' }, { label: 'B' }] });
    expect(listPendingChoices(sessionId)).toHaveLength(2);

    // 全库语义，不假设库里只有自己这几条（≥2 而不是 ===2，免于用例顺序耦合）
    expect(sweepStaleChoices()).toBeGreaterThanOrEqual(2);
    expect(listPendingChoices(sessionId)).toHaveLength(0);

    // 同一进程内被调用时也必须唤醒挂起的工具，否则本测试自己就会永久悬挂
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok && r1.record.status === 'cancelled').toBe(true);
    expect(r2.ok && r2.record.status === 'cancelled').toBe(true);
  });
});

describe('listPendingChoices 与回灌文案', () => {
  it('只返回 pending；不同会话互不串台', () => {
    const a = 's-list-a';
    const b = 's-list-b';
    askAndGetId(a, 'A 的问题');
    expect(listPendingChoices(a)).toHaveLength(1);
    expect(listPendingChoices(b)).toHaveLength(0);
    cancelChoicesBySession(a, '收尾');
  });

  it('回灌文案：已答复提示「按这个选择继续」；已作废提示「不要再调用」', async () => {
    const s1 = 's-hint-1';
    const id1 = askAndGetId(s1);
    const r1 = answerChoice(id1, { optionId: 'o1' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(choiceToolHint(r1.record)).toContain('用户选择：先补基础');
    expect(choiceToolHint(r1.record)).toContain('继续');

    const s2 = 's-hint-2';
    const id2 = askAndGetId(s2);
    const rec = cancelChoice(id2, '用户已停止生成');
    expect(rec).not.toBeNull();
    const hint = choiceToolHint(rec!);
    expect(hint).toContain('已作废');
    expect(hint).toContain('不要再次调用 ask_choice');
  });
});
