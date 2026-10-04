/**
 * sources/reader-page —— `/api/sources/read` 的数据装配（契约 `docs/SOURCE-TRACE-SPEC.md` §14.1）。
 *
 * 一句话：`loadReaderStruct`（取页 + 清洗，与 `/view` 同一次、同一份缓存）→ `parseReaderBlocks`（结构化）
 * → `ReaderPage`。单独成文件是为了让 `reader.ts` 不再长（它已贴近 400 行红线），
 * 也让「HTML 怎么来」与「怎么变成块」两件事各自可读。
 */
import type { ReaderPageResult } from '@sb/shared';
import { loadReaderStruct } from './reader.js';
import { parseReaderBlocks } from './reader-blocks.js';

export async function loadReaderPage(url: string, title: string, signal?: AbortSignal): Promise<ReaderPageResult> {
  const r = await loadReaderStruct(url, title, signal);
  if (!r.ok) return { ok: false, url, status: r.status, reason: r.reason };
  return {
    ok: true,
    url,
    title: r.doc.title,
    site: r.doc.site,
    byline: r.doc.byline ?? '',
    blocks: parseReaderBlocks(r.doc.body),
    thin: r.thin,
  };
}
