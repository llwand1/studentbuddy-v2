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
 *   英文侧因此自动公开——★ 而「前缀被改窄就静默下线」这件事由 `robots-coverage.test.ts` 逐条 loc 现验（issue #4 的锁：把 `Allow: /terms/` 改窄 ⇒ CI 直接红），不靠「我记得覆盖了」。
 */
export const CATALOG_PATH_EN = '/terms/en/index.html';

/**
 * 公开更新记录页。★ 与目录页同一条规矩：必须带 `.html`（线上 Caddy 没有目录索引，
 * `/changelog/` 会被兜成 SPA 壳），而且**默认全封**的 `robots.txt` 要为它开一扇 `Allow`。
 */
export const CHANGELOG_PATH = '/changelog/index.html';

/** 更新记录的 Atom 订阅地址；同样要在 `robots.txt` 里点名放行 */
export const FEED_PATH = '/atom.xml';

/**
 * 复习计划表生成器（公开工具页）。★ 同一条规矩：必须带 `.html`，且不在 `/terms/` 前缀下，
 *   所以 `robots.txt` 要为它单开一扇 `Allow`。
 * ★ 路径里刻意不叫 `/tools/`：那是仓内目录名，`public-hygiene.ts` 把它算作内部字样，
 *   而 canonical 与页内链接都是公网字节——起名字的时候就被那把锁挡回来了。
 */
export const PLAN_TOOL_PATH = '/ebbinghaus-plan.html';

// ── 回应用的链接一律带来源（渠道台账 C1/C4，契约 `docs/GROWTH-SPEC.md` §2.5）──────────
//
// ★ 为什么这些常量住在这里：公开页是**零 JS 的静态文档**，它自己不会写 cookie、也不会发请求，
//   所以「从词条页来的」这件事只剩一条通路能传下去——**链接本身**。写在 `href` 里，
//   SPA 落地时读一次、存一次（`web/src/lib/attribution.ts`），之后的每个请求才带得回来。
// ⚠️ 名字要与服务端 `growth_action_day.source` 那一格能放的对上：小写、`[a-z0-9_-]`、≤24 字符。
//   这条不是风格要求——超形的部分会被 `normalizeRef` 截断，读侧看到的就不是你写的名字。

/** 中文词条页（含目录页） */
export const REF_TERMS = 'terms';
/** 英文词条页（含英文目录页）——★ 与中文侧分开：两条渠道的效果本来就该分开看 */
export const REF_TERMS_EN = 'terms-en';
/** 公开更新记录页 */
export const REF_CHANGELOG = 'changelog';
/** 复习计划表生成器 */
export const REF_PLAN = 'plan';

/** 带来源地回应用首页。 */
export function appHome(ref: string): string {
  return `/?ref=${encodeURIComponent(ref)}`;
}

