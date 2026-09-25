/**
 * chat/tools/offer-pk-battle — `offer_pk_battle` 工具面测试（契约 docs/PK-SPEC.md §16.13 的 T5）。
 *
 * 本批的**功能定义**是「AI 主动发起」，所以第一优先级不是文案，而是三件会静默失效的接线：
 * ① **模型到底拿不拿得到它**：注册表 + 下发清单 + 提示词点名，三样缺一件就等于
 *    「AI 嘴上说要跟你打，屏幕上没有卡」（`generate_quiz` 上线时漏挂 index 的前例同款症状）。
 *    ★ 只走 `./index.js` 取工具：否则「index 里那行 import 没了」这一条测不出来。
 * ② **本轮不许被挂起**：这是它与 `ask_choice` 的分水岭。挂起的代价是把会话钉在 busy 上，
 *    而「拒绝/不理睬」正是这类邀请的正常结局 ⇒ 挂起＝把「可以拒绝」做成假承诺。
 *    锁法是「没人答复时 `await runTool(...)` 照样返回」——实现若改成等待，本文件会超时红灯
 *    （不是断言文案，是断言控制流；这是这条唯一诚实的锁形）。
 * ③ **免确认档不是靠默认阈值的巧合**：`normalizeConfirmThreshold` 允许 0，阈值 0 时
 *    `affected(1) > 0` 成立 ⇒ 每张邀请先撞一张「批准这个提议」的确认卡，两层卡叠在同一条决策上。
 *    故这里显式 `needsConfirm: false`，并留一条「阈值 0 也直接发出」的用例。
 *
 * 另外两条口径：闸门挡下**不是错误**（回灌文案里不许有重试暗示，否则教会模型刷屏）、
 * `owner_id` 必须落到邀请行上（人维度那条闸门的判据就是它）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_DISPATCHED_TOOLS, PK_INVITE_OWNER_DAILY_MAX, PK_INVITE_REASON_MAX, TOPIC_MAX } from '@sb/shared';

const { openIsolated, closeDb, getDb } = await import('../../storage/db.js');
// ★ 只从 `./index.js` 拿：注册副作用由 index 的 import 顺序完成，绕过它就测不出漏挂
const { runTool, toolMeta, toolNames, toolDefinitions } = await import('./index.js');
const { snapshot } = await import('../sse-bus.js');
const { SYSTEM_PROMPT } = await import('../system-prompt.js');
const { saveConfirmThreshold } = await import('../../storage/confirm-threshold.js');
import type { ToolContext } from './registry.js';

let dir = '';
const TOOL = 'offer_pk_battle';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-offer-pk-'));
  openIsolated(dir);
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  onStep: () => {},
  ownerId: null,
  sessionId: 'sess-pk-tool',
  ...over,
});

const call = (args: Record<string, unknown>, over: Partial<ToolContext> = {}) =>
  runTool(TOOL, JSON.stringify(args), ctx(over));

const rows = (sessionId: string): Array<Record<string, unknown>> =>
  getDb().prepare('SELECT * FROM pk_invites WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;

describe('① 注册与下发（模型拿不到 = 本批白做）', () => {
  it('在注册表里，且出现在下发给模型的清单里', () => {
    expect(toolNames()).toContain(TOOL);
    expect(toolDefinitions().map((d) => d.function.name)).toContain(TOOL);
  });

  it('内建清单离 MAX_DISPATCHED_TOOLS 还有余量（超限按注册顺序静默截断）', () => {
    const names = toolNames();
    expect(names.length).toBeLessThanOrEqual(MAX_DISPATCHED_TOOLS);
    expect(names.indexOf(TOOL)).toBeLessThan(MAX_DISPATCHED_TOOLS);
    // ★ 如实记：它注册在 `ask_choice` **之前**（ask_choice 由 index 本体注册，恒为清单最后一位），
    //   ⇒ 真撞上限时它是倒数第二个被截的。这条只锁「今天内建清单没撞上限」——
    //   MCP 外部工具也进同一张注册表，接入后要重新数（`update_tasks` 不在册：带每轮状态，走 tool-dispatch）。
  });

  it('元数据：kind=write（它写一行 pk_invites）+ needsConfirm=false（两张卡不叠）', () => {
    const m = toolMeta(TOOL);
    expect(m?.kind).toBe('write');
    expect(m?.needsConfirm).toBe(false);
    // 没有 run 入口：有写副作用的工具只走 planWrite（写门面唯一，旁路即漏洞）
    expect(m?.run).toBeUndefined();
    expect(m?.planWrite).toBeTypeOf('function');
  });

  it('提示词点名了它，并写明「不等答复」与「没发出去不是故障」', () => {
    expect(SYSTEM_PROMPT).toContain(TOOL);
    expect(SYSTEM_PROMPT).toContain('不要等他');
    expect(SYSTEM_PROMPT).toContain('终点信号');
  });

  it('入参只吃 topic + reason，两者都必填（描述里带长度上限，模型才知道往哪裁）', () => {
    const params = toolDefinitions().find((d) => d.function.name === TOOL)?.function.parameters;
    expect(Object.keys(params?.properties ?? {})).toEqual(['topic', 'reason']);
    expect(params?.required).toEqual(['topic', 'reason']);
    const described = JSON.stringify(params);
    expect(described).toContain(String(TOPIC_MAX));
    expect(described).toContain(String(PK_INVITE_REASON_MAX));
  });
});

describe('② 调用即返回，不等答复（与 ask_choice 的分水岭）', () => {
  it('没人点过接受/拒绝，runTool 依然返回：库里一行、频道里一帧 `pk-invite-asked`', async () => {
    const r = await call({ topic: '高一数学 正弦定理', reason: '刚推导完，趁热打一局' });
    expect(r.content).toContain('不需要等他');
    expect(r.meta?.affected).toBe(1);
    expect(r.meta?.confirm ?? null).toBeNull();
    expect(rows('sess-pk-tool')).toHaveLength(1);
    expect(snapshot('sess-pk-tool').some((e) => e.type === 'pk-invite-asked')).toBe(true);
  });

  it('回灌文本里不重复题面细节、也不承诺「他选了我们就开始」（他可能永远不点）', async () => {
    const r = await call({ topic: '词根 spect', reason: '看看你记住了没' });
    expect(r.content).toContain('词根 spect');
    expect(r.content).not.toMatch(/他选择后|选定后|等他点/);
  });

  it('owner_id 落在邀请行上（人维度那条闸门的判据就是这一列）', async () => {
    await call({ topic: '牛二定律', reason: '练一轮' }, { ownerId: 'u-payer' });
    expect(rows('sess-pk-tool')[0]?.owner_id).toBe('u-payer');
  });
});

describe('③ 确认门不参与：阈值 0（「全都问我」）时邀请照样发出', () => {
  it('saveConfirmThreshold(0) 后调用仍**立即返回**、落库一行、meta.confirm 为 null', async () => {
    saveConfirmThreshold(0, 'u-thr');
    const r = await call({ topic: '洋流分布', reason: '刚讲完一轮' }, { ownerId: 'u-thr', sessionId: 'sess-thr' });
    expect(r.content).toContain('已向学习者发出对战邀请');
    expect(r.meta?.confirm ?? null).toBeNull();
    expect(rows('sess-thr')).toHaveLength(1);
  });
});

describe('闸门与参数：失败口径都是「回灌给人看的话」，不抛异常', () => {
  it('同一会话第二张：被挡、不落库，且文案里没有重试暗示（写了就是教会模型刷屏）', async () => {
    await call({ topic: '牛顿第三定律', reason: '趁热' });
    const second = await call({ topic: '牛顿第三定律', reason: '再来一局' });
    expect(second.content).toContain('没发出去');
    expect(second.content).not.toMatch(/重试|再试一次|稍后再调|again/);
    expect(second.meta?.affected).toBe(0);
    expect(rows('sess-pk-tool')).toHaveLength(1);
  });

  it(`人维度发满 ${PK_INVITE_OWNER_DAILY_MAX} 张后：第 ${PK_INVITE_OWNER_DAILY_MAX + 1} 张被挡（跨会话累计）`, async () => {
    for (let i = 0; i < PK_INVITE_OWNER_DAILY_MAX; i += 1) {
      const r = await call({ topic: `主题 ${i}`, reason: '练一轮' }, { ownerId: 'u-daily', sessionId: `s-daily-${i}` });
      expect(r.meta?.affected).toBe(1);
    }
    const over = await call({ topic: '多要一张', reason: '练一轮' }, { ownerId: 'u-daily', sessionId: 's-daily-latest' });
    expect(over.meta?.affected).toBe(0);
    expect(rows('s-daily-latest')).toHaveLength(0);
  });

  it('缺 reason：registry 的参数预闸先挡住（工具体都没进），不落库', async () => {
    const r = await call({ topic: '只给了主题' });
    expect(r.content).toMatch(/reason|必填|参数/);
    expect(rows('sess-pk-tool')).toHaveLength(0);
  });

  it('空 topic（schema 过了、语义不过）：工具体回灌「怎么改对」，不落库', async () => {
    const r = await call({ topic: '   ', reason: '有说明' });
    expect(r.content).toContain('参数不全');
    expect(r.meta?.affected).toBe(0);
    expect(rows('sess-pk-tool')).toHaveLength(0);
  });

  it('没有会话上下文：卡片无处可挂，如实回灌并建议走对战页（不静默、不抛）', async () => {
    const r = await call({ topic: '没有会话', reason: '练一轮' }, { sessionId: undefined });
    expect(r.content).toContain('没有会话上下文');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM pk_invites').get()).toEqual({ n: 0 });
  });

  it('超长入参在建邀请时就被截断（不是留到用户点接受才报错）', async () => {
    await call({ topic: '一'.repeat(TOPIC_MAX + 40), reason: '长'.repeat(PK_INVITE_REASON_MAX + 40) });
    const row = rows('sess-pk-tool')[0];
    expect(String(row?.topic)).toHaveLength(TOPIC_MAX);
    expect(String(row?.reason)).toHaveLength(PK_INVITE_REASON_MAX);
  });
});
