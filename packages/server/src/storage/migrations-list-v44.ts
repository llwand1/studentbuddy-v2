/**
 * storage/migrations-list-v44 — **v44 及之后**的迁移分片（2026-09-25，学习流/知识图功能整体下线）。
 *
 * **为什么又切一片、不追加进 `-v43.ts`**：那片是同伴批次（AI 主动发起对战，`1b40c66`）当天刚落地的
 * 文件，登记簿上该会话仍挂 [WIP] ⇒ 追加进去等于把两批的提交顺序变成隐式耦合（与 `-v43.ts`
 * 自己当初立项的理由同一条）。聚合出口 `migrations-list.ts` 各挂一行。
 *
 * ⚠️ **本批是删除型迁移**，与仓里此前四十三条「只加不减」的取向相反。因此有两条常驻约束：
 *  1. **链上历史一字不回改**（`-v18.ts` 的建表、`-v31.ts`/`-v33.ts` 的加列全部原样留着）：
 *     已应用的版本号是历史锚点，回改会让新库与老库结构分叉。⇒ 结果是**重放整条链时这七张表
 *     会"先被建出来、再被删掉"**，这是有意的，不是遗漏。
 *  2. 于是「退版本重放」那批用例里的 `revertV33()` **不能再对 `flow_*`／`knowledge_*` 做 ALTER**
 *     （v44 之后新库里它们不存在 ⇒ `no such table`），只退仍然活着的三张 `quiz_*`。
 *     该 helper 的注释里写明了这件事，别把它当手滑删的用例改回去。
 *
 * ⚠️ **并且：往后链上每 DROP 掉一张表，所有"退版本重放"用例都要在退之前把那张表按它当初的
 *   建表语句补回来**。本批实测踩到的就是这条——`db.test.ts` 造老库的手法是「开最新库、抹
 *   `schema_version`」，v44 之前那个替身等价、之后不等价（表已经没了），改完 helper 前
 *   **14 例同时红在 `no such table: flow_def`**。★ 而生产路径一直是好的：真实的 v32 老库里
 *   这五张表本来就在。⇒ **这是测试替身的破绽，不是迁移的 bug**，但它的表现方式与真 bug 一样。
 *
 * ⚠️ **刻意不含 `VACUUM`**：执行器 `migrations.ts` 是「每版一个事务」，而 SQLite 的
 *   `VACUUM` 不能在事务里跑（`cannot VACUUM from within a transaction`）⇒ 加了会让迁移直接失败。
 *   代价：库文件不会因删表而变小，但空出的页会被后续写入复用。要真的缩小文件只能发版后手工做。
 *
 * ★ 数据**不做备份、不做归档**：老板 2026-09-25 判决「也一起删了，现在用户太少了，没有必要留着，
 *   因为之后有大规划」。`flow_*`/`knowledge_*` 那七张表里如有真实用户数据，跑完这条迁移就没了。
 *   这条决定留在 CHANGELOG 本批行与 `docs/STUDY-FLOW-SPEC.md` 的墓碑里，不在这里重复。
 */
export const MIGRATIONS_V44: Array<{ version: number; statements: string[] }> = [
  // v44：学习流（功能页 + 运行器 + 五张表）与知识图（两张表）下线，2026-09-25。
  //
  // ★ `IF EXISTS` 不是习惯性多写：v44 之后**新建的库**同样会跑这一版（v18 建完 v44 删），
  //   而"退到 v43 再重放"的用例会对**已经删过一遍**的库二次执行 ⇒ 不写 IF EXISTS 就是第二次红。
  // ★ 顺序按"子表在前、定义表在后"排（与 v18 建表的层级同序）：SQLite 不强制，但它让读迁移的
  //   人一眼看出这七张是同一层的东西，删的时候心里有层级。
  // ★ 索引不需要单独 DROP：`DROP TABLE` 连带删掉该表上的全部索引（`migrations-v44.test.ts`
  //   钉了「不留孤儿索引」，因为孤儿索引会让下一次同名建表撞 `already exists`）。
  {
    version: 44,
    statements: [
      `DROP TABLE IF EXISTS flow_step`,
      `DROP TABLE IF EXISTS flow_edge`,
      `DROP TABLE IF EXISTS flow_run_step`,
      `DROP TABLE IF EXISTS flow_run`,
      `DROP TABLE IF EXISTS flow_def`,
      `DROP TABLE IF EXISTS knowledge_edge`,
      `DROP TABLE IF EXISTS knowledge_node`,
    ],
  },
];
