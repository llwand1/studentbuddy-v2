# UNTRUSTED-RENDER-SPEC — 模型产出渲染契约（前端零依赖的安全代价怎么付）

> 版本：v1.0 | 状态：[已落地] | 日期：2026-09-30
> 关联：`packages/web/src/lib/svg-sanitize.ts`（净化器）｜`svg-allowlist.ts`（白名单数据）｜`markdown-inline.ts`（链接 / 图片白名单）｜`docs/TEST-PLAN.md` §3（攻击语料 + 模糊测试登记）

## 0. 立场

`@sb/web` 不引 Markdown / 图表 / 净化库是一个刻意选择（README「前端零依赖是选择，不是省事」）。
这个选择的代价必须**明码标价**：自绘渲染器渲染的是**模型产出的不可信内容**，安全责任不能靠"我们剥了 script"
这一句话背书。本契约把攻击面、防线与证明方式写死，任何改动渲染层的人先读这一页。

替代方案 `react-markdown + rehype-sanitize + DOMPurify` 不是不能选——它们是**黑名单 + 白名单混合、经过十年真实攻击打磨**的库。
本仓不选它们的理由只有一个：把攻击面收窄到三个围栏、由自己的白名单与模糊测试守，比引入 ~200KB 依赖 + 跟 CVE 更可控。
**这个理由成立的前提是 §3 的测试必须一直在、一直绿**；哪天它们被删了，就应该换库。

## 1. 攻击面盘点（sink 在哪）

| sink | 内容来源 | 落点 | 防线 |
|---|---|---|---|
| Markdown 正文 | 模型 token 流 | React 元素树（**不走 innerHTML**） | AST → React；唯一两个「属性直出」点：`<a href>`（`safeHref`）与 `<img src>`（`safeImgSrc`） |
| ```svg 围栏 / 题图 / 图表 | 模型输出 → `fixSvg` 自愈 | `dangerouslySetInnerHTML`（`SvgPreviewCard` / `ChartCard` / `CoachCardViews`）+ blob: 独立文档（下载 / 新窗口） | **白名单净化器**（§2） |
| ```html 围栏 | 模型输出 | `<iframe sandbox>` + `CSP: sandbox`，源为 `null` | 隔离而非净化（沙箱页不能调写接口：`originCheck` 不放行 `'null'`） |

`safeHref` 只放行 `http(s):` / `mailto:` / `#…` / **站内根路径 `/…`**；根路径**必须排除 `//` 与 `/\`**（协议相对 URL 与 Chromium 的反斜杠等价形，长得像站内、点开就出站——2026-09-30 修）。

## 2. SVG 白名单净化器（四条硬规则）

净化器解析用 **HTML 解析器**（与 innerHTML 注入点同一套，消灭「净化时按 XML 解析、注入时按 HTML 解析」的差异），
遍历后用 **XMLSerializer** 输出良构 XML（innerHTML 与 blob: 两条路读到同一棵树）。

| 规则 | 内容 | 典型被挡招式 |
|---|---|---|
| R1 元素白名单 | 不在 `ALLOWED_ELEMENTS` 的元素**整棵子树丢弃**；非 SVG 命名空间一律丢 | `script` / `foreignObject` / `image` / `feImage` / `iframe` / `<desc><img onerror>`（HTML 集成点） |
| R2 属性白名单 + 值检查 | 不在 `ALLOWED_ATTRS` 的丢；`on*` 丢；值含 `javascript:` `data:` `vbscript:` `expression(` 或**非 `#` 片段的 `url(…)`** 丢；`xmlns*` 一律丢（序列化器按真实命名空间重生成）；XML 非法控制字符剥掉 | `fill="url(https://…)"` 外呼、实体 / 制表符切开的协议、`xmlns:xlink=""` 让 XML 路解析失败 |
| R3 链接策略 | `href` / `xlink:href` 归一成裸 `href`；`<a>` 放行 `http(s)` / `mailto` / `#`，其余元素只放行 `#片段` | `<use href="data:…">`、`<a href="data:text/html,…">`；SMIL 不许以 `href` / `style` / `class` / `on*` 为目标 |
| R4 样式 | `style` 属性与 `<style>` 同一套 CSS 过滤：禁 `@` 规则、外链 `url()`、`expression`、反斜杠转义、`<`；`<style>` 每条规则包成 `:where(svg[data-sb-scope="…"], svg[data-sb-scope="…"] *):is(原选择器)` | `@import`、`body{display:none}` 全页泄漏、`u\72l(` 转义绕过 |

无 DOM（纯 node）时净化器返回空串（卡片走「无法解析」降级）——旧版在这里退回一条**从未在浏览器里跑过**的弱正则路径，
只在测试里被执行，制造了「没有 DOM 也安全」的错觉；现已删除。

**残余风险（如实记录）**：① 净化器信任浏览器 HTML 解析器与 XMLSerializer 的规范行为，mXSS 类问题若源于浏览器 bug 无法在此层挡住
（缓解：输出良构 XML、文本一律实体化、`<style>` 内容禁 `<`）；② `<a>` 外链是允许的（模型可以贴钓鱼链接——这是内容问题不是执行问题，
与 Markdown 链接同一口径：`target=_blank rel="noopener noreferrer"`）；③ SMIL 动画仍开放（几何 / 呈现属性），若浏览器出现新的 SMIL 执行面，
收紧 `ANIMATABLE_ATTRS` 即可。

## 3. 证明方式（不是"我们觉得安全"）

| 测试 | 锁什么 |
|---|---|
| `web/src/lib/svg-sanitize.test.ts` | **攻击语料**（每条一类招式，见 R1–R4 表）+ **正常画图能力不误伤**（```chart 自绘输出逐属性存活、渐变 / 标记 / 裁剪 / textPath / 主题变量）+ 幂等 + 良构 XML |
| `web/src/lib/svg-sanitize.fuzz.test.ts` | **确定性种子模糊测试**（mulberry32，seed 20260930，默认 300 轮；`SB_FUZZ_ITERS=5000` 本地加深）。语料生成器专挑坏的；**判定器**对每份输出跑五条不变量：不抛 / 注入点复读全在白名单 / **XML 与 HTML 两套解析器元素序列一致** / 幂等 / 线性耗时。判定器自身有「已知坏图必判红」的自检，防空转 |
| `web/src/lib/svg-utils.test.ts` | `fixSvg` 自愈产物能完整通过白名单（自愈与净化的接缝） |
| `web/src/lib/markdown.test.ts` | `safeHref` 的 `//` / `/\` / 各协议正反例 |

模糊测试在落地当天就抓到四类真实缺陷：命名空间声明属性让 XML 路解析失败、未声明前缀被序列化成 `ns1:href`（再解析即丢）、
XML 非法控制字符穿过 HTML 解析器、`aria-&label` 这种 HTML 解析器接受但 XML 不合法的属性名——四处都已修。**这就是为什么它必须留在 CI 里。**

## 4. 改动纪律

- 给白名单**加**元素 / 属性：先在 §2 表里说清它会不会发请求 / 执行代码 / 泄样式，再加，并给一条语料。
- 改 `safeHref` / `safeImgSrc`：正反例同时补，`//` 与 `/\` 两条反例不许删。
- 删 §3 任一测试 = 触发「该换库了」的讨论，不许静默删。
