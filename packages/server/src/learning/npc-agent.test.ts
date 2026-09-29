/**
 * learning/npc-agent — 伙伴智能体：工具取的事实按他脚下那格的领域过滤、按用户隔离；
 * ★ 循环：模型要查 ⇒ 执行工具、结果以（系统）消息喂回、第二轮给出回答；同一工具一轮对话只执行一次；
 * 最后一轮不给工具；动作清单回给前端；上游失败 ⇒ 降级台词且不带动作。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const aiText = vi.hoisted(() => vi.fn());
vi.mock('../ai/gateway.js', async (orig) => ({ ...(await orig<object>()), aiText }));
vi.mock('./npc-genesis.js', async (orig) => ({ ...(await orig<object>()), resolveNpcTarget: () => ({ model: 'm', apiKey: 'k' }) }));

const { openIsolated, closeDb, getDb } = await import('../storage/db.js');
const { saveOneTerm } = await import('./terms.js');
const { recordMisconception } = await import('./learner-model.js');
const { recallLearnerState, relatedTermsOf } = await import('./npc-agent-tools.js');
const { npcTalk } = await import('./npc-talk.js');
import type { NpcView } from './npc.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-npcagent-'));
  openIsolated(dir);
  aiText.mockReset();
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const U = 'u1';
const ctx = (over: Partial<{ term: string; domain: string; ownerId: string }> = {}) => ({ ownerId: U, npcId: 'n1', term: '暗反应', domain: '生物', ...over });
const npc = { id: 'n1', name: '小叶', term: '暗反应', termId: 't', domain: '生物', bio: '', threat: null, distressed: false } as unknown as NpcView;

describe('工具：recall_learner_state / related_terms', () => {
  it('★ 误区只取这块地所属领域的；别人的看不到', () => {
    const bio = saveOneTerm('光反应', '…', '生物', U);
    const his = saveOneTerm('辛亥革命', '…', '历史', U);
    recordMisconception(U, { termId: bio.id, topic: '', note: '以为暗反应只在夜里进行' });
    recordMisconception(U, { termId: his.id, topic: '', note: '以为辛亥革命完成了反封建任务' });
    const other = saveOneTerm('光反应', '…', '生物', 'u2');
    recordMisconception('u2', { termId: other.id, topic: '', note: '别人的误区' });
    const out = recallLearnerState(ctx());
    expect(out).toContain('以为暗反应只在夜里进行');
    expect(out).not.toContain('辛亥革命');
    expect(out).not.toContain('别人的误区');
    expect(recallLearnerState(ctx({ domain: '化学' }))).toContain('没有记录在案的误区');
  });

  it('关系：按脚下词条名找到自己的词条，列出关系；没有就照实说', () => {
    const a = saveOneTerm('暗反应', '…', '生物', U);
    const b = saveOneTerm('光反应', '…', '生物', U);
    getDb().prepare(`INSERT INTO term_edge (id, owner_id, a_id, b_id, relation, note) VALUES ('e1', ?, ?, ?, 'prerequisite', '提供 ATP')`).run(U, b.id, a.id);
    expect(relatedTermsOf(ctx())).toContain('光反应');
    expect(relatedTermsOf(ctx({ term: '不存在' }))).toContain('还没连上');
  });
});

describe('npcTalk 智能体循环', () => {
  it('★ 查记忆 ⇒ 工具结果喂回 ⇒ 第二轮回答；动作回给前端；最后一轮不给工具', async () => {
    const bio = saveOneTerm('光反应', '…', '生物', U);
    recordMisconception(U, { termId: bio.id, topic: '', note: '以为暗反应只在夜里进行' });
    aiText
      .mockResolvedValueOnce({ ok: true, text: '', toolCalls: [{ name: 'recall_learner_state', arguments: '{}' }] })
      .mockResolvedValueOnce({ ok: true, text: '你之前把暗反应当成夜里的事啦。', toolCalls: [] });
    const r = await npcTalk({ ownerId: U, npc, text: '我哪里不熟？' });
    expect(r.source).toBe('ai');
    expect(r.reply).toContain('夜里');
    expect(r.actions).toEqual([{ tool: 'recall_learner_state', label: '看了看你的记忆' }]);
    const second = aiText.mock.calls[1]![0] as { messages: Array<{ content: string }>; tools?: unknown };
    expect(second.messages.at(-1)!.content).toContain('以为暗反应只在夜里进行');
    expect(second.tools).toBeDefined(); // 第 2 轮仍可再查别的
  });

  it('★ 同一工具只执行一次；到第 3 轮不再给工具', async () => {
    aiText.mockResolvedValue({ ok: true, text: '嗯…', toolCalls: [{ name: 'related_terms', arguments: '{}' }] });
    aiText.mockResolvedValueOnce({ ok: true, text: '', toolCalls: [{ name: 'related_terms', arguments: '{}' }] });
    aiText.mockResolvedValueOnce({ ok: true, text: '', toolCalls: [{ name: 'recall_learner_state', arguments: '{}' }] });
    aiText.mockResolvedValueOnce({ ok: true, text: '好了，说完了。', toolCalls: [] });
    const r = await npcTalk({ ownerId: U, npc, text: '和什么有关？' });
    expect(r.actions?.map((a) => a.tool)).toEqual(['related_terms', 'recall_learner_state']);
    expect(aiText).toHaveBeenCalledTimes(3);
    expect((aiText.mock.calls[2]![0] as { tools?: unknown }).tools).toBeUndefined();
    expect(r.reply).toBe('好了，说完了。');
  });

  it('上游失败 ⇒ 降级台词、不带动作、不落库', async () => {
    aiText.mockResolvedValue({ ok: false, error: 'boom', reason: 'upstream' });
    const r = await npcTalk({ ownerId: U, npc, text: '在吗' });
    expect(r.source).toBe('fallback');
    expect(r.actions).toBeUndefined();
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c).toBe(0);
  });
});
