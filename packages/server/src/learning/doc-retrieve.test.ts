/**
 * learning/doc-retrieve 单测（契约 DOC-RAG-SPEC §6 T1~T5、T8）。
 * 纯函数、不碰 DB（故不需要临时 SB_DATA_DIR）；检索层是确定性的，所以召回能当回归锁用。
 */
import { describe, it, expect } from 'vitest';
import {
  bm25Retriever,
  buildBm25Index,
  chunkDoc,
  getRetriever,
  joinChunks,
  pickUniformChunks,
  retrieveDoc,
  scoreChunks,
  tokenizeDoc,
} from './doc-retrieve.js';
import { DOC_CHUNK_CHARS, DOC_CHUNK_OVERLAP } from '@sb/shared';

describe('tokenizeDoc 分词', () => {
  it('英文按词、数字成词、中文按 bigram 切', () => {
    const toks = tokenizeDoc('牛顿第二定律 F=ma 与 9.8 无关');
    expect(toks).toEqual(expect.arrayContaining(['牛顿', '顿第', '第二', '二定', '定律', 'f', 'ma', '9.8', '与', '无关']));
    expect(toks).not.toContain('无与'); // 跨空白的字不该被粘成词元
  });
  it('单个汉字原样保留（否则「熵」这种单字词全体漏切）', () => {
    expect(tokenizeDoc('熵 H2O')).toEqual(expect.arrayContaining(['熵', 'h2o']));
  });
  it('标点与空白既不成词也不产字（它们不该参与相关性打分）', () => {
    expect(tokenizeDoc('——  …  ；')).toEqual([]);
  });
});

describe('chunkDoc 切块', () => {
  const para = (s: string): string => s.repeat(30); // 每段 30 字

  it('块偏移能 slice 回原文（出处定位的前提）', () => {
    const doc = ['第一节', para('甲'), para('乙'), para('丙'), para('丁')].join('\n\n');
    const chunks = chunkDoc(doc, 100, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(doc.slice(c.from, c.to).trim()).toBe(c.text);
  });

  it('overlap=0 时不丢字：所有块去空白拼接 = 全文去空白', () => {
    const doc = [para('爱'), para('因'), para('梦'), para('洛'), para('兹')].join('\n\n');
    const joined = chunkDoc(doc, 120, 0).map((c) => c.text).join('');
    expect(joined.replace(/\s+/g, '')).toBe(doc.replace(/\s+/g, ''));
  });

  it('整篇无换行的粘贴件走定长硬切；overlap>0 能把跨界那句救回来', () => {
    // 标记词 '核心理物' 刻意横跨第 100 个字这个边界
    const flat = '物'.repeat(98) + '核心理物' + '物'.repeat(89);
    expect(flat.length).toBe(191);
    const noOverlap = chunkDoc(flat, 100, 0); // 步长 100 → 块 [0,100) [100,191) → 标记被劈开
    const withOverlap = chunkDoc(flat, 100, 40); // 步长 60 → 块 [0,60) [60,120) … → 标记完整落在第二块
    expect(noOverlap.length).toBeGreaterThan(1);
    expect(noOverlap.some((c) => c.text.includes('核心理物'))).toBe(false);
    expect(withOverlap.some((c) => c.text.includes('核心理物'))).toBe(true);
    for (const c of withOverlap) {
      expect(c.text.length).toBeLessThanOrEqual(100);
      expect(c.text).toBe(flat.slice(c.from, c.to)); // 硬切后的偏移必须仍对得上原文
    }
  });

  it('空白正文切不出块，不抛错', () => {
    expect(chunkDoc('   \n\n  \n  ', 100, 10)).toEqual([]);
    expect(chunkDoc('', 100, 10)).toEqual([]);
  });

  it('seq 严格从 0 递增（注入段的段号靠它）', () => {
    const doc = [para('天'), para('地'), para('人'), para('鬼'), para('神')].join('\n\n');
    const chunks = chunkDoc(doc, 40, 8);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_c, i) => i));
  });
});

describe('BM25 打分', () => {
  // size=20 保证三段各自成块（块内词元数接近，idf 差异才干净）
  const chunks = chunkDoc(
    ['第一段讲牛顿运动定律的应用与例题', '第二段讲电磁感应定律的应用与例题', '第三段是完全无关的话'].join('\n\n'),
    20,
    0,
  );
  const idx = buildBm25Index(chunks);

  it('基线：三段切成三块', () => {
    expect(chunks.length).toBe(3);
    expect(idx.n).toBe(3);
  });
  it('稀有词权重必须高于常见词（idf 的本职）', () => {
    // 「电磁」只出现在第二块；「应用」两块都有
    expect(idx.idf.get('电磁') ?? 0).toBeGreaterThan(idx.idf.get('应用') ?? 0);
  });
  it('idf 恒非负：取经典式会在 df>N/2 的词上出负分，那会把命中一堆常见词的块排到零分之下', () => {
    for (const w of idx.idf.values()) expect(w).toBeGreaterThanOrEqual(0);
  });
  it('查询命中哪块，哪块就排第一', () => {
    expect(scoreChunks(idx, '电磁感应')[0]?.i).toBe(1);
  });
  it('字面零命中就是空结果——不设绝对分数阈值（阈值已被探针实测否掉，§3.3）', () => {
    expect(scoreChunks(idx, '量子色动力学')).toEqual([]);
    expect(scoreChunks(idx, '……')).toEqual([]);
  });
});

describe('retrieveDoc 编排', () => {
  /** 合成讲义：12 章，每章一条只在本章出现的冷门事实 */
  const CHAPTERS = [
    ['重力加速度', '月球表面的重力加速度约为 1.62 米每二次方秒'],
    ['宇宙速度', '第一宇宙速度的数值是 7.9 千米每秒'],
    ['碰撞', '完全非弹性碰撞中动能损失比例最大'],
    ['引力常量', '卡文迪许扭秤实验第一次测出了引力常量 G'],
    ['元电荷', '密立根油滴实验测定的是元电荷 e 的数值'],
    ['电势', '场强为零的位置电势不一定为零'],
    ['转变温度', '超导体零电阻状态对应的温度叫转变温度'],
    ['霍尔电压', '霍尔电压与载流子浓度成反比'],
    ['楞次定律', '楞次定律的本质是能量守恒定律在感应电流方向上的体现'],
    ['变压器', '理想变压器原副线圈中交流的频率保持不变'],
    ['临界角', '全反射临界角的公式是 sin C 等于 1 除以折射率 n'],
    ['半衰期', '半衰期不受温度与压强等外界条件影响'],
  ] as const;
  const FILLER = '这一节先给出定义与适用条件，再讨论边界情形下的退化行为，最后回到例题。'.repeat(8);
  const DOC = CHAPTERS.map(([t, f]) => `## ${t}\n\n${FILLER}\n\n${f}。\n\n${FILLER}`).join('\n\n');

  it('基线：语料要真的够长（否则后面的 Top-K 断言都是空转）', () => {
    expect(DOC.length).toBeGreaterThan(6000);
    expect(chunkDoc(DOC).length).toBeGreaterThan(8);
  });
  it('T8 召回锁定：每条关键词型提问，答案块必须落在前 3 块内（检索层确定性 ⇒ 能锁死）', () => {
    for (const [t, f] of CHAPTERS) {
      const found = retrieveDoc(DOC, `${t} ${f.slice(0, 8)}`, { k: 3 });
      expect(found.some((c) => c.text.includes(f)), `未召回：${t}`).toBe(true);
    }
  });
  it('答案块必须排第一（只看命中不看排序，等于没锁）', () => {
    for (const [t, f] of CHAPTERS) {
      expect(retrieveDoc(DOC, f, { k: 4 })[0]?.text, `首位不对：${t}`).toContain(f);
    }
  });
  it('k 截断生效：请求 1 块就只回 1 块', () => {
    expect(retrieveDoc(DOC, '半衰期不受温度与压强等外界条件影响', { k: 1 })).toHaveLength(1);
  });
  it('预算截断生效：装不下第二块时就只留第一块', () => {
    const query = '半衰期 温度 压强 碰撞 动能 损失';
    const many = retrieveDoc(DOC, query, { k: 8 });
    expect(many.length).toBeGreaterThan(1);
    const two = (many[0]?.text.length ?? 0) + (many[1]?.text.length ?? 0);
    expect(retrieveDoc(DOC, query, { k: 8, budgetChars: two - 1 })).toHaveLength(1);
  });
  it('首块无条件保留：预算再小也不至于什么都不注入', () => {
    expect(retrieveDoc(DOC, '半衰期不受温度与压强等外界条件影响', { k: 4, budgetChars: 1 })).toHaveLength(1);
  });
  it('空查询不检索（交回调用方决定退化成均匀取样还是别的）', () => {
    expect(retrieveDoc(DOC, '   ')).toEqual([]);
  });
  it('返回按分数降序，不是原文顺序', () => {
    const r = retrieveDoc(DOC, '卡文迪许扭秤实验第一次测出了引力常量 G', { k: 6 });
    expect(r.length).toBeGreaterThan(1);
    for (let i = 1; i < r.length; i++) expect(r[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(r[i]?.score ?? 0);
  });
  it('检索器接缝可替换：getRetriever 与 bm25Retriever 必须同源（embed 档将来只改这一处）', () => {
    expect(getRetriever()).toBe(bm25Retriever);
    expect(getRetriever().kind).toBe('bm25');
  });
});

describe('pickUniformChunks 均匀覆盖', () => {
  const DOC = Array.from({ length: 40 }, (_v, i) => `第 ${i} 段 ${'内容'.repeat(60)}`).join('\n\n');

  it('首段与末段都必须被选中——抽词条要的是覆盖面，只覆盖开头等于没改', () => {
    const r = pickUniformChunks(DOC, 8);
    expect(r.length).toBeGreaterThan(2);
    expect(r[0]?.text).toContain('第 0 段');
    expect(r[r.length - 1]?.text).toContain('第 39 段');
  });
  it('返回原文顺序、score 恒 0（它没有相关性可言）', () => {
    const r = pickUniformChunks(DOC, 6);
    expect(r.map((c) => c.seq)).toEqual([...r.map((c) => c.seq)].sort((a, b) => a - b));
    expect(r.every((c) => c.score === 0)).toBe(true);
  });
  it('要的块数超过总块数时全取，不重复不报错', () => {
    const all = chunkDoc(DOC, DOC_CHUNK_CHARS, DOC_CHUNK_OVERLAP).length;
    expect(pickUniformChunks(DOC, all + 99).length).toBe(all);
  });
  it('预算不够时是“少取几块但仍横跨全文”，不是“从前往后装到装不下”（否则就退化成只覆盖开头）', () => {
    const tight = pickUniformChunks(DOC, 20, { budgetChars: 2000 });
    expect(tight.length).toBeGreaterThan(1);
    expect(tight.length).toBeLessThan(20);
    expect(tight[0]?.text).toContain('第 0 段');
    expect(tight[tight.length - 1]?.text).toContain('第 39 段');
    const used = tight.reduce((s, c) => s + c.text.length, 0);
    expect(used).toBeLessThanOrEqual(2000);
  });
  it('空文本返空数组', () => {
    expect(pickUniformChunks('', 5)).toEqual([]);
  });
});

describe('joinChunks 拼装', () => {
  const doc = `${'甲段内容。'.repeat(20)}\n\n${'乙段内容。'.repeat(20)}`;
  const hits = retrieveDoc(doc, '甲段内容', { k: 2, chunkChars: 40, overlap: 0 });

  it('withMarks=true 才带段号（对话要段号，出题/抽词条不要）', () => {
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain('甲段内容');
    expect(joinChunks(hits, true)).toContain('【段 1】');
    expect(joinChunks(hits, false)).not.toContain('【段 1】');
  });
});
