/**
 * 评测用的搜索回放：在 `globalThis.fetch` 层拦截产品 Bing 通道的 RSS 请求，
 * 用快照（`datasets/complete-v1.search.json`）里「当前用例」的结果合成一份 RSS 返回。
 * 其余请求（网页正文、图片、模型 API）原样放行。两臂共用，产品代码零改动。
 */
import fs from 'node:fs';

interface Snap { cases: Record<string, Array<{ title: string; url: string; snippet?: string }>> }

let snap: Snap | null = null;
let current = '';
let installed = false;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function installSearchReplay(snapshotFile: string): void {
  snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as Snap;
  if (installed) return;
  installed = true;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/^https?:\/\/(www|cn)\.bing\.com\/search\?/.test(url)) {
      const items = (snap?.cases[current] ?? []).map((r) =>
        `<item><title>${esc(r.title)}</title><link>${esc(r.url)}</link><description>${esc(r.snippet ?? '')}</description></item>`).join('');
      return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>replay</title>${items}</channel></rss>`,
        { status: 200, headers: { 'content-type': 'text/xml' } });
    }
    return real(input, init);
  }) as typeof fetch;
}

export function setReplayCase(id: string): void { current = id; }
