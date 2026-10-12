#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\rap'))
$output = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $output) { throw 'Package output already exists. Choose a new output path.' }
$files = @(
    'RAP.ps1', 'GUI.ps1', 'GUIWorker.ps1', 'Desktop.cs', 'Transport.cs',
    'Start RAP.cmd', 'Start RAP.vbs', 'Start RAP diagnostics.cmd', 'README.md'
)
$vendor = Join-Path $source 'Vendor\QrCodeGenerator'
if (-not (Test-Path -LiteralPath $vendor -PathType Container)) { throw 'Bundled QR source/license directory is missing.' }
foreach ($file in Get-ChildItem -LiteralPath $vendor -File -Recurse) {
    if ($file.Extension -in @('.cs', '.md', '.txt') -or $file.Name -match '^LICENSE') {
        $files += $file.FullName.Substring($source.Length + 1)
    }
}
foreach ($relative in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $relative) -PathType Leaf)) {
        throw "Required RAP distribution file is missing: $relative"
    }
}
$stage = Join-Path ([IO.Path]::GetTempPath()) ('pathplotter-package-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($stage)
try {
    foreach ($relative in $files) {
        $target = Join-Path $stage $relative
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $target
    }
    [IO.File]::WriteAllText((Join-Path $stage 'protocol-version.txt'), "PathPlotter relay protocol: 2`r`nRequires the matching WebSocket relay and frontend.`r`n")
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output))
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $output
    $hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($output + '.sha256', "$hash  $([IO.Path]::GetFileName($output))`r`n")
    Write-Output "Portable RAP package created with $($files.Count) allowlisted files and protocol metadata."
} finally {
    foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse) { Remove-Item -LiteralPath $file.FullName -Force }
    foreach ($directory in Get-ChildItem -LiteralPath $stage -Directory -Recurse | Sort-Object { $_.FullName.Length } -Descending) {
        [IO.Directory]::Delete($directory.FullName)
    }
    [IO.Directory]::Delete($stage)
}
