/**
 * mix-report 的联网文案与来源清单单测（契约 docs/QUIZ-SEARCH-SPEC.md §2.7/§2.8，2026-09-13）。
 * 判定全在服务端 report，本文件只钉「怎么把结果说成人话」——尤其是**不许静默**：
 * 开了没搜到、搜了失败、命中缓存，三种情况的说法必须各不相同。
 * ★ 用 `mk()` 造 fixture 而非手写全字段：契约加字段（如 `refs`）时本文件不必逐条补。
 */
import { describe, it, expect } from 'vitest';
import type { QuizSearchReport } from '@sb/shared';
import { searchNote, refsList } from './mix-report';

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
