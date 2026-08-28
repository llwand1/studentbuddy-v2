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
}));

vi.mock('../llm/router.js', () => ({
  routeRole: () => ({
    model: 'test-model',
    apiKey: 'k',
    baseUrl: 'http://127.0.0.1:1/v1',
    adapter: {
      type: 'openai' as const,
      async *chat() {
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
  searchWeb: async () => ({
    results: [{ title: '牛顿第二定律', url: 'https://example.com/newton', snippet: 'F=ma', source: 'exa' }],
    providers: ['exa'],
    failed: [],
  }),
  resultsToContext: (rs: Array<{ title: string; url: string }>) => rs.map((r) => `${r.title}\n${r.url}`).join('\n\n'),
  KEYED_PROVIDERS: ['exa', 'tavily', 'zhipu'] as const,
  listKeyStatus: () => ({ exa: false, tavily: false, zhipu: false }),
  saveProviderKey: () => undefined,
  getProviderKey: () => '',
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
});

afterEach(() => closeDb());
