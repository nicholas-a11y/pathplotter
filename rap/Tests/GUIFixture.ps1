# Safe worker fixture. Never uses network, actual user registration or LightBurn.
$script:ActiveImport = @{ fixture = $true }
Invoke-UiCommand @{ action = 'slow-http' }
if ($script:SlowHttp -or $null -eq $script:ActiveImport) { throw 'Worker changed transport or stopped an active import.' }
$script:SlowHttp = $true
Invoke-UiCommand @{ action = 'socket' }
if (-not $script:SlowHttp -or $null -eq $script:ActiveImport) { throw 'Worker restored sockets during an active import.' }
$script:SlowHttp = $false
$script:ActiveImport = $null
$script:FixtureConsentAttempts = 0
$script:FixtureClaimAttempts = 0
function Invoke-Http([string]$Url, [string]$Method, [string]$Token, $Body = $null, [hashtable]$Headers = @{}, [int]$TimeoutMs = 5000, [switch]$Raw) {
    if ($Url -ceq 'https://fixture.invalid/v1/register') { return @{ relayId = 'fixture-relay'; credential = 'fixture-only' } }
    if ($Url -ceq 'https://fixture.invalid/v1/enrollment/start') {
        if ((Read-Protected 'enrollment.dpapi').verifier -cne $Body.verifier) { throw 'Verifier was not persisted before start.' }
        return @{ requestId = 'fixture-enrollment'; phrase = 'AMBER RIVER'; expiresAt = 1800000600000.0 }
    }
    if ($Url -ceq 'https://fixture.invalid/v1/enrollment/fixture-enrollment/claim') {
        $script:FixtureClaimAttempts++
        if ($script:FixtureClaimAttempts -eq 1) { $script:FixtureFirstClaim = $script:Clock.ElapsedMilliseconds; return @{ status = 'pending' } }
        if ($script:Clock.ElapsedMilliseconds - $script:FixtureFirstClaim -lt 5000) { throw 'Enrollment polled too quickly.' }
        Send-Ui 'fixture' 'enrollment-confirmed'
        return @{ status = 'complete'; relayId = 'fixture-relay'; credential = 'fixture-only' }
    }
    if ($Url -ceq 'http://127.0.0.1:19520/api/connect') {
        $script:FixtureConsentAttempts++
        Start-Sleep -Milliseconds 1000
        if ($script:FixtureConsentAttempts -eq 1) { Send-Ui 'fixture' 'consent-denied'; return @{ status = 'denied' } }
        Send-Ui 'fixture' 'consent-granted'
        return @{ status = 'ok'; secret = 'fixture-only' }
    }
    throw 'Unexpected network call forbidden by GUI fixture.'
}
$script:FixturePairRejected = $false
function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
    $now = ([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalMilliseconds
    switch -CaseSensitive ($Path) {
        '/agent/start' { return @{ generation = 1; serverTime = $now } }
        '/agent/update' {
            if (-not $Body.connected) { Send-Ui 'fixture' 'disconnected' }
            $pending = @()
            if (-not $script:FixturePairRejected) { $pending = @(@{ id = 'fixture-pair'; phrase = 'AMBER RIVER' }) }
            return @{ serverTime = $now; job = $null; pairings = $pending; previewActive = $true }
        }
        '/agent/browser-launch' { return @{ launchToken = 'fixture-launch-never-display'; expiresAt = $now + 60000 } }
        '/pairing/new' { return @{ invitation = 'fixture-phone'; expiresAt = $now + 300000 } }
        '/agent/code/new' {
            if ($null -ne $script:ActiveImport) { throw 'Code window issued during an import.' }
            Send-Ui 'fixture' 'code-created'
            return @{ id = $Body.requestId; code = 'ABC'; expiresAt = $now + 60000; serverTime = $now; status = 'waiting' }
        }
        '/agent/code/cancel' {
            Send-Ui 'fixture' 'code-cancelled'
            return @{ id = $Body.requestId; status = 'cancelled' }
        }
        '/pairing/decide' {
            if ($Body.pairingId -cne 'fixture-pair') { throw 'Wrong pairing target.' }
            if ($Body.approve) { Send-Ui 'fixture' 'approve' }
            else { Send-Ui 'fixture' 'reject'; $script:FixturePairRejected = $true }
            return @{}
        }
        default { throw 'Unexpected cloud call forbidden by GUI fixture.' }
    }
}
function Get-Observation {
    # Slow work still runs outside the UI; the form timer continues processing.
    Start-Sleep -Milliseconds 200
    return @{ connected = $true; position = @{ x = 1; y = 2 }; context = @{ revision = 'fixture-context'; size = $null }; observationAgeMs = 200; tick = $script:Clock.ElapsedMilliseconds; error = $null }
}
function New-AgentSocket {
    $mock = New-Object PSObject -Property @{ IsOpen = $true; IsFinished = $false; Failure = ''; Queue = (New-Object 'Collections.Generic.Queue[string]') }
    $mock | Add-Member ScriptMethod Enqueue {
        param($text)
        $message = $text | ConvertFrom-Json
        $result = Invoke-Cloud '/agent/update' $message.body
        $this.Queue.Enqueue((@{ v = 2; type = 'update-result'; id = $message.id; body = $result } | ConvertTo-Json -Depth 25 -Compress))
    }
    $mock | Add-Member ScriptMethod Take { if ($this.Queue.Count) { return $this.Queue.Dequeue() }; return $null }
    $mock | Add-Member ScriptMethod Dispose { $this.IsOpen = $false; Send-Ui 'fixture' 'disconnected' }
    return $mock
}
