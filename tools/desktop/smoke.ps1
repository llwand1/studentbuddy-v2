param([string]$Installer = '', [string]$Version = '0.1.0')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (!$Installer) { $Installer = Join-Path $repoRoot ".runtime\desktop-output\StudentBuddy-$Version-windows-x64-setup.exe" }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{F276CD79-EBEA-4705-9B31-20CA08B5F1EA}_is1'
if (Test-Path -LiteralPath $uninstallKey) { throw 'A user installation exists; smoke test must use a fresh machine/user.' }
$baseUrl = 'http://127.0.0.1:18794'
try { Invoke-WebRequest "$baseUrl/api/health" -UseBasicParsing -TimeoutSec 1 | Out-Null; throw 'Desktop port is in use.' }
catch [System.Net.WebException] { }
$testRoot = Join-Path $repoRoot ('.runtime\smoke-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot 'Install with spaces'
$dataDir = Join-Path $testRoot 'data'
$launcher = Join-Path $installDir 'StudentBuddy.exe'
$savedDataDir = $env:SB_DATA_DIR
$savedRequireAuth = $env:SB_REQUIRE_AUTH
$env:SB_DATA_DIR = $dataDir
$env:SB_REQUIRE_AUTH = '1' # The desktop launcher must override inherited cloud configuration.
$assertions = 0
$unrelatedNode = $null
function Assert([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
    $script:assertions++
    Write-Host "PASS $Message"
}
function RunSetup {
    $process = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', '/TASKS=', "/DIR=`"$installDir`"", "/LOG=`"$testRoot\install.log`"") -WindowStyle Hidden -Wait -PassThru
    Assert ($process.ExitCode -eq 0) 'Installer exits successfully'
}
function StartApp {
    $process = Start-Process -FilePath $launcher -ArgumentList '--no-browser' -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($process.HasExited) { throw "Launcher exited with $($process.ExitCode). Read desktop.log." }
        try {
            $health = Invoke-RestMethod "$baseUrl/api/health" -TimeoutSec 1
            if ($health.ok) { return $process }
        } catch [System.Net.WebException] { }
        Start-Sleep -Milliseconds 250
    }
    throw 'Desktop did not become healthy.'
}
function StopApp {
    $process = Start-Process -FilePath $launcher -ArgumentList '--stop' -WindowStyle Hidden -Wait -PassThru
    Assert ($process.ExitCode -eq 0) 'Stop command exits successfully'
}
try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    RunSetup
    $unrelatedNode = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('-e', '"setInterval(()=>{},1000)"') -WindowStyle Hidden -PassThru
    Assert ((Test-Path -LiteralPath $launcher) -and (Test-Path -LiteralPath "$installDir\runtime\node.exe")) 'Launcher and bundled runtime are installed'
    $app = StartApp
    $page = Invoke-WebRequest $baseUrl -UseBasicParsing
    Assert ($page.Content -match '<div id="root">') 'Installed application serves the web shell'
    $assetMatch = [regex]::Match($page.Content, 'src="(/assets/[^" ]+\.js)"')
    Assert $assetMatch.Success 'Web shell references a built JavaScript asset'
    $asset = Invoke-WebRequest ($baseUrl + $assetMatch.Groups[1].Value) -UseBasicParsing
    Assert ($asset.StatusCode -eq 200 -and $asset.Content.Length -gt 1000) 'Installed JavaScript asset is accessible'
    Assert ((Invoke-RestMethod "$baseUrl/api/auth/providers").form -eq 'local') 'Desktop overrides inherited cloud mode'
    $session = Invoke-RestMethod "$baseUrl/api/sessions" -Method Post -Headers @{Origin=$baseUrl} -ContentType 'application/json' -Body '{}'
    Assert (![string]::IsNullOrEmpty($session.id)) 'Local API can save a real session'
    $duplicate = Start-Process -FilePath $launcher -ArgumentList '--no-browser' -WindowStyle Hidden -Wait -PassThru
    $servers = @(Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$installDir\runtime\node.exe" })
    Assert ($duplicate.ExitCode -eq 0 -and !$app.HasExited -and $servers.Count -eq 1) 'Repeated launch shares exactly one bundled server'
    StopApp
    Assert ($app.WaitForExit(10000)) 'Stopping releases the launcher and its server'
    $occupied = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 18794)
    try {
        $occupied.Start()
        $conflict = Start-Process -FilePath $launcher -ArgumentList '--no-browser' -WindowStyle Hidden -Wait -PassThru
        Assert ($conflict.ExitCode -ne 0 -and $occupied.Server.IsBound) 'Occupied port fails without replacing another service'
    } finally { $occupied.Stop() }
    $app = StartApp
    RunSetup # Update while the installed application is running.
    Assert ($app.WaitForExit(10000)) 'Upgrade stops the old launcher'
    $app = StartApp
    $sessions = @(Invoke-RestMethod "$baseUrl/api/sessions")
    Assert (@($sessions | Where-Object { $_.id -eq $session.id }).Count -eq 1) 'Session survives stop, restart and upgrade'
    $uninstall = Start-Process -FilePath "$installDir\unins000.exe" -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -WindowStyle Hidden -Wait -PassThru
    Assert ($uninstall.ExitCode -eq 0 -and $app.WaitForExit(10000)) 'Uninstall stops only this application'
    Assert (!$unrelatedNode.HasExited) 'Uninstall leaves an unrelated Node process running'
    Assert (!(Test-Path -LiteralPath $launcher) -and !(Test-Path -LiteralPath $uninstallKey)) 'Uninstall removes application and registration'
    Assert (Test-Path -LiteralPath "$dataDir\studentbuddy.db") 'Uninstall preserves the learning database'
    Write-Host "Desktop smoke: $assertions assertions passed. Test data: $testRoot"
} finally {
    if (Test-Path -LiteralPath $launcher) {
        Start-Process -FilePath $launcher -ArgumentList '--stop' -WindowStyle Hidden -Wait | Out-Null
        if (Test-Path -LiteralPath "$installDir\unins000.exe") {
            Start-Process -FilePath "$installDir\unins000.exe" -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -WindowStyle Hidden -Wait | Out-Null
        }
    }
    $env:SB_DATA_DIR = $savedDataDir
    $env:SB_REQUIRE_AUTH = $savedRequireAuth
    if ($unrelatedNode -and !$unrelatedNode.HasExited) { $unrelatedNode.Kill(); $unrelatedNode.WaitForExit(5000) | Out-Null }
}
