#!/usr/bin/env pwsh
<#
.SYNOPSIS
Publish both packages in dependency order, using a Node that can run the tests.

.DESCRIPTION
`prepublishOnly` runs `npm test`, and the tests execute TypeScript directly, so
they need Node >= 22.18. npm runs lifecycle scripts through `cmd /c node ...`,
which resolves `node` from PATH — so merely running `npm publish` in a shell whose
PATH still points at Node 20 fails inside check-node.mjs.

This script finds a suitable Node, prepends its directory to PATH for every child
process, and then publishes:
  1. @leiboss/dsh-tts          (the engine: nothing depends on it yet)
  2. @leiboss/dsh-voiceover    (depends on @leiboss/dsh-tts@^0.3.0)

.PARAMETER DryRun
Runs the whole flow (including build and tests) without uploading.

.PARAMETER Otp
One-time password for accounts with 2FA enabled.

.EXAMPLE
pwsh -File scripts/publish.ps1 -DryRun
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
  throw 'No Node >= 22.18 found. Install one, or pass it by putting it first on PATH.'
}

function Read-Package([string]$relative) {
  $path = Join-Path $repo $relative
  return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
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
$range = [string]$voiceover.dependencies.'@leiboss/dsh-tts'
if ($range -and $range.StartsWith('^')) {
  $expected = $range.TrimStart('^')
  if ($tts.version -ne $expected) {
    throw "voiceover depends on @leiboss/dsh-tts@$range but the engine is at $($tts.version). Align them before publishing."
  }
}

if ($DryRun) { Write-Host "dry run     : nothing will be uploaded" -ForegroundColor Yellow }

foreach ($relative in @('packages\tts', 'packages\voiceover')) {
  $package = if ($relative -like '*tts*') { $tts } else { $voiceover }
  Write-Host "`n== publishing $($package.name)@$($package.version)" -ForegroundColor Cyan
  Push-Location (Join-Path $repo $relative)
  try {
    $arguments = @('publish', '--access', 'public')
    if ($DryRun) { $arguments += '--dry-run' }
    if ($Otp) { $arguments += "--otp=$Otp" }
    & npm @arguments
    if ($LASTEXITCODE -ne 0) { throw "npm publish failed for $($package.name)" }
  }
  finally {
    Pop-Location
  }
}

if (-not $DryRun) {
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
