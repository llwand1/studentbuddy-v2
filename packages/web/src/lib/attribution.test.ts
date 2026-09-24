// @vitest-environment jsdom
/**
 * lib/attribution — 「谁带来的」前端那一半的锁（契约 `docs/GROWTH-SPEC.md` §2.5）。
 *
 * ★ 重心在三处最容易写错、且错了**不报错**的地方：
 *   ① 末触覆盖（写成首触的话，新渠道会被老 ref 永久遮掉，读数看起来"没效果"）；
 *   ② 中文渠道名不能被洗成假 slug 存进去（"贴吧"→ 归一后是空串 ⇒ 不存不发，落进 `direct`）——
 *      把非法输入折成一个能存的怪值，等于凭空造一个没人认领的渠道；
 *   ③ 存储抛（隐私模式）只丢归因、不丢页面。
 * 与服务端配合的端到端（带头 → 落库 → 读回）在 `server/src/routes/growth.test.ts`，两侧不重叠。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from './api-request';
import {
  captureRef,
  extractRef,
  normalizeRef,
  __resetRefForTests,
  REF_MAX_LEN,
  REF_HEADER,
  REF_STORAGE_KEY,
  type RefStore,
} from './attribution';

function memStore(initial: Record<string, string> = {}): RefStore & { dump(): Record<string, string> } {
  const data = { ...initial };
  return {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    dump: () => data,
  };
}

describe('normalizeRef（客户端先归一遍：不能让非法字符走到 setRequestHeader 上抛）', () => {
  it('小写、空白折叠成 -、去首尾分隔符', () => {
    expect(normalizeRef('  TieBa ')).toBe('tieba');
    expect(normalizeRef('Class Group')).toBe('class-group');
    expect(normalizeRef('--x__')).toBe('x');
  });

  it('★ 截到 24 字符（与服务端那一格同上限）', () => {
    expect(normalizeRef('a'.repeat(40))).toBe('a'.repeat(REF_MAX_LEN));
    expect(REF_MAX_LEN).toBe(24);
  });

  it('★ 纯中文（含中英混排的标点）归一成空串，不是 `--`／`-` 那种假值', () => {
    expect(normalizeRef('贴吧')).toBe('');
    expect(normalizeRef('考研/数学')).toBe(''); // 整串都非法 ⇒ 折成一个 `-` 再被首尾剥掉
    expect(normalizeRef('zhihu/贴吧')).toBe('zhihu'); // ★ 合法那截留着，被洗掉的只是非法那截
    expect(normalizeRef('')).toBe('');
  });
});

describe('extractRef（?ref= 与 hash 里的 ?ref= 都认；utm_source 同义）', () => {
  it('search 优先，其次 hash 查询段', () => {
    expect(extractRef('?ref=tieba', '')).toBe('tieba');
    expect(extractRef('', '#/pk?ref=class-group')).toBe('class-group');
    expect(extractRef('?utm_source=zhihu', '')).toBe('zhihu');
  });

  it('★ 与邀请码共存：`#/pk?code=...` 里没有 ref 就返回空，别把 code 当成来源', () => {
    expect(extractRef('', '#/pk?code=AbC123')).toBe('');
  });

  it('两个参数名同时出现时 ref 赢（ref 是本站自己写的，语义更明确）', () => {
    expect(extractRef('?ref=tieba&utm_source=zhihu', '')).toBe('tieba');
  });
});

describe('captureRef（末触口径＝老板 2026-09-24 拍板）', () => {
  it('★ 带了新 ref 就覆盖旧值：老渠道不许永久遮掉新渠道', () => {
    const store = memStore({ [REF_STORAGE_KEY]: 'tieba' });
    expect(captureRef({ search: '?ref=class-group', hash: '' }, store)).toBe('class-group');
    expect(store.dump()[REF_STORAGE_KEY]).toBe('class-group');
  });

  it('没带 ref 时沿用存储里的旧值（同一会话刷新不丢来源）', () => {
    const store = memStore({ [REF_STORAGE_KEY]: 'terms' });
    expect(captureRef({ search: '', hash: '' }, store)).toBe('terms');
    expect(store.dump()[REF_STORAGE_KEY]).toBe('terms');
  });

  it('★ 两处都没有 ⇒ 空串（读侧折成 `direct`），并且不写存储', () => {
    const store = memStore();
    expect(captureRef({ search: '', hash: '' }, store)).toBe('');
    expect(store.dump()).toEqual({});
  });

  it('★ 中文渠道名不存不发（宁缺不误归属）', () => {
    const store = memStore();
    expect(captureRef({ search: '?ref=贴吧', hash: '' }, store)).toBe('');
    expect(store.dump()).toEqual({});
  });

  it('存储抛（隐私模式）只丢归因，不抛给页面', () => {
    const boom: RefStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(captureRef({ search: '?ref=tieba', hash: '' }, boom)).toBe('tieba');
    expect(captureRef({ search: '', hash: '' }, boom)).toBe('');
  });

  it('存储整个拿不到（null）也不抛', () => {
    expect(captureRef({ search: '?ref=tieba', hash: '' }, null)).toBe('tieba');
    expect(captureRef({ search: '', hash: '' }, null)).toBe('');
  });
});

describe('注入：`X-SB-Ref` 由 api 那一层统一带上（请求出口只有一个）', () => {
  /** 桩 fetch，并把每次实际发出去的头记下来。 */
  function stubFetch(): { sent: () => Headers[] } {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(init ?? {});
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );
    return { sent: () => seen.map((i) => new Headers(i.headers as HeadersInit | undefined)) };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetRefForTests();
    window.localStorage.removeItem(REF_STORAGE_KEY);
    window.history.replaceState({}, '', '/');
  });

  it('★ 地址栏带 `?ref=` ⇒ 存进本地、并出现在**每一条** api 请求的头上', async () => {
    window.history.replaceState({}, '', '/?ref=class-group');
    __resetRefForTests(); // 模块级缓存在上个用例之后必须能重跑
    const f = stubFetch();
    await request('/api/auth/providers');
    await request('/api/growth/counters');
    for (const h of f.sent()) expect(h.get(REF_HEADER)).toBe('class-group');
    expect(window.localStorage.getItem(REF_STORAGE_KEY)).toBe('class-group'); // ★ 第二跳不带 ref 也还在
  });

  it('★ 没有来源 ⇒ 连这个头都不发（前端不制造第二份「空」，空由服务端折成 `direct`）', async () => {
    __resetRefForTests();
    const f = stubFetch();
    await request('/api/auth/providers');
    const [only] = f.sent();
    expect(only?.has(REF_HEADER)).toBe(false);
    expect(window.localStorage.getItem(REF_STORAGE_KEY)).toBeNull();
  });

  it('★ `app_open` 的采集点必须走 api 层（源码锁：换回裸 fetch 就静默丢掉最关键那个数的来源）', () => {
    // ★ 不 `new URL(相对, import.meta.url)`：jsdom 环境里的 `URL` 是 jsdom 那个类，
    //   node 的 `fileURLToPath` 认不出它（实测报「The URL must be of scheme file」）。走纯字符串。
    const here = fileURLToPath(import.meta.url);
    const src = readFileSync(join(dirname(here), '..', 'app', 'Landing.tsx'), 'utf8');
    expect(src).not.toMatch(/fetch\s*\(\s*['"`]\/api\/auth\/providers/);
    expect(src).toContain('api.auth');
  });
});
