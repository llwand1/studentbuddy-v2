/**
 * pk-view.test — PK 页面纯逻辑回归锁。
 *
 * 钉的是契约口径：房号 6 位数字、时钟钳 0 不出负数、房主恒为 players[0]。
 * 时钟格式化是「客户端时间只作展示」的最后一道屏——格式错了对局页全员看错。
 */
import { describe, it, expect } from 'vitest';
import { PK_ROOM_CODE_LEN, type PkRoomState } from '@sb/shared';
import { formatClock, isOwner, myIndex, normalizeRoomCode, remainingMs } from './pk-view';

function state(players: Array<{ userId: string; nickname: string }>): PkRoomState {
  return {
    roomId: 'r-1',
    roomCode: '123456',
    status: 'waiting',
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
