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
$tooMany = '[' + ((1..513 | ForEach-Object { '[0,0,1,1]' }) -join ',') + ']'
Check ($null -eq $parse.Invoke($null,@($tooMany))) 'Excess particle regions are rejected'
foreach ($invalid in @('[]','[[63,0,2,2]]','[[0,0,0,2]]','[[0,0,2]]','[[1.5,0,2,2]]','[[-1,0,2,2]]','[[99999999999999,0,1,1]]','null',('['+(('[[0,0,1,1]]')*100)+']'))) {
    Check ($null -eq $parse.Invoke($null,@($invalid))) 'Invalid geometry leaves the previous native clip intact'
}
$sigil = '[' + ((1..512 | ForEach-Object { '[1,1,2,2]' }) -join ',') + ']'
Check ($parse.Invoke($null,@($sigil)).Length -eq 512) 'The circle, book and halos fit the bounded native clip budget'
Check ($null -eq $parse.Invoke($null,@($sigil.PadRight(12001)))) 'Oversized shape messages are rejected before parsing'
$click = $type.GetMethod('ShouldOpenBallAfterMove',$flags)
$origin = [Drawing.Point]::new(0,0)
Check ($click.Invoke($null,@($origin,$origin,$false))) 'An unmoved tap still opens the app'
Check (!$click.Invoke($null,@($origin,$origin,$true))) 'Dragging back to the starting point never becomes a tap'
Check (!$click.Invoke($null,@($origin,[Drawing.Point]::new(10,0),$false))) 'A changed position never becomes a tap'
$trailType = $assembly.GetType('CompanionTrailState',$true)
$instanceFlags = [Reflection.BindingFlags]'NonPublic,Instance'
$add = $trailType.GetMethod('Add',$instanceFlags)
$frame = $trailType.GetMethod('Frame',$instanceFlags)
$count = $trailType.GetProperty('Count',$instanceFlags)
foreach ($factor in @([single]1,[single]1.25,[single]1.5,[single]2)) {
    $trail = [Activator]::CreateInstance($trailType,$true)
    $null = $add.Invoke($trail,@($origin,[double]0,$factor))
    $null = $add.Invoke($trail,@([Drawing.Point]::new([int](100*$factor),0),[double]100,$factor))
    $paint = @($frame.Invoke($trail,@([double]300,$factor)))
    $validPixels = $paint.Count -gt 0
    $warmOnly = $true; $flame = $false; $ember = $false
    foreach ($pixel in $paint) {
        $bounds = $pixel.GetType().GetField('Bounds',$instanceFlags).GetValue($pixel)
        $color = $pixel.GetType().GetField('Color',$instanceFlags).GetValue($pixel)
        $validPixels = $validPixels -and $bounds.Width -gt 0 -and $bounds.Height -gt 0
        $warmOnly = $warmOnly -and $color.R -gt $color.G -and $color.R -gt $color.B
        $flame = $flame -or ($bounds.Height -gt $bounds.Width -and $color.G -gt $color.B)
        $ember = $ember -or ($bounds.Width -eq $bounds.Height -and $color.G -gt $color.B)
    }
    Check ($validPixels -and $warmOnly -and $flame -and $ember) "World-space trail uses only warm flame tongues and small embers at DPI $factor"
    Check (@($frame.Invoke($trail,@([double]1000,$factor))).Count -eq 0) 'Trail evaporates after its final movement'
}
$trail = [Activator]::CreateInstance($trailType,$true)
$null = $add.Invoke($trail,@($origin,[double]0,[single]1))
$null = $add.Invoke($trail,@($origin,[double]10,[single]1))
Check ($count.GetValue($trail,$null) -eq 1) 'Stationary pointers do not accumulate a trail'
for ($i=1;$i -le 200;$i++) { $null = $add.Invoke($trail,@([Drawing.Point]::new($i*3,0),[double]$i,[single]1)) }
Check ($count.GetValue($trail,$null) -le 48) 'Fast movement has bounded trail history'
$null = $add.Invoke($trail,@([Drawing.Point]::new(8000,-4000),[double]300,[single]1))
Check ($count.GetValue($trail,$null) -eq 1) 'Cross-monitor jumps do not create giant trail windows'
$trailType.GetMethod('Clear',$instanceFlags).Invoke($trail,@())
Check ($count.GetValue($trail,$null) -eq 0) 'Hiding or disabling effects clears trail history'
$overlayType = $assembly.GetType('CompanionTrail',$true)
$style = $overlayType.GetField('PassThroughStyles',$flags).GetRawConstantValue()
Check (($style -band 0x80020) -eq 0x80020 -and ($style -band 0x08000000) -ne 0) 'Trail overlays use layered click-through and never-activate styles'
Write-Host "Native companion smoke: $checks assertions passed; no windows or personal data opened."

