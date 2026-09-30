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
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /optimize+ /codepage:65001 "/out:$stage\StudentBuddy.exe" tools\desktop\Launcher.cs
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
