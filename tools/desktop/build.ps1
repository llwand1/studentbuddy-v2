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
$sourceCommit = git rev-parse HEAD
@{ version = $Version; sourceCommit = $sourceCommit; node = (node -p 'process.version'); architecture = 'windows-x64' } |
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

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /r:"`"$webView2Core`"" /r:"`"$webView2WinForms`"" "/out:$stage\StudentBuddy.exe" tools\desktop\Launcher.cs
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
    $install = Start-Process -FilePath $innoSetup -ArgumentList @('/PORTABLE=1', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$innoDir`"") -WindowStyle Hidden -Wait -PassThru
    if ($install.ExitCode -ne 0) { throw 'Portable compiler extraction failed.' }
}
& $iscc "/DAppVersion=$Version" "/DSourceDirectory=$stage" "/DOutputDirectory=$OutputDir" tools\desktop\installer.iss
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$installer = Join-Path $OutputDir "StudentBuddy-$Version-windows-x64-setup.exe"
$hash = FileHash $installer
"$hash  $(Split-Path $installer -Leaf)" | Set-Content -Encoding ascii (Join-Path $OutputDir 'SHA256SUMS.txt')
Write-Host "Installer: $installer"
