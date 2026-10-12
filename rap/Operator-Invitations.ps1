#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Generate', 'List', 'Cancel')][string]$Action = 'List',
    [ValidateRange(1, 20)][int]$Count = 10,
    [ValidateLength(0, 64)][string]$Label = '',
    [string]$InvitationId = '',
    [string]$Relay = 'https://pathplotter-relay-v2.nicholas-leqeta.workers.dev',
    [switch]$LibraryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$operatorLibraryOnly = [bool]$LibraryOnly
. (Join-Path $PSScriptRoot 'RAP.ps1') -LibraryOnly

function Invoke-OperatorInvitations([string]$Operation, [string]$Root, [string]$AdminToken, [int]$Amount, [string]$BatchLabel, [string]$Id) {
    $rootUrl = Assert-CloudRoot $Root
    if ($AdminToken.Length -lt 32) { throw 'The private operator admin token must contain at least 32 characters.' }
    $path = '/v1/operator/invitations'
    $method = 'GET'; $body = $null
    switch -CaseSensitive ($Operation) {
        'Generate' {
            if ($Amount -lt 1 -or $Amount -gt 20 -or $BatchLabel.Length -gt 64 -or $BatchLabel -match '[\x00-\x1f\x7f]') { throw 'Use 1-20 invitations and a label of at most 64 characters without control characters.' }
            $method = 'POST'; $body = @{ count = $Amount; label = $BatchLabel }
        }
        'List' { }
        'Cancel' {
            $parsed = [Guid]::Empty
            if (-not [Guid]::TryParseExact($Id, 'D', [ref]$parsed)) { throw 'Supply an invitation ID from List, not its secret token.' }
            $path += '/' + $parsed.ToString('D') + '/cancel'; $method = 'POST'; $body = @{}
        }
        default { throw 'Choose Generate, List or Cancel.' }
    }
    try { $result = Invoke-Http ($rootUrl + $path) $method $AdminToken $body -TimeoutMs 15000 }
    catch {
        throw 'Operator request failed (authorization, rate limit, capacity or network). No automatic retry occurred. If Generate may have reached the relay, use List to find and cancel the uncertain batch before generating replacements. Check the admin secret and relay deployment.'
    }
    if ($Operation -ceq 'Cancel') {
        if ((Get-Field $result 'status') -cne 'cancelled') { throw 'Invalid cancellation response; check List before retrying.' }
        return $result
    }
    if (-not (Test-Field $result 'invitations')) { throw 'Invalid invitation response; use List to reconcile an uncertain generation.' }
    $items = @($result.invitations)
    if ($Operation -ceq 'Generate' -and $items.Count -ne $Amount) { throw 'Incomplete invitation batch response; use List to reconcile.' }
    foreach ($item in $items) {
        $parsed = [Guid]::Empty
        if (-not [Guid]::TryParseExact([string](Get-Field $item 'id'), 'D', [ref]$parsed) -or
            (Get-Field $item 'status') -notin @('unused', 'used', 'expired', 'cancelled') -or
            -not (Test-Number (Get-Field $item 'expiresAt')) -or
            $item.expiresAt -lt 0 -or $item.expiresAt -gt 253402300799999) { throw 'Invalid invitation metadata; use List to reconcile.' }
        if ($Operation -ceq 'Generate' -and ((Get-Field $item 'token') -isnot [string] -or (Get-Field $item 'token') -notmatch '^[A-Za-z0-9_-]{43}$')) { throw 'Invalid invitation token; use List to cancel the uncertain batch.' }
    }
    return $result
}

if ($operatorLibraryOnly) { return }
Write-Warning 'Private operator tool. Do not use transcripts, recordings or shared terminals. Generated invitations are displayed once; keep them securely. Never hand out the admin token.'
$secure = Read-Host 'Private OPERATOR_ADMIN_TOKEN (not an invitation)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$admin = $null
try {
    $admin = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $result = Invoke-OperatorInvitations $Action $Relay $admin $Count $Label $InvitationId
    if ($Action -ceq 'Generate') {
        Write-Host ('Batch: ' + $result.batchId + '. Each invitation expires after seven days and registers one RAP. Hand out InvitationID for RAP; CancellationId is operator-only.')
        foreach ($item in $result.invitations) {
            [pscustomobject]@{ CancellationId = $item.id; Label = $item.label; ExpiresUtc = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$item.expiresAt).UtcDateTime; InvitationID = $item.token } | Format-List
        }
    } elseif ($Action -ceq 'List') {
        if ((Get-Field $result 'truncated') -eq $true) { Write-Warning 'Only the latest 1000 invitations are shown. Metadata is retained until 30 days after expiry.' }
        $result.invitations | Select-Object id, batchId, label, status, @{ Name = 'ExpiresUtc'; Expression = { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$_.expiresAt).UtcDateTime } } | Format-Table -AutoSize
    } else { Write-Host 'Invitation cancelled. Already-registered RAP credentials are not revoked by cancellation.' }
} finally {
    $admin = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secure.Dispose()
}
