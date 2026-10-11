StudentBuddy Windows 本地版

从开始菜单启动 StudentBuddy，会打开应用窗口。
第一次使用请在设置里配置自己的 AI 服务商与模型。
关闭窗口后，服务仍在托盘运行；右键托盘图标可打开应用或退出。

启动时桌面上还会出现一只吉祥物（悬浮球）。点一下它会展开成手机大小的窗口，可以直接问问题、刷词刷题；按住拖动可以换位置（位置会记住）。托盘菜单可显示/隐藏它，或用「悬浮球回到吉祥物」把它收回原样。

支持 Windows 10/11 x64，无需另装 Node 或 npm。应用窗口依赖系统自带的 WebView2 运行时（Windows 11、以及装过 Edge 的 Windows 10 自带）；若运行时缺失，会改用默认浏览器打开并在日志说明原因。
学习数据使用既有 studentbuddy-v2 数据目录，升级和卸载不会删除学习数据。
启动日志：%LOCALAPPDATA%\StudentBuddy\desktop.log

项目与源码：https://github.com/llwand1/studentbuddy-v2
内置运行时和各依赖的许可证位于 runtime/LICENSE 与 node_modules 中。
