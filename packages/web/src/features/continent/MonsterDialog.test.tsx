// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildMonsterQuestions, computeReviewState, speciesTypes } from '@sb/shared';
import { MonsterDialog } from './MonsterDialog';
import type { ContinentTileView } from './continent-view';

afterEach(cleanup);

/**
 * 造一个地块视图——只填本文件要用的字段，其余给中性值。
 * ★ 为什么要抽这个 helper：`ContinentTileView` 每加一个字段（本轮加了领地/可通行 5 个），
 *   散落的字面量就会同时编译失败。集中一处，加字段只改这里。
 */
function tileOf(id: string, over: Partial<ContinentTileView> = {}): ContinentTileView {
  return {
    id,
    term: `词条${id}`,
    definition: `释义${id}`,
    domain: '编程',
    row: 0,
    col: 0,
    status: 'due',
    overdueDays: 0,
    daysSince: 1,
    dueInDays: 0,
    stage: 0,
    inScope: true,
    hasMonster: true,
    level: 1,
    species: speciesTypes(id, 1),
    discovered: false,
    landOwner: null,
    landOwnerTerm: null,
    territoryCount: 0,
    walkable: false,
    isLand: false,
    ...over,
  };
}

describe('知识大陆复习保存', () => {
  it('最后一题保存失败后可重试，保存过程中不重复提交', async () => {
    const tile = tileOf('retry-term', { term: '闭包', definition: '函数与它所引用的词法环境的组合', species: ['fill'] });
    const onSolved = vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce(undefined);
    render(<MonsterDialog tile={tile} pool={[]} onSolved={onSolved} onClose={() => undefined} />);
    const question = buildMonsterQuestions(tile, 1, [])[0];
    if (!question) throw new Error('缺少测试题目');
    if (question.type === 'judge') fireEvent.click(screen.getByRole('button', { name: question.answer ? '对' : '错' }));
    else if (question.type === 'choice' || question.type === 'scene') {
      fireEvent.click(screen.getByRole('button', { name: question.options[question.answerIndex] }));
    } else if (question.type === 'fill') fireEvent.change(screen.getByRole('textbox'), { target: { value: question.answer } });
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

describe('知识大陆情景题', () => {
  /** 取一个 1 级就是情景题的 id（`speciesTypes(id,1)[0] === 'scene'`，与本轮口径同源） */
  function sceneId(): string {
    for (let i = 0; i < 4000; i += 1) {
      const id = `s${i}`;
      if (speciesTypes(id, 1)[0] === 'scene') return id;
    }
    throw new Error('找不到情景题词条 id');
  }

  it('情景题渲染出情境框与题型标签，答对即收复', async () => {
    const id = sceneId();
    const tile = tileOf(id, { species: ['scene'] });
    const createdAt = '2026-09-20 00:00:00';
    const pool = ['x', 'y'].map((p) => ({
      id: p,
      term: `干扰${p}`,
      definition: `释义${p}`,
      domain: 'js',
      importance: 0.5,
      usage_count: 1,
      created_at: createdAt,
      updated_at: createdAt,
      review_stage: 0,
      last_reviewed_at: null,
      review_in_scope: 0,
      review: computeReviewState({ stage: 0, createdAt, now: new Date('2026-09-26T12:00:00Z') }),
    }));
    const onSolved = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<MonsterDialog tile={tile} pool={pool} onSolved={onSolved} onClose={() => undefined} />);
    // 题型标签 + 情境框（情景题比选择题多的就是这一层框）
    expect(screen.getByText('情景题')).toBeTruthy();
    const frame = container.querySelector('.continent-q-frame');
    expect(frame?.textContent ?? '').not.toBe('');
    const question = buildMonsterQuestions(tile, 1, pool)[0];
    if (!question || question.type !== 'scene') throw new Error('该 id 的首题应为情景题');
    fireEvent.click(screen.getByRole('button', { name: question.options[question.answerIndex] }));
    fireEvent.click(screen.getByRole('button', { name: '最后一击' }));
    await waitFor(() => expect(onSolved).toHaveBeenCalledTimes(1));
  });
});