# SEO-SPEC — 词条长尾静态页（公开门面）

> 版本：v0.1.0 | 状态：[活跃] | 更新：2026-09-22
>
> 本契约管的是**本站第一次对外部访客与搜索引擎公开的内容面**：一批独立静态词条页、`robots.txt` 的放行口径、`sitemap.xml`。
> 产品内的词条（`term_library`）是**用户私有数据**，与本文件说的「词条页」不是一回事，见 §4 红线。

## 1. 为什么做

线上定位是演示与试用（见 `DEPLOY.md` 与产品叙事），冷启动靠付费投放不成立。本渠道是免费推广清单里的第 1 项：
**用搜索能命中的讲解页，把「这个产品解决什么」摆到访客面前**，页尾再给一条回主站的路。

三件事按老板 2026-09-22 的拍板定案（不是我的默认值）：

| 决策点 | 定案 | 代价（写清楚，别事后当意外） |
|--------|------|------------------------------|
| 抓取闸怎么开 | `robots.txt` **默认全封，只用 `Allow` 精确开门**：`/$`（首页）与 `/terms/`（词条页）两扇 | 以后应用里新增的客户端路由不会被顺手放出去；代价是**新公开面要记得来改这个文件** |
| 页面写哪类词条 | **学习科学概念 12 页**（提取练习／间隔重复／遗忘曲线／交错练习／必要难度／精细加工／组块／认知负荷／元认知／概念图／费曼学习法／学习迁移） | 搜索量小于「学科知识点」，但**事实可控**：这类内容我们讲得准，也不必承诺学科正确性 |
| URL 形状 | `/terms/<拼音slug>.html`，**带扩展名** | 实测线上 Caddy 对**无扩展名**路径一律 `try_files → /index.html`（`/terms/1234` 与 `/` 返回同一份 SPA 壳）⇒ 带 `.html` 才走静态文件通道。用扩展名换掉一次服务器配置改动 |

## 2. 机制

```
packages/web/src/seo/term-entries-a.ts ┐
packages/web/src/seo/term-entries-b.ts ┘→ term-corpus.ts（唯一事实源：类型＋拼装＋URL）
                                     ↓
                    term-page.ts（纯函数：词条 → 完整 HTML 字符串）
                                     ↓
        ssg.ts::writeSeoPages(dist)  ←─ vite.config.ts 的 closeBundle(order:'post')
                                     ↓
   dist/terms/<slug>.html ×12 ＋ dist/terms/index.html ＋ dist/sitemap.xml
```

- **构建期生成，运行期零依赖**：Node 服务端与 SPA 都不参与，页面是纯静态文件，Caddy 直接发。
- **产物随 `deploy.sh` 的 tar 上线**（`packages/web/dist` 在包内），不需要任何服务器改动。
- 页面**不带 `<script>`**，只有一个 `<link>`（canonical）；样式自带一小段，不引 SPA 产物 ⇒ 关掉 JS 也读得到正文。
- 首页壳（`packages/web/index.html`）同时补了 `<title>`／description／og 三件，此前是 `<title>studentbuddy</title>` 裸奔。

## 3. 数据口径

- `sitemap.xml` 条数＝首页 ＋ 目录页 ＋ 12 条词条页 = **14**。
- `lastmod` 取构建当天。**手工维护代价为零、失真代价也低**，故不引入「内容真实修改时间」那套账（要做就得配语料版本表，本批刻意不做）。

## 4. 三条红线（由机器守，不靠自觉）

| 红线 | 为什么 | 守它的锁 |
|------|--------|----------|
| 页面里**不出现任何使用量数字**（人数／好评／满意度） | 真实计数（批次 B）尚未上线，写一个数字就是造假；而这是全站唯一对外宣称事实的地方 | `term-corpus.test.ts`「诚实红线」组：正则封掉「已有 N 人」「超过 N」「N 名用户」等形状 |
| **不引用真实用户的词条** | `term_library` 全是私有数据，`owner_id` 之外无人可读（TENANCY-SPEC §8） | 语料是仓内常量文件，与库无任何 import 关系（结构上不可能读到） |
| **不许诺学习效果**（包过／提分／记忆力提升） | 机制可以讲，疗效不能讲 | 同上一组测试里的第二把锁 |

补充两条软口径（暂未成锁，改语料时人盯）：词条正文里不出现具体产品数字（接口数、提交数），也不点名第三方产品做对比。

## 5. 已知代价与刻意未做

1. ⚠️ **`/terms/`（目录页）依赖 Caddy 的目录索引行为**，本批未在线上真机验证。最坏情况：它回落到 SPA 壳（人畜无害，只是目录页对爬虫没内容）。**12 个 `.html` 页不受影响**。上线后用 §6 的第 4 条判据验，不成再决定改 Caddy 或改用 `all.html`。
2. **没做 JSON-LD 结构化数据**（`DefinedTerm`／`Article`）：线上 CSP 是 `script-src 'self'` 的 Report-Only，内联 `<script type="application/ld+json">` 会不会刷报告未实测，先不放。
3. **英文侧词条页未做**：落地页已双语，词条页只有中文。英文访客的长尾要靠另一批。
4. **应用内没有入口指向这批页**（登录后侧栏看不见），只有页面之间互链与回首页。是否在产品里挂「学习科学词条」目录，属产品决策，留给老板。
5. `robots.txt` 的 `Allow` 口径只管**自觉爬虫**；对无视 robots 的抓取，私有面仍由 `SB_REQUIRE_AUTH` 与鉴权守（那才是真闸）。

## 6. 上线与验收判据（发版后逐条 curl）

1. `curl -s https://11wand.com/robots.txt` ⇒ 含 `Allow: /terms/` 与 `Sitemap:` 行。
2. `curl -sI https://11wand.com/terms/tiqu-lixian.html` ⇒ `200 text/html`。
3. `curl -s .../terms/tiqu-lixian.html | grep -c '<script'` ⇒ **0**；`grep -o '<title>[^<]*'` ⇒ 该页自己的标题。
4. `curl -s -o /dev/null -w '%{http_code}' https://11wand.com/terms/` ⇒ 200 且正文含「学习科学词条」（见 §5 第 1 条）。
5. `curl -s https://11wand.com/sitemap.xml` ⇒ 14 个 `<loc>`、xmlns 为 `sitemaps.org`。
6. 三条红线：页面上找不到任何「N 人」「好评」「包过」字样。

## 7. 维护

- 加一条词条＝在 `term-entries-a/b.ts` 追加一项（**任一文件超 400 行就再开一个 `term-entries-c.ts`**，gates 会拦），`sitemap`／目录页／互链全自动跟上。
- `related` 只写 slug，**写错会立刻红**（`term-corpus.test.ts` 的死链锁）。
- 页面文案改动无需重新部署以外的动作：改语料 → `npm run build` → 发版。
