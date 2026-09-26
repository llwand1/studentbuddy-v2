/**
 * storage/migrations-list — 迁移清单**聚合出口**（唯一对外出口，`migrations.ts` 只认 `MIGRATIONS`）。
 *
 * 清单数据已按版本区间拆到三个分片文件（2026-09-16 二次拆分 / **2026-09-17 三次拆分**）：
 *  · `migrations-list-v1-9.ts`  —— v1~v9  建库地基 / M2 练析 / M3 忆 / M4 反馈环 /
 *                                M5 忆域重做 / 文档模式 / 词条整理 / 深度理解 / 可观测
 *  · `migrations-list-v10.ts`   —— v10~v17（PK 域 / 过程回放 / 刷题笔记 / 呈现形态 /
 *                                方案选择框 / 对战历史 / 长期记忆 / 看图）
 *  · `migrations-list-v18.ts`   —— v18 及之后（学习流 / 领域一等实体 / 情景题 / **账号与会话**）
 *                                ★ 加新迁移加到这一片（v21 加完后 `-v10.ts` 触 400 红线的产物）
 *  · `migrations-list-v22.ts`   —— v22~v29（会话归属 / 艾宾浩斯 / 画像归主 / 复习督促 /
 *                                情景题 / 验证码 / 复习范围 / **LLM 成本归主**）
 *  · `migrations-list-v30.ts`   —— v30 及之后（M2d-1 设置与反馈环归主）
 *  · `migrations-list-v31.ts`   —— v31~v39（M2d-2 词条库 / 领域 / 提及流水归主 / 全站 FTS /
 *                                平台配额 / GitHub OAuth / 知识图追问）
 *  · `migrations-list-v40.ts`   —— **v40 及之后**（GitHub 独立建号）
 *                                ★ 加新迁移加到这一片（v31 片装到 379 行后切出，见下）
 *  · `migrations-list-v43.ts`   —— **v43 及之后**（AI 主动发起对战的邀请）
 *                                ★ 新开一片的理由写在那片文件头（避同仓另一会话在途的 v41 片），
 *                                  ⚠️ 那片还钉着一条「v43 不得早于 v42 发版」的执行器拦路牌
 *  · `migrations-list-v44.ts`   —— **v44 及之后**（★ 本仓**第一条删除型迁移**：学习流/知识图七张表下线）
 *                                ★ 另起一片同样是为了不踩同伴当天落地的 `-v43.ts`；
 *                                  ⚠️ 本片文件头钉着两条常驻约束（链上历史不回改、`revertV33()`
 *                                    不能再对已删表做 ALTER），往这片加东西前先读它
 *
 * **拆分理由**：清单是**只会单向增长**的数据。本文件 2026-09-14 从 `db.ts` 拆出（当时
 * 404 行触 AGENTS.md「.ts ≤400 行」红线），拆完 387 行；2026-09-16 加 v18（学习流，七张表）
 * 后切出 `-v10`；**2026-09-17 加 v21（账号与会话）后 `-v10` 再涨到 426 行 ⇒ 三次拆分**。
 * 分片文件里原有注释写明的规矩是「**按版本区间再切，不要用「压注释」换行数**」
 * ——那些注释记的是每张表**为什么这么建**，价值远高于行数，故本次严格照此办理。
 *
 * **零行为改动**：迁移语句与注释一字未改，只是换了文件放。执行器（`migrations.ts`）
 * 一行未动，仍然只消费 `MIGRATIONS` 这一个数组。
 *
 * ★ 追加新迁移 ＝ 往 **`migrations-list-v40.ts`** 数组**尾部**加一项（v 号顺延），
 *   **不要动既有项**——已应用的版本号是历史锚点，改了不会重跑，只会让新库与老库结构分叉。
 *   （2026-09-23 批次 F-2 起落点是 **v41 分片**；v40 在 `-v40.ts`、v31~v39 在 `-v31.ts`、v22~v29 在 `-v22.ts`。）
 *   **2026-09-24 起落点改为 `-v43.ts` 片尾**（新开一片避同仓另一会话在途的 v41 片，理由与一条
 *   执行器拦路牌都在那片文件头；等 v41/v42 那片空下来可并片，纯搬运零行为改动）。
 *   **2026-09-25 起落点是 `-v44.ts` 片尾**（同一条理由再沿用一次：`-v43.ts` 是同伴当天落地、
 *   登记簿上仍挂 [WIP] 的文件）。
 *   **2026-09-25（同日第二跳）本批另开 `-v45.ts` 一片**：`-v44.ts` 也是同伴当天落地、且同仓仍有
 *   会话在途 ⇒ 同一条理由第三次沿用。并片随时可做（纯搬运、零行为改动）。
 * ⚠️ 回放迁移链的测试必须把**加列**也 DROP 掉（`ALTER TABLE ADD COLUMN` 不幂等，
 *   本仓实测踩过 `duplicate column name: summary` / `: images`，见 `storage/db.test.ts`）。
 */
import { MIGRATIONS_V1_9 } from './migrations-list-v1-9.js';
import { MIGRATIONS_V10 } from './migrations-list-v10.js';
import { MIGRATIONS_V18 } from './migrations-list-v18.js';
import { MIGRATIONS_V22 } from './migrations-list-v22.js';
import { MIGRATIONS_V30 } from './migrations-list-v30.js';
import { MIGRATIONS_V31 } from './migrations-list-v31.js';
import { MIGRATIONS_V40 } from './migrations-list-v40.js';
import { MIGRATIONS_V41 } from './migrations-list-v41.js';
import { MIGRATIONS_V43 } from './migrations-list-v43.js';
import { MIGRATIONS_V44 } from './migrations-list-v44.js';
import { MIGRATIONS_V45 } from './migrations-list-v45.js';

export const MIGRATIONS: Array<{ version: number; statements: string[] }> = [
  ...MIGRATIONS_V1_9,
  ...MIGRATIONS_V10,
  ...MIGRATIONS_V18,
  ...MIGRATIONS_V22,
  ...MIGRATIONS_V30,
  ...MIGRATIONS_V31,
  ...MIGRATIONS_V40,
  ...MIGRATIONS_V41,
  ...MIGRATIONS_V43,
  ...MIGRATIONS_V44,
  ...MIGRATIONS_V45,
];
