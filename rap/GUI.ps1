#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$LibraryOnly,
    [switch]$SmokeTest,
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'PathPlotter\RAP')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Initialize-DesktopTypes {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    if (-not ('PathPlotterRap.UiBridge' -as [type])) {
        $compiler = New-Object CodeDom.Compiler.CompilerParameters
        $compiler.GenerateInMemory = $true
        $compiler.TempFiles = New-Object CodeDom.Compiler.TempFileCollection($PSScriptRoot, $false)
        foreach ($assembly in @('System.dll', 'System.Core.dll', 'System.Drawing.dll')) { [void]$compiler.ReferencedAssemblies.Add($assembly) }
        try { Add-Type -Path (Join-Path $PSScriptRoot 'Desktop.cs') -CompilerParameters $compiler }
        finally { $compiler.TempFiles.Delete() }
    }
    if (-not ('Net.Codecrete.QrCodeGenerator.QrCode' -as [type])) {
        # The MIT encoder is bundled unmodified. Lower C#6 syntax for PS5's C#5
        # compiler in memory, without altering its QR algorithm or source files.
        $sources = foreach ($name in @('BitArrayExtensions', 'DataTooLongException', 'Objects', 'QrCode', 'QrSegment', 'ReedSolomonGenerator')) {
            $text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot ('Vendor\QrCodeGenerator\' + $name + '.cs')))
            $text = [regex]::Replace($text, 'nameof\((\w+)\)', '"$1"')
            $text = [regex]::Replace($text, '(?<=\d)_(?=\d)', '')
            $text = $text.Replace('{ get; }', '{ get; private set; }')
            $text = $text.Replace('$"Data length = {dataUsedBits} bits, Max capacity = {numDataBits} bits"', 'String.Format("Data length = {0} bits, Max capacity = {1} bits", dataUsedBits, numDataBits)')
            $text = $text.Replace('$"<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 {dim} {dim}\" stroke=\"none\">\n"', 'String.Format("<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 {0} {0}\" stroke=\"none\">\n", dim)')
            $text = $text.Replace('$"\t<rect width=\"100%\" height=\"100%\" fill=\"{background}\"/>\n"', 'String.Format("\t<rect width=\"100%\" height=\"100%\" fill=\"{0}\"/>\n", background)')
            $text = $text.Replace('$"M{x + border},{y + border}h1v1h-1z"', 'String.Format("M{0},{1}h1v1h-1z", x + border, y + border)')
            $text.Replace('$"\" fill=\"{foreground}\"/>\n"', 'String.Format("\" fill=\"{0}\"/>\n", foreground)')
        }
        # Separate compilation units keep upstream using directives legal.
        $compiler = New-Object CodeDom.Compiler.CompilerParameters
        $compiler.GenerateInMemory = $true
        $compiler.TempFiles = New-Object CodeDom.Compiler.TempFileCollection($PSScriptRoot, $false)
        foreach ($assembly in @('System.dll', 'System.Core.dll', 'System.Drawing.dll')) { [void]$compiler.ReferencedAssemblies.Add($assembly) }
        $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
        try {
            $result = $provider.CompileAssemblyFromSource($compiler, [string[]]$sources)
            if ($result.Errors.HasErrors) { throw ('Bundled QR encoder could not be compiled: ' + (($result.Errors | ForEach-Object { $_.ToString() }) -join '; ')) }
            $null = $result.CompiledAssembly
        } finally {
            $files = @($compiler.TempFiles)
            $provider.Dispose()
            $compiler.TempFiles.Delete()
            foreach ($file in $files) {
                for ($attempt = 0; $attempt -lt 20 -and [IO.File]::Exists($file); $attempt++) {
                    try { [IO.File]::Delete($file) } catch { Start-Sleep -Milliseconds 50 }
                }
            }
        }
    }
}

function New-InvitationBitmap([string]$Url) {
    if ($Url -notmatch '^https://nicholas-a11y\.github\.io/pathplotter/#relay=[^&]+&relayId=[^&]+&invite=[^&]+$' -or $Url.Length -gt 4096) { throw 'Only ordinary phone invitations can be QR encoded.' }
    $qr = [Net.Codecrete.QrCodeGenerator.QrCode]::EncodeText($Url, [Net.Codecrete.QrCodeGenerator.QrCode+Ecc]::Medium)
    return $qr.ToBitmap(4, 4)
}

function Get-ActivationKey([string]$Directory) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($sid + '|' + [IO.Path]::GetFullPath($Directory).TrimEnd('\').ToUpperInvariant())
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
    } finally { $sha.Dispose() }
}

function New-UiButton([string]$Text, $Command) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $Text; $button.AutoSize = $true; $button.Tag = $Command
    $button.Add_Click({
        param($sender, $eventArgs)
        if (Submit-Ui $sender.Tag) { $sender.Enabled = $false }
    })
    return $button
}

function Submit-Ui($Command) {
    if ($script:Desktop.closing -or $script:Desktop.busy) { return $false }
    $script:Desktop.busy = $true
    $script:Desktop.notice.Text = ''
    $script:Desktop.bridge.Commands.Enqueue($Command)
    return $true
}

function Show-RapWindow {
    $form = $script:Desktop.form
    $form.Show(); $form.WindowState = 'Normal'
    [void]$form.Activate()
}

function Clear-Phone {
    $d = $script:Desktop
    if ($null -eq $d.phone) { return }
    if ($null -ne $d.phoneImage) { $d.phonePicture.Image = $null; $d.phoneImage.Dispose(); $d.phoneImage = $null }
    try {
        if ([Windows.Forms.Clipboard]::ContainsText() -and [Windows.Forms.Clipboard]::GetText() -ceq $d.phoneUrl) { [Windows.Forms.Clipboard]::Clear() }
    } catch { }
    $d.phoneUrl = ''; $d.phoneLink.Clear(); $d.phoneCopy.Enabled = $false
    $d.phoneExpiry.Text = 'Invitation expired or closed. Create a new invitation to pair.'
}

function Show-Phone($Value) {
    $d = $script:Desktop
    if ($null -ne $d.phone) { Clear-Phone; $d.phone.Dispose() }
    $d.phone = New-Object Windows.Forms.Form
    $d.phone.Text = 'Pair phone - private invitation'; $d.phone.ClientSize = New-Object Drawing.Size(500, 580)
    $panel = New-Object Windows.Forms.FlowLayoutPanel
    $panel.Dock = 'Fill'; $panel.FlowDirection = 'TopDown'; $panel.WrapContents = $false; $panel.AutoScroll = $true
    $d.phone.Controls.Add($panel)
    $label = New-Object Windows.Forms.Label
    $label.Text = 'Scan with your phone. Compare its phrase here before approving. Do not share this QR/link or screenshots.'
    $label.Size = New-Object Drawing.Size(470, 55); $panel.Controls.Add($label)
    $d.phoneUrl = $Value.url
    $d.phoneImage = New-InvitationBitmap $Value.url
    $d.phonePicture = New-Object Windows.Forms.PictureBox
    $d.phonePicture.Size = New-Object Drawing.Size(470, 370); $d.phonePicture.SizeMode = 'Zoom'; $d.phonePicture.Image = $d.phoneImage
    $panel.Controls.Add($d.phonePicture)
    $d.phoneLink = New-Object Windows.Forms.TextBox
    $d.phoneLink.ReadOnly = $true; $d.phoneLink.Width = 470; $d.phoneLink.Text = $Value.url; $panel.Controls.Add($d.phoneLink)
    $d.phoneCopy = New-Object Windows.Forms.Button
    $d.phoneCopy.Text = 'Copy private phone link'; $d.phoneCopy.AutoSize = $true
    $d.phoneCopy.Add_Click({ if ($script:Desktop.phoneUrl) { [Windows.Forms.Clipboard]::SetText($script:Desktop.phoneUrl) } })
    $panel.Controls.Add($d.phoneCopy)
    $d.phoneExpiry = New-Object Windows.Forms.Label
    $d.phoneExpiry.Size = New-Object Drawing.Size(470, 35); $panel.Controls.Add($d.phoneExpiry)
    $d.phoneDeadline = $d.clock.ElapsedMilliseconds + $Value.remainingMs
    $d.phone.Add_FormClosed({ Clear-Phone })
    $d.phone.Show($d.form)
}

function Show-Approvals($Pairings) {
    $d = $script:Desktop
    $signature = ($Pairings.Keys | Sort-Object | ForEach-Object { $_ + ':' + $Pairings[$_] }) -join '|'
    $d.pairings = $Pairings
    if ($signature -ceq $d.pairingSignature) { return }
    $d.pairingSignature = $signature
    while ($d.approvals.Controls.Count -gt 0) { $d.approvals.Controls[0].Dispose() }
    foreach ($id in ($Pairings.Keys | Sort-Object)) {
        $card = New-Object Windows.Forms.FlowLayoutPanel
        $card.Size = New-Object Drawing.Size(565, 90); $card.FlowDirection = 'LeftToRight'
        $phrase = New-Object Windows.Forms.Label
        $phrase.Text = 'Compare the exact phrase on the requesting browser:' + [Environment]::NewLine + $Pairings[$id]
        $phrase.Size = New-Object Drawing.Size(545, 45); $card.Controls.Add($phrase)
        $approve = New-UiButton 'Approve matching phrase' @{ action = 'decide'; id = $id; phrase = $Pairings[$id]; approve = $true }
        $reject = New-UiButton 'Reject' @{ action = 'decide'; id = $id; phrase = $Pairings[$id]; approve = $false }
        $card.Controls.Add($approve); $card.Controls.Add($reject); $d.approvals.Controls.Add($card)
    }
    if ($Pairings.Count -gt 0) {
        Show-RapWindow
        $d.tray.ShowBalloonTip(3000, 'Browser approval requested', 'Compare the exact phrase in RAP. Approve only a browser you recognize.', [Windows.Forms.ToolTipIcon]::Info)
    }
}

function Show-Browsers($Rows) {
    $d = $script:Desktop
    if ($null -ne $d.browsers) { $d.browsers.Dispose() }
    $d.browsers = New-Object Windows.Forms.Form
    $d.browsers.Text = 'Connected browsers'; $d.browsers.ClientSize = New-Object Drawing.Size(440, 300)
    $panel = New-Object Windows.Forms.FlowLayoutPanel
    $panel.Dock = 'Fill'; $panel.AutoScroll = $true; $panel.FlowDirection = 'TopDown'; $panel.WrapContents = $false
    $d.browsers.Controls.Add($panel)
    foreach ($row in $Rows) {
        $button = New-Object Windows.Forms.Button
        $button.AutoSize = $true; $button.Text = 'Revoke: ' + $row.label; $button.Tag = $row.id
        $button.Add_Click({
            param($sender, $eventArgs)
            if ([Windows.Forms.MessageBox]::Show('Revoke this browser? Its relay access will stop.', 'Revoke browser', 'YesNo', 'Warning') -eq 'Yes') {
                if (Submit-Ui @{ action = 'revoke'; id = $sender.Tag }) { $sender.Enabled = $false }
            }
        })
        $panel.Controls.Add($button)
    }
    if (@($Rows).Count -eq 0) {
        $label = New-Object Windows.Forms.Label
        $label.Text = 'No approved browsers.'; $label.AutoSize = $true; $panel.Controls.Add($label)
    }
    $d.browsers.Show($d.form)
}

function Handle-UiEvent($Event) {
    $d = $script:Desktop
    switch -CaseSensitive ($Event.kind) {
        'setup' {
            $d.busy = $false; $d.setup.Visible = $true; $d.register.Enabled = $true
            $d.enrollment.Visible = $false
            if ($null -ne $Event.value) { $d.api.Text = $Event.value.apiRoot; $d.name.Text = $Event.value.name }
            $d.status.Text = 'Guided setup: choose a computer name, then register in your browser. Leave invitation blank. Advanced relay override and existing operator invitations remain available.'
            Show-RapWindow
        }
        'enrollment' {
            $d.busy = $false; $d.setup.Visible = $false; $d.enrollment.Visible = $true
            $d.enrollmentPhrase = $Event.value.phrase
            $d.enrollmentText.Text = 'Enrollment phrase: ' + $Event.value.phrase + '. Compare it with the browser for this computer. Never approve a different phrase or an unsolicited request.'
            $d.confirmEnrollment.Enabled = $true
            $d.status.Text = 'Browser setup opened. Complete its verification and explicit approval. Confirm the matching phrase below to finish on this computer.'
            if (-not $d.smoke) {
                try { Start-Process -FilePath $Event.value.url }
                catch { $d.notice.Text = 'Windows could not open your browser. Retry setup explicitly; the enrollment verifier is protected for recovery.' }
            }
            Show-RapWindow
        }
        'consent' {
            $d.busy = $false; $d.setup.Visible = $false; $d.consent.Visible = $true; $d.consent.Enabled = $true
            $d.status.Text = 'Open LightBurn, enable REST API in Settings > Extensions, keep network API access disabled. Click below, bring LightBurn forward, then approve its own dialog within 30 seconds.'
            Show-RapWindow
        }
        'configured' { $d.configured = $true; $d.busy = $false; $d.setup.Visible = $false; $d.enrollment.Visible = $false; $d.consent.Visible = $false; $d.status.Text = 'Connecting to LightBurn and relay...' }
        'recovery' {
            $d.busy = $false; $d.recovery.Visible = $true
            $d.status.Text = 'Saved registration is invalid or unreadable. Replace only local credentials with explicit consent below. The import journal is preserved; ask the operator to revoke the old agent credential and revoke the old LightBurn entry.'
            Show-RapWindow
        }
        'health' {
            $d.healthy = $Event.value.connected
            $d.importing = [bool]$Event.value.importing
            $d.activeSlowHttp = [bool]$Event.value.slowHttp
            $d.status.Text = $(if ($d.healthy) { 'Connected' } else { 'Reconnecting / not ready' }) +
                ' - ' + $(if ($d.activeSlowHttp) { 'HTTP compatibility mode' } else { 'WebSockets' }) + '. ' + $Event.value.message
            if ($Event.value.importing) { $d.status.Text += ' Import in progress; never automatically retried.' }
            $d.tray.Text = 'PathPlotter RAP - ' + $(if ($d.healthy) { 'Connected' } else { 'Not ready' })
            if (-not $d.healthy) { Show-Approvals @{} }
        }
        'transport' {
            $d.activeSlowHttp = [bool]$Event.value
            $d.healthy = $false
            $d.status.Text = 'Reconnecting - ' + $(if ($d.activeSlowHttp) { 'HTTP compatibility mode' } else { 'WebSockets' }) + '.'
        }
        'desktop' {
            # Never place launch grants in labels, clipboard, QR, logs or saved state.
            if ($d.smoke) { $d.smokeOpens++ }
            else {
                try { Start-Process -FilePath $Event.value }
                catch { $d.status.Text = 'Windows could not open the default browser. Check the default HTTPS app, then click Open PathPlotter.'; Show-RapWindow }
            }
            $Event.value = $null
        }
        'phone' { Show-Phone $Event.value; $d.smokePhones++ }
        'code-window' {
            $d.codeId = $Event.value.id; $d.codeDeadline = $d.clock.ElapsedMilliseconds + $Event.value.remainingMs
            $d.codeText.Text = $Event.value.code
            $d.codeStatus.Text = 'Code window requested. Cancel is best effort; completed browser access must be revoked separately.'
        }
        'code-status' {
            if ($d.codeId -ceq $Event.value.id -and $Event.value.status -cne 'waiting') {
                $d.codeText.Text = ''; $d.codeId = ''
                $d.codeStatus.Text = $(if ($Event.value.status -in @('claimed', 'complete')) { 'Code claimed. Check Connected browsers; access persists until revoked.' } else { 'Code window ' + $Event.value.status + '.' })
            }
        }
        'pairings' { Show-Approvals $Event.value }
        'browsers' { Show-Browsers $Event.value }
        'action-complete' {
            $d.busy = $false; $d.pairingSignature = $null
            Show-Approvals $d.pairings
        }
        'notice' { $d.notice.Text = $Event.value; Show-RapWindow }
        'fatal' { $d.status.Text = $Event.value; $d.failed = $true; Show-RapWindow }
        'fixture' { $d.fixtureEvents.Add($Event.value) }
        'stopped' {
            $d.stopped = $true; $d.busy = $false; $d.healthy = $false
            if ($d.closing) { $d.form.Close() }
            else { $d.status.Text += ' RAP stopped. Quit and restart after correcting the issue.'; Show-RapWindow }
        }
    }
}

function Request-RapQuit {
    $d = $script:Desktop
    $d.closing = $true; $d.bridge.StopRequested = $true
    $d.status.Text = 'Stopping safely. Waiting for bounded requests; incomplete imports are fenced and journaled, never resent.'
    Show-RapWindow
    if ($d.stopped) { $d.form.Close() }
}

function Start-RapDesktop {
    if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Start RAP GUI with Windows PowerShell -STA.' }
    Initialize-DesktopTypes
    [Windows.Forms.Application]::EnableVisualStyles()
    $activation = New-Object PathPlotterRap.Activation((Get-ActivationKey $DataDirectory))
    if (-not $activation.Owner) {
        try {
            if (-not $activation.Signal()) { throw 'The running RAP could not be activated. Wait for startup/shutdown; do not delete its instance lock.' }
        } finally { $activation.Dispose() }
        return
    }
    $d = @{
        bridge = (New-Object PathPlotterRap.UiBridge); clock = [Diagnostics.Stopwatch]::StartNew()
        activation = $activation; configured = $false; healthy = $false; busy = $false; closing = $false; stopped = $false; failed = $false
        phone = $null; phoneImage = $null; phoneUrl = ''; phoneDeadline = 0L; browsers = $null
        codeId = ''; codeDeadline = 0L
        pairings = @{}; pairingSignature = ''; smoke = [bool]$SmokeTest; smokeOpens = 0; smokePhones = 0; smokeStage = 0; smokeConsentTicks = 0
        fixtureEvents = (New-Object 'Collections.Generic.List[string]')
    }
    $script:Desktop = $d
    $worker = $null; $runspace = $null; $async = $null
    try {
        $d.form = New-Object Windows.Forms.Form
        $d.form.Text = 'PathPlotter RAP'; $d.form.ClientSize = New-Object Drawing.Size(610, 680)
        $d.form.StartPosition = 'CenterScreen'; $d.form.MinimumSize = New-Object Drawing.Size(630, 500)
        $layout = New-Object Windows.Forms.FlowLayoutPanel
        $layout.Dock = 'Fill'; $layout.FlowDirection = 'TopDown'; $layout.WrapContents = $false; $layout.AutoScroll = $true
        $d.form.Controls.Add($layout)
        $d.status = New-Object Windows.Forms.Label
        $d.status.Text = 'Starting RAP...'; $d.status.Size = New-Object Drawing.Size(585, 100); $layout.Controls.Add($d.status)
        $d.notice = New-Object Windows.Forms.Label
        $d.notice.Size = New-Object Drawing.Size(585, 70); $d.notice.ForeColor = [Drawing.Color]::DarkRed; $layout.Controls.Add($d.notice)
        $actions = New-Object Windows.Forms.FlowLayoutPanel
        $actions.Size = New-Object Drawing.Size(585, 45); $layout.Controls.Add($actions)
        $d.open = New-UiButton 'Open PathPlotter' @{ action = 'open' }
        $d.pair = New-UiButton 'Pair phone' @{ action = 'phone' }
        $d.list = New-UiButton 'Connected browsers' @{ action = 'browsers' }
        foreach ($button in @($d.open, $d.pair, $d.list)) { $button.Enabled = $false; $actions.Controls.Add($button) }
        $codePanel = New-Object Windows.Forms.FlowLayoutPanel
        $codePanel.Size = New-Object Drawing.Size(580, 165); $codePanel.FlowDirection = 'TopDown'; $codePanel.WrapContents = $false
        $codeHelp = New-Object Windows.Forms.Label
        $codeHelp.Text = 'Website-first pairing: explicitly allow a 60-second code window, then enter its three letters in PathPlotter Connection. Anyone who knows or guesses this short code can gain saved access. Use Pair phone with desktop approval for stronger protection.'
        $codeHelp.Size = New-Object Drawing.Size(560, 60); $codePanel.Controls.Add($codeHelp)
        $codeActions = New-Object Windows.Forms.FlowLayoutPanel
        $codeActions.Size = New-Object Drawing.Size(560, 35)
        $d.codeNew = New-UiButton 'Allow code pairing' @{ action = 'code-new' }
        $d.codeCancel = New-UiButton 'Cancel code' @{ action = 'code-cancel' }
        $d.codeNew.Enabled = $false; $d.codeCancel.Enabled = $false
        $codeActions.Controls.Add($d.codeNew); $codeActions.Controls.Add($d.codeCancel); $codePanel.Controls.Add($codeActions)
        $d.codeText = New-Object Windows.Forms.Label
        $d.codeText.Size = New-Object Drawing.Size(560, 25); $d.codeText.Font = New-Object Drawing.Font('Segoe UI', 14, [Drawing.FontStyle]::Bold)
        $codePanel.Controls.Add($d.codeText)
        $d.codeStatus = New-Object Windows.Forms.Label
        $d.codeStatus.Size = New-Object Drawing.Size(560, 35); $d.codeStatus.Text = 'Not enabled. Requires operator opt-in and browser verification.'
        $codePanel.Controls.Add($d.codeStatus); $layout.Controls.Add($codePanel)
        $d.setup = New-Object Windows.Forms.FlowLayoutPanel
        $d.setup.Size = New-Object Drawing.Size(580, 255); $d.setup.FlowDirection = 'TopDown'; $d.setup.WrapContents = $false; $d.setup.Visible = $false
        $layout.Controls.Add($d.setup)
        foreach ($field in @(@('HTTPS relay origin (advanced override)', 'api'), @('Computer name', 'name'), @('Optional existing operator invitation (blank for guided setup)', 'invitation'))) {
            $label = New-Object Windows.Forms.Label
            $label.Text = $field[0]; $label.AutoSize = $true; $d.setup.Controls.Add($label)
            $box = New-Object Windows.Forms.TextBox
            $box.Width = 560; $d[$field[1]] = $box; $d.setup.Controls.Add($box)
        }
        $d.name.Text = $env:COMPUTERNAME; $d.invitation.UseSystemPasswordChar = $true
        $d.api.Text = 'https://pathplotter-relay-test.nicholas-leqeta.workers.dev'; $d.api.ReadOnly = $true
        $d.override = New-Object Windows.Forms.CheckBox
        $d.override.Text = 'Advanced: override relay origin'; $d.override.AutoSize = $true
        $d.override.Add_CheckedChanged({ $script:Desktop.api.ReadOnly = -not $script:Desktop.override.Checked })
        $d.setup.Controls.Add($d.override)
        $d.register = New-Object Windows.Forms.Button
        $d.register.Text = 'Register this computer'; $d.register.AutoSize = $true
        $d.register.Add_Click({
            $s = $script:Desktop
            if (Submit-Ui @{ action = 'register'; api = $s.api.Text.Trim(); name = $s.name.Text.Trim(); invitation = $s.invitation.Text }) {
                $s.invitation.Clear(); $s.register.Enabled = $false; $s.status.Text = 'Registering... Do not repeat an ambiguous request automatically.'
            }
        })
        $d.setup.Controls.Add($d.register)
        $discard = New-Object Windows.Forms.Button
        $discard.Text = 'Discard expired enrollment setup...'; $discard.AutoSize = $true
        $discard.Add_Click({
            if ([Windows.Forms.MessageBox]::Show('Discard only the protected pending enrollment verifier? Any ambiguous completed registration will no longer be recoverable through this verifier. Use only for expired or cancelled setup. Existing credentials and import journal are untouched.', 'Discard pending setup', 'YesNo', 'Warning') -eq 'Yes') {
                [void](Submit-Ui @{ action = 'discard-enrollment' })
            }
        })
        $d.setup.Controls.Add($discard)
        $d.enrollment = New-Object Windows.Forms.FlowLayoutPanel
        $d.enrollment.Size = New-Object Drawing.Size(580, 120); $d.enrollment.Visible = $false
        $d.enrollmentText = New-Object Windows.Forms.Label
        $d.enrollmentText.Size = New-Object Drawing.Size(560, 65); $d.enrollment.Controls.Add($d.enrollmentText)
        $d.confirmEnrollment = New-Object Windows.Forms.Button
        $d.confirmEnrollment.Text = 'Confirm exact matching enrollment phrase'; $d.confirmEnrollment.AutoSize = $true
        $d.confirmEnrollment.Add_Click({
            $s = $script:Desktop
            if ([Windows.Forms.MessageBox]::Show('Only continue if your browser shows "' + $s.enrollmentPhrase + '" for this computer and you explicitly approved that request. Never approve an unsolicited enrollment.', 'Confirm enrollment', 'YesNo', 'Warning') -eq 'Yes') {
                if (Submit-Ui @{ action = 'confirm-enrollment'; phrase = $s.enrollmentPhrase }) { $s.confirmEnrollment.Enabled = $false; $s.status.Text = 'Waiting for browser approval (setup checks at least 5 seconds apart)...' }
            }
        })
        $d.enrollment.Controls.Add($d.confirmEnrollment); $layout.Controls.Add($d.enrollment)
        $d.importing = $false; $d.activeSlowHttp = $false
        $advanced = New-Object Windows.Forms.CheckBox
        $advanced.Text = 'Advanced connection settings'; $advanced.AutoSize = $true
        $d.transportPanel = New-Object Windows.Forms.FlowLayoutPanel
        $d.transportPanel.Size = New-Object Drawing.Size(580, 155)
        $d.transportPanel.FlowDirection = 'TopDown'; $d.transportPanel.WrapContents = $false
        $d.transportPanel.Visible = $false
        $advanced.Add_CheckedChanged({ param($sender, $eventArgs) $script:Desktop.transportPanel.Visible = $sender.Checked })
        $layout.Controls.Add($advanced)
        $d.socketChoice = New-Object Windows.Forms.RadioButton
        $d.socketChoice.Text = 'WebSockets (recommended; reconnects automatically)'
        $d.socketChoice.AutoSize = $true; $d.socketChoice.Checked = $true
        $d.httpChoice = New-Object Windows.Forms.RadioButton
        $d.httpChoice.Text = 'Compatibility mode - slower HTTP'
        $d.httpChoice.AutoSize = $true
        $d.transportPanel.Controls.Add($d.socketChoice); $d.transportPanel.Controls.Add($d.httpChoice)
        $help = New-Object Windows.Forms.Label
        $help.Text = 'Use HTTP only if your network blocks WebSockets. Updates and approvals may take longer. Select the same mode in PathPlotter. No automatic HTTP fallback or import retries.'
        $help.Size = New-Object Drawing.Size(555, 48); $d.transportPanel.Controls.Add($help)
        $d.applyTransport = New-Object Windows.Forms.Button
        $d.applyTransport.Text = 'Apply'; $d.applyTransport.AutoSize = $true; $d.applyTransport.Enabled = $false
        $d.applyTransport.Add_Click({
            $s = $script:Desktop
            if ($s.importing) { $s.notice.Text = 'Wait for the current import outcome before changing connection settings.'; return }
            [void](Submit-Ui @{ action = $(if ($s.httpChoice.Checked) { 'slow-http' } else { 'socket' }) })
        })
        $d.transportPanel.Controls.Add($d.applyTransport)
        $layout.Controls.Add($d.transportPanel)
        $d.consent = New-UiButton 'Request local LightBurn permission (state, project, upload)' @{ action = 'consent' }
        $d.consent.Visible = $false; $layout.Controls.Add($d.consent)
        $d.recovery = New-Object Windows.Forms.Button
        $d.recovery.Text = 'Replace invalid local registration...'; $d.recovery.AutoSize = $true; $d.recovery.Visible = $false
        $d.recovery.Add_Click({
            if ([Windows.Forms.MessageBox]::Show('Forget the unreadable/invalid local credentials and register again? Remote permissions must be revoked separately. The import journal will not be removed.', 'Replace invalid registration', 'YesNo', 'Warning') -eq 'Yes') {
                if (Submit-Ui @{ action = 'reset-registration' }) { $script:Desktop.recovery.Visible = $false }
            }
        })
        $layout.Controls.Add($d.recovery)
        $d.approvals = New-Object Windows.Forms.FlowLayoutPanel
        $d.approvals.Size = New-Object Drawing.Size(585, 250); $d.approvals.FlowDirection = 'TopDown'; $d.approvals.WrapContents = $false; $d.approvals.AutoScroll = $true
        $layout.Controls.Add($d.approvals)
        $safety = New-Object Windows.Forms.Label
        $safety.Text = 'Send imports SVG only. RAP never jogs, fires or starts the laser. Closing this window keeps RAP in the tray. Choose Quit to stop.'
        $safety.Size = New-Object Drawing.Size(585, 45); $layout.Controls.Add($safety)
        $d.tray = New-Object Windows.Forms.NotifyIcon
        $d.tray.Icon = [Drawing.SystemIcons]::Application; $d.tray.Text = 'PathPlotter RAP - Starting'; $d.tray.Visible = $true
        $menu = New-Object Windows.Forms.ContextMenuStrip
        $d.tray.ContextMenuStrip = $menu
        foreach ($item in @(@('Open PathPlotter', 'open'), @('Pair phone', 'phone'), @('Connected browsers', 'browsers'))) {
            $entry = $menu.Items.Add($item[0]); $entry.Tag = @{ action = $item[1] }
            $entry.Add_Click({ param($sender, $eventArgs) [void](Submit-Ui $sender.Tag) })
            $d['menu-' + $item[1]] = $entry; $entry.Enabled = $false
        }
        $entry = $menu.Items.Add('Status'); $entry.Add_Click({ Show-RapWindow })
        foreach ($item in @(@('Forget LightBurn permission...', 'forget-lightburn'), @('Forget local registration...', 'forget-relay'))) {
            $entry = $menu.Items.Add($item[0]); $entry.Tag = @{ action = $item[1] }
            $d['menu-' + $item[1]] = $entry; $entry.Enabled = $false
            $entry.Add_Click({
                param($sender, $eventArgs)
                if ([Windows.Forms.MessageBox]::Show('Forget local credentials and stop RAP? This does not revoke remote permissions. The import journal will be preserved.', 'Explicit permission reset', 'YesNo', 'Warning') -eq 'Yes') {
                    [void](Submit-Ui $sender.Tag)
                }
            })
        }
        $entry = $menu.Items.Add('Quit'); $entry.Add_Click({ Request-RapQuit })
        $d.tray.Add_DoubleClick({ Show-RapWindow })
        $d.form.Add_FormClosing({
            param($sender, $eventArgs)
            if (-not $script:Desktop.stopped) {
                $eventArgs.Cancel = $true
                if ($eventArgs.CloseReason -in @('WindowsShutDown', 'TaskManagerClosing')) { Request-RapQuit }
                elseif ($script:Desktop.closing) { Show-RapWindow } else { $sender.Hide() }
            }
        })
        $runspace = [Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        $runspace.ApartmentState = 'MTA'; $runspace.ThreadOptions = 'ReuseThread'; $runspace.Open()
        $worker = [Management.Automation.PowerShell]::Create(); $worker.Runspace = $runspace
        [void]$worker.AddCommand((Join-Path $PSScriptRoot 'GUIWorker.ps1')).AddParameter('Bridge', $d.bridge).AddParameter('DataDirectory', $DataDirectory).AddParameter('Fixture', [bool]$SmokeTest)
        $async = $worker.BeginInvoke()
        $d.async = $async
        $d.timer = New-Object Windows.Forms.Timer
        $d.timer.Interval = 100
        $d.timer.Add_Tick({
            try {
                $s = $script:Desktop
                if ($s.async.IsCompleted -and -not $s.stopped -and $s.bridge.Events.IsEmpty) {
                    Handle-UiEvent @{ kind = 'fatal'; value = 'RAP worker could not start. Check portable files and script policy using the diagnostic launcher.' }
                    Handle-UiEvent @{ kind = 'stopped' }
                }
                if ($s.activation.TakeActivation()) { Show-RapWindow }
                for ($i = 0; $i -lt 32; $i++) {
                    $event = $null
                    if (-not $s.bridge.Events.TryDequeue([ref]$event)) { break }
                    Handle-UiEvent $event
                }
                foreach ($control in @($s.open, $s.pair, $s['menu-open'], $s['menu-phone'])) {
                    $control.Enabled = $s.healthy -and -not $s.busy -and -not $s.closing -and -not $s.stopped
                }
                foreach ($control in @($s.list, $s['menu-browsers'], $s['menu-forget-lightburn'], $s['menu-forget-relay'])) {
                    $control.Enabled = $s.configured -and -not $s.busy -and -not $s.closing -and -not $s.stopped
                }
                $s.applyTransport.Enabled = $s.configured -and -not $s.importing -and -not $s.busy -and
                    -not $s.closing -and -not $s.stopped -and ($s.httpChoice.Checked -ne $s.activeSlowHttp)
                $s.codeNew.Enabled = $s.healthy -and -not $s.importing -and -not $s.busy -and -not $s.closing -and -not $s.stopped
                $s.codeCancel.Enabled = [bool]$s.codeId -and -not $s.busy -and -not $s.closing -and -not $s.stopped
                if ($s.codeId) {
                    $remaining = $s.codeDeadline - $s.clock.ElapsedMilliseconds
                    if ($remaining -le 0) { $s.codeText.Text = ''; $s.codeId = ''; $s.codeStatus.Text = 'Code window expired. No new code was generated.' }
                    elseif (-not $s.healthy) { $s.codeText.Text = ''; $s.codeStatus.Text = 'Disconnected; cancellation unconfirmed. Server expiry remains in effect.' }
                    else { $s.codeStatus.Text = 'Expires in ' + [Math]::Ceiling($remaining / 1000) + ' seconds. Pairing saves access until revoked.' }
                }
                if ($null -ne $s.phone -and $s.phoneUrl) {
                    $remaining = $s.phoneDeadline - $s.clock.ElapsedMilliseconds
                    if ($remaining -le 0) { Clear-Phone }
                    else { $s.phoneExpiry.Text = 'Expires in ' + [Math]::Ceiling($remaining / 1000) + ' seconds.' }
                }
                if ($s.smoke) {
                    if ($s.busy -and $s.consent.Visible) { $s.smokeConsentTicks++ }
                    Step-GuiSmoke
                }
            } catch {
                $script:Desktop.failed = $true
                $script:Desktop.status.Text = 'RAP UI failed. Stopping safely; no import will be retried.'
                Request-RapQuit
            }
        })
        $d.timer.Start()
        [Windows.Forms.Application]::Run($d.form)
        $d.bridge.StopRequested = $true
        if ($null -ne $async) { $null = $worker.EndInvoke($async) }
        if ($worker.HadErrors) { throw 'RAP worker failed; no secret error details are displayed.' }
        if ($SmokeTest) { Assert-GuiSmoke }
    } finally {
        $d.bridge.StopRequested = $true
        # Do not abruptly kill the worker: its finally block fences/journals work.
        if ($null -ne $worker) {
            if ($null -ne $async -and -not $async.IsCompleted) { $null = $worker.EndInvoke($async) }
            $worker.Dispose()
        }
        if ($null -ne $runspace) { $runspace.Dispose() }
        if ($d.ContainsKey('timer')) { $d.timer.Stop(); $d.timer.Dispose() }
        Clear-Phone
        if ($null -ne $d.phone) { $d.phone.Dispose() }
        if ($null -ne $d.browsers) { $d.browsers.Dispose() }
        if ($d.ContainsKey('tray')) { $d.tray.Visible = $false; $d.tray.Dispose() }
        if ($d.ContainsKey('form')) { $d.form.Dispose() }
        $activation.Dispose()
    }
}

function Step-GuiSmoke {
    $s = $script:Desktop
    if ($s.clock.ElapsedMilliseconds -gt 20000) { $s.failed = $true; Request-RapQuit; return }
    switch ($s.smokeStage) {
        0 { if ($s.setup.Visible) { [void](Submit-Ui @{ action = 'register'; api = 'https://fixture.invalid'; name = 'Fixture PC'; invitation = '' }); $s.smokeStage = 1 } }
        1 { if ($s.enrollment.Visible -and -not $s.busy) { [void](Submit-Ui @{ action = 'confirm-enrollment'; phrase = $s.enrollmentPhrase }); $s.smokeStage = 8 } }
        8 { if ($s.consent.Visible) { [void](Submit-Ui @{ action = 'consent' }); $s.smokeStage = 2 } }
        2 {
            if ($s.consent.Visible -and -not $s.busy -and $s.fixtureEvents.Contains('consent-denied')) {
                [void](Submit-Ui @{ action = 'consent' })
            }
            if ($s.healthy -and $s.smokeOpens -eq 1 -and -not $s.busy) { [void](Submit-Ui @{ action = 'phone' }); $s.smokeStage = 3 }
        }
        3 {
            if ($s.smokePhones -eq 1 -and $s.pairings.ContainsKey('fixture-pair') -and -not $s.busy) {
                [void](Submit-Ui @{ action = 'decide'; id = 'fixture-pair'; phrase = 'WRONG PHRASE'; approve = $true })
                $s.smokeStage = 4
            }
        }
        4 {
            if (-not $s.busy) {
                [void](Submit-Ui @{ action = 'decide'; id = 'fixture-pair'; phrase = 'AMBER RIVER'; approve = $false })
                $s.smokeStage = 5
            }
        }
        5 {
            if (-not $s.busy -and $s.fixtureEvents.Contains('reject')) {
                $duplicate = New-Object PathPlotterRap.Activation((Get-ActivationKey $DataDirectory))
                try { if ($duplicate.Owner -or -not $duplicate.Signal()) { throw 'Duplicate activation failed.' } }
                finally { $duplicate.Dispose() }
                $s.phoneDeadline = 0
                $s.smokeStage = 6
            }
        }
        6 {
            if (-not $s.phoneUrl -and -not $s.busy) {
                if (-not $s.socketChoice.Checked -or $s.activeSlowHttp) { throw 'WebSockets must be the default.' }
                $s.transportPanel.Visible = $true
                $s.httpChoice.Checked = $true
                if ($s.activeSlowHttp) { throw 'Selecting a radio button must not change transport.' }
                $s.smokeStage = 9
            }
        }
        9 {
            if ($s.applyTransport.Enabled) { $s.applyTransport.PerformClick(); $s.smokeStage = 10 }
        }
        10 {
            if ($s.activeSlowHttp -and -not $s.busy) {
                $s.importing = $true
                $s.applyTransport.Enabled = $false
                $s.socketChoice.Checked = $true
                $s.applyTransport.PerformClick()
                if (-not $s.activeSlowHttp -or $s.busy) { throw 'Apply must not run during an import.' }
                $s.importing = $false
                $s.smokeStage = 11
            }
        }
        11 {
            if ($s.applyTransport.Enabled) { $s.applyTransport.PerformClick(); $s.smokeStage = 12 }
        }
        12 {
            if (-not $s.activeSlowHttp -and -not $s.busy -and $s.codeNew.Enabled) {
                $s.codeNew.PerformClick(); $s.smokeStage = 13
            }
        }
        13 {
            if ($s.codeText.Text -ceq 'ABC' -and $s.codeCancel.Enabled -and -not $s.busy) {
                if ($s.codeDeadline - $s.clock.ElapsedMilliseconds -gt 60000) { throw 'Code countdown exceeds 60 seconds.' }
                $s.codeCancel.PerformClick(); $s.smokeStage = 14
            }
        }
        14 {
            if (-not $s.codeId -and -not $s.busy -and $s.fixtureEvents.Contains('code-cancelled')) {
                Handle-UiEvent @{ kind = 'code-window'; value = @{ id = 'expired-fixture'; code = 'XYZ'; remainingMs = 0 } }
                $s.smokeStage = 15
            }
        }
        15 {
            if (-not $s.codeId -and -not $s.codeText.Text) { Request-RapQuit; $s.smokeStage = 7 }
        }
    }
}

function Assert-GuiSmoke {
    $s = $script:Desktop
    if ($s.failed -or $s.smokeStage -ne 7 -or $s.smokeOpens -ne 1 -or $s.smokePhones -ne 1 -or
        $s.fixtureEvents.Contains('approve') -or -not $s.fixtureEvents.Contains('reject') -or -not $s.fixtureEvents.Contains('disconnected') -or
        -not $s.fixtureEvents.Contains('enrollment-confirmed') -or -not $s.fixtureEvents.Contains('consent-denied') -or -not $s.fixtureEvents.Contains('consent-granted') -or
        -not $s.fixtureEvents.Contains('code-created') -or -not $s.fixtureEvents.Contains('code-cancelled') -or $s.smokeConsentTicks -lt 10) {
        throw ('GUI fixture smoke checks failed: stage=' + $s.smokeStage + ', failed=' + $s.failed +
            ', opens=' + $s.smokeOpens + ', phones=' + $s.smokePhones + ', fixture=' + ($s.fixtureEvents -join ','))
    }
    Write-Host 'PASS GUI: STA form/tray, guided enrollment, consent, responsive UI, desktop/phone pairing, explicit code window/countdown/cancel/expiry, advanced transport radio selection with explicit Apply and import guard, duplicate activation and graceful shutdown.'
}

if (-not $LibraryOnly) {
    try { Start-RapDesktop }
    catch {
        if ($SmokeTest) { throw }
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show('RAP could not start. Verify all portable files, Windows PowerShell 5.1, script policy and protected local state. A running copy must be quit normally; never delete the import journal to retry imports.', 'PathPlotter RAP', 'OK', 'Error')
        exit 1
    }
}
