# Safe worker fixture. Never uses network, actual user registration or LightBurn.
$script:FixtureConsentAttempts = 0
function Invoke-Http([string]$Url, [string]$Method, [string]$Token, $Body = $null, [hashtable]$Headers = @{}, [int]$TimeoutMs = 5000, [switch]$Raw) {
    if ($Url -ceq 'https://fixture.invalid/v1/register') { return @{ relayId = 'fixture-relay'; credential = 'fixture-only' } }
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
            return @{ serverTime = $now; job = $null; pairings = $pending }
        }
        '/agent/browser-launch' { return @{ launchToken = 'fixture-launch-never-display'; expiresAt = $now + 60000 } }
        '/pairing/new' { return @{ invitation = 'fixture-phone'; expiresAt = $now + 300000 } }
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
