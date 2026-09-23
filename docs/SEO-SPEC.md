# SEO-SPEC — 词条长尾静态页（公开门面）

> 版本：v0.1.5 | 状态：[活跃] | 更新：2026-09-23 23:1x（**v0.1.5：批次 G-1 补上一条静态可抓入口（v0.2.117，未发版）＋ §5 新增第 11 条红线「SPA 里的入口对不执行 JS 的抓取器不存在」**——今天读线上数据定性：Googlebot 抓了 `/` 与 `/robots.txt` 却没抓 sitemap 与词条页，而线上首页只有 1487 字节空壳、零静态 `<a>` ⇒ 批次 E 那两处入口是 React 渲染产物。补法＝`index.html` 一条**静态**目录页链接＋一个 `<link rel="sitemap">`，容器带 `hidden`，并把它「必须不可见」也做成了锁。★ 新增 §6 第 9 条：那条判据**发版前后都该跑一次**，因为它量的就是「不执行 JS 的那一份字节里有没有这条路」）｜前值 v0.1.4（2026-09-23 19:1x **v0.1.4：批次 F-3 给 14 页公开页装上分享卡（`og:image` 1200×630，v0.2.116，未发版）**——★ 两条新代价进 §5 第 10 条：**PNG 是提交资源**（改了语料不重跑 `npm run og:shots` 就是旧图，内容陈旧机器拦不住）、`robots.txt` 为 `/og/` 开了一扇 `Allow`（Google 图片抓图看 robots）；★ 验收新增 §6 第 8 条，判据带 **`content-type: image/png` ＋ 字节数**，理由正是 v0.1.3 那条前科：本站错地址也返 200 壳。v0.1.3：批次 E 发版（09:54）后线上复验，七条判据全绿，实录见 §6.1；同批补一条取证出来的代价——**不存在的 `/terms/*.html` 返 200 壳而不是 404**（§5 第 9 条），并把 §6 第 2 条判据从「看状态码」改成「状态码＋字节数」，因为光看状态码这类问题一律漏网。v0.1.2：目录页地址换正＋两处入口；v0.1.1：线上只读取证后补两条代价——① 词条页零 JS ⇒ **GoatCounter 永远数不到它们**，效果只能看 Caddy 日志（§5 第 6 条＋§6 第 7 条判据）；② **Googlebot 已在场、Baiduspider 从没来过** ⇒ 发版对 Google 是顺水推舟，对百度必须另去站长平台主动提交（§5 第 7 条）。v0.1.0：2026-09-22 初版）
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
                                     ↑
                  paths.ts（CATALOG_PATH 一个常量，SPA 侧与构建侧共用）
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
- **指向目录页的链接一律从 `paths.ts` 的 `CATALOG_PATH` 拼**（值是 `/terms/index.html`）：SPA 侧（落地页页脚、词条库空态）与构建侧（页内导航、`sitemap`、canonical）共用同一个常量，两侧各写一份必然漂。
- ★ **分享卡（批次 F-3）也走同一个事实源**：`src/seo/og-card.ts` 是卡面文案与 `og:image` 那四行 meta 的**单点**（它从 `term-corpus` 取字段，不另写一份文案），`term-page.ts` 的 `head()` 与首页壳的 og 块都对着它；14 张 1200×630 PNG 落 `packages/web/public/og/`、随构建进 `dist/og/`，重新生成＝`npm run og:shots`。⚠️ **它们是提交资源、不是构建产物**，理由与代价见 §5 第 10 条。

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

1. ✅ **目录页地址（09-23 09:09 线上实测已定，批次 E 已按此改）**：原先挂的「依赖 Caddy 目录索引行为」已证伪——线上**没有目录索引**，`try_files {path} /index.html` 把目录形式 `/terms/` 兜成了 SPA 壳（**1487 字节、正文一句都没有**），而 `/terms/index.html` 吐的是真目录（**5705 字节**）。⇒ 目录页地址从此**必须是带扩展名那一个**，由 `term-page.test.ts` 的「一条目录形式的链接都不留」与「每条 `/terms/` 链接都有落盘文件」两把锁守着（含 `sitemap` 里也不许出现 `https://11wand.com/terms/`）。
2. **没做 JSON-LD 结构化数据**（`DefinedTerm`／`Article`）：线上 CSP 是 `script-src 'self'` 的 Report-Only，内联 `<script type="application/ld+json">` 会不会刷报告未实测，先不放。
3. **英文侧词条页未做**：落地页已双语，词条页只有中文。英文访客的长尾要靠另一批。
4. ✅ **产品内入口**（批次 E，09-23 09:54 已发版）：两处——落地页页脚一条站内链接（同标签页，爬虫从首页走得到），词条库**空态**一条（新标签，只给「还没有词条、不知道该存什么」的人；有词条的人不显示）。★ 刻意**不是**侧栏常驻项：登录后应用是干活的地方，挂一排外部阅读页是噪音。真机排版与文案待老板判（`manual-test.md` MT-16）。
5. `robots.txt` 的 `Allow` 口径只管**自觉爬虫**；对无视 robots 的抓取，私有面仍由 `SB_REQUIRE_AUTH` 与鉴权守（那才是真闸）。
6. ★ **这批页零 `<script>`（§4 的锁），代价是「GoatCounter 数不到它们」**——统计靠的是页面里那段 JS 埋点，爬虫可读＝统计不可读。⇒ **词条页的真实访问量只能从 Caddy 访问日志看**（`grep -oE '"uri":"/terms[^"]*' /var/log/caddy/access.log`），**不要**去 GoatCounter 里找它，更**不要因为 GoatCounter 上词条页是 0 就判定「没人看」**。要不要给词条页补一条不破坏「零脚本」承诺的计数通道（服务端日志入表），属后续决策。
7. ★ **中文长尾的真实瓶颈不在代码，在「百度没来过」**（2026-09-23 08:47 只读取证；日志跨度自 09-19 23:40）：**Googlebot 每 1～2 天来访，并主动读 `robots.txt`**（最近一次 09-22 21:00）⇒ 线上那条 `Disallow: /` 一改，`Allow: /terms/` 立刻对它可见，**发版就是顺水推舟**。而 **Baiduspider 一次都没出现过**：日志里带 "Baidu" 字样的三类 UA 中，09-22 11:00 那批（`Baidu; P1 5.1.1) NABar/1.0` 在扫 `/junhuashen.php`、`/index.php/user/login`）是**伪装百度 UA 的漏洞扫描器**，不是蜘蛛。⇒ 百度侧必须去**百度搜索资源平台验证站点＋主动推送 API 提交**，光改 robots 与 sitemap 不会自己生效；这一步是老板本人的账号动作（要手机号/邮箱验证），AI 不代做。

8. ★ **站长验证文件的通路（渠道台账 C9），坑在 `robots.txt`**：本站 robots 是「**默认全封、只用 `Allow` 精确开门**」的口径 ⇒ 老板从 Google／百度搜索资源平台拿到验证文件（形如 `googleAb12cd.html`／`baiduAb12cd.txt`）后，**只把文件放进 `packages/web/public/` 是不够的**——Googlebot 与 Baiduspider 抓它会先读 robots，被 `Disallow: /` 挡住就直接验证失败（文件本身线上可 curl 到，爬虫却不去）。正路四步：① 文件放进 `packages/web/public/`（带扩展名 ⇒ 构建后进 `dist/` 根，Caddy 按静态文件直出，这条实测同 `robots.txt` 本身）；② `packages/web/public/robots.txt` 加**一条精确 `Allow`**（★ 别写通配：百度老 parser 不认 `Allow: /*.html` 这类形状）；③ `npm run build` 后本地核 `dist/<文件名>` 与 robots 两样都在；④ 发版（逐次点名授权）后再回平台点「验证」。meta 标签那条路同理，但它是首页 HTML，`Allow: /$` 已经放行，不用改 robots。

9. ★ **不存在的 `/terms/*.html` 不返 404，返 200 ＋ SPA 壳**（09-23 09:56 取证：`curl -sI /terms/bu-cun-zai.html` ⇒ `200`、`Content-Length: 1487`）。这是 `try_files {path} /index.html` 那条兜底的**另一面**：§5 第 1 条用它解释了「为什么目录形式是壳」，同一机制也让**任何错地址都长得像活页**。⇒ 两条后果：① **验收判据不许只看状态码**，必须核字节数（真页 5.9～6.2 KB，壳 1487 B），本批 §6 第 2 条按此加强；② 对爬虫这是一类 **soft 404**——语料改 slug、或外链写错一个字符，页面不会被机器拦下，只会被 Google 判成「空页」并**拖累整节的可信度**。目前唯一的守法是仓内的死链锁（`term-corpus.test.ts` 的 `related` 锁＋`term-page.test.ts` 的「每条链接都有落盘文件」锁），★ 它管不到**别人写错的外链**，那一段没有解，除非给 `/terms/` 单独配一条真 404（要动 Caddy，属服务器改动，本批刻意没做）。

10. ★ **分享卡（`og:image`）的 PNG 是提交资源、不是构建产物**（批次 F-3，v0.2.116）：发版 tar 与 CI 里都没有浏览器，所以 14 张 1200×630 卡**签进 `packages/web/public/og/`**。⇒ **代价是「语料改了、图不会自己跟着变」**：文案漂移由锁拦（卡片字段逐字取自 `term-corpus`，页与卡不同源即刻红），**图内容的陈旧拦不住**——唯一的守法是改完语料重跑 `npm run og:shots`（它会逐张量排版越界并报最低内容底边，红在退出码里）。另三条如实记账：① PNG 由**本机 Edge 153.0.4234.32** 无头截出，别的操作系统字体度量不同 ⇒ 仓内的锁读的是 **PNG 的 IHDR 字节**（尺寸与存在性），不锁像素；② `robots.txt` 加了 `Allow: /og/`——**社交平台抓图不看 robots，Google 图片抓它看**，本站 robots 是默认全封口径，不放行就是自己挡自己的图；③ **英文侧尚无公开页 ⇒ 无英文卡**（与 §5 第 3 条同一条代价）。

11. ★★ **SPA 里的入口，对不执行 JS 的抓取器等于不存在**（2026-09-23 23:1x 线上取证立，批次 G-1 v0.2.117 补，**未发版**）：本仓的首页是 Vite 壳——线上实测 **1487 字节、`#root` 空、整页零个静态 `<a>`**，站内所有链接都要 React 挂载之后才出现在 DOM 里。⇒ **后果**：Googlebot 当天四轮抓 `/` 与 `/robots.txt`（robots 里 `Sitemap:` 那行早就在）**却零抓 `/sitemap.xml` 与词条页**——声明齐、内容页也在，**缺一整条走得通的路**；批次 E 交付的「两处入口」（页脚＋空态）因此对首波抓取**一句都不成立**。✅ **补法（本批）**：在手写的那份 `packages/web/index.html` 里放一条**静态** `<a href="/terms/index.html">`（目录页自己链向十二条 ⇒ 爬虫一跳拿到整簇）＋ 一个 `<link rel="sitemap" type="application/xml" href="/sitemap.xml">`，容器带 **`hidden`**（★ 目标是**发现 URL**，不是给访客多看一行字；不用「挂载后用 JS 隐藏」是因为 CSP 现为 Report-Only，将来转强制会杀掉那段内联脚本，而 `hidden` 不需要 JS 参与）。★ **两条锁**：`term-page.test.ts` ⑭ 锁「地址与 `CATALOG_PATH` 同形＋sitemap 声明在」，⑮ 锁「它必须待在带 `hidden` 的容器里」——后者锁的是**不可见**这件事本身，因为「顺手把 `hidden` 删了」等于一次没登记的视觉改动。⚠️ **本条不承诺效果**：`hidden` 里的链接 Google 会不会跟、多久跟属未知（各家实现对隐藏元素里的链接处理不同，本站更是一条数据都没有），唯一确定的判据在站长平台后台（＝渠道台账 C9，已点名为老板动作）。★ **从此的通用口径**：**凡「给爬虫看的东西」都要问一句「不执行 JS 的那一份字节里有没有它」**，判据一律写成 `curl` ＋ `grep`（见 §6 第 9 条），不许拿「页面上有入口」当证据。
    - ★ **顺带两条附注**：① `index.html` **随站发布**，所以那段入口注释里只留「看 §5 第 11 条」这一句指针，**不把施工理由写进公开字节**（同一族红线＝渠道台账 C8：公开页不许带内部挂账；★ 这一条是收口时自查改的，改前那版把取证过程与 CSP 判断全写进了要发布的那份 HTML）；② ⇒ **本批上线后首页壳从 1487 B 变成约 2.5 KB**，所以本文 §5 第 1、9 条拿「1487 字节」当「这是壳」判据的地方，此后一律读成「**与真页差一个 KB 级 ＋ 有没有该页正文**」，**不是精确值**（★ 这条本来就是易碎判据，本批正好把它换成 §6 第 9 条那种 grep 判据）。

## 6. 上线与验收判据（发版后逐条 curl）

1. `curl -s https://11wand.com/robots.txt` ⇒ 含 `Allow: /terms/` 与 `Sitemap:` 行。
2. `curl -sI https://11wand.com/terms/tiqu-lixian.html` ⇒ `200 text/html`；★ **并且必须同时核字节数 ≥5000**（见 §5 第 9 条：壳也返 200，只看状态码等于没验）。
3. `curl -s .../terms/tiqu-lixian.html | grep -c '<script'` ⇒ **0**；`grep -o '<title>[^<]*'` ⇒ 该页自己的标题。
4. ★ 目录页（09-23 已实测一轮，见 §5 第 1 条）：`curl -s https://11wand.com/terms/index.html | grep -c '学习科学词条'` ⇒ 非零；同批再跑一次 `curl -s https://11wand.com/terms/ | grep -c '<script'` ⇒ **仍然非零**（它是 SPA 壳，这一条是**反向判据**：壳还在就说明线上没换过逻辑，正常）。页内导航与页脚两条链接、`sitemap` 第三条 `<loc>` 都必须是 `/terms/index.html`。
5. `curl -s https://11wand.com/sitemap.xml` ⇒ 14 个 `<loc>`、xmlns 为 `sitemaps.org`。
6. 三条红线：页面上找不到任何「N 人」「好评」「包过」字样。
7. 效果观测（★ **别用 GoatCounter，理由见 §5 第 6 条**）：上线满 1～2 天后 `ssh` 到服务器跑一次
   `grep -hE '"uri":"/terms[^"]*html' /var/log/caddy/access.log* | grep -vE 'studentbuddy-probe|"user_agent":"curl/' | wc -l`
   ⇒ **只看它有没有出现过非零**（★ 前半段剔自己：C10 打标的脚本走 `studentbuddy-probe`，发版验收时的 `curl` 走 `curl/`，两条都是我们干的，不剔就是自增流量）。同一份日志按 UA 分一下就能看见是谁来的（`Googlebot`／`bingbot`／真人）。★ 判据是「有没有人来」，不是「来了几个」——**在 §5 第 7 条那条百度提交做完之前，不许拿这个词对外说「有流量」**。

8. ★ **分享卡（批次 F-3 之后才有这条，发版后跑）**：
   - `curl -sI https://11wand.com/og/tiqu-lixian.png` ⇒ `200` ＋ **`content-type: image/png`** ＋ `content-length` 与仓内该文件字节数一致（实测本机 **62.1 KB**）。★★ **只看状态码等于没验**——§5 第 9 条已取证「本站任何错地址都返 200 ＋ 1487 字节 SPA 壳」，图若被同一条 `try_files` 兜住，平台抓到的是 HTML、渲染出来就是没有卡，而**没有任何一端会报错**。
   - `curl -s https://11wand.com/terms/tiqu-lixian.html | grep -o 'og:image" content="[^"]*'` ⇒ 该页**指向自己那张**（14 页逐一核对，串页＝给 A 页配 B 页的图）；`grep -c 'twitter:card" content="summary_large_image'` ⇒ **1**（还是 `summary` 就是没发新版）。
   - `curl -s https://11wand.com/robots.txt | grep -c 'Allow: /og/'` ⇒ 1。
   - ⚠️ **卡片在真实对话框里清不清楚／淡不淡，curl 判不了** ⇒ 见 `manual-test.md` **MT-20**（判定权在老板）

9. ★ **静态可抓入口（批次 G-1 之后才有这条；★ 发版前后各跑一次才有意义，因为它量的就是「换没换壳」）**：
   - `curl -s https://11wand.com/ | grep -c 'href="/terms/index.html"'` ⇒ **发版前 0、发版后 1**（不需要浏览器，量的正是 §5 第 11 条那句话）；
   - `curl -s https://11wand.com/ | grep -c 'rel="sitemap"'` ⇒ 发版前 0、发版后 1；
   - ★★ **反向判据（防的是「入口漏成可见」）**：`curl -s https://11wand.com/ | grep -c '<nav hidden>'` ⇒ 1——那条链接**必须**待在带 `hidden` 的容器里；若它变成屏上一行字，就是有人改掉了 `hidden`，属一次没登记的视觉改动（`term-page.test.ts` ⑮ 已在仓内拦，这条是线上侧的对账）。。

## 6.1 最近一轮验收实录（09-23 09:54 批次 E 发版后，全绿）

发版链条本身：`npm run check`（四连）→ `gates` 绿 → build 打出 **14 个静态页** → 包 4.4 MB／775 条目 → 两端 sha256 一致 → `.env` 与线上一致 → 预演（库副本＋18799）`{"ok":true}`、迁移水位 40 → 切换后服务 `active`、health ok → 取证 3 文件 sha256 全等。

| 判据 | 结果 |
|------|------|
| 1 robots | ✅ `Allow: /terms/` ＋ `Sitemap:` 都在 |
| 2 词条页 200 ＋字节 | ✅ `tiqu-lixian.html` 200／`text/html; charset=utf-8`／**6173 B**（壳是 1487 B，两者可分） |
| 3 零脚本＋自己的 title | ✅ **12 页每页 `<script>` 数＝0、外部 `src`＝0**；title 12 个全不重复（例：「提取练习是什么、怎么做 - StudentBuddy」） |
| 4 目录页 | ✅ `/terms/index.html` 200／5745 B，正文含「学习科学词条」3 处；★ **发版要修的那件事已修**：线上词条页内的目录链接从 2× `/terms/`（空壳）变成 2× `/terms/index.html` |
| 5 sitemap | ✅ **14 个 `<loc>`**、xmlns `sitemaps.org`，第三条为 `/terms/index.html`，`/terms/` 那条已消失 |
| 6 三条红线 | ✅ 12 页全文扫「已有 N 人／好评／五星／满意度／包过／保过／提分」⇒ **0 命中** |
| 7 效果观测 | ⚠️ **暂时还是零访客**：`/terms` 命中 **37 条全是 `curl/8.18.0`**（就是我这一轮验收自己打的）。上线满 1～2 天后重跑 §6 第 7 条那条 grep，**先剔 `curl/` 再看非零** |

## 7. 维护

- 加一条词条＝在 `term-entries-a/b.ts` 追加一项（**任一文件超 400 行就再开一个 `term-entries-c.ts`**，gates 会拦），`sitemap`／目录页／互链全自动跟上。
- `related` 只写 slug，**写错会立刻红**（`term-corpus.test.ts` 的死链锁）。
- 页面文案改动无需重新部署以外的动作：改语料 → `npm run build` → 发版。
