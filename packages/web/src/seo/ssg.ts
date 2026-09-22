/**
 * 构建期把词条页写进 dist（SSG）。
 *
 * ★ 为什么写 `.html` 文件而不是靠前端路由：线上 Caddy 对**无扩展名**路径一律
 *   `try_files → /index.html`（实测 `/terms/1234` 与 `/` 返回同一份 SPA 壳），
 *   带 `.html` 才走静态文件通道。用扩展名换掉一次服务器配置改动。
 * ★ 只在本机/CI 构建期运行（由 `vite.config.ts` 的 closeBundle 钩子调用）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PUBLIC_TERMS, SITE_ORIGIN, termPath, type PublicTerm } from './term-corpus';
import { renderTermIndexPage, renderTermPage } from './term-page';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** sitemap：首页 ＋ 目录页 ＋ 每个词条页 */
export function renderSitemapXml(
  terms: readonly PublicTerm[] = PUBLIC_TERMS,
  today: Date = new Date(),
): string {
  const stamp = isoDate(today);
  const locs = [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/terms/`, ...terms.map((t) => `${SITE_ORIGIN}${termPath(t)}`)];
  const urls = locs.map((loc) => `  <url><loc>${loc}</loc><lastmod>${stamp}</lastmod></url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

export interface WrittenSeoFile {
  /** 相对 outDir 的路径，供构建日志打印 */
  rel: string;
  bytes: number;
}

/** 写出全部静态页与 sitemap，返回落盘清单 */
export function writeSeoPages(
  outDir: string,
  terms: readonly PublicTerm[] = PUBLIC_TERMS,
  today: Date = new Date(),
): WrittenSeoFile[] {
  const written: WrittenSeoFile[] = [];
  const put = (rel: string, html: string): void => {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, html, 'utf8');
    written.push({ rel, bytes: Buffer.byteLength(html, 'utf8') });
  };
  for (const term of terms) put(`terms/${term.slug}.html`, renderTermPage(term));
  put('terms/index.html', renderTermIndexPage(terms));
  put('sitemap.xml', renderSitemapXml(terms, today));
  return written;
}
