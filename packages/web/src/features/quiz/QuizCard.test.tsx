// @vitest-environment jsdom
/**
 * QuizCard.test — 聊天题卡的作答锁（issue #56，2026-09-27）。
 *
 * ★ 四条判据，每条都对应一个"写错了也不会自己冒出来"的形状：
 *  ① **`judge` 渲染得出选项、答得了**。2026-09-20 加判断题时本卡片的选项渲染只写了
 *    `single｜multiple` ⇒ 那类卡在界面上是一个没有选项、提交按钮永远 disabled 的死块，
 *    而它**不报错**（题照样出得出来）。这份 UI 锁是那句「一切按选项判分的链路零特判」
 *    在渲染侧的第一次兑现。
 *  ② **上报的请求体里没有 `correct`**。这是"服务端复判"在前端侧的形状锁：只要有人把
 *    本地算的那个布尔塞进 body，这条立刻红。
 *  ③ **服务端返回的对错覆盖本地那份**（用例里刻意让两者相反）。两侧共用
 *    `shared/quiz-judge.ts` 本该一致，真不一致时以服务端为准是拍板的含义本身。
 *  ④ **上报失败不挡翻解析**。作答与解析是学习动作，记账是我们的统计需求；
 *    为了后者把前者的内容藏起来，等于让用户体验替指标买单。
 *
 * ★ `api.request` 用 `vi.mock` 替身：本文件锁的是"卡片发了什么、拿到响应怎么显示"，
 *   服务端的判分对不对由 `routes/quiz-report.test.ts` 与 `quiz-judge.test.ts` 那两处锁。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { QuizQuestion } from '@sb/shared';
import { QuizCard } from './QuizCard';

const request = vi.fn();
// 路径必须与组件里那句 import 指向同一个文件，否则 mock 挂不上
vi.mock('../../lib/api', () => ({ api: { request: (...args: unknown[]) => request(...args) } }));

afterEach(() => {
  cleanup();
  request.mockReset();
});

const ok = (correct: boolean | null, recorded = true) => Promise.resolve({ ok: true, correct, recorded });

const SINGLE: QuizQuestion[] = [{ type: 'single', question: '1+1=?', options: ['1', '2', '3'], answer: [1] }];
const JUDGE: QuizQuestion[] = [{ type: 'judge', question: '2 是偶数', options: ['正确', '错误'], answer: [0] }];

function optionButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button.quiz-opt')];
}

function submitBtn(container: HTMLElement): HTMLButtonElement | undefined {
  // `querySelector` 找不到时给的是 `null`，而用例断言的是 `undefined` ⇒ 归一，别让断言去迁就 helper 的形状
  return container.querySelector<HTMLButtonElement>('button.quiz-submit') ?? undefined;
}

describe('① 判断题答得了（本批修掉的死卡）', () => {
  it('judge 渲染出两个选项，点选后可提交，并显示判定结果', async () => {
    request.mockImplementation(() => ok(true));
    const { container } = render(<QuizCard title="T" questions={JUDGE} quizId="q1" />);
    const opts = optionButtons(container);
    // ★ 这一条在 2026-09-27 之前是 0：`judge` 不在选项渲染的判据里，整道题一个按钮都没有
    expect(opts).toHaveLength(2);
    expect(submitBtn(container)?.disabled).toBe(true); // 还没选 ⇒ 闸门关着
    fireEvent.click(opts[0]!);
    expect(submitBtn(container)?.disabled).toBe(false);
    fireEvent.click(submitBtn(container)!);
    await waitFor(() => expect(container.textContent).toContain('答对了'));
    expect(container.textContent).toContain('判断');
  });

  it('judge 单选语义：点第二个选项不会把第一个留在选中集里（与 single 同路，不是 multiple）', async () => {
    request.mockImplementation(() => ok(false));
    const { container } = render(<QuizCard title="T" questions={JUDGE} quizId="q1" />);
    const opts = optionButtons(container);
    fireEvent.click(opts[0]!);
    fireEvent.click(opts[1]!);
    fireEvent.click(submitBtn(container)!);
    const body = request.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(body.body).picked).toEqual([1]);
  });
});

describe('② 只交作答，不交对错', () => {
  it('上报打到 `/api/quiz/report`，body 里有 picked、**没有 correct**', async () => {
    request.mockImplementation(() => ok(true));
    const { container } = render(<QuizCard title="T" questions={SINGLE} quizId="q42" />);
    fireEvent.click(optionButtons(container)[1]!);
    fireEvent.click(submitBtn(container)!);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe('/api/quiz/report');
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({ quizId: 'q42', index: 0, picked: [1], text: '' });
    expect('correct' in body).toBe(false);
    expect('sessionId' in body).toBe(false); // 归属由服务端经 quiz_block 带出，不接受客户端自报
  });

  it('填空交的是 text，不交 picked', async () => {
    request.mockImplementation(() => ok(true));
    const { container } = render(
      <QuizCard title="T" questions={[{ type: 'fill', question: '水化学式____', answer: ['H2O'] }]} quizId="q9" />
    );
    fireEvent.input(container.querySelector('input.quiz-fill')!, { target: { value: 'H2O' } });
    fireEvent.click(submitBtn(container)!);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const body = JSON.parse((request.mock.calls[0]![1] as { body: string }).body) as { picked?: unknown; text?: string };
    expect(body.text).toBe('H2O');
    expect(body.picked ?? []).toEqual([]);
  });
});

describe('③④ 服务端回执说了算；失败不挡路', () => {
  it('本地判对、服务端判错 ⇒ 屏幕显示服务端那份', async () => {
    // 正常情况下两侧共用同一纯函数不会相反；真相反（题面被改过／包被动过）时以服务端为准
    request.mockImplementation(() => ok(false));
    const { container } = render(<QuizCard title="T" questions={SINGLE} quizId="q1" />);
    fireEvent.click(optionButtons(container)[1]!); // 本地这份是"对"
    fireEvent.click(submitBtn(container)!);
    await waitFor(() => expect(container.textContent).toContain('答错了'));
  });

  it('服务端说没记上（重答）⇒ 出解析，并说明为什么不重复计', async () => {
    request.mockImplementation(() => ok(true, false));
    const { container } = render(<QuizCard title="T" questions={SINGLE} quizId="q1" />);
    fireEvent.click(optionButtons(container)[1]!);
    fireEvent.click(submitBtn(container)!);
    await waitFor(() => expect(container.textContent).toContain('已经答过'));
    expect(container.textContent).toContain('答案：'); // 解析照常给
  });

  it('请求失败 ⇒ 解析照常翻出来，并说清是"没写上服务端"', async () => {
    request.mockImplementation(() => Promise.reject(new Error('network')));
    const { container } = render(<QuizCard title="T" questions={SINGLE} quizId="q1" />);
    fireEvent.click(optionButtons(container)[1]!);
    fireEvent.click(submitBtn(container)!);
    await waitFor(() => expect(container.textContent).toContain('练习记录没写上服务端'));
    expect(container.textContent).toContain('答案：');
    expect(container.textContent).toContain('答对了'); // 本地那份仍然显示
  });

  it('缺 quizId 的老卡 ⇒ 一次请求都不发，并如实说明不记录', async () => {
    const { container } = render(<QuizCard title="T" questions={SINGLE} />);
    fireEvent.click(optionButtons(container)[1]!);
    fireEvent.click(submitBtn(container)!);
    await waitFor(() => expect(container.textContent).toContain('不记录'));
    expect(request).not.toHaveBeenCalled();
  });

  it('服务端回 `correct:null`（这题不判）⇒ 不显示对错，只说不计入', async () => {
    request.mockImplementation(() => ok(null, false));
    const { container } = render(<QuizCard title="T" questions={SINGLE} quizId="q1" />);
    fireEvent.click(optionButtons(container)[1]!);
    fireEvent.click(submitBtn(container)!);
    await waitFor(() => expect(container.textContent).toContain('未计入练习记录'));
    expect(container.textContent).not.toContain('答对了');
    expect(container.textContent).not.toContain('答错了');
  });
});

describe('既有行为不破', () => {
  it('essay 仍然没有提交按钮（免检口径沿用，不是本批改的）', () => {
    const { container } = render(<QuizCard title="T" questions={[{ type: 'essay', question: '为什么', answer: '要点' }]} quizId="q1" />);
    expect(submitBtn(container)).toBeUndefined();
    /**
     * ⚠️ 顺手记下现网既有缺陷（**已登记在册＝issue #51**，老板 2026-09-27 提，其验收判据
     * 第一条「五类普通题均可提交并完成整组」正对着它；**本批不修**）：essay 没有提交按钮 ⇒
     * `revealed` 恒 `false` ⇒ 那句 `q.type === 'essay' ? q.solution ?? q.answer : …`
     * 在 `{revealed && …}` 里，**参考要点在界面上永远渲染不到**——
     * 而输入框的 placeholder 正写着「写下你的解答（对照参考要点）」，即它承诺了一个看不到的东西。
     * 这条断言锁的是**现状**（不显示），不是认可现状；修它要动可见行为，另批走。
     */
    expect(container.textContent).not.toContain('要点');
  });

  it('多选仍然是勾选式（点第二个不掉第一个）', async () => {
    request.mockImplementation(() => ok(true));
    const { container } = render(
      <QuizCard
        title="T"
        questions={[{ type: 'multiple', question: '选两个', options: ['a', 'b', 'c'], answer: [0, 2] }]}
        quizId="qm"
      />,
    );
    const opts = optionButtons(container);
    fireEvent.click(opts[0]!);
    fireEvent.click(opts[2]!);
    fireEvent.click(submitBtn(container)!);
    const body = JSON.parse((request.mock.calls[0]![1] as { body: string }).body) as { picked: number[] };
    expect(body.picked).toEqual([0, 2]);
  });
});
