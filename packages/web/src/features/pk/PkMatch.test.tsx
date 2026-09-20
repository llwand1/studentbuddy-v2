// @vitest-environment jsdom
/**
 * PkMatch.test — 对局视图的组件级回归锁（契约 docs/PK-SPEC.md §1/§5/§9/§12）。
 *
 * pk-view.test.ts 锁纯函数口径；这里锁的是「帧到了界面动不动」：
 * 中央三态互斥（答题／出题中／出题，UX 批核心改动）、出题入口永远可达、
 * 判分反馈真调 API 并回显、跑题裁判建议必须显示（只说「跑题」不给方向＝坑人）、
 * 投降两段确认。判分权威在服务端，本组件只发请求 + 渲染。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { PkPlayer, PkQuestion, PkRoomState } from '@sb/shared';
import { ApiError, api } from '../../lib/api';
import { PkMatch } from './PkMatch';

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ApiError: actual.ApiError,
    api: {
      pk: { submitQuiz: vi.fn(), submitAnswer: vi.fn(), useHelp: vi.fn(), requestRetry: vi.fn() },
    },
  };
});

const pk = api.pk as unknown as Record<'submitQuiz' | 'submitAnswer' | 'useHelp' | 'requestRetry', ReturnType<typeof vi.fn>>;

const ME = 'u-me';
const OPP = 'u-opp';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function player(userId: string, over: Partial<PkPlayer> = {}): PkPlayer {
  return {
    userId,
    nickname: userId === ME ? '我' : '对手',
    score: 3,
    correct: 2,
    answered: 3,
    lastQuizAt: 0,
    topic: '浮力',
    helpLeft: 1,
    failStreak: 0,
    ...over,
  };
}

function question(over: Partial<PkQuestion> = {}): PkQuestion {
  return {
    id: 'q1',
    roomId: 'r-1',
    fromUserId: OPP,
    toUserId: ME,
    prompt: 'p',
    stem: '一物体排开 2kg 水，浮力为？',
    options: ['2N', '20N', '9.8N', '无法确定'],
    createdAt: 0,
    deadlineAt: Date.now() + 45_000,
    status: 'pending',
    ...over,
  };
}

function room(over: Partial<PkRoomState> = {}): PkRoomState {
  return {
    roomId: 'r-1',
    roomCode: '123456',
    status: 'active',
    mode: 'pvp',
    players: [player(ME), player(OPP)],
    nextQuizAt: {},
    endsAt: Date.now() + 60_000,
    questions: [],
    currentTopic: '浮力',
    topicOwnerId: ME,
    topicTurn: 0,
    retryNextAt: {},
    ...over,
  };
}

function setup(state: PkRoomState, over: { busy?: boolean; onForfeit?: () => void } = {}) {
  const onForfeit = over.onForfeit ?? vi.fn();
  const r = render(
    <PkMatch state={state} userId={ME} busy={over.busy ?? false} onForfeit={onForfeit} />,
  );
  return { ...r, onForfeit };
}

const inFold = (c: HTMLElement) => {
  const btn = c.querySelector('.sb-pk-fold-btn') as HTMLButtonElement;
  if (btn.textContent?.includes('展开')) fireEvent.click(btn);
};

describe('PkMatch 对局视图', () => {
  it('有我的待答题：中央区只放答题块，出题入口收进折叠区且仍可达', () => {
    const { container } = setup(room({ questions: [question()] }));
    const main = container.querySelector('.sb-pk-arena-main')!;
    expect(main.textContent).toContain('轮到你答');
    expect(main.textContent).toContain('一物体排开 2kg 水，浮力为？');
    expect(main.textContent).not.toContain('出题给对手'); // 中央三态互斥，不并列堆叠
    expect(container.querySelector('.sb-pk-fold-sum')?.textContent).toContain('出题 · ');
    inFold(container);
    expect(container.querySelector('.sb-pk-fold-body')?.textContent).toContain('出题给对手'); // 入口永远可达
  });

  /**
   * 两条闪光各自挂一条独立计时器是旧实现的坑：第一条到点会把第二条刚亮起来的判定一起抹掉，
   * 玩家连答两题时第二条几乎看不见。时间线用假计时器钉死（两次闪光间隔 1000ms < 2500ms），
   * 再推进到「第一条已到期、第二条还没」的那一帧断言它仍在。
   */
  it('连答两题：后一条判定不被前一条的计时器提前抹掉', async () => {
    vi.useFakeTimers();
    try {
      pk.submitAnswer
        .mockResolvedValueOnce({ correct: true, delta: 2 })
        .mockResolvedValueOnce({ correct: false, delta: -1 });
      const { container } = setup(room({ questions: [question()] }));
      const opt = container.querySelectorAll('.sb-pk-option')[1] as Element;
      const flash = () => container.querySelector('.sb-pk-verdict-flash');
      /** act 只刷 microtask 与 React 待渲染队列、不推进假计时器，所以两条闪光各自的到期点可算 */
      const settle = () => act(async () => {});
      await act(async () => {
        fireEvent.click(opt);
      });
      expect(flash()?.textContent).toContain('答对 +2');
      vi.advanceTimersByTime(1000);
      await act(async () => {
        fireEvent.click(opt);
      });
      expect(flash()?.textContent).toContain('答错');
      vi.advanceTimersByTime(1600); // t=2600：第一条的 2500ms 已过，第二条只走了 1600ms
      await settle();
      expect(flash()?.textContent).toContain('答错'); // 旧实现：这里已被第一条抹成 null
      vi.advanceTimersByTime(1000); // t=3600：第二条自己的 2500ms 到点，该收了
      await settle();
      expect(flash()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('点选项 → POST answer → 判分反馈回显（答题只发选择，判分在服务端）', async () => {
    pk.submitAnswer.mockResolvedValue({ correct: true, delta: 2 });
    const { container } = setup(room({ questions: [question()] }));
    fireEvent.click(container.querySelectorAll('.sb-pk-option')[1] as Element);
    expect(pk.submitAnswer).toHaveBeenCalledWith('r-1', 'q1', 1);
    await waitFor(() => {
      const flash = container.querySelector('.sb-pk-verdict-flash');
      expect(flash?.textContent).toContain('答对 +2');
      expect(flash?.className).toContain('correct');
    });
  });

  it('无题可答时中央是出题块：空提示词禁用提交，提交后清空输入', async () => {
    pk.submitQuiz.mockResolvedValue(undefined);
    const { container } = setup(room({ questions: [] }));
    const main = container.querySelector('.sb-pk-arena-main')!;
    expect(main.textContent).toContain('出题给对手');
    const submit = main.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(main.querySelector('.sb-pk-input')!, { target: { value: '  出一道浮力题  ' } });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(pk.submitQuiz).toHaveBeenCalledWith('r-1', '出一道浮力题', 'single')); // trim 在服务调用点；§15 B2 题型随请求带走
    expect((main.querySelector('.sb-pk-input') as HTMLInputElement).value).toBe('');
  });

  it('跑题被拒：错误文案 + 裁判建议同时上屏（只说跑题不给方向＝坑人）', async () => {
    pk.submitQuiz.mockRejectedValue(
      new ApiError(400, '题目跑题了', { extra: { advice: { advice: ['往浮力概念靠'], knowledge: '阿基米德', refs: [] } } }),
    );
    const { container } = setup(room({ questions: [] }));
    fireEvent.change(container.querySelector('.sb-pk-input')!, { target: { value: '出一道历史题' } });
    fireEvent.click(container.querySelector('button[type="submit"]')!);
    await waitFor(() => {
      expect(container.querySelector('.sb-pk-error')?.textContent).toContain('题目跑题了');
      expect(container.textContent).toContain('裁判建议：这样出题才贴题');
      expect(container.querySelector('.sb-pk-advice li')?.textContent).toBe('往浮力概念靠');
    });
  });

  it('对手出题中：中央换成过渡提示（真秒数），不当成「没题也没事」', () => {
    const { container } = setup(
      room({ questions: [], quizPending: { userId: OPP, at: Date.now() - 3_000 } }),
    );
    const main = container.querySelector('.sb-pk-arena-main')!;
    expect(main.textContent).toContain('对手正在出题');
    expect(main.textContent).toContain('题目一出来就自动出现在这里');
    expect(main.textContent).not.toContain('出题给对手');
  });

  it('已判定行给分差与正确答案字母；错题带二次机会，冷却中禁用并显倒计时', async () => {
    pk.requestRetry.mockResolvedValue({ explanation: '浮力=排开水重', question: undefined });
    const wrong = question({ id: 'q9', status: 'answered', chosen: 0, answerRevealed: 1 });
    const { container } = setup(room({ questions: [wrong] }));
    expect(container.querySelector('.sb-pk-fold-sum')?.textContent).toContain('已判定 1');
    inFold(container);
    const body = container.querySelector('.sb-pk-fold-body')!;
    expect(body.textContent).toContain('答错 −1');
    expect(body.textContent).toContain('正确答案 B');
    const retry = body.querySelector('.sb-pk-btn.ghost') as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(pk.requestRetry).toHaveBeenCalledWith('r-1', 'q9'));
    await waitFor(() => expect(container.textContent).toContain('二次机会：现场解析'));
  });

  it('二次机会冷却未到时按钮禁用，倒计时直给（不能让人点了才知不能点）', () => {
    const wrong = question({ id: 'q9', status: 'answered', chosen: 1, answerRevealed: 0 });
    const { container } = setup(
      room({ questions: [wrong], retryNextAt: { [ME]: Date.now() + 30_000 } }),
    );
    inFold(container);
    const retry = container.querySelector('.sb-pk-fold-body .sb-pk-btn.ghost') as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toMatch(/二次机会 \d+:\d{2}/);
    expect(pk.requestRetry).not.toHaveBeenCalled();
  });

  it('投降两段确认：先「投降」再「确认认输」才回调；busy 时两钮禁用防重复提交', () => {
    const idle = setup(room({ questions: [] }));
    inFold(idle.container);
    let body = idle.container.querySelector('.sb-pk-fold-body')!;
    fireEvent.click(body.querySelector('.sb-pk-btn.danger') as HTMLButtonElement);
    expect(body.textContent).toContain('确认认输？'); // 一段点击不得直接投降（不可撤销）
    const confirm = Array.from(body.querySelectorAll('button')).find((b) => b.textContent === '确认认输');
    fireEvent.click(confirm!);
    expect(idle.onForfeit).toHaveBeenCalledTimes(1);

    const busy = setup(room({ questions: [] }), { busy: true });
    inFold(busy.container);
    body = busy.container.querySelector('.sb-pk-fold-body')!;
    fireEvent.click(body.querySelector('.sb-pk-btn.danger') as HTMLButtonElement);
    const busyBtn = Array.from(body.querySelectorAll('button')).find((b) => b.textContent === '提交中…');
    expect(busyBtn).toBeTruthy(); // 在途不换按钮语义，只换文案并禁用
    expect((busyBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
