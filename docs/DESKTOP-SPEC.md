# Windows 本地安装包

首版桌面版本：0.1.0；Windows 10/11 x64。

## 使用契约

- 安装程序按当前用户安装，不需要管理员权限，提供开始菜单入口、可选桌面快捷方式与标准卸载入口。
- 内置与构建依赖相同的 Node x64 运行时；用户无需 Node、npm 或源码。
- 启动器隐藏运行本地服务并打开默认浏览器；托盘菜单可再次打开或退出。重复启动共用一个服务。
- 服务仅监听回环地址；强制本地免登录形态，网页与 API 同源。
- 数据沿用服务端已有的数据目录解析规则，升级与卸载保留数据。
- 启动失败明确显示错误和日志位置。升级、卸载先停止本安装的服务，不能结束其他 Node 进程。
- 这是本地版，首次使用在设置中配置自己的 AI 服务商；联网功能仍需网络。

## 构建与发版契约

- `npm run desktop:build -- -Version 0.1.0` 在 Windows x64 构建安装程序与 SHA-256 文件。
- 构建先生成网页与服务端产物，然后在独立打包目录从锁文件安装服务端生产依赖。
- 安装程序包含运行时许可证与依赖许可证。Inno Setup 编译器按固定版本、固定 SHA-256 下载到构建目录，不做系统安装。
- `npm run desktop:smoke` 使用隔离数据目录验证安装、网页/API、重复启动、停止、升级、卸载和数据保留。
- 桌面版 tag 使用 `desktop-v<版本>`，挂在实际构建的提交上；GitHub Release 提供安装程序和校验文件。`v0.2.x` 与线上更新表继续记录网站版本。
- `tools/desktop/windows-installer.yml` 提供可选的自动构建发版模板；移至 `.github/workflows/` 即可启用，提交工作流需要 GitHub 凭据具备 `workflow` 权限。发版前必须通过仓库质量检查和安装包冒烟验证。

## 服务端静态文件契约

`SB_WEB_DIST` 可选：未配置时保持现有 API 服务；配置后从该绝对目录提供静态网页，非 API 的无扩展名 GET/HEAD 路径回退到 `index.html`。未知 API 与丢失的静态资源仍返回 404。

## GitHub Packages 分发契约

- GitHub npm registry 的 `@llwand1/studentbuddy-windows` 包分发已验证的 Windows x64 安装程序，版本与 `desktop-v<版本>` Release 一致。
- 包包含安装程序、SHA256SUMS、许可证、使用说明和显式安装命令；安装 npm 包不会自动启动安装程序。
- 打包前校验 Release 的 SHA-256，安装命令再次校验；文件名与版本严格匹配，校验失败拒绝打包或执行。
- `repository` 元数据关联本仓库；首次发布后核实包关联和公开可见性，使仓库 Packages 显示此包。
- `.github/workflows/desktop-package.yml` 手动选择已有桌面 Release，用 Actions 的 `GITHUB_TOKEN` 和 `packages: write` 发布；PR 仅运行工具测试。
- 复验：`node --test tools/desktop/npm-package.test.mjs`，并用 `npm pack` 检查分发文件和安装程序摘要。
