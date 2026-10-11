import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adaptQuestion, parseAdaptedQuiz, parseFeedbackOptions, parseFeedbackRequest, predictFeedback } from './quiz-feedback.js';
const ai = vi.hoisted(() => ({ text: vi.fn(), json: vi.fn() }));
vi.mock('../ai/gateway.js', () => ({ aiText: ai.text, aiJson: ai.json }));
vi.mock('./exam-mode.js', () => ({ buildExamPromptBlock: () => '当前应试范围' }));
vi.mock('./learner-model.js', () => ({ buildLearnerQuizBlock: () => '' }));
vi.mock('./adaptive-quiz.js', () => ({ buildDifficultyBlock: () => '默认难度' }));
vi.mock('./quiz-image.js', () => ({ loadQuizImage: () => false, buildImageInstruction: () => '', saveQuizImage: vi.fn() }));
const q = { type: 'single' as const, question: '2+3等于多少？', options: ['4', '5'], answer: [1], explanation: '加法' };
const input = { title: '加法', question: q, feedback: '先练一步基础加法' };
const raw = (question = '1+1等于多少？') => `[QUIZ]${JSON.stringify({ title: '一步加法', adjustment: '减少数值和步骤，先巩固加法。',
  questions: [{ ...q, question, options: ['2', '3'], answer: [0], source: { kind: 'collect', title: '假真题' }, tier: 'real' }] })}[/QUIZ]`;
beforeEach(() => { ai.text.mockReset(); ai.json.mockReset(); });
describe('GrillMe 题目评价', () => {
  it('校验题型、答案、输入上限，忽略客户端来源；评价不能空或过长', () => {
    expect(parseFeedbackRequest({ ...input, question: { ...q, source: { kind: 'collect' } } }, true)).toEqual(input);
    for (const bad of [{ ...input, feedback: '' }, { ...input, feedback: 'x'.repeat(601) }, { ...input, sessionId: 2 },
      { ...input, question: { ...q, answer: [9] } }, { ...input, question: { ...q, type: 'unknown' } }]) expect(parseFeedbackRequest(bad, true)).toBeNull();
  });
  it('预判选项有界且不重复，使用系统生成的稳定 id', () => {
    const options = [{ label: '先练一步', description: '减少运算步骤' }, { label: '换个情境', description: '在应用中练同一考点' }];
    expect(parseFeedbackOptions(JSON.stringify({ options }))?.map(o => o.id)).toEqual(['feedback-1', 'feedback-2']);
    expect(parseFeedbackOptions(JSON.stringify({ options: [options[0], options[0]] }))).toBeNull();
    expect(parseFeedbackOptions('{"options":[]}')).toBeNull();
  });
  it('预判不传参考答案和解析，显式传归属及取消信号', async () => {
    ai.json.mockResolvedValue({ ok: true, value: [{ id: '1', label: '简化', description: '先练一步' }] });
    const signal = new AbortController().signal;
    await predictFeedback(input, 'owner', signal);
    const call = ai.json.mock.calls[0]![0];
    expect(call).toMatchObject({ purpose: 'quiz.feedback', ownerId: 'owner', signal });
    expect(JSON.parse(call.messages[1].content)).not.toHaveProperty('answer');
    expect(call.messages[1].content).not.toContain('explanation');
  });
  it('拒绝原题、悬空图、无参考答案与缺少调整说明；新题身份按 AI 创作处理', () => {
    expect(parseAdaptedQuiz(raw(q.question), q, input.feedback, false)).toBeNull();
    expect(parseAdaptedQuiz(raw('根据下图回答问题'), q, input.feedback, false)).toBeNull();
    expect(parseAdaptedQuiz(raw().replace('"answer":[0]', '"answer":[]'), q, input.feedback, false)).toBeNull();
    expect(parseAdaptedQuiz(raw().replace('"adjustment":"减少数值和步骤，先巩固加法。",', ''), q, input.feedback, false)).toBeNull();
    expect(parseAdaptedQuiz(raw(), q, input.feedback, false)).toMatchObject({ feedback: { comment: input.feedback }, questions: [{ tier: 'basic', source: { kind: 'ai' } }] });
  });
  it('实质调整新题，坏输出最多重试一次；不使用预产物绕过反馈', async () => {
    ai.text.mockResolvedValueOnce({ ok: true, text: raw(q.question) }).mockResolvedValueOnce({ ok: true, text: raw() });
    const signal = new AbortController().signal;
    expect((await adaptQuestion(input, 'owner', signal)).questions[0]?.question).toBe('1+1等于多少？');
    expect(ai.text).toHaveBeenCalledTimes(2);
    expect(ai.text.mock.calls[0]![0]).toMatchObject({ purpose: 'quiz.adapt', ownerId: 'owner', signal });
    expect(JSON.parse(ai.text.mock.calls[0]![0].messages[1].content).feedback).toBe(input.feedback);
  });
  it('取消后不接收迟到新题，也不发起重试', async () => {
    const ctrl = new AbortController();
    ai.text.mockImplementation(async () => { ctrl.abort(); return { ok: true, text: raw() }; });
    await expect(adaptQuestion(input, 'owner', ctrl.signal)).rejects.toThrow();
    expect(ai.text).toHaveBeenCalledTimes(1);
  });
});
