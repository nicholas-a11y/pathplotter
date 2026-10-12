#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Operator-Invitations.ps1') -LibraryOnly
$script:Calls = 0
$id = [Guid]::NewGuid().ToString('D')
$script:OperatorFixtureId = $id
$admin = 'test-admin-token-not-a-real-secret-12345'
function Invoke-Http([string]$Url, [string]$Method, [string]$Token, $Body = $null, [hashtable]$Headers = @{}, [int]$TimeoutMs = 5000, [switch]$Raw) {
    $script:Calls++
    if ($Url -match [regex]::Escape($admin) -or $Token -cne $admin -or $TimeoutMs -ne 15000) { throw 'Invalid private request.' }
    if ($Method -ceq 'GET') { return @{ invitations = @() } }
    if ($Url.EndsWith('/cancel')) { return @{ status = 'cancelled' } }
    if ($Body.count -ne 1 -or $Body.label -cne 'Test group') { throw 'Invalid batch body.' }
    return @{ batchId = $script:OperatorFixtureId; invitations = @(@{ id = $script:OperatorFixtureId; token = ('a' * 43); status = 'unused'; expiresAt = 1800000000000 }) }
}
$null = Invoke-OperatorInvitations 'Generate' 'https://relay.invalid' $admin 1 'Test group' ''
$null = Invoke-OperatorInvitations 'List' 'https://relay.invalid' $admin 1 '' ''
$null = Invoke-OperatorInvitations 'Cancel' 'https://relay.invalid' $admin 1 '' $id
if ($script:Calls -ne 3) { throw 'Missing operator calls.' }
foreach ($operation in @(
    { Invoke-OperatorInvitations 'Generate' 'http://relay.invalid' $admin 1 '' '' },
    { Invoke-OperatorInvitations 'Generate' 'https://relay.invalid' $admin 21 '' '' },
    { Invoke-OperatorInvitations 'Generate' 'https://relay.invalid' 'short' 1 '' '' },
    { Invoke-OperatorInvitations 'Cancel' 'https://relay.invalid' $admin 1 '' 'not-an-id' }
)) {
    $failed = $false
    try { & $operation } catch { $failed = $true }
    if (-not $failed -or $script:Calls -ne 3) { throw 'Invalid input reached network.' }
}
function Invoke-Http { $script:Calls++; throw 'Simulated lost reply.' }
$failed = $false
try { Invoke-OperatorInvitations 'Generate' 'https://relay.invalid' $admin 1 '' '' }
catch { $failed = $_.Exception.Message -match 'use List' }
if (-not $failed -or $script:Calls -ne 4) { throw 'Ambiguous generation was retried or hidden.' }
Write-Host 'PASS operator invitation tool: HTTPS, private header, exact actions, bounds, metadata and explicit lost-reply reconciliation without retry.'
