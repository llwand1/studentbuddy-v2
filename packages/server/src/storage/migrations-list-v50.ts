/**
 * v50（2026-09-29 网络配图：`search_images` 与出题配图）
 *
 * - `media_attribution`：本地缓存图（`storage/image-cache.ts` 的内容 hash 文件名）→ 出处、许可、作者、看图结论。
 *   图文件本身已按内容去重；这张表让「显示署名」「清理时知道图从哪来」有据可查。
 * - `image_query_cache`：检索词 + 主题 → 已核验通过的图（30 天）。同一个「线粒体」被问一百次，只找一次、只看一次。
 * ★ 新表 + CREATE IF NOT EXISTS（不 ALTER 旧表，理由同 v47/v48/v49）。
 */
export const MIGRATIONS_V50: Array<{ version: number; statements: string[] }> = [
  {
    version: 50,
    statements: [
      `CREATE TABLE IF NOT EXISTS media_attribution (
        name        TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        page_url    TEXT NOT NULL DEFAULT '',
        license     TEXT,
        author      TEXT,
        title       TEXT NOT NULL DEFAULT '',
        depicts     TEXT NOT NULL DEFAULT '',
        verified    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS image_query_cache (
        key         TEXT PRIMARY KEY,
        names       TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ],
  },
];
