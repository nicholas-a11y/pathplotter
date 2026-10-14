#requires -Version 5.1
# Background worker for GUI.ps1. -LibraryOnly loads the functions for tests.
param($Bridge, [string]$DataDirectory, [switch]$Fixture, [switch]$LibraryOnly)
$onlyWorkerFunctions = [bool]$LibraryOnly
. (Join-Path $PSScriptRoot 'RAP.ps1') -DataDirectory $DataDirectory
. (Join-Path $PSScriptRoot 'Updater.ps1')
$script:UiBridge = $Bridge
$script:CloudReady = $false
$script:ConsentJob = $null
$script:AutoOpened = $false
$script:HostedApp = 'https://nicholas-a11y.github.io/pathplotter/'
$script:LatestRelease = $null
$script:NextUpdateCheck = 0L
$script:AnnouncedUpdateRequired = $false
$script:NextBrowserCheck = 0L
$script:UpToDate = $false

function Send-Ui([string]$Kind, $Value = $null) {
    $Bridge.Events.Enqueue(@{ kind = $Kind; value = $Value })
}

function Wait-Ui([string]$Action) {
    while (-not $Bridge.StopRequested) {
        $command = $null
        if ($Bridge.Commands.TryDequeue([ref]$command)) {
            if ($command.action -ceq $Action) { return $command }
        }
        Start-Sleep -Milliseconds 50
    }
    throw 'Setup cancelled.'
}

function Initialize-Config {
    try { $script:Config = Read-SavedConfig }
    catch {
        Send-Ui 'recovery'
        $null = Wait-Ui 'reset-registration'
        [IO.File]::Delete((Join-Path $script:DataDirectory 'credentials.dpapi'))
        $script:Config = $null
    }
    while ($null -eq $script:Config -and -not $Bridge.StopRequested) {
        Send-Ui 'setup'
        $command = Wait-Ui 'register'
        try {
            $api = Assert-CloudRoot $command.api
            $name = $command.name
            if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -gt 64 -or $name -match '[\x00-\x1f]') { throw 'Invalid computer name.' }
            $invitation = [string]$command.invitation
            if ($invitation.Length -lt 16 -or $invitation.Length -gt 256) { throw 'Invalid Invitation ID.' }
            $result = Invoke-Http ($api + '/v1/register') 'POST' '' @{ invitation = $invitation; name = $name }
            if ((Get-Field $result 'relayId') -isnot [string] -or [string]::IsNullOrEmpty($result.relayId) -or
                (Get-Field $result 'credential') -isnot [string] -or [string]::IsNullOrEmpty($result.credential)) { throw 'Invalid registration response.' }
            $script:Config = @{ apiRoot = $api; relayId = $result.relayId; credential = $result.credential; lightBurnSecret = '' }
            Write-Protected 'credentials.dpapi' $script:Config
        } catch {
            Send-Ui 'notice' 'Registration failed. Check the Invitation ID (it may be used up, revoked or expired) and your internet connection, then try again.'
        } finally { $command.invitation = $null; $invitation = $null }
    }
    # LightBurn permission is optional here: the relay session (and browser pairing)
    # starts without it, and the user grants it later with the Request permission button.
    if ([string]::IsNullOrEmpty($script:Config.lightBurnSecret)) { Send-Ui 'consent' }
    Send-Ui 'configured'
}

# Seams for the non-blocking LightBurn consent request (replaced by the GUI test fixture).
function Start-LightBurnConnect {
    $request = [Net.HttpWebRequest]::Create($script:LightBurnRoot + '/api/connect')
    $request.Method = 'POST'
    $request.AllowAutoRedirect = $false
    $request.Proxy = $null
    $request.Timeout = 35000
    $request.ReadWriteTimeout = 35000
    $request.ContentType = 'application/json'
    $bytes = $script:Utf8.GetBytes((@{ application_name = 'PathPlotter RAP'; capabilities = @('state', 'project', 'upload') } | ConvertTo-Json -Compress))
    $request.ContentLength = $bytes.Length
    $deadline = New-Object PathPlotterRap.RequestDeadline($request, 35000)
    try {
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        return @{ request = $request; deadline = $deadline; result = $request.BeginGetResponse($null, $null) }
    } catch { $deadline.Dispose(); throw }
}

function Test-LightBurnConnectReady($Job) { return $Job.result.IsCompleted }

function Complete-LightBurnConnect($Job) {
    $response = $null
    try {
        $response = [Net.HttpWebResponse]$Job.request.EndGetResponse($Job.result)
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300 -or $response.ContentType -notmatch '^application/json(?:;|$)') { throw 'LightBurn consent denied.' }
        $input = $response.GetResponseStream()
        $buffer = New-Object byte[] 4096
        $output = New-Object IO.MemoryStream
        try {
            while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if ($output.Length + $count -gt 65536) { throw 'LightBurn response exceeded its bound.' }
                $output.Write($buffer, 0, $count)
            }
            return ($script:Utf8.GetString($output.ToArray()) | ConvertFrom-Json)
        } finally { $input.Dispose(); $output.Dispose() }
    } finally {
        if ($null -ne $response) { $response.Close() }
        $Job.deadline.Dispose()
    }
}

function Stop-LightBurnConnect {
    $job = $script:ConsentJob
    $script:ConsentJob = $null
    if ($null -ne $job -and $job.ContainsKey('request')) {
        try { $job.request.Abort() } catch { }
        try { $job.deadline.Dispose() } catch { }
    }
}

function Start-LightBurnConsent {
    if ($null -ne $script:ConsentJob) { return }
    try {
        $script:ConsentJob = Start-LightBurnConnect
        Send-Ui 'consent-pending'
    } catch {
        $script:ConsentJob = $null
        Send-Ui 'consent-done' $false
        Send-Ui 'notice' 'LightBurn did not respond. Open LightBurn, keep network API access disabled, bring LightBurn to the foreground so the permission prompt appears, then try again.'
    }
}

function Update-LightBurnConsent {
    $job = $script:ConsentJob
    if ($null -eq $job -or -not (Test-LightBurnConnectReady $job)) { return }
    $script:ConsentJob = $null
    $granted = $false
    try {
        $pair = Complete-LightBurnConnect $job
        if ((Get-Field $pair 'status') -cne 'ok' -or (Get-Field $pair 'secret') -isnot [string] -or [string]::IsNullOrEmpty($pair.secret)) { throw 'LightBurn consent denied.' }
        $script:Config.lightBurnSecret = $pair.secret
        Write-Protected 'credentials.dpapi' $script:Config
        $granted = $true
    } catch {
        Send-Ui 'notice' 'LightBurn did not grant access. Keep network API access disabled, bring LightBurn to the foreground so its permission prompt appears, and approve it within 30 seconds. Retry only with consent.'
    }
    $pair = $null
    Send-Ui 'consent-done' $granted
    if ($granted) { $script:ForcePublish = $true }
}

function Get-DesktopLaunchUrl($ReplacementIds = $null) {
    if (-not $script:CloudReady) { throw 'Wait for the relay connection.' }
    $body = @{}
    if ($null -ne $ReplacementIds) { $body.replaceBrowserIds = @($ReplacementIds) }
    $launch = Invoke-Cloud '/agent/browser-launch' $body
    $token = Get-Field $launch 'launchToken'
    if ($token -isnot [string] -or [string]::IsNullOrWhiteSpace($token) -or $token.Length -gt 2048 -or
        (Convert-Time (Get-Field $launch 'expiresAt')) -le (Get-ServerNow)) { throw 'Invalid or expired desktop launch.' }
    return $script:HostedApp + '#relay=' + [Uri]::EscapeDataString($script:Config.apiRoot) +
        '&relayId=' + [Uri]::EscapeDataString($script:Config.relayId) + '&launch=' + [Uri]::EscapeDataString($token)
}

function Get-PairedBrowsers {
    $result = Invoke-Cloud '/agent/browsers' -Body $null -Method 'GET'
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
    return ,$rows
}

# Only one browser is paired at a time; the window shows it with a Disconnect button.
function Send-BrowserState {
    $rows = Get-PairedBrowsers
    Send-Ui 'browser' $(if ($rows.Count -gt 0) { $rows[0] } else { $null })
}

function Publish-RapHealth([string]$Message, [bool]$Connected, [bool]$CloudReady = $Connected) {
    if ($CloudReady -and -not $script:CloudReady) { $script:NextBrowserCheck = 0L }
    $script:CloudReady = $CloudReady
    Send-Ui 'health' @{ message = $Message; connected = $Connected; cloud = $CloudReady; importing = ($null -ne $script:ActiveImport) }
    if ($CloudReady -and -not $script:AutoOpened -and -not $Bridge.StopRequested) {
        # One attempt per normal launch, never on a reconnect or ordinary invitation.
        $script:AutoOpened = $true
        try {
            if ((Get-ApprovedBrowserIds).Count -eq 0) { Send-Ui 'desktop' (Get-DesktopLaunchUrl) }
        }
        catch { Send-Ui 'notice' 'Could not open PathPlotter automatically. Click Open PathPlotter to try again.' }
    }
}

function Publish-RapPairings($Pairings) { Send-Ui 'pairings' $Pairings }

function Send-RapVersion {
    $value = @{ current = $script:RapVersion; available = $false; required = [bool]$script:UpdateRequired; upToDate = [bool]$script:UpToDate }
    if ($null -ne $script:LatestRelease) { $value.available = $true; $value.latest = $script:LatestRelease.version }
    Send-Ui 'version' $value
}

function Update-RapReleaseInfo([switch]$Explicit) {
    $script:NextUpdateCheck = [long]::MaxValue
    try {
        $release = Get-RapLatestRelease
        $script:LatestRelease = $(if (Test-RapNewer $release.version $script:RapVersion) { $release } else { $null })
        $script:UpToDate = [bool]$Explicit -and $null -eq $script:LatestRelease
    } catch {
        if ($Explicit -or $script:UpdateRequired) { Send-Ui 'notice' 'Could not check GitHub for RAP updates. Check your internet connection and try again.' }
    }
    Send-RapVersion
}

function Invoke-UiCommand($Command) {
    switch -CaseSensitive ($Command.action) {
        'open' {
            $ids = Get-ApprovedBrowserIds
            if ($ids.Count) { Send-Ui 'confirm-switch' @{ action = 'open-replace'; replaceBrowserIds = $ids } }
            else { Send-Ui 'desktop' (Get-DesktopLaunchUrl) }
        }
        'open-replace' {
            if ($Command.replaceBrowserIds -isnot [array]) { throw 'Missing replacement confirmation.' }
            Send-Ui 'desktop' (Get-DesktopLaunchUrl $Command.replaceBrowserIds)
        }
        'phone' {
            if (-not $script:CloudReady) { throw 'Wait for the relay connection.' }
            $pair = Invoke-Cloud '/agent/pairing/new'
            $token = Get-Field $pair 'invitation'
            $expiry = Convert-Time (Get-Field $pair 'expiresAt')
            if ($token -isnot [string] -or [string]::IsNullOrWhiteSpace($token) -or $token.Length -gt 2048 -or $expiry -le (Get-ServerNow)) { throw 'Invalid phone invitation.' }
            $url = $script:HostedApp + '#relay=' + [Uri]::EscapeDataString($script:Config.apiRoot) +
                '&relayId=' + [Uri]::EscapeDataString($script:Config.relayId) + '&invite=' + [Uri]::EscapeDataString($token)
            Send-Ui 'phone' @{ url = $url; remainingMs = [Math]::Min(300000, $expiry - (Get-ServerNow)) }
        }
        { $_ -in @('decide', 'decide-replace') } {
            if ($Command.approve -isnot [bool] -or -not $script:PendingPairings.ContainsKey($Command.id) -or
                $script:PendingPairings[$Command.id] -cne $Command.phrase) { throw 'Request expired or phrase changed.' }
            $body = @{ pairingId = $Command.id; approve = $Command.approve }
            if ($Command.approve) {
                if ($Command.action -ceq 'decide-replace') {
                    if ($Command.replaceBrowserIds -isnot [array]) { throw 'Missing replacement confirmation.' }
                    $body.replaceBrowserIds = @($Command.replaceBrowserIds)
                } else {
                    $ids = Get-ApprovedBrowserIds
                    if ($ids.Count) {
                        Send-Ui 'confirm-switch' @{ action = 'decide-replace'; id = $Command.id; phrase = $Command.phrase; approve = $true; replaceBrowserIds = $ids }
                        return
                    }
                }
            }
            $null = Invoke-Cloud '/agent/pairing/decide' $body
            $script:PendingPairings.Remove($Command.id)
            Send-Ui 'pairings' ([hashtable]$script:PendingPairings.Clone())
        }
        'revoke' {
            if ($Command.id -isnot [string] -or $Command.id -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Invalid browser.' }
            $null = Invoke-Cloud '/agent/browsers/revoke' @{ browserId = $Command.id }
        }
        'forget-lightburn' {
            $script:Config.lightBurnSecret = ''
            Write-Protected 'credentials.dpapi' $script:Config
            Send-Ui 'notice' 'Local LightBurn permission forgotten. Also revoke PathPlotter RAP in LightBurn Manage API Security. Quit and restart RAP, then click Request local LightBurn permission to grant it again.'
            $script:StopRequested = $true
        }
        'forget-relay' {
            [IO.File]::Delete((Join-Path $script:DataDirectory 'credentials.dpapi'))
            Send-Ui 'notice' 'Local credentials removed; import journal preserved. Ask the operator to revoke the old relay credential and revoke the LightBurn permission. Quit and restart to register.'
            $script:StopRequested = $true
        }
        'consent' { Start-LightBurnConsent }
        'check-update' { Update-RapReleaseInfo -Explicit }
        'update' {
            if ($null -ne $script:ActiveImport) { Send-Ui 'notice' 'Wait for the current import to finish, then click Update now again.'; return }
            if ($null -eq $script:LatestRelease) { Update-RapReleaseInfo -Explicit; return }
            Install-RapUpdate $script:LatestRelease
            Start-RapRelaunch $PSScriptRoot
            Send-Ui 'restarting'
            $script:StopRequested = $true
        }
        default { throw 'Unsupported GUI action.' }
    }
}

function Read-UiCommand {
    if ($Bridge.StopRequested) { $script:StopRequested = $true; return }
    # Check GitHub once at startup and when the relay reports this version is too old,
    # never periodically, so a slow GitHub response cannot stall a live session.
    if ($script:Clock.ElapsedMilliseconds -ge $script:NextUpdateCheck -or $script:UpdateRequired -ne $script:AnnouncedUpdateRequired) {
        $script:AnnouncedUpdateRequired = $script:UpdateRequired
        Update-RapReleaseInfo
    }
    Update-LightBurnConsent
    if ($script:CloudReady -and $script:Clock.ElapsedMilliseconds -ge $script:NextBrowserCheck) {
        $script:NextBrowserCheck = $script:Clock.ElapsedMilliseconds + 20000
        try { Send-BrowserState } catch { }
    }
    # One action per cycle; protocol/import processing cannot be starved by clicks.
    $command = $null
    if ($Bridge.Commands.TryDequeue([ref]$command)) {
        try { Invoke-UiCommand $command }
        catch {
            if ($command.action -ceq 'update') {
                Send-Ui 'notice' 'Update failed and RAP files were left unchanged. Check your internet connection and try again, or download the latest RAP zip from GitHub Releases.'
            } elseif ($command.action -cin @('open-replace', 'decide-replace')) {
                Send-Ui 'notice' 'Browser switch failed or expired. Finish pending imports or resolve unknown outcomes in the paired browser, check the connection, then refresh and confirm the switch again.'
            } else {
                Send-Ui 'notice' 'Action failed or request expired. Check connection/permissions and refresh before an explicit retry; no automatic approval or revocation retry.'
            }
        }
        finally {
            # Show the result of pairing changes at once; a browser takes a moment to finish opening.
            if ($command.action -cin @('decide', 'decide-replace', 'revoke')) { $script:NextBrowserCheck = 0L }
            elseif ($command.action -cin @('open', 'open-replace')) { $script:NextBrowserCheck = $script:Clock.ElapsedMilliseconds + 4000 }
            Send-Ui 'action-complete'
        }
    }
}

if ($Fixture) { . (Join-Path $PSScriptRoot 'Tests\GUIFixture.ps1') }
if ($onlyWorkerFunctions) { return }
Send-RapVersion
try { Start-Rap }
catch { Send-Ui 'fatal' 'RAP could not start. Check registration, local permissions, protected state and the instance lock. Do not delete the import journal to retry imports.' }
finally { Stop-LightBurnConnect; Send-Ui 'stopped' }
