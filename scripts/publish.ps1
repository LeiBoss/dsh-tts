#!/usr/bin/env pwsh
<#
.SYNOPSIS
Publish both packages in dependency order, using a Node that can run the tests.

.DESCRIPTION
Two problems this script exists to solve:

1. npm runs lifecycle scripts through `cmd /c node ...`, which resolves `node`
   from PATH. A shell with Node 20 on PATH therefore fails inside check-node.mjs
   even when the caller exported a newer Node. This script finds a suitable Node
   and prepends it to PATH for every child process.

2. `npm publish` builds and tests before uploading, so a 30-second TOTP often
   expires before the request leaves the machine. Build and tests run first, then
   the upload uses `--ignore-scripts` so the PUT happens immediately.

.PARAMETER DryRun
Runs verification and packing without uploading.

.PARAMETER Otp
One-time password for accounts with 2FA. Generate it right before running;
the upload starts within a couple of seconds.

.EXAMPLE
pwsh -File scripts/publish.ps1 -DryRun

.EXAMPLE
# account uses 2FA: build/test, then publish fast with a fresh code
pwsh -File scripts/publish.ps1 -Otp 123456
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$Otp
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

function Find-Node {
  $candidates = @()
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath -and $onPath.Source) { $candidates += $onPath.Source }
  $candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')

  foreach ($candidate in $candidates) {
    if (-not (Test-Path $candidate)) { continue }
    $version = (& $candidate --version).Trim()
    $parts = $version.TrimStart('v').Split('.')
    if ($parts.Count -lt 2) { continue }
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 18)) {
      return [pscustomobject]@{ Path = $candidate; Version = $version }
    }
  }
  throw 'No Node >= 22.18 found. Install one, or put it first on PATH.'
}

function Read-Package([string]$relative) {
  $path = Join-Path $repo $relative
  return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Invoke-Native([string]$label, [scriptblock]$body) {
  & $body
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

$node = Find-Node
$nodeDir = Split-Path $node.Path -Parent
$env:PATH = "$nodeDir;$env:PATH"
Write-Host "node        : $($node.Version) ($nodeDir)" -ForegroundColor Cyan

$tts = Read-Package 'packages\tts\package.json'
$voiceover = Read-Package 'packages\voiceover\package.json'
Write-Host "engine      : $($tts.name)@$($tts.version)" -ForegroundColor Cyan
Write-Host "product     : $($voiceover.name)@$($voiceover.version)" -ForegroundColor Cyan

# The product's dependency range must be satisfiable by the engine version being
# published, otherwise `dsh plugin add` fails for everyone.
function Test-CaretRange([string]$range, [string]$version) {
  if (-not $range.StartsWith('^')) { return $true }
  $low = [version]($range.TrimStart('^'))
  $high = [version]$version
  if ($high -lt $low) { return $false }
  if ($low.Major -eq 0) {
    # ^0.3.0 means >=0.3.0 <0.4.0
    return ($high.Major -eq 0 -and $high.Minor -eq $low.Minor)
  }
  return ($high.Major -eq $low.Major)
}

$range = [string]$voiceover.dependencies.'@leiboss/dsh-tts'
if ($range -and -not (Test-CaretRange $range $tts.version)) {
  throw "voiceover depends on @leiboss/dsh-tts@$range, which $($tts.version) does not satisfy. Align them before publishing."
}

Write-Host "`n== verify (build + tests)" -ForegroundColor Cyan
Push-Location $repo
try {
  Invoke-Native 'npm run build' { npm run build }
  Invoke-Native 'npm test' { npm test }
}
finally {
  Pop-Location
}

foreach ($relative in @('packages\tts', 'packages\voiceover')) {
  $package = if ($relative -like '*tts*') { $tts } else { $voiceover }
  Write-Host "`n== publishing $($package.name)@$($package.version)" -ForegroundColor Cyan
  Push-Location (Join-Path $repo $relative)
  try {
    # --ignore-scripts on purpose: build and tests already ran above, and a fresh
    # TOTP only lasts 30 seconds -- the upload must not spend them on tsc.
    $arguments = @('publish', '--access', 'public', '--ignore-scripts')
    if ($DryRun) { $arguments += '--dry-run' }
    if ($Otp) { $arguments += "--otp=$Otp" }
    & npm @arguments
    if ($LASTEXITCODE -ne 0) {
      Write-Host ''
      if ($LASTEXITCODE -eq 1) {
        Write-Host 'If the error mentions 2FA, either pass -Otp <fresh code> or create a' -ForegroundColor Yellow
        Write-Host 'granular access token with "bypass 2FA" and set it in your ~/.npmrc.' -ForegroundColor Yellow
      }
      throw "npm publish failed for $($package.name)"
    }
  }
  finally {
    Pop-Location
  }
}

function Wait-Tarball([string]$name, [string]$version, [int]$timeoutSeconds = 600) {
  # A publish answers immediately, but the tarball is queued for processing and
  # 404s for a few minutes. Checking only the metadata therefore reports success
  # on something nobody can install yet.
  $leaf = $name.Split('/')[-1]
  $url = "https://registry.npmjs.org/$name/-/$leaf-$version.tgz"
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt += 1
    try {
      $response = Invoke-WebRequest -Uri "$url`?probe=$attempt" -Method Head -UseBasicParsing -TimeoutSec 20
      if ($response.StatusCode -eq 200) {
        Write-Host "  $name@$version tarball ready" -ForegroundColor Green
        return $true
      }
    }
    catch {
      Write-Host "  $name@$version tarball not ready yet (attempt $attempt)" -ForegroundColor DarkYellow
    }
    Start-Sleep -Seconds 15
  }
  Write-Host "  $name@$version tarball still 404 after $timeoutSeconds s" -ForegroundColor Red
  return $false
}

if (-not $DryRun) {
  Write-Host "`n== verify the tarballs are downloadable" -ForegroundColor Cyan
  $ttsReady = Wait-Tarball $tts.name $tts.version
  $voiceoverReady = Wait-Tarball $voiceover.name $voiceover.version
  if (-not ($ttsReady -and $voiceoverReady)) {
    throw 'Published, but a tarball is not downloadable yet. Re-run the install check in a few minutes.'
  }
  Write-Host "`n== verify the registry" -ForegroundColor Cyan
  & npm view $tts.name version
  & npm view $voiceover.name version
  & npm view $voiceover.name dependencies
  Write-Host "`nNext: install it into a clean profile and boot it:" -ForegroundColor Green
  Write-Host "  dsh --profile verify --from-default-profile web --dump-config"
  Write-Host "  dsh plugin --profile verify add $($voiceover.name)"
  Write-Host "  dsh verify"
}

# A successful run must report success: PowerShell would otherwise inherit the
# exit code of the last native command it ran.
exit 0
