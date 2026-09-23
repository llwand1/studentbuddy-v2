import { describe, it, expect } from 'vitest';
import { foldToolRounds, type HistoryRow } from './history-fold';

let seq = 0;
const row = (o: Partial<HistoryRow> & { role: string; content: string }): HistoryRow => ({
  id: `m${++seq}`,
  created_at: '2026-09-12 03:00:00',
  tool_calls: null,
  tool_call_id: null,
  ...o,
});

/** 造 tool_calls 的 JSON 串（与 flow.ts 落库形状一致） */
const calls = (...items: Array<[string, string, string]>): string =>
  JSON.stringify(items.map(([id, name, args]) => ({ id, name, arguments: args })));

describe('foldToolRounds', () => {
  it('单轮工具：工具轮不产出消息，步骤折到后面那条正文上', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: '搜一下' }),
      row({ role: 'assistant', content: '', tool_calls: calls(['c1', 'search_web', '{"query":"新闻"}']) }),
      row({ role: 'tool', content: '搜索结果摘要', tool_call_id: 'c1' }),
      row({ role: 'assistant', content: '根据搜索…' }),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[1]?.content).toBe('根据搜索…');
    expect(out[1]?.steps).toEqual([
      { tool: 'search_web', status: 'done', args: '{"query":"新闻"}', result: '搜索结果摘要' },
    ]);
  });

  it('多轮工具累积到同一条正文，结果按各自 call id 回填', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: '查两件事' }),
      row({ role: 'assistant', content: '', tool_calls: calls(['a', 'search_web', '{"query":"x"}']) }),
      row({ role: 'tool', content: 'X 结果', tool_call_id: 'a' }),
      row({ role: 'assistant', content: '', tool_calls: calls(['b', 'manage_terms', '{"action":"add"}']) }),
      row({ role: 'tool', content: 'Y 结果', tool_call_id: 'b' }),
      row({ role: 'assistant', content: '都查完了' }),
    ]);
    expect(out).toHaveLength(2);
    const last = out[1];
    expect(last?.content).toBe('都查完了');
    expect(last?.steps?.map((s) => [s.tool, s.result])).toEqual([
      ['search_web', 'X 结果'],
      ['manage_terms', 'Y 结果'],
    ]);
    expect(last?.steps?.every((s) => s.status === 'done')).toBe(true);
  });

  it('一轮内并列多个 call 全部进 steps', () => {
    const out = foldToolRounds([
      row({
        role: 'assistant',
        content: '',
        tool_calls: calls(['a', 'search_web', '{}'], ['b', 'tidy_terms', '{}']),
      }),
      row({ role: 'tool', content: 'RA', tool_call_id: 'a' }),
      row({ role: 'tool', content: 'RB', tool_call_id: 'b' }),
      row({ role: 'assistant', content: '结果' }),
    ]);
    expect(out[0]?.steps?.map((s) => s.tool)).toEqual(['search_web', 'tidy_terms']);
    expect(out[0]?.steps?.map((s) => s.result)).toEqual(['RA', 'RB']);
  });

  it('无工具轮的普通问答不带 steps', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: '你好' }),
      row({ role: 'assistant', content: '你好呀' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]?.steps).toBeUndefined();
  });

  it('有工具轮但没写完正文（被停止 / 纯工具轮）→ 保一条空正文消息，过程不丢', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: '整理词条' }),
      row({ role: 'assistant', content: '', tool_calls: calls(['t1', 'tidy_terms', '{"action":"auto"}']) }),
      row({ role: 'tool', content: '已合并 3 条', tool_call_id: 't1' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]?.content).toBe('');
    expect(out[1]?.steps?.[0]).toEqual({
      tool: 'tidy_terms',
      status: 'done',
      args: '{"action":"auto"}',
      result: '已合并 3 条',
    });
  });

  it('tool_calls 是坏 JSON → 当没有工具调用，不抛错也不吞消息', () => {
    const out = foldToolRounds([row({ role: 'assistant', content: '{oops', tool_calls: 'not json' })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe('{oops');
    expect(out[0]?.steps).toBeUndefined();
  });

  it('tool_call_id 配不上任何 call → 无副作用（孤儿结果不凭空造步骤）', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: 'q' }),
      row({ role: 'tool', content: '孤儿结果', tool_call_id: 'nope' }),
      row({ role: 'assistant', content: 'a' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]?.steps).toBeUndefined();
  });

  it('工具结果截断到 400 字（与流式期 step.result 同口径）', () => {
    const out = foldToolRounds([
      row({ role: 'assistant', content: '', tool_calls: calls(['c1', 'search_web', '{}']) }),
      row({ role: 'tool', content: 'x'.repeat(1000), tool_call_id: 'c1' }),
      row({ role: 'assistant', content: 'done' }),
    ]);
    expect(out[0]?.steps?.[0]?.result).toHaveLength(400);
  });

  it('新提问清掉未收口的步骤，不跨轮污染', () => {
    const out = foldToolRounds([
      row({ role: 'assistant', content: '', tool_calls: calls(['c1', 'search_web', '{}']) }), // 悬空
      row({ role: 'user', content: '下一个问题' }),
      row({ role: 'assistant', content: '回答' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toBe('下一个问题');
    expect(out[1]?.steps).toBeUndefined();
  });

  it('时间戳与角色原样透传', () => {
    const out = foldToolRounds([row({ role: 'user', content: 'hi', created_at: '2026-09-12 03:11:22' })]);
    expect(out[0]).toEqual({ role: 'user', content: 'hi', ts: '2026-09-12 03:11:22' });
  });

  // —— v11：思考链与任务清单随消息落库，重开会话要能一起回放 ——

  it('reasoning/tasks 列折到那条正文消息上（与 steps 并存）', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: '帮我做个计划' }),
      row({ role: 'assistant', content: '', tool_calls: calls(['t1', 'update_tasks', '{"tasks":[]}']) }),
      row({ role: 'tool', content: '任务清单已更新：共 2 项', tool_call_id: 't1' }),
      row({
        role: 'assistant',
        content: '按这三步做…',
        reasoning: '先拆解需求，再排顺序。',
        tasks: JSON.stringify([
          { text: '拆解需求', status: 'done' },
          { text: '排顺序', status: 'pending' },
        ]),
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]?.content).toBe('按这三步做…');
    expect(out[1]?.reasoning).toBe('先拆解需求，再排顺序。');
    expect(out[1]?.tasks).toEqual([
      { text: '拆解需求', status: 'done' },
      { text: '排顺序', status: 'pending' },
    ]);
    expect(out[1]?.steps?.[0]?.tool).toBe('update_tasks');
  });

  it('纯思考轮（无工具、无清单）只带 reasoning 也算过程', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: '为什么' }),
      row({ role: 'assistant', content: '因为…', reasoning: '让我先想想前因后果。' }),
    ]);
    expect(out[1]?.reasoning).toBe('让我先想想前因后果。');
    expect(out[1]?.tasks).toBeUndefined();
    expect(out[1]?.steps).toBeUndefined();
  });

  it('reasoning 为空串 / tasks 为空数组或坏 JSON → 一律不挂（不留空壳键）', () => {
    const out = foldToolRounds([
      row({ role: 'assistant', content: 'a', reasoning: '' }),
      row({ role: 'assistant', content: 'b', tasks: '[]' }),
      row({ role: 'assistant', content: 'c', tasks: 'not json' }),
      row({ role: 'assistant', content: 'd', reasoning: null, tasks: null }),
    ]);
    expect(out.map((m) => m.reasoning)).toEqual([undefined, undefined, undefined, undefined]);
    expect(out.map((m) => m.tasks)).toEqual([undefined, undefined, undefined, undefined]);
  });

  // —— P1（v32 两列）：实测耗时随行回放，刷新/切会话后卡片数字不变 ——

  it('thinking_ms / duration_ms 还原到消息与工具卡（与流式期 done/终态帧同源）', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: 'q' }),
      row({ role: 'assistant', content: '', tool_calls: calls(['c1', 'search_web', '{}']) }),
      row({ role: 'tool', content: 'R', tool_call_id: 'c1', duration_ms: 4200 }),
      row({ role: 'assistant', content: 'a', reasoning: '想了想', thinking_ms: 7300 }),
    ]);
    expect(out[1]?.thinkingMs).toBe(7300);
    expect(out[1]?.steps?.[0]?.durationMs).toBe(4200);
  });

  it('老行没有实测值（NULL）→ 不挂空壳键：缺就是缺，退「无时长」而不是 0 秒', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: 'q' }),
      row({ role: 'assistant', content: '', tool_calls: calls(['c1', 'search_web', '{}']) }),
      row({ role: 'tool', content: 'R', tool_call_id: 'c1', duration_ms: null }),
      row({ role: 'assistant', content: 'a', thinking_ms: null }),
    ]);
    expect('thinkingMs' in (out[1] ?? {})).toBe(false);
    expect(out[1]?.steps?.[0]?.durationMs).toBeUndefined();
  });

  it('0 毫秒如实回放（与 NULL 可分辨）：真测出 0 就存 0 就显示，不伪装成缺失', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: 'q' }),
      row({ role: 'assistant', content: '', tool_calls: calls(['c1', 'tidy_terms', '{}']) }),
      row({ role: 'tool', content: 'R', tool_call_id: 'c1', duration_ms: 0 }),
      row({ role: 'assistant', content: 'a', thinking_ms: 0 }),
    ]);
    expect(out[1]?.thinkingMs).toBe(0);
    expect(out[1]?.steps?.[0]?.durationMs).toBe(0);
  });
});

/**
 * `[QUIZ]` 登记行的还原（2026-09-23「出题工具化」批：聊天模型自己能出题之后，
 * 会话里出现题卡成了常态，这一坨 JSON 再原样上屏就是对外可见的残骸）。
 * ★ 下面的行序是**服务端真实行序**，不是我想当然：出卡发生在工具执行中
 *   （`learning/quiz-announce.ts` 直接 INSERT），而工具轮与正文行要等本轮收口才由
 *   `chat/persist.ts#persistRounds` 一次性写入 ⇒ `[QUIZ]` 行的 rowid **在前**。
 *   代价见 `docs/TOOL-ECOSYSTEM-SPEC.md` §5.4：重开会话时卡片排在「我出了 5 道题」那句前面。
 */
describe('foldToolRounds — [QUIZ] 登记行还原成题卡', () => {
  const QUIZ_ROW =
    '[QUIZ]{"title":"词根 spect","questions":[{"type":"single","question":"aspect 本义？","options":["外表","旁观"],"answer":[1]}],"quizId":"q-77"}[/QUIZ]';

  it('真实行序（卡片行在工具轮之前）：卡片独立成一条，步骤仍归最后那条正文', () => {
    const out = foldToolRounds([
      row({ role: 'user', content: '考我几个词根' }),
      row({ role: 'assistant', content: QUIZ_ROW }),
      row({ role: 'assistant', content: '', tool_calls: calls(['c1', 'generate_quiz', '{"topic":"词根 spect"}']) }),
      row({ role: 'tool', content: '已出题 1 道…', tool_call_id: 'c1' }),
      row({ role: 'assistant', content: '给你出了 1 道题，点在卡片上作答' }),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    const card = out[1];
    expect(card?.quizBlock?.quizId).toBe('q-77');
    expect(card?.content).toBe('');
    // 卡片行当时没有待收口的步骤 ⇒ 步骤自然留在后面那条正文上（`MessageRow` 见到 quizBlock 就
    // 早退，挂在卡片行上的步骤是渲染不出来的——这条与本批行序结论一起锁住）
    expect(card?.steps).toBeUndefined();
    expect(out[2]?.steps?.map((s) => s.tool)).toEqual(['generate_quiz']);
    // JSON 残骸不许以任何形式出现在正文里
    expect(out.every((m) => !m.content.includes('[QUIZ]'))).toBe(true);
  });

  it('老行没有 quizId ⇒ 照样还原成卡（只是答了不记账），不回落成一坨 JSON', () => {
    const out = foldToolRounds([row({ role: 'assistant', content: QUIZ_ROW.replace(/,"quizId":"q-77"/, '') })]);
    expect(out[0]?.quizBlock?.quiz.questions).toHaveLength(1);
    expect(out[0]?.quizBlock?.quizId).toBeUndefined();
  });

  it('[QUIZ] 标记在但 JSON 坏了 ⇒ 原样当普通文本回放（内容一个字不丢，比开一张空卡诚实）', () => {
    const broken = '[QUIZ]{"title":"半截","questions":[{"type":"single"}';
    const out = foldToolRounds([row({ role: 'assistant', content: broken })]);
    expect(out[0]?.quizBlock).toBeUndefined();
    expect(out[0]?.content).toBe(broken);
  });

  it('卡片行把前面悬空的步骤收走时不串到下一条正文（跨轮污染防护同 user 行口径）', () => {
    // 现实中不发生（见上面的行序说明）；这里锁的是「卡片行 = 一次归属收口」这条规则本身，
    // 免得哪天出卡时机挪到工具轮之后就静默双挂
    const out = foldToolRounds([
      row({ role: 'user', content: 'q' }),
      row({ role: 'assistant', content: '', tool_calls: calls(['c1', 'generate_quiz', '{}']) }),
      row({ role: 'tool', content: '已出题…', tool_call_id: 'c1' }),
      row({ role: 'assistant', content: QUIZ_ROW }),
      row({ role: 'assistant', content: '做完了告诉我' }),
    ]);
    expect(out[1]?.quizBlock?.quizId).toBe('q-77');
    expect(out[2]?.steps).toBeUndefined();
  });
});
