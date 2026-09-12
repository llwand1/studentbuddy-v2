/**
 * pk-view.test — PK 页面纯逻辑回归锁。
 *
 * 钉的是契约口径：房号 6 位数字、时钟钳 0 不出负数、房主恒为 players[0]。
 * 时钟格式化是「客户端时间只作展示」的最后一道屏——格式错了对局页全员看错。
 */
import { describe, it, expect } from 'vitest';
import { PK_ROOM_CODE_LEN, type PkQuestion, type PkRoomState } from '@sb/shared';
import {
  cdRemainingMs,
  formatClock,
  isOwner,
  myIndex,
  myPendingQuestion,
  optionLetter,
  pendingToOpponent,
  remainingMs,
  verdictText,
  normalizeRoomCode,
} from './pk-view';

function state(players: Array<{ userId: string; nickname: string }>): PkRoomState {
  return {
    roomId: 'r-1',
    roomCode: '123456',
    status: 'waiting',
    mode: 'pvp',
    players: players.map((p) => ({ ...p, score: 0, correct: 0, answered: 0, lastQuizAt: 0 })),
    nextQuizAt: {},
    endsAt: 0,
    questions: [],
  };
}

describe('normalizeRoomCode（房号输入归一）', () => {
  it('只留数字：字母/符号/空格一律剔除', () => {
    expect(normalizeRoomCode('12a3-4 5')).toBe('12345');
  });

  it('截到 6 位（PK_ROOM_CODE_LEN），多输不进请求', () => {
    expect(normalizeRoomCode('1234567890')).toBe('123456');
    expect(normalizeRoomCode('123456').length).toBe(PK_ROOM_CODE_LEN);
  });

  it('纯非数字输入归一为空串（空串由调用方按「未填」处理）', () => {
    expect(normalizeRoomCode('abc')).toBe('');
    expect(normalizeRoomCode('')).toBe('');
  });
});

describe('remainingMs / formatClock（对局时钟，客户端只作展示）', () => {
  it('未到点返回剩余毫秒', () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
  });

  it('到点与已过点钳 0，绝不出现负数倒计时', () => {
    expect(remainingMs(10_000, 10_000)).toBe(0);
    expect(remainingMs(10_000, 99_999)).toBe(0);
  });

  it('formatClock：m:ss 补零（7:35 / 0:00 / 8:00）', () => {
    expect(formatClock(455_000)).toBe('7:35');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(480_000)).toBe('8:00');
  });

  it('formatClock：负数入参与毫秒尾数都安全（钳 0 + 向下取整）', () => {
    expect(formatClock(-1)).toBe('0:00');
    expect(formatClock(59_999)).toBe('0:59');
    expect(formatClock(60_000)).toBe('1:00');
  });
});

describe('myIndex / isOwner（房主恒为 players[0]）', () => {
  const two = state([
    { userId: 'u-owner', nickname: '房主' },
    { userId: 'u-guest', nickname: '客人' },
  ]);

  it('按 userId 定位下标；不在房内返回 -1', () => {
    expect(myIndex(two, 'u-guest')).toBe(1);
    expect(myIndex(two, 'u-none')).toBe(-1);
  });

  it('players[0] 是房主，其余不是', () => {
    expect(isOwner(two, 'u-owner')).toBe(true);
    expect(isOwner(two, 'u-guest')).toBe(false);
  });

  it('单人 waiting 房：房主可见、isOwner 仍成立', () => {
    const one = state([{ userId: 'u-owner', nickname: '房主' }]);
    expect(isOwner(one, 'u-owner')).toBe(true);
    expect(myIndex(one, 'u-owner')).toBe(0);
  });
});

describe('P0-2/PVE 动作区辅助（CD / 待答 / 选项字母 / 判定文案）', () => {
  function withQuestion(qs: PkQuestion[]): PkRoomState {
    const s = state([
      { userId: 'u-me', nickname: '我' },
      { userId: 'ai-r-1', nickname: 'AI 对手' },
    ]);
    s.questions = qs;
    return s;
  }

  function q(over: Partial<PkQuestion>): PkQuestion {
    return {
      id: 'pq-1',
      roomId: 'r-1',
      fromUserId: 'ai-r-1',
      toUserId: 'u-me',
      prompt: '主题：科学',
      stem: '题干',
      options: ['A', 'B', 'C', 'D'],
      createdAt: 0,
      deadlineAt: 45_000,
      status: 'pending',
      ...over,
    };
  }

  it('cdRemainingMs：未登记 = 已解锁（0），登记过 = 剩余，到点钳 0', () => {
    const s = state([{ userId: 'u-me', nickname: '我' }]);
    s.nextQuizAt['u-me'] = 10_000;
    expect(cdRemainingMs(s, 'u-me', 4_000)).toBe(6_000);
    expect(cdRemainingMs(s, 'u-me', 99_999)).toBe(0);
    expect(cdRemainingMs(s, 'u-none', 0)).toBe(0);
  });

  it('myPendingQuestion：只认「发给我且 pending」的题', () => {
    const s = withQuestion([
      q({ id: 'a', status: 'pending' }),
      q({ id: 'b', status: 'answered', chosen: 0, answerRevealed: 1 }),
      q({ id: 'c', status: 'pending', toUserId: 'ai-r-1' }),
    ]);
    expect(myPendingQuestion(s, 'u-me')?.id).toBe('a');
  });

  it('pendingToOpponent：只认「我出、发给对方、pending」的题', () => {
    const s = withQuestion([
      q({ id: 'x', fromUserId: 'u-me', toUserId: 'ai-r-1', status: 'pending' }),
      q({ id: 'y', fromUserId: 'ai-r-1', toUserId: 'u-me', status: 'pending' }),
    ]);
    expect(pendingToOpponent(s, 'u-me')?.id).toBe('x');
  });

  it('没有待答/待判题时返回 null（不炸）', () => {
    expect(myPendingQuestion(withQuestion([]), 'u-me')).toBeNull();
    expect(pendingToOpponent(withQuestion([]), 'u-me')).toBeNull();
  });

  it('optionLetter：0-3 → A-D，越界返回空串', () => {
    expect(optionLetter(0)).toBe('A');
    expect(optionLetter(3)).toBe('D');
    expect(optionLetter(4)).toBe('');
    expect(optionLetter(-1)).toBe('');
  });

  it('verdictText：答对带 + 号，答错为负', () => {
    expect(verdictText(true, 2)).toBe('答对 +2');
    expect(verdictText(false, -1)).toBe('答错 -1');
  });
});
