param([Parameter(Mandatory=$true)][string]$Launcher)
$ErrorActionPreference = 'Stop'
$Launcher = (Resolve-Path -LiteralPath $Launcher).Path
$folder = Split-Path $Launcher
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Web.Extensions
foreach ($name in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')) {
    $null = [Reflection.Assembly]::LoadFrom((Join-Path $folder $name))
}
$assembly = [Reflection.Assembly]::LoadFrom($Launcher)
$type = $assembly.GetType('Launcher', $true)
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$checks = 0
function Check([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
    $script:checks++
    Write-Host "PASS $Message"
}
Check ($type.GetField('BallLogical',$flags).GetRawConstantValue() -eq 64) 'Native companion occupies a 64 logical pixel window'
Check ($type.GetField('BallCellLogical',$flags).GetRawConstantValue() -eq 2) 'Native sprite is 32 logical pixels'
$scale = $type.GetMethod('ScaleBallRect',$flags)
foreach ($factor in @([single]1,[single]1.25,[single]1.5,[single]2)) {
    $rect = $scale.Invoke($null,@(16,16,32,32,$factor))
    Check ($rect.X -eq [Math]::Round(16*$factor) -and $rect.Width -eq [Math]::Round(32*$factor)) "Clip edges align at DPI factor $factor"
}
$parse = $type.GetMethod('ParseBallShape',$flags)
$valid = $parse.Invoke($null,@('[[16,16,32,32],[1,2,2,2]]'))
Check ($valid.Length -eq 2) 'Sprite and particle shapes are accepted together'
$tooMany = '[' + ((1..97 | ForEach-Object { '[0,0,1,1]' }) -join ',') + ']'
Check ($null -eq $parse.Invoke($null,@($tooMany))) 'Excess particle regions are rejected'
foreach ($invalid in @('[]','[[63,0,2,2]]','[[0,0,0,2]]','[[0,0,2]]','[[1.5,0,2,2]]','[[-1,0,2,2]]','[[99999999999999,0,1,1]]','null',('['+(('[[0,0,1,1]]')*100)+']'))) {
    Check ($null -eq $parse.Invoke($null,@($invalid))) 'Invalid geometry leaves the previous native clip intact'
}
Write-Host "Native companion smoke: $checks assertions passed; no windows or personal data opened."

