/**
 * chat/flow 单轨工具循环回归（M1 收尾）：
 * ① 工具轮与最终回答一并原子落库且顺序为 assistant(tool_calls)→tool→assistant；
 * ② 中途失败不留孤儿 tool 消息（v1 语义）；
 * ③ 达轮次上限时收尾消息仍是 assistant；
 * ④ step 事件三态进 SSE 缓冲。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TokenChunk } from '../llm/types.js';
import type { TidySummary } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-flow-test-'));
delete process.env.EXA_API_KEY;
delete process.env.TAVILY_API_KEY;
delete process.env.ZHIPU_API_KEY;

const stub = vi.hoisted(() => ({
  turns: [] as Array<TokenChunk[] | Error>,
  idx: 0,
  searchFail: null as string | null,
  searchSnippet: 'F=ma',
  /** 最近一次 chat() 收到的 messages（断言词条注入进了上下文） */
  lastMessages: [] as Array<{ role: string; content: string }>,
}));

vi.mock('../llm/router.js', () => ({
  routeRole: () => ({
    model: 'test-model',
    apiKey: 'k',
    baseUrl: 'http://127.0.0.1:1/v1',
    adapter: {
      type: 'openai' as const,
      async *chat(args: { messages: Array<{ role: string; content: string }> }) {
        stub.lastMessages = args.messages;
        const turn = stub.turns[stub.idx++];
        if (turn instanceof Error) throw turn;
        for (const chunk of turn ?? []) yield chunk;
      },
      async listModels() {
        return [];
      },
    },
  }),
}));

vi.mock('../search/index.js', () => ({
  searchWeb: async () =>
    stub.searchFail
      ? { results: [], providers: [], failed: [stub.searchFail] }
      : {
          results: [{ title: '牛顿第二定律', url: 'https://example.com/newton', snippet: stub.searchSnippet, source: 'exa' }],
          providers: ['exa'],
          failed: [],
        },
  resultsToContext: (rs: Array<{ title: string; url: string; snippet: string }>) =>
    rs.map((r) => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n'),
  KEYED_PROVIDERS: ['exa', 'tavily', 'zhipu'] as const,
  listKeyStatus: () => ({ exa: false, tavily: false, zhipu: false }),
  saveProviderKey: () => undefined,
  getProviderKey: () => '',
}));

// 忆域 v2（词条库）mock：受控返回「命中词条」/「抽取失败」，隔离 flow 注入路径断言
const termsStub = vi.hoisted(() => ({
  relevant: [] as Array<{ term: string; definition: string; domain: string }>,
  queries: [] as Array<[string, number]>,
  extractRejects: false,
}));

vi.mock('../learning/terms.js', () => ({
  getRelevantTerms: (q: string, limit: number) => {
    termsStub.queries.push([q, limit]);
    return termsStub.relevant;
  },
  saveTerms: () => 0,
  extractTerms: async () => {
    if (termsStub.extractRejects) throw new Error('抽取服务不可用');
    return [];
  },
  countUsage: () => 0,
}));

// 文档模式 mock：资料段是否存在由测例控制，隔离 flow 的注入与预算路径
// queries 记录 flow 传进来的检索查询词：长文档靠它才能检索，漏传就只能整篇直塞（契约 DOC-RAG-SPEC T7）
const documentStub = vi.hoisted(() => ({
  doc: null as null | { name: string; text: string; chars: number; truncated: boolean },
  queries: [] as string[],
}));

vi.mock('../learning/document.js', () => ({
  MAX_DOC_CHARS: 60_000,
  getSessionDoc: () => documentStub.doc,
  buildDocBlock: (d: { name: string; text: string }, query = '') => {
    documentStub.queries.push(query);
    return `【资料 ${d.name}】${d.text}`;
  },
}));

// 词条整理 mock：flow 测的是工具接线（tool_calls → 执行 → 摘要回灌 → step），引擎语义由 tidy.test.ts 锁
const tidyStub = vi.hoisted(() => ({
  calls: [] as string[],
  summary: {
    result: 'ok',
    before: 5,
    after: 3,
    mergedClusters: [{ canonical: '机器学习', aliases: ['machine learning'], reason: '中英互译' }],
    domainRenames: { 计算机: 'cs' },
  } as TidySummary,
}));

vi.mock('../learning/tidy.js', () => ({
  tidyTerms: async (): Promise<TidySummary> => {
    tidyStub.calls.push('auto');
    return tidyStub.summary;
  },
  mergeTerms: (terms: string[]): TidySummary => {
    tidyStub.calls.push(`merge:${terms.join(',')}`);
    return tidyStub.summary;
  },
  renameDomain: (from: string, to: string): TidySummary => {
    tidyStub.calls.push(`rename:${from}>${to}`);
    return tidyStub.summary;
  },
}));

const { getDb, closeDb } = await import('../storage/db.js');
const { saveAnswerStyle, resetAnswerStyle } = await import('../storage/answer-style.js');
const { handleMessage } = await import('./flow.js');
const { snapshot } = await import('./sse-bus.js');

function newSession(): string {
  const id = `s-${Math.random().toString(36).slice(2)}`;
  getDb().prepare(`INSERT INTO sessions (id) VALUES (?)`).run(id);
  return id;
}

function rows(sessionId: string) {
  return getDb()
    .prepare(`SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY created_at, rowid`)
    .all(sessionId) as Array<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>;
}

/** 屏上真正出现过的文本（token 事件按序拼接）——用于钉死「流什么就存什么」 */
function streamed(sessionId: string): string {
  return snapshot(sessionId)
    .filter((e) => e.type === 'token')
    .map((e) => (e.type === 'token' ? e.content : ''))
    .join('');
}

const toolCallTurn = (text: string): TokenChunk[] => [
  { content: text, done: false, toolCalls: [{ id: 'c1', name: 'search_web', arguments: '{"query":"牛顿第二定律"}' }] },
];

beforeEach(() => {
  stub.turns = [];
  stub.idx = 0;
  stub.searchFail = null;
  stub.searchSnippet = 'F=ma';
  stub.lastMessages = [];
  resetAnswerStyle(); // 偏好落 app_settings，不清就会流到下一个测例
  termsStub.relevant = [];
  termsStub.queries = [];
  termsStub.extractRejects = false;
  documentStub.doc = null;
  documentStub.queries = [];
  tidyStub.calls = [];
  getDb().prepare('DELETE FROM messages').run();
  getDb().prepare('DELETE FROM sessions').run();
});

describe('单轨工具循环', () => {
  it('工具轮 + 最终回答按 assistant→tool→assistant 顺序原子落库', async () => {
    const sid = newSession();
    stub.turns = [toolCallTurn('我先查一下'), [{ content: '答案正文', done: false }, { content: '', done: true }]];

    const r = await handleMessage({ sessionId: sid, text: '什么是牛顿第二定律' });
    expect(r.ok).toBe(true);

    const list = rows(sid);
    expect(list.map((x) => x.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(list[1]?.content).toBe('');
    expect(JSON.parse(list[1]?.tool_calls ?? '[]')).toHaveLength(1);
    expect(list[2]?.tool_call_id).toBe('c1');
    expect(list[2]?.content).toContain('https://example.com/newton');
    // 过程语与最终正文都保留在同一条 assistant 消息里（流什么就存什么）
    expect(list[3]?.content).toBe('我先查一下\n\n答案正文');
    expect(streamed(sid)).toBe(list[3]?.content);
    expect(getDb().prepare('SELECT COUNT(*) c FROM token_usage').get()).toEqual({ c: 1 });
  });

  it('step 事件三态进缓冲（联网搜索溯源可见）', async () => {
    const sid = newSession();
    stub.turns = [toolCallTurn(''), [{ content: '答', done: true }]];
    await handleMessage({ sessionId: sid, text: 'q' });

    const steps = snapshot(sid).filter((e) => e.type === 'step');
    expect(steps.map((s) => s.type === 'step' && s.status)).toEqual(['running', 'done']);
    expect(steps.some((s) => s.type === 'step' && (s.detail ?? '').includes('1 条结果'))).toBe(true);
  });

  it('工具轮之后生成失败 → 已上屏的字带中断标记落库，工具轮仍不落（无孤儿）', async () => {
    const sid = newSession();
    stub.turns = [toolCallTurn('我先查一下'), new Error('上游 500')];

    const r = await handleMessage({ sessionId: sid, text: 'q' });
    expect(r.ok).toBe(false);

    const list = rows(sid);
    expect(list.map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(list[1]?.content).toBe('我先查一下\n\n（生成中断）');
    expect(streamed(sid)).toBe(list[1]?.content); // 刷新后看到的与当时看到的完全一致
    expect(list.filter((x) => x.tool_calls || x.role === 'tool')).toHaveLength(0);

    const evs = snapshot(sid);
    expect(evs.at(-1)?.type).toBe('done'); // 死流也必须收口，否则切回会话重放半截
    expect(evs.some((e) => e.type === 'chat-error')).toBe(true);
  });

  it('达轮次上限 → 已执行工具轮仍落库，收尾仍是 assistant 正文', async () => {
    const sid = newSession();
    stub.turns = Array.from({ length: 12 }, () => toolCallTurn(''));

    const r = await handleMessage({ sessionId: sid, text: 'q' });
    expect(r.ok).toBe(true);

    const list = rows(sid);
    expect(list.at(-1)?.role).toBe('assistant');
    expect(list.at(-1)?.content).toContain('工具调用已达上限');
    expect(streamed(sid)).toBe(list.at(-1)?.content); // 上限提示同样上屏
    expect(list.filter((x) => x.tool_calls).length).toBe(8);
    expect(list.filter((x) => x.role === 'tool').length).toBe(8);
  });

  it('工具回灌逼近预算 → 提前收口并提示「上下文预算已满」（而非轮次上限）', async () => {
    const sid = newSession();
    stub.searchSnippet = '中'.repeat(20_000); // 单轮 3 个工具结果 ≈ 3×14k tokens，三轮回灌 ≈126k > 预算
    const multiCallTurn = (): TokenChunk[] => [
      {
        content: '',
        done: false,
        toolCalls: [
          { id: 'a', name: 'search_web', arguments: '{"query":"x"}' },
          { id: 'b', name: 'search_web', arguments: '{"query":"y"}' },
          { id: 'c', name: 'search_web', arguments: '{"query":"z"}' },
        ],
      },
    ];
    stub.turns = [multiCallTurn(), multiCallTurn(), multiCallTurn(), multiCallTurn(), multiCallTurn(), multiCallTurn()];

    const r = await handleMessage({ sessionId: sid, text: 'q' });
    expect(r.ok).toBe(true);

    const list = rows(sid);
    expect(list.at(-1)?.role).toBe('assistant');
    expect(list.at(-1)?.content).toContain('上下文预算已满');
    expect(list.at(-1)?.content).not.toContain('工具调用已达上限');
    // 预算在第 3 轮回灌后触发：已执行 3 轮（3 组 tool_calls + 9 条 tool 结果），未等到轮次上限
    expect(list.filter((x) => x.tool_calls).length).toBe(3);
    expect(list.filter((x) => x.role === 'tool').length).toBe(9);
  });

  it('无 key 且搜索失败 → 工具结果回灌明确引导（去设置页配搜索 key）', async () => {
    const sid = newSession();
    stub.searchFail = 'lite: 超时; instant: 超时';
    stub.turns = [toolCallTurn(''), [{ content: '基于已有知识回答。', done: true }]];

    const r = await handleMessage({ sessionId: sid, text: 'q' });
    expect(r.ok).toBe(true);

    const list = rows(sid);
    const toolMsg = list.find((x) => x.role === 'tool');
    expect(toolMsg?.content).toContain('未配置搜索 key');
    expect(toolMsg?.content).toContain('智谱');
    expect(toolMsg?.content).toContain('lite: 超时');
  });

  it('忆域 v2：命中词条以第二条 system 消息注入上下文（不污染正文）', async () => {
    const sid = newSession();
    termsStub.relevant = [
      { term: 'closure', definition: '闭包：函数与其词法作用域的绑定', domain: 'cs' },
      { term: 'scope', definition: '作用域：变量可被访问的范围', domain: 'cs' },
    ];
    stub.turns = [[{ content: '闭包（closure）是函数与其词法作用域的绑定。', done: false }, { content: '', done: true }]];

    const r = await handleMessage({ sessionId: sid, text: '什么是闭包 closure？' });
    expect(r.ok).toBe(true);

    // 检索参数正确（query + 默认 Top-15）
    expect(termsStub.queries).toEqual([['什么是闭包 closure？', 15]]);
    // 注入后的消息里应有第二条 system（基础提示 + 词条提示），词条行逐字正确（偏好段恒在其后）
    const sys = stub.lastMessages.filter((m) => m.role === 'system');
    expect(sys).toHaveLength(3); // 基础提示 + 词条段 + 偏好段（偏好段恒在最后，不挤掉前两段）
    expect(sys[1]?.content).toContain('优先使用这些术语');
    expect(sys[1]?.content).toContain('- closure（cs）：闭包：函数与其词法作用域的绑定');
    expect(sys[1]?.content).toContain('- scope（cs）：作用域：变量可被访问的范围');
    // 注入只进上下文，屏上与库内正文都不含词条提示
    expect(streamed(sid)).toBe('闭包（closure）是函数与其词法作用域的绑定。');
    const list = rows(sid);
    expect(list.at(-1)?.content).toBe('闭包（closure）是函数与其词法作用域的绑定。');
  });

  it('忆域 v2：自动抽取失败（fire-and-forget）不打断对话主流程', async () => {
    const sid = newSession();
    termsStub.extractRejects = true;
    stub.turns = [[{ content: '正常回答。', done: true }]];

    const r = await handleMessage({ sessionId: sid, text: 'q' });
    expect(r.ok).toBe(true);

    const list = rows(sid);
    expect(list.at(-1)?.content).toBe('正常回答。');
    expect(streamed(sid)).toBe('正常回答。');
  });

  it('词条库整理：tidy_terms auto 全链路（tool_calls → 执行 → 摘要回灌 → step 三态）', async () => {
    const sid = newSession();
    stub.turns = [
      [
        {
          content: '我来整理一下',
          done: false,
          toolCalls: [{ id: 't1', name: 'tidy_terms', arguments: '{"action":"auto"}' }],
        },
      ],
      [{ content: '整理好了。', done: true }],
    ];

    const r = await handleMessage({ sessionId: sid, text: '帮我整理一下词条库' });
    expect(r.ok).toBe(true);
    expect(tidyStub.calls).toEqual(['auto']);

    const list = rows(sid);
    expect(list.map((x) => x.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const toolMsg = list.find((x) => x.role === 'tool');
    expect(toolMsg?.content).toContain('机器学习'); // 整理摘要回灌给模型
    expect(toolMsg?.content).toContain('自然语言'); // 汇报口径指令随行（不让模型甩原始 JSON）
    const steps = snapshot(sid).filter((e) => e.type === 'step');
    expect(
      steps.some((s) => s.type === 'step' && s.tool === 'tidy_terms' && s.status === 'running' && (s.detail ?? '').includes('整理')),
    ).toBe(true);
    expect(steps.some((s) => s.type === 'step' && s.tool === 'tidy_terms' && s.status === 'done')).toBe(true);
  });

  it('词条库整理：merge 参数不全 → 引导重调（不崩、step error）', async () => {
    const sid = newSession();
    stub.turns = [
      [
        {
          content: '',
          done: false,
          toolCalls: [{ id: 't2', name: 'tidy_terms', arguments: '{"action":"merge","terms":["闭包"]}' }],
        },
      ],
      [{ content: '好的。', done: true }],
    ];

    const r = await handleMessage({ sessionId: sid, text: '把闭包合并一下' });
    expect(r.ok).toBe(true);
    expect(tidyStub.calls).toHaveLength(0); // 参数没过关，引擎没被调用
    const toolMsg = rows(sid).find((x) => x.role === 'tool');
    expect(toolMsg?.content).toContain('至少两个词条名');
    const steps = snapshot(sid).filter((e) => e.type === 'step');
    expect(steps.some((s) => s.type === 'step' && s.tool === 'tidy_terms' && s.status === 'error')).toBe(true);
  });
});

describe('文档模式注入（契约 5.0 §5.1-2/3）', () => {
  const docOf = (chars: number) => ({ name: '讲义.md', text: '资'.repeat(chars), chars, truncated: false });

  it('载入资料后以第三条 system 注入资料段，且只进上下文不外泄', async () => {
    const sid = newSession();
    documentStub.doc = docOf(120);
    termsStub.relevant = [{ term: '加速度', definition: '速度的变化率', domain: 'physics' }];
    stub.turns = [[{ content: '按资料作答。', done: true }]];

    const r = await handleMessage({ sessionId: sid, text: '这一节讲什么' });
    expect(r.ok).toBe(true);

    const sys = stub.lastMessages.filter((m) => m.role === 'system');
    expect(sys).toHaveLength(4); // 基础提示 + 词条段 + 资料段 + 偏好段
    expect(sys[2]?.content).toContain('【资料 讲义.md】'); // 资料段仍在第三位，偏好段固定收尾
    // 注入只进上下文：屏上与库内正文都不该出现资料段
    expect(streamed(sid)).toBe('按资料作答。');
    expect(rows(sid).at(-1)?.content).toBe('按资料作答。');
  });

  it('清除资料后下一轮出站 messages 不再含资料段（验收③）', async () => {
    const sid = newSession();
    documentStub.doc = docOf(50);
    stub.turns = [[{ content: '一', done: true }], [{ content: '二', done: true }]];

    await handleMessage({ sessionId: sid, text: '第一问' });
    expect(stub.lastMessages.some((m) => m.content.includes('【资料'))).toBe(true);

    documentStub.doc = null;
    await handleMessage({ sessionId: sid, text: '第二问' });
    expect(stub.lastMessages.some((m) => m.content.includes('【资料'))).toBe(false);
    expect(stub.lastMessages.filter((m) => m.role === 'system')).toHaveLength(2); // 基础 + 偏好（资料段已清）
  });

  it('资料段计入截断预算：载入 4 万字资料后被载历史明变少', async () => {
    const sid = newSession();
    const seed = (n: number) => {
      for (let i = 0; i < n; i++) {
        getDb()
          .prepare(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`)
          .run(`h-${i}`, sid, i % 2 === 0 ? 'user' : 'assistant', '字'.repeat(5000));
      }
    };
    const historyCount = () => stub.lastMessages.filter((m) => m.role !== 'system').length;
    stub.turns = [[{ content: 'ok', done: true }], [{ content: 'ok', done: true }]];

    seed(20);
    await handleMessage({ sessionId: sid, text: 'q' });
    const withoutDoc = historyCount();

    // 重播种：上一轮落库的新消息会让历史长度漂
    getDb().prepare('DELETE FROM messages').run();
    seed(20);
    documentStub.doc = docOf(40_000);
    await handleMessage({ sessionId: sid, text: 'q' });
    const withDoc = historyCount();

    expect(withoutDoc).toBe(21); // 20 条历史 + 本轮新问题全数保留
    expect(withDoc).toBeLessThanOrEqual(withoutDoc - 3);
  });

  // 契约 DOC-RAG-SPEC §6 T7：长文档分支的检索词来自本轮提问，flow 漏传则文档模式退化回直塞
  it('本轮提问会作为检索词传给 buildDocBlock', async () => {
    const sid = newSession();
    documentStub.doc = docOf(80_000);
    stub.turns = [[{ content: '答。', done: true }]];

    await handleMessage({ sessionId: sid, text: '半衰期受不受温度影响' });

    expect(documentStub.queries.length).toBeGreaterThan(0); // 一调都没调 = 资料段根本没注入
    for (const q of documentStub.queries) expect(q).toBe('半衰期受不受温度影响');
  });
});

describe('回答方式偏好注入（契约 ANSWER-STYLE §3）', () => {
  const sysNow = () => stub.lastMessages.filter((m) => m.role === 'system');

  it('未配置也注入一段默认偏好，且排在所有注入段的最后', async () => {
    const sid = newSession();
    termsStub.relevant = [{ term: '加速度', definition: '速度的变化率', domain: 'physics' }];
    stub.turns = [[{ content: '答。', done: true }]];

    await handleMessage({ sessionId: sid, text: '什么是加速度' });
    const sys = sysNow();
    expect(sys).toHaveLength(3); // 基础 + 词条 + 偏好
    expect(sys[1]?.content).toContain('优先使用这些术语');
    expect(sys.at(-1)?.content).toContain('结论先行'); // 默认 verbosity=standard
    expect(sys.at(-1)?.content).toContain('讲人话'); // 默认 tone=teacher，与现状同话
  });

  it('改库内偏好 → 下一轮出站的偏好段随之改变（不改就不算生效）', async () => {
    const sid = newSession();
    saveAnswerStyle({ verbosity: 'brief', shape: 'bullets' });
    stub.turns = [[{ content: '一', done: true }]];

    await handleMessage({ sessionId: sid, text: '第一问' });
    const block = sysNow().at(-1)?.content ?? '';
    expect(block).toContain('两三句内');
    expect(block).toContain('多用短列点');
    expect(block).not.toContain('结论先行'); // 换档后旧措辞必须消失，防两段并存
  });

  it('偏好段只进上下文：屏上与库内正文都不含它', async () => {
    const sid = newSession();
    saveAnswerStyle({ tone: 'socratic' });
    stub.turns = [[{ content: '你先想想看。', done: true }]];

    await handleMessage({ sessionId: sid, text: '讲讲牛顿定律' });
    expect(streamed(sid)).toBe('你先想想看。');
    expect(rows(sid).at(-1)?.content).toBe('你先想想看。');
    expect(sysNow().at(-1)?.content).toContain('先反问一两个关键问题');
  });

  it('恢复默认（删键）后回到默认偏好段', async () => {
    const sid = newSession();
    saveAnswerStyle({ verbosity: 'detailed' });
    resetAnswerStyle();
    stub.turns = [[{ content: 'ok', done: true }]];

    await handleMessage({ sessionId: sid, text: 'q' });
    const block = sysNow().at(-1)?.content ?? '';
    expect(block).toContain('结论先行');
    expect(block).not.toContain('宁长勿短');
  });
});

afterEach(() => closeDb());
