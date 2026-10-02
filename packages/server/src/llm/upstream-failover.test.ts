/**
 * llm/upstream-failover 单测（2026-10-02，契约 `docs/TENANCY-SPEC.md` §8.1.3.5）—— **失败换路**判定。
 *
 * 纯函数、不打网络、不碰库。本文件只钉 `shouldFailover` / `decideFailover` 的口径与
 * `markFailover`/`markedFailover` 的往返；换路**接线**（两适配器真的会发下一路）在
 * `openai.test.ts` / `anthropic.test.ts` 里端到端验。
 */
import { describe, expect, it } from 'vitest';
import {
  decideFailover,
  markFailover,
  markedFailover,
  shouldFailover,
  UpstreamHttpError,
} from './upstream-failover.js';

describe('v20261002 shouldFailover：哪些失败值得换下一路', () => {
  it('★ 换：429（限速，本模块的主要动机）/408/401/403/5xx/网络错', () => {
    for (const s of [429, 408, 401, 403, 500, 502, 503, 504, 599]) {
      expect(shouldFailover({ status: s }), `status=${s}`).toBe(true);
    }
    expect(shouldFailover({ network: true })).toBe(true); // fetch 抛 / 超时
  });

  it('★ 不换：400/404/422（请求形状/模型名问题，每条路都会同样拒）与未列出的状态码', () => {
    for (const s of [400, 404, 422, 418, 200, 301]) {
      expect(shouldFailover({ status: s }), `status=${s}`).toBe(false);
    }
    expect(shouldFailover({})).toBe(false); // 既无状态码也无 network 标记 ⇒ 保守不换
  });
});

describe('v20261002 decideFailover：结合"超时/用户取消"上下文', () => {
  it('HTTP 错误按状态码判：429 换、400 不换', () => {
    expect(decideFailover(new UpstreamHttpError(429, 'x'), { timedOut: false, aborted: false })).toBe(true);
    expect(decideFailover(new UpstreamHttpError(400, 'x'), { timedOut: false, aborted: false })).toBe(false);
  });

  it('超时（无状态码）⇒ 换（网络类）', () => {
    expect(decideFailover(new Error('上游无响应'), { timedOut: true, aborted: false })).toBe(true);
  });

  it('★ 用户取消 ⇒ **一律不换**（哪怕同时超时 / 哪怕状态码可换）', () => {
    expect(decideFailover(new UpstreamHttpError(429, 'x'), { timedOut: false, aborted: true })).toBe(false);
    expect(decideFailover(new Error('上游无响应'), { timedOut: true, aborted: true })).toBe(false);
  });

  it('裸 AbortError（非用户取消、非超时，罕见）⇒ 保守不换', () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(decideFailover(abortErr, { timedOut: false, aborted: false })).toBe(false);
  });

  it('其它未知错误 ⇒ 按网络类换（真正的拦截点是"吐字节后不换"，见 runFailover 的 yielded）', () => {
    expect(decideFailover(new TypeError('fetch failed'), { timedOut: false, aborted: false })).toBe(true);
  });
});

describe('v20261002 markFailover / markedFailover：标记随错误穿过 generator 边界', () => {
  it('标记 true/false 可读回，且不改 message / instanceof', () => {
    const e = new UpstreamHttpError(429, '保持原文案');
    const marked = markFailover(e, true);
    expect(marked).toBe(e); // 同一对象（可扩展时不包装）
    expect(marked.message).toBe('保持原文案');
    expect(markedFailover(marked)).toBe(true);

    expect(markedFailover(markFailover(new Error('x'), false))).toBe(false);
    expect(markedFailover(new Error('未标记'))).toBe(false); // 未标记 ⇒ false（不换）
    expect(markedFailover('not-an-error')).toBe(false);
  });
});