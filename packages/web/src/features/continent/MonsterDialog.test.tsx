// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildMonsterQuestions, computeReviewState, speciesTypes } from '@sb/shared';
import { MonsterDialog } from './MonsterDialog';
import type { ContinentTileView } from './continent-view';

/**
 * 魔法吟唱的两个子弹窗**桩化**：咒语书要请求会话、吟唱框要打字复述——它们各有自己的用例
 * （`SpellBook.test.tsx` / `SpellChant.test.tsx`）；本文件只锁「翻书 → 吟唱 → 伤害回到血条 / 收复」这条接线。
 */
vi.mock('./SpellBook', () => ({
  SpellBook: (props: { onPick: (plan: unknown, session: { id: string; title: string }) => void; onClose: () => void }) => (
    <div className="stub-spell-book">
      <button onClick={() => props.onPick({ verses: [], truncated: 0, resonant: true }, { id: 's1', title: '闭包那次' })}>选咒语</button>
      <button onClick={props.onClose}>合上</button>
    </div>
  ),
}));
vi.mock('./SpellChant', () => ({
  SpellChant: (props: { title: string; onCast: (damage: number, detail: { kind: string }) => void; onClose: () => void }) => (
    <div className="stub-spell-chant">
      <span>吟唱中：{props.title}</span>
      <button onClick={() => props.onCast(2, { kind: 'dusk' })}>释放二点</button>
      <button onClick={() => props.onCast(0, { kind: 'dusk' })}>哑火</button>
      <button onClick={props.onClose}>中断</button>
    </div>
  ),
}));

afterEach(cleanup);
/** 横版战场是 canvas：jsdom 拿不到 2d 上下文，`BattleStage` 遇到 `null` 直接不画（画面不参与断言，血量走 aria-label） */
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

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
    monsterKind: 'due',
    ring: 0,
    wear: 0,
    ruin: false,
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
      last_used_at: null,
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

describe('知识大陆魔法吟唱', () => {
  it('伤害够就收复：onSolved 带这次释放的款式，父组件据此放该款的咒语版特效', async () => {
    const tile = tileOf('spell-1', { species: ['fill'] });
    const onSolved = vi.fn().mockResolvedValue(undefined);
    render(<MonsterDialog tile={tile} pool={[]} onSolved={onSolved} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '魔法吟唱' }));
    fireEvent.click(screen.getByRole('button', { name: '选咒语' }));
    expect(screen.getByText('吟唱中：闭包那次')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '释放二点' }));
    await waitFor(() => expect(onSolved).toHaveBeenCalledTimes(1));
    expect(onSolved).toHaveBeenLastCalledWith(tile, 'dusk');
  });

  it('伤害不够就掉血继续答题，且本次开怪只能吟唱一次', () => {
    const tile = tileOf('spell-3', { level: 3, species: speciesTypes('spell-3', 3) });
    const onSolved = vi.fn();
    render(<MonsterDialog tile={tile} pool={[]} onSolved={onSolved} onClose={() => undefined} />);
    expect(screen.getByText('第 1 / 3 题')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '魔法吟唱' }));
    fireEvent.click(screen.getByRole('button', { name: '选咒语' }));
    fireEvent.click(screen.getByRole('button', { name: '释放二点' }));
    // 掉 2 滴血 = 跳到最后一题；血条只剩一颗亮着
    expect(screen.getByText('第 3 / 3 题')).toBeTruthy();
    expect(document.querySelectorAll('.continent-hp-dot.on')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '最后一击' })).toBeTruthy();
    const used = screen.getByRole('button', { name: '吟唱已用' }) as HTMLButtonElement;
    expect(used.disabled).toBe(true);
    expect(onSolved).not.toHaveBeenCalled();
  });

  it('合上咒语书不算用掉；中断吟唱与哑火都算用掉并留一句话', () => {
    const tile = tileOf('spell-x', { level: 2, species: speciesTypes('spell-x', 2) });
    render(<MonsterDialog tile={tile} pool={[]} onSolved={vi.fn()} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '魔法吟唱' }));
    fireEvent.click(screen.getByRole('button', { name: '合上' }));
    expect((screen.getByRole('button', { name: '魔法吟唱' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '魔法吟唱' }));
    fireEvent.click(screen.getByRole('button', { name: '选咒语' }));
    fireEvent.click(screen.getByRole('button', { name: '中断' }));
    expect(screen.getByText(/吟唱中断/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '吟唱已用' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('第 1 / 2 题')).toBeTruthy();
    cleanup();
    render(<MonsterDialog tile={tile} pool={[]} onSolved={vi.fn()} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '魔法吟唱' }));
    fireEvent.click(screen.getByRole('button', { name: '选咒语' }));
    fireEvent.click(screen.getByRole('button', { name: '哑火' }));
    expect(screen.getByText(/哑火/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '吟唱已用' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('横版战斗（2026-09-30：地图 → 战场的转场与战场本身）', () => {
  it('讨伐弹窗带着横版战场：血量与题数同源，掉血后战场的可读描述跟着变', () => {
    const tile = tileOf('stage-3', { level: 3, species: speciesTypes('stage-3', 3) });
    render(<MonsterDialog tile={tile} pool={[]} onSolved={vi.fn()} onClose={() => undefined} />);
    expect(screen.getByRole('dialog', { name: '讨伐 词条stage-3' })).toBeTruthy();
    expect(document.querySelector('.continent-battle .continent-battle-card')).toBeTruthy();
    const stage = screen.getByRole('img', { name: /横版战场：勇者对阵「词条stage-3」/ });
    expect(stage.getAttribute('aria-label')).toContain('剩余 3 / 3');
    fireEvent.click(screen.getByRole('button', { name: '魔法吟唱' }));
    fireEvent.click(screen.getByRole('button', { name: '选咒语' }));
    fireEvent.click(screen.getByRole('button', { name: '释放二点' }));
    expect(screen.getByRole('img', { name: /剩余 1 \/ 3/ })).toBeTruthy();
  });

  it('废墟重建走同一场战斗：标题说"重建"、对手是"废墟守卫"，「撤退」即关闭', () => {
    const tile = tileOf('ruin-1', { ruin: true, hasMonster: false, monsterKind: null, status: 'upcoming', species: ['fill'] });
    const onClose = vi.fn();
    render(<MonsterDialog tile={tile} pool={[]} onSolved={vi.fn()} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: '重建 词条ruin-1' })).toBeTruthy();
    expect(screen.getByText(/废墟守卫/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤退' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
