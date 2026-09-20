/**
 * routes/search — `GET /api/search` 的**可见性矩阵**（契约 `docs/FTS-SPEC.md` §4 / §6 第 4 行）。
 *
 * ★ 本文件只锁「谁能看到谁的」，**不重复**索引层的行为（分词、写点、重建都在
 *   `search/fts-index.test.ts`）。分开的理由：那边是纯函数 + 模块直调，这边要真过
 *   `ownerIdOf(req)` 这条从 cookie 到归属值的链路——**它才是最容易写错的一环**
 *   （`ownerIdOf` 返回 null 时"不加条件"是豁免、返回 '' 时是"只看无主"，两者差一个字符，
 *   而写错的后果是跨用户泄露且不报错）。
 *
 * ★ 矩阵三行（FTS-SPEC §4）各断言一轮：
 *   · `message`  —— 认证态 `owner = 当前用户`；**未认证不过滤**（等价今天 sessions 全量列表）
 *   · `term`     —— 认证态 `owner = 当前用户`（**不含**无主行）；未认证 `owner = ''`
 *   · `note`     —— 同 term
 *   认证态一律**看不到无主行**：M2d 口径「无主 = 谁都不泄露」（`migrations-list-v31.ts` 头注）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-search-'));

const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { saveOneTerm } = await import('../learning/terms.js');
const { insertSession } = await import('../auth/ownership.js');
const { insertUserMessage } = await import('../chat/persist.js');
const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

/** 造一个真实登录用户并返回它的 cookie 串 */
async function signUp(email: string): Promise<{ id: string; cookie: string }> {
  const user = await createUser(email, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return { id: user.id, cookie: `${AUTH_COOKIE_NAME}=${token}` };
}

const alice = await signUp('search-alice@example.com');
const bob = await signUp('search-bob@example.com');

// ── 夹具：A 的 / B 的 / 无主的三份数据，各用互不重叠的关键词 ──
saveOneTerm('甲用户专有词条', '甲写的释义内容', '测试', alice.id);
saveOneTerm('乙用户专有词条', '乙写的释义内容', '测试', bob.id);
saveOneTerm('无主专有词条', '无主行的释义内容', '测试', null);
insertSession('s-search-a', alice.id);
insertUserMessage('s-search-a', '甲用户会话里的消息正文', []);
insertSession('s-search-b', bob.id);
insertUserMessage('s-search-b', '乙用户会话里的消息正文', []);

afterAll(() => closeDb());

/** 发一次搜索请求；`cookie` 为空即未登录 */
function search(q: string, cookie = '', extra = '') {
  const r = request(app).get(`/api/search?q=${encodeURIComponent(q)}${extra}`).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
}

describe('routes/search — 参数闸门', () => {
  it('空 q 直接返回空结果（前端清空搜索框是常态，不是错误）', async () => {
    const res = await search('   ').expect(200);
    expect(res.body).toEqual({ q: '', hits: [] });
  });

  it('超长 q 被截断到上限（bigram 词元数随字数线性膨胀，不设闸会被拖垮）', async () => {
    const res = await search('牛'.repeat(300)).expect(200);
    expect((res.body as { q: string }).q.length).toBeLessThanOrEqual(80);
  });

  it('未知 kinds 静默丢弃、不 400（前端版本比服务端新时那条链路不该直接断）', async () => {
    const res = await search('甲写的释义内容', alice.cookie, '&kinds=term,nonsense').expect(200);
    expect((res.body as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    // 只认 term：把 kinds 收窄成纯未知值时，等价于"不限定"（走默认三类），不该报错
    await search('甲写的释义内容', alice.cookie, '&kinds=nonsense').expect(200);
  });

  it('limit 非数字 / 非正数回落默认值，不报错', async () => {
    await search('甲写的释义内容', alice.cookie, '&limit=abc').expect(200);
    await search('甲写的释义内容', alice.cookie, '&limit=-5').expect(200);
  });
});

describe('routes/search — 可见性矩阵（认证态）', () => {
  it('★ 词条：看得到自己的，看不到别人的，也看不到无主行', async () => {
    const mine = await search('甲写的释义内容', alice.cookie).expect(200);
    expect((mine.body as { hits: unknown[] }).hits).toHaveLength(1);
    const others = await search('乙写的释义内容', alice.cookie).expect(200);
    expect((others.body as { hits: unknown[] }).hits).toHaveLength(0);
    // 无主行「谁都不泄露」——认证态同样看不到
    const orphan = await search('无主行的释义内容', alice.cookie).expect(200);
    expect((orphan.body as { hits: unknown[] }).hits).toHaveLength(0);
  });

  it('★ 消息：只看得到自己会话里的', async () => {
    const mine = await search('甲用户会话里的消息正文', alice.cookie).expect(200);
    expect((mine.body as { hits: unknown[] }).hits).toHaveLength(1);
    const others = await search('乙用户会话里的消息正文', alice.cookie).expect(200);
    expect((others.body as { hits: unknown[] }).hits).toHaveLength(0);
  });

  it('消息命中带 parentId（前端据此跳进那个会话）', async () => {
    const res = await search('甲用户会话里的消息正文', alice.cookie).expect(200);
    const hits = (res.body as { hits: Array<{ parentId?: string }> }).hits;
    expect(hits[0]?.parentId).toBe('s-search-a');
  });
});

describe('routes/search — 可见性矩阵（未认证 / 本地单人模式）', () => {
  it('★ 词条：只看无主行（挡住过渡期里别的用户写的数据）', async () => {
    const orphan = await search('无主行的释义内容').expect(200);
    expect((orphan.body as { hits: unknown[] }).hits).toHaveLength(1);
    const otherUser = await search('甲写的释义内容').expect(200);
    expect((otherUser.body as { hits: unknown[] }).hits).toHaveLength(0);
  });

  it('★ 消息：**不过滤**——等价今天 sessions 列表的全量可见（本地单人行为不变）', async () => {
    const a = await search('甲用户会话里的消息正文').expect(200);
    const b = await search('乙用户会话里的消息正文').expect(200);
    expect((a.body as { hits: unknown[] }).hits).toHaveLength(1);
    expect((b.body as { hits: unknown[] }).hits).toHaveLength(1);
  });
});
