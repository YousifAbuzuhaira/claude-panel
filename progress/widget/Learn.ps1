#Requires -Version 5.1
# Opens Learn on Windows: the web version (web/server.mjs, in WSL or on Windows itself) in an
# Edge app window, with no tabs or address bar. Run by the panel's Learn links, the games' Learn chip
# (Open-Sibling in Chrome.ps1) and /learn and /course (windowArgv in hooks/widget.ts).
#
# There is one Learn window. The server's `open learn` runs with CLAUDE_PANEL_LAUNCH=1 (through
# wsl.exe from WSL, through node.exe on Windows itself: WebOpen.ps1), and answers either a
# one-time link, opened here, or `existing`: a Learn page is already open and has gone to the
# view and course asked for, and this brings its window forward. (Asking WSL to start the
# browser fails when the wsl.exe it ran in ends at once.) Each attempt is noted in
# %TEMP%\claude-panel-browser.log. Kept to ASCII.

param(
  # Unused since Learn left its WPF window; kept so every caller's arguments still bind.
  [int64]$OwnerHwnd = 0,
  [string]$SessionId = 'default',
  # Where to open: -View library|course|review|learned|ask|settings|overlap and -CourseId <id>.
  [string]$View = '',
  [string]$CourseId = '',
  # An explainer's clips (/clips, the panel's Watch clips): the player on it, in a window of its own.
  [string]$Explain = ''
)

$ErrorActionPreference = 'Stop'

# The page's <title>: the Edge app window carries it as its caption.
$WINDOW_TITLE = 'Learn'
$VIEWS = @('library', 'course', 'review', 'learned', 'ask', 'settings', 'overlap')
$ANSWER_WAIT_MS = 30000

function Write-Log([string]$Text) {
  try { [System.IO.File]::AppendAllText((Join-Path $env:TEMP 'claude-panel-browser.log'), ('{0} learn: {1}' -f (Get-Date -Format s), $Text) + [Environment]::NewLine) } catch {}
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ClaudeLearnLaunch {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

  // The first visible top-level window whose caption is exactly `text` (a minimised one counts).
  public static IntPtr WindowByText(string text) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr hwnd, IntPtr l) {
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(hwnd, sb, 256);
      if (IsWindowVisible(hwnd) && sb.ToString() == text) { found = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

# Screen and window positions in real pixels on every monitor (per-monitor DPI aware).
[void][ClaudeLearnLaunch]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

# How to ask the web server for a page (wsl.exe from WSL, node.exe on Windows itself).
. (Join-Path $PSScriptRoot 'WebOpen.ps1')

# The server's `open learn ...`: its last JSON line, or $null. `-New` asks for a link even with a
# Learn page open (its window couldn't be found here).
function Invoke-WebOpen([switch]$New) {
  $page = 'learn'
  $extra = ''
  if ($Explain -match '^x[0-9a-f]{12,20}$') {
    $page = 'learn/video'
    $extra = " --explain $Explain"
  } else {
    if ($VIEWS -contains $View) { $extra += " --view $View" }
    if ($CourseId -match '^[\w.-]{1,160}$') { $extra += " --course $CourseId" }
  }
  $start = New-WebOpenStart $page $extra -New:$New
  if (-not $start) { Write-Log (Get-WebOpenTrouble); return $null }
  $child = [System.Diagnostics.Process]::Start($start)
  $reading = $child.StandardOutput.ReadToEndAsync()
  if (-not $child.WaitForExit($ANSWER_WAIT_MS)) { Write-Log 'no answer from the web server in 30 s'; return $null }
  $lines = @($reading.Result -split "`n" | Where-Object { $_.Trim() })
  if ($lines.Count -eq 0) { Write-Log 'WSL answered nothing'; return $null }
  try { return ($lines[-1] | ConvertFrom-Json) } catch { Write-Log "not JSON: $($lines[-1])"; return $null }
}

# A new Learn window fills the second screen (the first one that isn't the main one), as the
# person asked; with one screen it stays where Edge put it. It waits for the window (its caption
# is the page's title, once the page loads), and leaves one Edge already put on that screen.
$WINDOW_WAIT_MS = 15000
function Move-ToSecondScreen {
  Add-Type -AssemblyName System.Windows.Forms
  $screen = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
  if (-not $screen) { return }
  $until = [DateTime]::UtcNow.AddMilliseconds($WINDOW_WAIT_MS)
  $hwnd = [IntPtr]::Zero
  while ($hwnd -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $until) {
    Start-Sleep -Milliseconds 100
    $hwnd = [ClaudeLearnLaunch]::WindowByText($WINDOW_TITLE)
  }
  if ($hwnd -eq [IntPtr]::Zero) { Write-Log 'the new window never showed its title: left where it opened'; return }
  $rect = New-Object ClaudeLearnLaunch+RECT
  [void][ClaudeLearnLaunch]::GetWindowRect($hwnd, [ref]$rect)
  $middle = New-Object System.Drawing.Point([int](($rect.Left + $rect.Right) / 2), [int](($rect.Top + $rect.Bottom) / 2))
  $work = $screen.WorkingArea
  if ($work.Contains($middle)) { return }
  # Restored first: a maximised window moves as a whole, then fills the screen it is on.
  [void][ClaudeLearnLaunch]::ShowWindow($hwnd, 9)
  [void][ClaudeLearnLaunch]::SetWindowPos($hwnd, [IntPtr]::Zero, $work.X, $work.Y, $work.Width, $work.Height, 0x14)
  [void][ClaudeLearnLaunch]::ShowWindow($hwnd, 3)
  Write-Log "moved the new window to $($screen.DeviceName)"
}

# The link in an Edge app window (no tabs or address bar), else in the default browser.
function Open-Link([string]$Link) {
  # The new window may take the foreground: this process may, having been started from a click.
  [void][ClaudeLearnLaunch]::AllowSetForegroundWindow(-1)
  foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if (-not $root) { continue }
    $edge = Join-Path $root 'Microsoft\Edge\Application\msedge.exe'
    if (Test-Path -LiteralPath $edge) {
      [void][System.Diagnostics.Process]::Start($edge, "--app=$Link")
      Write-Log 'opened an Edge app window'
      # The player's caption is its clip's title, not Learn's: left where Edge puts it.
      if (-not $Explain) { Move-ToSecondScreen }
      return
    }
  }
  [void][System.Diagnostics.Process]::Start($Link)
  Write-Log 'no Edge: opened the default browser'
}

# The open Learn window to the front, restored if minimised. False when there is none to find.
function Show-LearnWindow {
  $hwnd = [ClaudeLearnLaunch]::WindowByText($WINDOW_TITLE)
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  if ([ClaudeLearnLaunch]::IsIconic($hwnd)) { [void][ClaudeLearnLaunch]::ShowWindow($hwnd, 9) }
  $front = [ClaudeLearnLaunch]::SetForegroundWindow($hwnd)
  Write-Log "brought the open window forward (foreground: $front)"
  return $true
}

try {
  $answer = Invoke-WebOpen
  if (-not $answer) { exit 1 }
  if (-not $answer.ok) { Write-Log "the server said: $($answer.error)"; exit 1 }
  if ([string]$answer.shown -eq 'existing') {
    if (Show-LearnWindow) { exit 0 }
    # Learn is open somewhere this can't see (a browser tab): a window of its own after all.
    Write-Log 'a Learn page is open but no window is captioned Learn: opening one'
    $answer = Invoke-WebOpen -New
    if (-not $answer -or -not $answer.launch) { exit 1 }
  }
  if ($answer.launch) { Open-Link ([string]$answer.launch); exit 0 }
  Write-Log "no link in the answer (shown: $($answer.shown))"
  exit 1
} catch {
  Write-Log "failed: $($_.Exception.Message)"
  exit 1
}
