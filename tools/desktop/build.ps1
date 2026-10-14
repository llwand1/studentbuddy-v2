param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '0.1.0',
    [string]$OutputDir = '',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
function FileHash([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $repoRoot
if ((node -p "process.platform + '/' + process.arch") -ne 'win32/x64') { throw 'Build on Windows x64.' }
if (!$OutputDir) { $OutputDir = Join-Path $repoRoot '.runtime\desktop-output' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
if (!$SkipBuild) {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
}
# A fresh stage prevents stale dependencies; existing builds are preserved.
$stage = Join-Path $repoRoot ('.runtime\desktop-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath package.json,package-lock.json,LICENSE -Destination $stage
foreach ($workspace in @('server', 'web', 'shared')) {
    $target = Join-Path $stage "packages\$workspace"
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -LiteralPath "packages\$workspace\package.json" -Destination $target
}
Push-Location -LiteralPath $stage
try {
    npm ci --omit=dev --workspace=@sb/server --include-workspace-root=false
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
} finally { Pop-Location }
Copy-Item -LiteralPath packages\server\dist -Destination (Join-Path $stage 'packages\server') -Recurse
Copy-Item -LiteralPath packages\web\dist -Destination (Join-Path $stage 'web') -Recurse
New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') | Out-Null
$nodeBinary = (Get-Command node.exe).Source
Copy-Item -LiteralPath $nodeBinary -Destination (Join-Path $stage 'runtime\node.exe')
$nodeLicense = Join-Path (Split-Path $nodeBinary) 'LICENSE'
if (Test-Path -LiteralPath $nodeLicense) {
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $stage 'runtime\LICENSE')
} else {
    $nodeVersion = node -p 'process.version'
    Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/LICENSE" -OutFile (Join-Path $stage 'runtime\LICENSE')
}
Copy-Item -LiteralPath tools\desktop\README.txt -Destination $stage
Copy-Item -LiteralPath tools\browser-extension -Destination (Join-Path $stage 'browser-extension') -Recurse
Copy-Item -LiteralPath tools\desktop\update-client.cjs,tools\desktop\update-core.cjs,tools\desktop\update-public-key.pem -Destination $stage
# Official GitHub OAuth stdio integration, immutable version + release digest.
$githubDir = Join-Path $repoRoot '.runtime\github-mcp-2.0.2'
New-Item -ItemType Directory -Force -Path $githubDir | Out-Null
$githubZip = Join-Path $githubDir 'release.zip'
if (!(Test-Path -LiteralPath $githubZip)) { Invoke-WebRequest 'https://github.com/github/github-mcp-server/releases/download/v2.0.2/github-mcp-server_Windows_x86_64.zip' -OutFile $githubZip }
if ((FileHash $githubZip) -ne '4ae64087501650752f21c9d5af5378107a5116d94ee1cf37786b22b8c4bd99df') { throw 'GitHub official release SHA-256 mismatch.' }
Expand-Archive -LiteralPath $githubZip -DestinationPath $githubDir -Force
if ((FileHash (Join-Path $githubDir 'github-mcp-server.exe')) -ne '1bbf1cd5be216d5c622ccb0da4529d747c983fcf6bbf76f9c3e6c3b32877c1df') { throw 'GitHub binary SHA-256 mismatch.' }
$githubTarget = Join-Path $stage 'integrations\github'
New-Item -ItemType Directory -Force -Path $githubTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $githubDir 'github-mcp-server.exe'), (Join-Path $githubDir 'LICENSE') -Destination $githubTarget
@{version='2.0.2';binarySha256='1bbf1cd5be216d5c622ccb0da4529d747c983fcf6bbf76f9c3e6c3b32877c1df';source='https://github.com/github/github-mcp-server/releases/tag/v2.0.2'} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $githubTarget 'release.json')
# 应用图标：每次构建由吉祥物点阵现生成（换装 / 改品牌色后图标自动跟上，不需要手改位图）
node tools\desktop\make-icon.mjs
if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
Copy-Item -LiteralPath tools\desktop\app.ico -Destination $stage
Copy-Item -LiteralPath tools\desktop\mascot-region.txt -Destination $stage
$sourceState = node tools\desktop\source-state.cjs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Source content verification failed.' }
@{ version = $Version; sourceCommit = $sourceState.sourceCommit; sourceDirty = $sourceState.sourceDirty; node = (node -p 'process.version'); architecture = 'windows-x64' } |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $stage 'desktop-build.json')

# WebView2 SDK：固定版本 + 固定 SHA-256，解压到 .runtime 后引用其程序集，随安装包分发，不做系统安装。
$webView2Version = '1.0.4258.31'
$webView2Sha256 = '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9'
$webView2Dir = Join-Path $repoRoot ".runtime\webview2-sdk-$webView2Version"
$webView2Lib = Join-Path $webView2Dir 'lib\net462'
$webView2Core = Join-Path $webView2Lib 'Microsoft.Web.WebView2.Core.dll'
$webView2WinForms = Join-Path $webView2Lib 'Microsoft.Web.WebView2.WinForms.dll'
$webView2Native = Join-Path $webView2Dir 'runtimes\win-x64\native\WebView2Loader.dll'
if (!(Test-Path -LiteralPath $webView2WinForms) -or !(Test-Path -LiteralPath $webView2Native)) {
    New-Item -ItemType Directory -Force -Path $webView2Dir | Out-Null
    $webView2Package = Join-Path $webView2Dir "microsoft.web.webview2.$webView2Version.nupkg"
    if (!(Test-Path -LiteralPath $webView2Package)) {
        Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$webView2Version/microsoft.web.webview2.$webView2Version.nupkg" -OutFile $webView2Package
    }
    if ((FileHash $webView2Package) -ne $webView2Sha256) { throw 'WebView2 SDK SHA-256 mismatch.' }
    $webView2Zip = Join-Path $webView2Dir 'sdk.zip'
    Copy-Item -LiteralPath $webView2Package -Destination $webView2Zip -Force
    Expand-Archive -LiteralPath $webView2Zip -DestinationPath $webView2Dir -Force
    Remove-Item -LiteralPath $webView2Zip -Force
}
Copy-Item -LiteralPath $webView2Core -Destination $stage
Copy-Item -LiteralPath $webView2WinForms -Destination $stage
Copy-Item -LiteralPath $webView2Native -Destination $stage

# ★ /win32manifest 必须给：csc 默认清单**不含 dpiAware** ⇒ 进程 DPI 不感知 ⇒
# 在 200% 缩放的屏幕上窗口被系统位图拉伸、文字发虚（2026-10-10 真机实测修复）。
$launcherManifest = Join-Path $repoRoot 'tools\desktop\launcher.manifest'
# ★ /win32icon 必须给：exe 自身带吉祥物图标，任务栏、快捷方式、卸载项才有品牌形象
$appIcon = Join-Path $repoRoot 'tools\desktop\app.ico'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Force -Path (Join-Path $githubTarget 'browser-launch') | Out-Null
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /r:System.Web.dll "/out:$githubTarget\browser-launch\rundll32.exe" tools\desktop\GithubBrowserLauncher.cs
if ($LASTEXITCODE -ne 0) { throw 'GitHub browser adapter compilation failed.' }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/win32manifest:`"$launcherManifest`"" "/win32icon:`"$appIcon`"" /r:System.Web.Extensions.dll /r:"`"$webView2Core`"" /r:"`"$webView2WinForms`"" "/out:$stage\StudentBuddy.exe" tools\desktop\Launcher.cs tools\desktop\CompanionTrail.cs tools\desktop\DesktopRecovery.cs tools\desktop\DesktopFilesHost.cs tools\desktop\DesktopQuickMenu.cs tools\desktop\DesktopCaptureSelector.cs tools\desktop\DesktopScreenCapture.cs tools\desktop\DesktopNativeReader.cs tools\desktop\DesktopStudyInvite.cs
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }

$innoDir = Join-Path $repoRoot '.runtime\inno-7.1.0'
$iscc = Join-Path $innoDir 'ISCC.exe'
if (!(Test-Path -LiteralPath $iscc)) {
    $innoSetup = Join-Path $repoRoot '.runtime\innosetup-7.1.0-x64.exe'
    if (!(Test-Path -LiteralPath $innoSetup)) {
        Invoke-WebRequest 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe' -OutFile $innoSetup
    }
    if ((FileHash $innoSetup) -ne '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f') {
        throw 'Inno Setup SHA-256 mismatch.'
    }
    $install = Start-Process -FilePath $innoSetup -ArgumentList @('/SP-', '/PORTABLE=1', '/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$innoDir`"") -WindowStyle Hidden -Wait -PassThru
    if ($install.ExitCode -ne 0) { throw 'Portable compiler extraction failed.' }
}
& $iscc "/DAppVersion=$Version" "/DSourceDirectory=$stage" "/DOutputDirectory=$OutputDir" tools\desktop\installer.iss
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$installer = Join-Path $OutputDir "StudentBuddy-$Version-windows-x64-setup.exe"
$hash = FileHash $installer
"$hash  $(Split-Path $installer -Leaf)" | Set-Content -Encoding ascii (Join-Path $OutputDir 'SHA256SUMS.txt')
Write-Host "Installer: $installer"
node tools\desktop\package-reader-extension.mjs $OutputDir (Join-Path $stage 'browser-extension')
if ($LASTEXITCODE -ne 0) { throw 'Reader extension archive failed.' }
