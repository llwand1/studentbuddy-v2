/**
 * chat/grill.test — grill-me 模式（v18）的单测。
 *
 * 这个模式的存在理由就是「触发权不该在模型手里」，所以测试的重点不是提示词文案，
 * 而是**工程强绑是否真的发生**，以及两段提问的挂起语义有没有搞反：
 * ① 强绑 —— 收尾那一轮必须带着 `toolChoice=ask_choice` 下发（模型没有自由发挥的空间）；
 * ② 不挂起 —— 收尾是 `offerOnly`：用户不点也得能继续，否则「可以跳过」是假承诺；
 * ③ 静默失败 —— 收尾问不出来不能让已经上屏的回答被标成出错；
 * ④ pre/post 标记 —— 前端靠它决定「沉进消息流」与「选完开新一轮」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatRequest, LLMAdapter, TokenChunk } from '../llm/types.js';
import { closeDb, openIsolated } from '../storage/db.js';
import { listPendingChoices } from './choice.js';
import { snapshot } from './sse-bus.js';
import { toolDefinitions } from './tools.js';
import { GRILL_POST, GRILL_PRE, GRILL_TOOL_CHOICE, grillInstruction, runGrillClosing } from './grill.js';

let tmpDir = '';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-grill-'));
  openIsolated(tmpDir);
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 假适配器：记下收到的请求，并按剧本吐 chunk。
 * 剧本返回 `Error` 时模拟「适配器/网络炸了」，用来验收尾的静默失败。
 */
function stubAdapter(script: (req: ChatRequest) => TokenChunk[] | Error) {
  const seen: ChatRequest[] = [];
  const adapter: LLMAdapter = {
    type: 'openai',
    async *chat(req: ChatRequest) {
      seen.push(req);
      const out = script(req);
      if (out instanceof Error) throw out;
      for (const c of out) yield c;
    },
    async listModels() {
      return [];
    },
  };
  return { adapter, seen };
}

/** 模型「调用 ask_choice」的一轮完整输出 */
function askChoiceChunk(args: Record<string, unknown>): TokenChunk[] {
  return [
    { content: '', done: false, toolCalls: [{ id: 'call-1', name: 'ask_choice', arguments: JSON.stringify(args) }] },
    { content: '', done: true },
  ];
}

const NEXT_STEP_ARGS = {
  question: '接下来想怎么走？',
  options: [{ label: '继续深入' }, { label: '出两道题测我' }],
};

/** 跑一次收尾提问，回收 step 事件 */
async function runClosing(sessionId: string, script: (req: ChatRequest) => TokenChunk[] | Error) {
  const { adapter, seen } = stubAdapter(script);
  const steps: Array<{ tool: string; status: string; detail?: string }> = [];
  await runGrillClosing({
    sessionId,
    adapter,
    model: 'm',
    apiKey: 'k',
    messages: [{ role: 'user', content: '讲讲二分查找' }, { role: 'assistant', content: '……' }],
    tools: toolDefinitions(),
    onStep: (tool, status, detail) => steps.push({ tool, status, detail }),
    ownerId: null,
  });
  return { seen, steps };
}

describe('两段指令（纯函数出口）', () => {
  it('pre 与 post 是两条不同的指令，不是同一个模板换词', () => {
    expect(grillInstruction('pre')).toBe(GRILL_PRE);
    expect(grillInstruction('post')).toBe(GRILL_POST);
    expect(GRILL_PRE).not.toBe(GRILL_POST);
  });

  it('pre 要求「第一个动作必须是调用 ask_choice」（先写完正文就没人点卡了）', () => {
    expect(GRILL_PRE).toContain('第一个动作必须是调用 ask_choice');
  });

  it('post 明确要求「不要总结刚讲过的内容」（否则模型收尾时会复述一遍正文）', () => {
    expect(GRILL_POST).toContain('不要总结刚讲过的内容');
  });

  it('两段指令都要求 2~4 个选项（契约的选项数上限）', () => {
    expect(GRILL_PRE).toContain('2~4');
    expect(GRILL_POST).toContain('2~4');
  });

  it('GRILL_TOOL_CHOICE 锁死 ask_choice —— 强绑靠这个常量，不靠提示词自觉', () => {
    expect(GRILL_TOOL_CHOICE).toEqual({ type: 'function', name: 'ask_choice' });
  });
});

describe('runGrillClosing（收尾提问）', () => {
  it('把 toolChoice=ask_choice 原样下发给适配器（工程强绑真的发生了）', async () => {
    const { seen } = await runClosing('s-grill-bind', () => askChoiceChunk(NEXT_STEP_ARGS));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolChoice).toEqual(GRILL_TOOL_CHOICE);
  });

  it('收尾指令以 user 消息 push 到 messages 尾部（收尾那一轮的上下文）', async () => {
    const messages = [{ role: 'user' as const, content: '讲讲二分查找' }];
    const { adapter } = stubAdapter(() => askChoiceChunk(NEXT_STEP_ARGS));
    await runGrillClosing({
      sessionId: 's-grill-msg',
      adapter,
      model: 'm',
      apiKey: 'k',
      messages,
      tools: toolDefinitions(),
      onStep: () => undefined,
      ownerId: null,
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'user', content: GRILL_POST });
  });

  it('收到 tool_call → 落一张 post 卡，且**不挂起**（没人点选也已经返回）', async () => {
    const sessionId = 's-grill-offer';
    await runClosing(sessionId, () => askChoiceChunk(NEXT_STEP_ARGS));

    const list = listPendingChoices(sessionId);
    expect(list).toHaveLength(1);
    // 仍是 pending ＝ 函数没在等答复就返回了（若走的是 askChoice，这里会永久挂起 → 用例超时）
    expect(list[0]!.status).toBe('pending');
    expect(list[0]!.question).toBe('接下来想怎么走？');
    expect(list[0]!.options.map((o) => o.label)).toEqual(['继续深入', '出两道题测我']);

    // 前端认的是 SSE 那一份——`grillPhase` 只在内存与 SSE 下发里活（库内无此列，刻意不加迁移），
    // 它决定「点选后是续本轮还是开新一轮」。这条断言就是该决定的数据来源。
    const asked = snapshot(sessionId).find((e) => e.type === 'choice-asked');
    expect(asked && asked.type === 'choice-asked' ? asked.request.grillPhase : null).toBe('post');
    // 反过来把代价钉死：库内读回**没有** phase（刷新后捞回的卡降级为普通卡，设计上接受）
    expect(list[0]!.grillPhase).toBeUndefined();
  });

  it('模型只回正文、没有 tool_call → 静默返回，不落卡', async () => {
    const sessionId = 's-grill-notool';
    await runClosing(sessionId, () => [
      { content: '好吧', done: false },
      { content: '', done: true },
    ]);
    expect(listPendingChoices(sessionId)).toHaveLength(0);
  });

  it('适配器抛错 → 静默返回（收尾失败不该把已上屏的回答标成出错）', async () => {
    const sessionId = 's-grill-throw';
    await expect(runClosing(sessionId, () => new Error('upstream 500'))).resolves.toBeDefined();
    expect(listPendingChoices(sessionId)).toHaveLength(0);
  });

  it('参数不合法 → 不落卡，但 step 报错留痕（模型可自纠，不静默）', async () => {
    const sessionId = 's-grill-badargs';
    const { steps } = await runClosing(sessionId, () =>
      askChoiceChunk({ question: '', options: [] }), // 空问题 / 空选项必被校验拒掉
    );
    expect(listPendingChoices(sessionId)).toHaveLength(0);
    expect(steps.some((s) => s.tool === 'ask_choice' && s.status === 'error')).toBe(true);
  });

  it('tool_call 的 arguments 不是合法 JSON → 仍不落卡、也不抛（交给校验回灌）', async () => {
    const sessionId = 's-grill-badjson';
    await expect(
      runClosing(sessionId, () => [
        { content: '', done: false, toolCalls: [{ id: 'c1', name: 'ask_choice', arguments: '{' }] },
        { content: '', done: true },
      ]),
    ).resolves.toBeDefined();
    expect(listPendingChoices(sessionId)).toHaveLength(0);
  });
});
