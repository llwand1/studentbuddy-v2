// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { PkRoomState } from '@sb/shared';
import { usePkEffects } from './usePkEffects';

const me = 'u-me';
const opp = 'u-opp';
function state(questions: PkRoomState['questions'] = [], scores = [2, 3]): PkRoomState {
  return {
    roomId: 'r1', roomCode: '123456', status: 'active', mode: 'pvp',
    players: [
      { userId: me, nickname: '我', score: scores[0] ?? 0, correct: 1, answered: 1, lastQuizAt: 0, topic: '数学', helpLeft: 1, failStreak: 0 },
      { userId: opp, nickname: '对手', score: scores[1] ?? 0, correct: 1, answered: 1, lastQuizAt: 0, topic: '数学', helpLeft: 1, failStreak: 0 },
    ],
    nextQuizAt: {}, endsAt: Date.now() + 60_000, questions, currentTopic: '数学', topicOwnerId: me, topicTurn: 0, retryNextAt: {},
  };
}
function question(over: Partial<PkRoomState['questions'][number]> = {}): PkRoomState['questions'][number] {
  return { id: 'q1', roomId: 'r1', fromUserId: opp, toUserId: me, prompt: 'p', stem: '题', options: ['A', 'B'], createdAt: 1, deadlineAt: 9, status: 'pending', ...over };
}
function Harness({ value }: { value: PkRoomState }) {
  const fx = usePkEffects(value, me);
  return <section><button onClick={fx.toggleSound}>sound:{String(fx.sound)}</button><button onClick={() => fx.answerResult(true)}>correct</button><span>{fx.fx ? `${fx.fx.kind}:${fx.fx.combo ?? ''}` : 'idle'}</span><span>{fx.scoreFx?.userId ?? 'no-score'}</span></section>;
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('usePkEffects', () => {
  it('新题送到本人时出一次到场反馈，音效偏好切换并保存在本机', () => {
    const view = render(<Harness value={state()} />);
    view.rerender(<Harness value={state([question()])} />);
    expect(view.container.textContent).toContain('question:');
    fireEvent.click(view.getByText('sound:true'));
    expect(view.getByText('sound:false')).toBeTruthy();
    expect(localStorage.getItem('sb:pk:sound')).toBe('off');
  });

  it('对手交卷按比分差闪分数；自己连续答对三题触发连击档', () => {
    const pending = question({ toUserId: opp, fromUserId: me });
    const view = render(<Harness value={state([pending])} />);
    view.rerender(<Harness value={state([question({ toUserId: opp, fromUserId: me, status: 'answered', chosen: 1, answerRevealed: 1 })], [2, 5])} />);
    expect(view.container.textContent).toContain(opp);
    fireEvent.click(view.getByText('correct'));
    fireEvent.click(view.getByText('correct'));
    fireEvent.click(view.getByText('correct'));
    expect(view.container.textContent).toContain('combo:3');
  });

  it('首次挂载现有题目只建立快照基线，不误响过期事件', () => {
    const view = render(<Harness value={state([question({ status: 'answered' })])} />);
    expect(view.container.textContent).toContain('idle');
  });
});
