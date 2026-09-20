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
  finishTitle,
  formatClock,
  formatEndedAt,
  isOwner,
  myIndex,
  myOutcome,
  myPendingQuestion,
  optionLetter,
  outcomeLabel,
  pendingToOpponent,
  reasonLabel,
  remainingMs,
  reviewVerdict,
  verdictText,
  normalizeRoomCode,
  topicOwnerLabel,
  myHelpLeft,
  retryRemainingMs,
  myWrongQuestions,
  quizPendingLabel,
  quizPendingSec,
  verdictKind,
  buildPkInviteLink,
  pkInviteCodeFromHash,
  sanitizeReturnTo,
} from './pk-view';

function state(players: Array<{ userId: string; nickname: string }>): PkRoomState {
  return {
    roomId: 'r-1',
    roomCode: '123456',
    status: 'waiting',
    mode: 'pvp',
    players: players.map((p) => ({
      ...p,
      score: 0,
      correct: 0,
      answered: 0,
      lastQuizAt: 0,
      topic: '',
      helpLeft: 1,
      failStreak: 0,
    })),
    nextQuizAt: {},
    endsAt: 0,
    questions: [],
    currentTopic: '',
    topicOwnerId: '',
    topicTurn: 0,
    retryNextAt: {},
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

describe('P0-7 · 主题轮转 / 道具 / 二次机会（纯函数）', () => {
  function two() {
    const s = state([
      { userId: 'a', nickname: '甲' },
      { userId: 'b', nickname: '乙' },
    ]);
    return s;
  }

  /** 造一道题：默认「发给 a、已判答错」，用例按需覆盖 */
  function q(over: Partial<PkQuestion>): PkQuestion {
    return {
      id: 'q1',
      roomId: 'r-1',
      fromUserId: 'b',
      toUserId: 'a',
      prompt: '',
      stem: '',
      options: ['x', 'y'],
      createdAt: 0,
      deadlineAt: 0,
      status: 'answered',
      chosen: 1,
      answerRevealed: 0,
      ...over,
    };
  }

  it('topicOwnerLabel：归我 → 你的主题；归对手 → 昵称；没开局 → 空', () => {
    expect(topicOwnerLabel({ ...two(), topicOwnerId: 'a' }, 'a')).toBe('你的主题');
    expect(topicOwnerLabel({ ...two(), topicOwnerId: 'b' }, 'a')).toBe('乙 的主题');
    expect(topicOwnerLabel(two(), 'a')).toBe('');
  });

  it('myHelpLeft：在房内读快照，不在房内返 0（不造假默认值）', () => {
    expect(myHelpLeft(two(), 'a')).toBe(1);
    expect(myHelpLeft(two(), 'ghost')).toBe(0);
  });

  it('retryRemainingMs：没用过 = 0 立即可用；CD 内为正且到点钳 0', () => {
    expect(retryRemainingMs(two(), 'a', 1000)).toBe(0);
    expect(retryRemainingMs({ ...two(), retryNextAt: { a: 5000 } }, 'a', 3000)).toBe(2000);
    expect(retryRemainingMs({ ...two(), retryNextAt: { a: 5000 } }, 'a', 9000)).toBe(0);
  });

  it('myWrongQuestions：只收「我答的且没答对」——答对/pending/别人的都不算', () => {
    const s = {
      ...two(),
      questions: [
        q({ id: 'wrong' }),
        q({ id: 'right', chosen: 0 }), // 答对
        q({ id: 'timeout', status: 'timeout', chosen: undefined }), // 超时未答，也算错
        q({ id: 'others', toUserId: 'b' }), // 不是我答的
        q({ id: 'pending', status: 'pending', chosen: undefined, answerRevealed: undefined }), // 还没判
      ],
    };
    expect(myWrongQuestions(s, 'a').map((x) => x.id)).toEqual(['wrong', 'timeout']);
  });
});

describe('P0-8 · 投降 / 对战历史（纯函数）', () => {
  /** 造一道题：默认「发给 a、已判定答对」，用例按需覆盖 */
  function q(over: Partial<PkQuestion>): PkQuestion {
    return {
      id: 'q1',
      roomId: 'r-1',
      fromUserId: 'b',
      toUserId: 'a',
      prompt: '',
      stem: '',
      options: ['x', 'y'],
      createdAt: 0,
      deadlineAt: 0,
      status: 'answered',
      chosen: 0,
      answerRevealed: 0,
      ...over,
    };
  }

  function finished(over: Partial<PkRoomState> = {}): PkRoomState {
    return {
      ...state([
        { userId: 'a', nickname: '甲' },
        { userId: 'b', nickname: '乙' },
      ]),
      status: 'finished',
      ...over,
    };
  }

  it('★ reviewVerdict：还没答的题（chosen 与 answerRevealed 双双 undefined）必须显示「未作答」', () => {
    // 这条是回归锁：旧写法 `chosen === answerRevealed` 在两个 undefined 时恰好为 true，
    // 屏幕上把「对局结束时还没答的题」显示成「答对 +2」（2026-09-14 随历史回看一并修掉）
    expect(reviewVerdict(q({ status: 'pending', chosen: undefined, answerRevealed: undefined }))).toEqual({
      text: '未作答',
      ok: false,
    });
  });

  it('reviewVerdict：超时 −1 / 答对 +2 / 答错 −1 三态互不串台', () => {
    expect(reviewVerdict(q({ status: 'timeout', chosen: undefined, answerRevealed: 1 }))).toEqual({
      text: '超时 −1',
      ok: false,
    });
    expect(reviewVerdict(q({ chosen: 1, answerRevealed: 1 }))).toEqual({ text: '答对 +2', ok: true });
    expect(reviewVerdict(q({ chosen: 0, answerRevealed: 1 }))).toEqual({ text: '答错 −1', ok: false });
  });

  it('outcomeLabel：胜 / 负 / 平', () => {
    expect(outcomeLabel('win')).toBe('胜');
    expect(outcomeLabel('lose')).toBe('负');
    expect(outcomeLabel('draw')).toBe('平');
  });

  it('reasonLabel：认输必须与「时间到」分开说，且分敌我措辞', () => {
    expect(reasonLabel('timeup', 'win')).toBe('时间到');
    expect(reasonLabel('timeup', 'draw')).toBe('时间到 · 平局');
    expect(reasonLabel('forfeit', 'win')).toBe('对方认输');
    expect(reasonLabel('forfeit', 'lose')).toBe('自己认输');
  });

  it('myOutcome：我赢 / 我输 / 无 winner 即平', () => {
    expect(myOutcome(finished({ winner: 'a' }), 'a')).toBe('win');
    expect(myOutcome(finished({ winner: 'b' }), 'a')).toBe('lose');
    expect(myOutcome(finished(), 'a')).toBe('draw');
  });

  it('finishTitle：认输换文案（「对局结束」看不出是谁点了投降）；时间到仍是老三样', () => {
    expect(finishTitle(finished({ winner: 'a', endReason: 'forfeit' }), 'a')).toBe('对方认输');
    expect(finishTitle(finished({ winner: 'b', endReason: 'forfeit' }), 'a')).toBe('自己认输');
    expect(finishTitle(finished({ winner: 'a' }), 'a')).toBe('对局结束');
    expect(finishTitle(finished(), 'a')).toBe('平局');
  });

  it('formatEndedAt：非法/缺失返空串（宁可空着也不显示 Invalid Date）', () => {
    expect(formatEndedAt(Number.NaN)).toBe('');
    expect(formatEndedAt(0)).toBe('');
    expect(formatEndedAt(-1)).toBe('');
  });

  it('formatEndedAt：MM-DD HH:mm 且补零（用本地时间构造，避开时区差异）', () => {
    expect(formatEndedAt(new Date(2026, 0, 5, 9, 7).getTime())).toBe('01-05 09:07');
    expect(formatEndedAt(new Date(2026, 11, 31, 23, 59).getTime())).toBe('12-31 23:59');
  });
});

describe('UX 批 · 出题过渡 / 判分种类（纯函数）', () => {
  function q(over: Partial<PkQuestion>): PkQuestion {
    return {
      id: 'q1',
      roomId: 'r-1',
      fromUserId: 'b',
      toUserId: 'a',
      prompt: '',
      stem: '',
      options: ['x', 'y'],
      createdAt: 0,
      deadlineAt: 0,
      status: 'answered',
      chosen: 0,
      answerRevealed: 0,
      ...over,
    };
  }

  function room(over: Partial<PkRoomState> = {}): PkRoomState {
    return {
      ...state([
        { userId: 'a', nickname: '甲' },
        { userId: 'b', nickname: '乙' },
      ]),
      ...over,
    };
  }

  it('★ quizPendingLabel：自己出题时不提示（我刚点了按钮、按钮本身就在转圈，再插一条是刷存在感）', () => {
    expect(quizPendingLabel(room({ quizPending: { userId: 'a', at: 1000 } }), 'a')).toBeNull();
  });

  it('quizPendingLabel：没人在出题 → null（不能凭空显示「对方正在出题」）', () => {
    expect(quizPendingLabel(room(), 'a')).toBeNull();
  });

  it('quizPendingLabel：对手出题 → 「对手正在出题」；AI 座位出题 → 「AI 正在出题」', () => {
    expect(quizPendingLabel(room({ quizPending: { userId: 'b', at: 1000 } }), 'a')).toEqual({
      who: '对手',
      text: '对手正在出题',
    });
    expect(quizPendingLabel(room({ quizPending: { userId: 'ai-r-1', at: 1000 } }), 'a')).toEqual({
      who: 'AI',
      text: 'AI 正在出题',
    });
  });

  it('quizPendingSec：向下取整、不出现负数（本机时钟回拨也不显示「−3s」）', () => {
    const s = room({ quizPending: { userId: 'b', at: 10_000 } });
    expect(quizPendingSec(s, 10_000)).toBe(0);
    expect(quizPendingSec(s, 13_900)).toBe(3);
    expect(quizPendingSec(s, 9_000)).toBe(0);
    expect(quizPendingSec(room(), 99_999)).toBe(0);
  });

  it('★ verdictKind：未作答（chosen 与 answerRevealed 双双 undefined）不算答对——与 reviewVerdict 同口径', () => {
    expect(verdictKind(q({ status: 'answered', chosen: undefined, answerRevealed: undefined }))).toBe('wrong');
  });

  it('verdictKind：答对 / 答错 / 超时 / 未判定四态互不串台', () => {
    expect(verdictKind(q({ chosen: 1, answerRevealed: 1 }))).toBe('correct');
    expect(verdictKind(q({ chosen: 1, answerRevealed: 2 }))).toBe('wrong');
    expect(verdictKind(q({ status: 'timeout' }))).toBe('timeout');
    expect(verdictKind(q({ status: 'pending' }))).toBe('pending');
  });
});

// ── §14.2/§14.3 邀请链接与 returnTo（B1，2026-09-20）────────────────

describe('pkInviteCodeFromHash（§14.2：query 在 hash 片段内，location.search 取不到）', () => {
  it('标准邀请链接：#/pk?code=123456 → 123456', () => {
    expect(pkInviteCodeFromHash('#/pk?code=123456')).toBe('123456');
  });

  it('带额外参数也认：#/pk?code=123456&from=wechat → 123456', () => {
    expect(pkInviteCodeFromHash('#/pk?code=123456&from=wechat')).toBe('123456');
  });

  it('非数字 / 超长 / 缺码 → 归一为空或截断（normalizeRoomCode 同口径）', () => {
    expect(pkInviteCodeFromHash('#/pk?code=abc')).toBe('');
    expect(pkInviteCodeFromHash('#/pk?code=1234567')).toBe('123456'); // 截到 6 位
    expect(pkInviteCodeFromHash('#/pk')).toBe('');
    expect(pkInviteCodeFromHash('#/pk?other=x')).toBe('');
  });
});

describe('buildPkInviteLink（§14.2：链接必须带 #，格式 <origin><path>#/pk?code=）', () => {
  it('拼出的链接能被 pkInviteCodeFromHash 还原出房号（拼与解析互为逆操作）', () => {
    const link = buildPkInviteLink('654321', { origin: 'https://11wand.com', pathname: '/' });
    expect(link).toContain('#/pk?code=654321');
    expect(link).not.toContain('undefined');
    const hash = `#${link.split('#')[1]}`;
    expect(pkInviteCodeFromHash(hash)).toBe('654321');
  });
});

describe('sanitizeReturnTo（§14.3：只允许 #/ 开头的站内 hash，防开放重定向）', () => {
  it('站内 hash 放行；绝对 URL / 裸路径 / 空值一律丢弃', () => {
    expect(sanitizeReturnTo('#/pk?code=123456')).toBe('#/pk?code=123456');
    expect(sanitizeReturnTo('#/pk')).toBe('#/pk');
    expect(sanitizeReturnTo('https://evil.com#/pk')).toBeNull(); // 钓鱼链接
    expect(sanitizeReturnTo('/pk')).toBeNull();
    expect(sanitizeReturnTo('pk')).toBeNull();
    expect(sanitizeReturnTo('')).toBeNull();
    expect(sanitizeReturnTo(null)).toBeNull();
    expect(sanitizeReturnTo(undefined)).toBeNull();
  });
});
