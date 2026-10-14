param([Parameter(Mandatory=$true)][string]$Launcher, [string]$Node = '')
$ErrorActionPreference = 'Stop'
$Launcher = (Resolve-Path -LiteralPath $Launcher).Path
if (!$Node) { $Node = (Get-Command node.exe).Source }
$Node = (Resolve-Path -LiteralPath $Node).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$testRoot = Join-Path $repoRoot ('.runtime\recovery-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
foreach ($name in @('StudentBuddy.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')) {
    Copy-Item -LiteralPath (Join-Path (Split-Path $Launcher) $name) -Destination $testRoot
}
$fixture = Join-Path $testRoot 'RecoverySmoke.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /platform:x64 "/out:$fixture" (Join-Path $PSScriptRoot 'RecoverySmoke.cs')
if ($LASTEXITCODE -ne 0) { throw 'Recovery fixture compilation failed.' }
& $fixture (Join-Path $testRoot 'StudentBuddy.exe') $Node $testRoot
if ($LASTEXITCODE -ne 0) { throw 'Isolated native recovery tests failed.' }
