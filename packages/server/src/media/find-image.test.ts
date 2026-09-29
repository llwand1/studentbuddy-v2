/**
 * media/find-image —— 找图流程（2026-09-29 新建）。依赖全部注入，不联网、不调模型。
 * 锁的是「写错不报错」的纪律：非 yes 不收、泄露必拒、出题必须看过图、Commons 够了不打扰 Bing、
 * 缓存只存看过的图且出题不读缓存、最多看 4 张（每张一次付费的看图调用）。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-findimg-test-'));
const { findImages, creditLine } = await import('./find-image.js');
type Deps = NonNullable<Parameters<typeof findImages>[0]['deps']>;

const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 1, 2, 3]);
const cand = (i: number, source: 'commons' | 'bing' = 'commons') => ({
  url: `https://x.test/${source}/${i}.png`, pageUrl: `https://x.test/p/${i}`, title: `T${i}`, source, license: 'CC0', author: 'A',
});
let seq = 0;
function deps(over: Partial<Deps> & { match?: string[]; leak?: boolean } = {}): Deps & { calls: { verify: number; bing: number } } {
  const calls = { verify: 0, bing: 0 };
  const base = seq++ * 16;
  return {
    calls,
    commons: over.commons ?? (async () => [cand(base + 1), cand(base + 2), cand(base + 3), cand(base + 4), cand(base + 5)]),
    bing: async (...a) => { calls.bing++; return over.bing ? over.bing(...a) : [cand(base + 9, 'bing')]; },
    download: over.download ?? (async (url) => ({ ok: true, bytes: PNG(Number(url.match(/(\d+)\.png/)![1])), ext: 'png', mime: 'image/png' })),
    verify: over.verify ?? (async () => {
      const m = over.match?.[calls.verify] ?? 'yes';
      calls.verify++;
      return { verdict: 'checked', result: { match: m as 'yes', depicts: 'D', textInImage: '', revealsAnswer: false }, leak: over.leak ?? false };
    }),
  };
}

describe('findImages', () => {
  it('只收 yes；partial/no 记进 rejected', async () => {
    const d = deps({ match: ['no', 'partial', 'yes'] });
    const r = await findImages({ query: 'q1', ownerId: null, deps: d });
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.verified).toBe(true);
    expect(r.images[0]!.src).toMatch(/^\/api\/images\//);
    expect(r.rejected.join()).toMatch(/no.*partial|partial.*no/);
  });
  it('最多看 4 张', async () => {
    const d = deps({ match: ['no', 'no', 'no', 'no', 'yes'] });
    const r = await findImages({ query: 'q2', ownerId: null, deps: d });
    expect(r.images).toHaveLength(0);
    expect(d.calls.verify).toBe(4);
  });
  it('泄露答案的图一律拒', async () => {
    const r = await findImages({ query: 'q3', ownerId: null, quiz: { question: 'Q', answers: ['X'] }, requireVerified: true, deps: deps({ leak: true }) });
    expect(r.images).toHaveLength(0);
  });
  it('requireVerified：看图失败就不收；否则收但标未核验', async () => {
    const verify: Deps['verify'] = async () => ({ verdict: 'unverified', reason: 'no-model' });
    expect((await findImages({ query: 'q4', ownerId: null, requireVerified: true, deps: deps({ verify }) })).images).toHaveLength(0);
    const r = await findImages({ query: 'q5', ownerId: null, deps: deps({ verify }) });
    expect(r.images[0]!.verified).toBe(false);
    expect(creditLine(r.images[0]!)).toContain('未经看图核验');
  });
  it('Commons 够 2 张就不查 Bing；不够才补', async () => {
    const d1 = deps();
    await findImages({ query: 'q6', ownerId: null, deps: d1 });
    expect(d1.calls.bing).toBe(0);
    const d2 = deps({ commons: async () => [] });
    const r = await findImages({ query: 'q7', ownerId: null, deps: d2 });
    expect(d2.calls.bing).toBe(1);
    expect(r.images[0]!.source).toBe('bing');
  });
  it('缓存：普通检索第二次命中不再看图；出题不读缓存', async () => {
    const d = deps();
    await findImages({ query: 'Cache Me', ownerId: null, deps: d });
    const seen = d.calls.verify;
    const again = await findImages({ query: ' cache me ', ownerId: null, deps: d });
    expect(again.cached).toBe(true);
    expect(d.calls.verify).toBe(seen);
    const quiz = await findImages({ query: 'cache me', ownerId: null, quiz: { question: 'Q', answers: [] }, deps: d });
    expect(quiz.cached).toBe(false);
  });
  it('下载失败不抛，换下一张', async () => {
    const download = vi.fn(async () => ({ ok: false as const, kind: 'error' as const, reason: 'x' }));
    const r = await findImages({ query: 'q8', ownerId: null, deps: deps({ download }) });
    expect(r.images).toHaveLength(0);
    expect(r.rejected[0]).toBe('error');
  });
});
