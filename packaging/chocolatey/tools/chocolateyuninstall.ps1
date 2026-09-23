$ErrorActionPreference = 'Stop'

# Get-UninstallRegistryKey returns $null (not nothing) when no key matches,
# and @($null) is a one-element array, so filter before counting. Without this
# a user who removed LogTapper from Settings > Apps first got a GetFullPath
# error here (caught by scripts/verify-chocolatey.ps1, step 4).
$keys = @(Get-UninstallRegistryKey -SoftwareName 'LogTapper*' | Where-Object { $_ })
if ($keys.Count -eq 0) {
  Write-Host 'LogTapper is not registered in Add/Remove Programs; nothing to uninstall.'
  return
}

foreach ($key in $keys) {
  Uninstall-ChocolateyPackage -PackageName 'logtapper' -FileType 'exe' `
    -SilentArgs '/S' -ValidExitCodes @(0) -File ($key.UninstallString -replace '"', '')
}
