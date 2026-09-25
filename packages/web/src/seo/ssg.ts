/**
 * 构建期把词条页与更新记录页写进 dist（SSG）。
 *
 * ★ 为什么写 `.html` 文件而不是靠前端路由：线上 Caddy 对**无扩展名**路径一律
 *   `try_files → /index.html`（实测 `/terms/1234` 与 `/` 返回同一份 SPA 壳），
 *   带 `.html` 才走静态文件通道。用扩展名换掉一次服务器配置改动。
 * ★ 目录页同一条规矩：`/terms/`（目录形式）线上没有目录索引，兜出来是 SPA 壳，
 *   所以落盘名与指向它的链接一律从 `CATALOG_PATH` 拼（09-23 线上实测钉死）。
 * ★ 英文侧落在 `terms/en/` 下面：URL 与文件仍同形，`mkdirSync(..., {recursive:true})` 顺带建目录，
 *   所以「多一层语言目录」在链路里不需要任何新管线（批次 H-1 关心的正是这一点能不能白拿）。
 * ★ 只在本机/CI 构建期运行（由 `vite.config.ts` 的 closeBundle 钩子调用）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CATALOG_PATH,
  PUBLIC_TERMS,
  SITE_ORIGIN,
  termPath,
  type PublicTerm,
} from './term-corpus';
import { CATALOG_PATH_EN, PUBLIC_TERMS_EN, termEnPath, type EnglishTerm } from './term-corpus-en';
import { renderTermIndexPage, renderTermPage } from './term-page';
import { renderTermIndexPageEn, renderTermPageEn } from './term-page-en';
import { CHANGELOG_PATH, FEED_PATH, PLAN_TOOL_PATH } from './paths';
import { renderAtomFeed, renderChangelogPage } from './changelog-page';
import { renderPlanToolPage } from './plan-page';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** sitemap：首页 ＋ 中英两个目录页 ＋ 两边每一个词条页 ＋ 计划表工具页 */
export function renderSitemapXml(
  terms: readonly PublicTerm[] = PUBLIC_TERMS,
  enTerms: readonly EnglishTerm[] = PUBLIC_TERMS_EN,
  today: Date = new Date(),
): string {
  const stamp = isoDate(today);
  const locs = [
    `${SITE_ORIGIN}/`,
    `${SITE_ORIGIN}${CATALOG_PATH}`,
    ...terms.map((t) => `${SITE_ORIGIN}${termPath(t)}`),
    `${SITE_ORIGIN}${CATALOG_PATH_EN}`,
    ...enTerms.map((t) => `${SITE_ORIGIN}${termEnPath(t)}`),
    `${SITE_ORIGIN}${PLAN_TOOL_PATH}`,
  ];
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
  enTerms: readonly EnglishTerm[] = PUBLIC_TERMS_EN,
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
  // ★ 落盘名从 CATALOG_PATH 派生：URL 与文件必须同形（差一个扩展名，线上就兜成 SPA 壳）
  put(CATALOG_PATH.slice(1), renderTermIndexPage(terms));
  // ★ 英文侧嵌在 `terms/en/` 下面，同一把尺：落盘名一律从地址常量派生（`mkdirSync` 递归建目录）
  for (const term of enTerms) put(`terms/en/${term.slug}.html`, renderTermPageEn(term));
  put(CATALOG_PATH_EN.slice(1), renderTermIndexPageEn(enTerms));
  // ★ 更新页与订阅同一把尺：落盘名一律从地址常量派生
  put(CHANGELOG_PATH.slice(1), renderChangelogPage());
  put(FEED_PATH.slice(1), renderAtomFeed());
  // ★ 工具页：带日期那张表由页内脚本算，构建期只落那张不带日期的形状表（所以它永远不会过期）
  put(PLAN_TOOL_PATH.slice(1), renderPlanToolPage());
  put('sitemap.xml', renderSitemapXml(terms, enTerms, today));
  return written;
}
