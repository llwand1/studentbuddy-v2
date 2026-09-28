/**
 * spell-chant-view.test — 历史行 → 咒语（契约 `docs/SPELL-CHANT-SPEC.md` §3.2–3.3）。
 *
 * ★ 锁三件事：① 题卡走对话页那份 `foldToolRounds` 还原（`[QUIZ]` 登记行 → 题）而不是本层再解析一遍；
 *   ② 工具轮（assistant 空正文 + tool 结果）不成节——那是「回答的过程」，不是一轮对话；
 *   ③ 共鸣按**全部**正文判（含没进节的那部分），文案由数字组句、不自己算数。
 */
import { describe, expect, it } from 'vitest';
import type { HistoryRow } from '../chat/history-fold';
import { castText, planSpell, spellTimeText, truncatedText, turnsFromHistory, verseTitle } from './spell-chant-view';

let n = 0;
function row(role: string, content: string, over: Partial<HistoryRow> = {}): HistoryRow {
  n += 1;
  return { id: `m${n}`, role, content, created_at: `2026-09-2${n % 9} 01:02:03`, ...over };
}

const quizRow = row(
  'assistant',
  `[QUIZ]${JSON.stringify({
    title: '闭包小测',
    quizId: 'q1',
    questions: [
      { type: 'single', question: '闭包捕获的是？', options: ['值', '词法环境'], answer: [1] },
      { type: 'essay', question: '谈谈内存' },
    ],
  })}[/QUIZ]`,
);

describe('planSpell：历史行 → 咒语', () => {
  it('提问配回答成节、题卡按对话页口径还原、工具轮不成节', () => {
    const rows: HistoryRow[] = [
      row('user', '什么是闭包？'),
      row('assistant', '', { tool_calls: JSON.stringify([{ id: 'c1', name: 'search', arguments: '{}' }]) }),
      row('tool', '搜索结果……', { tool_call_id: 'c1' }),
      row('assistant', '闭包是函数与其词法环境的组合。'),
      row('user', '出几道题'),
      quizRow,
    ];
    const plan = planSpell(rows, '闭包');
    expect(plan.verses.map((v) => v.kind)).toEqual(['recall', 'recall', 'quiz']);
    const first = plan.verses[0];
    if (first?.kind !== 'recall') throw new Error('首节应为复述');
    expect(first.echo).toBe('闭包是函数与其词法环境的组合。');
    const quiz = plan.verses[2];
    if (quiz?.kind !== 'quiz') throw new Error('第三节应为题');
    expect(quiz.title).toBe('闭包小测');
    expect(quiz.question.type).toBe('single');
    expect(plan.truncated).toBe(0);
    expect(plan.resonant).toBe(true);
  });

  it('共鸣看全部正文（含题干），不只看进了节的；词条没出现 ⇒ 不共鸣', () => {
    const rows: HistoryRow[] = [row('user', '出几道题'), quizRow];
    expect(planSpell(rows, '闭包').resonant).toBe(true);
    expect(planSpell(rows, '傅里叶变换').resonant).toBe(false);
    expect(planSpell([row('user', '随便聊聊'), row('assistant', '好啊')], '闭包').resonant).toBe(false);
  });

  it('只有图片没有文字的提问、空会话 ⇒ 0 节', () => {
    expect(planSpell([], '闭包').verses).toEqual([]);
    const imgOnly = [row('user', '', { images: JSON.stringify([{ dataUrl: 'data:image/png;base64,AAA' }]) }), row('assistant', '这张图是……')];
    expect(planSpell(imgOnly, '闭包').verses).toEqual([]);
    expect(turnsFromHistory(imgOnly)).toHaveLength(2);
  });
});

describe('文案：由数字组句', () => {
  it('verseTitle / truncatedText / castText', () => {
    expect(verseTitle({ kind: 'recall', prompt: 'p', echo: '' }, 0)).toBe('第 1 节 · 复述当初的提问');
    expect(verseTitle({ kind: 'quiz', question: { type: 'judge', question: 'x', answer: [0] }, title: 't' }, 2)).toBe('第 3 节 · 重做当初的题');
    expect(truncatedText(0)).toBeNull();
    expect(truncatedText(4)).toContain('4 节');
    expect(castText(0, 0, 3, false)).toContain('哑火');
    expect(castText(3, 3, 3, false)).toBe('3 节里命中 3 节：造成 3 点伤害。');
    expect(castText(6, 3, 4, true)).toContain('威力加倍：造成 6 点伤害');
    expect(castText(6, 3, 4, true, '炎蛇')).toBe('4 节里命中 3 节，咒语与这块地共鸣，威力加倍，化作「炎蛇」：造成 6 点伤害！');
    expect(castText(2, 2, 3, false, '无光斩')).toBe('3 节里命中 2 节，化作「无光斩」：造成 2 点伤害。');
    expect(castText(0, 0, 3, false, '无光斩')).not.toContain('无光斩');
  });

  it('spellTimeText：SQLite UTC 串按本地日历说人话；解析不出为空', () => {
    const now = new Date('2026-09-28T12:00:00+08:00');
    expect(spellTimeText('2026-09-28 01:00:00', now)).toBe('今天');
    expect(spellTimeText('2026-09-27 01:00:00', now)).toBe('昨天');
    expect(spellTimeText('2026-09-20 01:00:00', now)).toBe('8 天前');
    expect(spellTimeText('2026-06-01 01:00:00', now)).toBe('6月1日');
    expect(spellTimeText('not a date', now)).toBe('');
  });
});
