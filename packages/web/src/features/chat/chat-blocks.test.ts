/**
 * chat-blocks —— 聊天流内容块分派与还原（契约 SCENARIO-SPEC §8 M3）。
 * live 分派挪自 useChatStream（quiz 行为逐字同构，回归锁在此）；scenario 是 M3 新链路。
 */
import { describe, expect, it } from 'vitest';
import type { StreamMessage } from './useChatStream';
import { applyChatBlock, openScenarioView, restoreScenarioBlock } from './chat-blocks';

const DEMO_ID = 'demo-uuid-1';
const PAYLOAD = {
  title: '断电检修',
  tasks: [{ id: 't1', prompt: '先断总闸', criteria: { kind: 'state', value: 'off' } }],
};

describe('applyChatBlock — live 分派', () => {
  it('scenario 块 → 场景卡片消息（demoId 从 blockId 抽取）', () => {
    let out: StreamMessage[] = [];
    applyChatBlock<StreamMessage>(
      (u) => {
        out = u(out);
      },
      `scenario-${DEMO_ID}`,
      { kind: 'scenario', payload: PAYLOAD },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('assistant');
    expect(out[0]?.content).toBe('');
    expect(out[0]?.scenarioBlock?.demoId).toBe(DEMO_ID);
    expect(out[0]?.scenarioBlock?.payload.tasks).toHaveLength(1);
  });

  it('quiz 块行为不变（挪动的回归锁）：quizId 从 blockId 抽取', () => {
    let out: StreamMessage[] = [];
    applyChatBlock<StreamMessage>(
      (u) => {
        out = u(out);
      },
      'quiz-q-123',
      { kind: 'quiz', payload: { title: 'T', questions: [] } },
    );
    expect(out[0]?.quizBlock?.quizId).toBe('q-123');
    expect(out[0]?.quizBlock?.quiz.title).toBe('T');
  });

  it('认不出的 kind / 坏 payload 静默忽略（不炸消息流）', () => {
    let out: StreamMessage[] = [];
    const push = (payload: unknown, blockId = 'scenario-x') => {
      applyChatBlock<StreamMessage>(
        (u) => {
          out = u(out);
        },
        blockId,
        payload,
      );
    };
    push({ kind: 'unknown-kind', payload: PAYLOAD });
    push(undefined);
    push({ kind: 'scenario', payload: { title: '没有评分点', tasks: [] } });
    push({ kind: 'scenario', payload: PAYLOAD }, '没有前缀的id');
    expect(out).toHaveLength(0);
  });
});

describe('openScenarioView — 形状闸门', () => {
  it('缺 id / criteria.kind 的评分点 ⇒ null（残骸不开成可玩卡）', () => {
    expect(openScenarioView(`scenario-${DEMO_ID}`, { title: 'T', tasks: [{ prompt: '没id' }] })).toBeNull();
    expect(
      openScenarioView(`scenario-${DEMO_ID}`, {
        title: 'T',
        tasks: [{ id: 't1', prompt: 'p', criteria: {} }],
      }),
    ).toBeNull();
  });
});

describe('restoreScenarioBlock — 历史还原', () => {
  const HISTORY_TEXT = `[SCENARIO]${JSON.stringify({ ...PAYLOAD, quizId: 'quiz-uuid-9', demoId: DEMO_ID })}[/SCENARIO]`;

  it('登记文本 → 卡片视图（quizId/demoId 从登记键读，blockId 重建）', () => {
    const v = restoreScenarioBlock(`前面的话\n${HISTORY_TEXT}\n后面的话`);
    expect(v).not.toBeNull();
    expect(v?.demoId).toBe(DEMO_ID);
    expect(v?.quizId).toBe('quiz-uuid-9');
    expect(v?.blockId).toBe(`scenario-${DEMO_ID}`);
    expect(v?.payload.title).toBe('断电检修');
  });

  it('缺 demoId / 非 JSON / 无标记 ⇒ null（回落普通文本展示）', () => {
    expect(restoreScenarioBlock('[SCENARIO]{"title":"T","tasks":[{"id":"t1","prompt":"p","criteria":{"kind":"state","value":"x"}}]}[/SCENARIO]')).toBeNull();
    expect(restoreScenarioBlock('[SCENARIO]不是json[/SCENARIO]')).toBeNull();
    expect(restoreScenarioBlock('完全无关文本')).toBeNull();
  });
});
