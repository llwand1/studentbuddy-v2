// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QuizQuestionItem } from './QuizQuestionItem';

vi.mock('../../lib/api-ai-ops', async (orig) => {
  const real = await orig<typeof import('../../lib/api-ai-ops')>();
  return { ...real, aiOpsApi: { ...real.aiOpsApi, reportAnswer: vi.fn(), grade: () => new Promise(() => undefined) } };
});
afterEach(cleanup);

const base = { type: 'single' as const, question: '阅读材料可知，作者的态度是（　）', options: ['赞许', '批评'], answer: [0] };
const order = (a: Node, b: Node) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;

describe('QuizQuestionItem 自包含渲染（QUIZ-COMPLETE-SPEC §6）', () => {
  it('material 渲染在题干之前，且保留原文', () => {
    render(<QuizQuestionItem q={{ ...base, material: '我看见他戴着黑布小帽，穿着黑布大马褂。' }} index={0} onComplete={() => undefined} />);
    const mat = screen.getByLabelText('材料');
    expect(mat.textContent).toContain('黑布小帽');
    expect(order(mat, screen.getByText(/作者的态度/))).toBeTruthy();
  });
  it('essential 原图排在题干之前；普通配图仍排在题干之后', () => {
    const photo = { src: '/api/images/a.png', alt: '电路图', credit: '图源：exam.test（原题页面配图）', pageUrl: 'https://exam.test/p' };
    const { rerender } = render(<QuizQuestionItem q={{ ...base, photo: { ...photo, essential: true } }} index={0} onComplete={() => undefined} />);
    expect(order(screen.getByAltText('电路图'), screen.getByText(/作者的态度/))).toBeTruthy();
    rerender(<QuizQuestionItem q={{ ...base, photo }} index={0} onComplete={() => undefined} />);
    expect(order(screen.getByText(/作者的态度/), screen.getByAltText('电路图'))).toBeTruthy();
  });
  it('旧题（无 material/photo）不多出任何节点', () => {
    render(<QuizQuestionItem q={{ ...base, question: '光合作用的场所是（　）' }} index={0} onComplete={() => undefined} />);
    expect(screen.queryByLabelText('材料')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('原图署名链接指回来源页面', () => {
    render(<QuizQuestionItem q={{ ...base, photo: { src: '/api/images/a.png', alt: 'x', credit: '图源：exam.test', pageUrl: 'https://exam.test/p', essential: true } }} index={0} onComplete={() => undefined} />);
    expect(screen.getByRole('link', { name: '图源：exam.test' }).getAttribute('href')).toBe('https://exam.test/p');
  });
});
