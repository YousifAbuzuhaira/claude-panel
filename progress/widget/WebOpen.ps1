#Requires -Version 5.1
# How a Windows window asks the plugin's web server for a page (Learn.ps1, and Open-InBrowser in
# Chrome.ps1): `server.mjs open <page> ...` with CLAUDE_PANEL_LAUNCH=1, which answers a one-time
# link to open here, or `existing` when a Learn page is open already. Dot-sourced. Kept to ASCII.
#
# Run from \\wsl.localhost\<distro>\...\widget (Claude Code in WSL): wsl.exe runs web/web.sh in
# that distro, which finds its Node. Run from a Windows folder (Claude Code on Windows itself, with
# Git Bash): node.exe from PATH runs web\server.mjs beside this folder.

# The process to start, set to hand back its output; $null when there is no way to run the server.
# `-New` asks for a link even with a Learn page open (its window couldn't be found).
function New-WebOpenStart([string]$Page, [string]$Extra = '', [switch]$New) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.WorkingDirectory = $env:TEMP
  $words = ("open $Page $Extra").Trim()
  $match = [regex]::Match([string]$PSScriptRoot, '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)$', 'IgnoreCase')
  if ($match.Success) {
    $distro = $match.Groups[1].Value
    $webScript = ($match.Groups[2].Value -replace '\\', '/') -replace '/widget$', '/web/web.sh'
    $reuse = if ($New) { ' CLAUDE_PANEL_NEW=1' } else { '' }
    $start.FileName = 'wsl.exe'
    $start.Arguments = "-d $distro -e env CLAUDE_PANEL_LAUNCH=1$reuse bash `"$webScript`" $words"
    return $start
  }
  $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { return $null }
  $server = Join-Path (Split-Path -Parent $PSScriptRoot) 'web\server.mjs'
  $start.FileName = $node.Source
  $start.Arguments = "`"$server`" $words"
  $start.EnvironmentVariables['CLAUDE_PANEL_LAUNCH'] = '1'
  if ($New) { $start.EnvironmentVariables['CLAUDE_PANEL_NEW'] = '1' }
  elseif ($start.EnvironmentVariables.ContainsKey('CLAUDE_PANEL_NEW')) { $start.EnvironmentVariables.Remove('CLAUDE_PANEL_NEW') }
  return $start
}

# Why New-WebOpenStart gave nothing, for the log.
function Get-WebOpenTrouble {
  return "no node.exe on PATH to run the web server ($PSScriptRoot)"
}
