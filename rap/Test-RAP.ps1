#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Run these checks using built-in Windows PowerShell 5.1, not PowerShell 7.'
}
$script:Passed = 0
$statePath = Join-Path $PSScriptRoot ('.test-state-' + [Guid]::NewGuid().ToString('N'))

function Check([string]$Name, [scriptblock]$Test) {
    & $Test
    $script:Passed++
    Write-Host ('PASS ' + $Name)
}
function Assert($Condition, [string]$Message = 'Assertion failed') {
    if (-not $Condition) { throw $Message }
}
function Must-Throw([scriptblock]$Test) {
    $threw = $false
    try { & $Test } catch { $threw = $true }
    Assert $threw 'Expected a failure, not a success-shaped fallback.'
}

try {
    Check 'PS5.1 syntax for all RAP scripts and no execution-policy bypass' {
        foreach ($file in Get-ChildItem $PSScriptRoot -Filter '*.ps1' -Recurse) {
            $tokens = $null; $parseErrors = $null
            [void][Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
            Assert ($parseErrors.Count -eq 0) ('Parse error in ' + $file.Name)
        }
        $launcher = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Start RAP.cmd'))
        $guiLauncher = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Start RAP.vbs'))
        Assert ($launcher -match 'wscript.exe')
        Assert ($guiLauncher -match 'WindowsPowerShell\\v1.0\\powershell.exe')
        Assert ($guiLauncher -match '-STA')
        Assert ($launcher -notmatch '(?i)ExecutionPolicy|Bypass|Unrestricted')
        Assert ($guiLauncher -notmatch '(?i)ExecutionPolicy|Bypass|Unrestricted')
    }
    . (Join-Path $PSScriptRoot 'RAP.ps1') -DataDirectory $statePath
    . (Join-Path $PSScriptRoot 'Updater.ps1')
    $script:OriginalHttp = ${function:Invoke-Http}
    $script:CaptureHttp = $false
    # Nothing below may accidentally call actual cloud/LightBurn HTTP.
    function Invoke-Http([string]$Url, [string]$Method, [string]$Token, $Body = $null, [hashtable]$Headers = @{}, [int]$TimeoutMs = 5000, [switch]$Raw) {
        if (-not $script:CaptureHttp) { throw 'Network calls forbidden in focused mocked tests.' }
        $script:Wire = @{ url = $Url; method = $Method; token = $Token; body = $Body; headers = $Headers; timeout = $TimeoutMs; raw = [bool]$Raw }
        return @{ code = 202 }
    }
    function Start-StateEventStream { return $null }
    Initialize-Storage

    Check 'HMAC-SHA256 minute token exact known vector' {
        Assert ((Get-LightBurnToken 'key' 123) -ceq 'a7f7739b1dc5b4e922b1226c9fcbdc83498dee375382caee08fd52a13eb7cfe2')
        Assert ((Get-LightBurnToken 'key' 124) -cne (Get-LightBurnToken 'key' 123))
    }
    Check 'HTTPS cloud origin only, no credential/query/path URL leakage' {
        Assert ((Assert-CloudRoot 'https://relay.example/') -ceq 'https://relay.example')
        foreach ($root in @('http://relay.example', 'https://secret@relay.example', 'https://relay.example/path', 'https://relay.example/?token=x', 'https://relay.example/#x')) {
            Must-Throw { Assert-CloudRoot $root }
        }
    }
    Check 'DPAPI roundtrip, atomic replacement and restrictive current-user directory ACL' {
        Write-Protected 'test.dpapi' @{ credential = 'test-secret-never-log'; value = 1 }
        Assert ((Read-Protected 'test.dpapi').value -eq 1)
        $raw = [IO.File]::ReadAllBytes((Join-Path $statePath 'test.dpapi'))
        Assert ([Text.Encoding]::UTF8.GetString($raw) -notmatch 'test-secret-never-log')
        Write-Protected 'test.dpapi' @{ credential = 'another-test-value'; value = 2 }
        Assert ((Read-Protected 'test.dpapi').value -eq 2)
        Assert (@(Get-ChildItem $statePath -Filter '*.next').Count -eq 0)
        $acl = [IO.Directory]::GetAccessControl($statePath)
        Assert $acl.AreAccessRulesProtected
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            Assert ($rule.IdentityReference.Value -eq $sid)
        }
        $lock = New-Object IO.FileStream((Join-Path $statePath 'test.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
        try { Must-Throw { $second = New-Object IO.FileStream((Join-Path $statePath 'test.lock'), 'OpenOrCreate', 'ReadWrite', 'None'); $second.Dispose() } }
        finally { $lock.Dispose() }
    }
    Check 'Unreadable protected state fails closed' {
        [IO.File]::WriteAllBytes((Join-Path $statePath 'bad.dpapi'), [byte[]]@(1, 2, 3))
        Must-Throw { Read-Protected 'bad.dpapi' }
        Write-Protected 'wrong-shape.dpapi' @('not-an-object')
        Must-Throw { Read-Protected 'wrong-shape.dpapi' }
        Write-Protected 'journal.dpapi' @{ invalid = @{ status = 'accepted' } }
        Must-Throw { Load-Journal }
        $script:Journal = @{}
        Save-Journal
    }

    $script:Svg = '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><circle cx="5" cy="5" r="2" fill="none" stroke="#ff0000" stroke-width="0.2"/><path d="M 1 1 L 2 2 L 3 1 Z" fill="none" stroke="#123ABC" stroke-width="0.2"/></svg>'
    Check 'Constrained circle and M/L/Z vector SVG accepted' { Assert-Svg $script:Svg }
    Check 'SVG external references, scripts, DTD, text, processing instructions and unbounded geometry rejected' {
        foreach ($svg in @(
            ($script:Svg -replace '<circle ', '<circle onload="alert(1)" '),
            ($script:Svg -replace '<circle ', '<circle href="https://example.invalid" '),
            ($script:Svg -replace '<circle ', '<circle style="fill:url(x)" '),
            ($script:Svg -replace '<circle ', '<g><circle ' -replace '</svg>', '</g></svg>'),
            ($script:Svg -replace '<circle ', '<script/><circle '),
            ($script:Svg -replace '<circle ', '<text>label</text><circle '),
            ($script:Svg -replace 'r="2"', 'r="1mm"'),
            ($script:Svg -replace 'width="10mm"', 'width="10"'),
            ($script:Svg -replace 'viewBox="0 0 10 10"', 'viewBox="0 0 -10 10"'),
            ($script:Svg -replace 'M 1 1 L 2 2', 'M 1 1 L 1e999 2'),
            ($script:Svg -replace 'M 1 1 L 2 2', 'M 1 1 Q 2 2'),
            ($script:Svg -replace 'r="2"', 'r="NaN"'),
            ($script:Svg -replace '<svg ', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg '),
            ($script:Svg -replace '<svg ', '<?xml-stylesheet href="https://example.invalid"?><svg ')
        )) { Must-Throw { Assert-Svg $svg } }
    }

    $script:LocalCalls = New-Object 'Collections.Generic.List[string]'
    $script:Mode = 'good'
    function Invoke-Local([string]$Path) {
        $script:LocalCalls.Add($Path)
        switch ($Path) {
            '/api/status' {
                if ($script:Mode -eq 'offline') { return @{ connected = $false } }
                if ($script:Mode -eq 'auth') { throw 'HTTP authorization failed (401). Check clock, permissions or revoke/re-pair explicitly.' }
                if ($script:Mode -eq 'nosecret') { throw 'Local LightBurn credentials are missing.' }
                return @{ connected = $true }
            }
            '/api/project' {
                $workspace = @{ machine_size = @{ x = 400; y = 300 }; workpiece_size = @{ x = 100; y = 80 }; workpiece_offset = @{ x = 20; y = 30 }; machine_view = $false }
                if ($script:Mode -eq 'offset') { $workspace.workpiece_offset.x = 21 }
                if ($script:Mode -eq 'empty') { $workspace = @{} }
                if ($script:Mode -eq 'nosize') { $workspace.workpiece_size = $null }
                return @{ workspace = $workspace; filename = 'work.lbrn2'; device = @{ name = 'Mock machine' } }
            }
            '/api/position' {
                if ($script:Mode -eq 'machine') { return @{ machine = @{ x = 1; y = 2 } } }
                if ($script:Mode -eq 'nan') { return @{ workpiece = @{ x = [double]::NaN; y = 2 } } }
                return @{ workpiece = @{ x = 12.5; y = 9.25 }; machine = @{ x = 999; y = 999 } }
            }
            default { throw 'Unexpected local endpoint.' }
        }
    }
    Check 'Workpiece-only reads serialized with current status and context, never zero/machine fallback' {
        $script:Observation = Get-Observation
        Assert $script:Observation.connected
        Assert ($script:Observation.position.x -eq 12.5 -and $script:Observation.position.y -eq 9.25)
        Assert (($script:LocalCalls -join ',') -eq '/api/status,/api/project,/api/position')
        foreach ($mode in @('offline', 'auth', 'empty', 'machine', 'nan')) {
            $script:Mode = $mode
            $bad = Get-Observation
            Assert (-not $bad.connected -and $null -eq $bad.position -and $null -eq $bad.context)
        }
        $script:Mode = 'good'
    }
    Check 'Workspace offset changes context revision; absent workpiece size remains unknown' {
        $first = Get-Observation
        $script:Mode = 'offset'
        Assert ((Get-Observation).context.revision -cne $first.context.revision)
        $script:Mode = 'nosize'
        $unknownSize = Get-Observation
        Assert ($unknownSize.connected -and $null -eq $unknownSize.context.size)
        $script:Mode = 'good'
    }
    Check 'Missing LightBurn permission is a clear not-ready state, not a relay failure' {
        $script:Mode = 'nosecret'
        $none = Get-Observation
        $script:Mode = 'good'
        Assert (-not $none.connected -and $null -eq $none.position -and $none.error -like 'LightBurn permission has not been granted yet*') $none.error
    }
    Check 'An acknowledged update reports the relay as ready even while LightBurn is not' {
        $script:Healths = New-Object 'Collections.Generic.List[object]'
        function Publish-RapHealth([string]$Message, [bool]$Connected, [bool]$CloudReady = $Connected) { $script:Healths.Add(@{ message = $Message; connected = $Connected; cloud = $CloudReady }) }
        $notReady = @{ connected = $false; position = $null; context = $null; observationAgeMs = 5; tick = $script:Clock.ElapsedMilliseconds; error = 'LightBurn API available, but no machine connected.' }
        Publish-ObservationHealth $notReady @{ connected = $false }
        Assert ($script:Healths.Count -eq 1 -and -not $script:Healths[0].connected -and $script:Healths[0].cloud -and $script:Healths[0].message -ceq $notReady.error)
        Remove-Item Function:\Publish-RapHealth
        function Publish-RapHealth([string]$Message, [bool]$Connected, [bool]$CloudReady = $Connected) { }
    }    $script:ServerTime = 1800000000000.0
    $script:ServerTick = $script:Clock.ElapsedMilliseconds
    Check 'Start/update clock calibration uses serverTime and full monotonic RTT, never wall clock' {
        Set-ClockCalibration @{ serverTime = 1800000000000.0 } 1000 1040
        Assert ($script:ClockUncertainty -eq 40 -and $script:ServerTick -eq 1040)
        $observation = @{ connected = $true; position = @{ x = 1; y = 2 }; context = @{ revision = 'test'; size = $null }; observationAgeMs = 20; tick = 1100; error = $null }
        $body = New-ObservationUpdate $observation 1110
        Assert ($body.connected -and $body.observationAgeMs -eq 30)
        Assert ($body.observedAtServer -eq 1800000000040.0 -and $body.clockUncertaintyMs -eq 40)
        Set-ClockCalibration @{ serverTime = 1800000000200.0 } 1200 1250
        Assert ($script:ClockUncertainty -eq 50)
        Must-Throw { Set-ClockCalibration @{} 1000 1040 }
        Must-Throw { Set-ClockCalibration @{ serverTime = 0 } 1000 1040 }
        Must-Throw { Set-ClockCalibration @{ serverTime = 1 } 1040 1000 }
    }
    Check 'Delayed RAP publication remains stale at cloud receipt despite small reported read age' {
        Set-ClockCalibration @{ serverTime = 1800000000000.0 } 1000 1040
        $observation = @{ connected = $true; position = @{ x = 1; y = 2 }; context = @{ revision = 'test'; size = $null }; observationAgeMs = 20; tick = 1100; error = $null }
        $body = New-ObservationUpdate $observation 1110
        $delayedReceipt = 1800000005040.0
        $ageAtReceipt = [Math]::Max($body.observationAgeMs, $delayedReceipt - $body.observedAtServer + $body.clockUncertaintyMs)
        Assert ($body.observationAgeMs -eq 30 -and $ageAtReceipt -eq 5040 -and $ageAtReceipt -gt 2000)
    }
    Check 'Missing calibration and locally stale observations cannot publish connected samples' {
        $observation = @{ connected = $true; position = @{ x = 1; y = 2 }; context = @{ revision = 'test'; size = $null }; observationAgeMs = 20; tick = 1100; error = $null }
        $script:ServerTime = $null; $script:ClockUncertainty = $null
        $body = New-ObservationUpdate $observation 1110
        Assert (-not $body.connected -and $null -eq $body.position -and $null -eq $body.observedAtServer)
        Set-ClockCalibration @{ serverTime = 1800000000000.0 } 1000 1040
        $body = New-ObservationUpdate $observation 3101
        Assert (-not $body.connected -and $null -eq $body.context)
        Set-ClockCalibration @{ serverTime = 1800000000000.0 } $script:Clock.ElapsedMilliseconds
    }
    function New-TestJob([string]$Id = 'job-test') {
        return @{ id = $Id; status = 'claimed'; svg = $script:Svg; checksum = Get-Hash ($script:Utf8.GetBytes($script:Svg)); filename = 'pathplotter-test.svg'; anchor = @{ x = 30; y = 40 }; contextRevision = $script:Observation.context.revision; expiresAt = (Get-ServerNow) + 60000 }
    }
    function Fresh-Observation {
        return @{ connected = $true; position = $script:Observation.position; context = $script:Observation.context; observationAgeMs = 0; tick = $script:Clock.ElapsedMilliseconds; error = $null }
    }
    Check 'Position activity starts on coordinate changes and settles exactly after two quiet seconds' {
        $script:PositionConnected = $false
        $script:PositionInitialized = $false
        $script:PositionMotionActive = $false
        $base = Fresh-Observation
        $base.tick = 1000
        Register-PreviewObservation $base
        Assert (-not (Get-PreviewMotion $base 2999).settled)
        Assert ((Get-PreviewMotion $base 3000).settled)
        $moved = @{ connected = $true; position = @{ x = $base.position.x + 1; y = $base.position.y }; context = $base.context; observationAgeMs = 0; tick = 3100; error = $null }
        Register-PreviewObservation $moved
        Assert ((Get-PreviewMotion $moved 3100).moving -and -not (Get-PreviewMotion $moved 3100).settled)
        Assert ((Get-PreviewMotion $moved 5099).moving)
        $stopped = Get-PreviewMotion $moved 5100
        Assert (-not $stopped.moving -and $stopped.settled)
    }
    Check 'UTF-8 checksum, expiry, anchor, context and readiness validation' {
        $job = New-TestJob
        $bytes = Assert-Job $job (Fresh-Observation)
        Assert ($bytes.Length -eq $script:Utf8.GetByteCount($script:Svg))
        foreach ($mutation in @('checksum', 'expired', 'context', 'anchor', 'filename', 'state', 'size')) {
            $job = New-TestJob
            switch ($mutation) {
                'checksum' { $job.checksum = '0' * 64 }
                'expired' { $job.expiresAt = (Get-ServerNow) - 1 }
                'context' { $job.contextRevision = 'wrong' }
                'anchor' { $job.anchor.x = [double]::PositiveInfinity }
                'filename' { $job.filename = "../unsafe`r`n.svg" }
                'state' { $job.status = 'accepted' }
                'size' { $job.svg = 'x' * 524289 }
            }
            Must-Throw { Assert-Job $job (Fresh-Observation) }
        }
        $stale = Fresh-Observation; $stale.observationAgeMs = 2001
        Must-Throw { Assert-Job (New-TestJob) $stale }
        $offline = Fresh-Observation; $offline.connected = $false
        Must-Throw { Assert-Job (New-TestJob) $offline }
    }
    Check 'Authenticated cloud routing and exact raw LightBurn upload placement headers' {
        $script:Config = @{ apiRoot = 'https://relay.example'; relayId = 'synthetic-relay'; credential = 'synthetic-credential'; lightBurnSecret = 'synthetic-secret' }
        $script:CaptureHttp = $true
        try {
            $null = Invoke-Cloud '/agent/start' @{ version = '3.0.0' }
            Assert ($script:Wire.url -eq 'https://relay.example/v1/relays/synthetic-relay/agent/start')
            Assert ($script:Wire.token -ceq 'synthetic-credential' -and $script:Wire.method -eq 'POST' -and $script:Wire.timeout -eq 5000)
            $null = Invoke-Cloud '/agent/browsers' -Body $null -Method 'GET'
            Assert ($script:Wire.method -eq 'GET' -and $null -eq $script:Wire.body)
            $culture = [Threading.Thread]::CurrentThread.CurrentCulture
            try {
                [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]'fr-FR'
                $job = New-TestJob; $job.anchor.x = 30.5; $job.anchor.y = -2.25
                $null = Send-Upload $job ($script:Utf8.GetBytes($script:Svg))
            } finally { [Threading.Thread]::CurrentThread.CurrentCulture = $culture }
            Assert ($script:Wire.url -eq 'http://127.0.0.1:19520/api/file/upload' -and $script:Wire.method -eq 'POST' -and $script:Wire.raw)
            Assert ($script:Wire.headers['X-Origin'] -ceq 'center' -and $script:Wire.headers['X-Position-X'] -ceq '30.5' -and $script:Wire.headers['X-Position-Y'] -ceq '-2.25')
            Assert ($script:Wire.token -cmatch '^[0-9a-f]{64}$' -and $script:Wire.token -cne 'synthetic-secret')
            Assert ($script:Wire.body -is [byte[]])
        } finally { $script:CaptureHttp = $false }
    }
    Check 'Only exact file_imported SSE labels and literal boolean success count' {
        Assert ($null -eq [PathPlotterRap.EventStream]::ImportPayload('message', '{"success":true,"type":"file_imported"}'))
        Assert ($null -eq [PathPlotterRap.EventStream]::ImportPayload('status', '{"success":true}'))
        Assert ((Get-ImportResult ([PathPlotterRap.EventStream]::ImportPayload('file_imported', '{"success":true}'))) -eq 'confirmed')
        Assert ((Get-ImportResult '{"success":false}') -eq 'failed')
        foreach ($data in @('{"success":"true"}', '{"success":1}', '{"status":"ok"}', 'invalid')) { Assert ($null -eq (Get-ImportResult $data)) }
    }
    Check 'Real SSE reader requires :connected, ignores pre-arm and generic success events, parses genuine event' {
        $compiler = New-Object CodeDom.Compiler.CompilerParameters
        $compiler.GenerateInMemory = $true
        $compiler.TempFiles = New-Object CodeDom.Compiler.TempFileCollection($statePath, $false)
        [void]$compiler.ReferencedAssemblies.Add('System.dll')
        [void]$compiler.ReferencedAssemblies.Add('System.Core.dll')
        Add-Type -Path (Join-Path $PSScriptRoot 'Tests\Fixtures.cs') -CompilerParameters $compiler
        $fixture = New-Object PathPlotterRapTests.SseFixture(':notconnected')
        $stream = New-Object PathPlotterRap.EventStream($fixture.Url, 'synthetic-test-token')
        try {
            Assert (-not $stream.WaitReady(100))
            $fixture.Emit(":connected`r`n`r`n")
            Assert ($stream.WaitReady(5000))
            $fixture.Emit("event: file_imported`ndata: {`"success`":true}`n`n")
            Assert ($null -eq $stream.Take(100))
            $stream.Arm()
            $fixture.Emit("event: status`ndata: {`"success`":true}`n`n")
            Assert ($null -eq $stream.Take(100))
            $fixture.Emit("event: file_imported`ndata: {`"success`":`ndata: true}`n`n")
            Assert ((Get-ImportResult ($stream.Take(5000))) -eq 'confirmed')
        } finally { $stream.Dispose(); $fixture.Dispose() }
    }
    Check 'State SSE reader retains position and connection events without weakening import confirmation' {
        $fixture = New-Object PathPlotterRapTests.SseFixture(':connected')
        $stream = New-Object PathPlotterRap.StateEventStream($fixture.Url, 'synthetic-test-token')
        try {
            Assert ($stream.WaitReady(5000))
            $fixture.Emit("event: job`ndata: {`"state`":`"idle`"}`n`nevent: position`ndata: {`"workpiece`":{`"x`":12.5,`"y`":-4}}`n`nevent: connection`ndata: {`"connected`":false}`n`n")
            $first = $null
            $second = $null
            $deadline = $script:Clock.ElapsedMilliseconds + 3000
            while ($null -eq $second -and $script:Clock.ElapsedMilliseconds -lt $deadline) {
                $nextEvent = $stream.Take()
                if ($null -ne $nextEvent) {
                    if ($null -eq $first) { $first = $nextEvent } else { $second = $nextEvent }
                } else { Start-Sleep -Milliseconds 10 }
            }
            Assert ($null -ne $first -and $first.Name -ceq 'position') 'The position event was not retained.'
            Assert (($first.Data | ConvertFrom-Json).workpiece.x -eq 12.5)
            Assert ($first.ReceivedAtUtcTicks -gt 0)
            Assert ($null -ne $second -and $second.Name -ceq 'connection') 'The connection event was not retained.'
            Assert (-not ($stream.Take()))
        } finally { $stream.Dispose(); $fixture.Dispose() }
    }
    Check 'HTTP JSON validation, authorization errors, redirects and whole-request timeout fail closed' {
        $fixture = New-Object PathPlotterRapTests.HttpFixture(200, 'application/json', '{"value":123}', 0)
        try { Assert ((& $script:OriginalHttp $fixture.Url 'GET' 'synthetic-test-token').value -eq 123) }
        finally { $fixture.Dispose() }
        foreach ($scenario in @(
            @{ status = 401; type = 'application/json'; body = '{"credential":"synthetic-response-never-log"}'; delay = 0 },
            @{ status = 302; type = 'application/json'; body = '{"value":123}'; delay = 0 },
            @{ status = 200; type = 'text/html'; body = 'not json'; delay = 0 },
            @{ status = 200; type = 'application/json'; body = 'invalid'; delay = 0 },
            @{ status = 200; type = 'application/json'; body = 'null'; delay = 0 },
            @{ status = 200; type = 'application/json'; body = '{"value":123}'; delay = 500 }
        )) {
            $fixture = New-Object PathPlotterRapTests.HttpFixture($scenario.status, $scenario.type, $scenario.body, $scenario.delay)
            try { Must-Throw { & $script:OriginalHttp $fixture.Url 'GET' 'synthetic-test-token' -TimeoutMs 100 } }
            finally { $fixture.Dispose() }
        }
    }
    Check 'HTTP 426 from the relay reports that this RAP must be updated' {
        $fixture = New-Object PathPlotterRapTests.HttpFixture(426, 'application/json', '{"error":"rap_update_required","minimumVersion":"9.0.0"}', 0)
        try {
            $message = ''
            try { $null = & $script:OriginalHttp $fixture.Url 'POST' 'synthetic-test-token' @{ version = '0.0.1' } } catch { $message = $_.Exception.Message }
            Assert ($message -ceq 'RAP_UPDATE_REQUIRED')
        } finally { $fixture.Dispose() }
    }
    Check 'Unbuffered raw upload transport sends immutable bytes once to test fixture, without redirect or stale-connection reuse' {
        $fixture = New-Object PathPlotterRapTests.HttpFixture(202, 'application/json', '{}', 0)
        try {
            $bytes = $script:Utf8.GetBytes($script:Svg)
            $result = & $script:OriginalHttp $fixture.Url 'POST' 'synthetic-test-token' $bytes @{ 'X-Filename' = 'test.svg'; 'X-Origin' = 'center' } -Raw
            Assert ($result.code -eq 202 -and $fixture.RequestBody.Length -eq $bytes.Length)
            Assert ((Get-Hash $fixture.RequestBody) -ceq (Get-Hash $bytes))
            Assert ($fixture.RequestHeaders -match 'Content-Type: application/octet-stream')
            Assert ($fixture.RequestHeaders -match 'Connection: [Cc]lose')
            Assert ($fixture.RequestHeaders -match 'Authorization: Bearer synthetic-test-token')
        } finally { $fixture.Dispose() }
    }

    Check 'Pending browser approvals are validated before reaching the UI' {
        $script:Published = $null
        function Publish-RapPairings($Pairings) { $script:Published = $Pairings }
        Show-PendingPairings @(@{ id = 'pairing-test'; phrase = 'calm river 123' })
        Assert ($script:Published['pairing-test'] -ceq 'calm river 123' -and $script:PendingPairings.Count -eq 1)
        Must-Throw { Show-PendingPairings @(@{ id = '../bad'; phrase = 'calm river' }) }
        Must-Throw { Show-PendingPairings @(@{ id = 'ok'; phrase = "line`nbreak" }) }
        $script:PendingPairings = @{}
    }
    Check 'Saved registration is validated and missing registration is reported' {
        [IO.File]::Delete((Join-Path $statePath 'credentials.dpapi'))
        Assert ($null -eq (Read-SavedConfig))
        Must-Throw { Initialize-Config }
        Write-Protected 'credentials.dpapi' @{ apiRoot = 'https://relay.example/'; relayId = 'synthetic-relay'; credential = 'synthetic-credential'; lightBurnSecret = '' }
        Assert ((Read-SavedConfig).apiRoot -ceq 'https://relay.example')
        Write-Protected 'credentials.dpapi' @{ apiRoot = 'https://relay.example'; relayId = ''; credential = 'synthetic-credential'; lightBurnSecret = '' }
        Must-Throw { Read-SavedConfig }
        [IO.File]::Delete((Join-Path $statePath 'credentials.dpapi'))
    }
    function Get-Observation { return Fresh-Observation }
    $script:Generation = 1
    $script:Config = @{ apiRoot = 'https://relay.example'; relayId = 'synthetic-relay'; credential = 'synthetic-credential'; lightBurnSecret = 'synthetic-secret' }
    $script:Order = New-Object 'Collections.Generic.List[string]'
    $script:Uploads = 0
    $script:Ready = $true
    $script:UploadMode = 'accepted'
    $script:EventData = '{"success":true}'
    $script:CloudReject = $false
    $script:CloseStream = $false
    $script:Streams = New-Object 'Collections.Generic.List[object]'
    $script:RealStream = $null
    function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
        if ($script:CloudReject) { throw 'Mock cloud fence/rejection.' }
        $script:Order.Add('cloud-' + $Body.status)
        return @{ id = ($Path -split '/')[3]; status = $Body.status }
    }
    function New-ImportStream {
        if ($null -ne $script:RealStream) { return $script:RealStream }
        $mock = [pscustomobject]@{ IsOpen = $true; Disposed = $false; Polls = 0 }
        $mock | Add-Member ScriptMethod WaitReady { param($ms); $script:Order.Add('ready'); return $script:Ready }
        $mock | Add-Member ScriptMethod Arm { $script:Order.Add('armed') }
        $mock | Add-Member ScriptMethod Take {
            param($ms)
            Assert ($ms -eq 0) 'Confirmation polling must not wait.'
            $this.Polls++
            if ($script:CloseStream) { $this.IsOpen = $false }
            return $script:EventData
        }
        $mock | Add-Member ScriptMethod Dispose { Assert (-not $this.Disposed); $this.Disposed = $true; $script:Order.Add('disposed') }
        $script:Streams.Add($mock)
        return $mock
    }
    function Send-Upload($Job, [byte[]]$Bytes) {
        $script:Uploads++
        $script:Order.Add('upload')
        $saved = Read-Protected 'journal.dpapi'
        Assert ((Get-Field (Get-Field $saved $Job.id) 'status') -eq 'attempting') 'Durable attempting journal must precede the side effect.'
        if ($script:UploadMode -eq 'throw') { throw 'Mock uncertain network outcome.' }
        if ($script:UploadMode -eq 'wrong-status') { return @{ code = 200 } }
        return @{ code = 202 }
    }
    Check 'Durable attempting + cloud ownership + SSE ready before one serialized upload' {
        $script:Journal = @{}
        Invoke-Import (New-TestJob 'job-confirmed') (Fresh-Observation)
        Assert ($script:Journal['job-confirmed'].status -eq 'accepted' -and $null -ne $script:ActiveImport)
        Assert ($script:Streams[-1].Polls -eq 0 -and -not $script:Streams[-1].Disposed)
        Update-Import
        Assert ($script:Journal['job-confirmed'].status -eq 'confirmed')
        Assert (($script:Order -join ',') -eq 'ready,cloud-attempting,armed,upload,cloud-accepted,disposed')
        Assert ($script:Uploads -eq 1)
        Invoke-Import (New-TestJob 'job-confirmed') (Fresh-Observation)
        Assert ($script:Uploads -eq 1) 'Duplicate delivery uploaded twice.'
    }
    Check 'Unready SSE and cloud fence abort before upload, without success fallback' {
        $script:Ready = $false
        Invoke-Import (New-TestJob 'job-unready') (Fresh-Observation)
        Assert ($script:Journal['job-unready'].status -eq 'failed' -and $script:Uploads -eq 1)
        $script:Ready = $true; $script:CloudReject = $true
        Invoke-Import (New-TestJob 'job-fenced') (Fresh-Observation)
        Assert ($script:Journal['job-fenced'].status -eq 'failed' -and $script:Uploads -eq 1)
        $script:CloudReject = $false
    }
    Check 'Context rechecked after cloud acknowledgement, before side effect' {
        $script:FreshCount = 0
        $script:Order.Clear()
        function Get-Observation {
            $script:FreshCount++
            $o = Fresh-Observation
            if ($script:FreshCount -ge 2) { $o.context = @{ revision = 'different'; size = $null } }
            return $o
        }
        Invoke-Import (New-TestJob 'job-changed') (Fresh-Observation)
        Assert ($script:Journal['job-changed'].status -eq 'failed' -and $script:Uploads -eq 1)
        Assert (($script:Order -join ',') -eq 'ready,cloud-attempting,disposed')
        function Get-Observation { return Fresh-Observation }
    }
    Check 'Uncertain upload, unexpected HTTP status and accepted-without-event never retried' {
        foreach ($mode in @('throw', 'wrong-status', 'accepted')) {
            $script:UploadMode = $mode; $script:EventData = $null; $script:CloseStream = $true
            $id = 'job-unknown-' + $mode
            $before = $script:Uploads
            Invoke-Import (New-TestJob $id) (Fresh-Observation)
            Update-Import
            Assert ($script:Journal[$id].status -eq 'unknown' -and $script:Uploads -eq $before + 1)
            Invoke-Import (New-TestJob $id) (Fresh-Observation)
            Assert ($script:Uploads -eq $before + 1)
        }
        $script:UploadMode = 'accepted'
        $script:CloseStream = $false
    }
    Check 'Genuine file_imported false is failed, never bool-coerced into success' {
        $script:EventData = '{"success":false,"error":"synthetic remote text not printed"}'
        Invoke-Import (New-TestJob 'job-failed') (Fresh-Observation)
        Update-Import
        Assert ($script:Journal['job-failed'].status -eq 'failed')
    }
    Check 'Pending confirmation holds one serial import, rejects malformed events, and times out without retry' {
        $script:EventData = $null
        $before = $script:Uploads
        Invoke-Import (New-TestJob 'job-timeout') (Fresh-Observation)
        $stream = $script:ActiveImport.stream
        Invoke-Import (New-TestJob 'job-next') (Fresh-Observation)
        Assert ($script:Uploads -eq $before + 1 -and -not $script:Journal.ContainsKey('job-next'))
        foreach ($data in @('invalid', '{"success":"true"}', '{"success":1}', '{"type":"file_imported"}')) {
            $script:EventData = $data
            Update-Import
            Assert ($script:Journal['job-timeout'].status -eq 'accepted' -and -not $stream.Disposed)
        }
        Assert ($script:ActiveImport.deadline -gt $script:Clock.ElapsedMilliseconds)
        Assert ($script:ActiveImport.deadline -le $script:Clock.ElapsedMilliseconds + 20000)
        $script:ActiveImport.deadline = $script:Clock.ElapsedMilliseconds
        $script:EventData = '{"success":true}'
        Update-Import
        Assert ($script:Journal['job-timeout'].status -eq 'unknown' -and $stream.Disposed -and $null -eq $script:ActiveImport)
        Assert ((Read-Protected 'journal.dpapi').'job-timeout'.status -eq 'unknown')
        Invoke-Import (New-TestJob 'job-timeout') (Fresh-Observation)
        Assert ($script:Uploads -eq $before + 1)
        Invoke-Import (New-TestJob 'job-next') (Fresh-Observation)
        Update-Import
        Assert ($script:Uploads -eq $before + 2 -and $script:Journal['job-next'].status -eq 'confirmed')
    }
    Check 'Cooperative poll validates a genuine event through the real SSE reader' {
        $fixture = New-Object PathPlotterRapTests.SseFixture(':connected')
        $script:RealStream = New-Object PathPlotterRap.EventStream($fixture.Url, 'synthetic-test-token')
        try {
            Invoke-Import (New-TestJob 'job-real-event') (Fresh-Observation)
            $fixture.Emit("event: status`ndata: {`"success`":true}`n`nevent: file_imported`ndata: {`"success`":`"true`"}`n`n")
            for ($i = 0; $i -lt 5; $i++) { Update-Import; Start-Sleep -Milliseconds 20 }
            Assert ($script:Journal['job-real-event'].status -eq 'accepted')
            $fixture.Emit("event: file_imported`ndata: {`"success`":true}`n`n")
            $deadline = $script:Clock.ElapsedMilliseconds + 3000
            while ($null -ne $script:ActiveImport -and $script:Clock.ElapsedMilliseconds -lt $deadline) {
                Update-Import
                Start-Sleep -Milliseconds 10
            }
            Assert ($script:Journal['job-real-event'].status -eq 'confirmed' -and $null -eq $script:ActiveImport)
        } finally {
            Stop-Import
            $script:RealStream.Dispose()
            $script:RealStream = $null
            $fixture.Dispose()
        }
    }
    Check 'Stop and changed or missing generation fence accepted imports and retain no-retry tombstones' {
        foreach ($mode in @('stop', 'changed', 'missing')) {
            $script:Generation = 1; $script:StopRequested = $false; $script:EventData = $null
            $id = 'job-loss-' + $mode
            Invoke-Import (New-TestJob $id) (Fresh-Observation)
            $stream = $script:ActiveImport.stream
            switch ($mode) {
                'stop' { $script:StopRequested = $true }
                'changed' { $script:Generation = 2 }
                'missing' { $script:Generation = $null }
            }
            $script:EventData = '{"success":true}'
            Update-Import
            Assert ($script:Journal[$id].status -eq 'unknown' -and $stream.Disposed -and $null -eq $script:ActiveImport)
            $script:Generation = 1; $script:StopRequested = $false
            $before = $script:Uploads
            Load-Journal
            Invoke-Import (New-TestJob $id) (Fresh-Observation)
            Assert ($script:Uploads -eq $before)
        }
    }
    Check 'Stop or generation loss during setup aborts before side effect' {
        foreach ($mode in @('stop', 'generation')) {
            $script:StopRequested = $false; $script:Generation = 1
            $script:FreshCount = 0; $script:SetupLoss = $mode
            function Get-Observation {
                $script:FreshCount++
                if ($script:FreshCount -eq 2) {
                    if ($script:SetupLoss -eq 'stop') { $script:StopRequested = $true }
                    else { $script:Generation = 2 }
                }
                return Fresh-Observation
            }
            $before = $script:Uploads
            Invoke-Import (New-TestJob ('job-setup-' + $mode)) (Fresh-Observation)
            Assert ($script:Uploads -eq $before -and $null -eq $script:ActiveImport -and $script:Streams[-1].Disposed)
            Assert ($script:Journal['job-setup-' + $mode].status -eq 'failed')
        }
        $script:StopRequested = $false; $script:Generation = 1
        function Get-Observation { return Fresh-Observation }
    }
    Check 'Restart recovers claimed/attempting/accepted as unknown; terminal tombstones retained' {
        foreach ($status in @('claimed', 'attempting', 'accepted', 'confirmed', 'failed', 'unknown')) {
            $script:Journal['recovery-' + $status] = @{ status = $status; error = ''; pending = $false }
        }
        Save-Journal
        Load-Journal
        foreach ($status in @('claimed', 'attempting', 'accepted')) {
            Assert ($script:Journal['recovery-' + $status].status -eq 'unknown')
            Assert $script:Journal['recovery-' + $status].pending
        }
        foreach ($status in @('confirmed', 'failed', 'unknown')) { Assert ($script:Journal['recovery-' + $status].status -eq $status) }
        $before = $script:Uploads
        Invoke-Import (New-TestJob 'recovery-attempting') (Fresh-Observation)
        Assert ($script:Uploads -eq $before)
    }
    $script:PublicationBodies = New-Object 'Collections.Generic.List[object]'
    $script:ScheduleMode = 'serial'
    $script:CycleCount = 0
    $script:ReadCount = 0
    function Initialize-Config {
        $script:Config = @{ apiRoot = 'https://relay.example'; relayId = 'synthetic-relay'; credential = 'synthetic-credential'; lightBurnSecret = 'synthetic-secret' }
    }
    function Get-Observation { $script:ReadCount++; return Fresh-Observation }
    function Read-UiCommand {
        if ($script:ScheduleMode -eq 'fatal' -and $script:CycleCount -ge 1 -and $script:Socket.Queue.Count -eq 0) { throw 'Mock interrupted main loop.' }
        $limit = 2
        if ($script:ScheduleMode -eq 'serial') { $limit = 4 }
        if ($script:CycleCount -ge $limit -and ($null -eq $script:Socket -or $script:Socket.Queue.Count -eq 0)) { $script:StopRequested = $true }
    }
    function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
        if ($Path -eq '/agent/start') { return @{ generation = 10; serverTime = 1800000000000.0 } }
        if ($Path -eq '/agent/update') {
            if (-not $Body.connected) { return @{} }
            $script:CycleCount++
            $script:PublicationBodies.Add($Body)
            if ($script:ScheduleMode -eq 'serial') {
                if ($script:CycleCount -in @(2, 3)) {
                    Assert ($script:Journal['schedule-first'].status -eq 'accepted')
                    Assert ($script:Uploads -eq $script:ScheduleBefore + 1)
                    Assert (-not $script:ActiveImport.stream.Disposed)
                }
                if ($script:CycleCount -eq 3) { $script:EventData = '{"success":true}' }
                if ($script:CycleCount -eq 4) {
                    Assert ($script:Journal['schedule-first'].status -eq 'confirmed')
                    $script:EventData = $null
                }
                $id = 'schedule-second'
                if ($script:CycleCount -eq 1) { $id = 'schedule-first' }
            } elseif ($script:ScheduleMode -eq 'fence') {
                if ($script:CycleCount -eq 2) { throw 'Mock lost cloud generation.' }
                $id = 'schedule-fenced'
            } elseif ($script:ScheduleMode -eq 'fatal') { $id = 'schedule-interrupted' }
            else { $id = 'schedule-second' }
            $job = New-TestJob $id
            if ($script:ScheduleMode -eq 'serial' -and $script:CycleCount -in @(2, 3)) { $job = $null }
            return @{ serverTime = 1800000000000.0; pairings = @(); job = $job; previewActive = $true }
        }
        return @{ id = ($Path -split '/')[3]; status = $Body.status }
    }
    function New-AgentSocket {
        $mock = New-Object PSObject -Property @{ IsOpen = $true; IsFinished = $false; Failure = ''; Queue = (New-Object 'Collections.Generic.Queue[string]') }
        $mock | Add-Member ScriptMethod Enqueue {
            param($text)
            $message = $text | ConvertFrom-Json
            $result = Invoke-Cloud '/agent/update' $message.body
            $this.Queue.Enqueue((@{ v = 2; type = 'update-result'; id = $message.id; body = $result } | ConvertTo-Json -Depth 25 -Compress))
            $this.Queue.Enqueue((@{ v = 2; type = 'work'; body = $result } | ConvertTo-Json -Depth 25 -Compress))
        }
        $mock | Add-Member ScriptMethod Take { if ($this.Queue.Count) { return $this.Queue.Dequeue() }; return $null }
        $mock | Add-Member ScriptMethod Dispose { $this.IsOpen = $false }
        return $mock
    }
    Check 'Built-in PS5.1 ClientWebSocket authorization, fragmented receive, async send and bounded idle cancellation' {
        Assert ([Net.WebSockets.ClientWebSocket].Assembly.GetName().Name -eq 'System')
        $fixture = New-Object PathPlotterRapTests.SocketFixture
        $socket = New-Object PathPlotterRap.AgentSocket($fixture.Url, 'fixture-socket-credential')
        try {
            $timer = [Diagnostics.Stopwatch]::StartNew()
            while (-not $socket.IsOpen -and $timer.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 10 }
            Assert $socket.IsOpen
            Assert ($fixture.Headers -match 'Authorization: Bearer fixture-socket-credential' -and $fixture.Url -notmatch 'credential')
            $socket.Enqueue('{"v":2,"type":"update"}')
            $fixture.Send('{"v":2,"type":"work"}', $true)
            $text = $null
            while ($null -eq $text -and $timer.ElapsedMilliseconds -lt 5000) { $text = $socket.Take(); Start-Sleep -Milliseconds 10 }
            Assert ($text -ceq '{"v":2,"type":"work"}')
            while ($null -eq $fixture.Received -and $timer.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 10 }
            Assert ($fixture.Received -ceq '{"v":2,"type":"update"}')
            $large = 'x' * 614400
            $fixture.Send($large, $true)
            $timer.Restart(); $text = $null
            while ($null -eq $text -and $timer.ElapsedMilliseconds -lt 5000) { $text = $socket.Take(); Start-Sleep -Milliseconds 10 }
            Assert ($text -ceq $large) 'Valid full-size job envelope did not pass bounded fragmented receive.'
            Must-Throw { $socket.Enqueue(('x' * 16385)) }
            $timer.Restart(); $socket.Dispose()
            Assert ($socket.IsFinished -and $timer.ElapsedMilliseconds -lt 2000 -and -not $socket.IsOpen)
        } finally { $socket.Dispose(); $fixture.Dispose() }
        $fixture = New-Object PathPlotterRapTests.SocketFixture
        $socket = New-Object PathPlotterRap.AgentSocket($fixture.Url, 'fixture-only')
        try {
            for ($i = 0; $i -lt 5; $i++) { $fixture.Send(('x' * 900000), $false) }
            $timer.Restart()
            while (-not $socket.IsFinished -and $timer.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 10 }
            Assert ($socket.IsFinished -and $socket.Failure -match 'IOException') 'Aggregate inbound byte budget was not enforced.'
        } finally { $socket.Dispose(); $fixture.Dispose() }
        $fixture = New-Object PathPlotterRapTests.SocketFixture
        $socket = New-Object PathPlotterRap.AgentSocket($fixture.Url, 'fixture-only')
        try {
            $fixture.Send(('x' * 1048577), $false)
            $timer.Restart()
            while (-not $socket.IsFinished -and $timer.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 10 }
            Assert ($socket.IsFinished -and $null -eq $socket.Take() -and $socket.Failure -match 'InvalidDataException')
        } finally { $socket.Dispose(); $fixture.Dispose() }
    }
    Check 'Actual Start-Rap scheduling reads and publishes fresh coordinates while confirmation waits; serial next import and quit cleanup' {
        $script:Journal = @{}; Save-Journal
        $script:EventData = $null
        $script:ScheduleBefore = $script:Uploads
        Start-Rap
        Assert ($script:CycleCount -eq 4 -and $script:ReadCount -ge 4)
        Assert ($script:Uploads -eq $script:ScheduleBefore + 2)
        foreach ($body in $script:PublicationBodies) {
            Assert ($body.connected -and $null -ne $body.position -and $null -ne $body.context -and $body.observationAgeMs -le 2000)
        }
        Assert ($script:Journal['schedule-first'].status -eq 'confirmed')
        Assert ($script:Journal['schedule-second'].status -eq 'unknown')
        Assert ($null -eq $script:ActiveImport -and $script:Streams[-1].Disposed)
    }
    Check 'Start-Rap can restart after quit without reuploading an incomplete import' {
        $script:ScheduleMode = 'restart'; $script:CycleCount = 0
        $before = $script:Uploads
        Start-Rap
        Assert ($script:CycleCount -eq 2 -and $script:Generation -eq 10)
        Assert ($script:Uploads -eq $before -and $script:Journal['schedule-second'].status -eq 'unknown')
        Assert ($null -eq $script:ActiveImport)
    }
    Check 'Main cloud failure abandons accepted stream under generation fence; unexpected exit also cleans up' {
        $script:ScheduleMode = 'fence'; $script:CycleCount = 0
        Start-Rap
        Assert ($null -eq $script:Generation -and $null -eq $script:ActiveImport -and $script:Streams[-1].Disposed)
        Assert ($script:Journal['schedule-fenced'].status -eq 'unknown')
        $script:ScheduleMode = 'fatal'; $script:CycleCount = 0
        Must-Throw { Start-Rap }
        Assert ($null -eq $script:ActiveImport -and $script:Streams[-1].Disposed)
        Assert ((Read-Protected 'journal.dpapi').'schedule-interrupted'.status -eq 'unknown')
        $lock = New-Object IO.FileStream((Join-Path $statePath 'instance.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
        $lock.Dispose()
    }
    Check 'Stationary socket capture performs new serialized reads; work still delivers pairing; duplicate requests fail closed' {
        $script:CaptureReads = 0
        function Get-Observation {
            $script:CaptureReads++
            $observation = Fresh-Observation
            $observation.position.x = $script:CaptureReads
            return $observation
        }
        $script:Socket = New-Object PSObject -Property @{ Queue = (New-Object 'Collections.Generic.Queue[string]'); Sent = (New-Object 'Collections.Generic.List[string]') }
        $script:Socket | Add-Member ScriptMethod Take { if ($this.Queue.Count) { return $this.Queue.Dequeue() }; return $null }
        $script:Socket | Add-Member ScriptMethod Enqueue { param($text); $this.Sent.Add($text) }
        $script:CaptureIds = @{}; $script:OutstandingUpdates = @{}
        $script:Generation = 10; $script:ServerTime = 1800000000000.0; $script:ServerTick = $script:Clock.ElapsedMilliseconds; $script:ClockUncertainty = 0
        $first = [Guid]::NewGuid().ToString(); $second = [Guid]::NewGuid().ToString()
        $script:Socket.Queue.Enqueue((@{ v = 2; type = 'work'; body = @{ previewActive = $false; job = $null; pairings = @(@{ id = 'stationary-pair'; phrase = 'AMBER RIVER' }) } } | ConvertTo-Json -Depth 10 -Compress))
        foreach ($id in @($first, $second)) { $script:Socket.Queue.Enqueue((@{ v = 2; type = 'capture'; id = $id } | ConvertTo-Json -Compress)) }
        Receive-AgentMessages
        Assert ($script:CaptureReads -eq 2 -and $script:PendingPairings.ContainsKey('stationary-pair'))
        $a = $script:Socket.Sent[0] | ConvertFrom-Json; $b = $script:Socket.Sent[1] | ConvertFrom-Json
        Assert ($a.type -ceq 'capture-result' -and $a.id -ceq $first -and $a.body.position.x -eq 1 -and $b.body.position.x -eq 2)
        Assert ($a.body.sequence -lt $b.body.sequence -and $a.body.observedAtServer -le $b.body.observedAtServer)
        $script:Socket.Queue.Enqueue((@{ v = 2; type = 'capture'; id = $first } | ConvertTo-Json -Compress))
        Must-Throw { Receive-AgentMessages }
        Assert ($script:CaptureReads -eq 2)
        $script:Socket = $null
    }
    $script:TimingMessages = New-Object 'Collections.Generic.List[object]'
    $script:TimingHttp = New-Object 'Collections.Generic.List[object]'
    $script:TimingClock = [Diagnostics.Stopwatch]::StartNew()
    $script:TimingLimit = 19000
    $script:ReadCount = 0
    function Get-Observation { $script:ReadCount++; return Fresh-Observation }
    function Read-UiCommand { if ($script:TimingClock.ElapsedMilliseconds -ge $script:TimingLimit) { $script:StopRequested = $true } }
    function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
        if ($Path -eq '/agent/start') { return @{ generation = 11; serverTime = 1800000000000.0 } }
        $script:TimingHttp.Add(@{ path = $Path; tick = $script:Clock.ElapsedMilliseconds; body = $Body })
        throw 'Unexpected timing fixture cloud call.'
    }
    function New-AgentSocket {
        $mock = New-Object PSObject -Property @{ IsOpen = $true; IsFinished = $false; Failure = ''; Queue = (New-Object 'Collections.Generic.Queue[string]') }
        $mock | Add-Member ScriptMethod Enqueue {
            param($text)
            $message = $text | ConvertFrom-Json
            $script:TimingMessages.Add(@{ tick = $script:Clock.ElapsedMilliseconds; body = $message.body })
            $result = @{ serverTime = 1800000000000.0; previewActive = [bool]$message.body.moving; pairings = @(); job = $null }
            $this.Queue.Enqueue((@{ v = 2; type = 'update-result'; id = $message.id; body = $result } | ConvertTo-Json -Depth 25 -Compress))
        }
        $mock | Add-Member ScriptMethod Take { if ($this.Queue.Count) { return $this.Queue.Dequeue() }; return $null }
        $mock | Add-Member ScriptMethod Dispose { $this.IsOpen = $false }
        return $mock
    }
    Check 'REST fallback retains fresh capture health and sends a settled transition after two seconds' {
        $script:Journal = @{}; Save-Journal
        $script:TimingClock.Restart()
        Start-Rap
        Assert ($script:ReadCount -ge 30 -and $script:TimingHttp.Count -eq 0) ('Reads=' + $script:ReadCount + ' http=' + $script:TimingHttp.Count)
        Assert ($script:TimingMessages.Count -eq 3) ('Stationary socket published too often or omitted health: ' + $script:TimingMessages.Count + ' messages.')
        for ($i = 1; $i -lt $script:TimingMessages.Count; $i++) {
            Assert ($script:TimingMessages[$i].tick - $script:TimingMessages[$i - 1].tick -ge 495) ('Publishes ' + $i + ' too close: ' + ($script:TimingMessages[$i].tick - $script:TimingMessages[$i - 1].tick) + ' ms.')
        }
        Assert (-not $script:TimingMessages[0].body.settled -and $script:TimingMessages[1].body.settled) 'The initial and settled flags are wrong.'
        Assert ($script:TimingMessages[1].tick - $script:TimingMessages[0].tick -ge 1900) 'Preview settled before two seconds without a position change.'
        Assert (-not $script:TimingMessages[0].body.moving -and -not $script:TimingMessages[1].body.moving) 'A stationary RAP incorrectly reported movement.'
        Assert ($script:TimingMessages[2].tick - $script:TimingMessages[1].tick -ge 15000) ('Idle health came after ' + ($script:TimingMessages[2].tick - $script:TimingMessages[1].tick) + ' ms.')
        Assert ($script:TimingMessages[2].body.observationAgeMs -lt 600 -and $script:TimingMessages[2].body.connected) 'Idle health observation was stale.'
    }
    Check 'LightBurn state events activate preview on movement and release it after two quiet seconds' {
        $script:Journal = @{}; Save-Journal
        $script:TimingMessages = New-Object 'Collections.Generic.List[object]'
        $script:TimingClock.Restart()
        $script:EventStartTick = $script:Clock.ElapsedMilliseconds
        $script:EventIndex = 0
        $script:EventSchedule = @(
            @{ at = 500; x = 101 },
            @{ at = 1000; x = 102 },
            @{ at = 1500; x = 103 },
            @{ at = 2000; x = 103 },
            @{ at = 2500; x = 103 }
        )
        $script:EventBase = Fresh-Observation
        function Start-StateEventStream {
            $mock = New-Object PSObject -Property @{ IsOpen = $true; Disposed = $false }
            $mock | Add-Member ScriptMethod Take {
                if ($script:EventIndex -lt $script:EventSchedule.Count -and
                    $script:Clock.ElapsedMilliseconds - $script:EventStartTick -ge $script:EventSchedule[$script:EventIndex].at) {
                    $sample = $script:EventSchedule[$script:EventIndex]
                    $script:EventIndex++
                    $payload = @{ workpiece = @{ x = $sample.x; y = $script:EventBase.position.y } } | ConvertTo-Json -Depth 5 -Compress
                    return New-Object PathPlotterRap.StateEvent('position', $payload)
                }
                return $null
            }
            $mock | Add-Member ScriptMethod Dispose { $this.IsOpen = $false; $this.Disposed = $true }
            $position = @{ workpiece = @{ x = $script:EventBase.position.x; y = $script:EventBase.position.y } }
            return @{ stream = $mock; context = $script:EventBase.context; connected = $true; position = $position; positionTick = $script:EventBase.tick; observation = $script:EventBase }
        }
        function Read-UiCommand { if ($script:TimingClock.ElapsedMilliseconds -ge 4100) { $script:StopRequested = $true } }
        function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
            if ($Path -eq '/agent/start') { return @{ generation = 12; serverTime = 1800000000000.0 } }
            throw 'Unexpected event-stream test cloud call.'
        }
        function New-AgentSocket {
            $mock = New-Object PSObject -Property @{ IsOpen = $true; IsFinished = $false; Failure = ''; Queue = (New-Object 'Collections.Generic.Queue[string]') }
            $mock | Add-Member ScriptMethod Enqueue {
                param($text)
                $message = $text | ConvertFrom-Json
                $script:TimingMessages.Add(@{ tick = $script:TimingClock.ElapsedMilliseconds; body = $message.body })
                $result = @{ serverTime = 1800000000000.0; previewActive = [bool]$message.body.moving; pairings = @(); job = $null }
                $this.Queue.Enqueue((@{ v = 2; type = 'update-result'; id = $message.id; body = $result } | ConvertTo-Json -Depth 25 -Compress))
            }
            $mock | Add-Member ScriptMethod Take { if ($this.Queue.Count) { return $this.Queue.Dequeue() }; return $null }
            $mock | Add-Member ScriptMethod Dispose { $this.IsOpen = $false }
            return $mock
        }
        Start-Rap
        $movingMessages = @($script:TimingMessages | Where-Object { $_.body.moving })
        $settledMessages = @($script:TimingMessages | Where-Object { $_.body.settled })
        Assert ($movingMessages.Count -eq 3) ('Movement update count was ' + $movingMessages.Count + '.')
        $motionHistory = ($script:TimingMessages | ForEach-Object { '{0}ms moving={1} settled={2}' -f $_.tick, $_.body.moving, $_.body.settled }) -join ', '
        Assert ($settledMessages.Count -eq 1 -and -not $settledMessages[0].body.moving) ('The final settled update was missing or still marked moving. Updates: ' + $motionHistory)
        Assert ($settledMessages[0].tick - $movingMessages[-1].tick -ge 1900) 'The preview lease was released before two quiet seconds.'
        for ($i = 1; $i -lt $movingMessages.Count; $i++) {
            Assert ($movingMessages[$i].tick - $movingMessages[$i - 1].tick -ge 495) 'Movement updates exceeded the documented LightBurn event cadence.'
        }
        Assert ($null -eq $script:StateStream) 'RAP did not dispose the position event stream on exit.'
        function Start-StateEventStream { return $null }
    }
    Check 'Relay version refusal pauses RAP, reports Update now and backs off' {
        $script:Healths = New-Object 'Collections.Generic.List[string]'
        $script:StartBodies = New-Object 'Collections.Generic.List[object]'
        function Invoke-Cloud([string]$Path, $Body = @{}, [string]$Method = 'POST') {
            if ($Path -ceq '/agent/start') { $script:StartBodies.Add($Body); throw 'RAP_UPDATE_REQUIRED' }
            throw 'Unexpected cloud call after version refusal.'
        }
        function Publish-RapHealth([string]$Message, [bool]$Connected) { if (-not $Connected) { $script:Healths.Add($Message) } }
        $script:TimingLimit = 1500; $script:TimingClock.Restart()
        Start-Rap
        Assert ($script:StartBodies.Count -eq 1 -and $script:StartBodies[0].version -ceq $script:RapVersion)
        Assert ($script:UpdateRequired -and $script:Healths[$script:Healths.Count - 1] -match 'Update now')
        $script:UpdateRequired = $false
    }
    Check 'RAP version file is a plain semantic version' {
        Assert ($script:RapVersion -match '^\d+\.\d+\.\d+$' -and $script:RapVersion -ceq ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'version.txt')).Trim()))
    }
    Check 'Updater accepts only rap-vX.Y.Z GitHub releases, compares versions numerically and stays on GitHub HTTPS' {
        $release = ConvertTo-RapRelease @{ tag_name = 'rap-v3.10.2' }
        Assert ($release.version -ceq '3.10.2' -and $release.zipUrl -ceq 'https://github.com/nicholas-a11y/pathplotter/releases/download/rap-v3.10.2/PathPlotter-RAP-Windows.zip' -and $release.hashUrl -ceq ($release.zipUrl + '.sha256'))
        foreach ($tag in @('v3.1.0', 'rap-v3.1', 'rap-v3.1.0-beta', 'rap-v3.1.0/../x')) { Must-Throw { ConvertTo-RapRelease @{ tag_name = $tag } } }
        Assert ((Test-RapNewer '3.0.10' '3.0.9') -and -not (Test-RapNewer '3.0.0' '3.0.0') -and -not (Test-RapNewer '2.9.9' '3.0.0'))
        foreach ($url in @('https://github.com/x', 'https://api.github.com/x', 'https://objects.githubusercontent.com/x', 'https://release-assets.githubusercontent.com/x')) { Assert (Test-UpdateHost ([Uri]$url)) $url }
        foreach ($url in @('http://github.com/x', 'https://github.com.evil.example/x', 'https://evilgithubusercontent.com/x', 'https://github.com:8443/x')) { Assert (-not (Test-UpdateHost ([Uri]$url))) $url }
    }
    Check 'Updater verifies the checksum, refuses unsafe archives and replaces files with rollback' {
        $work = Join-Path ([IO.Path]::GetTempPath()) ('pathplotter-rap-test-' + [Guid]::NewGuid().ToString('N'))
        $target = Join-Path $work 'install'
        [void][IO.Directory]::CreateDirectory($target)
        try {
            Add-Type -AssemblyName System.IO.Compression
            function New-TestZip([hashtable]$Files) {
                $memory = New-Object IO.MemoryStream
                $archive = New-Object IO.Compression.ZipArchive($memory, [IO.Compression.ZipArchiveMode]::Create, $true)
                foreach ($name in $Files.Keys) {
                    $writer = New-Object IO.StreamWriter($archive.CreateEntry($name).Open())
                    try { $writer.Write($Files[$name]) } finally { $writer.Dispose() }
                }
                $archive.Dispose()
                return ,$memory.ToArray()
            }
            function Get-TestHash([byte[]]$Bytes) {
                $sha = [Security.Cryptography.SHA256]::Create()
                try { return (-join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') })) + '  PathPlotter-RAP-Windows.zip' } finally { $sha.Dispose() }
            }
            $files = @{}
            foreach ($name in $script:UpdateRequiredFiles) { $files[$name] = 'new ' + $name }
            $files['version.txt'] = '3.9.0'
            $files['Vendor/QrCodeGenerator/QrCode.cs'] = 'new vendor'
            foreach ($name in @('RAP.ps1', 'version.txt')) { [IO.File]::WriteAllText((Join-Path $target $name), 'old ' + $name) }
            $script:TestZip = New-TestZip $files
            $script:TestHash = Get-TestHash $script:TestZip
            function Invoke-UpdateDownload([string]$Url, [int]$MaxBytes) {
                if ($Url.EndsWith('.sha256')) { return ,$script:Utf8.GetBytes($script:TestHash) }
                return ,$script:TestZip
            }
            $release = ConvertTo-RapRelease @{ tag_name = 'rap-v3.9.0' }
            $good = $script:TestHash
            $script:TestHash = ('0' * 64) + '  PathPlotter-RAP-Windows.zip'
            Must-Throw { Install-RapUpdate $release $target }
            Assert ([IO.File]::ReadAllText((Join-Path $target 'RAP.ps1')) -ceq 'old RAP.ps1')
            $script:TestHash = $good
            Must-Throw { Install-RapUpdate (ConvertTo-RapRelease @{ tag_name = 'rap-v3.9.1' }) $target }
            Assert ([IO.File]::ReadAllText((Join-Path $target 'version.txt')) -ceq 'old version.txt')
            Install-RapUpdate $release $target
            Assert ([IO.File]::ReadAllText((Join-Path $target 'RAP.ps1')) -ceq 'new RAP.ps1')
            Assert ([IO.File]::ReadAllText((Join-Path $target 'version.txt')) -ceq '3.9.0')
            Assert ([IO.File]::ReadAllText((Join-Path $target 'Vendor\QrCodeGenerator\QrCode.cs')) -ceq 'new vendor')
            $unsafe = @{} + $files; $unsafe['../escape.txt'] = 'x'
            $script:TestZip = New-TestZip $unsafe; $script:TestHash = Get-TestHash $script:TestZip
            Must-Throw { Install-RapUpdate $release $target }
            Assert (-not [IO.File]::Exists((Join-Path $work 'escape.txt')))
        } finally { if ([IO.Directory]::Exists($work)) { [IO.Directory]::Delete($work, $true) } }
    }
} finally {
    if (Get-Command Stop-Import -ErrorAction SilentlyContinue) { Stop-Import }
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([IO.Directory]::Exists($statePath)) {
        try { Remove-Item -LiteralPath $statePath -Recurse -Force }
        catch {
            if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw }
            Start-Sleep -Milliseconds 50
        }
    }
}
Write-Host ("Passed $script:Passed focused checks on Windows PowerShell $($PSVersionTable.PSVersion). No hardware/cloud calls or user credential changes.")
