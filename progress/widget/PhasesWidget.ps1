#Requires -Version 5.1
# The phases checklist as a small card over the chat's WezTerm window.
#
# Owned by the WezTerm window: it sits above that window and under every other
# app, hides when it minimizes and goes when it closes. It follows the window,
# keeps the spot the person dragged it to, and reads the plan the mod writes to
# -StateFile. It talks back on stdout, one JSON line per event: ready, closed,
# alive, duplicate, error. PowerShell names ignore case, so glyphs are $GLYPH_*
# and no variable may reuse a parameter's name. Kept to ASCII: Windows PowerShell reads a .ps1
# without a BOM as ANSI, so every non-ASCII glyph is built from its code point.

param(
  [Parameter(Mandatory = $true)][string]$StateFile,
  [string]$SessionId = 'default',
  [string]$Title = '',
  [string]$Root = '',
  [string]$WezTerm = 'C:\Program Files\WezTerm\wezterm.exe',
  [int]$PadLeft = 12,
  [int]$PadTop = 10,
  [int]$PadBottom = 6,
  # Testing aid: draw the panel to this PNG (whatever window is in front) and exit.
  [string]$SnapshotPath = '',
  [ValidateSet('', 'phases', 'tests', 'learn')][string]$SnapshotTab = '',
  [ValidateSet('', 'open', 'closed')][string]$SnapshotLook = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Send-Event([hashtable]$Event) {
  try {
    [Console]::Out.WriteLine(($Event | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    return $true
  } catch {
    return $false
  }
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PhasesWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);

  public static string ClassOf(IntPtr hwnd) { var s = new StringBuilder(256); GetClassName(hwnd, s, 256); return s.ToString(); }
  public static string TextOf(IntPtr hwnd) { var s = new StringBuilder(1024); GetWindowText(hwnd, s, 1024); return s.ToString(); }
  public static uint ProcessOf(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }

  public static IntPtr[] WindowsOf(uint pid, string className) {
    var found = new List<IntPtr>();
    EnumWindows((hwnd, l) => {
      if ((pid == 0 || ProcessOf(hwnd) == pid) && IsWindowVisible(hwnd) && ClassOf(hwnd) == className) found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }

  public static IntPtr WindowByText(string text) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, l) => {
      if (IsWindowVisible(hwnd) && TextOf(hwnd) == text) { found = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

# Per-monitor DPI awareness before WPF loads: every position below is in
# physical pixels, and WPF draws its content sharp at the monitor's scale.
[void][PhasesWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$mutex = New-Object System.Threading.Mutex($false, "Local\ClaudePhases-$SessionId")
try {
  $isOwner = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  # A widget before this one was killed while holding it: it is ours now.
  $isOwner = $true
}
if (-not $isOwner -and -not $SnapshotPath) {
  [void](Send-Event @{ event = 'duplicate' })
  exit 0
}

$WEZTERM_CLASS = 'org.wezfurlong.wezterm'
$GLYPH_CHECK = [string][char]0x2713
$GLYPH_NOW = [string][char]0x25B8
$GLYPH_CLOSE = [string][char]0x2715
$GLYPH_GRIP = [string][char]0x25E3
$MIN_SCALE = 0.7
$MAX_SCALE = 2.5
$GLYPH_EXPANDED = [string][char]0x25BE
$GLYPH_COLLAPSED = [string][char]0x25B8
$GLYPH_DOT = [string][char]0x00B7
$GLYPH_GAMES = [string][char]0x25A6
$GLYPH_ARROW = [string][char]0x2192

# --- Which WezTerm window and pane this chat lives in -------------------------

# The widget is a child of this chat's pane: wsl.exe under wezterm-gui.exe.
function Find-WezTermProcessId {
  $all = @{}
  foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name) { $all[[int]$p.ProcessId] = $p }
  $id = $PID
  for ($i = 0; $i -lt 12 -and $all.ContainsKey($id); $i++) {
    $p = $all[$id]
    if ($p.Name -eq 'wezterm-gui.exe') { return [int]$p.ProcessId }
    $id = [int]$p.ParentProcessId
  }
  $fg = [PhasesWin32]::GetForegroundWindow()
  if ([PhasesWin32]::ClassOf($fg) -eq $WEZTERM_CLASS) { return [int][PhasesWin32]::ProcessOf($fg) }
  $any = Get-Process wezterm-gui -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($any) { return [int]$any.Id }
  return 0
}

function Get-Panes([int]$GuiPid) {
  if ($GuiPid -gt 0) { $env:WEZTERM_UNIX_SOCKET = Join-Path $env:USERPROFILE ".local\share\wezterm\gui-sock-$GuiPid" }
  try {
    $json = & $WezTerm cli list --format json 2>$null
    if (-not $json) { return @() }
    return @(($json -join "`n") | ConvertFrom-Json)
  } catch {
    return @()
  }
}

function Select-Pane($Panes) {
  if ($Panes.Count -eq 0) { return $null }
  if ($Title) {
    $match = $Panes | Where-Object { ($_.title -replace '^\W+', '').Trim() -eq $Title } | Select-Object -First 1
    if ($match) { return $match }
  }
  if ($Root) {
    $match = $Panes | Where-Object { $_.cwd -and $_.cwd.TrimEnd('/').EndsWith($Root.TrimEnd('/')) } | Select-Object -First 1
    if ($match) { return $match }
  }
  $match = $Panes | Where-Object { $_.is_active } | Select-Object -First 1
  if ($match) { return $match }
  return $Panes[0]
}

$guiPid = Find-WezTermProcessId
$panes = Get-Panes $guiPid
$pane = Select-Pane $panes
$owners = [PhasesWin32]::WindowsOf([uint32]$guiPid, $WEZTERM_CLASS)
$owner = [IntPtr]::Zero
if ($pane) { $owner = $owners | Where-Object { [PhasesWin32]::TextOf($_) -eq $pane.window_title } | Select-Object -First 1 }
if (-not $owner -or $owner -eq [IntPtr]::Zero) { $owner = $owners | Select-Object -First 1 }
if (-not $owner) {
  [void](Send-Event @{ event = 'error'; message = 'no WezTerm window found' })
  exit 1
}

# The pane's box inside the window's client area, in physical pixels. The rows
# left over below the panes are the tab bar plus a part cell; the person's drag
# offset absorbs what that estimate misses.
function Measure-Pane {
  $client = New-Object PhasesWin32+RECT
  [void][PhasesWin32]::GetClientRect($owner, [ref]$client)
  if (-not $script:pane) {
    return @{ Right = $client.Right - $PadLeft; Top = $PadTop }
  }
  $p = $script:pane
  $cellW = $p.size.pixel_width / $p.size.cols
  $cellH = $p.size.pixel_height / $p.size.rows
  $rowsInTab = ($script:panes | Where-Object { $_.tab_id -eq $p.tab_id } | ForEach-Object { $_.top_row + $_.size.rows } | Measure-Object -Maximum).Maximum
  $tabH = [Math]::Max(0, $client.Bottom - $PadTop - $PadBottom - $rowsInTab * $cellH)
  return @{
    Right = $PadLeft + ($p.left_col + $p.size.cols) * $cellW
    Top = $tabH + $PadTop + $p.top_row * $cellH
  }
}

# --- What the person left it as: where, how big, open or not, which tab --------

$GLYPH_RUNNING = [string][char]0x25CF
$GLYPH_FAILED = [string][char]0x2717
$GLYPH_FULL = [string][char]0x2588
$GLYPH_EMPTY = [string][char]0x2591
$BAR_CELLS = 18

$prefsFile = Join-Path $env:LOCALAPPDATA 'ClaudePhases\offset.json'
$script:offset = @{ dx = 0; dy = 0 }
$script:isExpanded = $true
$script:scale = 1.0
try {
  if (Test-Path $prefsFile) {
    $saved = Get-Content $prefsFile -Raw | ConvertFrom-Json
    $script:offset = @{ dx = [int]$saved.dx; dy = [int]$saved.dy }
    if ($null -ne $saved.expanded) { $script:isExpanded = [bool]$saved.expanded }
    if ($saved.scale) { $script:scale = [Math]::Max($MIN_SCALE, [Math]::Min($MAX_SCALE, [double]$saved.scale)) }
  }
} catch {}

function Save-Prefs {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $prefsFile) | Out-Null
    @{ dx = $script:offset.dx; dy = $script:offset.dy; expanded = $script:isExpanded; scale = [Math]::Round($script:scale, 3) } |
      ConvertTo-Json -Compress | Set-Content -Path $prefsFile -Encoding ASCII
  } catch {}
}

# --- The panel ----------------------------------------------------------------

function Brush([string]$Hex) { return [System.Windows.Media.BrushConverter]::new().ConvertFromString($Hex) }
$ink = Brush '#E8E6E3'
$dim = Brush '#8B8A88'
$green = Brush '#5FB98A'
$red = Brush '#E0696B'
$accent = Brush '#E08A5F'
$gold = Brush '#E6BE47'
$font = New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas')

function New-Text([string]$Text, $Foreground) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.Foreground = $Foreground
  return $block
}

function New-Gap([double]$Left, [double]$Top, [double]$Right, [double]$Bottom) {
  return New-Object System.Windows.Thickness($Left, $Top, $Right, $Bottom)
}

$win = New-Object System.Windows.Window
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.ShowInTaskbar = $false
$win.ShowActivated = $false
$win.Topmost = $false
$win.ResizeMode = 'NoResize'
$win.SizeToContent = 'WidthAndHeight'
$win.Left = -32000
$win.Top = -32000
$win.FontFamily = $font
$win.FontSize = 12

$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius(10)
$card.Background = Brush '#EB1C1D20'
$card.BorderBrush = Brush '#33FFFFFF'
$card.BorderThickness = New-Object System.Windows.Thickness(1)
$card.Padding = New-Gap 12 9 12 10
$card.Cursor = [System.Windows.Input.Cursors]::SizeAll
$card.MinWidth = 220
$card.MaxWidth = 360
$cardScale = New-Object System.Windows.Media.ScaleTransform($script:scale, $script:scale)
$card.LayoutTransform = $cardScale

# Header: the open/closed arrow, the two tabs (or the one-line summary), and the close mark.
$header = New-Object System.Windows.Controls.DockPanel
$toggleText = New-Text '' $dim
$toggleText.Margin = New-Gap 0 0 8 0
$toggleText.Cursor = [System.Windows.Input.Cursors]::Hand
[System.Windows.Controls.DockPanel]::SetDock($toggleText, 'Left')
$closeText = New-Text $GLYPH_CLOSE $dim
$closeText.Margin = New-Gap 12 0 0 0
$closeText.Cursor = [System.Windows.Input.Cursors]::Hand
[System.Windows.Controls.DockPanel]::SetDock($closeText, 'Right')
$gamesText = New-Text $GLYPH_GAMES $dim
$gamesText.Margin = New-Gap 12 0 0 0
$gamesText.Cursor = [System.Windows.Input.Cursors]::Hand
$gamesText.ToolTip = 'Games'
[System.Windows.Controls.DockPanel]::SetDock($gamesText, 'Right')

$tabs = New-Object System.Windows.Controls.StackPanel
$tabs.Orientation = 'Horizontal'
$phasesTab = New-Text '' $ink
$phasesTab.Cursor = [System.Windows.Input.Cursors]::Hand
$testsTab = New-Text '' $dim
$testsTab.Cursor = [System.Windows.Input.Cursors]::Hand
$testsTab.Margin = New-Gap 14 0 0 0
# Learn: courses Claude builds (widget/Learn.ps1). The tab only shows; typing happens in its window.
$learnTab = New-Text 'Learn' $dim
$learnTab.Cursor = [System.Windows.Input.Cursors]::Hand
$learnTab.Margin = New-Gap 14 0 0 0
[void]$tabs.Children.Add($phasesTab)
[void]$tabs.Children.Add($testsTab)
[void]$tabs.Children.Add($learnTab)

$summaryText = New-Object System.Windows.Controls.TextBlock
$summaryText.TextTrimming = 'CharacterEllipsis'

[void]$header.Children.Add($toggleText)
[void]$header.Children.Add($closeText)
[void]$header.Children.Add($gamesText)
[void]$header.Children.Add($tabs)
[void]$header.Children.Add($summaryText)

$rule = New-Object System.Windows.Controls.Border
$rule.Height = 1
$rule.Background = Brush '#26FFFFFF'
$rule.Margin = New-Gap 0 6 0 6

$body = New-Object System.Windows.Controls.StackPanel
$footer = New-Text '' $dim
$footer.Margin = New-Gap 0 6 0 0

# The games the header's games mark offers, in a row under the header.
$gamesRow = New-Object System.Windows.Controls.StackPanel
$gamesRow.Orientation = 'Horizontal'
$gamesRow.HorizontalAlignment = 'Right'
$gamesRow.Margin = New-Gap 0 6 0 0
$gamesRow.Visibility = 'Collapsed'
$gameChoices = @()
foreach ($choice in @(@{ label = 'Sudoku'; script = 'Sudoku.ps1'; title = 'ClaudeSudoku' }, @{ label = '2048'; script = 'Game2048.ps1'; title = 'Claude2048' }, @{ label = 'Typing'; script = 'TypeTest.ps1'; title = 'ClaudeTypeTest' }, @{ label = 'Chess'; script = 'ChessPuzzles.ps1'; title = 'ClaudeChess' })) {
  $pick = New-Text $choice.label $ink
  $pick.Tag = $choice
  $pick.Margin = New-Gap 14 0 0 0
  $pick.Cursor = [System.Windows.Input.Cursors]::Hand
  [void]$gamesRow.Children.Add($pick)
  $gameChoices += $pick
}

$stack = New-Object System.Windows.Controls.StackPanel
[void]$stack.Children.Add($header)
[void]$stack.Children.Add($gamesRow)
[void]$stack.Children.Add($rule)
[void]$stack.Children.Add($body)
[void]$stack.Children.Add($footer)
$card.Child = $stack

# The resize grip, bottom-left: the panel is pinned by its top-right corner, so
# pulling the grip out (left or down) grows it toward the chat.
$grip = New-Text $GLYPH_GRIP $dim
$grip.FontSize = 11
$grip.Margin = New-Gap 3 0 0 1
$grip.HorizontalAlignment = 'Left'
$grip.VerticalAlignment = 'Bottom'
$grip.Cursor = [System.Windows.Input.Cursors]::SizeNESW
$grip.ToolTip = 'Drag to resize'

$cardHost = New-Object System.Windows.Controls.Grid
[void]$cardHost.Children.Add($card)
[void]$cardHost.Children.Add($grip)
$win.Content = $cardHost

# --- Drawing ------------------------------------------------------------------

$script:state = $null
$script:activeTab = 'phases'
$script:seenFocus = $null

function Get-Bar($Ratio) {
  if ($null -eq $Ratio) { return $GLYPH_EMPTY * $BAR_CELLS }
  $filled = [int][Math]::Round([Math]::Max([double]0, [Math]::Min([double]1, [double]$Ratio)) * $BAR_CELLS)
  return ($GLYPH_FULL * $filled) + ($GLYPH_EMPTY * ($BAR_CELLS - $filled))
}

function Get-RunLook($Run) {
  switch ([string]$Run.status) {
    'passed' { return @{ glyph = $GLYPH_CHECK; color = $green } }
    'failed' { return @{ glyph = $GLYPH_FAILED; color = $red } }
    default {
      $color = $accent
      if ([int]$Run.failed -gt 0) { $color = $red }
      return @{ glyph = $GLYPH_RUNNING; color = $color }
    }
  }
}

function Add-PhaseRows($Plan) {
  if ($null -eq $Plan) {
    [void]$body.Children.Add((New-Text 'No plan yet.' $dim))
    $footer.Text = ''
    return
  }
  $heading = New-Text ([string]$Plan.title) $ink
  $heading.FontWeight = 'Bold'
  $heading.TextWrapping = 'Wrap'
  $heading.Margin = New-Gap 0 0 0 4
  [void]$body.Children.Add($heading)
  foreach ($item in @($Plan.items)) {
    $line = New-Object System.Windows.Controls.DockPanel
    $line.Margin = New-Gap 0 1 0 1
    $name = New-Text ([string]$item.name) $ink
    $name.TextWrapping = 'Wrap'
    switch ([string]$item.status) {
      'done' { $box = New-Text "[$GLYPH_CHECK] " $green; $name.Foreground = $dim }
      'in_progress' {
        $box = New-Text "[$GLYPH_NOW] " $accent; $box.FontWeight = 'Bold'
        $name.Foreground = $accent; $name.FontWeight = 'Bold'
      }
      default { $box = New-Text '[ ] ' $ink }
    }
    [System.Windows.Controls.DockPanel]::SetDock($box, 'Left')
    [void]$line.Children.Add($box)
    [void]$line.Children.Add($name)
    [void]$body.Children.Add($line)
  }
  $footer.Text = "$($Plan.done) of $($Plan.total) done"
}

function Add-RunRows($Runs) {
  $list = @($Runs)
  if ($list.Count -eq 0) {
    [void]$body.Children.Add((New-Text 'No test runs yet.' $dim))
    $footer.Text = ''
    return
  }
  [array]::Reverse($list)
  foreach ($run in $list) {
    $look = Get-RunLook $run
    $isLive = [string]$run.status -eq 'running'

    $top = New-Object System.Windows.Controls.DockPanel
    $mark = New-Text "$($look.glyph) " $look.color
    [System.Windows.Controls.DockPanel]::SetDock($mark, 'Left')
    $label = New-Text ([string]$run.label) $ink
    $label.TextTrimming = 'CharacterEllipsis'
    if (-not $isLive) { $label.Foreground = $dim }
    [void]$top.Children.Add($mark)
    [void]$top.Children.Add($label)

    $counts = New-Object System.Windows.Controls.TextBlock
    $counts.Margin = New-Gap 14 1 0 8
    $barRun = New-Object System.Windows.Documents.Run((Get-Bar $run.ratio))
    $barRun.Foreground = $look.color
    [void]$counts.Inlines.Add($barRun)
    $countRun = New-Object System.Windows.Documents.Run(" $($run.count)")
    $countRun.Foreground = $ink
    [void]$counts.Inlines.Add($countRun)
    $passRun = New-Object System.Windows.Documents.Run("  $GLYPH_CHECK$($run.passed)")
    $passRun.Foreground = $green
    [void]$counts.Inlines.Add($passRun)
    if ([int]$run.failed -gt 0) {
      $failRun = New-Object System.Windows.Documents.Run(" $GLYPH_FAILED$($run.failed)")
      $failRun.Foreground = $red
      [void]$counts.Inlines.Add($failRun)
    }

    [void]$body.Children.Add($top)
    [void]$body.Children.Add($counts)
  }
  # All the runs shown, together.
  $totals = $script:state.totals
  $footer.Text = ''
  if ($totals -and [int]$totals.tests -gt 0) {
    $runWord = 'runs'
    if ([int]$totals.runs -eq 1) { $runWord = 'run' }
    $text = "$($totals.tests) tests in $($totals.runs) $runWord $GLYPH_DOT $($totals.passed) passed"
    if ([int]$totals.failed -gt 0) { $text += " $GLYPH_DOT $($totals.failed) failed" }
    $footer.Text = $text
  }
}

# A link that opens the Learn window; a click on it never starts a drag.
function New-LearnLink([string]$Text) {
  $link = New-Text $Text $accent
  $link.Cursor = [System.Windows.Input.Cursors]::Hand
  $link.Margin = New-Gap 0 4 0 0
  $link.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
  $link.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Open-Game 'Learn.ps1' 'ClaudeLearn' -Shared })
  return $link
}

function Add-LearnRows($Learn) {
  $footer.Text = ''
  $build = if ($Learn) { $Learn.build } else { $null }
  $course = if ($Learn) { $Learn.course } else { $null }
  if ($build) {
    $state = [string]$build.state
    $color = switch ($state) { 'failed' { $red } 'waiting-picks' { $gold } 'done' { $green } default { $accent } }
    $glyph = switch ($state) { 'done' { $GLYPH_CHECK } 'failed' { $GLYPH_FAILED } default { $GLYPH_RUNNING } }
    $top = New-Object System.Windows.Controls.DockPanel
    $mark = New-Text "$glyph " $color
    [System.Windows.Controls.DockPanel]::SetDock($mark, 'Left')
    $topic = New-Text ([string]$build.topic) $ink
    $topic.TextTrimming = 'CharacterEllipsis'
    [void]$top.Children.Add($mark)
    [void]$top.Children.Add($topic)
    [void]$body.Children.Add($top)
    $message = New-Text ([string]$build.message) $dim
    $message.TextWrapping = 'Wrap'
    $message.Margin = New-Gap 14 1 0 0
    [void]$body.Children.Add($message)
    if ([int]$build.total -gt 0 -and $state -ne 'done') {
      $counts = New-Object System.Windows.Controls.TextBlock
      $counts.Margin = New-Gap 14 2 0 6
      $barRun = New-Object System.Windows.Documents.Run((Get-Bar ([double]$build.done / [double]$build.total)))
      $barRun.Foreground = $color
      [void]$counts.Inlines.Add($barRun)
      $countRun = New-Object System.Windows.Documents.Run(" $([int]$build.done)/$([int]$build.total) pages")
      $countRun.Foreground = $ink
      [void]$counts.Inlines.Add($countRun)
      [void]$body.Children.Add($counts)
    }
  }
  if ($course) {
    $title = New-Text ([string]$course.title) $ink
    $title.FontWeight = 'Bold'
    $title.TextWrapping = 'Wrap'
    $title.Margin = New-Gap 0 $(if ($build) { 6 } else { 0 }) 0 0
    [void]$body.Children.Add($title)
    $where = "Page $([int]$course.page) of $([int]$course.total)"
    if ($course.next) { $where += " $GLYPH_DOT next: $([string]$course.next)" }
    $line = New-Text $where $dim
    $line.TextWrapping = 'Wrap'
    [void]$body.Children.Add($line)
  }
  if (-not $build -and -not $course) {
    $intro = New-Text 'Courses Claude builds from free videos and docs, to read while it works.' $dim
    $intro.TextWrapping = 'Wrap'
    [void]$body.Children.Add($intro)
  }
  [void]$body.Children.Add((New-LearnLink $(if ($course) { "Carry on reading $GLYPH_ARROW" } else { "Open Learn $GLYPH_ARROW" })))
}

function Show-State {
  $state = $script:state
  if ($null -eq $state) { return }
  $plan = $state.plan
  $runs = @($state.runs | Where-Object { $_ })
  $live = @($runs | Where-Object { $_.status -eq 'running' })

  # A new test run turns the panel to its Tests tab; with no plan, Tests is all there is.
  if ($state.focus -and $state.focus -ne $script:seenFocus) {
    if ($null -ne $script:seenFocus -or $live.Count -gt 0) { $script:activeTab = 'tests' }
    $script:seenFocus = $state.focus
  }
  if ($null -eq $plan -and $runs.Count -gt 0 -and $script:activeTab -ne 'learn') { $script:activeTab = 'tests' }
  if ($runs.Count -eq 0 -and $script:activeTab -eq 'tests') { $script:activeTab = 'phases' }
  # With no plan and no tests, a Learn build is what there is to show.
  $learn = $state.learn
  if ($null -eq $plan -and $runs.Count -eq 0 -and $learn -and $learn.build) { $script:activeTab = 'learn' }
  $learnBuild = if ($learn) { $learn.build } else { $null }

  $phasesLabel = 'Phases'
  if ($plan) { $phasesLabel = "Phases $($plan.done)/$($plan.total)" }
  $testsLabel = 'Tests'
  if ($live.Count -gt 0) { $testsLabel = "Tests $GLYPH_RUNNING $($live[-1].count)" }
  elseif ($runs.Count -gt 0) { $testsLabel = "Tests $((Get-RunLook $runs[-1]).glyph)" }
  $learnLabel = 'Learn'
  if ($learnBuild -and [string]$learnBuild.state -eq 'running' -and [int]$learnBuild.total -gt 0) { $learnLabel = "Learn $([int]$learnBuild.done)/$([int]$learnBuild.total)" }
  elseif ($learnBuild -and [string]$learnBuild.state -eq 'running') { $learnLabel = "Learn $GLYPH_RUNNING" }
  $phasesTab.Text = $phasesLabel
  $testsTab.Text = $testsLabel
  $learnTab.Text = $learnLabel
  $phasesTab.Foreground = $dim; $phasesTab.FontWeight = 'Normal'
  $testsTab.Foreground = $dim; $testsTab.FontWeight = 'Normal'
  $learnTab.Foreground = $dim; $learnTab.FontWeight = 'Normal'
  if ($script:activeTab -eq 'tests') { $testsTab.Foreground = $ink; $testsTab.FontWeight = 'Bold' }
  elseif ($script:activeTab -eq 'learn') { $learnTab.Foreground = $ink; $learnTab.FontWeight = 'Bold' }
  else { $phasesTab.Foreground = $ink; $phasesTab.FontWeight = 'Bold' }

  $body.Children.Clear()
  if (-not $script:isExpanded) {
    # Collapsed: one line for the tab in front.
    $toggleText.Text = $GLYPH_COLLAPSED
    $tabs.Visibility = 'Collapsed'
    $summaryText.Visibility = 'Visible'
    $summaryText.Inlines.Clear()
    if ($script:activeTab -eq 'learn') {
      $lead = New-Object System.Windows.Documents.Run('Learn ')
      $lead.Foreground = $accent
      $lead.FontWeight = 'Bold'
      $restText = if ($learnBuild) { [string]$learnBuild.message } elseif ($learn -and $learn.course) { [string]$learn.course.title } else { '' }
      $rest = New-Object System.Windows.Documents.Run($restText)
      $rest.Foreground = $dim
      [void]$summaryText.Inlines.Add($lead)
      [void]$summaryText.Inlines.Add($rest)
    } elseif ($script:activeTab -eq 'tests' -and $runs.Count -gt 0) {
      $run = $runs[-1]
      $look = Get-RunLook $run
      $lead = New-Object System.Windows.Documents.Run("$($look.glyph) $($run.count) ")
      $lead.Foreground = $look.color
      $lead.FontWeight = 'Bold'
      $rest = New-Object System.Windows.Documents.Run([string]$run.label)
      $rest.Foreground = $dim
      [void]$summaryText.Inlines.Add($lead)
      [void]$summaryText.Inlines.Add($rest)
    } elseif ($plan) {
      $current = @($plan.items) | Where-Object { $_.status -eq 'in_progress' } | Select-Object -First 1
      if (-not $current) { $current = @($plan.items) | Where-Object { $_.status -eq 'todo' } | Select-Object -First 1 }
      $name = 'All done'
      if ($current) { $name = [string]$current.name }
      $lead = New-Object System.Windows.Documents.Run($name)
      $lead.Foreground = $accent
      $lead.FontWeight = 'Bold'
      $rest = New-Object System.Windows.Documents.Run(" $GLYPH_DOT $($plan.done)/$($plan.total)")
      $rest.Foreground = $dim
      [void]$summaryText.Inlines.Add($lead)
      [void]$summaryText.Inlines.Add($rest)
    }
    $rule.Visibility = 'Collapsed'
    $body.Visibility = 'Collapsed'
    $footer.Visibility = 'Collapsed'
    return
  }

  $toggleText.Text = $GLYPH_EXPANDED
  $tabs.Visibility = 'Visible'
  $summaryText.Visibility = 'Collapsed'
  $rule.Visibility = 'Visible'
  $body.Visibility = 'Visible'
  if ($script:activeTab -eq 'tests') { Add-RunRows $runs }
  elseif ($script:activeTab -eq 'learn') { Add-LearnRows $learn }
  else { Add-PhaseRows $plan }
  if ($footer.Text) { $footer.Visibility = 'Visible' } else { $footer.Visibility = 'Collapsed' }
}

function Update-Panel {
  Show-State
  $win.UpdateLayout()
  Set-CardPosition
}

# --- Placement ----------------------------------------------------------------

$script:me = [IntPtr]::Zero
$script:box = $null
$script:lastOwner = $null
$script:dragging = $false
$script:dragStart = $null
$script:resizing = $false
$script:resizeStart = $null

function Get-Rect([IntPtr]$Hwnd) {
  $r = New-Object PhasesWin32+RECT
  [void][PhasesWin32]::GetWindowRect($Hwnd, [ref]$r)
  return $r
}

# SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
function Move-Card([int]$X, [int]$Y) { [void][PhasesWin32]::SetWindowPos($script:me, [IntPtr]::Zero, $X, $Y, 0, 0, 0x15) }

function Set-CardPosition {
  if ($script:me -eq [IntPtr]::Zero -or $null -eq $script:box) { return }
  $origin = New-Object PhasesWin32+POINT
  [void][PhasesWin32]::ClientToScreen($owner, [ref]$origin)
  $mine = Get-Rect $script:me
  $own = Get-Rect $owner
  $w = $mine.Right - $mine.Left
  $h = $mine.Bottom - $mine.Top
  $dpiScale = [PhasesWin32]::GetDpiForWindow($owner) / 96.0
  $x = [int]($origin.X + $script:box.Right - $w - 12 * $dpiScale + $script:offset.dx)
  $y = [int]($origin.Y + $script:box.Top + 8 * $dpiScale + $script:offset.dy)
  $x = [Math]::Max($own.Left, [Math]::Min($x, $own.Right - $w))
  $y = [Math]::Max($own.Top, [Math]::Min($y, $own.Bottom - $h))
  Move-Card $x $y
}

# --- Mouse: drag the panel, resize from the grip, switch tabs, open/close ----

function Get-Cursor {
  $cursor = New-Object PhasesWin32+POINT
  [void][PhasesWin32]::GetCursorPos([ref]$cursor)
  return $cursor
}

function Switch-Expanded {
  $script:isExpanded = -not $script:isExpanded
  Save-Prefs
  Update-Panel
}

$card.Add_MouseLeftButtonDown({
  param($sender, $e)
  if ($e.ClickCount -ge 2) { $script:dragging = $false; Switch-Expanded; return }
  $cursor = Get-Cursor
  $r = Get-Rect $script:me
  $script:dragStart = @{ cx = $cursor.X; cy = $cursor.Y; x = $r.Left; y = $r.Top }
  $script:dragging = $true
  [void]$card.CaptureMouse()
})

$card.Add_MouseMove({
  if (-not $script:dragging) { return }
  $cursor = Get-Cursor
  Move-Card ($script:dragStart.x + $cursor.X - $script:dragStart.cx) ($script:dragStart.y + $cursor.Y - $script:dragStart.cy)
})

$card.Add_MouseLeftButtonUp({
  if (-not $script:dragging) { return }
  $script:dragging = $false
  $card.ReleaseMouseCapture()
  $r = Get-Rect $script:me
  $script:offset = @{ dx = $script:offset.dx + $r.Left - $script:dragStart.x; dy = $script:offset.dy + $r.Top - $script:dragStart.y }
  Save-Prefs
})

$grip.Add_MouseLeftButtonDown({
  param($sender, $e)
  $e.Handled = $true
  $cursor = Get-Cursor
  $r = Get-Rect $script:me
  $script:resizeStart = @{ cx = $cursor.X; cy = $cursor.Y; scale = $script:scale; width = [Math]::Max(1, $r.Right - $r.Left) }
  $script:resizing = $true
  [void]$grip.CaptureMouse()
})

$grip.Add_MouseMove({
  if (-not $script:resizing) { return }
  $cursor = Get-Cursor
  $start = $script:resizeStart
  $grow = (($start.cx - $cursor.X) + ($cursor.Y - $start.cy)) / 2
  $next = $start.scale * ($start.width + $grow) / $start.width
  $script:scale = [Math]::Max($MIN_SCALE, [Math]::Min($MAX_SCALE, $next))
  $cardScale.ScaleX = $script:scale
  $cardScale.ScaleY = $script:scale
  $win.UpdateLayout()
  Set-CardPosition
})

$grip.Add_MouseLeftButtonUp({
  param($sender, $e)
  if (-not $script:resizing) { return }
  $e.Handled = $true
  $script:resizing = $false
  $grip.ReleaseMouseCapture()
  Save-Prefs
})

# Clicks on these never start a drag.
foreach ($control in @($toggleText, $closeText, $gamesText, $phasesTab, $testsTab, $learnTab) + $gameChoices) {
  $control.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
}
$toggleText.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Switch-Expanded })
$phasesTab.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $script:activeTab = 'phases'; Update-Panel })
$testsTab.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $script:activeTab = 'tests'; Update-Panel })
$learnTab.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $script:activeTab = 'learn'; Update-Panel })
$gamesText.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  if ($gamesRow.Visibility -eq 'Visible') { $gamesRow.Visibility = 'Collapsed' } else { $gamesRow.Visibility = 'Visible' }
  Update-Panel
})
foreach ($pick in $gameChoices) {
  $pick.Add_MouseLeftButtonUp({
    param($sender, $e)
    $e.Handled = $true
    $gamesRow.Visibility = 'Collapsed'
    Update-Panel
    Open-Game $sender.Tag.script $sender.Tag.title
  })
}
$closeText.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  [void](Send-Event @{ event = 'closed' })
  $win.Close()
})

# --- Games: each its own process, so a game outlives the panel ----------------

function Open-Game([string]$ScriptName, [string]$WindowTitle, [switch]$Shared) {
  try {
    # One of each game per chat (Learn: one per machine, its library is one): a second
    # pick brings it forward. The panel just took the click, so it may hand the foreground over.
    $existingTitle = if ($Shared) { $WindowTitle } else { "${WindowTitle}:$SessionId" }
    $existing = [PhasesWin32]::WindowByText($existingTitle)
    if ($existing -ne [IntPtr]::Zero) { [void][PhasesWin32]::SetForegroundWindow($existing); return }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = 'powershell.exe'
    $start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\$ScriptName`" -OwnerHwnd $([int64]$owner) -SessionId $SessionId"
    # Shell-started: it inherits no handle, so the mod still sees this panel's
    # output end when the panel goes.
    $start.UseShellExecute = $true
    $start.WindowStyle = 'Hidden'
    $start.WorkingDirectory = $env:TEMP
    $game = [System.Diagnostics.Process]::Start($start)
    if ($game) { [void][PhasesWin32]::AllowSetForegroundWindow($game.Id) }
  } catch {
    # No game is no reason to lose the panel.
  }
}

# --- Reading what the mod wrote -----------------------------------------------

$script:lastText = $null
$script:lastStamp = $null
$script:missingSince = $null
$script:fullReadAt = [DateTime]::MinValue

function Sync-State {
  if (-not [System.IO.File]::Exists($StateFile)) {
    if ($null -eq $script:missingSince) { $script:missingSince = [DateTime]::UtcNow }
    elseif (([DateTime]::UtcNow - $script:missingSince).TotalSeconds -gt 2) { $win.Close() }
    return
  }
  $script:missingSince = $null
  $info = New-Object System.IO.FileInfo($StateFile)
  $stamp = "$($info.LastWriteTimeUtc.Ticks)/$($info.Length)"
  $isDue = ([DateTime]::UtcNow - $script:fullReadAt).TotalSeconds -gt 2
  if ($stamp -eq $script:lastStamp -and -not $isDue) { return }
  try {
    $stream = [System.IO.File]::Open($StateFile, 'Open', 'Read', 'ReadWrite')
    try { $text = (New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)).ReadToEnd() } finally { $stream.Dispose() }
    $script:fullReadAt = [DateTime]::UtcNow
    $script:lastStamp = $stamp
    if ($text -eq $script:lastText) { return }
    $parsed = $text | ConvertFrom-Json
  } catch {
    return # a write caught halfway: the next tick reads it whole
  }
  $script:lastText = $text
  $script:state = $parsed
  Update-Panel
}

# --- Life ---------------------------------------------------------------------

$win.Add_SourceInitialized({
  $script:me = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
  # WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW: clicks never take focus, no Alt-Tab entry.
  $style = [PhasesWin32]::GetWindowLong($script:me, -20)
  [void][PhasesWin32]::SetWindowLong($script:me, -20, ($style -bor 0x08000000 -bor 0x80))
})

function Save-Snapshot {
  if ($SnapshotTab) { $script:activeTab = $SnapshotTab }
  if ($SnapshotLook) { $script:isExpanded = $SnapshotLook -eq 'open' }
  Show-State
  $win.UpdateLayout()
  $dpi = 96.0 * [PhasesWin32]::GetDpiForWindow($owner) / 96.0
  $width = [int][Math]::Ceiling($cardHost.ActualWidth * $dpi / 96.0)
  $height = [int][Math]::Ceiling($cardHost.ActualHeight * $dpi / 96.0)
  $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($width, $height, $dpi, $dpi, [System.Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($cardHost)
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $file = [System.IO.File]::Create($SnapshotPath)
  try { $encoder.Save($file) } finally { $file.Dispose() }
}

$win.Add_ContentRendered({
  if ($SnapshotPath) { Save-Snapshot; $win.Close(); return }
  $script:box = Measure-Pane
  $script:lastOwner = Get-Rect $owner
  Set-CardPosition
  $paneId = $null
  if ($script:pane) { $paneId = $script:pane.pane_id }
  [void](Send-Event @{ event = 'ready'; hwnd = [int64]$owner; paneId = $paneId; guiPid = $guiPid })
})

$script:tick = 0
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$timer.Add_Tick({
  $script:tick++
  if (-not [PhasesWin32]::IsWindow($owner)) { $win.Close(); return }
  if ($script:tick % 3 -eq 0 -and -not $script:dragging -and -not $script:resizing) { Sync-State }
  if ($script:tick % 50 -eq 0 -and -not (Send-Event @{ event = 'alive' })) { $win.Close(); return }
  if ($script:dragging -or $script:resizing -or [PhasesWin32]::IsIconic($owner)) { return }
  $now = Get-Rect $owner
  $was = $script:lastOwner
  if ($null -eq $was -or $now.Left -ne $was.Left -or $now.Top -ne $was.Top -or $now.Right -ne $was.Right -or $now.Bottom -ne $was.Bottom) {
    $resized = $null -eq $was -or ($now.Right - $now.Left) -ne ($was.Right - $was.Left) -or ($now.Bottom - $now.Top) -ne ($was.Bottom - $was.Top)
    if ($resized) {
      $script:panes = Get-Panes $guiPid
      $fresh = $script:panes | Where-Object { $script:pane -and $_.pane_id -eq $script:pane.pane_id } | Select-Object -First 1
      if ($fresh) { $script:pane = $fresh }
      $script:box = Measure-Pane
    }
    $script:lastOwner = $now
    Set-CardPosition
  }
})

$script:panes = $panes
$script:pane = $pane
Sync-State
$owned = New-Object System.Windows.Interop.WindowInteropHelper($win)
$owned.Owner = $owner
$timer.Start()
$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnMainWindowClose'
[void]$app.Run($win)
$timer.Stop()
try { $mutex.ReleaseMutex() } catch {}
exit 0
