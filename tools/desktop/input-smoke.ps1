param([Parameter(Mandatory=$true)][string]$Launcher)
$ErrorActionPreference='Stop'
$Launcher=(Resolve-Path -LiteralPath $Launcher).Path
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$testRoot=Join-Path $repoRoot ('.runtime\input-smoke-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
foreach($name in @('StudentBuddy.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')){Copy-Item -LiteralPath (Join-Path (Split-Path $Launcher) $name) -Destination $testRoot}
$fixture=Join-Path $testRoot 'DesktopInputSmoke.exe'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /platform:x64 /codepage:65001 "/out:$fixture" (Join-Path $PSScriptRoot 'DesktopInputSmoke.cs')
if($LASTEXITCODE -ne 0){throw 'Input fixture compilation failed'}
& $fixture (Join-Path $testRoot 'StudentBuddy.exe')
if($LASTEXITCODE -ne 0){throw 'Native input tests failed'}
