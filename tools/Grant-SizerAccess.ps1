#Requires -Version 7.0

<#
.SYNOPSIS
    Grants a user the System Administrator role on every environment that failed
    ingest with an access error, by looping `pac admin assign-user` over the
    FAILED rows of data\ingest-log.csv.

.DESCRIPTION
    Companion to the sizer's batch ingest: after a tenant-wide run, ingest-log.csv
    lists environments the signed-in user could not read (HTTP 403 / "not a member"
    / "no roles"). This script assigns the given user a role on exactly those
    environments so the failed ingests can be re-run.

    BLAST RADIUS - read before running:
    - This grants STANDING System Administrator (full data access) on every
      targeted environment, to one user. It is the scripted equivalent of the
      Power Platform admin center self-elevation, but it does NOT auto-expire.
    - Plan a removal pass after the sizing engagement (see ROLLBACK in NOTES).
    - Use -ExcludePattern to keep sandbox/dev series and other irrelevant
      environments out of scope, and prefer scoping to environments that appear
      in the PPAC AI Builder consumption report.

    Always preview with -WhatIf first.

.PARAMETER UserPrincipalName
    UPN of the user to grant (normally the admin who runs the ingest).

.PARAMETER LogPath
    Path to ingest-log.csv (default: .\data\ingest-log.csv relative to the
    current directory).

.PARAMETER ExcludePattern
    Regex matched against the environment URL; matching environments are skipped.
    Example: 'sdy\d+|test|tst|-dev' to skip sandbox/dev series.

.PARAMETER Role
    Security role to assign. Default 'System Administrator'. A custom role with
    Read on msdyn_aievent/msdyn_aimodel/msdyn_aitemplate is the least-privilege
    alternative if the customer has created one in each environment.

.PARAMETER Environments
    Explicit environment URLs to process instead of reading the log file.

.EXAMPLE
    .\Grant-SizerAccess.ps1 -UserPrincipalName admin@contoso.com -WhatIf
    Lists every grant that would be made (from the FAILED log rows), changes nothing.

.EXAMPLE
    .\Grant-SizerAccess.ps1 -UserPrincipalName admin@contoso.com -ExcludePattern 'sdy\d+|test|tst'
    Grants on failed environments except the sandbox/test series.

.NOTES
    Prerequisites : Power Platform CLI (pac) installed and authenticated as a
                    Power Platform admin:
                      dotnet tool install --global Microsoft.PowerApps.CLI.Tool
                      pac auth create
    Required role : Power Platform Administrator (to assign users to environments).
    ROLLBACK      : pac cannot remove role assignments. Remove the standing access
                    afterwards in PPAC (environment > Settings > Users > remove the
                    role) or with Microsoft's sample scripts for high-privileged
                    role cleanup (learn.microsoft.com: manage-high-privileged-admin-roles).
    Author        : Sayed Ali. Not an official Microsoft solution.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[^@\s]+@[^@\s]+$')]
    [string] $UserPrincipalName,

    [string] $LogPath = '.\data\ingest-log.csv',

    [string] $ExcludePattern,

    [ValidateNotNullOrEmpty()]
    [string] $Role = 'System Administrator',

    [string[]] $Environments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command pac -ErrorAction SilentlyContinue)) {
    throw "Power Platform CLI (pac) not found. Install: dotnet tool install --global Microsoft.PowerApps.CLI.Tool - then run 'pac auth create' as a Power Platform admin."
}

if (-not $Environments -or $Environments.Count -eq 0) {
    if (-not (Test-Path $LogPath)) {
        throw "Ingest log not found: $LogPath. Run 'sizer ingest' first, or pass -Environments explicitly."
    }
    $rows = Import-Csv $LogPath | Where-Object status -eq 'FAILED'
    # An environment that later succeeded is no longer missing.
    $succeeded = (Import-Csv $LogPath | Where-Object status -eq 'OK' | Select-Object -ExpandProperty environment -Unique)
    $Environments = $rows | Select-Object -ExpandProperty environment -Unique |
        Where-Object { $_ -notin $succeeded -and $_ -notmatch 'yourorg' }
}

if ($ExcludePattern) {
    $before = $Environments.Count
    $Environments = @($Environments | Where-Object { $_ -notmatch $ExcludePattern })
    Write-Host "Excluded $($before - $Environments.Count) environment(s) matching '$ExcludePattern'."
}

if ($Environments.Count -eq 0) {
    Write-Host 'Nothing to do - no missing environments after filtering.'
    return
}

Write-Host "Granting '$Role' to $UserPrincipalName on $($Environments.Count) environment(s)..."
$results = [System.Collections.Generic.List[object]]::new()
$index = 0

foreach ($envUrl in $Environments) {
    $index++
    if (-not $PSCmdlet.ShouldProcess($envUrl, "Assign role '$Role' to $UserPrincipalName")) {
        continue
    }
    Write-Host "[$index/$($Environments.Count)] $envUrl"
    try {
        $output = pac admin assign-user --environment $envUrl --user $UserPrincipalName --role $Role 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw ($output.Trim() -replace '\s+', ' ') }
        Write-Host '   granted' -ForegroundColor Green
        $results.Add([pscustomobject]@{ Environment = $envUrl; Result = 'GRANTED'; Detail = '' })
    } catch {
        $message = ($_.Exception.Message -replace '\s+', ' ')
        $message = $message.Substring(0, [math]::Min(200, $message.Length))
        Write-Warning "   failed: $message"
        $results.Add([pscustomobject]@{ Environment = $envUrl; Result = 'FAILED'; Detail = $message })
    }
}

if ($results.Count -gt 0) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outFile = Join-Path (Split-Path $LogPath -Parent) "grant-log_$stamp.csv"
    $results | Export-Csv -Path $outFile -NoTypeInformation -Encoding UTF8
    $granted = @($results | Where-Object Result -eq 'GRANTED').Count
    Write-Host "`nDone: $granted/$($results.Count) granted. Log: $outFile"
    Write-Host 'Next: re-run ingest for these environments, then forecast. Plan a role-removal pass after the engagement.'
}
