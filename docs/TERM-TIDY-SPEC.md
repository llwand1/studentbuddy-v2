# 词条库 AI 整理（Term Tidy）功能契约 v1

> 版本：v1.0.0 | 状态：[WIP] | 更新：2026-09-03
> 适用仓库：`Desktop\studentbuddy-v2`（monorepo：server / shared / web）
> 铁律来源：`AGENTS.md`（六条 ADR + 工程红线）；本文是「先改契约再改码」的载体。
> 老板拍板（2026-09-03，三项）：**对话内自然语言指挥 AI 直接改**（不做词条页按钮/自动触发）、**直接应用不预览**、**只合并不删除**。

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-03 | v1.0.0 | 首次立契：整理能力做成对话工具 `tidy_terms`（同 `search_web` 单轨），别名列 + 防再分裂入库 |

---

## 1. 目标与服务哪一环

**一句话**：词条库只进不出、领域由 LLM 自由生成越抽越碎、同义词各自成条——给对话 AI 一个「整理词条库」的工具，用自然语言指挥（「帮我整理一下词条库」「把 closure 和闭包合并」「把计算机领域改名 cs」），AI 调工具直接改库并汇报结果。

- 服务闭环：**忆（M3 词条库）** 的长期维护，不新建第六环（ADR-1 自检通过）。
- 参照范式：Anki「查找重复笔记」+ Obsidian「别名（aliases）」——同义词作为别名挂到主词条下，不丢概念（抄范式不抄包袱）。
- 入口闸门（§0.14）：三个月后被删的唯一可能是忆域整体换记忆机制；白写率低。

## 2. 现状痛点（代码实证）

| 痛点 | 根因（文件:行） |
|---|---|
| 领域碎 | `learning/terms.ts` TERMS_PROTOCOL 让 LLM 自由发明 domain，无受控词表，同一学科抽出 cs/计算机/computer science 多个 |
| 同义词成条 | `storage/db.ts` UNIQUE(term, domain) 只挡完全同词同域；机器学习/machine learning、Closure/closure 各自成行 |
| 只进不出 | 无任何整理入口，词条单调膨胀 |

## 3. 交互形态（老板拍板）

```
用户（对话）："词条太多了，帮我整理一下词条库"
  → 模型发起 tool_calls: tidy_terms { action: "auto" }
      → step 上屏「正在整理词条库…」
      → planTidy()：全部词条发 LLM，产出 [TIDY] 方案（同义词簇 + 领域归一）
      → applyTidy()：服务端校验 + 单事务落库（直接应用，无预览）
  → 工具返回结构化摘要 → 模型自然语言汇报（合并了什么、词条数变化）

用户："把 closure 和 闭包 合并"   → tidy_terms { action: "merge", terms: ["闭包", "closure"] }（确定性，不走 LLM）
用户："把计算机领域改名叫 cs"     → tidy_terms { action: "rename_domain", from: "计算机", to: "cs" }（确定性）
```

不做：词条页按钮、自动触发、预览确认（均被否）。

## 4. 数据模型（DB 迁移 v7）

```sql
-- v7：词条库 AI 整理（2026-09-03 契约）
-- 被并入的同义词挂在主词条的 aliases（JSON string[]）上，概念不丢、可追溯
ALTER TABLE term_library ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
```

- 认知进化契约（`COGNITIVE-EVOLUTION-SPEC.md`，待评审未实现）原定 v7，本功能实现**在前**、占用 v7，该契约已同步改 v8。
- tidy 状态（上次整理时间/统计）落既有 `app_settings`（键 `term_tidy_state`），不建表。

## 5. `[TIDY]` 输出协议（模型侧）

```
[TIDY]{"clusters":[{"keep":"<保留词条 id>","term":"<主词条名>","domain":"<归一后领域>","merge":["<被并入 id>"],"reason":"<一句话理由>"}],"domainRenames":{"<旧领域>":"<新领域>"}}[/TIDY]
```

规则（写进提示词）：
1. 只合并**同一概念的不同写法**（同义词、中英互译、大小写/单复数变体、缩写）；不确定是否同一概念**绝不合并**（宁缺勿滥）。
2. `term` 必须取簇内已有词条名（服务端校验，杜撰即丢簇）。
3. `domainRenames` 把碎领域归到规范名；已有规范领域名（english/math/cs…）优先沿用。
4. 无可合并输出空 `clusters`、无领域可归一省略 `domainRenames`。
5. 输入为全库词条（`id | term | domain | 释义截 60 字`），上限 1000 条（importance+usage 排序截断，超出在结果中说明）。

## 6. 合并语义（applyTidy，单事务）

| 字段 | 合并规则 |
|---|---|
| term | 簇声明的 canonical（须为簇内已有名） |
| definition | 簇内 importance 最高者的释义（平手取 keep 行） |
| domain | 簇声明值经 domainRenames 归一后 |
| importance | max |
| usage_count | sum |
| last_used_at | max |
| created_at | min（保留最早学习时间） |
| source_session_id | COALESCE(keep 行, 簇内首个非空) |
| aliases | 簇内其他成员 term ∪ 其他成员 aliases，去重并剔除 canonical 本身 |

- 被并入行**删除**（概念保留在 aliases，属「合并」不属「删除概念」，符合拍板）。
- domainRenames 应用后若撞 UNIQUE(term, domain)（改名把同词同域挤到一起）→ 自动按同语义合并。
- 校验（applyTidy 前置）：簇内 id 全部存在、≥2 条、canonical 在簇内；不合规簇整簇丢弃不应用（ADR-4 降级）。

## 7. 防再分裂（否则整理完几天又乱回去）

1. **别名感知入库**：`saveTerms`/`saveOneTerm` 入库前建索引——新词条命中已有词条的 aliases（大小写不敏感，跨域）→ 并入该行不新建；同词同域大小写不敏感命中 → 并入。
2. **抽取领域引导**：`extractTerms` 提示词注入已有领域 top-12，引导新词条优先归入既有领域。
3. **别名计数**：`countUsage` 匹配 term + aliases（大小写不敏感），合并后英文别名在回复中出现照样计数。

## 8. 模块与红线

| 文件 | 职责 | 预估行数 |
|---|---|---|
| `learning/tidy.ts`（新） | [TIDY] 协议/解析/校验/应用 + mergeTerms 点名合并 + renameDomain | ~300（≤400 ✓） |
| `learning/terms.ts` | 别名索引并入 + countUsage 别名 + 抽取领域引导 | 258→~310（≤400 ✓） |
| `chat/tools.ts` | 注册 `tidy_terms`（auto/merge/rename_domain 三 action） | 88→~150 |
| `web/features/terms/TermsPage.tsx` | 词条行展示 aliases | 205→~215（≤300 ✓） |
| `chat/flow.ts` | **零改动**（工具注册表单轨，G3） | 0 |

SSE step 事件为通用契约（tool/status/detail），不新增事件类型；不新增 HTTP 路由；不新增 DomainEvent（整理非学习行为，不记 XP）。

## 9. 测试清单（§0.8 强制）

| 文件 | 用例要点 |
|---|---|
| `learning/tidy.test.ts`（新） | 解析容错（围栏/杂质/畸形→null）；校验丢弃无效簇（id 不存在/单条簇/canonical 杜撰）；合并语义逐字段（usage sum/imp max/def 取最高/aliases 并集/created 最早/成员删除）；domainRenames + UNIQUE 冲突自动合并；tidy 状态落 app_settings；mergeTerms 找不到词条如实报告；renameDomain 空领域报告；空方案零变更 |
| `learning/terms.test.ts` | +命中别名并入不新建；+同词同域大小写不敏感并入；+countUsage 别名与大小写命中 |
| `chat/flow.test.ts` | +tidy_terms 工具全链路（模型 tool_calls → 真执行 → 摘要回灌 → step 事件） |

通过后同步 `docs/dev/test-plan.md` 基线与不变量；`npm run check`（Node 20）全绿。

## 10. 风险（§0.5）

| 级别 | 风险 | 处置 |
|---|---|---|
| P1 | LLM 误合并（把相近概念判成同义词）→ 词条被并 | 提示词「不确定绝不合并」+ 校验丢无效簇 + aliases 保留全部被并词名可人工复原；直接应用是老板拍板，风险已知情 |
| P2 | 整理 LLM 调用失败/超时 | 工具捕获返回失败文案，对话不崩（ADR-4，同 search_web） |
| P2 | 词条过多撑爆单次 LLM | 1000 条上限 + 截断说明 |
| P2 | 工具参数乱填（action 缺失/terms 空） | 工具入口校验，返回引导文案让模型重调 |
