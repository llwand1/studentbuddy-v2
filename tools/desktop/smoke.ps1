param([string]$Installer = '', [string]$Version = '0.1.0', [string]$PreviousInstaller = '')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (!$Installer) { $Installer = Join-Path $repoRoot ".runtime\desktop-output\StudentBuddy-$Version-windows-x64-setup.exe" }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{F276CD79-EBEA-4705-9B31-20CA08B5F1EA}_is1'
if (Test-Path -LiteralPath $uninstallKey) { throw 'A user installation exists; smoke test must use a fresh machine/user.' }
$portFile = Join-Path $env:LOCALAPPDATA 'StudentBuddy\port'
$baseUrl = ''
if (Test-Path -LiteralPath $portFile) { throw 'A desktop instance appears to be running (port file exists).' }
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
function RunSetup([string]$SetupFile = $Installer) {
    $process = Start-Process -FilePath $SetupFile -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', '/TASKS=', "/DIR=`"$installDir`"", "/LOG=`"$testRoot\install.log`"") -WindowStyle Hidden -Wait -PassThru
    Assert ($process.ExitCode -eq 0) 'Installer exits successfully'
}
function StartApp {
    $process = Start-Process -FilePath $launcher -ArgumentList '--no-browser' -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($process.HasExited) { throw "Launcher exited with $($process.ExitCode). Read desktop.log." }
        try {
            $actualPort = if (Test-Path -LiteralPath $portFile) { (Get-Content -LiteralPath $portFile -ErrorAction Stop).Trim() } else { '18794' }
            $script:baseUrl = 'http://127.0.0.1:' + $actualPort
            $health = Invoke-RestMethod "$script:baseUrl/api/health" -TimeoutSec 1
            if ($health.ok) { return $process }
        } catch { }
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
    if ($PreviousInstaller) {
        $PreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstaller).Path
        RunSetup $PreviousInstaller
        $previousApp = StartApp
        $previousSession = Invoke-RestMethod "$baseUrl/api/sessions" -Method Post -Headers @{Origin=$baseUrl} -ContentType 'application/json' -Body '{}'
        StopApp
        Assert ($previousApp.WaitForExit(10000)) 'Previous public version stops cleanly'
    }
    RunSetup
    $unrelatedNode = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('-e', '"setInterval(()=>{},1000)"') -WindowStyle Hidden -PassThru
    Assert ((Test-Path -LiteralPath $launcher) -and (Test-Path -LiteralPath "$installDir\runtime\node.exe")) 'Launcher and bundled runtime are installed'
    & powershell -NoProfile -File (Join-Path $repoRoot 'tools\desktop\companion-smoke.ps1') -Launcher $launcher
    Assert ($LASTEXITCODE -eq 0) 'Packaged native companion geometry and malformed-shape checks pass'
    & powershell -NoProfile -File (Join-Path $repoRoot 'tools\desktop\recovery-smoke.ps1') -Launcher $launcher -Node (Join-Path $installDir 'runtime\node.exe')
    Assert ($LASTEXITCODE -eq 0) 'Packaged crash recovery, shutdown and owned-process cleanup pass'
    $app = StartApp
    if ($PreviousInstaller) {
        $upgradedSessions = @(Invoke-RestMethod "$baseUrl/api/sessions")
        Assert (@($upgradedSessions | Where-Object { $_.id -eq $previousSession.id }).Count -eq 1) 'Real previous-version session survives cross-version upgrade'
    }
    $page = Invoke-WebRequest $baseUrl -UseBasicParsing
    Assert ($page.Content -match '<div id="root">') 'Installed application serves the web shell'
    $assetMatch = [regex]::Match($page.Content, 'src="(/assets/[^" ]+\.js)"')
    Assert $assetMatch.Success 'Web shell references a built JavaScript asset'
    $asset = Invoke-WebRequest ($baseUrl + $assetMatch.Groups[1].Value) -UseBasicParsing
    Assert ($asset.StatusCode -eq 200 -and $asset.Content.Length -gt 1000) 'Installed JavaScript asset is accessible'
    Assert ((Invoke-RestMethod "$baseUrl/api/auth/providers").form -eq 'local') 'Desktop overrides inherited cloud mode'
    $session = Invoke-RestMethod "$baseUrl/api/sessions" -Method Post -Headers @{Origin=$baseUrl} -ContentType 'application/json' -Body '{}'
    Assert (![string]::IsNullOrEmpty($session.id)) 'Local API can save a real session'
    Assert (Test-Path -LiteralPath (Join-Path $installDir 'browser-extension\manifest.json')) 'Installer includes the chosen-page browser extension'
    $study = Invoke-RestMethod "$baseUrl/api/desktop/study"
    Assert (!$study.settings.enabled -and $study.settings.intervalMinutes -eq 3) 'Timed quiz is opt-in with a three minute default'
    $pairBody = @{sessionId=$session.id} | ConvertTo-Json -Compress
    $pairCode = Invoke-RestMethod "$baseUrl/api/desktop/browser/pair-code" -Method Post -Headers @{Origin=$baseUrl} -ContentType 'application/json' -Body $pairBody
    Assert ($pairCode.code.Length -eq 10 -and $pairCode.endpoint -eq $baseUrl) 'Local reader pairing reports the actual loopback port'
    $pairRequest = @{code=$pairCode.code} | ConvertTo-Json -Compress
    $connection = Invoke-RestMethod "$baseUrl/api/desktop/bridge/pair" -Method Post -ContentType 'application/json' -Body $pairRequest
    $bridgeHeaders = @{Authorization=('Bearer ' + $connection.token)}
    $snapshot = @{url='https://example.org/learning'; title='Installer reading smoke'; text='A selected webpage supplies temporary learning material.'; selection='temporary learning material'; viewport='A selected webpage'; epoch='installer-smoke'; seq=1} | ConvertTo-Json -Compress
    $null = Invoke-RestMethod "$baseUrl/api/desktop/bridge/page" -Method Post -Headers $bridgeHeaders -ContentType 'application/json' -Body $snapshot
    $reader = Invoke-RestMethod "$baseUrl/api/desktop/browser?text=1"
    Assert ($reader.page.connected -and $reader.page.sessionId -eq $session.id -and $reader.page.text -match 'temporary learning material') 'Packaged reader pairs and receives the chosen-page snapshot'
    $null = Invoke-RestMethod "$baseUrl/api/desktop/browser" -Method Delete -Headers @{Origin=$baseUrl}
    Assert ($null -eq (Invoke-RestMethod "$baseUrl/api/desktop/browser?text=1").page) 'Stopping packaged reader clears its temporary material'
    $enabledSettings = @{enabled=$true; intervalMinutes=3; scope='browser'} | ConvertTo-Json -Compress
    $configured = Invoke-RestMethod "$baseUrl/api/desktop/study" -Method Post -Headers @{Origin=$baseUrl} -ContentType 'application/json' -Body $enabledSettings
    Assert ($configured.settings.enabled -and $configured.settings.scope -eq 'browser' -and $configured.nextAt -gt 0) 'Packaged timer saves the interval and chosen reading scope'
    $disabledSettings = @{enabled=$false; intervalMinutes=3; scope='learning'} | ConvertTo-Json -Compress
    $configured = Invoke-RestMethod "$baseUrl/api/desktop/study" -Method Post -Headers @{Origin=$baseUrl} -ContentType 'application/json' -Body $disabledSettings
    Assert (!$configured.settings.enabled -and $null -eq $configured.nextAt) 'Disabling packaged timer cancels its deadline'
    $duplicate = Start-Process -FilePath $launcher -ArgumentList '--no-browser' -WindowStyle Hidden -Wait -PassThru
    $servers = @(Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$installDir\runtime\node.exe" })
    Assert ($duplicate.ExitCode -eq 0 -and !$app.HasExited -and $servers.Count -eq 1) 'Repeated launch shares exactly one bundled server'
    StopApp
    Assert ($app.WaitForExit(10000)) 'Stopping releases the launcher and its server'
    & "$installDir\runtime\node.exe" "$repoRoot\tools\desktop\migration-smoke.cjs" prepare "$dataDir\studentbuddy.db"
    Assert ($LASTEXITCODE -eq 0) 'Isolated database reproduces the already-recorded v58 collision'
    $app = StartApp
    StopApp
    Assert ($app.WaitForExit(10000)) 'Repaired legacy database starts and stops successfully'
    & "$installDir\runtime\node.exe" "$repoRoot\tools\desktop\migration-smoke.cjs" verify "$dataDir\studentbuddy.db" $session.id
    Assert ($LASTEXITCODE -eq 0) 'Installed v59 repairs both missing tables and GrillMe field without losing the session'
    $occupied = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 18794)
    $canOccupy = $true
    try { $occupied.Start() } catch { $canOccupy = $false }
    if ($canOccupy) {
        try {
            $fallback = StartApp
            Assert ($baseUrl -ne 'http://127.0.0.1:18794') 'Preferred port occupied: launcher falls back to another loopback port'
            Assert ($occupied.Server.IsBound) 'Fallback leaves the occupying service untouched'
            StopApp
            Assert ($fallback.WaitForExit(10000)) 'Fallback instance stops cleanly'
        } finally { $occupied.Stop() }
    } else {
        Write-Host 'SKIP Preferred port 18794 cannot be bound in this environment (OS port exclusion, e.g. Hyper-V/WSL); conflict case not exercised.'
    }
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
