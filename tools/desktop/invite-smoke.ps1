param([Parameter(Mandatory=$true)][string]$Launcher,[string]$Frames='')
$ErrorActionPreference='Stop'
$Launcher=(Resolve-Path -LiteralPath $Launcher).Path
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$target=Join-Path $repo ('.runtime\invite-smoke-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $target | Out-Null
foreach($name in @('StudentBuddy.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')){Copy-Item -LiteralPath (Join-Path (Split-Path $Launcher) $name) -Destination $target}
$fixture=Join-Path $target 'StudyInviteSmoke.exe'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /platform:x64 /codepage:65001 "/out:$fixture" (Join-Path $PSScriptRoot 'StudyInviteSmoke.cs')
if($LASTEXITCODE -ne 0){throw 'Invitation fixture compilation failed'}
if($Frames){& $fixture (Join-Path $target 'StudentBuddy.exe') ([IO.Path]::GetFullPath($Frames))}else{& $fixture (Join-Path $target 'StudentBuddy.exe')}
if($LASTEXITCODE -ne 0){throw 'Native invitation tests failed'}
