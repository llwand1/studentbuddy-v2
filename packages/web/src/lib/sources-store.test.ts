/**
 * sources-store 单测（契约 docs/SOURCE-TRACE-SPEC.md §8.1）。
 * 钉：① live 帧整表替换 + 首选（精选 > 在读 > 首条）+ 保持当前选中；② 跨轮不自动弹、主动重开保留 live 状态；
 * ③ 历史打开可指定 n；④ 前后切换按面板顺序回绕、Alt+k 直达；⑤ takeTurnSources 同秒重复取一致、
 * 过期后不再挂、会话不符为空；⑥ readerUrl 按类型选端点；⑦ showSource 同一份架子只切条目。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SourceItem, SourcesBlockPayload } from '@sb/shared';
import {
  applyLiveSources,
  closeSources,
  getSources,
  openSources,
  reopenSources,
  rememberSessionSources,
  setSourceSession,
  readerUrl,
  resetSourcesStore,
  selectSourceAt,
  showSource,
  stepSource,
  takeTurnSources,
} from './sources-store';

const item = (n: number, origin: SourceItem['origin'] = 'search', kind: SourceItem['kind'] = 'page'): SourceItem => ({
  n,
  url: `https://x.example.com/${n}`,
  title: `T${n}`,
  site: 'x.example.com',
  kind,
  origin,
});
const frame = (items: SourceItem[], readingN?: number): SourcesBlockPayload => ({ kind: 'sources', sessionId: 's1', items, ...(readingN ? { readingN } : {}) });

beforeEach(() => resetSourcesStore());

describe('live 帧', () => {
  it('① 首帧只更新入口、首选精选 > 在读 > 首条；主动打开后保持当前选中，选中被挤掉才重选', () => {
    applyLiveSources(frame([item(1), item(2)]));
    expect(getSources()).toMatchObject({ open: false, live: true, activeN: 1, sessionId: 's1' });
    reopenSources();
    applyLiveSources(frame([item(1), item(2), item(3, 'read')], 3));
    expect(getSources().activeN).toBe(1); // 用户正在看 1，不跳
    expect(getSources().readingN).toBe(3);
    applyLiveSources(frame([item(2), item(3, 'read'), item(4, 'pick')]));
    expect(getSources().activeN).toBe(4); // 1 被挤掉 ⇒ 落到精选
    resetSourcesStore();
    applyLiveSources(frame([item(1), item(2, 'read')], 2));
    expect(getSources().activeN).toBe(2); // 无精选 ⇒ 在读
  });

  it('② 关闭后跨轮不自动弹；主动重开保留选中条目与 AI 在读状态', () => {
    applyLiveSources(frame([item(1)]));
    closeSources();
    expect(getSources().open).toBe(false);
    applyLiveSources(frame([item(1), item(2)]));
    expect(getSources().open).toBe(false);
    takeTurnSources('s1');
    applyLiveSources(frame([item(7)]));
    expect(getSources().open).toBe(false);
    reopenSources();
    expect(getSources()).toMatchObject({ open: true, live: true, activeN: 7 });
  });
  it('切会话清掉旧入口；历史恢复不展开，也不覆盖新 live 帧或其他会话', () => {
    openSources('s1', [item(1)]);
    setSourceSession('s2');
    expect(getSources()).toMatchObject({ sessionId: 's2', open: false, items: [] });
    rememberSessionSources('s1', [item(1)]);
    expect(getSources().items).toEqual([]);
    rememberSessionSources('s2', [item(2)]);
    expect(getSources()).toMatchObject({ open: false, activeN: 2 });
    applyLiveSources({ ...frame([item(3)]), sessionId: 's2' });
    rememberSessionSources('s2', [item(2)]);
    expect(getSources().activeN).toBe(3);
    setSourceSession(null);
    expect(getSources().items).toEqual([]);
  });
});

describe('历史 / 切换 / 归位', () => {
  it('③ openSources 指定 n；n 不存在落到首选；空架不打开', () => {
    openSources('s2', [item(1), item(2, 'pick')], 1);
    expect(getSources()).toMatchObject({ open: true, live: false, activeN: 1, sessionId: 's2' });
    openSources('s2', [item(1), item(2, 'pick')], 9);
    expect(getSources().activeN).toBe(2);
    resetSourcesStore();
    openSources('s2', []);
    expect(getSources().open).toBe(false);
  });

  it('④ stepSource 按面板顺序（精选→读过→搜到）回绕；selectSourceAt 直达', () => {
    openSources('s3', [item(1), item(2, 'read'), item(3, 'pick')]);
    expect(getSources().activeN).toBe(3);
    stepSource(1);
    expect(getSources().activeN).toBe(2);
    stepSource(1);
    expect(getSources().activeN).toBe(1);
    stepSource(1);
    expect(getSources().activeN).toBe(3);
    stepSource(-1);
    expect(getSources().activeN).toBe(1);
    selectSourceAt(2);
    expect(getSources().activeN).toBe(2);
    selectSourceAt(9);
    expect(getSources().activeN).toBe(2);
  });

  it('⑤ takeTurnSources：同秒重复取一致（StrictMode 双调）、过期后为空、会话不符为空、空架为空', () => {
    vi.useFakeTimers();
    applyLiveSources(frame([item(1)]));
    expect(takeTurnSources('s-other')).toEqual({});
    const a = takeTurnSources('s1');
    const b = takeTurnSources('s1');
    expect(a.sources).toHaveLength(1);
    expect(b).toEqual(a);
    expect(getSources().live).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(takeTurnSources('s1')).toEqual({});
    applyLiveSources(frame([]));
    expect(takeTurnSources('s1')).toEqual({});
    vi.useRealTimers();
  });

  it('⑥ readerUrl：pdf 走 /pdf，其余走 /view，带 session/url/title', () => {
    expect(readerUrl('s1', item(1, 'search', 'pdf'))).toBe('/api/sources/pdf?session=s1&url=https%3A%2F%2Fx.example.com%2F1&title=T1');
    expect(readerUrl('s1', item(2))).toMatch(/^\/api\/sources\/view\?session=s1&url=/);
  });

  it('⑦ showSource：同一份架子只切条目并确保打开；不同架子按新架重开', () => {
    const items = [item(1), item(2)];
    openSources('s1', items, 1);
    closeSources();
    showSource('s1', items, 2);
    expect(getSources()).toMatchObject({ open: true, activeN: 2 });
    const other = [item(5)];
    showSource('s9', other, 5);
    expect(getSources()).toMatchObject({ sessionId: 's9', activeN: 5, items: other });
  });
});
