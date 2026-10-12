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
    $d.approvals.Visible = $Pairings.Count -gt 0
    $d.approvals.Height = [Math]::Min(250, $Pairings.Count * 96)
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
    $d.browsers.Text = 'Paired browser'; $d.browsers.ClientSize = New-Object Drawing.Size(440, 300)
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
            $d.busy = $false; $d.setup.Visible = $true; $d.registrationAdvanced.Visible = $true; $d.register.Enabled = $true
            $d.status.Text = 'Not registered. Enter the Invitation ID you were given.'
            Show-RapWindow
        }
        'consent' {
            $d.busy = $false; $d.setup.Visible = $false; $d.consent.Visible = $true; $d.consent.Enabled = $true
            $d.status.Text = 'Open LightBurn, enable REST API in Settings > Extensions, keep network API access disabled. Click below, bring LightBurn forward, then approve its own dialog within 30 seconds.'
            Show-RapWindow
        }
        'configured' { $d.configured = $true; $d.busy = $false; $d.setup.Visible = $false; $d.registrationAdvanced.Visible = $false; $d.consent.Visible = $false; $d.status.Text = 'Connecting to LightBurn and relay...' }
        'recovery' {
            $d.busy = $false; $d.recovery.Visible = $true
            $d.status.Text = 'Saved registration is invalid or unreadable. Replace only local credentials with explicit consent below. The import journal is preserved; ask the operator to revoke the old agent credential and revoke the old LightBurn entry.'
            Show-RapWindow
        }
        'health' {
            $d.healthy = $Event.value.connected
            $d.importing = [bool]$Event.value.importing
            $d.status.Text = $(if ($d.healthy) { 'Connected. ' } else { 'Not ready. ' }) + $Event.value.message
            if ($Event.value.importing) { $d.status.Text += ' Import in progress; never automatically retried.' }
            $d.tray.Text = 'PathPlotter RAP - ' + $(if ($d.healthy) { 'Connected' } else { 'Not ready' })
            if (-not $d.healthy) { Show-Approvals @{} }
        }
        'version' {
            $d.versionLabel.Text = 'RAP v' + $Event.value.current
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
        'phone' { Show-Phone $Event.value; $d.smokePhones++ }
        'pairings' { Show-Approvals $Event.value }
        'browsers' { Show-Browsers $Event.value }
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
        phone = $null; phoneImage = $null; phoneUrl = ''; phoneDeadline = 0L; browsers = $null; switchRequest = $null
        pairings = @{}; pairingSignature = ''; smoke = [bool]$SmokeTest; smokeOpens = 0; smokePhones = 0; smokeStage = 0; smokeConsentTicks = 0
        fixtureEvents = (New-Object 'Collections.Generic.List[string]')
    }
    $script:Desktop = $d
    $worker = $null; $runspace = $null; $async = $null
    try {
        $d.form = New-Object Windows.Forms.Form
        $d.form.Text = 'PathPlotter RAP'; $d.form.ClientSize = New-Object Drawing.Size(610, 470)
        $d.form.StartPosition = 'CenterScreen'; $d.form.MinimumSize = New-Object Drawing.Size(630, 500)
        $layout = New-Object Windows.Forms.FlowLayoutPanel
        $layout.Dock = 'Fill'; $layout.FlowDirection = 'TopDown'; $layout.WrapContents = $false; $layout.AutoScroll = $true
        $d.form.Controls.Add($layout)
        $d.status = New-Object Windows.Forms.Label
        $d.status.Text = 'Starting RAP...'; $d.status.Size = New-Object Drawing.Size(585, 65); $layout.Controls.Add($d.status)
        $d.notice = New-Object Windows.Forms.Label
        $d.notice.Size = New-Object Drawing.Size(585, 55); $d.notice.ForeColor = [Drawing.Color]::DarkRed; $layout.Controls.Add($d.notice)
        $actions = New-Object Windows.Forms.FlowLayoutPanel
        $actions.Size = New-Object Drawing.Size(585, 45); $layout.Controls.Add($actions)
        $d.open = New-UiButton 'Open PathPlotter' @{ action = 'open' }
        $d.pair = New-UiButton 'Pair phone' @{ action = 'phone' }
        $d.list = New-UiButton 'Paired browser' @{ action = 'browsers' }
        foreach ($button in @($d.open, $d.pair)) { $button.Enabled = $false; $actions.Controls.Add($button) }
        $d.list.Enabled = $false
        $versionRow = New-Object Windows.Forms.FlowLayoutPanel
        $versionRow.Size = New-Object Drawing.Size(585, 35); $layout.Controls.Add($versionRow)
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
        $d.setup = New-Object Windows.Forms.FlowLayoutPanel
        $d.setup.Size = New-Object Drawing.Size(580, 90); $d.setup.FlowDirection = 'TopDown'; $d.setup.WrapContents = $false; $d.setup.Visible = $false
        $layout.Controls.Add($d.setup)
        $d.registrationAdvanced = New-Object Windows.Forms.FlowLayoutPanel
        $d.registrationAdvanced.Size = New-Object Drawing.Size(560, 110)
        $d.registrationAdvanced.FlowDirection = 'TopDown'; $d.registrationAdvanced.WrapContents = $false
        foreach ($field in @(@('Relay origin', 'api'), @('Computer name', 'name'), @('Invitation ID', 'invitation'))) {
            $parent = $(if ($field[1] -ceq 'invitation') { $d.setup } else { $d.registrationAdvanced })
            $label = New-Object Windows.Forms.Label
            $label.Text = $field[0]; $label.AutoSize = $true; $parent.Controls.Add($label)
            $box = New-Object Windows.Forms.TextBox
            $box.Width = 540; $d[$field[1]] = $box; $parent.Controls.Add($box)
        }
        $d.name.Text = $env:COMPUTERNAME; $d.invitation.UseSystemPasswordChar = $true
        $d.api.Text = 'https://pathplotter-relay-v3.nicholas-leqeta.workers.dev'
        $d.register = New-Object Windows.Forms.Button
        $d.register.Text = 'Register this computer'; $d.register.AutoSize = $true
        $d.register.Add_Click({
            $s = $script:Desktop
            if ([string]::IsNullOrWhiteSpace($s.invitation.Text)) { $s.notice.Text = 'Enter your Invitation ID.'; return }
            if (Submit-Ui @{ action = 'register'; api = $s.api.Text.Trim(); name = $s.name.Text.Trim(); invitation = $s.invitation.Text.Trim() }) {
                $s.invitation.Clear(); $s.register.Enabled = $false; $s.status.Text = 'Registering...'
            }
        })
        $d.setup.Controls.Add($d.register)
        $d.importing = $false
        $advanced = New-Object Windows.Forms.CheckBox
        $advanced.Text = 'Advanced connection settings'; $advanced.AutoSize = $true
        $d.advancedPanel = New-Object Windows.Forms.FlowLayoutPanel
        $d.advancedPanel.AutoSize = $true; $d.advancedPanel.MaximumSize = New-Object Drawing.Size(580, 0)
        $d.advancedPanel.FlowDirection = 'TopDown'; $d.advancedPanel.WrapContents = $false
        $d.advancedPanel.Visible = $false
        $advanced.Add_CheckedChanged({ param($sender, $eventArgs) $script:Desktop.advancedPanel.Visible = $sender.Checked })
        $layout.Controls.Add($advanced)
        $d.advancedPanel.Controls.Add($d.registrationAdvanced)
        $d.advancedPanel.Controls.Add($d.list)
        $layout.Controls.Add($d.advancedPanel)
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
        $d.approvals.Size = New-Object Drawing.Size(585, 0); $d.approvals.Visible = $false
        $d.approvals.FlowDirection = 'TopDown'; $d.approvals.WrapContents = $false; $d.approvals.AutoScroll = $true
        $layout.Controls.Add($d.approvals)
        $safety = New-Object Windows.Forms.Label
        $safety.Text = 'Send imports SVG only. RAP never jogs, fires or starts the laser. Closing this window keeps RAP in the tray. Choose Quit to stop.'
        $safety.Size = New-Object Drawing.Size(585, 45); $layout.Controls.Add($safety)
        $d.tray = New-Object Windows.Forms.NotifyIcon
        $d.tray.Icon = [Drawing.SystemIcons]::Application; $d.tray.Text = 'PathPlotter RAP - Starting'; $d.tray.Visible = $true
        $menu = New-Object Windows.Forms.ContextMenuStrip
        $d.tray.ContextMenuStrip = $menu
        foreach ($item in @(@('Open PathPlotter', 'open'), @('Pair phone', 'phone'), @('Paired browser', 'browsers'))) {
            $entry = $menu.Items.Add($item[0]); $entry.Tag = @{ action = $item[1] }
            $entry.Add_Click({ param($sender, $eventArgs) [void](Submit-Ui $sender.Tag) })
            $d['menu-' + $item[1]] = $entry; $entry.Enabled = $false
        }
        $entry = $menu.Items.Add('Status'); $entry.Add_Click({ Show-RapWindow })
        $entry = $menu.Items.Add('Check for updates'); $entry.Tag = @{ action = 'check-update' }
        $entry.Add_Click({ param($sender, $eventArgs) [void](Submit-Ui $sender.Tag) })
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
                foreach ($control in @($s.list, $s.update, $s['menu-browsers'], $s['menu-check-update'], $s['menu-forget-lightburn'], $s['menu-forget-relay'])) {
                    $control.Enabled = $s.configured -and -not $s.busy -and -not $s.closing -and -not $s.stopped
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
        0 {
            if ($s.setup.Visible) {
                if ($s.advancedPanel.Visible -or $s.api.Visible -or $s.name.Visible -or $s.setup.Controls.Count -ne 3) { throw 'Advanced setup is not hidden by default.' }
                $s.register.PerformClick()
                if ($s.busy -or -not $s.bridge.Commands.IsEmpty -or $s.notice.Text -cne 'Enter your Invitation ID.' -or -not $s.invitation.UseSystemPasswordChar) { throw 'Blank invitation was not refused explicitly.' }
                [void](Submit-Ui @{ action = 'register'; api = 'https://fixture.invalid'; name = 'Fixture PC'; invitation = 'fixture-invitation-id' }); $s.smokeStage = 1
            }
        }
        1 { if ($s.consent.Visible) { [void](Submit-Ui @{ action = 'consent' }); $s.smokeStage = 2 } }
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
            if (-not $s.phoneUrl -and -not $s.busy -and $s.update.Visible) {
                if ($s.update.Text -cne 'Update now to v9.9.9' -or $s.versionLabel.Text -notmatch '^RAP v\d+\.\d+\.\d+ - update available$') { throw 'Update offer is not shown.' }
                [void](Submit-Ui @{ action = 'update' }); $s.smokeStage = 7
            }
        }
    }
}

function Assert-GuiSmoke {
    $s = $script:Desktop
    if ($s.failed -or $s.smokeStage -ne 7 -or $s.smokeOpens -ne 1 -or $s.smokePhones -ne 1 -or
        $s.fixtureEvents.Contains('approve') -or -not $s.fixtureEvents.Contains('reject') -or -not $s.fixtureEvents.Contains('disconnected') -or
        -not $s.fixtureEvents.Contains('registered') -or -not $s.fixtureEvents.Contains('consent-denied') -or -not $s.fixtureEvents.Contains('consent-granted') -or
        -not $s.fixtureEvents.Contains('installed') -or -not $s.fixtureEvents.Contains('relaunch') -or $s.smokeConsentTicks -lt 10) {
        throw ('GUI fixture smoke checks failed: stage=' + $s.smokeStage + ', failed=' + $s.failed +
            ', opens=' + $s.smokeOpens + ', phones=' + $s.smokePhones + ', fixture=' + ($s.fixtureEvents -join ','))
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
