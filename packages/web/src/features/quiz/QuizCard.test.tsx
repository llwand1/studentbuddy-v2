// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { checkQuizAnswer, type QuizQuestion } from '@sb/shared';
import { QuizCard } from './QuizCard';
import { resetRoundMocks, roundMocks, roundState, RoundEventSource } from './quiz-round.testkit';
vi.mock('../../lib/api-quiz-rounds', async () => ({ quizRoundsApi: (await import('./quiz-round.testkit')).roundMocks }));
vi.mock('../../lib/api-quiz-attempts', async () => ({ quizAttemptsApi: (await import('./quiz-round.testkit')).attemptMocks }));
const questions: QuizQuestion[] = [
  { type: 'single', question: '叶绿体的作用？', options: ['光合作用', '吸收矿物质'], answer: [0], explanation: '参考解析只在交卷后显示' },
  { type: 'single', question: '第二题', options: ['水', '光'], answer: [1] },
];
beforeEach(() => { resetRoundMocks(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async (qs = questions) => { render(<QuizCard title="植物" questions={qs} quizId="q1" sessionId="s1" />); return screen.findAllByRole('region', { name: /^第 \d 题$/ }); };
const select = (row: HTMLElement, text: string) => fireEvent.click(within(row).getByRole('button', { name: new RegExp(text) }));
it('keeps thinking optional and collapsed, preserves edits and hides all verdicts until group submission', async () => {
  const rows = await open();
  expect(screen.queryByRole('textbox', { name: '我的思考 / 评价' })).toBeNull();
  select(rows[0]!, '光合作用'); select(rows[1]!, '光');
  expect(screen.queryByText('参考解析只在交卷后显示')).toBeNull();
  expect(document.querySelector('.quiz-feedback')).toBeNull();
  select(rows[0]!, '吸收矿物质');
  fireEvent.click(within(rows[0]!).getByRole('button', { name: /我的思考/ }));
  fireEvent.change(screen.getByRole('textbox', { name: '我的思考 / 评价' }), { target: { value: '我不确定吸收是否发生在这里，题目用词有歧义。' } });
  await waitFor(() => expect(roundMocks.save).toHaveBeenCalled());
  expect(roundMocks.save.mock.calls.some(([, change]) => change.thought.includes('有歧义'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /提交整组答案/ }));
  await screen.findByText('第 1 轮 · 已交卷');
  const submitted = roundMocks.submit.mock.calls[0]![1];
  expect(submitted[0].draft.picked).toEqual([1]); expect(submitted[1].thought).toBe('');
  expect(screen.getByText('参考解析只在交卷后显示')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: '我的思考 / 评价' }).hasAttribute('disabled')).toBe(true);
});
it('handles all five types as editable drafts and does not provide answer hints before submission', async () => {
  const qs: QuizQuestion[] = [questions[0]!, { type: 'multiple', question: '选两项', options: ['甲', '乙', '丙'], answer: [0, 2] },
    { type: 'judge', question: '需要光？', answer: [0] }, { type: 'fill', question: '两种原料', answer: ['水', '二氧化碳'] }, { type: 'essay', question: '解释过程', answer: '能量转化' }];
  const rows = await open(qs);
  select(rows[0]!, '光合作用'); select(rows[1]!, '甲'); select(rows[1]!, '丙'); select(rows[2]!, '正确');
  expect(screen.queryByRole('button', { name: '提示' })).toBeNull();
  fireEvent.change(screen.getByLabelText('第 1 空'), { target: { value: '水' } });
  fireEvent.change(screen.getByLabelText('第 2 空'), { target: { value: 'CO2' } });
  fireEvent.change(screen.getByLabelText('你的解答'), { target: { value: '光转化成化学能' } });
  fireEvent.click(screen.getByRole('button', { name: /提交整组答案/ })); await screen.findByText('第 1 轮 · 已交卷');
  expect(roundMocks.submit.mock.calls[0]![1]).toHaveLength(5);
  expect(screen.getAllByLabelText(/的独立分析/)).toHaveLength(5);
});
it('shows question two while question one is still pending, ignoring old generations and duplicate stream revisions', async () => {
  roundMocks.submit.mockImplementation(async (id, changes) => {
    const r = roundState(id); r.state = 'submitted'; r.revision++;
    r.responses.forEach((a, i) => { Object.assign(a, changes[i]); a.result = checkQuizAnswer(r.questions[i]!, a.draft); a.status = 'analyzing'; a.generation = 1; });
    return JSON.parse(JSON.stringify(r));
  });
  const rows = await open(); select(rows[0]!, '光合作用'); select(rows[1]!, '光');
  fireEvent.click(screen.getByRole('button', { name: /提交整组答案/ })); await screen.findByText('第 1 轮 · 已交卷');
  await waitFor(() => expect(RoundEventSource.instances.length).toBe(1));
  const es = RoundEventSource.instances[0]!, r = roundState('round-1'), revision = r.revision + 1;
  act(() => es.emit({ type: 'delta', roundId: r.id, index: 1, generation: 1, revision, delta: '第二题的解释先出现' }));
  expect(within(screen.getByLabelText('第 2 题的独立分析')).getByText('第二题的解释先出现')).toBeTruthy();
  expect(within(screen.getByLabelText('第 1 题的独立分析')).queryByText('第二题的解释先出现')).toBeNull();
  act(() => { es.emit({ type: 'delta', roundId: r.id, index: 1, generation: 0, revision: revision + 2, delta: '旧任务不能出现' });
    es.emit({ type: 'delta', roundId: r.id, index: 1, generation: 1, revision, delta: '重复不能出现' }); });
  expect(screen.queryByText(/旧任务不能出现|重复不能出现/)).toBeNull();
});
it('preserves thought and analysis in the earlier round and starts the next round blank', async () => {
  const rows = await open([questions[0]!]); select(rows[0]!, '光合作用');
  fireEvent.click(screen.getByRole('button', { name: /我的思考/ }));
  fireEvent.change(screen.getByRole('textbox', { name: '我的思考 / 评价' }), { target: { value: '先排除另一项' } });
  fireEvent.click(screen.getByRole('button', { name: /提交整组答案/ })); await screen.findByText('第 1 轮 · 已交卷');
  fireEvent.click(screen.getByRole('button', { name: '再练一遍' })); await screen.findByText('第 2 轮 · 作答中');
  expect(screen.queryByRole('textbox', { name: '我的思考 / 评价' })).toBeNull();
  expect(screen.queryByText('本题分析文字')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看上一轮' })); await screen.findByText('第 1 轮 · 已交卷');
  expect(screen.getByRole('textbox', { name: '我的思考 / 评价' })).toHaveProperty('value', '先排除另一项');
  expect(screen.getByText('本题分析文字')).toBeTruthy();
});
it('preserves source tiers and essential question materials while withholding reference feedback', async () => {
  const qs: QuizQuestion[] = [{ ...questions[0]!, material: '原文材料', tier: 'real', source: { kind: 'collect', title: '真题', url: 'https://example.org' } },
    { ...questions[1]!, source: { kind: 'web', title: '参考' } }, { ...questions[0]!, question: '第三题' }];
  const rows = await open(qs);
  expect(within(rows[0]!).getByText('真题·必刷')).toBeTruthy();
  expect(within(rows[1]!).getByText('模拟题·建议做')).toBeTruthy();
  expect(within(rows[2]!).getByText('基础题·可选做')).toBeTruthy();
  expect(screen.getByLabelText('材料').textContent).toContain('原文材料');
  expect(screen.getByText(/本组：真题 1 · 模拟 1 · 基础 1/)).toBeTruthy();
});
