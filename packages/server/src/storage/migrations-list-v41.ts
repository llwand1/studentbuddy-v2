/**
 * storage/migrations-list-v41 — **v41 及之后**的迁移分片（2026-09-23 批次 F-2 开片）。
 *
 * **为什么又切一片**：上一片 `-v40.ts` 只有 39 行，但它的头注写死了「v40 及之后」——
 * 沿用 v10／v18／v22／v30／v31／v40 六次同款先例，**一个版本区间一个文件**，
 * 不去把 v41 塞进一个已经带完「v40 及之后」标题的分片里（那样下一个人找不到落点）。
 */

/**
 * ── v41：诚实计数（渠道台账 C4，契约 `docs/GROWTH-SPEC.md` §2）──
 *
 * 背景：落地页想挂「已有 N 人体验过」，而 09-23 的线上取证**证伪了现有口径**——
 * GoatCounter 的原始 `hits` 表 0 行 ⇒ 精确 UV 根本算不出来，「人」这个字在数据上不成立。
 * ⇒ 老板 2026-09-23 拍板：**只数产品内真实动作，标签只许写「次」**（总口径 §0 第 2 条）。
 *
 * ★★ **为什么是「一事件一行、按 (动作, 桶, 自然日) 做主键」而不是「一个计数器列加加」**：
 *   1. 判据要求「同一 IP 刷新不重复计」⇒ 去重键就是主键本身，`INSERT OR IGNORE` 天然幂等，
 *      **不需要读改写**（计数器列在并发下要么丢失更新、要么上事务锁）；
 *   2. 计数器列一旦写进去，「这个数怎么来的」就永久丢失了——而这张表要对外解释一个数字，
 *      保留「哪一天、哪个桶、哪种动作」才能把数复算一遍（C10 的判据正是「能复算对上」）；
 *   3. ⚠️ 代价如实记：表会随行数增长（每 IP 每动作每天最多一行）。按 09-23 实测的量级
 *      （一天十几个访客）**几年也到不了一万行**，故不建归档、不建清理任务——那是给假想需求做设计。
 *
 * ★ `bucket` **不是 IP**，是 `sha256(盐 + IP)` 的前 16 位十六进制：
 *   统计要按「人」的近似去重，但把访客 IP 明文落库既没必要、又是这张表唯一可能被拿去
 *   对号入座的字段。盐在 `growth_secret` 里，同库稳定 ⇒ 同 IP 同天才塌到同一行。
 *
 * ★ `growth_secret` 只许一行，由本迁移用 SQLite 的 `randomblob` 当场生成（**不读环境变量**：
 *   多一个必须配的键就多一处「漏配即静默退化」，而这里的退化方向是「盐变成常量」＝可被枚举）。
 *   ⚠️ 连带后果写清楚：**从备份恢复库会把盐一起换掉** ⇒ 恢复后同一 IP 会再算一次（少计与虚计之间
 *   选了「不谎报历史」，代价是恢复当天可能多出一小截，读侧口径不变）。
 */
export const MIGRATIONS_V41: Array<{ version: number; statements: string[] }> = [
  {
    version: 41,
    statements: [
      `CREATE TABLE IF NOT EXISTS growth_secret (
        salt TEXT NOT NULL
      )`,
      // 只灌第一行：表已有行时这条整体不写（WHERE 恒假），所以迁移重跑不会换盐
      `INSERT INTO growth_secret (salt)
       SELECT lower(hex(randomblob(16)))
       WHERE NOT EXISTS (SELECT 1 FROM growth_secret)`,
      `CREATE TABLE IF NOT EXISTS growth_action_day (
        kind TEXT NOT NULL,
        bucket TEXT NOT NULL,
        day TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY (kind, bucket, day)
      )`,
    ],
  },
];
