# GITHUB-OPS-SPEC — GitHub 对外面维护规范

> 版本：v0.1.1 | 状态：[活跃] | 更新：2026-09-25（★ R-3 由三件套扩成**四件套**：对外更新表补行从「靠人记」变成发版脚本第 ①c 步的硬检查）
>
> 本册管的是**仓库在 GitHub 上露出来的一切表面**：issue、PR、tag、Release、模板。判断标准只有一条——每一条对外文字都可能被未来的读者（招聘方、用户、爬虫背后的人）逐字读，所以**写进去的每一句都要能站在公开面被解释**。
>
> ✅ **登记欠账已结（09-24 当日补记于 `01de781`）**：本册与 `.github/` 模板改动的 CHANGELOG 行（13:5x）与 docs/ENGINEERING.md 目录速查指针均已落。留这段原文不删，是因为它本身演示了本册 R-1 的写法——**欠账要挂在有位置的地方，不是忘掉**。

## 1. 为什么立这本册

2026-09-24 之前，本仓的对外面只有「main 分支＋两个早期 tag」：几十版的版本演进对外不可见，真实存在的工程欠账只登记在仓内记录里，外面没人知道、也没人能看到「一个问题是怎么被跟踪和关闭的」。第一个正式 Release（v0.2.118）上线后确认了形状：**对外表面要从「碰巧存在」变成「每次实现都顺带维护」的固定动作**，故立规。

## 2. 五条硬规则

### R-1 真实工作项先立 issue

- 每一条已登记的缺口／欠账／待决策事项，要开工前先有对应 issue；内容用**真实事实**，不造话题、不灌水。
- 结构固定四段：**现状 → 影响 → 建议 → 验证标准**。写不出「影响」和「验证标准」的不开。
- 标签只用现有词表：`bug` / `enhancement` / `documentation`。

### R-2 实现走「issue → 分支 → PR」

- 代码改动一律开分支提 PR，PR 描述里 `Closes #N` 关联 issue；**纯文档改动可直接进 main**（沿袭仓内既有惯例，不装样子）。
- PR 合并的判断标准 = 四连全绿（`check`／`build`／`gates`／`metrics --check`）＋ §3 口径过一遍。

### R-3 发版 = 四件套同步（外加第 0 步：改号）

**桌面安装包发版**使用独立的 `desktop-v<版本>` tag，挂在实际构建提交上，Release 提供安装程序和 SHA-256 文件，同步 CHANGELOG。线上更新表只记录网站已生效的版本，桌面发版不修改该表、不触发网站部署；构建和验证要求见 `DESKTOP-SPEC.md`。

0. **改号**：`npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`，根与三个 workspace 的 `package.json`（含 lock）一次改齐，与 CHANGELOG 记录行**同一提交**。★ 2026-09-30 起全仓只有一个版本号（此前 `package.json` 挂着内部产品号 `2.0.0-alpha.0`、tag 走 `v0.2.x`，`/api/status` 报的号与更新页对不上）：`package.json` ＝ tag ＝ Release ＝ CHANGELOG ＝ `PUBLIC_RELEASES[0]` ＝ README 徽章 ＝ `/api/status`，机器核对＝`node tools/check-version.mjs`（`npm run gates` 与 `tools/deploy.sh` 第 ①d 步）；
1. **附注 tag**：挂在**线上实际构建的那个提交**上（不是之后的记录提交——09-24 第一次做时就专门核对过这条）；
2. **GitHub Release**：`gh release create`，Notes 用对外口径；
3. **CHANGELOG 记录行**：照常记。
4. **对外更新表补行**（`packages/web/src/seo/changelog-public.ts` 的 `PUBLIC_RELEASES`）：那一页只写**已经生效**的改动，所以补行的时点＝发版之后、下一次发版之前；

   第 4 件是 2026-09-25 补上的，因为前三件都有人记、第四件**只有口头约定**。判断标准：「已合并进当前历史的最高 tag」必须逐字等于 `PUBLIC_RELEASES` 表头——两个方向都会红（表落后＝线上更新页正在落后于线上本身；表领先＝对外页写着没生效的改动）。机器核对＝`node tools/check-public-changelog.mjs`，由 `tools/deploy.sh` 第 ①c 步自动跑，跳过只认显式的 `SKIP_PUBLIC_CHANGELOG_CHECK=1`（且要在记录写明为什么）。

### R-4 对外文字口径：公开运维词，零内部字样

- issue／PR／Release／模板里**禁用**：改动编号（G-3、H-1）、渠道代号、内部记录称呼（MT-xx、D11 之类）、口令、端口、运维路径、未收口的内部待办。
- 允许：真实存在的文件名、命令、URL、curl 判断标准——这类是任何开源仓库都会公开的正常工作语言。
- 底线与 `public-hygiene` 词表同源：**发布出去的字节里写了什么，是要被逐字读的**。

### R-5 版本号历史：真空保留，不回填

- tag 从 v0.2.118 起恢复逐版打；v0.2.71～v0.2.117 的缺口**刻意保留**，真相以仓内 CHANGELOG 与 11wand.com 更新日志页为准——第一个 Release 的页脚已经这么写了，后面不许悄悄改口。

## 3. 现状快照（2026-09-24，此节易碎，以 GitHub 实时读数为准）

- 首个正式 Release：v0.2.118（tag 挂在实际构建提交，Notes 四条线上判断标准全中）。
- issue 若干条在开，内容全部来自仓内已登记缺口的公开改写。
- `.github/` 有 issue 与 PR 模板各一套，形状与本册 R-1/R-2 对齐。
