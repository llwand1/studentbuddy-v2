/**
 * chat-blocks —— 聊天流内容块分派与还原（契约 SCENARIO-SPEC §8 M3）。
 * live 分派挪自 useChatStream（quiz 行为逐字同构，回归锁在此）；scenario 是 M3 新链路。
 */
import { describe, expect, it } from 'vitest';
import type { StreamMessage } from './useChatStream';
import { applyChatBlock, openScenarioView, restoreQuizBlock, restoreScenarioBlock } from './chat-blocks';

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

describe('restoreQuizBlock — 历史还原（2026-09-23「出题工具化」批补上）', () => {
  // ★ 下面的 JSON 字面量**刻意手写**、不用 JSON.stringify 造：它必须与另一包里的写出端
  //   `packages/server/src/learning/quiz-announce.ts#quizRowContent` 的产物逐字同形
  //   （顶层 title/questions/answer/quizId）。一把锁的两半：写出端漂了红 `quiz-announce.test.ts`，
  //   读回端漂了红这里——两边都在，才算锁住。
  const QUIZ_TEXT =
    '[QUIZ]{"title":"词根 spect","questions":[{"type":"single","question":"aspect 本义？","options":["外表","旁观","观点"],"answer":[2]}],"quizId":"q-77"}[/QUIZ]';

  it('登记文本 → 题卡视图（quizId 从顶层登记键读回，blockId 据此重建）', () => {
    const v = restoreQuizBlock(QUIZ_TEXT);
    expect(v).not.toBeNull();
    expect(v?.quizId).toBe('q-77');
    expect(v?.blockId).toBe('quiz-q-77');
    expect(v?.quiz.title).toBe('词根 spect');
    expect(v?.quiz.questions).toHaveLength(1);
  });

  it('前后有别的文字也能取出（登记行历史上就是「一句话 + [QUIZ]」的混排形状）', () => {
    expect(restoreQuizBlock(`前面的话\n${QUIZ_TEXT}\n后面的话`)?.quizId).toBe('q-77');
  });

  it('老行没有 quizId ⇒ 仍还原成卡，只是不记账（blockId 用 legacy 占位，不抛不吞）', () => {
    const legacy = QUIZ_TEXT.replace(/,"quizId":"q-77"/, '');
    const v = restoreQuizBlock(legacy);
    expect(v).not.toBeNull();
    expect(v?.quizId).toBeUndefined();
    expect(v?.blockId).toBe('quiz-legacy');
    expect(v?.quiz.questions).toHaveLength(1);
  });

  it('空题组 / 非 JSON / 缺标记 ⇒ null（该行回落普通文本，一行脏数据不毁掉整段历史）', () => {
    expect(restoreQuizBlock('[QUIZ]{"title":"T","questions":[]}[/QUIZ]')).toBeNull();
    expect(restoreQuizBlock('[QUIZ]不是json[/QUIZ]')).toBeNull();
    expect(restoreQuizBlock('完全无关文本')).toBeNull();
    // questions 不是数组（弱模型给成对象）也不能炸
    expect(restoreQuizBlock('[QUIZ]{"questions":{"0":"x"}}[/QUIZ]')).toBeNull();
  });
});
