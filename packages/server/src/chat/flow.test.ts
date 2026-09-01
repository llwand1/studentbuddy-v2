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

const { getDb, closeDb } = await import('../storage/db.js');
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
  termsStub.relevant = [];
  termsStub.queries = [];
  termsStub.extractRejects = false;
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
    // 注入后的消息里应有第二条 system（基础提示 + 词条提示），词条行逐字正确
    const sys = stub.lastMessages.filter((m) => m.role === 'system');
    expect(sys).toHaveLength(2);
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
});

afterEach(() => closeDb());
