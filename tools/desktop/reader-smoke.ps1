param([Parameter(Mandatory=$true)][string]$Launcher)
$ErrorActionPreference='Stop'
$Launcher=(Resolve-Path -LiteralPath $Launcher).Path
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$test=Join-Path $root ('.runtime\reader-smoke-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $test | Out-Null
foreach($name in @('StudentBuddy.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')) { Copy-Item -LiteralPath (Join-Path (Split-Path $Launcher) $name) -Destination $test }
$fixture=Join-Path $test 'ReaderSmoke.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /platform:x64 /codepage:65001 "/out:$fixture" (Join-Path $PSScriptRoot 'ReaderSmoke.cs')
if ($LASTEXITCODE -ne 0) { throw 'Reader fixture compilation failed' }
& $fixture (Join-Path $test 'StudentBuddy.exe')
if ($LASTEXITCODE -ne 0) { throw 'Native reader tests failed' }
