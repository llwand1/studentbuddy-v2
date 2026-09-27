// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QuizCard } from './QuizCard';
import { reviewAttempt } from './quiz-attempt';
const apiMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: apiMock }));
const question = { type: 'single' as const, question: '叶绿体的作用？', options: ['光合作用', '吸收矿物质'], answer: [0], explanation: '光能转化为化学能。' };
const result = { summary: '先区分能量和物质。', sections: [{ title: '光能去向', questions: [1], explanation: '光能转为化学能。',
  svg: "<svg viewBox='0 0 200 100'><rect x='10' y='10' width='100' height='30'/><text x='20' y='60'>光能</text></svg>", caption: '方框表示转化。' }],
  transfer: { question: '如果没有光呢？', answer: '光反应不能继续。' } };
beforeEach(() => { apiMock.request.mockReset(); });
afterEach(cleanup);
const complete = () => { fireEvent.click(screen.getByRole('button', { name: /吸收矿物质/ })); fireEvent.click(screen.getByText('确认作答')); };
describe('普通题完成与图文复盘', () => {
  it('五类题均能完成；多空分开提交，主观题不伪装自动判分', () => {
    render(<QuizCard title="混合练习" sessionId="s" questions={[
      question, { type: 'multiple', question: '选两个', options: ['一', '二', '三'], answer: [0, 2] },
      { type: 'judge', question: '需要光？', answer: [0] },
      { type: 'fill', question: '两种原料', answer: ['水', '二氧化碳'] },
      { type: 'essay', question: '解释过程', answer: '能量转化' },
    ]} />);
    expect(screen.queryByText('一键讲解 · 图文复盘')).toBeNull();
    const rows = screen.getAllByRole('region', { name: /第 \d 题/ });
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: /光合作用/ }));
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: /一/ }));
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: /三/ }));
    fireEvent.click(within(rows[2] as HTMLElement).getByRole('button', { name: /正确/ }));
    fireEvent.change(screen.getByLabelText('第 1 空'), { target: { value: '水' } });
    fireEvent.change(screen.getByLabelText('第 2 空'), { target: { value: 'CO2' } });
    fireEvent.change(screen.getByLabelText('你的解答'), { target: { value: '光转化为化学能' } });
    screen.getAllByText('确认作答').forEach((button) => fireEvent.click(button));
    fireEvent.click(screen.getByText('提交并对照参考'));
    expect(screen.getByText('一键讲解 · 图文复盘')).toBeTruthy();
    expect(screen.getByText(/3 项答案吻合/).textContent).toContain('2 项待对照');
    fireEvent.click(screen.getByText('再练一遍'));
    expect(screen.queryByText('本轮探索完成')).toBeNull();
    expect(screen.getAllByText('确认作答')).toHaveLength(4);
  });
  it('选项集合无序核对；填空保持语义待核对，缺参考不判错', () => {
    expect(reviewAttempt({ ...question, type: 'multiple', answer: [0, 1] }, { picked: [1, 0], fills: [], essay: '' }).verdict).toBe('correct');
    expect(reviewAttempt({ type: 'fill', question: '元素', answer: ['Fe'] }, { picked: [], fills: ['fe'], essay: '' }).verdict).toBe('review');
    expect(reviewAttempt({ ...question, answer: undefined }, { picked: [0], fills: [], essay: '' }).verdict).toBe('review');
  });
  it('只调用一次，并提交真实错答；渲染图文和可展开迁移思路', async () => {
    apiMock.request.mockResolvedValue(result);
    render(<QuizCard title="练习" questions={[question]} sessionId="s" />); complete();
    const button = screen.getByText('一键讲解 · 图文复盘');
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByText('光能去向');
    expect(apiMock.request).toHaveBeenCalledTimes(1);
    const body = JSON.parse(apiMock.request.mock.calls[0]?.[1].body);
    expect(body.items[0]).toMatchObject({ answer: 'B. 吸收矿物质', verdict: 'wrong' });
    expect(document.querySelector('.quiz-lesson svg text')?.textContent).toBe('光能');
    expect(screen.getByText('想一想，再查看参考思路').closest('details')?.open).toBe(false);
  });
  it('生成失败保留作答，允许重试；无有效图不得展示完成讲解', async () => {
    apiMock.request.mockRejectedValueOnce(new Error('模型暂不可用')).mockResolvedValueOnce(result);
    render(<QuizCard title="练习" questions={[question]} sessionId="s" />); complete();
    fireEvent.click(screen.getByText('一键讲解 · 图文复盘'));
    await screen.findByRole('alert');
    expect(screen.getByText(/B. 吸收矿物质/, { selector: 'p' })).toBeTruthy();
    fireEvent.click(screen.getByText('重新生成图文讲解'));
    await screen.findByText('光能去向');
  });
  it('取消中止请求，迟到的结果不覆盖页面', async () => {
    let resolve: (value: typeof result) => void = () => undefined;
    apiMock.request.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<QuizCard title="练习" questions={[question]} sessionId="s" />); complete();
    fireEvent.click(screen.getByText('一键讲解 · 图文复盘'));
    const signal = apiMock.request.mock.calls[0]?.[1].signal as AbortSignal;
    fireEvent.click(screen.getByText('取消生成'));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(result));
    await waitFor(() => expect(screen.queryByText('光能去向')).toBeNull());
    expect(screen.getByText('重新生成图文讲解')).toBeTruthy();
  });
  it('拒绝只有空 SVG 的结果', async () => {
    apiMock.request.mockResolvedValue({ ...result, sections: [{ ...result.sections[0], svg: '<svg></svg>' }] });
    render(<QuizCard title="练习" questions={[question]} sessionId="s" />); complete();
    fireEvent.click(screen.getByText('一键讲解 · 图文复盘'));
    await screen.findByText('讲解中的图示没有完整生成，请重试。');
    expect(screen.queryByText('看懂这一轮')).toBeNull();
  });
});
