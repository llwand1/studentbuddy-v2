/**
 * 公开静态词条页的站内路径 —— 构建侧（`term-corpus`／`ssg`）与 SPA 侧（落地页页脚、
 * 词条库空态）共用的唯一一份。
 *
 * ★ 为什么单开一个文件：应用只需要一个路径字符串，不该为了拿它把 12 条语料拽进包体。
 * ★ 必须带 `.html`：线上 Caddy 没有目录索引，目录形式 `/terms/` 会被 `try_files`
 *   兜成 SPA 壳（09-23 实测：壳 1487 B / 真目录 5705 B），差一个扩展名就吐不出内容。
 */
export const CATALOG_PATH = '/terms/index.html';

/**
 * 英文词条目录页。★ 与中文目录页同一条规矩：**必须带 `.html`**（线上 Caddy 没有目录索引，
 * `/terms/en/` 会被兜成 SPA 壳）。
 * ★ 它嵌在 `/terms/` 下面不是偶然：`robots.txt` 那扇 `Allow: /terms/` 是**前缀**放行，
 *   英文侧因此自动公开——由 `public-hygiene.test.ts` 现验前缀盖得住，不靠「我记得覆盖了」。
 */
export const CATALOG_PATH_EN = '/terms/en/index.html';

/**
 * 公开更新记录页。★ 与目录页同一条规矩：必须带 `.html`（线上 Caddy 没有目录索引，
 * `/changelog/` 会被兜成 SPA 壳），而且**默认全封**的 `robots.txt` 要为它开一扇 `Allow`。
 */
export const CHANGELOG_PATH = '/changelog/index.html';

/** 更新记录的 Atom 订阅地址；同样要在 `robots.txt` 里点名放行 */
export const FEED_PATH = '/atom.xml';
