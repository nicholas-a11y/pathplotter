#requires -Version 5.1
param($Bridge, [string]$DataDirectory, [switch]$Fixture, [switch]$LibraryOnly)
$onlyWorkerFunctions = [bool]$LibraryOnly
. (Join-Path $PSScriptRoot 'RAP.ps1') -LibraryOnly -DataDirectory $DataDirectory
$script:UiBridge = $Bridge
$script:Healthy = $false
$script:AutoOpened = $false
$script:CodeRequest = $null
$script:HostedApp = 'https://nicholas-a11y.github.io/pathplotter/'

function Send-Ui([string]$Kind, $Value = $null) {
    $Bridge.Events.Enqueue(@{ kind = $Kind; value = $Value })
}

function Wait-Ui([string]$Action) {
    while (-not $Bridge.StopRequested) {
        $command = $null
        if ($Bridge.Commands.TryDequeue([ref]$command)) {
            if ($command.action -ceq $Action) { return $command }
            if ($command.action -ceq 'discard-enrollment' -and $Action -ceq 'register') {
                [IO.File]::Delete((Join-Path $script:DataDirectory 'enrollment.dpapi'))
                Send-Ui 'setup'
            }
        }
        Start-Sleep -Milliseconds 50
    }
    throw 'Setup cancelled.'
}

function Initialize-Config {
    try {
        $script:Config = Read-Protected 'credentials.dpapi'
        if ($null -ne $script:Config) {
            $script:Config.apiRoot = Assert-CloudRoot $script:Config.apiRoot
            if ((Get-Field $script:Config 'relayId') -isnot [string] -or [string]::IsNullOrEmpty($script:Config.relayId) -or
                (Get-Field $script:Config 'credential') -isnot [string] -or [string]::IsNullOrEmpty($script:Config.credential) -or
                (Get-Field $script:Config 'lightBurnSecret') -isnot [string]) { throw 'Local relay credentials are incomplete.' }
        }
    } catch {
        Send-Ui 'recovery'
        $null = Wait-Ui 'reset-registration'
        [IO.File]::Delete((Join-Path $script:DataDirectory 'credentials.dpapi'))
        $script:Config = $null
    }
    while ($null -eq $script:Config -and -not $Bridge.StopRequested) {
        $savedEnrollment = $null
        try { $savedEnrollment = Read-Protected 'enrollment.dpapi' }
        catch { Send-Ui 'notice' 'Pending enrollment is unreadable. Explicitly discard expired setup below, or restore its protected file to recover an ambiguous registration.' }
        Send-Ui 'setup' $savedEnrollment
        $command = Wait-Ui 'register'
        try {
            $api = Assert-CloudRoot $command.api
            $name = $command.name
            if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -gt 80 -or $name -match '[\x00-\x1f]') { throw 'Invalid computer name.' }
            if ([string]::IsNullOrWhiteSpace($command.invitation)) {
                $pending = Start-Enrollment $api $name
                Send-Ui 'enrollment' @{ phrase = $pending.phrase; url = (Get-EnrollmentUrl $pending) }
                $confirmation = Wait-Ui 'confirm-enrollment'
                if ($confirmation.phrase -cne $pending.phrase) { throw 'Enrollment phrase mismatch.' }
                $deadline = $script:Clock.ElapsedMilliseconds + 600000
                $nextClaim = 0L
                while (-not $Bridge.StopRequested -and $script:Clock.ElapsedMilliseconds -lt $deadline) {
                    if ($script:Clock.ElapsedMilliseconds -ge $nextClaim) {
                        $nextClaim = $script:Clock.ElapsedMilliseconds + 5000
                        if (Complete-Enrollment $pending) { break }
                    }
                    if ($Bridge.StopRequested) { throw 'Setup cancelled.' }
                    Start-Sleep -Milliseconds 50
                }
                if ($null -eq $script:Config) { throw 'Enrollment cancelled or expired; protected verifier retained for explicit resume.' }
            } else {
                $result = Invoke-Http ($api + '/v1/register') 'POST' '' @{ bootstrapToken = $command.invitation; name = $name }
                if ((Get-Field $result 'relayId') -isnot [string] -or [string]::IsNullOrEmpty($result.relayId) -or
                    (Get-Field $result 'credential') -isnot [string] -or [string]::IsNullOrEmpty($result.credential)) { throw 'Invalid registration response.' }
                $script:Config = @{ apiRoot = $api; relayId = $result.relayId; credential = $result.credential; lightBurnSecret = '' }
                Write-Protected 'credentials.dpapi' $script:Config
            }
        } catch {
            Send-Ui 'notice' 'Setup failed or expired. Retry explicitly to resume the protected enrollment with the same relay and name. Check service availability or use an operator invitation. A consumed invitation may need replacement.'
        } finally { $command.invitation = $null }
    }
    while ([string]::IsNullOrEmpty($script:Config.lightBurnSecret)) {
        Send-Ui 'consent'
        $null = Wait-Ui 'consent'
        try {
            $pair = Invoke-Http ($script:LightBurnRoot + '/api/connect') 'POST' '' @{ application_name = 'PathPlotter RAP'; capabilities = @('state', 'project', 'upload') } -TimeoutMs 35000
            if ((Get-Field $pair 'status') -cne 'ok' -or (Get-Field $pair 'secret') -isnot [string] -or [string]::IsNullOrEmpty($pair.secret)) { throw 'LightBurn consent denied.' }
            $script:Config.lightBurnSecret = $pair.secret
            Write-Protected 'credentials.dpapi' $script:Config
        } catch { Send-Ui 'notice' 'LightBurn did not grant access. Enable its local REST API, keep network API access disabled, bring LightBurn forward and approve its dialog within 30 seconds. Retry only with consent.' }
    }
    Send-Ui 'configured'
}

function Get-DesktopLaunchUrl {
    if (-not $script:Healthy) { throw 'Wait for a healthy connection.' }
    $launch = Invoke-Cloud '/agent/browser-launch' @{}
    $token = Get-Field $launch 'launchToken'
    if ($token -isnot [string] -or [string]::IsNullOrWhiteSpace($token) -or $token.Length -gt 2048 -or
        (Convert-Time (Get-Field $launch 'expiresAt')) -le (Get-ServerNow)) { throw 'Invalid or expired desktop launch.' }
    return $script:HostedApp + '#relay=' + [Uri]::EscapeDataString($script:Config.apiRoot) +
        '&relayId=' + [Uri]::EscapeDataString($script:Config.relayId) + '&launch=' + [Uri]::EscapeDataString($token)
}

function Publish-RapHealth([string]$Message, [bool]$Connected) {
    $script:Healthy = $Connected
    Send-Ui 'health' @{ message = $Message; connected = $Connected; importing = ($null -ne $script:ActiveImport); slowHttp = [bool]$script:SlowHttp }
    if (-not $Connected -and $null -ne $script:CodeRequest) {
        try { Stop-CodePairing }
        catch { Send-Ui 'notice' 'Code cancellation could not be confirmed while disconnected. The server window still expires after 60 seconds; check Connected browsers for any completed pairing.' }
    }
    if ($Connected -and -not $script:AutoOpened -and -not $Bridge.StopRequested) {
        # One attempt per normal launch, never on a reconnect or ordinary invitation.
        $script:AutoOpened = $true
        try { Send-Ui 'desktop' (Get-DesktopLaunchUrl) }
        catch { Send-Ui 'notice' 'Desktop authorization could not be created. Check the updated relay is deployed, then use Open PathPlotter to retry explicitly.' }
    }
}

function Show-PendingPairings($Pairings) {
    $next = @{}
    foreach ($pair in @($Pairings)) {
        if ($null -eq $pair) { continue }
        $id = Get-Field $pair 'id'; $phrase = Get-Field $pair 'phrase'
        if ($id -isnot [string] -or $id -notmatch '^[A-Za-z0-9_-]{1,128}$' -or
            $phrase -isnot [string] -or $phrase -notmatch '^[A-Za-z0-9 -]{1,120}$') { throw 'Invalid browser approval request.' }
        $next[$id] = $phrase
    }
    $script:PendingPairings = $next
    Send-Ui 'pairings' ([hashtable]$next.Clone())
}

function Show-CodePairing($State) {
    if ($null -eq $State -or $null -eq $script:CodeRequest -or (Get-Field $State 'id') -cne $script:CodeRequest.id) { return }
    $status = Get-Field $State 'status'
    if ($status -cnotmatch '^(waiting|claimed|complete|cancelled|expired|failed)$') { throw 'Invalid code pairing state.' }
    Send-Ui 'code-status' @{ id = $script:CodeRequest.id; status = $status }
    if ($status -cne 'waiting') {
        $script:CodeRequest = $null
        if ($status -ceq 'claimed') { Send-Ui 'notice' 'A browser requested code pairing. Compare its phrase with the approval request and approve only your browser.' }
        if ($status -ceq 'complete') { Send-Ui 'notice' 'A browser paired using the code and retains access until revoked. Check Connected browsers to revoke unwanted access.' }
    }
}

function Stop-CodePairing {
    if ($null -eq $script:CodeRequest) { return }
    $result = Invoke-Cloud '/agent/code/cancel' @{ requestId = $script:CodeRequest.id }
    Show-CodePairing $result
}

function Invoke-UiCommand($Command) {
    switch -CaseSensitive ($Command.action) {
        'code-new' {
            if (-not $script:Healthy -or $null -ne $script:ActiveImport -or $Bridge.StopRequested) { throw 'Wait for a healthy, idle RAP before code pairing.' }
            if ($null -eq $script:CodeRequest -or $script:CodeRequest.deadline -le $script:Clock.ElapsedMilliseconds) {
                $script:CodeRequest = @{ id = [Guid]::NewGuid().ToString(); deadline = $script:Clock.ElapsedMilliseconds + 60000 }
            }
            Send-Ui 'code-window' @{ id = $script:CodeRequest.id; code = ''; remainingMs = [Math]::Max(0, $script:CodeRequest.deadline - $script:Clock.ElapsedMilliseconds) }
            try {
                $requestTick = $script:Clock.ElapsedMilliseconds
                $result = Invoke-Cloud '/agent/code/new' @{ requestId = $script:CodeRequest.id }
                $code = Get-Field $result 'code'
                $remaining = (Convert-Time (Get-Field $result 'expiresAt')) - (Convert-Time (Get-Field $result 'serverTime')) -
                    ($script:Clock.ElapsedMilliseconds - $requestTick)
                if ($code -isnot [string] -or $code -cnotmatch '^[A-Z]{3}$' -or $remaining -gt 60000) { throw 'Invalid code window.' }
                Send-Ui 'code-window' @{ id = $script:CodeRequest.id; code = $code; remainingMs = [Math]::Max(0, $remaining) }
                $script:CodeRequest.deadline = $script:Clock.ElapsedMilliseconds + [Math]::Max(0, $remaining)
                Show-CodePairing $result
            } catch { Send-Ui 'notice' 'Code pairing unavailable, busy or interrupted. Check that the operator enabled it. Retry Allow code pairing to recover the same window, or Cancel; no new window is created automatically.' }
        }
        'code-cancel' { Stop-CodePairing }
        'slow-http' {
            if ($null -ne $script:ActiveImport) { Send-Ui 'notice' 'Wait for the current import outcome before changing connection settings. Connection mode was not changed.'; return }
            Set-RapTransport $true
            Send-Ui 'transport' $true
            Send-Ui 'notice' 'HTTP compatibility mode selected. Responses may take several seconds; select the same mode in PathPlotter. No automatic import retries.'
        }
        'socket' {
            if ($null -ne $script:ActiveImport) { Send-Ui 'notice' 'Wait for the current import outcome before changing connection settings. Connection mode was not changed.'; return }
            Set-RapTransport $false
            Send-Ui 'transport' $false
            Send-Ui 'notice' 'WebSockets selected. Reconnecting; select WebSockets in PathPlotter too. HTTP fallback is never automatic.'
        }
        'open' { Send-Ui 'desktop' (Get-DesktopLaunchUrl) }
        'phone' {
            if (-not $script:Healthy) { throw 'Wait for a healthy connection.' }
            $pair = Invoke-Cloud '/pairing/new'
            $token = Get-Field $pair 'invitation'
            $expiry = Convert-Time (Get-Field $pair 'expiresAt')
            if ($token -isnot [string] -or [string]::IsNullOrWhiteSpace($token) -or $token.Length -gt 2048 -or $expiry -le (Get-ServerNow)) { throw 'Invalid phone invitation.' }
            $url = $script:HostedApp + '#relay=' + [Uri]::EscapeDataString($script:Config.apiRoot) +
                '&relayId=' + [Uri]::EscapeDataString($script:Config.relayId) + '&invite=' + [Uri]::EscapeDataString($token)
            Send-Ui 'phone' @{ url = $url; remainingMs = [Math]::Min(300000, $expiry - (Get-ServerNow)) }
        }
        'decide' {
            if ($Command.approve -isnot [bool] -or -not $script:PendingPairings.ContainsKey($Command.id) -or
                $script:PendingPairings[$Command.id] -cne $Command.phrase) { throw 'Request expired or phrase changed.' }
            $null = Invoke-Cloud '/pairing/decide' @{ pairingId = $Command.id; approve = $Command.approve }
            $script:PendingPairings.Remove($Command.id)
            Send-Ui 'pairings' ([hashtable]$script:PendingPairings.Clone())
        }
        'browsers' {
            $result = Invoke-Cloud '/browsers' -Body $null -Method 'GET'
            $browsers = Get-Field $result 'browsers'
            if ($browsers -isnot [array]) { throw 'Invalid browser list.' }
            $rows = @()
            foreach ($browser in $browsers) {
                $id = Get-Field $browser 'id'
                if ($id -isnot [string] -or $id -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Invalid browser.' }
                $label = Get-Field $browser 'label'
                if ($label -isnot [string] -or [string]::IsNullOrWhiteSpace($label)) { $label = Get-Field $browser 'name' }
                if ($label -isnot [string] -or [string]::IsNullOrWhiteSpace($label)) { $label = 'Approved browser ' + ($rows.Count + 1) }
                $rows += @{ id = $id; label = $label.Substring(0, [Math]::Min(80, $label.Length)) }
            }
            Send-Ui 'browsers' $rows
        }
        'revoke' {
            if ($Command.id -isnot [string] -or $Command.id -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Invalid browser.' }
            $null = Invoke-Cloud '/browsers/revoke' @{ browserId = $Command.id }
            Send-Ui 'notice' 'Browser access revoked. Refresh Connected browsers.'
        }
        'forget-lightburn' {
            $script:Config.lightBurnSecret = ''
            Write-Protected 'credentials.dpapi' $script:Config
            Send-Ui 'notice' 'Local LightBurn permission forgotten. Also revoke PathPlotter RAP in LightBurn Manage API Security. Quit and restart to request permission again.'
            $script:StopRequested = $true
        }
        'forget-relay' {
            [IO.File]::Delete((Join-Path $script:DataDirectory 'credentials.dpapi'))
            Send-Ui 'notice' 'Local credentials removed; import journal preserved. Ask the operator to revoke the old relay credential and revoke the LightBurn permission. Quit and restart to register.'
            $script:StopRequested = $true
        }
        default { throw 'Unsupported GUI action.' }
    }
}

function Read-ConsoleCommand {
    if ($Bridge.StopRequested) { $script:StopRequested = $true; return }
    # One action per cycle; protocol/import processing cannot be starved by clicks.
    $command = $null
    if ($Bridge.Commands.TryDequeue([ref]$command)) {
        try { Invoke-UiCommand $command }
        catch { Send-Ui 'notice' 'Action failed or request expired. Check connection/permissions and refresh before an explicit retry; no automatic approval, revocation or enrollment retry.' }
        finally { Send-Ui 'action-complete' }
    }
}

if ($Fixture) { . (Join-Path $PSScriptRoot 'Tests\GUIFixture.ps1') }
if ($onlyWorkerFunctions) { return }
try { Start-Rap }
catch { Send-Ui 'fatal' 'RAP could not start. Check registration, local permissions, protected state and the instance lock. Do not delete the import journal to retry imports.' }
finally {
    try { Stop-CodePairing }
    catch { Send-Ui 'notice' 'Code cancellation was not confirmed on shutdown. Server expiry remains in effect; completed browser access must be revoked separately.' }
    Send-Ui 'stopped'
}
