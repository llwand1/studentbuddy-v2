/** 真路由 + 真库 + 真网关，假上游：锁现场出题、刷新排重、归属与不落聊天。 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, validateQuestionSeedBatch, startPomodoro } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-opener-'));
const llm = vi.hoisted(() => ({ ready: true, reply: [] as string[], calls: [] as string[], caps: [] as Array<number | undefined>, finishes: [] as string[], verdicts: [] as boolean[], checked: [] as string[], fail: '' }));
vi.mock('../llm/router.js', async importOriginal => ({
  ...await importOriginal<typeof import('../llm/router.js')>(),
  routeRole: (role: string) => llm.ready ? {
    model: 'test-model', apiKey: 'test', baseUrl: 'http://127.0.0.1:1/v1', streamMode: 'once' as const,
    adapter: { type: 'openai' as const, async *chat(req: { messages: Array<{ content: string }>; maxTokens?: number }) {
      if (role === 'solver') {
        llm.checked.push(req.messages.at(-1)?.content ?? '');
        yield { content: JSON.stringify({ valid: llm.verdicts.shift() ?? true, reason: '存在两个等价正确选项，不能只选更直接的定义。' }), done: true };
        return;
      }
      llm.calls.push(req.messages.map(m => m.content).join('\n'));
      llm.caps.push(req.maxTokens);
      if (llm.fail) throw new Error(llm.fail);
      yield { content: llm.reply.shift() ?? 'bad-json', done: true, finishReason: llm.finishes.shift() ?? 'stop' };
    }, async listModels() { return []; } },
  } : null,
}));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession } = await import('../auth/session.js');
const { saveExamMode, saveExamScope } = await import('../learning/exam-mode.js');
const { importSeeds, listSeeds } = await import('../learning/question-seeds.js');
const { savePomodoro } = await import('../storage/pomodoro.js');
const request = (await import('supertest')).default;
const origin = 'http://localhost:5173';
const q = (question = '公平硬币下一次出现正面的概率是多少？') => JSON.stringify({ topic: '概率', question, options: ['25%', '50%', '75%'], answer: 1, explanation: '每一次抛掷独立，正面概率是 50%。' });
const post = (body: object = {}, cookie?: string) => {
  const r = request(app).post('/api/chat/opener').set('Origin', origin);
  return (cookie ? r.set('Cookie', cookie) : r).send(body);
};
beforeEach(() => {
  llm.ready = true; llm.reply = []; llm.calls = []; llm.caps = []; llm.finishes = []; llm.verdicts = []; llm.checked = []; llm.fail = '';
  getDb().prepare("DELETE FROM app_settings WHERE key IN ('campfire_opener_seen', 'exam_mode', 'exam_sources')").run();
  getDb().prepare("DELETE FROM app_settings WHERE key GLOB 'question_seed*' OR key='pomodoro'").run();
});
afterAll(closeDb);

describe('篝火现场召题', () => {
  const addSeed = (math = true) => {
    const v = validateQuestionSeedBatch({ batchId: 'b', seeds: [{ externalId: 'seed', topic: math ? '一元一次方程' : '概率', domain: math ? 'math' : 'general', tags: math ? ['数学'] : ['概率'], objective: '理解与练习考点', facts: ['等可能结果的概率由结果数比例计算'], rubric: ['解释正确原因'], variations: ['更换情境与参数'], types: ['single'], validUntil: new Date(Date.now() + 86400000).toISOString(), ...(math ? { recipe: { kind: 'linear-equation', coefficients: [-2, 2], constants: [-1, 1], solutions: [-3, 3] } } : {}) }] });
    if (!v.ok) throw new Error(v.error); importSeeds(v.value, null);
  };
  it('预产物参数现场生成两道不同新题，无模型请求也可交付且仍防重', async () => {
    addSeed(); llm.ready = false;
    const first = await post().expect(200), second = await post({ exclude: [first.body.question.question] }).expect(200);
    expect(second.body.question.question).not.toBe(first.body.question.question);
    expect(first.body.preparation.mode).toBe('compiled'); expect(llm.calls).toHaveLength(0); expect(llm.checked).toHaveLength(0);
    expect(listSeeds(null)[0]!.used).toHaveLength(2);
  });
  it('一般蓝图仍现场创作并独立核对，成功后才记使用', async () => {
    addSeed(false); llm.reply = [q()]; const r = await post().expect(200);
    expect(r.body.preparation.mode).toBe('material'); expect(llm.calls[0]).toContain('等可能结果'); expect(llm.checked).toHaveLength(1);
    expect(listSeeds(null)[0]!.uses).toBe(1);
  });
  it('专注方向不匹配预产物时退回原出题，不强行召数学题', async () => {
    addSeed(); savePomodoro(startPomodoro({ subject: '英语' }, new Date()), null); llm.reply = [q()];
    const r = await post().expect(200); expect(r.body.preparation).toBeUndefined(); expect(llm.calls).toHaveLength(1);
    expect(listSeeds(null)[0]!.uses).toBe(0);
  });
  it('审题发现多解后把具体错因回喂，只交付重新创作且独立核对通过的题', async () => {
    llm.reply = [q('哪个条件等价于线性无关？'), q('公平骰子出现偶数的概率是多少？')];
    llm.verdicts = [false, true];
    const r = await post().expect(200);
    expect(r.body.question.question).toBe('公平骰子出现偶数的概率是多少？');
    expect(llm.checked).toHaveLength(2);
    expect(llm.calls[1]).toContain('两个等价正确选项');
  });
  it('两次审题均未通过，错误题不交付、不占近期题摘要', async () => {
    llm.reply = [q('未通过的题一？'), q('未通过的题二？')]; llm.verdicts = [false, false];
    const r = await post().expect(502);
    expect(r.body.question).toBeUndefined();
    expect(getDb().prepare("SELECT value FROM app_settings WHERE key = 'campfire_opener_seen'").get()).toBeUndefined();
  });
  it('真实截断式 JSON 提高上限重创作一次，只交付完整新题', async () => {
    llm.reply = ['{"topic":"概率","question":', q('骰子掷出偶数的概率是多少？')];
    llm.finishes = ['length', 'stop'];
    const result = await post().expect(200);
    expect(result.body.question.question).toBe('骰子掷出偶数的概率是多少？');
    expect(llm.caps).toEqual([2048, 4096]);
    expect(llm.calls).toHaveLength(2);
  });
  it('现场调模型，no-store，题不落会话或消息，摘要不含原题', async () => {
    llm.reply = [q()];
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM messages').get();
    const r = await post().expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.question.answer).toBe(1);
    expect(llm.calls).toHaveLength(1);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual(before);
    const saved = getDb().prepare("SELECT value FROM app_settings WHERE key = 'campfire_opener_seen'").get() as { value: string };
    expect(saved.value).not.toContain('硬币');
  });
  it('刷新请求不带旧题也会拦住重复，修复一次改成新题再交付', async () => {
    llm.reply = [q()];
    const first = await post().expect(200);
    llm.reply = [q(), q('公平骰子掷出 6 的概率是多少？')];
    const second = await post().expect(200);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.question.question).not.toBe(first.body.question.question);
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[0]).not.toEqual(llm.calls[1]);
  });
  it('修复后仍是旧题就失败，响应没有可回显旧题', async () => {
    llm.reply = [q(), q()];
    const r = await post({ exclude: ['公平硬币下一次出现正面的概率是多少？'] }).expect(502);
    expect(r.body.question).toBeUndefined();
    expect(llm.calls).toHaveLength(2);
  });
  it('非法输入在模型调用前拒绝', async () => {
    await post({ exclude: Array(9).fill('旧题') }).expect(400);
    expect(llm.calls).toHaveLength(0);
  });
  it('真实模型式代码围栏触发重新出题，只交付合格纯文字题', async () => {
    llm.reply = [q('Python 中下面代码的结果是什么？\n```python\nlen([1, 2])\n```'), q('Python 中 len([1, 2]) 的返回值是多少？')];
    const result = await post().expect(200);
    expect(result.body.question.question).toBe('Python 中 len([1, 2]) 的返回值是多少？');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]).toContain('不含 Markdown 代码围栏');
  });
  it('没模型给可行动的错误，上游失败不会回固定题', async () => {
    llm.ready = false;
    const missing = await post().expect(503);
    expect(missing.body.error).toContain('设置');
    llm.ready = true; llm.fail = 'test upstream offline';
    const broken = await post().expect(502);
    expect(broken.body.question).toBeUndefined();
    expect(broken.body.error).toContain('test upstream offline');
  });
  it('应试范围与排重按当前账号隔离，客户端自报范围无效', async () => {
    const a = await createUser('opener-a@test.example', 'password-good-123', undefined);
    const b = await createUser('opener-b@test.example', 'password-good-123', undefined);
    const cookie = (id: string) => `${AUTH_COOKIE_NAME}=${createSession(id).token}`;
    saveExamMode(true, a.id); saveExamScope({ packs: ['kaoyan'], custom: [] }, a.id);
    llm.reply = [q(), q()];
    const ra = await post({}, cookie(a.id)).expect(200);
    const rb = await post({ scope: 'A 私有范围' }, cookie(b.id)).expect(200);
    expect(ra.body.scope).toContain('考研');
    expect(rb.body.scope).toBe('');
    expect(llm.calls[0]).toContain('考研');
    expect(llm.calls[1]).not.toContain('A 私有范围');
    expect(llm.calls).toHaveLength(2);
  });
  it('跨源调用仍由既有 Origin 闸门拒绝', async () => {
    await request(app).post('/api/chat/opener').set('Origin', 'https://evil.example.com').send({}).expect(403);
    expect(llm.calls).toHaveLength(0);
  });
});
