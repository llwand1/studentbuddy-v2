/**
 * chat/tools/term-ops —— 词条三工具回归（契约 TOOL-ECOSYSTEM-SPEC §5.1，P3 / 拍板⑥⑭）。
 *
 * 与 confirm.test.ts 的分工：那边用假探针锁「门」的口径（apply 恒 0 死锁、阈值边界），
 * 这里锁「真工具」的落库语义——三样必测：
 * ① delete_terms 全链路（弹卡 → allow → 行删 + term_delete_log 一批）与 deny 零副作用；
 * ② **plan/apply 间隙改动**（确认卡挂着期间 UI 删了一条）→ apply 重校验整批中止，
 *    这是两阶段写最真实的 race 形态，假探针造不出来；
 * ③ 找不到就如实报（不模糊匹配着删、不弹「批准一次零改动」的空卡）。
 *
 * DB：openIsolated 临时目录（同 tidy.test 手法）——删除快照要写真表，零 DB 做不到；
 * 门侧零 mock：write-gate/confirm 都是被测路径本体，收口全走 resolveConfirmation。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SseEvent } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../../storage/db.js';
import { saveTerms, findTermByName, removeTerm, listTerms } from '../../learning/terms.js';
import { runTool, toolMeta } from './index.js';
import type { ToolContext } from './registry.js';
import { snapshot } from '../sse-bus.js';
import { pendingConfirmCount, resolveConfirmation } from './confirm.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-termops-'));
  openIsolated(dir);
});

afterEach(() => {
  expect(pendingConfirmCount()).toBe(0); // 残留挂起＝用例没收口
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function ctxOf(sessionId?: string): { ctx: ToolContext; steps: string[] } {
  const steps: string[] = [];
  return {
    ctx: {
      onStep: (tool, status, detail) => steps.push(`${tool}:${status}:${detail ?? ''}`),
      ownerId: null,
      ...(sessionId ? { sessionId } : {}),
    },
    steps,
  };
}

type RequestEv = Extract<SseEvent, { type: 'tool-confirm-request' }>;

/** 只认「发了 request 还没 resolved」的活帧（sse-bus 缓冲跨用例常驻） */
function openFrames(sid: string): RequestEv[] {
  const evs = snapshot(sid);
  const resolved = new Set(
    evs.flatMap((e) => (e.type === 'tool-confirm-resolved' ? [e.requestId] : [])),
  );
  return evs.filter(
    (e): e is RequestEv => e.type === 'tool-confirm-request' && !resolved.has(e.requestId),
  );
}

async function confirmFrame(sid: string): Promise<RequestEv> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const [frame] = openFrames(sid);
    if (frame) return frame;
  }
  throw new Error('没等到 tool-confirm-request 帧');
}

function logRows(): Array<{ affected_batch: string; actor: string; tool: string | null; snapshot: string }> {
  return getDb().prepare('SELECT affected_batch, actor, tool, snapshot FROM term_delete_log').all() as
    Array<{ affected_batch: string; actor: string; tool: string | null; snapshot: string }>;
}

function termCount(term: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM term_library WHERE term = ?').get(term) as { n: number }).n;
}

/** 种子库：ml/cs/math 三条，其中一条带长释义（截断口径用） */
function seed(): void {
  saveTerms(
    [
      { term: '机器学习', definition: '让计算机从数据中学习规律的一类方法', domain: 'cs' },
      { term: '闭包', definition: '函数与其词法环境的组合', domain: 'cs' },
      { term: '分数', definition: '表示一个数是另一个数的几分之几的数，通常写成 a/b 的形式，其中 b 不为零，这个定义写得足够长是为了验证 lookup 的六十字截断口径会不会生效', domain: 'math' },
    ],
    null,
    null,
  );
}

describe('lookup_terms — 查永不问（read 档零确认）', () => {
  it('全量查询：总数/命中/领域分布/汇报指令四段齐', async () => {
    seed();
    const { ctx } = ctxOf();
    const r = await runTool('lookup_terms', '{}', ctx);
    expect(r.content).toContain('词条库共 3 条');
    expect(r.content).toContain('命中 3 条');
    expect(r.content).toContain('cs 2');
    expect(r.content).toContain('math 1');
    expect(r.content).toContain('请用自然语言向用户汇报');
    expect(snapshot('no-such').length).toBe(0); // 只读工具不发确认帧（run 档根本不经 gate）
  });

  it('domain 与 keyword 前缀筛选各自生效，落空如实报「没有命中」', async () => {
    seed();
    const { ctx } = ctxOf();
    const cs = await runTool('lookup_terms', '{"domain":"cs"}', ctx);
    expect(cs.content).toContain('闭包');
    expect(cs.content).not.toContain('分数');
    const kw = await runTool('lookup_terms', '{"keyword":"机器"}', ctx);
    expect(kw.content).toContain('命中 1 条');
    const none = await runTool('lookup_terms', '{"keyword":"量子"}', ctx);
    expect(none.content).toContain('（没有命中任何词条）');
  });

  it('长释义截 60 字、别名随行显示', async () => {
    seed();
    getDb().prepare("UPDATE term_library SET aliases = '[\"closure\"]' WHERE term = '闭包'").run();
    const { ctx } = ctxOf();
    const r = await runTool('lookup_terms', '{}', ctx);
    expect(r.content).toContain('（别名：closure）');
    expect(r.content).not.toContain('六十字截断口径会不会生效'); // 60 字外的内容不回灌
  });

  it('31 条只回灌前 30 条并明说剩余（全量回灌会吃窗口）', async () => {
    saveTerms(Array.from({ length: 31 }, (_, i) => ({ term: `词${i}`, definition: `释义${i}`, domain: 'general' })), null, null);
    const { ctx } = ctxOf();
    const r = await runTool('lookup_terms', '{}', ctx);
    expect(r.content).toContain('仅显示前 30 条，其余 1 条');
  });
});

describe('upsert_term — 一次一条的写门面（新建/更新/别名命中）', () => {
  it('新建：落库 general 缺省，meta affected 1 且未经门（留痕 null）', async () => {
    const { ctx, steps } = ctxOf();
    const r = await runTool('upsert_term', '{"term":"熵","definition":"系统的无序程度"}', ctx);
    expect(r.content).toContain('词条已入库：熵');
    expect(r.meta?.affected).toBe(1);
    expect(r.meta?.confirm ?? null).toBeNull();
    const hit = findTermByName('熵', null);
    expect(hit?.domain).toBe('general');
    expect(steps).toContain('upsert_term:done:词条「熵」已入库（general）');
  });

  it('更新：同名不新建第二行，释义/重要度按 patch 改', async () => {
    seed();
    const { ctx } = ctxOf();
    const r = await runTool('upsert_term', '{"term":"闭包","definition":"函数捕获其定义环境的变量","importance":0.9}', ctx);
    expect(r.content).toContain('词条已更新：闭包');
    expect(termCount('闭包')).toBe(1); // 更新语义＝原地改，不是插第二条同名
    const hit = findTermByName('闭包', null);
    expect(hit?.definition).toBe('函数捕获其定义环境的变量');
    expect(hit?.importance).toBe(0.9);
  });

  it('别名命中走更新不新建（同概念口径与 findTermByName 同源）', async () => {
    seed();
    getDb().prepare("UPDATE term_library SET aliases = '[\"closure\"]' WHERE term = '闭包'").run();
    const { ctx } = ctxOf();
    const r = await runTool('upsert_term', '{"term":"closure","definition":"函数与其词法环境"}', ctx);
    expect(r.content).toContain('词条已更新：闭包');
    expect(termCount('closure')).toBe(0); // 没造出以别名命名的新行
    expect(termCount('闭包')).toBe(1);
  });

  it('释义与现状一致 → 零计划如实报，不碰库', async () => {
    seed();
    const before = getDb().prepare("SELECT updated_at FROM term_library WHERE term = '闭包'").get() as { updated_at: string };
    const { ctx } = ctxOf();
    const r = await runTool('upsert_term', '{"term":"闭包","definition":"函数与其词法环境的组合"}', ctx);
    expect(r.content).toContain('与现状一致');
    expect(r.meta?.affected).toBe(0);
    const after = getDb().prepare("SELECT updated_at FROM term_library WHERE term = '闭包'").get() as { updated_at: string };
    expect(after.updated_at).toBe(before.updated_at);
  });

  it('参数不全（term 或 definition 空白）→ 回灌「怎么改对」，零落库', async () => {
    const { ctx } = ctxOf();
    const r = await runTool('upsert_term', '{"term":"  ","definition":"x"}', ctx);
    expect(r.content).toContain('请带齐参数重新调用');
    expect(r.meta?.affected).toBe(0);
    expect(listTerms(undefined, undefined, null)).toHaveLength(0);
  });

  it('§4.6-5：计划与执行之间词条被删 → 更新分支中止如实报，不擅自改成新建', async () => {
    seed();
    const hit = findTermByName('闭包', null);
    if (!hit) throw new Error('种子未落库');
    const { ctx } = ctxOf();
    // 直接驱动 planWrite→（造间隙）→apply：runTool 里 plan 与 apply 之间没有插入点，间隙只能手工复现
    const plan = toolMeta('upsert_term')?.planWrite;
    if (!plan) throw new Error('upsert_term 未注册 planWrite');
    const p = await plan({ term: '闭包', definition: '新释义' }, ctx);
    if (!p) throw new Error('更新分支不该给空计划');
    removeTerm(hit.id, null); // 确认间隙 UI 删了它
    const r = await p.apply();
    expect(r.content).toContain('已被删除');
    expect(r.content).toContain('本次未写入');
    expect(r.meta?.affected).toBe(0);
    expect(termCount('闭包')).toBe(0); // 没有复活成新建
  });
});

describe('delete_terms — 必确认 + 快照 + 间隙重校验（§5.1 全链路）', () => {
  it('弹卡 → allow_once：行删 + term_delete_log 一批 N 行，未找到的随行如实报', async () => {
    seed();
    const { ctx, steps } = ctxOf('t-allow');
    const p = runTool('delete_terms', '{"terms":["机器学习","闭包","不存在词"]}', ctx);
    const frame = await confirmFrame('t-allow');
    expect(frame.tool).toBe('delete_terms');
    expect(frame.affected).toBe(2); // 未找到的不进卡（卡上只有会被删的）
    expect(frame.items).toEqual(['机器学习［cs］', '闭包［cs］']);
    // 批准前：手没伸进库
    expect(termCount('机器学习')).toBe(1);
    expect(logRows()).toHaveLength(0);
    expect(resolveConfirmation(frame.requestId, 'allow_once').ok).toBe(true);
    const r = await p;
    expect(r.meta?.confirm).toBe('allow_once');
    expect(r.meta?.affected).toBe(2);
    expect(r.content).toContain('已删除 2 条');
    expect(r.content).toContain('词条库里没有：不存在词');
    expect(r.content).toContain('整批撤销');
    expect(termCount('机器学习')).toBe(0);
    expect(steps).toContain('delete_terms:done:已删除 2 条');
    const logs = logRows();
    expect(logs).toHaveLength(2);
    expect(new Set(logs.map((l) => l.affected_batch)).size).toBe(1); // 一批一个批次号
    expect(logs.every((l) => l.actor === 'ai_tool' && l.tool === 'delete_terms')).toBe(true);
    expect(JSON.parse(logs[0]?.snapshot ?? '{}').term).toBeTruthy(); // 整行 JSON 快照
  });

  it('deny：行不删、零日志，回灌「请勿重复发起」', async () => {
    seed();
    const { ctx } = ctxOf('t-deny');
    const p = runTool('delete_terms', '{"terms":["分数"]}', ctx);
    const frame = await confirmFrame('t-deny');
    resolveConfirmation(frame.requestId, 'deny');
    const r = await p;
    expect(r.meta?.confirm).toBe('deny');
    expect(r.meta?.affected).toBeNull();
    expect(r.content).toContain('用户未批准');
    expect(termCount('分数')).toBe(1);
    expect(logRows()).toHaveLength(0);
  });

  it('全落空不弹空卡（affected 0 直 apply，§4.6 落码注 1）', async () => {
    seed();
    const { ctx } = ctxOf('t-empty');
    const r = await runTool('delete_terms', '{"terms":["查无此词"]}', ctx);
    expect(openFrames('t-empty')).toHaveLength(0);
    expect(r.meta?.affected).toBe(0);
    expect(r.content).toContain('词条库里没有：查无此词');
    expect(r.content).toContain('本次未删除任何词条');
  });

  it('terms 与 ids 给空 → 回灌「至少给一个」', async () => {
    const { ctx } = ctxOf('t-args');
    const r = await runTool('delete_terms', '{}', ctx);
    expect(r.content).toContain('至少给一个');
    expect(r.meta?.affected).toBe(0);
  });

  it('超 50 条报错不截断（截了哪几条模型不知道）', async () => {
    const names = Array.from({ length: 51 }, (_, i) => `词${i}`);
    const { ctx } = ctxOf('t-cap');
    const r = await runTool('delete_terms', JSON.stringify({ terms: names }), ctx);
    expect(r.content).toContain('单次最多 50 条');
    expect(r.content).toContain('点名 51 条');
    expect(openFrames('t-cap')).toHaveLength(0); // 超限连卡都不该发
  });

  it('按 id 删 + 未知 id 如实报（不存在与不可删同形，不给探测面）', async () => {
    seed();
    const hit = findTermByName('分数', null);
    if (!hit) throw new Error('种子未落库');
    const { ctx } = ctxOf('t-id');
    const p = runTool('delete_terms', JSON.stringify({ ids: [hit.id, 'ghost-id'] }), ctx);
    const frame = await confirmFrame('t-id');
    expect(frame.affected).toBe(1);
    resolveConfirmation(frame.requestId, 'allow_once');
    const r = await p;
    expect(r.content).toContain('已删除 1 条：分数');
    expect(r.content).toContain('这些 id 不存在或不可删：ghost-id');
    expect(termCount('分数')).toBe(0);
  });

  it('terms 与 ids 指向同一行 → 去重，affected 只算一次', async () => {
    seed();
    const hit = findTermByName('闭包', null);
    if (!hit) throw new Error('种子未落库');
    const { ctx } = ctxOf('t-dup');
    const p = runTool('delete_terms', JSON.stringify({ terms: ['闭包'], ids: [hit.id] }), ctx);
    const frame = await confirmFrame('t-dup');
    expect(frame.affected).toBe(1);
    resolveConfirmation(frame.requestId, 'allow_once');
    await p;
    expect(logRows()).toHaveLength(1); // 快照也没记重
  });

  it('★ plan/apply 间隙：卡挂着期间 UI 删了一条 → allow 后整批中止、剩余行健在、零日志', async () => {
    seed();
    const a = findTermByName('机器学习', null);
    if (!a) throw new Error('种子未落库');
    const { ctx } = ctxOf('t-race');
    const p = runTool('delete_terms', '{"terms":["机器学习","闭包"]}', ctx);
    const frame = await confirmFrame('t-race');
    removeTerm(a.id, null); // 用户趁卡片挂着自己在词条页删了「机器学习」
    resolveConfirmation(frame.requestId, 'allow_once');
    const r = await p;
    expect(r.content).toContain('整批中止');
    expect(r.content).toContain('一条未删');
    expect(r.meta?.affected).toBe(0);
    expect(termCount('闭包')).toBe(1); // 不补删也不部分执行——批 A 跑 A
    expect(logRows()).toHaveLength(0);
  });
});
