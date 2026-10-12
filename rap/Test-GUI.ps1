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
    function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
        $script:WireCalls.Add(@{ path = $Path; body = $Body; method = $Method })
        switch ($Path) {
            '/agent/browser-launch' {
                $expiry = (Get-ServerNow) + 60000
                if ($script:ExpiredLaunch) { $expiry = 1 }
                return @{ launchToken = 'fixture-private-launch'; expiresAt = $expiry }
            }
            '/pairing/new' { return @{ invitation = 'fixture-phone'; expiresAt = (Get-ServerNow) + 60000 } }
            '/pairing/decide' { return @{} }
            '/agent/code/new' { return @{ id = $Body.requestId; code = 'ABC'; expiresAt = (Get-ServerNow) + 60000; serverTime = Get-ServerNow; status = 'waiting' } }
            '/agent/code/cancel' { return @{ id = $Body.requestId; status = 'cancelled' } }
            default { throw 'Unexpected network call forbidden in GUI protocol checks.' }
        }
    }
    Publish-RapHealth 'not verified' $false
    if ($script:WireCalls.Count -ne 0) { throw 'Auto-open before verified healthy startup.' }
    Publish-RapHealth 'verified' $true
    Publish-RapHealth 'disconnected' $false
    Publish-RapHealth 'reconnected' $true
    Publish-RapHealth 'verified' $true
    if ($script:WireCalls.Count -ne 1 -or $script:WireCalls[0].path -cne '/agent/browser-launch' -or $script:WireCalls[0].body.Count -ne 0) { throw 'Desktop launch is not once-only or uses the wrong endpoint/body.' }
    Invoke-UiCommand @{ action = 'open' }
    if ($script:WireCalls.Count -ne 2 -or $script:WireCalls[1].path -cne '/agent/browser-launch') { throw 'Explicit open did not create a fresh launch.' }
    $script:ExpiredLaunch = $true
    $rejected = $false
    try { Invoke-UiCommand @{ action = 'open' } } catch { $rejected = $true }
    if (-not $rejected) { throw 'Expired desktop launch accepted.' }
    $script:ExpiredLaunch = $false
    Invoke-UiCommand @{ action = 'phone' }
    if ($script:WireCalls[3].path -cne '/pairing/new') { throw 'Phone incorrectly used desktop authorization.' }
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
    if ($script:WireCalls[$before].body.pairingId -cne 'fixture-request' -or $script:WireCalls[$before].body.approve -ne $true) { throw 'GUI approval targeted the wrong request.' }
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
    $script:Healthy = $false
    $before = $script:WireCalls.Count
    $rejected = $false
    try { Invoke-UiCommand @{ action = 'code-new' } } catch { $rejected = $true }
    if (-not $rejected -or $script:WireCalls.Count -ne $before) { throw 'Code pairing reached cloud while unhealthy.' }
    $script:Healthy = $true; $script:ActiveImport = @{ fixture = $true }
    $rejected = $false
    try { Invoke-UiCommand @{ action = 'code-new' } } catch { $rejected = $true }
    if (-not $rejected -or $script:WireCalls.Count -ne $before) { throw 'Code pairing reached cloud during import.' }
    $script:ActiveImport = $null
    Invoke-UiCommand @{ action = 'code-new' }
    $id = $script:CodeRequest.id
    Invoke-UiCommand @{ action = 'code-new' }
    if ($script:WireCalls[$before].body.requestId -cne $id -or $script:WireCalls[$before + 1].body.requestId -cne $id) { throw 'Explicit issuance recovery minted a different window.' }
    Invoke-UiCommand @{ action = 'code-cancel' }
    if ($null -ne $script:CodeRequest -or $script:WireCalls[$before + 2].body.requestId -cne $id) { throw 'Code cancellation lost the window identity.' }
    Write-Host 'PASS code pairing protocol: healthy/import guards, private idempotent issuance and explicit Cancel.'
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
