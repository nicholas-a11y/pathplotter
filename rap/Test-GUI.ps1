#requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
    [Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Run using built-in Windows PowerShell 5.1 -STA.' }
$state = Join-Path $PSScriptRoot ('.gui-test-' + [Guid]::NewGuid().ToString('N'))
$compilerScratchPattern = '^[a-z0-9]{8}\.(?:\d+\.)?(?:cs|cmdline|tmp|out|dll|pdb)$'
$existingCompilerScratch = @{}
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Force -File) {
    if ($file.Name -match $compilerScratchPattern) { $existingCompilerScratch[$file.Name] = $true }
}
try {
    . (Join-Path $PSScriptRoot 'GUI.ps1') -LibraryOnly
    Initialize-DesktopTypes
    $url = 'https://nicholas-a11y.github.io/pathplotter/#relay=https%3A%2F%2Ffixture.invalid&relayId=fixture-relay&invite=fixture-phone'
    $image = New-InvitationBitmap $url
    try {
        if ($image.Width -lt 100 -or $image.Width -ne $image.Height -or $image.GetPixel(0, 0).ToArgb() -ne [Drawing.Color]::White.ToArgb()) { throw 'QR bitmap/quiet zone invalid.' }
        $qr = [Net.Codecrete.QrCodeGenerator.QrCode]::EncodeText($url, [Net.Codecrete.QrCodeGenerator.QrCode+Ecc]::Medium)
        for ($y = -4; $y -lt $qr.Size + 4; $y++) {
            for ($x = -4; $x -lt $qr.Size + 4; $x++) {
                $dark = $image.GetPixel(($x + 4) * 4 + 2, ($y + 4) * 4 + 2).ToArgb() -eq [Drawing.Color]::Black.ToArgb()
                if ($dark -ne $qr.GetModule($x, $y)) { throw 'QR bitmap does not match the exact invitation encoding.' }
            }
        }
    } finally { $image.Dispose() }
    $rejected = $false
    try { $image = New-InvitationBitmap ($url.Replace('&invite=', '&launch=')); $image.Dispose() } catch { $rejected = $true }
    if (-not $rejected) { throw 'Desktop launch must never be QR encoded.' }
    $rejected = $false
    try { $image = New-InvitationBitmap ($url.Replace('&invite=', '&launch=private&invite=')); $image.Dispose() } catch { $rejected = $true }
    if (-not $rejected) { throw 'Mixed desktop/phone fragment must never be QR encoded.' }
    Write-Host 'PASS local licensed QR bitmap and desktop-grant QR refusal.'
    $key = Get-ActivationKey $state
    $owner = New-Object PathPlotterRap.Activation($key)
    $other = New-Object PathPlotterRap.Activation($key)
    try {
        if (-not $owner.Owner -or $other.Owner -or -not $other.Signal()) { throw 'Current-user activation failed.' }
        Start-Sleep -Milliseconds 100
        if (-not $owner.TakeActivation() -or $owner.TakeActivation()) { throw 'Activation was not consumed exactly once.' }
    } finally { $other.Dispose(); $owner.Dispose() }
    Write-Host 'PASS fixed-action duplicate current-user activation.'
    $bridge = New-Object PathPlotterRap.UiBridge
    . (Join-Path $PSScriptRoot 'GUIWorker.ps1') -Bridge $bridge -DataDirectory $state -LibraryOnly
    $script:Config = @{ apiRoot = 'https://fixture.invalid'; relayId = 'fixture-relay'; credential = 'fixture-only'; lightBurnSecret = 'fixture-only' }
    $script:ServerTime = 100000; $script:ServerTick = $script:Clock.ElapsedMilliseconds; $script:ClockUncertainty = 0
    $script:WireCalls = New-Object 'Collections.Generic.List[object]'
    $script:ExpiredLaunch = $false
    $script:ApprovedBrowserIds = @()
    function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
        $script:WireCalls.Add(@{ path = $Path; body = $Body; method = $Method })
        switch ($Path) {
            '/agent/browsers' { return @{ browsers = @($script:ApprovedBrowserIds | ForEach-Object { @{ id = $_ } }) } }
            '/agent/browser-launch' {
                $expiry = (Get-ServerNow) + 60000
                if ($script:ExpiredLaunch) { $expiry = 1 }
                return @{ launchToken = 'fixture-private-launch'; expiresAt = $expiry }
            }
            '/agent/pairing/new' { return @{ invitation = 'fixture-phone'; expiresAt = (Get-ServerNow) + 60000 } }
            '/agent/pairing/decide' { return @{} }
            '/agent/browsers/revoke' { return @{} }
            default { throw 'Unexpected network call forbidden in GUI protocol checks.' }
        }
    }
    Publish-RapHealth 'not verified' $false
    if ($script:WireCalls.Count -ne 0) { throw 'Auto-open before verified healthy startup.' }
    Publish-RapHealth 'verified' $true
    Publish-RapHealth 'disconnected' $false
    Publish-RapHealth 'reconnected' $true
    Publish-RapHealth 'verified' $true
    if ($script:WireCalls.Count -ne 2 -or $script:WireCalls[1].path -cne '/agent/browser-launch' -or $script:WireCalls[1].body.Count -ne 0) { throw 'Desktop launch is not once-only or uses the wrong endpoint/body.' }
    Invoke-UiCommand @{ action = 'open' }
    if ($script:WireCalls.Count -ne 4 -or $script:WireCalls[3].path -cne '/agent/browser-launch') { throw 'Explicit open did not create a fresh launch.' }
    $script:ExpiredLaunch = $true
    $rejected = $false
    try { Invoke-UiCommand @{ action = 'open' } } catch { $rejected = $true }
    if (-not $rejected) { throw 'Expired desktop launch accepted.' }
    $script:ExpiredLaunch = $false
    Invoke-UiCommand @{ action = 'phone' }
    if ($script:WireCalls[6].path -cne '/agent/pairing/new') { throw 'Phone incorrectly used desktop authorization.' }
    $before = $script:WireCalls.Count
    Show-PendingPairings @(@{ id = 'fixture-request'; phrase = 'EXACT PHRASE' })
    if ($script:WireCalls.Count -ne $before) { throw 'An ordinary pending request was automatically approved.' }
    foreach ($command in @(
        @{ action = 'decide'; id = 'wrong-request'; phrase = 'EXACT PHRASE'; approve = $true },
        @{ action = 'decide'; id = 'fixture-request'; phrase = 'exact phrase'; approve = $true }
    )) {
        $rejected = $false
        try { Invoke-UiCommand $command } catch { $rejected = $true }
        if (-not $rejected -or $script:WireCalls.Count -ne $before) { throw 'Mismatched request or phrase reached cloud approval.' }
    }
    Invoke-UiCommand @{ action = 'decide'; id = 'fixture-request'; phrase = 'EXACT PHRASE'; approve = $true }
    if ($script:WireCalls[$before + 1].body.pairingId -cne 'fixture-request' -or $script:WireCalls[$before + 1].body.approve -ne $true) { throw 'GUI approval targeted the wrong request.' }
    Show-PendingPairings @()
    $rejected = $false
    try { Invoke-UiCommand @{ action = 'decide'; id = 'fixture-request'; phrase = 'EXACT PHRASE'; approve = $false } } catch { $rejected = $true }
    if (-not $rejected) { throw 'Expired/removed pairing remained actionable.' }
    $event = $null
    while ($bridge.Events.TryDequeue([ref]$event)) {
        if ($event.kind -ceq 'desktop' -and ($event.value -notmatch '&launch=fixture-private-launch$' -or $event.value -match '&invite=')) { throw 'Invalid desktop launch fragment.' }
        if ($event.kind -ceq 'phone' -and ($event.value.url -notmatch '&invite=fixture-phone$' -or $event.value.url -match '&launch=')) { throw 'Invalid phone invitation fragment.' }
    }
    $script:Generation = 1; $script:ActiveImport = @{ generation = 1 }; $script:StopRequested = $false
    $bridge.StopRequested = $true
    $rejected = $false
    try { Assert-ImportOwnership } catch { $rejected = $true }
    if (-not $rejected -or -not $script:StopRequested) { throw 'GUI quit did not fence import ownership.' }
    $script:ActiveImport = $null; $script:StopRequested = $false; $bridge.StopRequested = $false
    Write-Host 'PASS GUI protocol: fresh auto-open once across reconnect, explicit fresh open, expired launch refusal, ordinary invitation separation, exact approval and removed-request refusal.'
    $script:ActiveImport = @{ fixture = $true }; $script:LatestRelease = @{ version = '9.9.9' }
    function Install-RapUpdate { throw 'Update installed during an import.' }
    Invoke-UiCommand @{ action = 'update' }
    if ($script:StopRequested) { throw 'Update stopped RAP during an import.' }
    $script:ActiveImport = $null; $script:LatestRelease = $null
    Write-Host 'PASS update is refused while an import is active.'
    $script:ApprovedBrowserIds = @([Guid]::NewGuid().ToString('D'))
    $script:AutoOpened = $false
    $before = $script:WireCalls.Count
    Publish-RapHealth 'verified' $true
    if ($script:WireCalls.Count -ne $before + 1 -or $script:WireCalls[$before].path -cne '/agent/browsers') { throw 'Auto-open attempted to replace a saved browser.' }
    Invoke-UiCommand @{ action = 'open' }
    if ($script:WireCalls[$script:WireCalls.Count - 1].path -cne '/agent/browsers') { throw 'Open did not wait for confirmation.' }
    Invoke-UiCommand @{ action = 'open-replace'; replaceBrowserIds = $script:ApprovedBrowserIds }
    if ($script:WireCalls[$script:WireCalls.Count - 1].body.replaceBrowserIds[0] -cne $script:ApprovedBrowserIds[0]) { throw 'Replacement did not carry exact reviewed browser IDs.' }
    Show-PendingPairings @(@{ id = 'replacement-phone'; phrase = 'EXACT SWITCH' })
    Invoke-UiCommand @{ action = 'decide'; id = 'replacement-phone'; phrase = 'EXACT SWITCH'; approve = $true }
    if ($script:WireCalls[$script:WireCalls.Count - 1].path -cne '/agent/browsers') { throw 'Phone approval silently replaced a browser.' }
    Invoke-UiCommand @{ action = 'decide-replace'; id = 'replacement-phone'; phrase = 'EXACT SWITCH'; approve = $true; replaceBrowserIds = $script:ApprovedBrowserIds }
    if ($script:WireCalls[$script:WireCalls.Count - 1].body.replaceBrowserIds[0] -cne $script:ApprovedBrowserIds[0]) { throw 'Phone switch omitted replacement IDs.' }
    Write-Host 'PASS one-browser GUI protocol: restart preserves existing pairing, explicit desktop/phone replacement confirmation and exact identity fencing.'
    # One paired browser is shown in the window with Disconnect; revoking is quiet.
    $script:ApprovedBrowserIds = @()
    $drop = $null; while ($bridge.Events.TryDequeue([ref]$drop)) { }
    Send-BrowserState
    $none = $null; $drop = $null; while ($bridge.Events.TryDequeue([ref]$drop)) { if ($drop.kind -ceq 'browser') { $none = $drop } }
    if ($null -eq $none -or $null -ne $none.value) { throw 'No paired browser was not reported as empty.' }
    $script:ApprovedBrowserIds = @('browser-one')
    Send-BrowserState
    $one = $null; while ($bridge.Events.TryDequeue([ref]$drop)) { if ($drop.kind -ceq 'browser') { $one = $drop } }
    if ($null -eq $one -or $one.value.id -cne 'browser-one' -or $one.value.label -cne 'Approved browser 1') { throw 'Paired browser was not reported with its id and label.' }
    Invoke-UiCommand @{ action = 'revoke'; id = 'browser-one' }
    if ($script:WireCalls[$script:WireCalls.Count - 1].path -cne '/agent/browsers/revoke' -or $script:WireCalls[$script:WireCalls.Count - 1].body.browserId -cne 'browser-one') { throw 'Disconnect did not revoke the shown browser.' }
    $noisy = $false; while ($bridge.Events.TryDequeue([ref]$drop)) { if ($drop.kind -ceq 'notice') { $noisy = $true } }
    if ($noisy) { throw 'Disconnecting a browser raised a notice.' }
    $script:ApprovedBrowserIds = @()
    Write-Host 'PASS paired browser is reported for the window and Disconnect revokes it without a notice.'    # Browser pairing needs only the relay session; LightBurn readiness is independent.
    $script:AutoOpened = $false; $script:ApprovedBrowserIds = @(); $script:WireCalls.Clear(); $script:CloudReady = $false
    Publish-RapHealth 'LightBurn not listening' $false $false
    if ($script:WireCalls.Count -ne 0 -or $script:CloudReady) { throw 'Pairing was available without a relay session.' }
    $rejected = $false
    try { Invoke-UiCommand @{ action = 'phone' } } catch { $rejected = $true }
    if (-not $rejected) { throw 'Phone pairing was allowed without a relay session.' }
    Publish-RapHealth 'LightBurn not listening' $false $true
    if (-not $script:CloudReady -or $script:WireCalls.Count -ne 2 -or $script:WireCalls[1].path -cne '/agent/browser-launch') { throw 'A relay session without LightBurn did not allow desktop pairing.' }
    Invoke-UiCommand @{ action = 'phone' }
    if ($script:WireCalls[$script:WireCalls.Count - 1].path -cne '/agent/pairing/new') { throw 'A relay session without LightBurn did not allow phone pairing.' }
    $ev = $null; $health = $null; function Clear-Events { $drop = $null; while ($bridge.Events.TryDequeue([ref]$drop)) { } }; function Read-Events { $items = @(); $item = $null; while ($bridge.Events.TryDequeue([ref]$item)) { $items += ,$item }; return ,$items }
    Clear-Events
    Publish-RapHealth 'LightBurn not listening' $false $true
    foreach ($ev in (Read-Events)) { if ($ev.kind -ceq 'health') { $health = $ev.value } }
    if ($health.connected -or -not $health.cloud) { throw 'Health event did not report relay ready and LightBurn not ready separately.' }
    Write-Host 'PASS relay session pairs browsers while LightBurn is not ready; the LightBurn state is reported separately.'
    # LightBurn permission is requested without blocking and is stored only when granted.
    Initialize-Storage
    $script:Config = @{ apiRoot = 'https://fixture.invalid'; relayId = 'fixture-relay'; credential = 'fixture-only'; lightBurnSecret = '' }
    $script:ConsentAnswer = @{ status = 'denied' }
    function Start-LightBurnConnect { return @{ ready = $true } }
    function Test-LightBurnConnectReady($Job) { return $Job.ready }
    function Complete-LightBurnConnect($Job) { return $script:ConsentAnswer }
    Clear-Events
    Start-LightBurnConsent
    Start-LightBurnConsent
    Update-LightBurnConsent
    $kinds = @(foreach ($ev in (Read-Events)) { [string]$ev.kind + ':' + $ev.value })
    if (($kinds -join ',') -cne 'consent-pending:,notice:LightBurn did not grant access. Enable its local REST API, keep network API access disabled, bring LightBurn forward and approve its dialog within 30 seconds. Retry only with consent.,consent-done:False' -or $script:Config.lightBurnSecret -ne '') { throw 'Denied LightBurn consent was stored or not reported: ' + ($kinds -join ',') }
    $script:ConsentAnswer = @{ status = 'ok'; secret = 'fixture-granted' }
    Start-LightBurnConsent
    Update-LightBurnConsent
    $kinds = @(foreach ($ev in (Read-Events)) { [string]$ev.kind + ':' + $ev.value })
    if (($kinds -join ',') -cne 'consent-pending:,consent-done:True' -or $script:Config.lightBurnSecret -cne 'fixture-granted' -or (Read-SavedConfig).lightBurnSecret -cne 'fixture-granted') { throw 'Granted LightBurn consent was not stored: ' + ($kinds -join ',') }
    $script:Config.lightBurnSecret = ''
    [IO.File]::Delete((Join-Path $state 'credentials.dpapi'))
    Write-Host 'PASS LightBurn permission is a non-blocking request, ignores duplicate clicks, stores only a granted secret and reports denial.'
    & (Join-Path $PSScriptRoot 'GUI.ps1') -SmokeTest -DataDirectory $state
    $lock = New-Object IO.FileStream((Join-Path $state 'instance.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $lock.Dispose()
    $owner = New-Object PathPlotterRap.Activation($key)
    try { if (-not $owner.Owner) { throw 'Desktop activation ownership was not released.' } }
    finally { $owner.Dispose() }
    Write-Host 'PASS instance lock and IPC released after GUI shutdown.'
} finally {
    # Delete flat fixture files explicitly: recursive .NET deletion can skip
    # Dropbox cloud-placeholder reparse files and report directory-not-empty.
    # Retry only transient Windows locks, with a hard deadline.
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([IO.Directory]::Exists($state)) {
        try {
            foreach ($file in [IO.Directory]::GetFiles($state)) { [IO.File]::Delete($file) }
            [IO.Directory]::Delete($state, $false)
        }
        catch {
            $cause = $_.Exception.GetBaseException()
            $code = $cause.HResult -band 0xffff
            if ($cause -isnot [IO.IOException] -or $code -notin @(32, 33, 145) -or [DateTime]::UtcNow -ge $cleanupDeadline) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
    # CodeDom's TempFileCollection.Delete can silently leave synced placeholders.
    # Remove only newly created compiler scratch, not pre-existing project files.
    foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Force -File) {
        if ($file.Name -notmatch $compilerScratchPattern -or $existingCompilerScratch.ContainsKey($file.Name)) { continue }
        $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([IO.File]::Exists($file.FullName)) {
            try { [IO.File]::Delete($file.FullName) }
            catch {
                $cause = $_.Exception.GetBaseException()
                $code = $cause.HResult -band 0xffff
                if ($cause -isnot [IO.IOException] -or $code -notin @(32, 33) -or [DateTime]::UtcNow -ge $cleanupDeadline) { throw }
                Start-Sleep -Milliseconds 100
            }
        }
    }
}
