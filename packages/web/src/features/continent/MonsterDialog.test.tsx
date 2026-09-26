// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildMonsterQuestions } from '@sb/shared';
import { MonsterDialog } from './MonsterDialog';
import type { ContinentTileView } from './continent-view';

afterEach(cleanup);

describe('知识大陆复习保存', () => {
  it('最后一题保存失败后可重试，保存过程中不重复提交', async () => {
    const tile: ContinentTileView = {
      id: 'retry-term', term: '闭包', definition: '函数与它所引用的词法环境的组合', domain: '编程',
      row: 0, col: 0, status: 'due', overdueDays: 0, daysSince: 1, dueInDays: 0,
      stage: 0, inScope: true, hasMonster: true, level: 1, species: ['fill'], discovered: false,
    };
    const onSolved = vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce(undefined);
    render(<MonsterDialog tile={tile} pool={[]} onSolved={onSolved} onClose={() => undefined} />);
    const question = buildMonsterQuestions(tile, 1, [])[0];
    if (!question) throw new Error('缺少测试题目');
    if (question.type === 'judge') fireEvent.click(screen.getByRole('button', { name: question.answer ? '对' : '错' }));
    else if (question.type === 'choice') fireEvent.click(screen.getByRole('button', { name: question.options[question.answerIndex] }));
    else if (question.type === 'fill') fireEvent.change(screen.getByRole('textbox'), { target: { value: question.answer } });
    else throw new Error('单词条题池应将连线题降级为填空');
    const submit = screen.getByRole('button', { name: '最后一击' });
    fireEvent.click(submit);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSolved).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText(/保存复习记录失败：连接中断/)).toBeTruthy());
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onSolved).toHaveBeenCalledTimes(2));
    expect(onSolved).toHaveBeenLastCalledWith(tile);
  });
});
