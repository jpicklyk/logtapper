$ErrorActionPreference = 'Stop'

# Chocolatey's own idiom. Not @(...): Get-UninstallRegistryKey returns $null
# when nothing matches, and @($null).Count is 1 (verify-chocolatey.ps1 step 4).
[array]$keys = Get-UninstallRegistryKey -SoftwareName 'LogTapper*'
if ($keys.Count -eq 0) {
  Write-Host 'LogTapper is not registered in Add/Remove Programs; nothing to uninstall.'
  return
}

foreach ($key in $keys) {
  Uninstall-ChocolateyPackage -PackageName 'logtapper' -FileType 'exe' `
    -SilentArgs '/S' -ValidExitCodes @(0) -File ($key.UninstallString -replace '"', '')
}
