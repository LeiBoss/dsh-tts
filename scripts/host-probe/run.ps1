<#
.SYNOPSIS
Host-level integration check for @leiboss/dsh-tts and @leiboss/dsh-voiceover.

.DESCRIPTION
Builds the monorepo, packs both packages, creates a throwaway headless DSH
profile, installs engine + product + probe, boots it twice, and asserts what the
real host resolved:

  * the engine published `ctx.tts` (a dependent with inject: ['tools','tts'] ran)
  * exactly one set of tools registered (installing both packages must not mount
    the engine twice; this relies on both patches using the id `dsh-tts`)
  * a real synthesis produced audio with exact duration and word boundaries
  * a second synthesis of the same text hit the cache and kept the boundaries

A fresh headless profile has no model key, so each boot ends with
MISSING_CREDENTIAL. That is expected: every assertion is settled during the
mount phase, before any model call. Set DEEPSEEK_API_KEY if you also want the
agent to run a task.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/host-probe/run.ps1
#>
[CmdletBinding()]
param(
  [string]$Profile = 'tts-host-probe',
  [string]$DshPath = 'C:\Users\LeiBoss\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [switch]$KeepProfile
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$dsh = $DshPath
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$packDir = Join-Path $repo '.pack'
$probeDir = $PSScriptRoot
$failures = New-Object System.Collections.Generic.List[string]

function Step([string]$message) { Write-Host "== $message" -ForegroundColor Cyan }

function Check([bool]$condition, [string]$message) {
  if ($condition) { Write-Host "  PASS $message" -ForegroundColor Green }
  else { Write-Host "  FAIL $message" -ForegroundColor Red; $failures.Add($message) }
}

# Native commands write progress to stderr. Under the default Stop preference
# PowerShell 5.1 turns that into a terminating NativeCommandError, so run them
# with a local Continue preference and surface only the exit code.
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $exe @arguments 2>&1 | Out-Null
    return $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $previous }
}

if (-not (Test-Path $dsh)) { throw "dsh CLI not found at $dsh (pass -DshPath)" }

Step 'build'
Push-Location $repo
if ((Invoke-Native 'npm' @('run', 'build')) -ne 0) { Pop-Location; throw 'build failed' }

Step 'pack'
New-Item -ItemType Directory -Force -Path $packDir | Out-Null
Push-Location (Join-Path $repo 'packages\tts')
if ((Invoke-Native 'npm' @('pack', '--pack-destination', $packDir)) -ne 0) { Pop-Location; throw 'pack of @leiboss/dsh-tts failed' }
Pop-Location

# The product depends on @leiboss/dsh-tts@^0.3.0, which is not published yet, so
# the packed copy points at the local tarball. The manifest is restored after.
$voPkg = Join-Path $repo 'packages\voiceover\package.json'
$original = [System.IO.File]::ReadAllText($voPkg, [System.Text.Encoding]::UTF8)
try {
  $tgzSpec = 'file:' + ($packDir -replace '\\', '/') + '/leiboss-dsh-tts-0.3.0.tgz'
  $patched = $original.Replace('"@leiboss/dsh-tts": "^0.3.0"', '"@leiboss/dsh-tts": "' + $tgzSpec + '"')
  [System.IO.File]::WriteAllText($voPkg, $patched, (New-Object System.Text.UTF8Encoding($false)))
  Push-Location (Join-Path $repo 'packages\voiceover')
  if ((Invoke-Native 'npm' @('pack', '--pack-destination', $packDir)) -ne 0) { Pop-Location; throw 'pack of @leiboss/dsh-voiceover failed' }
  Pop-Location
}
finally {
  [System.IO.File]::WriteAllText($voPkg, $original, (New-Object System.Text.UTF8Encoding($false)))
}

Step "recreate profile $Profile"
if (Test-Path $profileDir) { Remove-Item $profileDir -Recurse -Force }
Invoke-Native $dsh @('--profile', $Profile, '--from-default-profile', 'headless', '--dump-config') | Out-Null
if (-not (Test-Path $profileDir)) { throw 'profile was not created' }

Step 'install engine + product + probe'
if ((Invoke-Native $dsh @('plugin', '--profile', $Profile, 'add', (Join-Path $packDir 'leiboss-dsh-tts-0.3.0.tgz'))) -ne 0) { throw 'install of @leiboss/dsh-tts failed' }
if ((Invoke-Native $dsh @('plugin', '--profile', $Profile, 'add', (Join-Path $packDir 'leiboss-dsh-voiceover-0.2.0.tgz'))) -ne 0) { throw 'install of @leiboss/dsh-voiceover failed' }
if ((Invoke-Native $dsh @('plugin', '--profile', $Profile, 'add', $probeDir)) -ne 0) { throw 'install of the probe plugin failed' }

Step 'boot twice (cache miss, then cache hit)'
$env:DSH_TTS_PROBE_SYNTH = '1'
$env:DSH_TTS_PROBE_TEXT = "host probe $([guid]::NewGuid().ToString('N').Substring(0, 8)) 联调测试"
$results = @()
foreach ($run in 1, 2) {
  $out = Join-Path $packDir "probe-run$run.json"
  $env:DSH_TTS_PROBE_OUT = $out
  Remove-Item $out -ErrorAction SilentlyContinue
  Invoke-Native $dsh @('--profile', $Profile, 'ping') | Out-Null
  if (-not (Test-Path $out)) { throw "probe produced no result on run $run" }
  $results += Get-Content $out -Raw | ConvertFrom-Json
}

Step 'assertions'
$first = $results[0]
$second = $results[1]
Check ($first.stage -eq 'applied') 'probe applied (inject tools+tts resolved)'
Check ($first.hasTts -and $first.hasSynthesize) 'ctx.get("tts") returns a service with synthesize()'
foreach ($name in @('tts_generate', 'tts_self_check', 'tts_probe_network', 'voiceover_create', 'voiceover_status', 'voiceover_export', 'voiceover_rerun')) {
  Check ($first.toolNames -contains $name) "tool registered: $name"
}
Check (@($first.duplicates).Count -eq 0) 'no duplicate tool registration (engine mounted once)'
Check ($first.synth.ok -eq $true) 'first synthesis succeeded'
Check ($first.synth.engine -eq 'edge-js') 'pure-JS engine used (no Python)'
Check ([int]$first.synth.words -gt 0) 'word boundaries returned on a cache miss'
Check ([int]$first.synth.durationMs -gt 0) 'exact duration measured'
Check ($second.synth.fromCache -eq $true) 'second run hit the cache'
Check ([int]$second.synth.words -gt 0) 'word boundaries survive a cache hit'

Step 'cleanup'
if (-not $KeepProfile) { Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue }
Pop-Location

if ($failures.Count -eq 0) {
  Write-Host 'HOST PROBE PASSED' -ForegroundColor Green
  exit 0
}
Write-Host "HOST PROBE FAILED ($($failures.Count) check(s))" -ForegroundColor Red
$failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
exit 1