# Deploy Anchor Watch to Fly.io
# Prerequisites:
#   1. fly auth login
#   2. Account unlocked: https://fly.io/high-risk-unlock
#   3. fly-secrets.local.env exists (generated once)
#
# Usage (from repo root):
#   .\scripts\fly-deploy.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$App = "breeze-anchor-watch"
$SecretsFile = Join-Path $Root "fly-secrets.local.env"

if (-not (Test-Path $SecretsFile)) {
  Write-Error "Missing $SecretsFile — generate secrets first."
}

# Parse KEY=VALUE lines
$vars = @{}
Get-Content $SecretsFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq "" -or $line.StartsWith("#")) { return }
  $i = $line.IndexOf("=")
  if ($i -lt 1) { return }
  $vars[$line.Substring(0, $i)] = $line.Substring($i + 1)
}

foreach ($k in @("BOAT_TOKEN", "VIEW_TOKEN")) {
  if (-not $vars.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($vars[$k])) {
    Write-Error "Missing $k in $SecretsFile"
  }
}

Write-Host "==> Ensuring app exists: $App"
$exists = $true
try {
  fly status -a $App 2>$null | Out-Null
} catch {
  $exists = $false
}
# fly status returns non-zero if missing
fly status -a $App 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating app..."
  fly apps create $App
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "==> Setting secrets"
fly secrets set `
  "BOAT_TOKEN=$($vars.BOAT_TOKEN)" `
  "VIEW_TOKEN=$($vars.VIEW_TOKEN)" `
  "BOAT_NAME=$($vars.BOAT_NAME ?? 'Breeze')" `
  -a $App
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Deploying (Docker build on Fly)"
fly deploy -a $App
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Deploy complete."
Write-Host "Health:  https://$App.fly.dev/api/health"
Write-Host "Phone:   https://$App.fly.dev/watch?token=$($vars.VIEW_TOKEN)"
Write-Host ""
Write-Host "On the boat, set:"
Write-Host "  CLOUD_URL=https://$App.fly.dev"
Write-Host "  BOAT_TOKEN=(from fly-secrets.local.env)"
