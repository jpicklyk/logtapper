<#
.SYNOPSIS
  Install-test the rendered Chocolatey package on a disposable Windows machine.

.DESCRIPTION
  What a maintainer would otherwise check by hand in a sandbox before a push
  (plans/chocolatey-channel.md, Verification). It installs LogTapper
  machine-wide into Program Files and uninstalls it again several times, so
  run it only on a throwaway machine: CI runs it on a fresh windows-latest
  runner from .github/workflows/verify-chocolatey.yml. Needs choco and an
  elevated shell. Never needs the Chocolatey API key; nothing is pushed.

  Expects `node scripts/render-packaging.mjs --out <RenderedDir>` to have run
  and `choco pack` to have written logtapper.<Version>.nupkg into <PackageDir>.

  Every check runs even after an earlier one fails; the script exits 1 at the
  end with the list of failures.

.EXAMPLE
  ./scripts/verify-chocolatey.ps1 -Version 0.13.3 -RenderedDir out -PackageDir pkg
#>
param(
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $RenderedDir,
  [Parameter(Mandatory)] [string] $PackageDir
)

$ErrorActionPreference = 'Stop'

# Literal, not derived from $env:ProgramFiles or the ARP entry: this is the
# exact path the unit test nsis_install_is_not_managed pins as not managed.
# managed_by() in src-tauri/src/commands/app_update.rs is is_scoop_managed
# (current_exe), and Settings > General > Updates shows its "managed by"
# message only when that returns Some, so finding the app here is the check
# that a Chocolatey install gets the normal update controls.
$InstallDir = 'C:\Program Files\LogTapper'
$AppExe = Join-Path $InstallDir 'log-tapper.exe'
$SidecarExe = Join-Path $InstallDir 'logtapper-mcp.exe'
$RenderedDir = (Resolve-Path $RenderedDir).Path
$PackageDir = (Resolve-Path $PackageDir).Path
$failures = [System.Collections.Generic.List[string]]::new()

function Step([string] $name) { Write-Host "`n=== $name" }

function Check([bool] $ok, [string] $what) {
  if ($ok) {
    Write-Host "  ok   $what"
  } else {
    Write-Host "  FAIL $what"
    if ($env:GITHUB_ACTIONS) { Write-Host "::error::$what" }
    $failures.Add($what)
  }
}

function Warn([string] $what) {
  Write-Host "  warn $what"
  if ($env:GITHUB_ACTIONS) { Write-Host "::warning::$what" }
}

# choco with -y, its output echoed indented, then a Check on its exit code:
# 0 unless -ExpectFailure. Returns the code and output for further checks.
function Invoke-Choco([string[]] $arguments, [string] $what, [switch] $ExpectFailure) {
  $out = & choco @arguments -y --no-progress 2>&1
  $code = $LASTEXITCODE
  $out | ForEach-Object { Write-Host "    $_" }
  Check (($code -eq 0) -ne $ExpectFailure.IsPresent) "$what (got $code)"
  [pscustomobject]@{ Code = $code; Output = ($out -join "`n") }
}

function Get-ArpEntry {
  Get-ItemProperty -ErrorAction SilentlyContinue -Path @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  ) | Where-Object { $_.DisplayName -eq 'LogTapper' } | Select-Object -First 1
}

function Wait-Until([scriptblock] $condition, [int] $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $condition) { return $true }
    Start-Sleep -Seconds 1
  }
  return [bool](& $condition)
}

function Stop-LogTapper {
  Get-Process -Name 'log-tapper', 'logtapper-mcp' -ErrorAction SilentlyContinue | Stop-Process -Force
}

# ---------------------------------------------------------------------------
Step "1. install from the local package"
$r = Invoke-Choco @('install', 'logtapper', '--source', $PackageDir) 'choco install exits 0'
Check (Test-Path $AppExe) "app installed machine-wide at $AppExe"
Check (Test-Path $SidecarExe) "MCP sidecar installed beside it"
$arp = Get-ArpEntry
Check ($null -ne $arp) "Add/Remove Programs entry 'LogTapper' under HKLM"
if ($arp) {
  Check ($arp.Publisher -eq 'Jeff Picklyk') "ARP Publisher is 'Jeff Picklyk' (got '$($arp.Publisher)')"
  Check ($arp.DisplayVersion -eq $Version) "ARP DisplayVersion is $Version (got '$($arp.DisplayVersion)')"
}
foreach ($ext in '.lts', '.ltw') {
  Check (Test-Path "Registry::HKEY_CLASSES_ROOT\$ext") "file association registered for $ext"
}

# ---------------------------------------------------------------------------
Step "2. reinstall over a running app"
$app = $null
if (Test-Path $AppExe) {
  $app = Start-Process -FilePath $AppExe -PassThru
  # A fixed wait, not Wait-Until on the process: the question is whether the
  # GUI *stays* up on a headless runner. Polling would pass the instant the
  # process exists, and an app that then crashed would read as "closed by
  # the installer" below.
  Start-Sleep -Seconds 10
}
$wasRunning = $null -ne $app -and [bool](Get-Process -Id $app.Id -ErrorAction SilentlyContinue)
if ($wasRunning) {
  $sidecarRunning = [bool](Get-Process -Name 'logtapper-mcp' -ErrorAction SilentlyContinue)
  Write-Host "  app running (pid $($app.Id)); sidecar running: $sidecarRunning"
} else {
  Warn "the app did not stay running on this machine, so the running-app half of step 2 was not exercised (a headless runner may not keep a GUI process up)"
}
$r = Invoke-Choco @('install', 'logtapper', '--source', $PackageDir, '--force') 'reinstall with --force exits 0'
if ($wasRunning) {
  Check (-not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) "installer closed the running app instead of stopping on it"
}
Check (Test-Path $AppExe) "app still installed after the reinstall"
Stop-LogTapper

# ---------------------------------------------------------------------------
Step "3. uninstall"
$r = Invoke-Choco @('uninstall', 'logtapper') 'choco uninstall exits 0'
if (Test-Path $AppExe) {
  Warn "files were still present when choco uninstall returned: the NSIS uninstaller detached. chocolateyuninstall.ps1 may want -SilentArgs '/S _?=<InstallLocation>' (plans/chocolatey-channel.md)"
} else {
  Write-Host "  uninstall was synchronous: files gone when choco returned"
}
Check (Wait-Until { -not (Test-Path $AppExe) } 60) "app binary removed"
Check (Wait-Until { $null -eq (Get-ArpEntry) } 60) "ARP entry removed"
Check (-not (Get-Process -Name 'logtapper-mcp' -ErrorAction SilentlyContinue)) "no orphaned sidecar process"
if (Test-Path $InstallDir) {
  Warn "install directory left behind, containing: $((Get-ChildItem $InstallDir -Recurse -Name) -join ', ')"
}

# ---------------------------------------------------------------------------
Step "4. choco uninstall after the app was already removed by hand"
$r = Invoke-Choco @('install', 'logtapper', '--source', $PackageDir) 'install for this step exits 0'
$arp = Get-ArpEntry
if ($arp) {
  $uninstaller = $arp.UninstallString -replace '"', ''
  Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
  Check (Wait-Until { $null -eq (Get-ArpEntry) } 60) "running the NSIS uninstaller directly removed the ARP entry"
  $r = Invoke-Choco @('uninstall', 'logtapper') 'choco uninstall with no ARP entry exits 0'
  Check ($r.Output -match 'nothing to uninstall') "chocolateyuninstall.ps1 took its 'nothing to uninstall' path"
} else {
  Check $false "ARP entry present after the step-4 install (cannot exercise the manual-uninstall path)"
}
Stop-LogTapper

# ---------------------------------------------------------------------------
Step "5. a tampered checksum aborts the install"
$work = Join-Path ([IO.Path]::GetTempPath()) "logtapper-tamper-$PID"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $RenderedDir 'chocolatey') -Destination $work -Recurse
$installScript = Join-Path $work 'tools\chocolateyinstall.ps1'
$original = Get-Content $installScript -Raw
$tampered = [regex]::Replace($original, "(checksum64\s*=\s*')([0-9a-fA-F])", {
    param($m)
    $flip = if ($m.Groups[2].Value -eq '0') { '1' } else { '0' }
    $m.Groups[1].Value + $flip
  })
Check ($tampered -ne $original) "checksum64 edited in the test copy"
Set-Content -Path $installScript -Value $tampered -NoNewline
$tamperedPkg = Join-Path $work 'pkg'
& choco pack (Join-Path $work 'logtapper.nuspec') --out $tamperedPkg 2>&1 | ForEach-Object { Write-Host "    $_" }
Check ($LASTEXITCODE -eq 0) "tampered package packs"
# --force so this step does not depend on the earlier ones: if an earlier
# uninstall failed, choco still lists logtapper as installed and would answer
# "already installed" with exit 0 without ever checking the checksum.
$r = Invoke-Choco @('install', 'logtapper', '--source', $tamperedPkg, '--force') 'install with a wrong checksum fails' -ExpectFailure
Check ($r.Output -match '(?i)checksum') "and it fails on the checksum, not for some other reason"
Check (-not (Test-Path $AppExe)) "nothing was installed from the tampered package"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
Step "result"
if ($failures.Count -gt 0) {
  Write-Host "$($failures.Count) check(s) failed for logtapper $($Version):"
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host "all checks passed for logtapper $Version"
exit 0
