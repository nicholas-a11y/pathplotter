#requires -Version 5.1
# RAP self-update from GitHub Releases. Dot-sourced by GUIWorker.ps1 after RAP.ps1.
# Releases are tagged rap-vX.Y.Z and carry PathPlotter-RAP-Windows.zip plus a
# .sha256 file. Only HTTPS GitHub hosts are contacted.

$script:UpdateRepository = 'nicholas-a11y/pathplotter'
$script:UpdateAsset = 'PathPlotter-RAP-Windows.zip'
$script:UpdateRequiredFiles = @('RAP.ps1', 'GUI.ps1', 'GUIWorker.ps1', 'Updater.ps1', 'Transport.cs', 'Desktop.cs', 'Start RAP.vbs', 'version.txt')

function Test-UpdateHost([Uri]$Uri) {
    if ($null -eq $Uri -or $Uri.Scheme -cne 'https' -or -not $Uri.IsDefaultPort) { return $false }
    $hostName = $Uri.Host.ToLowerInvariant()
    return $hostName -in @('github.com', 'api.github.com') -or $hostName.EndsWith('.githubusercontent.com', [StringComparison]::Ordinal)
}

function Invoke-UpdateDownload([string]$Url, [int]$MaxBytes) {
    $uri = [Uri]$Url
    for ($hop = 0; $hop -lt 6; $hop++) {
        if (-not (Test-UpdateHost $uri)) { throw 'Update download left GitHub.' }
        $request = [Net.HttpWebRequest][Net.WebRequest]::Create($uri)
        $request.AllowAutoRedirect = $false
        $request.UserAgent = 'PathPlotter-RAP/' + $script:RapVersion
        $request.Accept = 'application/vnd.github+json, application/octet-stream'
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 30000
        $response = $null
        try {
            try { $response = [Net.HttpWebResponse]$request.GetResponse() }
            catch [Net.WebException] {
                if ($null -eq $_.Exception.Response) { throw 'Could not reach GitHub to check for updates.' }
                $response = [Net.HttpWebResponse]$_.Exception.Response
            }
            $code = [int]$response.StatusCode
            if ($code -ge 300 -and $code -lt 400) {
                $location = $response.Headers['Location']
                if ([string]::IsNullOrEmpty($location)) { throw 'Update redirect had no location.' }
                $uri = New-Object Uri($uri, $location)
                continue
            }
            if ($code -ne 200) { throw "GitHub returned HTTP $code for the update." }
            $input = $response.GetResponseStream()
            $output = New-Object IO.MemoryStream
            try {
                $buffer = New-Object byte[] 65536
                while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    if ($output.Length + $count -gt $MaxBytes) { throw 'Update download is larger than expected.' }
                    $output.Write($buffer, 0, $count)
                }
                return ,$output.ToArray()
            } finally { $input.Dispose(); $output.Dispose() }
        } finally { if ($null -ne $response) { $response.Close() } }
    }
    throw 'Too many update redirects.'
}

function ConvertTo-RapRelease($Release) {
    $tag = Get-Field $Release 'tag_name'
    if ($tag -isnot [string] -or $tag -notmatch '^rap-v(\d+\.\d+\.\d+)$') { throw 'Latest GitHub release is not a RAP release.' }
    $version = $Matches[1]
    $base = 'https://github.com/' + $script:UpdateRepository + '/releases/download/' + $tag + '/' + $script:UpdateAsset
    return @{ version = $version; tag = $tag; zipUrl = $base; hashUrl = $base + '.sha256' }
}

function Get-RapLatestRelease {
    $bytes = Invoke-UpdateDownload ('https://api.github.com/repos/' + $script:UpdateRepository + '/releases/latest') 1048576
    return ConvertTo-RapRelease ($script:Utf8.GetString($bytes) | ConvertFrom-Json)
}

function Test-RapNewer([string]$Candidate, [string]$Current) {
    return ([Version]$Candidate) -gt ([Version]$Current)
}

function Assert-UpdateHash([byte[]]$Zip, [string]$HashText) {
    if ($HashText -notmatch '^\s*([0-9a-fA-F]{64})(\s|$)') { throw 'Update checksum file is invalid.' }
    $expected = $Matches[1].ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = -join ($sha.ComputeHash($Zip) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
    if ($actual -cne $expected) { throw 'Update checksum did not match; nothing was changed.' }
}

function Expand-UpdateZip([byte[]]$Zip, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression
    $root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $stream = New-Object IO.MemoryStream(, $Zip)
    $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Read)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('/', '\')
            if ($name.EndsWith('\')) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $root $name))
            if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Update archive contains an unsafe path.' }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            $in = $entry.Open()
            $out = [IO.File]::Create($target)
            try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
        }
    } finally { $archive.Dispose(); $stream.Dispose() }
}

function Remove-UpdateDirectory([string]$Path) {
    if ([IO.Directory]::Exists($Path)) { [IO.Directory]::Delete($Path, $true) }
}

function Install-RapUpdate($Release, [string]$TargetDirectory = $PSScriptRoot) {
    $zip = Invoke-UpdateDownload $Release.zipUrl 10485760
    $hash = $script:Utf8.GetString((Invoke-UpdateDownload $Release.hashUrl 4096))
    Assert-UpdateHash $zip $hash
    $work = Join-Path ([IO.Path]::GetTempPath()) ('pathplotter-rap-update-' + [Guid]::NewGuid().ToString('N'))
    $stage = Join-Path $work 'new'
    $backup = Join-Path $work 'backup'
    try {
        Expand-UpdateZip $zip $stage
        foreach ($required in $script:UpdateRequiredFiles) {
            if (-not [IO.File]::Exists((Join-Path $stage $required))) { throw "Update is missing $required." }
        }
        if ([IO.File]::ReadAllText((Join-Path $stage 'version.txt')).Trim() -cne $Release.version) { throw 'Update version does not match its release.' }
        $target = [IO.Path]::GetFullPath($TargetDirectory).TrimEnd('\')
        $files = @(Get-ChildItem -LiteralPath $stage -File -Recurse | ForEach-Object { $_.FullName.Substring($stage.Length + 1) })
        $copied = @()
        try {
            foreach ($relative in $files) {
                $destination = Join-Path $target $relative
                if ([IO.File]::Exists($destination)) {
                    $saved = Join-Path $backup $relative
                    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved))
                    [IO.File]::Copy($destination, $saved, $true)
                }
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
                $copied += $relative
                [IO.File]::Copy((Join-Path $stage $relative), $destination, $true)
            }
        } catch {
            foreach ($relative in $copied) {
                $saved = Join-Path $backup $relative
                $destination = Join-Path $target $relative
                if ([IO.File]::Exists($saved)) { [IO.File]::Copy($saved, $destination, $true) }
                else { [IO.File]::Delete($destination) }
            }
            throw 'Update could not replace RAP files; the previous version was restored.'
        }
    } finally { Remove-UpdateDirectory $work }
}

function Start-RapRelaunch([string]$Directory = $PSScriptRoot) {
    # Start the normal launcher directly (no hidden encoded PowerShell helper,
    # which security software flags). The new RAP waits for this process to exit.
    $launcher = Join-Path $Directory 'Start RAP.vbs'
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    Start-Process -FilePath $wscript -ArgumentList ('"' + $launcher + '" ' + $PID)
}
