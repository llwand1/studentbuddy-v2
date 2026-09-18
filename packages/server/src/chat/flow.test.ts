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
  /** 本轮全部 chat() 调用（按序）——用于断言「首轮注入、次轮已摘除」这类跨轮变化 */
  allMessages: [] as Array<Array<{ role: string; content: string }>>,
  /** 每次 chat() 收到的 toolChoice（按序）——v18.4 断言「首轮强绑、turn 1 放开」 */
  toolChoices: [] as unknown[],
}));

vi.mock('../llm/router.js', () => ({
  routeRole: (role?: string) => ({
    model: 'test-model',
    apiKey: 'k',
    baseUrl: 'http://127.0.0.1:1/v1',
    adapter: {
      type: 'openai' as const,
      async *chat(args: { messages: Array<{ role: string; content: string }>; toolChoice?: unknown }) {
        // ★ 摘要角色的调用**不进 turn 队列**：长期记忆压缩是收尾后异步触发的（MEMORY-SPEC §4.1），
        //   它与主流程无交互，却会走同一个 routeRole。不分角色的话，压缩会在测例结束前后
        //   偷走下一测例的 `turns[0]`（`idx` 已被 beforeEach 归零）——表现为随机失败，
        //   而根因与被测代码毫无关系。摘要产物由 compact.test.ts 自己锁。
        if (role === 'summarizer') return;
        // ★ 必须存**浅拷贝**：flow 传给适配器的是同一个 messages 数组，并在首轮后
        //   `splice` 摘掉触发增强段。存引用的话 allMessages[0] 会被追溯性改掉，
        //   于是「首轮有 nudge」永远断不出来（实测踩到：断言恒 false，而代码是对的）。
        stub.lastMessages = [...args.messages];
        stub.allMessages.push([...args.messages]);
        stub.toolChoices.push(args.toolChoice);
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
    .prepare(
      `SELECT role, content, tool_calls, tool_call_id, reasoning, tasks FROM messages WHERE session_id = ? ORDER BY created_at, rowid`,
    )
    .all(sessionId) as Array<{
    role: string;
    content: string;
    tool_calls: string | null;
    tool_call_id: string | null;
    reasoning: string | null;
    tasks: string | null;
  }>;
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
  stub.allMessages = [];
  stub.toolChoices = [];
  resetAnswerStyle(); // 偏好落 app_settings，不清就会流到下一个测例
  termsStub.relevant = [];
  termsStub.queries = [];
  termsStub.extractRejects = false;
  documentStub.doc = null;
  documentStub.queries = [];
  tidyStub.calls = [];
  getDb().prepare('DELETE FROM messages').run();
  getDb().prepare('DELETE FROM sessions').run();
  // 画像跨会话存活（这正是第二层的设计目的），故不会随 sessions 一起清——
  // 不显式清就会从上一个测例漏进来，把「六段顺序」这类按条数断言的测例染绿/染红
  getDb().prepare('DELETE FROM user_memory').run();
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

  it('v11：思考链与任务清单随消息落库（重开会话由 history-fold 回放）', async () => {
    const sid = newSession();
    stub.turns = [
      [
        {
          reasoning: '先看看要几步。',
          content: '',
          done: false,
          toolCalls: [{ id: 'q1', name: 'update_tasks', arguments: JSON.stringify({ tasks: [{ text: '查资料', status: 'pending' }] }) }],
        },
      ],
      [{ reasoning: '资料到手，可以作答了。', content: '答案', done: false }, { content: '', done: true }],
    ];

    const r = await handleMessage({ sessionId: sid, text: '做个计划' });
    expect(r.ok).toBe(true);

    const last = rows(sid).at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.content).toBe('答案');
    // 思考跨轮累积（两轮各自发过 reasoning），收口时一次落库
    expect(last?.reasoning).toBe('先看看要几步。资料到手，可以作答了。');
    expect(JSON.parse(last?.tasks ?? '[]')).toEqual([{ text: '查资料', status: 'pending' }]);
    // 中途的工具轮不落 reasoning/tasks（过程只挂在最终回答那一条上）
    expect(rows(sid).filter((x) => x.tool_calls).every((x) => x.reasoning === null && x.tasks === null)).toBe(true);
  });

  it('v11：生成中断也把已攒的思考与清单带上（过程不因失败而丢）', async () => {
    const sid = newSession();
    stub.turns = [
      [
        {
          reasoning: '我打算先列个清单。',
          content: '半截正文',
          done: false,
          toolCalls: [{ id: 'q1', name: 'update_tasks', arguments: JSON.stringify({ tasks: [{ text: '第一步', status: 'pending' }] }) }],
        },
      ],
      new Error('上游 500'),
    ];

    const r = await handleMessage({ sessionId: sid, text: 'q' });
    expect(r.ok).toBe(false);

    const list = rows(sid);
    expect(list.filter((x) => x.tool_calls || x.role === 'tool')).toHaveLength(0); // 仍不留孤儿 tool 消息
    const last = list.at(-1);
    expect(last?.content).toContain('半截正文');
    expect(last?.reasoning).toBe('我打算先列个清单。');
    expect(JSON.parse(last?.tasks ?? '[]')).toEqual([{ text: '第一步', status: 'pending' }]);
  });

  it('update_tasks 增量模式：按序号改 + 追加，服务端下发并落库合并后的完整清单', async () => {
    const sid = newSession();
    const call = (id: string, args: unknown): TokenChunk[] => [
      { content: '', done: false, toolCalls: [{ id, name: 'update_tasks', arguments: JSON.stringify(args) }] },
    ];
    stub.turns = [
      call('q1', { tasks: [{ text: '查资料', status: 'pending' }, { text: '写大纲', status: 'pending' }] }),
      call('q2', { updates: [{ index: 1, status: 'done' }, { index: 2, status: 'in_progress' }, { text: '排版' }] }),
      [{ content: '做完了', done: true }],
    ];

    const r = await handleMessage({ sessionId: sid, text: '帮我做' });
    expect(r.ok).toBe(true);

    const merged = [
      { text: '查资料', status: 'done' },
      { text: '写大纲', status: 'in_progress' },
      { text: '排版', status: 'pending' },
    ];
    // 事件恒为完整清单（前端整表替换，不做本地合并）
    const evs = snapshot(sid).filter((e) => e.type === 'tasks');
    expect(evs).toHaveLength(2);
    expect(evs.at(-1)?.items).toEqual(merged);
    // 落库的也是合并结果，不是最后那次的增量片段
    expect(JSON.parse(rows(sid).at(-1)?.tasks ?? '[]')).toEqual(merged);
    // 回灌带序号：模型下一次 patch 才知道第二条是哪条（两次调用各回灌一次，取最后那次）
    const toolRows = rows(sid).filter((x) => x.role === 'tool' && x.content.includes('任务清单已更新'));
    expect(toolRows).toHaveLength(2);
    expect(toolRows.at(-1)?.content).toContain('2. [>] 写大纲');
  });

  it('update_tasks 增量序号越界：整批不生效（清单保持原样），回灌附当前清单供自纠', async () => {
    const sid = newSession();
    const call = (id: string, args: unknown): TokenChunk[] => [
      { content: '', done: false, toolCalls: [{ id, name: 'update_tasks', arguments: JSON.stringify(args) }] },
    ];
    stub.turns = [
      call('q1', { tasks: [{ text: '查资料', status: 'pending' }, { text: '写大纲', status: 'pending' }] }),
      call('q2', { updates: [{ index: 1, status: 'done' }, { index: 9, status: 'done' }] }),
      [{ content: '好', done: true }],
    ];

    const r = await handleMessage({ sessionId: sid, text: 'q' });
    expect(r.ok).toBe(true);

    // 越界的那批一条也不生效：只有首次的 tasks 事件，没有第二个
    const evs = snapshot(sid).filter((e) => e.type === 'tasks');
    expect(evs).toHaveLength(1);
    expect(evs[0]?.items).toEqual([
      { text: '查资料', status: 'pending' },
      { text: '写大纲', status: 'pending' },
    ]);
    expect(JSON.parse(rows(sid).at(-1)?.tasks ?? '[]')).toEqual([
      { text: '查资料', status: 'pending' },
      { text: '写大纲', status: 'pending' },
    ]);
    // 回灌说明越界原因 + 当前清单（含序号），模型据此改对
    const bad = rows(sid).find((x) => x.role === 'tool' && x.content.includes('超出范围'));
    expect(bad?.content).toContain('1. [ ] 查资料');
  });

  it('达轮次上限 → 已执行工具轮仍落库，收尾仍是 assistant 正文', async () => {
    const sid = newSession();
    // 造的比上限多一轮：上限 15（flow.ts MAX_TOOL_TURNS），16 个工具轮才能撞到它
    stub.turns = Array.from({ length: 16 }, () => toolCallTurn(''));

    const r = await handleMessage({ sessionId: sid, text: 'q' });
    expect(r.ok).toBe(true);

    const list = rows(sid);
    expect(list.at(-1)?.role).toBe('assistant');
    expect(list.at(-1)?.content).toContain('工具调用已达上限');
    expect(streamed(sid)).toBe(list.at(-1)?.content); // 上限提示同样上屏
    expect(list.filter((x) => x.tool_calls).length).toBe(15); // = flow.ts MAX_TOOL_TURNS（8 → 15）
    expect(list.filter((x) => x.role === 'tool').length).toBe(15);
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

  it('搜索失败 → 回灌「你有这能力、只是这次没命中」（不泄漏内部配置、不给放弃台阶）', async () => {
    const sid = newSession();
    stub.searchFail = 'lite: 超时; instant: 超时';
    stub.turns = [toolCallTurn(''), [{ content: '这次没搜到。', done: true }]];

    const r = await handleMessage({ sessionId: sid, text: 'q' });
    expect(r.ok).toBe(true);

    const list = rows(sid);
    const toolMsg = list.find((x) => x.role === 'tool');
    // 2026-09-17 重写口径（bug-ledger B-006）：旧文案把「未配置搜索 key（免 key 兜底）/
    // 本网络可能不可达」这类**内部配置细节**甩给模型，模型转述出来就成了"我没有联网功能"
    // ——故这里对旧表述做**反向断言**，防它改回来。
    expect(toolMsg?.content).toContain('本次联网检索没有返回结果');
    expect(toolMsg?.content).toContain('具备');
    expect(toolMsg?.content).toContain('不要说自己没有联网能力');
    expect(toolMsg?.content).not.toContain('未配置搜索 key');
    expect(toolMsg?.content).not.toContain('智谱');
    // 检索通道的失败原因仍如实回灌（模型据此判断要不要换词重试）
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
    expect(sys).toHaveLength(4); // 基础提示 + 日期段 + 词条段 + 偏好段（偏好段恒在最后）
    expect(sys[2]?.content).toContain('优先使用这些术语');
    expect(sys[2]?.content).toContain('- closure（cs）：闭包：函数与其词法作用域的绑定');
    expect(sys[2]?.content).toContain('- scope（cs）：作用域：变量可被访问的范围');
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
    expect(sys).toHaveLength(5); // 基础提示 + 日期段 + 词条段 + 资料段 + 偏好段
    expect(sys[3]?.content).toContain('【资料 讲义.md】'); // 资料段仍在词条段之后，偏好段固定收尾
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
    expect(stub.lastMessages.filter((m) => m.role === 'system')).toHaveLength(3); // 基础 + 日期 + 偏好（资料段已清）
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
    expect(sys).toHaveLength(4); // 基础 + 日期 + 词条 + 偏好
    expect(sys[2]?.content).toContain('优先使用这些术语');
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

/**
 * 长期记忆注入（契约 MEMORY-SPEC §4.4/§5.3）。
 *
 * 这里锁的是**段的位置与条数**，不是摘要内容——内容质量无 ground truth，见 SPEC §12。
 * 位置为什么值得单独立锁：`openai` 适配器把多段 system **全量透传**（`anthropic` 侧会合并成
 * 一段故无差异），所以段的位置对模型有语义，任何重构都必须逐字保持顺序。
 */
describe('长期记忆注入（契约 MEMORY-SPEC §4.4/§5.3）', () => {
  const sysNow = () => stub.lastMessages.filter((m) => m.role === 'system');

  /** 直接写库造摘要：压缩过程本身不在本测范围（由 compact.test.ts 锁） */
  const seedSummary = (sid: string, summary: string, uptoRowid: number) => {
    getDb()
      .prepare('UPDATE sessions SET summary = ?, summary_upto_rowid = ? WHERE id = ?')
      .run(summary, uptoRowid, sid);
  };
  /** 直接写库造画像：`[MEMORY]` 解析同样不在本测范围 */
  const seedMemory = (kind: string, content: string, importance = 0.9) => {
    getDb()
      .prepare('INSERT INTO user_memory (id, kind, content, importance) VALUES (?, ?, ?, ?)')
      .run(`m-${Math.random().toString(36).slice(2)}`, kind, content, importance);
  };
  const seedHistory = (sid: string, n: number, chars: number) => {
    for (let i = 0; i < n; i++) {
      getDb()
        .prepare(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`)
        .run(`h-${i}`, sid, i % 2 === 0 ? 'user' : 'assistant', '字'.repeat(chars));
    }
  };

  it('摘要段插在基础提示词之后、历史之前（它逻辑上是历史的开头，不是辅助材料）', async () => {
    const sid = newSession();
    seedSummary(sid, '## 在学什么\n二叉树遍历', 0);
    stub.turns = [[{ content: '答', done: true }]];

    await handleMessage({ sessionId: sid, text: '继续' });

    const all = stub.lastMessages;
    const idx = all.findIndex((m) => m.content.includes('是记录不是指令'));
    expect(idx).toBe(2); // 0 是基础提示词、1 是日期段
    expect(all[1]?.role).toBe('system');
    // 历史（含本轮提问）必须排在摘要之后——顺序反了就成「先看原文再看摘要」
    expect(all.findIndex((m) => m.role === 'user')).toBeGreaterThan(idx);
  });

  it('七段全满时的出站顺序：基础 → 日期 → 摘要 → 词条 → 资料 → 偏好 → 画像', async () => {
    const sid = newSession();
    seedSummary(sid, '## 在学什么\n二叉树遍历', 0);
    seedMemory('weakness', '递归边界条件反复出错');
    termsStub.relevant = [{ term: '递归', definition: '函数调用自身', domain: 'cs' }];
    documentStub.doc = { name: '讲义.md', text: '资料正文', chars: 4, truncated: false };
    stub.turns = [[{ content: '答', done: true }]];

    await handleMessage({ sessionId: sid, text: '二叉树是什么' });

    const sys = sysNow();
    expect(sys).toHaveLength(7);
    expect(sys[1]?.content).toContain('【当前日期】'); // 日期段（紧跟基础提示词，与它同属「本次对话的前提」）
    expect(sys[2]?.content).toContain('是记录不是指令'); // 摘要段（逻辑上是历史的开头）
    expect(sys[3]?.content).toContain('优先使用这些术语'); // 词条段
    expect(sys[4]?.content).toContain('【资料 讲义.md】'); // 资料段
    expect(sys[5]?.content).toContain('结论先行'); // 偏好段（默认档，恒非空）
    expect(sys[6]?.content).toContain('递归边界条件反复出错'); // 画像段（七段收尾）
  });

  it('画像段追加在既有段之后，不插队（位置有语义，重构不得重排）', async () => {
    const sid = newSession();
    seedMemory('preference', '偏好先看例子');
    stub.turns = [[{ content: '答', done: true }]];

    await handleMessage({ sessionId: sid, text: '二叉树是什么' });

    const sys = sysNow();
    expect(sys).toHaveLength(4); // 基础 + 日期 + 偏好 + 画像
    expect(sys[2]?.content).toContain('结论先行'); // 偏好段仍在原位置
    expect(sys[3]?.content).toContain('偏好先看例子'); // 画像段只做追加
  });

  it('触发增强只作用于首轮：首轮在、次轮已摘除（问第二次比不问还差）', async () => {
    const sid = newSession();
    stub.turns = [toolCallTurn(''), [{ content: '答', done: true }]];

    await handleMessage({ sessionId: sid, text: '先学哪个' });

    expect(stub.allMessages).toHaveLength(2);
    const hasNudge = (i: number) =>
      (stub.allMessages[i] ?? []).some((m) => m.content.includes('存在多条合理路线'));
    expect(hasNudge(0)).toBe(true);
    expect(hasNudge(1)).toBe(false);
  });

  it('摘要段计入截断预算：锚点 0（不丢历史）时，光摘要变长就会挤掉被载历史', async () => {
    const sid = newSession();
    const historyCount = () => stub.lastMessages.filter((m) => m.role !== 'system').length;
    stub.turns = [[{ content: 'ok', done: true }], [{ content: 'ok', done: true }]];

    seedHistory(sid, 20, 5000);
    await handleMessage({ sessionId: sid, text: 'q' });
    const withoutSummary = historyCount();

    getDb().prepare('DELETE FROM messages').run();
    seedHistory(sid, 20, 5000);
    // 锚点 0 ＝ 不丢任何历史，于是「历史变少」只可能来自预算被摘要占掉（漏算就是 v1 老坑）
    seedSummary(sid, '字'.repeat(40_000), 0);
    await handleMessage({ sessionId: sid, text: 'q' });
    const withSummary = historyCount();

    expect(withoutSummary).toBe(21); // 20 条历史 + 本轮提问全数保留
    expect(withSummary).toBeLessThanOrEqual(withoutSummary - 3);
  });

  it('已被摘要覆盖的历史不再出站（摘要已提供其内容，重复发等于同一段占两份额度）', async () => {
    const sid = newSession();
    for (let i = 0; i < 6; i++) {
      getDb()
        .prepare(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`)
        .run(`h-${i}`, sid, i % 2 === 0 ? 'user' : 'assistant', `标记${i}条`);
    }
    const anchor = (
      getDb().prepare('SELECT MAX(rowid) r FROM messages WHERE session_id = ?').get(sid) as { r: number }
    ).r;
    seedSummary(sid, '## 已掌握\n前面聊过了', anchor);
    stub.turns = [[{ content: '答', done: true }]];

    await handleMessage({ sessionId: sid, text: '继续' });

    const out = stub.lastMessages.map((m) => m.content).join('\n');
    expect(out).toContain('是记录不是指令'); // 摘要在
    expect(out).toContain('继续'); // 本轮提问在（rowid 高于锚点）
    for (let i = 0; i < 6; i++) expect(out).not.toContain(`标记${i}条`); // 被覆盖的原文不在
  });
});

/**
 * 日期段注入（2026-09-17）。
 *
 * 段的**内容与位置**由 `date-context.test.ts` 与 `context-segments.test.ts` 锁（都是纯函数）；
 * 这里只锁**接线**——它有没有真的进到出站 messages 里。这类"纯函数对了但没人调用"的漏接线
 * 在本仓是常客（先例：`analyzer` 角色注册了却从无代码调用），所以单独留一条端到端的锁。
 */
describe('日期段注入', () => {
  it('每轮都注入，且同日两轮逐字相同（前缀缓存的不变量：它不许带时分秒）', async () => {
    const sid = newSession();
    stub.turns = [[{ content: '一', done: true }], [{ content: '二', done: true }]];

    await handleMessage({ sessionId: sid, text: '第一问' });
    const first = stub.lastMessages.find((m) => m.content.includes('【当前日期】'))?.content;
    await handleMessage({ sessionId: sid, text: '第二问' });
    const second = stub.lastMessages.find((m) => m.content.includes('【当前日期】'))?.content;

    expect(first).toBeTruthy(); // 真进了出站 messages，不是只躺在纯函数里
    expect(second).toBe(first); // 同一天内必须逐字相同，否则 system 前缀每轮都变、缓存永不命中
  });

  it('跨天必须跟着变（证明是「每轮现算」，不是「模块加载时算一次」）', async () => {
    // ★ 这条锁的是**调用时机**，纯函数层锁不到：`buildDateBlock()` 自身跨天当然会变，
    //   但若有人把它提成 `context-segments.ts` 的模块常量（`const DATE = buildDateBlock()`），
    //   `date-context.test.ts` 照样全绿——那段字会**从服务启动那天起永远不变**，
    //   表现是「服务开着不动，第二天问它今天几号还是昨天」。故必须在端到端这一层再锁一次。
    const sid = newSession();
    stub.turns = [[{ content: '一', done: true }], [{ content: '二', done: true }]];
    const dateOf = () => stub.lastMessages.find((m) => m.content.includes('【当前日期】'))?.content ?? '';

    vi.useFakeTimers({ toFake: ['Date'] }); // 只假 Date，不动 setTimeout（不干扰异步流程）
    try {
      vi.setSystemTime(new Date(2026, 8, 17, 23, 59));
      await handleMessage({ sessionId: sid, text: '第一问' });
      const day1 = dateOf();

      vi.setSystemTime(new Date(2026, 8, 18, 0, 1));
      await handleMessage({ sessionId: sid, text: '第二问' });
      const day2 = dateOf();

      expect(day1).toContain('2026年9月17日');
      expect(day2).toContain('2026年9月18日');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * v18.4 联网开关的工程强绑（bug-ledger B-006 的根因修复）。
 *
 * 为什么单独立一组：此前 `online`（UI「联网已开」pill）**压根没进 `/chat/send`**——
 * 开关只是装饰；而即便接上，靠提示词求模型「主动搜」仍不可靠（`search-nudge.ts` 记着这层）。
 * 这组用例钉的是**机器证据**：开关打开时首轮出站请求真的带着 `tool_choice=search_web`，
 * 且只绑首轮、指令出循环即摘。
 */
describe('联网开关的首轮强绑（v18.4）', () => {
  it('online=true → 首轮强绑 search_web，turn 1 起放开', async () => {
    const sid = newSession();
    stub.turns = [toolCallTurn(''), [{ content: '根据检索结果…', done: true }]];

    await handleMessage({ sessionId: sid, text: '牛来是什么', online: true });

    expect(stub.toolChoices).toHaveLength(2);
    expect(stub.toolChoices[0]).toEqual({ type: 'function', name: 'search_web' });
    // turn 1 必须放开：锁死会变成「搜完还要再搜」，正文永远出不来
    expect(stub.toolChoices[1]).toBeUndefined();
  });

  it('online 缺省 → 全程不干预（保持适配器默认的 auto）', async () => {
    const sid = newSession();
    stub.turns = [[{ content: '等于 2', done: true }]];
    await handleMessage({ sessionId: sid, text: '1+1' });
    expect(stub.toolChoices).toEqual([undefined]);
  });

  it('联网硬指令随首轮注入、出循环即摘（留着会让每一轮都重搜）', async () => {
    const sid = newSession();
    stub.turns = [toolCallTurn(''), [{ content: '正文', done: true }]];

    await handleMessage({ sessionId: sid, text: '牛来是什么', online: true });

    const hasForce = (msgs: Array<{ content: string }>) => msgs.some((m) => m.content.includes('已开启联网搜索'));
    expect(hasForce(stub.allMessages[0]!)).toBe(true);
    expect(hasForce(stub.allMessages[1]!)).toBe(false);
  });

  it('grill-me 与联网同开 → 强绑名额归 grill（GRILL_PRE 是硬性表述，冲突更大）', async () => {
    const sid = newSession();
    // 模型这一轮不调 ask_choice：调了会挂起等用户点选（pre 段的挂起语义由 choice.test.ts 锁，此处只验出站参数）
    stub.turns = [[{ content: '正文', done: true }]];

    await handleMessage({ sessionId: sid, text: '讲讲二分查找', grillMe: true, online: true });

    expect(stub.toolChoices[0]).toEqual({ type: 'function', name: 'ask_choice' });
    // 两段指令合成一条开场消息（不拆两条）：位置与用途相同，拆开只多占一次消息开销
    const opening = stub.allMessages[0]!.find((m) => m.content.includes('已开启联网搜索'));
    expect(opening?.content).toContain('第一个动作必须是调用 ask_choice');
  });
});

afterEach(() => closeDb());
