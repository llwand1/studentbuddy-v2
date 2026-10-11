// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuestionFeedback } from './QuestionFeedback';
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/api-request', () => ({ request: api.request }));
vi.mock('./QuizCard', () => ({ QuizCard: ({ title }: { title: string }) => <div>{title}</div> }));
const input = { title: '加法', sessionId: 's', question: { type: 'single' as const, question: '2+3？', options: ['4', '5'], answer: [1] } };
const choices = { options: [{ id: 'a', label: '先练一步', description: '减少运算步骤' }, { id: 'b', label: '换个情境', description: '保留加法考点' }] };
beforeEach(() => { api.request.mockReset(); });
afterEach(cleanup);
const open = () => fireEvent.click(screen.getByRole('button', { name: /评价这道题/ }));
describe('内联题目评价', () => {
  it('按需预判，收起再展开使用本题选项；点选意见直接适应出题', async () => {
    api.request.mockResolvedValueOnce(choices).mockResolvedValueOnce({ announced: true, quizId: 'new', quiz: {} });
    render(<QuestionFeedback input={input} />); expect(api.request).not.toHaveBeenCalled();
    open(); await screen.findByText('先练一步');
    fireEvent.click(screen.getByRole('button', { name: /收起题目评价/ })); open();
    expect(api.request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /先练一步/ }));
    await screen.findByText('已按评价生成新题，见下方题卡。');
    expect(JSON.parse(api.request.mock.calls[1]![1].body)).toMatchObject({ sessionId: 's', feedback: '先练一步；减少运算步骤', question: input.question });
  });
  it('预判失败仍可自定义，出题失败保留评价并可重试', async () => {
    api.request.mockRejectedValueOnce(new Error('预判失败')).mockRejectedValueOnce(new Error('出题失败')).mockResolvedValueOnce({ announced: true, quiz: {} });
    render(<QuestionFeedback input={input} />); open(); await screen.findByRole('alert');
    fireEvent.change(screen.getByRole('textbox', { name: '我的题目评价' }), { target: { value: '想练列方程' } });
    fireEvent.click(screen.getByRole('button', { name: '按评价再来一题' })); await screen.findByText('出题失败');
    expect((screen.getByRole('textbox', { name: '我的题目评价' }) as HTMLTextAreaElement).value).toBe('想练列方程');
    fireEvent.click(screen.getByRole('button', { name: '按评价再来一题' })); await screen.findByText('已按评价生成新题，见下方题卡。');
  });
  it('取消与切题时中止请求，不接受迟到结果或把旧选项带到新题', async () => {
    let finish!: (v: typeof choices) => void;
    api.request.mockImplementationOnce(() => new Promise(r => { finish = r; })).mockResolvedValueOnce({ options: [] });
    const view = render(<QuestionFeedback input={input} />); open();
    const signal = api.request.mock.calls[0]![1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(signal.aborted).toBe(true);
    await act(async () => { finish(choices); }); expect(screen.queryByText('先练一步')).toBeNull();
    view.rerender(<QuestionFeedback input={{ ...input, question: { ...input.question, question: '新题' } }} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    open(); await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
    expect(JSON.parse(api.request.mock.calls[1]![1].body).question.question).toBe('新题');
  });
  it('无会话热身在原题下面展示适应新题，无模态遮罩', async () => {
    const receive = vi.fn();
    api.request.mockResolvedValueOnce(choices).mockResolvedValueOnce({ announced: false, quizId: 'new', quiz: { title: '新的基础题', questions: [] } });
    render(<QuestionFeedback input={{ ...input, sessionId: undefined }} onAdapted={receive} />); open(); await screen.findByText('先练一步');
    fireEvent.click(screen.getByRole('button', { name: /先练一步/ })); await screen.findByText('已按评价生成新题，见下方题卡。');
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ quizId: 'new', announced: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
