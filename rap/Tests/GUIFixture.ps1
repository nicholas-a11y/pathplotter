# Safe worker fixture. Never uses network, actual user registration, GitHub or LightBurn.
$script:FixtureConsentAttempts = 0
function Invoke-Http([string]$Url, [string]$Method, [string]$Token, $Body = $null, [hashtable]$Headers = @{}, [int]$TimeoutMs = 5000, [switch]$Raw) {
    if ($Url -ceq 'https://fixture.invalid/v1/register') {
        if ($Body.invitation -cne 'fixture-invitation-id' -or $Body.name -cne 'Fixture PC' -or $Body.Count -ne 2) { throw 'Registration body is wrong.' }
        Send-Ui 'fixture' 'registered'
        return @{ relayId = 'fixture-relay'; credential = 'fixture-only' }
    }
    throw 'Unexpected network call forbidden by GUI fixture.'
}
# The real consent request is non-blocking; the fixture completes it after one second.
function Start-LightBurnConnect {
    $script:FixtureConsentAttempts++
    return @{ readyAt = $script:Clock.ElapsedMilliseconds + 1000; attempt = $script:FixtureConsentAttempts }
}
function Test-LightBurnConnectReady($Job) { return $script:Clock.ElapsedMilliseconds -ge $Job.readyAt }
function Complete-LightBurnConnect($Job) {
    if ($Job.attempt -eq 1) { Send-Ui 'fixture' 'consent-denied'; return @{ status = 'denied' } }
    Send-Ui 'fixture' 'consent-granted'
    return @{ status = 'ok'; secret = 'fixture-only' }
}
$script:FixturePairRejected = $false
function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
    $now = ([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalMilliseconds
    switch -CaseSensitive ($Path) {
        '/agent/start' {
            if ($Body.version -cne $script:RapVersion) { throw 'Start did not report the RAP version.' }
            return @{ generation = 1; serverTime = $now }
        }
        '/agent/update' {
            if (-not $Body.connected) { Send-Ui 'fixture' 'disconnected' }
            $pending = @()
            if (-not $script:FixturePairRejected) { $pending = @(@{ id = 'fixture-pair'; phrase = 'AMBER RIVER' }) }
            return @{ serverTime = $now; job = $null; pairings = $pending; previewActive = $true }
        }
        '/agent/browser-launch' { return @{ launchToken = 'fixture-launch-never-display'; expiresAt = $now + 60000 } }
        '/agent/browsers' { return @{ browsers = @() } }
        '/agent/pairing/new' { return @{ invitation = 'fixture-phone'; expiresAt = $now + 300000 } }
        '/agent/pairing/decide' {
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
function Get-RapLatestRelease { return @{ version = '9.9.9'; tag = 'rap-v9.9.9'; zipUrl = 'https://github.com/fixture'; hashUrl = 'https://github.com/fixture.sha256' } }
function Install-RapUpdate($Release) {
    if ($Release.version -cne '9.9.9') { throw 'Wrong release installed.' }
    Send-Ui 'fixture' 'installed'
}
function Start-RapRelaunch($Directory) { Send-Ui 'fixture' 'relaunch' }
