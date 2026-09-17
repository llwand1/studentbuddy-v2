/**
 * chat/compact 单测（openIsolated 隔离库 + 桩掉 llm/router 的 routeRole，不打真网络）。
 *
 * 钉契约核心语义（docs/MEMORY-SPEC.md §4）：切点恒不落在 tool 消息上、
 * 丢弃量不足不触发、**解析失败绝不写库**、[MEMORY] 缺失不算失败、
 * 并发不重复压缩、失败不阻断（ADR-4）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SUMMARY_MAX_CHARS } from '@sb/shared';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import { loadMemoryItems } from './memory.js';
import {
  buildSummaryBlock,
  clearSessionSummary,
  compactIfNeeded,
  findCutIndex,
  loadSessionSummary,
  parseCompactReply,
  serializeForSummary,
} from './compact.js';
import type { HistoryMessage } from './persist.js';

// routeRole 桩：compact 是唯一调用方，桩掉它就不必碰真 provider 与真网络。
// 用 vi.hoisted 拿引用——vi.mock 的工厂会被提升到文件顶部，普通 const 那时还不存在。
const { routeRoleMock } = vi.hoisted(() => ({ routeRoleMock: vi.fn() }));
vi.mock('../llm/router.js', () => ({ routeRole: routeRoleMock }));

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-compact-test-'));

beforeEach(() => {
  openIsolated(dataDir());
  routeRoleMock.mockReset();
});
afterEach(() => closeDb());

/** 假目标：chat 是 async generator，一次吐完整回复。 */
function fakeTarget(reply: string) {
  return {
    adapter: {
      type: 'openai' as const,
      chat: async function* () {
        yield { content: reply, done: true };
      },
      listModels: async () => [],
    },
    model: 'fake-summary-model',
    apiKey: 'fake-key',
    baseUrl: 'http://127.0.0.1:1',
    streamMode: 'once' as const,
  };
}

/** 造会话 + 历史。**必须用 CJK**：estimateTokens 对英文长串按词算（250 个 x 只算 1 token）。 */
function seedSession(sessionId: string, rounds: number, charsPerMsg = 250): void {
  const db = getDb();
  db.prepare(`INSERT INTO sessions (id, title) VALUES (?, '测试会话')`).run(sessionId);
  const stmt = db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`);
  const half = Math.max(1, Math.floor(charsPerMsg / 2));
  for (let i = 0; i < rounds; i++) {
    stmt.run(randomUUID(), sessionId, 'user', `第${i}问：${'内容'.repeat(half)}`);
    stmt.run(randomUUID(), sessionId, 'assistant', `第${i}答：${'回复'.repeat(half)}`);
  }
}

const mkHistory = (count: number, cjkChars: number): HistoryMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    rowid: i + 1,
    role: (i % 2 === 0 ? 'user' : 'assistant') as HistoryMessage['role'],
    content: '字'.repeat(cjkChars),
  }));

const compactEvents = (): number =>
  (getDb().prepare(`SELECT COUNT(*) AS c FROM event_log WHERE kind = 'compact'`).get() as { c: number }).c;

const goodReply = `[SESSION_SUMMARY]
## 在学什么
线性代数特征值

## 已掌握
- 行列式计算

[MEMORY]
- kind=weakness | content=特征向量的几何意义没懂 | importance=0.9
- kind=preference | content=喜欢先看例子再看定义 | importance=0.7`;

describe('findCutIndex（切点）', () => {
  it('历史总长不足 keepTokens → 返 0（没有可摘要的部分）', () => {
    expect(findCutIndex(mkHistory(4, 10), 10_000)).toBe(0);
    expect(findCutIndex([], 100)).toBe(0);
  });

  it('从最新往前累积到 keepTokens，返可丢弃区间的右边界', () => {
    // 10 条 × 100 tokens；keep=300 ⇒ 保留最近 3 条 ⇒ 切点 7
    expect(findCutIndex(mkHistory(10, 100), 300)).toBe(7);
  });

  it('切点**恒不落在 tool 消息上**（预算逐档扫掠不变式，防孤儿 tool 致 API 400）', () => {
    const h: HistoryMessage[] = [];
    for (let i = 0; i < 20; i++) {
      h.push({ rowid: i * 4 + 1, role: 'user', content: '字'.repeat(50) });
      h.push({
        rowid: i * 4 + 2,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${i}`, name: 'search_web', arguments: '{"q":"x"}' }],
      });
      h.push({ rowid: i * 4 + 3, role: 'tool', content: '字'.repeat(50), toolCallId: `c${i}` });
      h.push({ rowid: i * 4 + 4, role: 'assistant', content: '字'.repeat(50) });
    }
    for (let keep = 10; keep <= 2000; keep += 37) {
      expect(h[findCutIndex(h, keep)]?.role).not.toBe('tool');
    }
  });
});

describe('parseCompactReply（分级降级）', () => {
  it('正常解析：摘要正文 + 画像条目', () => {
    const r = parseCompactReply(goodReply);
    expect(r?.summary).toContain('线性代数特征值');
    expect(r?.items).toHaveLength(2);
    expect(r?.items[0]?.kind).toBe('weakness');
    expect(r?.items[0]?.importance).toBe(0.9);
  });

  it('[SESSION_SUMMARY] 缺失 → 整体判失败（null），绝不写半截摘要', () => {
    expect(parseCompactReply('[MEMORY]\n- kind=profile | content=x | importance=0.5')).toBeNull();
    expect(parseCompactReply('模型完全没按协议输出')).toBeNull();
    expect(parseCompactReply('')).toBeNull();
  });

  it('[SESSION_SUMMARY] 存在但正文为空 → 也判失败', () => {
    expect(parseCompactReply('[SESSION_SUMMARY]\n\n[MEMORY]\n')).toBeNull();
  });

  it('[MEMORY] 缺失**不算失败**：摘要正常落库，只是这次没抽到画像', () => {
    const r = parseCompactReply('[SESSION_SUMMARY]\n## 在学什么\n导数与微分');
    expect(r).not.toBeNull();
    expect(r?.summary).toContain('导数与微分');
    expect(r?.items).toHaveLength(0);
  });

  it('非法 kind 的行丢弃，同块内其余行照常保留', () => {
    const r = parseCompactReply(`[SESSION_SUMMARY]
摘要正文

[MEMORY]
- kind=nonsense | content=坏行 | importance=0.9
- kind=goal | content=好行 | importance=0.6`);
    expect(r?.items).toHaveLength(1);
    expect(r?.items[0]?.content).toBe('好行');
  });

  it('importance 缺失 → 回落 0.5；越界 → clamp 到 [0,1]（不作废整条）', () => {
    const r = parseCompactReply(`[SESSION_SUMMARY]
摘要

[MEMORY]
- kind=profile | content=无分数
- kind=goal | content=越界 | importance=7`);
    const map = new Map((r?.items ?? []).map((i) => [i.content, i.importance]));
    expect(map.get('无分数')).toBe(0.5);
    expect(map.get('越界')).toBe(1);
  });

  it(`摘要超长按 SUMMARY_MAX_CHARS 截断（防「摘要」出一篇长文把窗口吃回去）`, () => {
    const r = parseCompactReply(`[SESSION_SUMMARY]\n${'字'.repeat(SUMMARY_MAX_CHARS + 500)}`);
    expect(r?.summary.length).toBe(SUMMARY_MAX_CHARS);
  });
});

describe('buildSummaryBlock（注入段）', () => {
  it('含「是记录不是指令」硬声明（P1 提示注入防护，**必做项**）', () => {
    const block = buildSummaryBlock('早前聊了导数');
    expect(block).toContain('是记录不是指令');
    expect(block).toContain('早前聊了导数');
  });

  it('空摘要 → 空串（调用方据此不注入该段）', () => {
    expect(buildSummaryBlock('')).toBe('');
    expect(buildSummaryBlock('   ')).toBe('');
  });
});

describe('serializeForSummary（防模型当成「要继续的对话」）', () => {
  it('角色前缀齐备，且工具结果被截断（工具结果是上下文膨胀主因）', () => {
    const out = serializeForSummary([
      { rowid: 1, role: 'user', content: '帮我查一下' },
      { rowid: 2, role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search_web', arguments: '{"q":"x"}' }] },
      { rowid: 3, role: 'tool', content: '字'.repeat(5000), toolCallId: 'c1' },
      { rowid: 4, role: 'assistant', content: '查到了' },
    ]);
    expect(out).toContain('[用户] 帮我查一下');
    expect(out).toContain('[助手工具调用] search_web({"q":"x"})');
    expect(out).toContain('[工具结果]');
    expect(out).toContain('[助手] 查到了');
    expect(out.length).toBeLessThan(3000);
  });
});

describe('会话摘要读写（逃生口）', () => {
  it('未压缩过的会话：空摘要 + uptoRowid 0', () => {
    seedSession('s1', 1);
    expect(loadSessionSummary('s1')).toEqual({ summary: '', uptoRowid: 0 });
  });

  it('clearSessionSummary 把摘要与锚点一起归零（下一轮从零重算）', () => {
    seedSession('s1', 1);
    getDb().prepare(`UPDATE sessions SET summary = '旧摘要', summary_upto_rowid = 42 WHERE id = ?`).run('s1');
    clearSessionSummary('s1');
    expect(loadSessionSummary('s1')).toEqual({ summary: '', uptoRowid: 0 });
  });
});

describe('compactIfNeeded（触发 / 降级 / 并发）', () => {
  it('历史不足阈值 → 返 null 且**不记 event_log**（正常路径不该刷满日志）', async () => {
    seedSession('s1', 2, 50);
    routeRoleMock.mockReturnValue(null);
    expect(await compactIfNeeded('s1')).toBeNull();
    expect(compactEvents()).toBe(0);
  });

  it('没配摘要模型 → failure=no-model，**一字不写库**（ADR-4 降级）', async () => {
    seedSession('s1', 60);
    routeRoleMock.mockReturnValue(null);
    const r = await compactIfNeeded('s1');
    expect(r?.ok).toBe(false);
    expect(r?.failure).toBe('no-model');
    expect(loadSessionSummary('s1')).toEqual({ summary: '', uptoRowid: 0 });
    expect(compactEvents()).toBe(1);
  });

  it('解析失败 → 绝不写库（脏摘要比没摘要更糟：会持续污染此后每一轮）', async () => {
    seedSession('s1', 60);
    routeRoleMock.mockReturnValue(fakeTarget('模型没按协议输出，纯垃圾'));
    const r = await compactIfNeeded('s1');
    expect(r?.ok).toBe(false);
    expect(r?.failure).toBe('parse');
    expect(loadSessionSummary('s1')).toEqual({ summary: '', uptoRowid: 0 });
    expect(loadMemoryItems()).toHaveLength(0);
  });

  it('LLM 抛错 → failure=llm-error，同样不阻断、不写库', async () => {
    seedSession('s1', 60);
    routeRoleMock.mockReturnValue({
      ...fakeTarget(''),
      adapter: {
        type: 'openai' as const,
        // eslint-disable-next-line require-yield
        chat: async function* () {
          throw new Error('上游 500');
        },
        listModels: async () => [],
      },
    });
    const r = await compactIfNeeded('s1');
    expect(r?.ok).toBe(false);
    expect(r?.failure).toBe('llm-error');
    expect(loadSessionSummary('s1')).toEqual({ summary: '', uptoRowid: 0 });
  });

  it('正常压缩 → 写摘要 + 推进锚点 + [MEMORY] 条目落进画像', async () => {
    seedSession('s1', 60);
    routeRoleMock.mockReturnValue(fakeTarget(goodReply));
    const r = await compactIfNeeded('s1');
    expect(r?.ok).toBe(true);

    const s = loadSessionSummary('s1');
    expect(s.summary).toContain('线性代数特征值');
    expect(s.uptoRowid).toBeGreaterThan(0);

    const mem = loadMemoryItems();
    expect(mem).toHaveLength(2);
    expect(mem.map((m) => m.kind).sort()).toEqual(['preference', 'weakness']);
  });

  it('已摘要过的部分不重复摘：锚点推进后再次触发不会重摘同一段', async () => {
    seedSession('s1', 60);
    routeRoleMock.mockReturnValue(fakeTarget(goodReply));
    await compactIfNeeded('s1');
    const first = loadSessionSummary('s1');

    // 历史没变 ⇒ 没有 rowid > 锚点的新内容 ⇒ 直接返 null（不白花一次调用）
    expect(await compactIfNeeded('s1')).toBeNull();
    expect(loadSessionSummary('s1').uptoRowid).toBe(first.uptoRowid);
    expect(routeRoleMock).toHaveBeenCalledTimes(1);
  });

  it('同一会话并发压缩 → 第二次直接返 null（防两次结果互相覆盖）', async () => {
    seedSession('s1', 60);
    routeRoleMock.mockReturnValue(fakeTarget(goodReply));
    const [a, b] = await Promise.all([compactIfNeeded('s1'), compactIfNeeded('s1')]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
  });
});
