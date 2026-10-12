#Requires -Version 7.0
<#
.SYNOPSIS
    Builds the self-contained, offline customer zip for credit-transition-sizer.

.DESCRIPTION
    Stages the compiled tool with production node_modules and (optionally) the
    official Node.js LTS and Azure CLI Windows installers, so the customer needs
    NO internet downloads. Run this on a machine WITH internet access; the
    resulting zip is fully offline-usable.

    Included in the zip:
      dist/ (compiled tool), config/ (incl. rate tables), docs/, tools/generate-demo-data.mjs,
      node_modules/ (runtime deps only), README.md, RUN-GUIDE.md, .env.example,
      package.json, prerequisites/ (Node.js MSI + Azure CLI MSI unless -SkipPrerequisites)

    Excluded: .env, data/, output/, tests/, src/, devDependencies.

.PARAMETER SkipPrerequisites
    Skip downloading the Node.js and Azure CLI installers (smaller zip; customer
    must already have Node 20+).

.PARAMETER OutFile
    Output zip path. Default: CreditTransitionSizer_<yyyyMMdd>.zip in the package root.

.EXAMPLE
    pwsh tools/Build-CustomerPackage.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipPrerequisites,
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $OutFile) { $OutFile = Join-Path $root ("CreditTransitionSizer_{0}.zip" -f (Get-Date -Format 'yyyyMMdd')) }

Write-Host "== credit-transition-sizer customer package builder ==" -ForegroundColor Cyan

# 1. Fresh build
Write-Host "[1/5] Building (tsc)..."
Push-Location $root
try { npm run build | Out-Null } finally { Pop-Location }
if (-not (Test-Path (Join-Path $root 'dist\cli.js'))) { throw 'Build failed: dist/cli.js missing.' }

# 2. Stage files
Write-Host "[2/5] Staging files..."
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "cts-package-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $staging | Out-Null

Copy-Item (Join-Path $root 'dist')   (Join-Path $staging 'dist')   -Recurse
Copy-Item (Join-Path $root 'config') (Join-Path $staging 'config') -Recurse
Copy-Item (Join-Path $root 'docs')   (Join-Path $staging 'docs')   -Recurse
# internal validation log contains Sayed's tenant details — never ship it
Remove-Item (Join-Path $staging 'docs\VALIDATION-WALKTHROUGH.md') -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $staging 'tools') | Out-Null
Copy-Item (Join-Path $root 'tools\generate-demo-data.mjs') (Join-Path $staging 'tools\')
foreach ($f in 'README.md', 'RUN-GUIDE.md', '.env.example', 'package.json', 'package-lock.json') {
    Copy-Item (Join-Path $root $f) (Join-Path $staging $f)
}
New-Item -ItemType Directory -Path (Join-Path $staging 'output') | Out-Null

# 3. Production-only node_modules
Write-Host "[3/5] Installing production dependencies into the staging folder..."
Push-Location $staging
try {
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund | Out-Null
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $staging 'node_modules\exceljs'))) { throw 'npm ci failed: node_modules incomplete.' }

# 4. Prerequisite installers (official Microsoft/OpenJS sources)
if (-not $SkipPrerequisites) {
    Write-Host "[4/5] Downloading prerequisite installers (official sources)..."
    $prereq = Join-Path $staging 'prerequisites'
    New-Item -ItemType Directory -Path $prereq | Out-Null

    # Latest Node.js LTS x64 MSI, resolved from the official release index.
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    $nodeMsi = "node-$($lts.version)-x64.msi"
    Write-Host "      Node.js LTS: $($lts.version) ($($lts.lts))"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$($lts.version)/$nodeMsi" -OutFile (Join-Path $prereq $nodeMsi)

    # Latest Azure CLI x64 MSI via Microsoft's stable alias.
    Write-Host "      Azure CLI (latest MSI)..."
    Invoke-WebRequest -Uri 'https://aka.ms/installazurecliwindows' -OutFile (Join-Path $prereq 'azure-cli-latest-x64.msi') -MaximumRedirection 10

    Set-Content -Path (Join-Path $prereq 'README.txt') -Value @'
Prerequisite installers (downloaded from official sources at package build time):
  - node-*.msi           Node.js LTS (required)   source: https://nodejs.org/dist
  - azure-cli-*.msi      Azure CLI (only for auth option A)   source: https://aka.ms/installazurecliwindows
Install by double-clicking, accept defaults, then open a NEW PowerShell window.
'@
} else {
    Write-Host "[4/5] Skipping prerequisite installers (-SkipPrerequisites)."
}

# 5. Zip
Write-Host "[5/5] Creating $OutFile ..."
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $OutFile -CompressionLevel Optimal
Remove-Item $staging -Recurse -Force

$size = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
Write-Host "Done: $OutFile ($size MB)" -ForegroundColor Green
Write-Host "Customer entry point: RUN-GUIDE.md"
