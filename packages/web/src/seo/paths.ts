/**
 * 公开静态词条页的站内路径 —— 构建侧（`term-corpus`／`ssg`）与 SPA 侧（落地页页脚、
 * 词条库空态）共用的唯一一份。
 *
 * ★ 为什么单开一个文件：应用只需要一个路径字符串，不该为了拿它把 12 条语料拽进包体。
 * ★ 必须带 `.html`：线上 Caddy 没有目录索引，目录形式 `/terms/` 会被 `try_files`
 *   兜成 SPA 壳（09-23 实测：壳 1487 B / 真目录 5705 B），差一个扩展名就吐不出内容。
 */
export const CATALOG_PATH = '/terms/index.html';
