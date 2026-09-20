/**
 * mix-report 的联网文案与来源清单单测（契约 docs/QUIZ-SEARCH-SPEC.md §2.7/§2.8，2026-09-13）。
 * 判定全在服务端 report，本文件只钉「怎么把结果说成人话」——尤其是**不许静默**：
 * 开了没搜到、搜了失败、命中缓存，三种情况的说法必须各不相同。
 * ★ 用 `mk()` 造 fixture 而非手写全字段：契约加字段（如 `refs`）时本文件不必逐条补。
 */
import { describe, it, expect } from 'vitest';
import type { QuizBlendReport, QuizQuestion, QuizSearchReport } from '@sb/shared';
import { searchNote, refsList, scenarioMixNote, blendNote } from './mix-report';

/** 只写关心的字段，其余走零值 */
const mk = (p: Partial<QuizSearchReport>): QuizSearchReport => ({
  on: true,
  count: 0,
  providers: [],
  failed: [],
  refs: [],
  ...p,
});

describe('searchNote — 联网情况文案', () => {
  it('没联网 → null（本次没开不是损失，与配图开关关着同理，不必播报）', () => {
    expect(searchNote(undefined)).toBeNull();
    expect(searchNote(null)).toBeNull();
    expect(searchNote(mk({ on: false }))).toBeNull();
  });

  it('有命中 → 报条数与来源', () => {
    expect(searchNote(mk({ count: 4, providers: ['exa', 'tavily'] }))).toBe(
      '联网：参考了 4 条资料（来源 exa、tavily）。',
    );
  });

  it('只命中缓存 → 说命中缓存，不把 cache 谎报成一家搜索源', () => {
    expect(searchNote(mk({ count: 2, providers: ['cache'] }))).toBe('联网：参考了 2 条资料（本次命中缓存）。');
  });

  it('开了但全失败 → 连带真因一起说，并交代题目从哪来', () => {
    const s = searchNote(mk({ failed: ['exa: Exa 401'] }));
    expect(s).toContain('没取到参考');
    expect(s).toContain('exa: Exa 401');
    expect(s).toContain('模型自身知识');
  });

  it('开了、没失败、也没结果 → 仍要说一句（不静默）', () => {
    expect(searchNote(mk({}))).toContain('没搜到');
  });
});

describe('refsList — 参考来源清单', () => {
  it('没联网 / 无报告 → 空数组（不渲染来源区）', () => {
    expect(refsList(undefined)).toEqual([]);
    expect(refsList(null)).toEqual([]);
    expect(refsList(mk({ on: false, refs: [{ n: 1, title: 'x', url: 'u', provider: 'exa' }] }))).toEqual([]);
  });

  it('老服务端不返回 refs → 空数组（不崩）', () => {
    const legacy = { on: true, count: 3, providers: ['exa'], failed: [] } as unknown as QuizSearchReport;
    expect(refsList(legacy)).toEqual([]);
  });

  it('有来源 → 原样透传（前端不校验、不补全、不发明来源）', () => {
    const refs = [
      { n: 1, title: '标题一', url: 'https://a.example/1', provider: 'exa' },
      { n: 2, title: '', url: 'https://b.example/2', provider: 'tavily' },
    ];
    expect(refsList(mk({ count: 2, refs }))).toEqual(refs);
  });
});


describe('scenarioMixNote — 情景套数如实播报（SCENARIO-SPEC §6.1）', () => {
  const ok = (i: number) => ({ ok: true as const, quizId: `q${i}`, demoId: `d${i}` });
  const fail = () => ({ ok: false as const, failure: 'parse' as const });

  it('没配情景档（空/undefined）→ null，无事发生就不播报', () => {
    expect(scenarioMixNote(undefined)).toBeNull();
    expect(scenarioMixNote([])).toBeNull();
  });

  it('全成功：报套数（卡片本身看不出一共出了几套）', () => {
    expect(scenarioMixNote([ok(1)])).toContain('1 套已生成');
    expect(scenarioMixNote([ok(1), ok(2)])).toContain('成功 2/2 套'.replace('成功 2/2 套', '2 套已生成'));
  });

  it('部分失败：成功/失败各报多少，失败给行动指引（不静默）', () => {
    const note = scenarioMixNote([ok(1), fail(), fail()]);
    expect(note).toContain('成功 1/3 套');
    expect(note).toContain('失败 2 套');
  });

  it('no-model 与 parse 的指引不同（真因不同，行动就不同）', () => {
    expect(scenarioMixNote([{ ok: false, failure: 'no-model' }])).toContain('绑定模型');
    expect(scenarioMixNote([{ ok: false, failure: 'parse' }])).toContain('重试');
  });
});

describe('blendNote — 真题合流文案（QUIZ-BLEND-SPEC §3.4，2026-09-20 老板点单）', () => {
  /** 题型序与中文名在本文件**硬写**：文案测试要锁死用户看到的那几个字，不跟实现共用一个字典 */
  const KINDS = [
    ['single', '单选题'],
    ['multiple', '多选题'],
    ['fill', '填空题'],
    ['essay', '解答题'],
    ['scenario', '情景题'],
  ] as const;

  const ZERO_SRC = { single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 };
  const ZERO_AI = { single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 };

  /** 造一份合流报告；`missing` 由 requested/actual 如实推得（服务端就是这么填的） */
  const blend = (p: {
    requested?: Partial<Record<(typeof KINDS)[number][0], number>>;
    actual?: Partial<Record<(typeof KINDS)[number][0], number>>;
    pages?: { url: string; fetched: boolean }[];
    noCollect?: boolean;
  }): QuizBlendReport => {
    const requested = { ...ZERO_SRC, ...p.requested };
    const actual = { ...ZERO_SRC, ...p.actual };
    const missing = KINDS.filter(([t]) => actual[t] < requested[t]).map(([t, label]) => ({
      type: t,
      want: requested[t],
      got: actual[t],
      label,
    }));
    return {
      ai: { requested: { ...ZERO_AI }, actual: { ...ZERO_AI }, matched: true },
      real: { requested, actual, missing },
      ...(p.noCollect
        ? {}
        : {
            collect: {
              queries: ['mock'],
              providers: ['exa'],
              failed: [],
              pages: (p.pages ?? []).map((x) => ({ url: x.url, title: x.url, fetched: x.fetched })),
              total: 0,
              accepted: 0,
              rejected: 0,
            },
          }),
    };
  };

  it('没配真题（无报告 / 全 0）→ null，不是损失就不播报', () => {
    expect(blendNote(undefined)).toBeNull();
    expect(blendNote(null)).toBeNull();
    expect(blendNote(blend({}))).toBeNull();
    expect(blendNote(blend({ requested: { scenario: 0 } }))).toBeNull();
  });

  it('全摘够 → 逐档 want/want，并报总数与页数（页数取抓取成功的页）', () => {
    const note = blendNote(
      blend({
        requested: { single: 2, fill: 1 },
        actual: { single: 2, fill: 1 },
        pages: [
          { url: 'https://a.example/1', fetched: true },
          { url: 'https://b.example/2', fetched: true },
          { url: 'https://c.example/3', fetched: false },
        ],
      }),
    );
    expect(note).toBe('真题：单选题 2/2、填空题 1/1（共 3 道，来自 2 个网页）。');
  });

  it('页数优先按真题逐题 source.url 去重（准确口径，抓了没用上的页不算）', () => {
    const q = (url: string): QuizQuestion => ({
      type: 'single',
      question: 'x',
      source: { kind: 'collect', title: 't', url },
    });
    const questions = [q('https://a.example/1'), q('https://a.example/1'), q('https://b.example/2')];
    const note = blendNote(
      blend({
        requested: { single: 3 },
        actual: { single: 3 },
        pages: [
          { url: 'https://a.example/1', fetched: true },
          { url: 'https://b.example/2', fetched: true },
          { url: 'https://c.example/3', fetched: true },
        ],
      }),
      questions,
    );
    // 抓了 3 页，但题只出自 2 页 → 必须报 2（报 3 就是假账）
    expect(note).toBe('真题：单选题 3/3（共 3 道，来自 2 个网页）。');
  });

  it('AI/联网题的 url 不计入真题页数（来源分开算，不混账）', () => {
    const note = blendNote(
      blend({ requested: { single: 1 }, actual: { single: 1 } }),
      [{ type: 'single', question: 'x', source: { kind: 'ai', title: 'ai', url: 'https://z.example/9' } }],
    );
    // 一道 collect 题都没有 → 退回抓取成功页数（非 AI 题 url）
    expect(note).toBe('真题：单选题 1/1（共 1 道）。');
  });

  it('部分摘不到 → 缺的档标「少 N 道」，并明说未用 AI 顶替（D3 报缺不补）', () => {
    const note = blendNote(
      blend({ requested: { single: 2, fill: 1 }, actual: { single: 1 }, pages: [{ url: 'u', fetched: true }] }),
    );
    expect(note).toBe('真题：单选题 1/2（少 1 道）、填空题 0/1（少 1 道）——网上没摘到，未用 AI 顶替。');
  });

  it('一条都没摘到 → 交代结果、指向逐页报告、并说清题目从哪来', () => {
    const note = blendNote(blend({ requested: { single: 2, fill: 1 } }));
    expect(note).toBe('真题：本次一道都没摘到（原因见下方逐页报告），题目全部由 AI 出。');
  });

  it('没配的档不出现（requested=0 的题型不列）', () => {
    const note = blendNote(blend({ requested: { single: 1, essay: 2 }, actual: { single: 1, essay: 2 } }));
    expect(note).toContain('单选题 1/1');
    expect(note).toContain('解答题 2/2');
    expect(note).not.toContain('多选题');
    expect(note).not.toContain('情景题');
  });

  it('老服务端不返回 collect / 搜集整体抛错 → 照样给文案，不崩（真题是增益不是依赖）', () => {
    const note = blendNote(blend({ requested: { single: 2 }, actual: { single: 2 }, noCollect: true }));
    expect(note).toBe('真题：单选题 2/2（共 2 道）。');
    const empty = blendNote(blend({ requested: { single: 2 }, actual: { single: 0 }, noCollect: true }));
    expect(empty).toBe('真题：本次一道都没摘到（原因见下方逐页报告），题目全部由 AI 出。');
  });
});

