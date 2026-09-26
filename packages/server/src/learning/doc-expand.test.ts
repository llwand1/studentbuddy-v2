/**
 * learning/doc-expand 单测（契约 DOC-RAG-SPEC §10）。
 *
 * 三组用例各有使命：
 * ① **回落矩阵**——扩展失败的每一种姿势（无资料／短资料／抛错／空正文／超时／用户停止）
 *    都必须**逐字退回原话**，其中"无资料与短资料一次模型调用都不发"是成本保底；
 * ② **召回机制锁**——直接拿产品实现 `retrieveDoc` 证「原话召不回、扩完召得回」。
 *    ★ 这条是本批存在的唯一理由：它红了就说明"查询扩展"这个前提没了，整批该删，
 *      而不是去改断言（同 `doc-retrieve.test.ts` 的 T8 召回锁一个口径）。
 * ③ **接线锁**——`docQuery` 必须真的改变注入的资料段，且只改 `doc` 那一段。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatRequest, TokenChunk } from '../llm/types.js';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-doc-expand-test-'));
const { getDb, closeDb } = await import('../storage/db.js');
const { setSessionDoc, MAX_DOC_CHARS } = await import('./document.js');
const { expandDocQuery, DOC_EXPAND_MAX_TERMS_CHARS } = await import('./doc-expand.js');
const { retrieveDoc, chunkDoc } = await import('./doc-retrieve.js');
const { collectContextSegments } = await import('../chat/context-segments.js');
const { saveOneTerm } = await import('./terms.js');

function newSession(): string {
  const id = `s-${Math.random().toString(36).slice(2)}`;
  getDb().prepare(`INSERT INTO sessions (id) VALUES (?)`).run(id);
  return id;
}

afterAll(() => closeDb());

/** 假适配器：记录每次入参（★ 断言"没发过调用"要靠它，不靠猜） */
function fakeAdapter(script: { content?: string; throws?: boolean; delayMs?: number } = {}) {
  const calls: ChatRequest[] = [];
  const adapter = {
    type: 'openai' as const,
    async *chat(req: ChatRequest): AsyncIterable<TokenChunk> {
      calls.push(req);
      if (script.throws) throw new Error('上游炸了');
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      if (req.signal?.aborted) return; // 已被掐断：什么都不吐（等价真实适配器的行为）
      yield { content: script.content ?? '', done: true };
    },
    async listModels(): Promise<string[]> {
      return [];
    },
  };
  return { adapter, calls };
}

function targetFor(adapter: unknown) {
  return { adapter, model: 'test-model', apiKey: 'k', baseUrl: 'http://example.invalid' } as never;
}

// ── 一份"产品口径"的合成长资料（②③两组共用）────────────────────────────
/**
 * 造这份语料的唯一目的：让「答案块」在**学生原话**下排不进前 12，在**教材术语**下排第一。
 * 形状照离线探针的改写型漏接抄：干扰段全是口语（扔/掉/地面/跑得快），答案段只用教材词。
 * ★ 术语串逐字取自金样本 `tools/probes/doc-rag-rewrites.json` 第 2 章那条（`ch: 2`）。
 * ★ 体量必须越过 `MAX_DOC_CHARS`（实测 61,620 字 / 82 块），否则走的是整篇直塞、断言全是空转。
 */
const PARA = '扔出去的东西要跑多快才不会掉回地面';
const TERMS = '第一宇宙速度、近地卫星、环绕速度、万有引力、向心力、最小发射速度、7.9km/s';
const ANSWER_MARK = '第一宇宙速度：';
const ANSWER_SECTION =
  '第 X 节　航天专题　第一宇宙速度：把近地卫星的轨道半径近似取为地球半径，由万有引力提供向心力解出的最小发射速度，数值约 7.9km/s，它同时是该轨道上的环绕速度。　下一小节比较第二、第三宇宙速度。';

const COLLOQ = [
  '东西扔出去总会掉回地面，是因为地面附近的物体都被地球往回拉，扔得越快它飞得越远，落点也越远。',
  '你在车里跑得快，风把手往后推；同样的道理，物体在地面上滑得越快，阻力越大，最后停下来。',
  '为什么跳起来还会落回原地？地面在带着你一起跑，你上去的那几秒里地面也往前跑了同样的一段。',
  '把石头扔向远处，它走的是一条弯的线；扔得越用力，这条线被拉得越平，落地点离你越远。',
  '从高台上水平推一个东西，它在竖直方向掉得快慢和重量没关系，两种东西会同时着地。',
  '地面附近的物体都被地球往回拉，这个拉力大小跟质量成正比，所以重物体和轻物体掉得一样快。',
  '你跑得再快也不会离开地面，是因为地球一直把你拉回来；只有速度非常非常高，这条落回地面的线才会绕着地球弯成一圈。',
  '炮弹打出去会掉回来，射程取决于出膛的快慢和打出去的角度，四十五度时最远。',
  '把球踢得越高，它在空中待的时间越长，可它总会掉回地面，因为地球一直在拉它。',
  '东西在电梯里觉得变重还是变轻，取决于电梯跑得快慢有没有在变化，匀速的时候和站在地面一样。',
];
const OTHER = [
  '化学平衡那一节讲转化率与平衡常数：温度、浓度、压强的改变都会让平衡移动，但催化剂不会。',
  '光的干涉用双缝演示，亮纹间距和波长成正比、和双缝到屏的距离成正比，所以红光比紫光宽。',
  '原电池里负极发生氧化反应，电子从负极经外电路跑到正极，溶液里靠离子移动导电。',
  '气体的压强来自大量分子对器壁的频繁撞击，温度升高时分子平均动能变大，撞击也更凶。',
  '放射性样品的半衰期描述的是统计规律，三个原子核谈不上半衰期，样本越大越准。',
  '通电导线在磁场里受力的方向用左手判断，把电流方向和磁场方向都反过来，受力方向不变。',
  '电容器储存的电荷量和它两端的电压成正比，这个比值就叫电容，单位是法拉。',
  '地图上等高线越密坡度越陡；河流总从高处往低处流，所以在山脊线两侧分开。',
  '植物在光照下同时进行光合作用和呼吸作用，光强低于补偿点时反而消耗有机物。',
  '需求曲线向右下方倾斜，价格上升买的人少；供给曲线向右上方倾斜，价格高时厂家愿意多产。',
  '浮力大小等于排开液体受到的重力，所以同一艘船在淡水里比在海里吃水更深一些。',
  '杠杆平衡时两侧的力臂和力成反比，动力臂长就省力，但是要多费一段距离。',
];
const LONG_DOC = (() => {
  const paras: string[] = [];
  for (let i = 0; i < 650; i++) {
    const pool = i % 3 === 2 ? OTHER : COLLOQ;
    const body = pool[i % pool.length] as string;
    paras.push(`第 ${i + 1} 节 要点梳理：${body} 本节练习：用自己的话说清这一条，再各举一个生活里的例子。（第 ${i + 1} 节完）`);
  }
  paras.splice(150, 0, ANSWER_SECTION);
  return paras.join('\n\n');
})();
const SHORT_TEXT = '这是一篇很短的资料，整篇直塞就够。';

describe('回落矩阵：任何不划算或不确定的情形都逐字退回原话', () => {
  it('会话没挂资料 ⇒ 原样返回，且一次模型调用都不发', async () => {
    const s = newSession();
    const { adapter, calls } = fakeAdapter({ content: '重力加速度' });
    const out = await expandDocQuery('今天学什么', targetFor(adapter), s, null);
    expect(out).toBe('今天学什么');
    expect(calls).toHaveLength(0);
  });

  it('资料短于直塞阈值 ⇒ 原样返回、零调用（★ 等价现状锁：短文档档一个字都不该变）', async () => {
    const s = newSession();
    setSessionDoc(s, 'short.md', SHORT_TEXT, null);
    const { adapter, calls } = fakeAdapter({ content: '重力加速度' });
    const out = await expandDocQuery('整篇直塞够用吗', targetFor(adapter), s, null);
    expect(out).toBe('整篇直塞够用吗');
    expect(calls).toHaveLength(0);
    expect(SHORT_TEXT.length).toBeLessThanOrEqual(MAX_DOC_CHARS);
  });

  it('长资料 + 模型正常返回 ⇒ 原话后面拼上术语', async () => {
    const s = newSession();
    setSessionDoc(s, 'long.md', LONG_DOC, null);
    const { adapter, calls } = fakeAdapter({ content: `\n\n${TERMS}\n` });
    const out = await expandDocQuery(PARA, targetFor(adapter), s, null);
    expect(out).toBe(`${PARA} ${TERMS}`);
    expect(calls).toHaveLength(1);
    // ★ 不许开小 maxTokens：思考链模型会把小预算全花在 reasoning 上、content 返空串
    expect(calls[0]!.maxTokens!).toBeGreaterThan(1024);
    expect(calls[0]!.streamMode).toBe('once');
  });

  it('适配器抛错 ⇒ 原话（扩展失败不许把整轮回答带崩）', async () => {
    const s = newSession();
    setSessionDoc(s, 'long.md', LONG_DOC, null);
    const { adapter } = fakeAdapter({ throws: true });
    expect(await expandDocQuery('它会不会把对话搞挂', targetFor(adapter), s, null)).toBe('它会不会把对话搞挂');
  });

  it('模型返空正文 ⇒ 原话（实测 13 条里有 5 条这样死）', async () => {
    const s = newSession();
    setSessionDoc(s, 'long.md', LONG_DOC, null);
    const { adapter } = fakeAdapter({ content: '   \n  ' });
    expect(await expandDocQuery('空正文怎么办', targetFor(adapter), s, null)).toBe('空正文怎么办');
  });

  it('超过挂钟上限 ⇒ 原话，且那次调用确实被掐了 signal', async () => {
    const s = newSession();
    setSessionDoc(s, 'long.md', LONG_DOC, null);
    const { adapter, calls } = fakeAdapter({ content: '慢到的术语', delayMs: 300 });
    const out = await expandDocQuery('慢响应怎么办', targetFor(adapter), s, null, { timeoutMs: 30 });
    expect(out).toBe('慢响应怎么办');
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it('外部 signal 已 abort ⇒ 原话且不发调用（用户按了停止就别再花一次额度）', async () => {
    const s = newSession();
    setSessionDoc(s, 'long.md', LONG_DOC, null);
    const ac = new AbortController();
    ac.abort();
    const { adapter, calls } = fakeAdapter({ content: '术语' });
    const out = await expandDocQuery('停止之后', targetFor(adapter), s, null, { signal: ac.signal });
    expect(out).toBe('停止之后');
    expect(calls).toHaveLength(0);
  });

  it('模型话痨 ⇒ 术语串被字数闸截住（实测正常量 23–48 字，闸在 120）', async () => {
    const s = newSession();
    setSessionDoc(s, 'long.md', LONG_DOC, null);
    const { adapter } = fakeAdapter({ content: `好、${'词'.repeat(400)}` });
    const out = await expandDocQuery('问句', targetFor(adapter), s, null);
    expect(out.startsWith('问句 好、')).toBe(true);
    expect(out.slice('问句 '.length)).toHaveLength(DOC_EXPAND_MAX_TERMS_CHARS);
  });

  it('空问句 ⇒ 原样返回且不发调用', async () => {
    const s = newSession();
    setSessionDoc(s, 'long.md', LONG_DOC, null);
    const { adapter, calls } = fakeAdapter({ content: '术语' });
    expect(await expandDocQuery('   ', targetFor(adapter), s, null)).toBe('   ');
    expect(calls).toHaveLength(0);
  });
});

describe('召回机制锁：产品实现 `retrieveDoc` 上「原话召不回、扩完召得回」', () => {
  const hitsTarget = (query: string) =>
    retrieveDoc(LONG_DOC, query, { k: 12 }).some((c) => c.text.includes(ANSWER_MARK));

  it('前提：语料真的越过直塞阈值、块数远超 k（否则下面两条都在测整篇直塞，等于没锁）', () => {
    expect(LONG_DOC.length).toBeGreaterThan(MAX_DOC_CHARS);
    expect(chunkDoc(LONG_DOC).length).toBeGreaterThan(60);
  });

  it('★ 只拿学生原话检索 ⇒ 答案块进不了前 12（这就是今天要治的病）', () => {
    expect(hitsTarget(PARA)).toBe(false);
  });

  it('★ 扩过教材术语 ⇒ 同一份语料、同一个 k，答案块进来了', () => {
    expect(hitsTarget(`${PARA} ${TERMS}`)).toBe(true);
  });
});

describe('接线锁：`docQuery` 只改 doc 段，词条段照旧吃原话', () => {
  const s = newSession();
  setSessionDoc(s, 'long.md', LONG_DOC, null);
  saveOneTerm('地面', '课本里"地面附近"默认指海平面附近，g 取 9.8。', '物理', null);

  const segmentsOf = (docQuery?: string) =>
    collectContextSegments({ history: [], sessionId: s, text: PARA, docQuery, ownerId: null }).segments;

  it('传与不传 docQuery ⇒ doc 段确实不同，且差别就是答案块进没进来', () => {
    const raw = segmentsOf().find((x) => x.kind === 'doc')?.content ?? '';
    const expanded = segmentsOf(`${PARA} ${TERMS}`).find((x) => x.kind === 'doc')?.content ?? '';
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).not.toContain(ANSWER_MARK);
    expect(expanded).not.toBe(raw);
    expect(expanded).toContain(ANSWER_MARK);
  });

  it('★ 不传 docQuery ⇒ 与"传了原话"逐字相同（缺省即旧行为）', () => {
    expect(segmentsOf().find((x) => x.kind === 'doc')?.content).toBe(
      segmentsOf(PARA).find((x) => x.kind === 'doc')?.content,
    );
  });

  it('词条段不受 docQuery 影响，且非空（本批只在文档一路量过增益，另一路不许顺手动）', () => {
    const termsOf = (docQuery?: string) =>
      segmentsOf(docQuery).find((x) => x.kind === 'terms')?.content ?? '';
    expect(termsOf()).toContain('地面'); // 词条段为空的话，下面那条相等断言就是空转
    expect(termsOf(`${PARA} ${TERMS}`)).toBe(termsOf());
  });
});
