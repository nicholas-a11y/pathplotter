#requires -Version 5.1
# Core RAP library. GUI.ps1 is the only entry point: GUIWorker.ps1 dot-sources
# this file and replaces the UI hooks (Initialize-Config, Publish-RapHealth,
# Publish-RapPairings and Read-UiCommand).
param([string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'PathPlotter\RAP'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
if (-not ('PathPlotterRap.EventStream' -as [type])) {
    $compiler = New-Object CodeDom.Compiler.CompilerParameters
    $compiler.GenerateInMemory = $true
    $compiler.TempFiles = New-Object CodeDom.Compiler.TempFileCollection([IO.Path]::GetTempPath(), $false)
    [void]$compiler.ReferencedAssemblies.Add('System.dll')
    [void]$compiler.ReferencedAssemblies.Add('System.Core.dll')
    Add-Type -Path (Join-Path $PSScriptRoot 'Transport.cs') -CompilerParameters $compiler
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$script:Utf8 = New-Object Text.UTF8Encoding($false, $true)
$script:Clock = [Diagnostics.Stopwatch]::StartNew()
$script:DataDirectory = $DataDirectory
$script:Config = $null
$script:Journal = @{}
$script:Generation = $null
$script:ServerTime = $null
$script:ServerTick = 0L
$script:ClockUncertainty = $null
$script:Sequence = 0L
$script:PendingPairings = @{}
$script:StopRequested = $false
$script:ActiveImport = $null
$script:LightBurnRoot = 'http://127.0.0.1:19520'
$script:UiBridge = $null
$script:Socket = $null
$script:StateStream = $null
$script:PreviewActive = $false
$script:LastObservationHealth = ''
$script:DefaultRelay = 'https://pathplotter-relay-v3.nicholas-leqeta.workers.dev'
$script:UpdateRequired = $false
$script:RapVersion = '0.0.0'
$versionFile = Join-Path $PSScriptRoot 'version.txt'
if ([IO.File]::Exists($versionFile)) {
    $versionText = [IO.File]::ReadAllText($versionFile).Trim()
    if ($versionText -match '^\d+\.\d+\.\d+$') { $script:RapVersion = $versionText }
}

function New-AgentSocket {
    $url = $script:Config.apiRoot -replace '^https:', 'wss:'
    return New-Object PathPlotterRap.AgentSocket(($url + '/v1/relays/' + [Uri]::EscapeDataString($script:Config.relayId) + '/agent/stream?generation=' + $script:Generation), $script:Config.credential)
}

function Send-AgentMessage([string]$Type, [string]$Id, $Body) {
    $script:Socket.Enqueue((@{ v = 2; type = $Type; id = $Id; body = $Body } | ConvertTo-Json -Depth 25 -Compress))
}

function Publish-ObservationHealth($Observation, $Body) {
    $health = [string]$Observation.error
    if ($Observation.connected) { $health = 'LightBurn workpiece/context verified; cloud connected.' }
    $fresh = $Body.connected -and ($Observation.observationAgeMs + $script:Clock.ElapsedMilliseconds - $Observation.tick -le 2000)
    # The relay acknowledged this update, so browsers can be paired even while LightBurn is not ready.
    Publish-RapHealth $health ([bool]$fresh) $true
    if ($health -cne $script:LastObservationHealth) { Write-Host $health; $script:LastObservationHealth = $health }
}

function Invoke-AgentWork($Result, [switch]$FreshRequest) {
    if (-not (Test-Field $Result 'job') -or (Get-Field $Result 'pairings') -isnot [array] -or
        (Get-Field $Result 'previewActive') -isnot [bool]) { throw 'Invalid cloud work envelope.' }
    if ($FreshRequest -or (-not $script:PreviewActive -and $Result.previewActive)) { $script:ForcePublish = $true }
    $script:PreviewActive = $Result.previewActive
    Show-PendingPairings $Result.pairings
    if ($null -ne $Result.job) { Invoke-Import $Result.job (Get-Observation) }
}

function New-FreshCapture {
    $observation = Get-Observation
    $script:Sequence++
    return New-ObservationUpdate $observation
}

function Receive-AgentMessages {
    for ($i = 0; $i -lt 32; $i++) {
        $text = $script:Socket.Take()
        if ($null -eq $text) { break }
        $message = $text | ConvertFrom-Json
        if ((Get-Field $message 'v') -ne 2) { throw 'Unsupported socket protocol.' }
        switch -CaseSensitive (Get-Field $message 'type') {
            'update-result' {
                $id = Get-Field $message 'id'
                if ($id -isnot [string] -or -not $script:OutstandingUpdates.ContainsKey($id)) { throw 'Uncorrelated update response.' }
                $pending = $script:OutstandingUpdates[$id]
                Set-ClockCalibration $message.body $pending.tick
                $script:OutstandingUpdates.Remove($id)
                Publish-ObservationHealth $pending.observation $pending.body
                Invoke-AgentWork $message.body
            }
            'work' { Invoke-AgentWork $message.body -FreshRequest }
            'capture' {
                $id = Get-Field $message 'id'
                $parsed = [Guid]::Empty
                if ($id -isnot [string] -or -not [Guid]::TryParse($id, [ref]$parsed) -or $script:CaptureIds.ContainsKey($id)) { throw 'Invalid or repeated capture request.' }
                if ($script:CaptureIds.Count -ge 64) { $script:CaptureIds.Clear() }
                $script:CaptureIds[$id] = $true
                Send-AgentMessage 'capture-result' $id (New-FreshCapture)
            }
            'error' { throw ('Cloud socket rejected request: ' + [string](Get-Field $message 'error')) }
            default { throw 'Unexpected agent socket envelope.' }
        }
    }
}

function Get-ObservationSignature($Observation) {
    return (@{ connected = $Observation.connected; position = $Observation.position; context = $Observation.context; error = $Observation.error } | ConvertTo-Json -Depth 20 -Compress)
}

function Get-PositionSignature($Observation) {
    if (-not $Observation.connected -or $null -eq $Observation.position) { return '' }
    return (@{ x = $Observation.position.x; y = $Observation.position.y } | ConvertTo-Json -Compress)
}

function Register-PreviewObservation($Observation) {
    if (-not $Observation.connected -or $null -eq $Observation.position) {
        $script:PositionConnected = $false
        $script:PositionInitialized = $false
        $script:PositionMotionActive = $false
        return
    }
    $positionSignature = Get-PositionSignature $Observation
    if (-not $script:PositionConnected -or -not $script:PositionInitialized) {
        $script:LastPositionSignature = $positionSignature
        $script:LastPositionChangeTick = $Observation.tick
        $script:PositionInitialized = $true
        $script:PositionMotionActive = $false
    } elseif ($positionSignature -cne $script:LastPositionSignature) {
        $script:LastPositionSignature = $positionSignature
        $script:LastPositionChangeTick = $Observation.tick
        $script:PositionMotionActive = $true
    }
    $script:PositionConnected = $true
}

function Get-PreviewMotion($Observation, [long]$NowTick = -1) {
    if ($NowTick -lt 0) { $NowTick = $script:Clock.ElapsedMilliseconds }
    $age = $Observation.observationAgeMs + ($NowTick - $Observation.tick)
    $live = $Observation.connected -and $age -le 2000
    $quietFor = $NowTick - $script:LastPositionChangeTick
    $moving = $live -and $script:PositionMotionActive -and $quietFor -lt 2000
    $settled = $live -and $script:PositionInitialized -and $quietFor -ge 2000
    if (-not $moving) { $script:PositionMotionActive = $false }
    return @{ live = [bool]$live; moving = [bool]$moving; settled = [bool]$settled }
}

# UI hooks; GUIWorker.ps1 replaces these.
function Publish-RapHealth([string]$Message, [bool]$Connected, [bool]$CloudReady = $Connected) { }
function Publish-RapPairings($Pairings) { }
function Read-UiCommand { }
function Initialize-Config {
    $script:Config = Read-SavedConfig
    if ($null -eq $script:Config) { throw 'RAP is not registered.' }
}

function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [Collections.IDictionary]) { return ,$Object[$Name] }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return ,$property.Value }
    return $null
}

function Test-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $false }
    if ($Object -is [Collections.IDictionary]) { return $Object.Contains($Name) }
    return $null -ne $Object.PSObject.Properties[$Name]
}

function Test-Number($Value) {
    return ($Value -is [double] -or $Value -is [single] -or $Value -is [decimal] -or
        $Value -is [int] -or $Value -is [long]) -and
        -not [double]::IsNaN([double]$Value) -and -not [double]::IsInfinity([double]$Value)
}

function Get-Hash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-LightBurnToken([string]$Secret, [long]$Minute = -1) {
    if ([string]::IsNullOrEmpty($Secret)) { throw 'Local LightBurn credentials are missing.' }
    if ($Minute -lt 0) { $Minute = [long][Math]::Floor(([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalSeconds / 60) }
    $hmac = New-Object Security.Cryptography.HMACSHA256
    try {
        $hmac.Key = $script:Utf8.GetBytes($Secret)
        return ([BitConverter]::ToString($hmac.ComputeHash($script:Utf8.GetBytes($Minute.ToString([Globalization.CultureInfo]::InvariantCulture))))).Replace('-', '').ToLowerInvariant()
    } finally { $hmac.Dispose() }
}

function Initialize-Storage {
    [void][IO.Directory]::CreateDirectory($script:DataDirectory)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, 'None', 'Allow')
    $acl.AddAccessRule($rule)
    [IO.Directory]::SetAccessControl($script:DataDirectory, $acl)
}

function Write-Protected([string]$Name, $Value) {
    $path = Join-Path $script:DataDirectory $Name
    $next = $path + '.' + [Guid]::NewGuid().ToString('N') + '.next'
    $plain = $script:Utf8.GetBytes(($Value | ConvertTo-Json -Depth 30 -Compress))
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        $file = New-Object IO.FileStream($next, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        try { $file.Write($encrypted, 0, $encrypted.Length); $file.Flush($true) } finally { $file.Dispose() }
        $commitDeadline = $script:Clock.ElapsedMilliseconds + 2000
        while ($true) {
            try {
                if ([IO.File]::Exists($path)) { [IO.File]::Replace($next, $path, [Management.Automation.Language.NullString]::Value) }
                else { [IO.File]::Move($next, $path) }
                break
            } catch {
                # Antivirus/indexers can hold a transient sharing lock. Retrying an
                # atomic local replacement is safe; uploads are never retried here.
                $code = $_.Exception.GetBaseException().HResult -band 0xffff
                if ($code -notin @(32, 33) -or $script:Clock.ElapsedMilliseconds -ge $commitDeadline) { throw }
                Start-Sleep -Milliseconds 20
            }
        }
    } finally {
        [Array]::Clear($plain, 0, $plain.Length)
        if ([IO.File]::Exists($next)) { [IO.File]::Delete($next) }
    }
}

function Read-Protected([string]$Name) {
    $path = Join-Path $script:DataDirectory $Name
    if (-not [IO.File]::Exists($path)) { return $null }
    try {
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        try {
            $json = $script:Utf8.GetString($bytes)
            if (-not $json.TrimStart().StartsWith('{', [StringComparison]::Ordinal)) { throw 'Invalid protected state.' }
            $value = $json | ConvertFrom-Json
            if ($value -isnot [pscustomobject]) { throw 'Invalid protected state.' }
            return $value
        }
        finally { [Array]::Clear($bytes, 0, $bytes.Length) }
    } catch { throw 'Protected local state is unreadable. Do not delete the journal to retry imports; reconcile it manually.' }
}

function Save-Journal { Write-Protected 'journal.dpapi' $script:Journal }

function Load-Journal {
    $saved = Read-Protected 'journal.dpapi'
    $script:Journal = @{}
    if ($null -ne $saved) {
        foreach ($p in $saved.PSObject.Properties) {
            $record = $p.Value
            if ($p.Name -notmatch '^[A-Za-z0-9_-]{1,128}$' -or
                (Get-Field $record 'status') -notin @('claimed', 'attempting', 'accepted', 'confirmed', 'failed', 'unknown') -or
                (Get-Field $record 'error') -isnot [string] -or (Get-Field $record 'pending') -isnot [bool]) {
                throw 'Protected import journal has an invalid record. Reconcile manually; do not reset it to retry imports.'
            }
            if ((Get-Field $record 'status') -notin @('confirmed', 'failed', 'unknown')) {
                $record.status = 'unknown'
                $record.error = 'RAP restarted during an incomplete import. Inspect LightBurn; never automatically resend.'
                $record.pending = $true
            }
            $script:Journal[$p.Name] = $record
        }
        Save-Journal
    }
}

function Assert-CloudRoot([string]$Root) {
    $uri = $null
    if (-not [Uri]::TryCreate($Root, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or $uri.UserInfo -ne '' -or $uri.Query -ne '' -or $uri.Fragment -ne '' -or
        $uri.AbsolutePath -ne '/' -or $uri.Host -eq '') { throw 'Relay API root must be an HTTPS origin without a path, credentials, query or fragment.' }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Invoke-Http([string]$Url, [string]$Method, [string]$Token, $Body = $null, [hashtable]$Headers = @{}, [int]$TimeoutMs = 5000, [switch]$Raw) {
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Method = $Method
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutMs
    $request.ReadWriteTimeout = $TimeoutMs
    if (([Uri]$Url).IsLoopback) { $request.Proxy = $null }
    if ($Raw) {
        $request.AllowWriteStreamBuffering = $false
        $request.KeepAlive = $false
        $request.Pipelined = $false
        $request.ConnectionGroupName = [Guid]::NewGuid().ToString('N')
    }
    if ($Token) { $request.Headers['Authorization'] = 'Bearer ' + $Token }
    foreach ($key in $Headers.Keys) { $request.Headers[$key] = [string]$Headers[$key] }
    if ($null -ne $Body) {
        if ($Raw) { $bytes = [byte[]]$Body; $request.ContentType = 'application/octet-stream' }
        else { $bytes = $script:Utf8.GetBytes(($Body | ConvertTo-Json -Depth 20 -Compress)); $request.ContentType = 'application/json' }
        $request.ContentLength = $bytes.Length
    }
    $response = $null
    $deadline = New-Object PathPlotterRap.RequestDeadline($request, $TimeoutMs)
    try {
        if ($null -ne $Body) {
            $stream = $request.GetRequestStream()
            try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        }
        $response = [Net.HttpWebResponse]$request.GetResponse()
        if ($Raw) { return @{ code = [int]$response.StatusCode } }
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { throw 'HTTP endpoint did not return a success status.' }
        if ($response.ContentType -notmatch '^application/json(?:;|$)') { throw 'HTTP endpoint returned a non-JSON response.' }
        $input = $response.GetResponseStream()
        $buffer = New-Object byte[] 4096
        $output = New-Object IO.MemoryStream
        try {
            while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if ($output.Length + $count -gt 1048576) { throw 'HTTP response exceeded its bound.' }
                $output.Write($buffer, 0, $count)
            }
            $json = $script:Utf8.GetString($output.ToArray())
            if (-not $json.TrimStart().StartsWith('{', [StringComparison]::Ordinal)) { throw 'HTTP endpoint returned no JSON object.' }
            return ($json | ConvertFrom-Json)
        } finally { $input.Dispose(); $output.Dispose() }
    } catch [Net.WebException] {
        $code = 0
        if ($null -ne $_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            $_.Exception.Response.Close()
        }
        if ($code -eq 426) { throw 'RAP_UPDATE_REQUIRED' }
        if ($code -eq 401 -or $code -eq 403) { throw "HTTP authorization failed ($code). Check clock, permissions or revoke/re-pair explicitly." }
        if ($code -ne 0) { throw "HTTP request rejected ($code)." }
        throw 'HTTP network/timeout failure; no side-effect request is retried.'
    } catch [IO.IOException] {
        throw 'HTTP network/timeout failure; no side-effect request is retried.'
    } catch { throw 'HTTP request failed or returned an invalid response.' }
    finally {
        $deadline.Dispose()
        if ($null -ne $response) { $response.Close() }
        if ($Raw) { [void]$request.ServicePoint.CloseConnectionGroup($request.ConnectionGroupName) }
    }
}

function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
    $relay = [Uri]::EscapeDataString([string]$script:Config.relayId)
    return Invoke-Http ($script:Config.apiRoot + '/v1/relays/' + $relay + $Path) $Method $script:Config.credential $Body
}

function Get-ApprovedBrowserIds {
    $result = Invoke-Cloud '/agent/browsers' -Body $null -Method 'GET'
    $rows = Get-Field $result 'browsers'
    if ($rows -isnot [array]) { throw 'Invalid browser list.' }
    $ids = @()
    foreach ($row in $rows) {
        $id = Get-Field $row 'id'
        $parsed = [Guid]::Empty
        if ($id -isnot [string] -or -not [Guid]::TryParseExact($id, 'D', [ref]$parsed)) { throw 'Invalid browser.' }
        $ids += $id
    }
    return ,$ids
}

function Invoke-Local([string]$Path) {
    return Invoke-Http ($script:LightBurnRoot + $Path) 'GET' (Get-LightBurnToken $script:Config.lightBurnSecret) -TimeoutMs 1500
}

function Convert-Time($Value) {
    if (Test-Number $Value) { return [double]$Value }
    if ($Value -is [string]) {
        $parsed = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
            return ($parsed.UtcDateTime - [DateTime]'1970-01-01').TotalMilliseconds
        }
    }
    throw 'Invalid cloud timestamp.'
}

function Get-ServerNow {
    if ($null -eq $script:ServerTime) { throw 'Cloud time has not been established.' }
    $uncertainty = 0
    if ($null -ne $script:ClockUncertainty) { $uncertainty = $script:ClockUncertainty }
    return $script:ServerTime + ($script:Clock.ElapsedMilliseconds - $script:ServerTick) + $uncertainty
}

function Set-ClockCalibration($Response, [long]$RequestTick, [long]$ReceiptTick = -1) {
    if ($ReceiptTick -lt 0) { $ReceiptTick = $script:Clock.ElapsedMilliseconds }
    if ($RequestTick -lt 0 -or $ReceiptTick -lt $RequestTick) { throw 'Invalid monotonic clock calibration timing.' }
    $time = Convert-Time (Get-Field $Response 'serverTime')
    if ($time -le 0 -or [double]::IsNaN($time) -or [double]::IsInfinity($time)) { throw 'Invalid cloud clock calibration.' }
    $script:ServerTime = $time
    $script:ServerTick = $ReceiptTick
    # A server timestamp from anywhere within the request is bounded by full RTT.
    $script:ClockUncertainty = $ReceiptTick - $RequestTick
}

function New-ObservationUpdate($Observation, [long]$NowTick = -1) {
    if ($NowTick -lt 0) { $NowTick = $script:Clock.ElapsedMilliseconds }
    $age = $Observation.observationAgeMs + ($NowTick - $Observation.tick)
    $live = $Observation.connected -and $age -le 2000 -and
        $null -ne $script:ServerTime -and $null -ne $script:ClockUncertainty
    $body = @{
        generation = $script:Generation; sequence = $script:Sequence
        connected = $live; position = $null; context = $null
        observationAgeMs = $age; observedAtServer = $null; clockUncertaintyMs = $null
    }
    if ($live) {
        $body.position = $Observation.position
        $body.context = $Observation.context
        # Back-project the earliest instant of the local read using monotonic time.
        # The backend includes delayed transit at receipt, rather than restamping age.
        $body.observedAtServer = $script:ServerTime + ($Observation.tick - $script:ServerTick) - $Observation.observationAgeMs
        $body.clockUncertaintyMs = $script:ClockUncertainty
    }
    if ($Observation.error) { $body.error = $Observation.error }
    return $body
}

function Get-ProjectContext {
    $project = Invoke-Local '/api/project'
    $workspace = Get-Field $project 'workspace'
    if ($null -eq $workspace) { throw 'LightBurn workspace context is unavailable.' }
    foreach ($field in @('machine_size', 'workpiece_offset')) {
        $point = Get-Field $workspace $field
        if (-not (Test-Number (Get-Field $point 'x')) -or -not (Test-Number (Get-Field $point 'y'))) { throw 'LightBurn workspace dimensions or workpiece offset unavailable.' }
    }
    if ($workspace.machine_size.x -le 0 -or $workspace.machine_size.y -le 0 -or
        (Get-Field $workspace 'machine_view') -isnot [bool]) { throw 'Invalid LightBurn workspace context.' }
    $size = Get-Field $workspace 'workpiece_size'
    $sizeOut = $null
    if ($null -ne $size) {
        if (-not (Test-Number (Get-Field $size 'x')) -or -not (Test-Number (Get-Field $size 'y')) -or $size.x -le 0 -or $size.y -le 0) { throw 'Invalid LightBurn workpiece dimensions.' }
        $sizeOut = @{ x = $size.x; y = $size.y }
    }
    # Only stable documented coordinate/device fields, never layers or imported geometry.
    $stable = [ordered]@{
        workspace = [ordered]@{
            machine_size = Get-Field $workspace 'machine_size'
            workpiece_size = $sizeOut
            workpiece_offset = Get-Field $workspace 'workpiece_offset'
            machine_view = Get-Field $workspace 'machine_view'
        }
        filename = Get-Field $project 'filename'
        device = Get-Field $project 'device'
    }
    $revision = Get-Hash $script:Utf8.GetBytes(($stable | ConvertTo-Json -Depth 20 -Compress))
    return @{ revision = $revision; size = $sizeOut }
}

function New-StateObservation($Position, $Context, [bool]$Connected, [long]$Tick = -1, [double]$AgeMs = 0) {
    if ($Tick -lt 0) { $Tick = $script:Clock.ElapsedMilliseconds }
    if (-not $Connected) {
        return @{ connected = $false; position = $null; context = $null; observationAgeMs = 0; tick = $Tick; error = 'LightBurn API available, but no machine connected.' }
    }
    $point = Get-Field $Position 'workpiece'
    if (-not (Test-Number (Get-Field $point 'x')) -or -not (Test-Number (Get-Field $point 'y'))) {
        throw 'LightBurn event stream did not provide finite workpiece coordinates.'
    }
    if ($null -eq $Context -or (Get-Field $Context 'revision') -isnot [string]) {
        throw 'LightBurn project context is unavailable.'
    }
    return @{
        connected = $true; position = @{ x = $point.x; y = $point.y }
        context = $Context; observationAgeMs = $AgeMs; tick = $Tick; error = $null
    }
}

function New-StateEventStream {
    return New-Object PathPlotterRap.StateEventStream(($script:LightBurnRoot + '/api/events'), (Get-LightBurnToken $script:Config.lightBurnSecret))
}

function Start-StateEventStream {
    $stream = New-StateEventStream
    if ($null -eq $stream) { return $null }
    try {
        if (-not $stream.WaitReady(1500)) { throw 'LightBurn state event stream did not become ready.' }
        $state = Invoke-Local '/api/events/poll'
        $connection = Get-Field (Get-Field $state 'connection') 'connected'
        if ($connection -isnot [bool] -or -not $connection) { throw 'LightBurn event connection state is not usable; verify coordinates through REST polling.' }
        $context = Get-ProjectContext
        $observation = New-StateObservation (Get-Field $state 'position') $context $connection
        return @{
            stream = $stream; context = $context; connected = $connection
            position = Get-Field $state 'position'; positionTick = $observation.tick
            observation = $observation
        }
    } catch {
        $stream.Dispose()
        throw
    }
}

function Get-Observation {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $context = Get-ProjectContext
        $position = Invoke-Local '/api/position'
        $point = Get-Field $position 'workpiece'
        if (-not (Test-Number (Get-Field $point 'x')) -or -not (Test-Number (Get-Field $point 'y'))) { throw 'Finite workpiece X/Y are unavailable; machine coordinates are not substituted.' }
        return @{
            connected = $true; position = @{ x = $point.x; y = $point.y }
            context = $context
            observationAgeMs = $timer.ElapsedMilliseconds; tick = $script:Clock.ElapsedMilliseconds; error = $null
        }
    } catch {
        $errorText = 'LightBurn returned invalid or unavailable workpiece/context data.'
        if ($_.Exception.Message -like 'Local LightBurn credentials are missing*') { $errorText = 'LightBurn permission has not been granted yet. Click Request local LightBurn permission.' }
        elseif ($_.Exception.Message -like 'HTTP authorization failed*') { $errorText = 'LightBurn API authorization failed. Check Windows clock and Manage API Security; re-pair only with consent.' }
        elseif ($_.Exception.Message -like 'HTTP network/timeout failure*') { $errorText = 'LightBurn is not listening or timed out. Open LightBurn and try again.' }
        return @{ connected = $false; position = $null; context = $null; observationAgeMs = $timer.ElapsedMilliseconds; tick = $script:Clock.ElapsedMilliseconds; error = $errorText }
    }
}

function Assert-Job($Job, $Observation) {
    $id = Get-Field $Job 'id'
    if ($id -isnot [string] -or $id -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Invalid job identifier.' }
    if ((Get-Field $Job 'status') -notin @('queued', 'claimed')) { throw 'A non-ready job cannot be imported.' }
    if ((Convert-Time (Get-Field $Job 'expiresAt')) -le (Get-ServerNow)) { throw 'Job expired before import.' }
    if (-not $Observation.connected -or $null -eq $Observation.context -or
        $Observation.observationAgeMs + ($script:Clock.ElapsedMilliseconds - $Observation.tick) -gt 2000) { throw 'A fresh connected workpiece observation is required.' }
    if ((Get-Field $Job 'contextRevision') -cne $Observation.context.revision) { throw 'Coordinate context changed; import refused.' }
    $anchor = Get-Field $Job 'anchor'
    if (-not (Test-Number (Get-Field $anchor 'x')) -or -not (Test-Number (Get-Field $anchor 'y')) -or
        [Math]::Abs([double]$anchor.x) -gt 1000000 -or [Math]::Abs([double]$anchor.y) -gt 1000000) { throw 'Invalid placement anchor.' }
    $filename = Get-Field $Job 'filename'
    if ($filename -isnot [string] -or $filename.Length -gt 100 -or $filename.Contains('..') -or
        $filename -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.svg$') { throw 'Only a safe SVG filename is allowed.' }
    $svg = Get-Field $Job 'svg'
    if ($svg -isnot [string]) { throw 'SVG is missing.' }
    $bytes = $script:Utf8.GetBytes($svg)
    if ($bytes.Length -eq 0 -or $bytes.Length -gt 524288) { throw 'SVG exceeds the 512 KiB UTF-8 limit.' }
    $checksum = Get-Field $Job 'checksum'
    if ($checksum -isnot [string] -or $checksum -cnotmatch '^[0-9a-f]{64}$' -or (Get-Hash $bytes) -cne $checksum) { throw 'SVG checksum mismatch.' }
    Assert-Svg $svg
    return ,$bytes
}

function Assert-Svg([string]$Svg) {
    $settings = New-Object Xml.XmlReaderSettings
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.MaxCharactersInDocument = 524288
    $reader = [Xml.XmlReader]::Create((New-Object IO.StringReader($Svg)), $settings)
    $document = New-Object Xml.XmlDocument
    $document.XmlResolver = $null
    try { $document.Load($reader) } catch { throw 'SVG is not safe well-formed XML.' } finally { $reader.Dispose() }
    $root = $document.DocumentElement
    if ($null -eq $root -or $root.LocalName -cne 'svg' -or $root.NamespaceURI -cne 'http://www.w3.org/2000/svg') { throw 'Invalid SVG root.' }
    foreach ($child in $document.ChildNodes) {
        if ($child -ne $root -and $child.NodeType -notin @([Xml.XmlNodeType]::XmlDeclaration, [Xml.XmlNodeType]::Whitespace)) { throw 'SVG processing instructions and external content are forbidden.' }
    }
    $allowed = @{
        svg = @('xmlns', 'width', 'height', 'viewBox')
        circle = @('cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width')
        path = @('d', 'fill', 'stroke', 'stroke-width')
    }
    $nodes = @($document.SelectNodes('//*'))
    if ($nodes.Count -gt 10001) { throw 'SVG has too many shapes.' }
    $number = '-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?'
    foreach ($node in $nodes) {
        $tag = $node.LocalName
        if ($node.NamespaceURI -cne $root.NamespaceURI -or -not $allowed.ContainsKey($tag) -or
            ($node -ne $root -and ($tag -eq 'svg' -or $node.ParentNode -ne $root))) { throw 'SVG contains unsupported elements.' }
        foreach ($attr in $node.Attributes) {
            if ($attr.Name -cnotin $allowed[$tag]) { throw 'SVG contains unsupported attributes or external references.' }
            $value = $attr.Value
            switch -CaseSensitive ($attr.Name) {
                'xmlns' { if ($value -cne 'http://www.w3.org/2000/svg') { throw 'Invalid SVG namespace.' } }
                'fill' { if ($value -cne 'none') { throw 'Only outline SVG shapes are supported.' } }
                'stroke' { if ($value -notmatch '^#[0-9A-Fa-f]{6}$') { throw 'Invalid SVG stroke.' } }
                'd' { if ($value -notmatch "^\s*M\s+$number[ ,]+$number(?:\s+L\s+$number[ ,]+$number)+(?:\s+Z)?\s*$") { throw 'Only M/L/Z vector paths are supported.' } }
                'viewBox' { if ($value -notmatch "^\s*0[ ,]+0[ ,]+$number[ ,]+$number\s*$") { throw 'Invalid SVG viewBox.' } }
                default {
                    if ($attr.Name -notin @('width', 'height') -and $value -match 'mm$') { throw 'Only document dimensions may include units.' }
                    $numeric = $value -replace 'mm$', ''
                    if ($numeric -notmatch "^$number$") { throw 'Invalid SVG numeric attribute.' }
                    $n = [double]::Parse($numeric, [Globalization.CultureInfo]::InvariantCulture)
                    if ([double]::IsInfinity($n) -or [double]::IsNaN($n) -or [Math]::Abs($n) -gt 1000000 -or
                        ($attr.Name -in @('r', 'width', 'height', 'stroke-width') -and $n -le 0)) { throw 'SVG numeric attribute is out of bounds.' }
                    if ($attr.Name -in @('width', 'height') -and $value -notmatch 'mm$') { throw 'SVG dimensions must be in millimetres.' }
                }
            }
            if ($attr.Name -in @('d', 'viewBox')) {
                    foreach ($match in [regex]::Matches($value, $number)) {
                        $n = [double]::Parse($match.Value, [Globalization.CultureInfo]::InvariantCulture)
                        if ([double]::IsInfinity($n) -or [double]::IsNaN($n) -or [Math]::Abs($n) -gt 1000000) { throw 'SVG coordinate out of bounds.' }
                    }
                    if ($attr.Name -eq 'viewBox') {
                        $numbers = [regex]::Matches($value, $number)
                        if ([double]::Parse($numbers[2].Value, [Globalization.CultureInfo]::InvariantCulture) -le 0 -or
                            [double]::Parse($numbers[3].Value, [Globalization.CultureInfo]::InvariantCulture) -le 0) { throw 'SVG viewBox dimensions must be positive.' }
                }
            }
        }
        if ($tag -eq 'svg') { $required = @('width', 'height', 'viewBox') }
        elseif ($tag -eq 'circle') { $required = @('cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width') }
        else { $required = @('d', 'fill', 'stroke', 'stroke-width') }
        foreach ($name in $required) { if (-not $node.HasAttribute($name)) { throw 'Required SVG attributes are missing.' } }
        foreach ($child in $node.ChildNodes) {
            if ($child.NodeType -notin @([Xml.XmlNodeType]::Element, [Xml.XmlNodeType]::Whitespace, [Xml.XmlNodeType]::SignificantWhitespace) -and
                -not ($child.NodeType -eq [Xml.XmlNodeType]::Text -and [string]::IsNullOrWhiteSpace($child.Value))) { throw 'SVG text and embedded content are not supported.' }
        }
    }
    if ($nodes.Count -lt 2) { throw 'SVG has no geometry.' }
}

function Send-Record([string]$Id) {
    $record = $script:Journal[$Id]
    $body = @{ generation = $script:Generation; status = $record.status }
    if ($record.error) { $body.error = $record.error }
    $result = Invoke-Cloud ('/agent/jobs/' + [Uri]::EscapeDataString($Id) + '/status') $body
    if ((Get-Field $result 'id') -cne $Id -or (Get-Field $result 'status') -cne $record.status) { throw 'Cloud did not acknowledge the import state.' }
    $record.pending = $false
    Save-Journal
}

function Set-Record([string]$Id, [string]$Status, [string]$ErrorText = '') {
    $script:Journal[$Id] = @{ status = $Status; error = $ErrorText; pending = $true }
    Save-Journal
}

function New-ImportStream {
    return New-Object PathPlotterRap.EventStream(($script:LightBurnRoot + '/api/events'), (Get-LightBurnToken $script:Config.lightBurnSecret))
}

function Send-Upload($Job, [byte[]]$Bytes) {
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $headers = @{
        'X-Filename' = $Job.filename; 'X-Origin' = 'center'; 'X-Group-Shapes' = 'true'
        'X-Position-X' = ([double]$Job.anchor.x).ToString('R', $culture)
        'X-Position-Y' = ([double]$Job.anchor.y).ToString('R', $culture)
    }
    return Invoke-Http ($script:LightBurnRoot + '/api/file/upload') 'POST' (Get-LightBurnToken $script:Config.lightBurnSecret) $Bytes $headers -TimeoutMs 10000 -Raw
}

function Get-ImportResult([string]$Data) {
    if ([string]::IsNullOrEmpty($Data)) { return $null }
    try { $payload = $Data | ConvertFrom-Json } catch { return $null }
    $success = Get-Field $payload 'success'
    if ($success -isnot [bool]) { return $null }
    if ($success) { return 'confirmed' }
    return 'failed'
}

function Complete-Import([string]$Status, [string]$Message = '') {
    $active = $script:ActiveImport
    if ($null -eq $active) { return }
    try {
        Set-Record $active.id $Status $Message
        Write-Host ('Import result: ' + $Status)
    } finally {
        $script:ActiveImport = $null
        if ($null -ne $active.stream) { $active.stream.Dispose() }
    }
}

function Stop-Import {
    if ($null -eq $script:ActiveImport) { return }
    if ($script:ActiveImport.attempted) {
        Complete-Import 'unknown' 'RAP stopped or lost cloud generation during import. Inspect LightBurn; no automatic retry.'
    } else {
        Complete-Import 'failed' 'Import refused before upload: RAP stopped or lost cloud generation.'
    }
}

function Assert-ImportOwnership {
    if ($null -ne $script:UiBridge -and $script:UiBridge.StopRequested) { $script:StopRequested = $true }
    if ($script:StopRequested -or $null -eq $script:Generation -or
        $script:ActiveImport.generation -ne $script:Generation) {
        throw 'RAP stopped or lost cloud generation.'
    }
}

function Update-Import {
    if ($null -eq $script:ActiveImport) { return }
    $active = $script:ActiveImport
    if ($script:StopRequested -or $null -eq $script:Generation -or $active.generation -ne $script:Generation) {
        Stop-Import
        return
    }
    if ($active.phase -ne 'waiting') { return }
    try {
        if ($script:Clock.ElapsedMilliseconds -ge $active.deadline) {
            Complete-Import 'unknown' 'Upload accepted but no genuine file_imported confirmation within 20 seconds. Inspect LightBurn; do not automatically resend.'
            return
        }
        # One nonblocking dequeue per iteration bounds work even for invalid events.
        $result = Get-ImportResult ($active.stream.Take(0))
        if ($null -ne $result) {
            $message = ''
            if ($result -eq 'failed') { $message = 'LightBurn file_imported explicitly reported failure.' }
            Complete-Import $result $message
        } elseif (-not $active.stream.IsOpen) {
            Complete-Import 'unknown' 'Upload accepted but SSE closed without genuine file_imported confirmation. Inspect LightBurn; do not automatically resend.'
        }
    } catch {
        if ($null -ne $script:ActiveImport) {
            Complete-Import 'unknown' 'Import confirmation unavailable. Inspect LightBurn; no automatic retry.'
        } else { throw }
    }
}

function Invoke-Import($Job, $Observation) {
    # The retained stream is the import mutex, including the confirmation window.
    if ($null -ne $script:ActiveImport) { return }
    $id = Get-Field $Job 'id'
    if ($id -isnot [string] -or $id -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Cloud returned an invalid job identifier.' }
    if ($script:Journal.ContainsKey($id)) {
        # Even failed jobs are tombstones. Repeated delivery must never repeat upload.
        $script:Journal[$id].pending = $true
        Save-Journal
        return
    }
    $active = @{ id = $id; generation = $script:Generation; stream = $null; attempted = $false; phase = 'starting'; deadline = 0L }
    $script:ActiveImport = $active
    try {
        Assert-ImportOwnership
        $bytes = Assert-Job $Job $Observation
        Set-Record $id 'claimed'
        $active.stream = New-ImportStream
        $stream = $active.stream
        if (-not $stream.WaitReady(3000)) { throw 'LightBurn SSE did not send its connected readiness comment.' }
        $fresh = Get-Observation
        Assert-ImportOwnership
        $bytes = Assert-Job $Job $fresh
        if (-not $stream.IsOpen) { throw 'LightBurn event stream closed before upload.' }
        Set-Record $id 'attempting'
        # Do not upload unless the cloud generation still owns this job.
        Send-Record $id
        # Cloud acknowledgement may have taken seconds. Revalidate afterwards.
        $fresh = Get-Observation
        Assert-ImportOwnership
        $bytes = Assert-Job $Job $fresh
        if (-not $stream.IsOpen) { throw 'LightBurn event stream closed before upload.' }
        $stream.Arm()
        $active.attempted = $true
        $response = Send-Upload $Job $bytes
        if ($response.code -ne 202) {
            Complete-Import 'unknown' 'Unexpected upload response; inspect LightBurn before any manual resend.'
            return
        }
        $active.deadline = $script:Clock.ElapsedMilliseconds + 20000
        Set-Record $id 'accepted'
        try { Send-Record $id } catch { Write-Host 'Cloud import acknowledgement unavailable; saved locally.' }
        $active.phase = 'waiting'
        Assert-ImportOwnership
    } catch {
        if ($null -eq $script:ActiveImport) { throw }
        if ($active.attempted) { Complete-Import 'unknown' 'Import side effect may have occurred. Inspect LightBurn; no automatic retry.' }
        else { Complete-Import 'failed' 'Import refused before upload: invalid job, stale context, unavailable SSE, or cloud ownership not acknowledged.' }
    }
}

function Read-SavedConfig {
    $saved = Read-Protected 'credentials.dpapi'
    if ($null -eq $saved) { return $null }
    $saved.apiRoot = Assert-CloudRoot $saved.apiRoot
    if ((Get-Field $saved 'relayId') -isnot [string] -or [string]::IsNullOrEmpty($saved.relayId) -or
        (Get-Field $saved 'credential') -isnot [string] -or [string]::IsNullOrEmpty($saved.credential) -or
        (Get-Field $saved 'lightBurnSecret') -isnot [string]) { throw 'Local relay credentials are incomplete.' }
    return $saved
}

function Show-PendingPairings($Pairings) {
    $next = @{}
    foreach ($pair in @($Pairings)) {
        if ($null -eq $pair) { continue }
        $id = Get-Field $pair 'id'
        $phrase = Get-Field $pair 'phrase'
        if ($id -isnot [string] -or $id -notmatch '^[A-Za-z0-9_-]{1,128}$' -or
            $phrase -isnot [string] -or $phrase -notmatch '^[A-Za-z0-9 -]{1,120}$') { throw 'Invalid browser approval request.' }
        $next[$id] = $phrase
    }
    $script:PendingPairings = $next
    Publish-RapPairings ([hashtable]$next.Clone())
}

function Start-Rap {
    Initialize-Storage
    $lock = $null
    $lastPush = -15000L
    $script:LastObservationHealth = ''
    try {
        try { $lock = New-Object IO.FileStream((Join-Path $script:DataDirectory 'instance.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'Another RAP instance is running, or the local state directory cannot be locked.' }
        Load-Journal
        Initialize-Config
        $script:StopRequested = $false
        $script:Generation = $null
        $script:ServerTime = $null
        $script:ClockUncertainty = $null
        $backoff = 500
        $lastHealth = ''
        $nextRead = 0L
        $nextConnect = 0L
        $nextPush = 0L
        $nextContextRead = 0L
        $nextStreamRetry = 0L
        $signature = ''
        $publishedSignature = ''
        $publishedMoving = $false
        $publishedSettled = $false
        $publishedLive = $false
        $observation = $null
        $script:OutstandingUpdates = @{}
        $script:CaptureIds = @{}
        $script:ForcePublish = $true
        $script:PreviewActive = $false
        $script:StateStream = $null
        $script:EventContext = $null
        $script:EventConnected = $false
        $script:EventPosition = $null
        $script:EventPositionTick = 0L
        $script:PositionConnected = $false
        $script:PositionInitialized = $false
        $script:PositionMotionActive = $false
        $script:LastPositionSignature = ''
        $script:LastPositionChangeTick = 0L
        $streamFallbackReported = $false
        try {
            $state = Start-StateEventStream
            if ($null -ne $state) {
                $script:StateStream = $state.stream
                $script:EventContext = $state.context
                $script:EventConnected = $state.connected
                $script:EventPosition = $state.position
                $script:EventPositionTick = $state.positionTick
                $observation = $state.observation
                Register-PreviewObservation $observation
                $signature = Get-ObservationSignature $observation
                $nextContextRead = $script:Clock.ElapsedMilliseconds + 5000
                $nextRead = [long]::MaxValue
            } else {
                $nextStreamRetry = $script:Clock.ElapsedMilliseconds + 30000
            }
        } catch {
            $streamFallbackReported = $true
            $nextStreamRetry = $script:Clock.ElapsedMilliseconds + 30000
            Write-Host 'LightBurn event stream unavailable; using REST polling.'
        }
        while (-not $script:StopRequested) {
            Read-UiCommand
            Update-Import
            if ($script:StopRequested) { break }
            $now = $script:Clock.ElapsedMilliseconds
            if ($null -ne $script:StateStream -and -not $script:StateStream.IsOpen) {
                $script:StateStream.Dispose()
                $script:StateStream = $null
                $nextRead = 0L
                $nextStreamRetry = $now + 30000
                if (-not $streamFallbackReported) {
                    Write-Host 'LightBurn event stream closed; using REST polling.'
                    $streamFallbackReported = $true
                }
            }
            if ($null -ne $script:StateStream) {
                try {
                    if ($now -ge $nextContextRead) {
                        $script:EventContext = Get-ProjectContext
                        if ($script:EventConnected -and $null -ne $script:EventPosition) {
                            $observation = New-StateObservation $script:EventPosition $script:EventContext $true $script:EventPositionTick
                            Register-PreviewObservation $observation
                            $signature = Get-ObservationSignature $observation
                        }
                        $nextContextRead = $script:Clock.ElapsedMilliseconds + 5000
                    }
                    for ($eventIndex = 0; $eventIndex -lt 64; $eventIndex++) {
                        $stateEvent = $script:StateStream.Take()
                        if ($null -eq $stateEvent) { break }
                        $eventTick = $script:Clock.ElapsedMilliseconds
                        $eventAgeMs = [Math]::Max(0, ([DateTime]::UtcNow.Ticks - $stateEvent.ReceivedAtUtcTicks) / 10000.0)
                        $eventTick = [Math]::Max(0, $eventTick - [long][Math]::Ceiling($eventAgeMs))
                        if ($stateEvent.Name -ceq 'position') {
                            $script:EventPosition = $stateEvent.Data | ConvertFrom-Json
                            $script:EventPositionTick = $eventTick
                            if ($script:EventConnected) {
                                $observation = New-StateObservation $script:EventPosition $script:EventContext $true $eventTick $eventAgeMs
                            }
                        } elseif ($stateEvent.Name -ceq 'connection') {
                            $connectionEvent = $stateEvent.Data | ConvertFrom-Json
                            $connected = Get-Field $connectionEvent 'connected'
                            if ($connected -isnot [bool]) { throw 'LightBurn connection event is invalid.' }
                            if ($connected) {
                                $state = Invoke-Local '/api/events/poll'
                                $snapshotConnected = Get-Field (Get-Field $state 'connection') 'connected'
                                if ($snapshotConnected -isnot [bool] -or -not $snapshotConnected) { throw 'LightBurn event connection state is not usable; verify coordinates through REST polling.' }
                                $script:EventConnected = $true
                                $script:EventPosition = Get-Field $state 'position'
                                $script:EventContext = Get-ProjectContext
                                $script:EventPositionTick = $eventTick
                                $observation = New-StateObservation $script:EventPosition $script:EventContext $script:EventConnected $eventTick $eventAgeMs
                            } else {
                                throw 'LightBurn event reported disconnected; verify coordinates through REST polling.'
                            }
                        } else { continue }
                        Register-PreviewObservation $observation
                        $signature = Get-ObservationSignature $observation
                    }
                } catch {
                    $script:StateStream.Dispose()
                    $script:StateStream = $null
                    $nextRead = 0L
                    $nextStreamRetry = $script:Clock.ElapsedMilliseconds + 30000
                    if (-not $streamFallbackReported) {
                        Write-Host 'LightBurn event stream failed; using REST polling.'
                        $streamFallbackReported = $true
                    }
                }
            }
            if ($null -eq $script:StateStream -and $now -ge $nextRead) {
                $observation = Get-Observation
                Register-PreviewObservation $observation
                $signature = Get-ObservationSignature $observation
                $nextRead = [Math]::Max($now + 500, $script:Clock.ElapsedMilliseconds)
            }
            if ($null -eq $script:StateStream -and $now -ge $nextStreamRetry) {
                try {
                    $state = Start-StateEventStream
                    if ($null -ne $state) {
                        $script:StateStream = $state.stream
                        $script:EventContext = $state.context
                        $script:EventConnected = $state.connected
                        $script:EventPosition = $state.position
                        $script:EventPositionTick = $state.positionTick
                        $observation = $state.observation
                        Register-PreviewObservation $observation
                        $signature = Get-ObservationSignature $observation
                        $nextContextRead = $script:Clock.ElapsedMilliseconds + 5000
                        $nextRead = [long]::MaxValue
                        $streamFallbackReported = $false
                    } else { $nextStreamRetry = $now + 30000 }
                } catch {
                    $nextStreamRetry = $script:Clock.ElapsedMilliseconds + 30000
                }
            }
            try {
                if ($null -eq $script:Generation -and $now -ge $nextConnect) {
                    $requestTick = $script:Clock.ElapsedMilliseconds
                    $start = Invoke-Cloud '/agent/start' @{ version = $script:RapVersion }
                    $script:UpdateRequired = $false
                    Set-ClockCalibration $start $requestTick
                    $generation = Get-Field $start 'generation'
                    if (-not (Test-Number $generation) -or $generation -lt 1 -or [Math]::Floor($generation) -ne $generation) { throw 'Invalid cloud generation.' }
                    $script:Generation = $generation
                    $script:Sequence = 0L
                    $script:ForcePublish = $true
                    $script:OutstandingUpdates.Clear()
                    $script:CaptureIds.Clear()
                    $nextPush = 0L
                    $script:Socket = New-AgentSocket
                }
                if ($null -ne $script:Generation) {
                    if ($script:Socket.IsFinished) { throw $script:Socket.Failure }
                    Receive-AgentMessages
                    foreach ($id in @($script:OutstandingUpdates.Keys)) {
                        if ($script:Clock.ElapsedMilliseconds - $script:OutstandingUpdates[$id].tick -gt 5000) { throw 'Socket update acknowledgment timed out.' }
                    }
                    $now = $script:Clock.ElapsedMilliseconds
                    $motion = Get-PreviewMotion $observation $now
                    $live = $motion.live
                    $moving = $motion.moving
                    $settled = $motion.settled
                    $due = $script:ForcePublish -or $now - $lastPush -ge 15000 -or
                        ($moving -ne $publishedMoving) -or ($settled -ne $publishedSettled) -or
                        ($live -ne $publishedLive) -or
                        ($script:PreviewActive -and $signature -cne $publishedSignature)
                    if ($due -and $now -ge $nextPush -and $script:Socket.IsOpen) {
                        $script:Sequence++
                        $body = New-ObservationUpdate $observation
                        $body.settled = [bool]$settled
                        $body.moving = [bool]$moving
                        $requestTick = $script:Clock.ElapsedMilliseconds
                        $script:ForcePublish = $false
                        $id = [Guid]::NewGuid().ToString()
                        $script:OutstandingUpdates[$id] = @{ tick = $requestTick; observation = $observation; body = $body }
                        Send-AgentMessage 'update' $id $body
                        $nextPush = $requestTick + 500
                        $lastPush = $requestTick
                        $publishedSignature = $signature
                        $publishedMoving = $moving
                        $publishedSettled = $settled
                        $publishedLive = $live
                        foreach ($id in @($script:Journal.Keys)) {
                            if ($script:Journal[$id].pending) {
                                try { Send-Record $id } catch { Write-Host 'Saved import state not acknowledged by cloud; retained for reconciliation.' }
                            }
                        }
                        $backoff = 500
                    }
                }
            } catch {
                $updateRequired = $_.Exception.Message -ceq 'RAP_UPDATE_REQUIRED'
                # Failed cloud publications never preserve a visible live snapshot locally.
                $script:Generation = $null
                $script:ServerTime = $null
                $script:ClockUncertainty = $null
                $script:PendingPairings = @{}
                if ($null -ne $script:Socket) { $script:Socket.Dispose(); $script:Socket = $null }
                Stop-Import
                $health = 'Relay disconnected. Coordinates paused; reconnecting.'
                if ($updateRequired) {
                    $script:UpdateRequired = $true
                    $health = 'This RAP version is too old for the relay. Click Update now.'
                    $backoff = 30000
                }
                Publish-RapHealth $health $false
                if ($lastHealth -ne $health) { Write-Host $health; $lastHealth = $health }
                $nextConnect = $script:Clock.ElapsedMilliseconds + $backoff
                $backoff = [Math]::Min(30000, $backoff * 2)
            }
            Start-Sleep -Milliseconds 25
        }
    } finally {
        try { Stop-Import } finally {
            if ($null -ne $script:Socket) { $script:Socket.Dispose(); $script:Socket = $null }
            if ($null -ne $script:StateStream) { $script:StateStream.Dispose(); $script:StateStream = $null }
            if ($null -ne $lock) { $lock.Dispose() }
        }
    }
}
