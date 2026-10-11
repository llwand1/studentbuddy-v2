# Windows 本地安装包

首版桌面版本：0.1.0；Windows 10/11 x64。

桌面版 **0.2.0** 起，启动后打开的是**内嵌应用窗口**（WebView2），不再默认调用系统浏览器；差异见「应用窗口」一节。

## 使用契约

- 安装程序按当前用户安装，不需要管理员权限，提供开始菜单入口、**默认创建桌面快捷方式**（安装时可取消）与标准卸载入口。应用图标（安装包 / exe / 快捷方式 / 托盘 / 任务栏）统一用**吉祥物**：由 `tools/desktop/make-icon.mjs` 在构建期从点阵现生成，不存手画位图。
- 内置与构建依赖相同的 Node x64 运行时；用户无需 Node、npm 或源码。
- 启动器隐藏运行本地服务并打开**内嵌应用窗口**；关闭窗口只收进托盘，托盘菜单可再次打开或退出。重复启动共用一个服务，第二次启动把已有窗口带到前台。
- 服务仅监听回环地址；强制本地免登录形态，网页与 API 同源。
- 数据沿用服务端已有的数据目录解析规则，升级与卸载保留数据。
- 启动失败明确显示错误和日志位置；窗口加载失败时写明原因并降级用浏览器打开。升级、卸载先停止本安装的服务，不能结束其他 Node 进程。
- 这是本地版，首次使用在设置中配置自己的 AI 服务商；联网功能仍需网络。

## 应用窗口（桌面版 0.2.0 起）

- 主窗口由启动器自建：WinForms 窗体承载 WebView2（x64），加载本地服务 `http://127.0.0.1:<端口>`（默认 `18794`），窗口标题 `StudentBuddy`。常规路径**不再调用系统浏览器**。
- 关闭窗口只隐藏到托盘，服务不退出；托盘双击或菜单「打开 StudentBuddy」重新显示窗口并带到前台。
- 重复启动：第二实例不新建窗口、不新建服务，只把已有窗口带到前台后退出（退出码 0）。
- **端口择优**：默认用 `18794`；若该端口被其他程序占用、或被系统「端口排除段」拦下（`netsh int ipv4 show excludedportrange protocol=tcp`），启动器自动改用回环空闲端口，并把实际端口写入 `%LOCALAPPDATA%\StudentBuddy\port`（退出时删除）。**绝不替换或结束占用端口的其他进程。**
- `--no-browser` 语义为「不打开窗口」（自动化与冒烟使用）：服务照常启动并驻留托盘。`--stop` 语义不变。
- 依赖 **WebView2 Runtime**（Windows 11、以及装过 Edge 的 Windows 10 自带）。初始化失败时**不静默**：日志写明原因，并降级用系统浏览器打开应用；服务与数据不受影响。
- WebView2 用户数据目录固定在 `%LOCALAPPDATA%\StudentBuddy\webview2`；与学习数据目录分开，不混放。

## 桌面悬浮球（桌面版 0.2.0 起）

- 启动时除主窗口外，桌面上还有一只**吉祥物**（就是侧栏那只「见习法师团子」：同一份 16×16 点阵、同一套品牌色）。它不是一块窗口底板 —— 宿主用**窗口 Region** 按吉祥物外形把球窗裁出来，轮廓外的点击穿透到桌面；页面整页透明、只画吉祥物本身。眨眼动画保留；**跳动动画在球态关掉**（那会让吉祥物移出裁剪轮廓被切掉）。
- **点一下 ＝ 展开成手机小屏**。展开是**同一个窗口**放大到手机尺寸（逻辑 420×760）并切到应用内容：直接跑现有 App（`<App/>`），由它自己按 700px 断点走移动端布局 —— 问问题、等待时刷词、出题卡片、词条/复习页全都在。**不新做第二套前端**：小屏与主窗口必须是同一个 App（否则以后每改一处都要跟一次）。
- **拖一把 ＝ 挪位置**。落点写入 `%LOCALAPPDATA%\StudentBuddy\float-pos`（`x,y`），下次原地出现；判为离屏（换显示器 / 改分辨率）时回落主屏右下角。该文件是**用户偏好**，退出**不删**（与退出即删的 `port` 文件相反）。
- **点击与拖动的区分在宿主做**：网页一按下就请宿主进入系统原生移动循环；宿主跑完比对窗口位置，**没挪窝**才回一条 `sb-float:tap` 让网页展开。★ 为什么不放在网页：实机实测 **WebView2 在按住不放时不派发 pointermove**，网页侧根本看不到位移。
- 展开态顶部有一条 26px 薄条（可拖 + 右侧「—」收起）。★ **已知边界**：展开态里点应用的「对战」会离开 `#/float`，薄条随之消失 —— 此时用托盘菜单「悬浮球回到吉祥物」把它拉回来（重置回球态并收回尺寸）。
- 托盘菜单：「显示/隐藏悬浮球」收起或唤回；「悬浮球回到吉祥物」重置回吉祥物页。隐藏态随进程结束而复原（下次启动默认显示）。
- `--no-browser`（自动化与冒烟）**不创建球窗**。球窗初始化失败只记日志并收起它，**不牵连主窗口**。
- **几何是跨语言契约**：吉祥物画在 96 逻辑 px 窗口里、整块 80px 居中（每格 5px、起点 8px）。网页侧在 `features/float/float.css`，宿主侧在 `Launcher.cs` 的 `BallCellLogical`/`BallOriginLogical` —— 改一边必须同改另一边，否则轮廓与画面错位。轮廓数据 `mascot-region.txt` 由点阵生成、随包分发；读不到时退回椭圆兜底（球仍可点、可拖）。
- 消息常量同样是跨语言契约：网页侧 `features/float/float-view.ts` 的 `sb-float:drag`/`expand`/`collapse`/`tap` 必须与 `Launcher.cs` 逐字一致（网页侧由 `float-view.test.ts` 锁字面量）。
- 窗口与内容尺寸按当前 DPI 换算（与主窗口同一口径），200% 缩放下不出现位图拉伸。

## 构建与发版契约

- `npm run desktop:build -- -Version 0.1.0` 在 Windows x64 构建安装程序与 SHA-256 文件。
- 构建先生成网页与服务端产物，然后在独立打包目录从锁文件安装服务端生产依赖。
- 每次构建先跑 `node tools/desktop/make-icon.mjs`：由吉祥物点阵现生成 `app.ico`（六档 16/32/48/64/128/256）与 `mascot-region.txt`（球窗轮廓），两者随安装包分发；`app.ico` 同时经 `/win32icon` 打进 exe。换装或改品牌色后图标与轮廓自动跟上，不需要手改位图。
- 构建期从 NuGet 取得**固定版本 + 固定 SHA-256** 的 WebView2 SDK（`Microsoft.Web.WebView2`），解压到 `.runtime` 后引用其 `net462` 程序集与 `win-x64` 原生 `WebView2Loader.dll`，随安装包一起分发；不做系统安装。
- 安装程序包含运行时许可证与依赖许可证。Inno Setup 编译器按固定版本、固定 SHA-256 下载到构建目录，不做系统安装。
- `npm run desktop:smoke` 使用隔离数据目录验证安装、网页/API、重复启动、停止、升级、卸载和数据保留；实际端口从 `%LOCALAPPDATA%\StudentBuddy\port` 读取，不再假定 `18794`。
- 桌面版 tag 使用 `desktop-v<版本>`，挂在实际构建的提交上；GitHub Release 提供安装程序和校验文件。`v0.2.x` 与线上更新表继续记录网站版本。
- `tools/desktop/windows-installer.yml` 提供可选的自动构建发版模板；移至 `.github/workflows/` 即可启用，提交工作流需要 GitHub 凭据具备 `workflow` 权限。发版前必须通过仓库质量检查和安装包冒烟验证。

## 服务端静态文件契约

`SB_WEB_DIST` 可选：未配置时保持现有 API 服务；配置后从该绝对目录提供静态网页，非 API 的无扩展名 GET/HEAD 路径回退到 `index.html`。未知 API 与丢失的静态资源仍返回 404。

## GitHub Packages 分发契约

0.1.0 已发布并公开可见：[studentbuddy-windows](https://github.com/users/llwand1/packages/npm/package/studentbuddy-windows)。选择已有桌面 Release 发布：`gh workflow run desktop-package.yml -f version=0.1.0`；同一包版本只能发布一次。

- GitHub npm registry 的 `@llwand1/studentbuddy-windows` 包分发已验证的 Windows x64 安装程序，版本与 `desktop-v<版本>` Release 一致。
- 包包含安装程序、SHA256SUMS、许可证、使用说明和显式安装命令；安装 npm 包不会自动启动安装程序。
- 打包前校验 Release 的 SHA-256，安装命令再次校验；文件名与版本严格匹配，校验失败拒绝打包或执行。
- `repository` 元数据关联本仓库；首次发布后核实包关联和公开可见性，使仓库 Packages 显示此包。
- `.github/workflows/desktop-package.yml` 手动选择已有桌面 Release，用 Actions 的 `GITHUB_TOKEN` 和 `packages: write` 发布；PR 仅运行工具测试。
- 复验：`node --test tools/desktop/npm-package.test.mjs`，并用 `npm pack` 检查分发文件和安装程序摘要。
