/**
 * storage/migrations-list-v46 — **v46**（2026-09-28）：「余烬笺 · 意外发现」。
 *
 * 玩家可以给自己的一条词条写一张**余烬笺**（用自己的话写的理解 + 署名），它会以一簇异色篝火的样子
 * 随机出现在**别的玩家**的知识大陆上；走近即可读到，并可「收入卡册」（把这条词条加进自己的库）
 * 或「添柴致谢」（作者能看到被谢了几次）。
 *
 * ★ 只建新表、零 ALTER（与 v45 同一条理由：回放迁移链天然幂等）。
 * ★ 写笺是**显式动作**＝公开同意：没写过笺的词条永远不会出现在别人的大陆上；署名由作者自己填，
 *   不回读邮箱等账号信息。
 */
export const MIGRATIONS_V46: Array<{ version: number; statements: string[] }> = [
  {
    version: 46,
    statements: [
      // ★ 词条内容做**快照**（term/domain/definition）：作者之后改词条、删词条，已经传出去的笺不跟着漂移；
      //   作者删笺才会真的下线。`thanks` 是计数缓存，真账在 `ember_mark`（kind='thanked'）里，可重算。
      `CREATE TABLE IF NOT EXISTS ember_note (
        id          TEXT    NOT NULL PRIMARY KEY,
        owner_id    TEXT    NOT NULL DEFAULT '',
        term_id     TEXT    NOT NULL,
        term        TEXT    NOT NULL,
        domain      TEXT    NOT NULL DEFAULT '',
        definition  TEXT    NOT NULL DEFAULT '',
        body        TEXT    NOT NULL,
        sign        TEXT    NOT NULL,
        hue         TEXT    NOT NULL DEFAULT 'cyan',
        thanks      INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      )`,
      // 一条词条只留一张笺（再写就是改写）
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_ember_note_term ON ember_note(owner_id, term_id)`,
      // 读者侧的标记：kept 收入卡册 / thanked 致谢 / hidden 不想再看（举报也落这里，先对自己下线）
      `CREATE TABLE IF NOT EXISTS ember_mark (
        owner_id  TEXT NOT NULL DEFAULT '',
        note_id   TEXT NOT NULL,
        kind      TEXT NOT NULL,
        at        TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (owner_id, note_id, kind)
      )`,
    ],
  },
];
