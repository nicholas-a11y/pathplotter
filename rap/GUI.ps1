#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$LibraryOnly,
    [switch]$SmokeTest,
    [ValidateRange(0, 2147483647)][int]$WaitForProcessId = 0,
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'PathPlotter\RAP')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Initialize-DesktopTypes {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    if (-not ('PathPlotterRap.UiBridge' -as [type])) {
        $compiler = New-Object CodeDom.Compiler.CompilerParameters
        $compiler.GenerateInMemory = $true
        $compiler.TempFiles = New-Object CodeDom.Compiler.TempFileCollection([IO.Path]::GetTempPath(), $false)
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
        $compiler.TempFiles = New-Object CodeDom.Compiler.TempFileCollection([IO.Path]::GetTempPath(), $false)
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

# The hosted relay is built in. A relay.txt next to these files (one https origin) overrides it for self-hosting.
function Get-RelayOrigin {
    $override = Join-Path $PSScriptRoot 'relay.txt'
    if ([IO.File]::Exists($override)) {
        $text = [IO.File]::ReadAllText($override).Trim()
        if ($text) { return $text }
    }
    return 'https://pathplotter-relay-v3.nicholas-leqeta.workers.dev'
}

function Get-ComputerLabel {
    $name = [string]$env:COMPUTERNAME
    if ([string]::IsNullOrWhiteSpace($name)) { $name = 'This computer' }
    return $name.Substring(0, [Math]::Min(64, $name.Length))
}

function Clear-Phone {
    $d = $script:Desktop
    if ($null -eq $d.phone) { return }
    if ($null -ne $d.phoneImage) { $d.phonePicture.Image = $null; $d.phoneImage.Dispose(); $d.phoneImage = $null }
    try {
        if ([Windows.Forms.Clipboard]::ContainsText() -and [Windows.Forms.Clipboard]::GetText() -ceq $d.phoneUrl) { [Windows.Forms.Clipboard]::Clear() }
    } catch { }
    $d.phoneUrl = ''; $d.phoneCopy.Enabled = $false
    $d.phone.Visible = $false
}

function Show-Phone($Value) {
    $d = $script:Desktop
    Clear-Phone
    $d.phoneUrl = $Value.url
    $d.phoneImage = New-InvitationBitmap $Value.url
    $d.phonePicture.Image = $d.phoneImage
    $d.phoneCopy.Enabled = $true
    $d.phoneExpiry.Text = ''
    $d.phoneDeadline = $d.clock.ElapsedMilliseconds + $Value.remainingMs
    $d.phone.Visible = $true
}

function Show-Approvals($Pairings) {
    $d = $script:Desktop
    if ($Pairings.Count -gt 0) { Clear-Phone }
    $signature = ($Pairings.Keys | Sort-Object | ForEach-Object { $_ + ':' + $Pairings[$_] }) -join '|'
    $d.pairings = $Pairings
    $d.approvals.Visible = $Pairings.Count -gt 0
    $d.approvals.Height = [Math]::Min(250, $Pairings.Count * 110)
    if ($signature -ceq $d.pairingSignature) { return }
    $d.pairingSignature = $signature
    while ($d.approvals.Controls.Count -gt 0) { $d.approvals.Controls[0].Dispose() }
    foreach ($id in ($Pairings.Keys | Sort-Object)) {
        $card = New-Object Windows.Forms.FlowLayoutPanel
        $card.Size = New-Object Drawing.Size(565, 104); $card.FlowDirection = 'LeftToRight'
        $phrase = New-Object Windows.Forms.Label
        $phrase.Text = 'Approve only if the browser shows exactly:' + [Environment]::NewLine + $Pairings[$id]
        $phrase.Font = New-Object Drawing.Font($phrase.Font.FontFamily, 12, [Drawing.FontStyle]::Bold)
        $phrase.Size = New-Object Drawing.Size(545, 58); $card.Controls.Add($phrase)
        $approve = New-UiButton 'Approve matching phrase' @{ action = 'decide'; id = $id; phrase = $Pairings[$id]; approve = $true }
        $reject = New-UiButton 'Reject' @{ action = 'decide'; id = $id; phrase = $Pairings[$id]; approve = $false }
        $card.Controls.Add($approve); $card.Controls.Add($reject); $d.approvals.Controls.Add($card)
    }
    if ($Pairings.Count -gt 0) {
        Show-RapWindow
        $d.tray.ShowBalloonTip(3000, 'Browser approval requested', 'Compare the exact phrase in RAP. Approve only a browser you recognize.', [Windows.Forms.ToolTipIcon]::Info)
    }
}

function Handle-UiEvent($Event) {
    $d = $script:Desktop
    switch -CaseSensitive ($Event.kind) {
        'setup' {
            $d.busy = $false; $d.setup.Visible = $true; $d.register.Enabled = $true
            $d.status.Text = 'Not registered. Enter the Invitation ID you were given.'
            Show-RapWindow
        }
        'consent' {
            # LightBurn permission is optional until capturing; the relay and browser pairing work without it.
            $d.consentNeeded = $true; $d.consentPending = $false
            $d.consentHelp.Visible = $true; $d.consent.Visible = $true; $d.consent.Enabled = $true
        }
        'consent-pending' { $d.consentPending = $true; $d.consent.Enabled = $false }
        'consent-done' {
            $d.consentPending = $false
            if ($Event.value) { $d.consentNeeded = $false; $d.consentHelp.Visible = $false; $d.consent.Visible = $false }
            else { $d.consent.Enabled = $true }
        }
        'configured' { $d.configured = $true; $d.busy = $false; $d.setup.Visible = $false; $d.status.Text = 'Connecting to the relay...' }
        'recovery' {
            $d.busy = $false; $d.recovery.Visible = $true
            $d.status.Text = 'Saved registration is invalid or unreadable. Replace only local credentials with explicit consent below. The import journal is preserved; ask the operator to revoke the old agent credential and revoke the old LightBurn entry.'
            Show-RapWindow
        }
        'health' {
            # healthy means the relay session is up (enough to pair browsers); lightBurn is the capture-ready state.
            $d.healthy = [bool]$Event.value.cloud
            $d.lightBurn = [bool]$Event.value.connected
            $d.importing = [bool]$Event.value.importing
            if ($d.lightBurn) { $d.status.Text = 'Connected. ' + $Event.value.message }
            elseif ($d.healthy) { $d.status.Text = 'Relay connected: you can open PathPlotter and pair a browser now.' + [Environment]::NewLine + 'LightBurn not ready: ' + $Event.value.message }
            else { $d.status.Text = 'Not ready. ' + $Event.value.message }
            if ($Event.value.importing) { $d.status.Text += ' Import in progress; never automatically retried.' }
            $d.tray.Text = 'PathPlotter RAP - ' + $(if ($d.lightBurn) { 'Connected' } elseif ($d.healthy) { 'LightBurn not ready' } else { 'Not ready' })
            if (-not $d.healthy) { Show-Approvals @{} }
        }
        'version' {
            $d.versionLabel.Text = 'RAP v' + $Event.value.current + $(if ($Event.value.upToDate) { ' - up to date' } else { '' })
            $d.update.Visible = [bool]$Event.value.available
            if ($Event.value.available) {
                $d.update.Text = 'Update now to v' + $Event.value.latest
                $d.versionLabel.Text += ' - update available'
                if ($Event.value.required) { Show-RapWindow }
            }
        }
        'restarting' {
            $d.closing = $true; $d.bridge.StopRequested = $true
            $d.status.Text = 'RAP updated. Restarting...'
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
        'phone' { Show-Phone $Event.value; $d.smokePhones++; if ($d.smoke -and $d.phoneUrl -and $null -ne $d.phonePicture.Image) { $d.smokePhoneShown = $true } }
        'pairings' { Show-Approvals $Event.value }
        'browser' {
            # One browser at a time: while it is paired only Disconnect is offered.
            $d.browser = $Event.value
            $paired = $null -ne $d.browser
            $d.revoke.Visible = $paired
            $d.actions.Visible = -not $paired
            foreach ($name in @('menu-open', 'menu-phone')) { $d[$name].Available = -not $paired }
            if ($paired) { Clear-Phone }
            if ($d.smoke -and -not $paired) { $d.smokeBrowserShown = $true }
        }
        'confirm-switch' { $d.switchRequest = $Event.value }
        'action-complete' {
            $d.busy = $false; $d.pairingSignature = $null
            Show-Approvals $d.pairings
            if ($null -ne $d.switchRequest) {
                $command = $d.switchRequest; $d.switchRequest = $null
                if ([Windows.Forms.MessageBox]::Show('Replace the paired browser? Its access will stop. Pending or unresolved imports must be reconciled before switching.', 'Switch browser', 'YesNo', 'Warning') -eq 'Yes') {
                    [void](Submit-Ui $command)
                }
            }
        }
        'notice' { $d.notice.Text = $Event.value; Show-RapWindow }
        'fatal' { $d.status.Text = $Event.value; $d.failed = $true; Show-RapWindow }
        'fixture' { $d.fixtureEvents.Add($Event.value) }
        'stopped' {
            $d.stopped = $true; $d.busy = $false; $d.healthy = $false; $d.lightBurn = $false
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
    if ($WaitForProcessId -gt 0) {
        # After an update the previous RAP is exiting; wait for it to release the instance lock.
        $previous = Get-Process -Id $WaitForProcessId -ErrorAction SilentlyContinue
        if ($previous) { [void]$previous.WaitForExit(30000) }
    }
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
        activation = $activation; configured = $false; healthy = $false; lightBurn = $false; consentNeeded = $false; consentPending = $false; busy = $false; closing = $false; stopped = $false; failed = $false
        phone = $null; phoneImage = $null; phoneUrl = ''; phoneDeadline = 0L; browser = $null; switchRequest = $null; smokePhoneShown = $false; smokeBrowserShown = $false
        pairings = @{}; pairingSignature = ''; smoke = [bool]$SmokeTest; smokeOpens = 0; smokePhones = 0; smokeStage = 0; smokeConsentTicks = 0
        fixtureEvents = (New-Object 'Collections.Generic.List[string]')
    }
    $script:Desktop = $d
    $worker = $null; $runspace = $null; $async = $null
    try {
        $d.form = New-Object Windows.Forms.Form
        # The window sizes itself to its content so no empty space is left below the controls.
        $d.form.Text = 'PathPlotter RAP'
        $d.form.StartPosition = 'CenterScreen'
        $d.form.FormBorderStyle = 'FixedSingle'; $d.form.MaximizeBox = $false
        $d.form.AutoSize = $true; $d.form.AutoSizeMode = 'GrowAndShrink'
        $layout = New-Object Windows.Forms.FlowLayoutPanel
        $layout.Dock = 'None'; $layout.Location = New-Object Drawing.Point(0, 0)
        $layout.AutoSize = $true; $layout.AutoSizeMode = 'GrowAndShrink'
        $layout.FlowDirection = 'TopDown'; $layout.WrapContents = $false
        $layout.Padding = New-Object Windows.Forms.Padding(8, 8, 8, 8)
        $d.form.Controls.Add($layout)
        $d.status = New-Object Windows.Forms.Label
        $d.status.Text = 'Starting RAP...'; $d.status.AutoSize = $true; $d.status.MaximumSize = New-Object Drawing.Size(585, 0)
        $d.status.Margin = New-Object Windows.Forms.Padding(3, 3, 3, 8); $layout.Controls.Add($d.status)
        # Shown only while a browser is paired; then Open PathPlotter and Pair phone are hidden.
        $d.revoke = New-Object Windows.Forms.Button
        $d.revoke.Text = 'Disconnect paired browser'; $d.revoke.AutoSize = $true; $d.revoke.Visible = $false; $d.revoke.Enabled = $false
        $d.revoke.Margin = New-Object Windows.Forms.Padding(3, 0, 3, 8)
        $d.revoke.Add_Click({
            $s = $script:Desktop
            if ($null -ne $s.browser -and [Windows.Forms.MessageBox]::Show('Disconnect the paired browser? Its access to RAP stops. It can be paired again later.', 'Disconnect paired browser', 'YesNo', 'Warning') -eq 'Yes') {
                [void](Submit-Ui @{ action = 'revoke'; id = $s.browser.id })
            }
        })
        $layout.Controls.Add($d.revoke)
        $d.notice = New-Object Windows.Forms.Label
        $d.notice.AutoSize = $true; $d.notice.MaximumSize = New-Object Drawing.Size(585, 0); $d.notice.Visible = $false
        $d.notice.Margin = New-Object Windows.Forms.Padding(3, 0, 3, 8)
        $d.notice.ForeColor = [Drawing.Color]::DarkRed; $layout.Controls.Add($d.notice)
        $d.notice.Add_TextChanged({ param($sender, $eventArgs) $sender.Visible = $sender.Text.Length -gt 0 })
        # Top to bottom: registration (first run only), actions, who is paired, the phone QR, approvals, LightBurn permission, version.
        $d.setup = New-Object Windows.Forms.FlowLayoutPanel
        $d.setup.AutoSize = $true; $d.setup.AutoSizeMode = 'GrowAndShrink'; $d.setup.FlowDirection = 'TopDown'; $d.setup.WrapContents = $false; $d.setup.Visible = $false
        $layout.Controls.Add($d.setup)
        $label = New-Object Windows.Forms.Label
        $label.Text = 'Invitation ID'; $label.AutoSize = $true; $d.setup.Controls.Add($label)
        $d.invitation = New-Object Windows.Forms.TextBox
        $d.invitation.Width = 540; $d.invitation.UseSystemPasswordChar = $true; $d.setup.Controls.Add($d.invitation)
        $d.register = New-Object Windows.Forms.Button
        $d.register.Text = 'Register this computer'; $d.register.AutoSize = $true
        $d.register.Add_Click({
            $s = $script:Desktop
            if ([string]::IsNullOrWhiteSpace($s.invitation.Text)) { $s.notice.Text = 'Enter your Invitation ID.'; return }
            if (Submit-Ui @{ action = 'register'; api = (Get-RelayOrigin); name = (Get-ComputerLabel); invitation = $s.invitation.Text.Trim() }) {
                $s.invitation.Clear(); $s.register.Enabled = $false; $s.status.Text = 'Registering...'
            }
        })
        $d.setup.Controls.Add($d.register)
        $d.importing = $false
        $actions = New-Object Windows.Forms.FlowLayoutPanel
        $actions.AutoSize = $true; $actions.AutoSizeMode = 'GrowAndShrink'; $layout.Controls.Add($actions)
        $d.actions = $actions
        $d.open = New-UiButton 'Open PathPlotter' @{ action = 'open' }
        $d.pair = New-UiButton 'Pair phone' @{ action = 'phone' }
        foreach ($button in @($d.open, $d.pair)) { $button.Enabled = $false; $actions.Controls.Add($button) }
        $d.phone = New-Object Windows.Forms.FlowLayoutPanel
        $d.phone.AutoSize = $true; $d.phone.AutoSizeMode = 'GrowAndShrink'; $d.phone.FlowDirection = 'TopDown'; $d.phone.WrapContents = $false; $d.phone.Visible = $false
        $phoneHelp = New-Object Windows.Forms.Label
        $phoneHelp.Text = 'Scan this with the phone, then approve the phrase it shows. Keep this code private.'
        $phoneHelp.AutoSize = $true; $phoneHelp.MaximumSize = New-Object Drawing.Size(560, 0); $d.phone.Controls.Add($phoneHelp)
        $d.phonePicture = New-Object Windows.Forms.PictureBox
        $d.phonePicture.Size = New-Object Drawing.Size(300, 300); $d.phonePicture.SizeMode = 'Zoom'; $d.phone.Controls.Add($d.phonePicture)
        $phoneRow = New-Object Windows.Forms.FlowLayoutPanel
        $phoneRow.AutoSize = $true; $phoneRow.AutoSizeMode = 'GrowAndShrink'
        $d.phoneCopy = New-Object Windows.Forms.Button
        $d.phoneCopy.Text = 'Copy link'; $d.phoneCopy.AutoSize = $true; $d.phoneCopy.Enabled = $false
        $d.phoneCopy.Add_Click({ if ($script:Desktop.phoneUrl) { [Windows.Forms.Clipboard]::SetText($script:Desktop.phoneUrl) } })
        $phoneRow.Controls.Add($d.phoneCopy)
        $phoneClose = New-Object Windows.Forms.Button
        $phoneClose.Text = 'Close'; $phoneClose.AutoSize = $true; $phoneClose.Add_Click({ Clear-Phone })
        $phoneRow.Controls.Add($phoneClose)
        $d.phoneExpiry = New-Object Windows.Forms.Label
        $d.phoneExpiry.AutoSize = $true; $d.phoneExpiry.Margin = New-Object Windows.Forms.Padding(8, 8, 3, 3); $phoneRow.Controls.Add($d.phoneExpiry)
        $d.phone.Controls.Add($phoneRow)
        $layout.Controls.Add($d.phone)
        $d.approvals = New-Object Windows.Forms.FlowLayoutPanel
        $d.approvals.Size = New-Object Drawing.Size(585, 0); $d.approvals.Visible = $false
        $d.approvals.FlowDirection = 'TopDown'; $d.approvals.WrapContents = $false; $d.approvals.AutoScroll = $true
        $layout.Controls.Add($d.approvals)
        $d.consentHelp = New-Object Windows.Forms.Label
        $d.consentHelp.AutoSize = $true; $d.consentHelp.MaximumSize = New-Object Drawing.Size(585, 0); $d.consentHelp.Visible = $false
        $d.consentHelp.Text = 'To capture points, let RAP read LightBurn: turn on REST API in LightBurn (Settings > Extensions), click below, then approve LightBurn''s dialog within 30 seconds.'
        $layout.Controls.Add($d.consentHelp)
        $d.consent = New-UiButton 'Request local LightBurn permission' @{ action = 'consent' }
        $d.consent.Visible = $false; $layout.Controls.Add($d.consent)
        $d.recovery = New-Object Windows.Forms.Button
        $d.recovery.Text = 'Replace invalid local registration...'; $d.recovery.AutoSize = $true; $d.recovery.Visible = $false
        $d.recovery.Add_Click({
            if ([Windows.Forms.MessageBox]::Show('Forget the unreadable/invalid local credentials and register again? Remote permissions must be revoked separately. The import journal will not be removed.', 'Replace invalid registration', 'YesNo', 'Warning') -eq 'Yes') {
                if (Submit-Ui @{ action = 'reset-registration' }) { $script:Desktop.recovery.Visible = $false }
            }
        })
        $layout.Controls.Add($d.recovery)
        $versionRow = New-Object Windows.Forms.FlowLayoutPanel
        $versionRow.AutoSize = $true; $versionRow.AutoSizeMode = 'GrowAndShrink'; $layout.Controls.Add($versionRow)
        $d.versionLabel = New-Object Windows.Forms.Label
        $d.versionLabel.AutoSize = $true; $d.versionLabel.Margin = New-Object Windows.Forms.Padding(3, 8, 3, 3)
        $d.versionLabel.Text = 'RAP'; $versionRow.Controls.Add($d.versionLabel)
        $d.update = New-Object Windows.Forms.Button
        $d.update.AutoSize = $true; $d.update.Visible = $false
        $d.update.Add_Click({
            param($sender, $eventArgs)
            if ([Windows.Forms.MessageBox]::Show('Download the new RAP from GitHub, replace these files and restart RAP? Your registration and LightBurn permission are kept.', 'Update RAP', 'YesNo', 'Question') -eq 'Yes') {
                if (Submit-Ui @{ action = 'update' }) { $sender.Enabled = $false; $script:Desktop.status.Text = 'Downloading update...' }
            }
        })
        $versionRow.Controls.Add($d.update)
        $safety = New-Object Windows.Forms.Label
        $safety.Text = 'Closing this window keeps RAP in the system tray.'
        $safety.AutoSize = $true; $safety.MaximumSize = New-Object Drawing.Size(585, 0); $layout.Controls.Add($safety)
        $d.tray = New-Object Windows.Forms.NotifyIcon
        $d.tray.Icon = [Drawing.SystemIcons]::Application; $d.tray.Text = 'PathPlotter RAP - Starting'; $d.tray.Visible = $true
        $menu = New-Object Windows.Forms.ContextMenuStrip
        $d.tray.ContextMenuStrip = $menu
        foreach ($item in @(@('Open PathPlotter', 'open'), @('Pair phone', 'phone'))) {
            $entry = $menu.Items.Add($item[0]); $entry.Tag = @{ action = $item[1] }
            $entry.Add_Click({ param($sender, $eventArgs) [void](Submit-Ui $sender.Tag) })
            $d['menu-' + $item[1]] = $entry; $entry.Enabled = $false
        }
        $entry = $menu.Items.Add('Show window'); $entry.Add_Click({ Show-RapWindow })
        $entry = $menu.Items.Add('Check for updates'); $entry.Tag = @{ action = 'check-update' }
        # Show the window so the result (update offer or up to date) is seen.
        $entry.Add_Click({ param($sender, $eventArgs) Show-RapWindow; [void](Submit-Ui $sender.Tag) })
        $d['menu-check-update'] = $entry; $entry.Enabled = $false
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
                foreach ($control in @($s.revoke, $s.update, $s['menu-check-update'], $s['menu-forget-lightburn'], $s['menu-forget-relay'])) {
                    $control.Enabled = $s.configured -and -not $s.busy -and -not $s.closing -and -not $s.stopped
                }
                if ($null -ne $s.phone -and $s.phoneUrl) {
                    $remaining = $s.phoneDeadline - $s.clock.ElapsedMilliseconds
                    if ($remaining -le 0) { Clear-Phone }
                    else { $s.phoneExpiry.Text = 'Expires in ' + [Math]::Ceiling($remaining / 1000) + ' seconds.' }
                }
                if ($s.smoke) {
                    if ($s.consentPending) { $s.smokeConsentTicks++ }
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
        if ($d.ContainsKey('tray')) { $d.tray.Visible = $false; $d.tray.Dispose() }
        if ($d.ContainsKey('form')) { $d.form.Dispose() }
        $activation.Dispose()
    }
}

function Step-GuiSmoke {
    $s = $script:Desktop
    if ($s.clock.ElapsedMilliseconds -gt 20000) { $s.failed = $true; Request-RapQuit; return }
    switch ($s.smokeStage) {
        0 {
            if ($s.setup.Visible) {
                if ($s.setup.Controls.Count -ne 3 -or $s.ContainsKey('advancedPanel') -or $s.ContainsKey('api') -or $s.ContainsKey('name')) { throw 'Registration has extra controls beyond the Invitation ID.' }
                $s.register.PerformClick()
                if ($s.busy -or -not $s.bridge.Commands.IsEmpty -or $s.notice.Text -cne 'Enter your Invitation ID.' -or -not $s.invitation.UseSystemPasswordChar) { throw 'Blank invitation was not refused explicitly.' }
                [void](Submit-Ui @{ action = 'register'; api = 'https://fixture.invalid'; name = 'Fixture PC'; invitation = 'fixture-invitation-id' }); $s.smokeStage = 1
            }
        }
        1 {
            # The relay session starts without LightBurn permission, so browser pairing is available first.
            if ($s.healthy -and $s.consent.Visible -and $s.consentHelp.Visible -and $s.smokeOpens -eq 1 -and -not $s.busy) {
                if (-not $s.open.Enabled -or -not $s.pair.Enabled -or $s.fixtureEvents.Contains('consent-denied')) { throw 'Browser pairing was not available before LightBurn permission.' }
                [void](Submit-Ui @{ action = 'consent' }); $s.smokeStage = 2
            }
        }
        2 {
            if ($s.consent.Visible -and $s.consent.Enabled -and -not $s.consentPending -and -not $s.busy -and $s.fixtureEvents.Contains('consent-denied') -and -not $s.fixtureEvents.Contains('consent-granted')) {
                [void](Submit-Ui @{ action = 'consent' })
            }
            if ($s.fixtureEvents.Contains('consent-granted') -and -not $s.consent.Visible -and $s.healthy -and -not $s.busy) { [void](Submit-Ui @{ action = 'phone' }); $s.smokeStage = 3 }
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
            if (-not $s.phoneUrl -and -not $s.busy -and $s.update.Visible) {
                Handle-UiEvent @{ kind = 'browser'; value = @{ id = 'fixture-browser'; label = 'Fixture browser' } }
                if (-not $s.revoke.Visible -or $s.actions.Visible -or $s['menu-open'].Available -or $s['menu-phone'].Available) { throw 'A paired browser did not replace Open PathPlotter and Pair phone with Disconnect.' }
                Handle-UiEvent @{ kind = 'browser'; value = $null }
                if ($s.revoke.Visible -or -not $s.actions.Visible -or -not $s['menu-open'].Available -or -not $s['menu-phone'].Available) { throw 'Disconnecting did not bring back Open PathPlotter and Pair phone.' }
                if ($s.update.Text -cne 'Update now to v9.9.9' -or $s.versionLabel.Text -notmatch '^RAP v\d+\.\d+\.\d+ - update available$') { throw 'Update offer is not shown.' }
                [void](Submit-Ui @{ action = 'update' }); $s.smokeStage = 7
            }
        }
    }
}

function Assert-GuiSmoke {
    $s = $script:Desktop
    if ($s.failed -or $s.smokeStage -ne 7 -or $s.smokeOpens -ne 1 -or $s.smokePhones -ne 1 -or -not $s.smokePhoneShown -or -not $s.smokeBrowserShown -or
        $s.fixtureEvents.Contains('approve') -or -not $s.fixtureEvents.Contains('reject') -or -not $s.fixtureEvents.Contains('disconnected') -or
        -not $s.fixtureEvents.Contains('registered') -or -not $s.fixtureEvents.Contains('consent-denied') -or -not $s.fixtureEvents.Contains('consent-granted') -or
        -not $s.fixtureEvents.Contains('installed') -or -not $s.fixtureEvents.Contains('relaunch') -or $s.smokeConsentTicks -lt 10) {
        throw ('GUI fixture smoke checks failed: stage=' + $s.smokeStage + ', failed=' + $s.failed +
            ', opens=' + $s.smokeOpens + ', phones=' + $s.smokePhones + ', phoneShown=' + $s.smokePhoneShown + ', browserShown=' + $s.smokeBrowserShown + ', fixture=' + ($s.fixtureEvents -join ','))
    }
    Write-Host 'PASS GUI: STA form/tray, invitation registration, consent, responsive UI, desktop/phone pairing, update offer, install and restart, duplicate activation and graceful shutdown.'
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
