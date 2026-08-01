# Switch active cloud host between Fly and Suga (local config + printed boat/phone steps).
#
# Usage (from repo root):
#   .\scripts\switch-cloud.ps1 -Target fly
#   .\scripts\switch-cloud.ps1 -Target suga
#
# Reads fly-secrets.local.env (or cloud-secrets.local.env) for tokens and URLs.
# Does NOT redeploy — only updates CLOUD_HOST / CLOUD_URL in the local secrets file
# and prints what to change on the boat and phone.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('fly', 'suga')]
  [string]$Target
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$SecretsFile = Join-Path $Root 'fly-secrets.local.env'
if (-not (Test-Path $SecretsFile)) {
  $alt = Join-Path $Root 'cloud-secrets.local.env'
  if (Test-Path $alt) { $SecretsFile = $alt }
  else {
    Write-Error "Missing fly-secrets.local.env (or cloud-secrets.local.env). See cloud-hosts.example.env"
  }
}

function Read-EnvFile([string]$path) {
  $vars = [ordered]@{}
  Get-Content $path | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    $i = $line.IndexOf('=')
    if ($i -lt 1) { return }
    $vars[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim()
  }
  return $vars
}

function Write-EnvFile([string]$path, $vars) {
  $lines = @(
    '# LOCAL ONLY — do not commit.',
    '# CLOUD_HOST selects fly | suga for boat agent scripts.',
    ''
  )
  foreach ($k in $vars.Keys) {
    $lines += "$k=$($vars[$k])"
  }
  # Preserve CLOUD_URL as alias of the active host URL for boat-agent
  Set-Content -Path $path -Value ($lines -join "`n") -Encoding utf8
}

$vars = Read-EnvFile $SecretsFile

foreach ($k in @('BOAT_TOKEN', 'VIEW_TOKEN')) {
  if (-not $vars.Contains($k) -or [string]::IsNullOrWhiteSpace([string]$vars[$k])) {
    Write-Error "Missing $k in $SecretsFile"
  }
}

$flyUrl = if ($vars.Contains('CLOUD_URL_FLY') -and $vars['CLOUD_URL_FLY']) {
  $vars['CLOUD_URL_FLY']
} elseif ($vars.Contains('CLOUD_URL') -and $vars['CLOUD_URL'] -match 'fly\.dev') {
  $vars['CLOUD_URL']
} else {
  'https://breeze-anchor-watch.fly.dev'
}

$sugaUrl = if ($vars.Contains('CLOUD_URL_SUGA')) { $vars['CLOUD_URL_SUGA'] } else { '' }

if ($Target -eq 'suga') {
  if ([string]::IsNullOrWhiteSpace($sugaUrl) -or $sugaUrl -match 'YOUR-SERVICE|suga-xxxx') {
    Write-Error @"
CLOUD_URL_SUGA is not set in $SecretsFile.

1. Deploy the container on https://dashboard.suga.app
2. Enable public HTTPS (port 8787)
3. Copy the generated https://… URL into CLOUD_URL_SUGA=
4. Re-run: .\scripts\switch-cloud.ps1 -Target suga
"@
  }
  $activeUrl = $sugaUrl.TrimEnd('/')
} else {
  $activeUrl = $flyUrl.TrimEnd('/')
}

$vars['CLOUD_URL_FLY'] = $flyUrl.TrimEnd('/')
if ($sugaUrl) { $vars['CLOUD_URL_SUGA'] = $sugaUrl.TrimEnd('/') }
$vars['CLOUD_HOST'] = $Target
$vars['CLOUD_URL'] = $activeUrl
if (-not $vars.Contains('BOAT_NAME') -or -not $vars['BOAT_NAME']) {
  $vars['BOAT_NAME'] = 'Breeze'
}

Write-EnvFile $SecretsFile $vars

$view = $vars['VIEW_TOKEN']
$boat = $vars['BOAT_TOKEN']

Write-Host ""
Write-Host "Active cloud host: $Target"
Write-Host "CLOUD_URL:         $activeUrl"
Write-Host ""
Write-Host "Health check:"
Write-Host "  $activeUrl/api/health"
Write-Host ""
Write-Host "Phone watch URL:"
Write-Host "  $activeUrl/watch?token=$view"
Write-Host ""
Write-Host "Boat agent (PowerShell) — restart after setting:"
Write-Host "  `$env:CLOUD_URL=`"$activeUrl`""
Write-Host "  `$env:BOAT_TOKEN=`"$boat`""
Write-Host "  `$env:SIGNALK_HOST=`"localhost:3000`""
Write-Host "  `$env:PUSH_INTERVAL_MS=`"3000`""
Write-Host "  cd boat-agent; npm start"
Write-Host ""
Write-Host "Browser publish (boat UI Settings):"
Write-Host "  Cloud URL = $activeUrl"
Write-Host "  Boat token = (same BOAT_TOKEN)"
Write-Host ""
Write-Host "Note: Fly and Suga keep separate in-memory history. Switching hosts"
Write-Host "starts a fresh cloud session on the other side until the boat pushes again."
