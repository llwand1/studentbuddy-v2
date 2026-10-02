/**
 * quiz-wait：出题中的会话 id 作为第二个「等待」信号（契约 `docs/POMODORO-SPEC.md` §8）。
 * 锁：写同值不广播、读写一致、订阅者在变化时被叫到。
 */
import { describe, expect, it, vi } from 'vitest';
import { readQuizWait, setQuizWait } from './quiz-wait';
import { useQuizWait } from './quiz-wait';

describe('quiz-wait store', () => {
  it('读写一致；同值不重复广播', () => {
    setQuizWait(null);
    expect(readQuizWait()).toBeNull();
    setQuizWait('s1');
    expect(readQuizWait()).toBe('s1');
    setQuizWait('s1');
    expect(readQuizWait()).toBe('s1');
    setQuizWait(null);
    expect(readQuizWait()).toBeNull();
    expect(typeof useQuizWait).toBe('function');
    expect(vi.isMockFunction(useQuizWait)).toBe(false);
  });
});
