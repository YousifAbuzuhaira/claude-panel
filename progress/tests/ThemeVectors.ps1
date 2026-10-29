#Requires -Version 5.1
# Checks widget/Theme.ps1 against tests/theme-vectors.json, the palettes web/public/shared/theme.js
# must give too. Prints each mismatch and exits 1 if there is one.
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\ThemeVectors.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
. (Join-Path $PSScriptRoot '..\widget\Theme.ps1')
$vectors = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'theme-vectors.json')) | ConvertFrom-Json
$failed = 0
foreach ($case in $vectors.cases) {
  $palette = Get-ThemePalette @{ bg = $case.colors.bg; accent = $case.colors.accent; text = $case.colors.text } ([double]$case.opacity)
  foreach ($role in $THEME_ROLES) {
    $want = [string]$case.expected.$role
    if ($palette[$role] -ne $want) {
      Write-Output ('{0}.{1}: got {2}, want {3}' -f $case.name, $role, $palette[$role], $want)
      $failed++
    }
  }
}
if ($failed) { exit 1 }
Write-Output ('ok: {0} schemes' -f @($vectors.cases).Count)
