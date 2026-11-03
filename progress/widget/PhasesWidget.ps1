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
#
# It wears the colour scheme every window shares (Theme.ps1, group 'panel') and is built from
# the shared pieces (Chrome.ps1). It never takes keyboard focus, so everything here is a click:
#   row 1  the open/closed mark, the chat's title, the version (the Releases tab), and the marks
#          for colour scheme, Learn and games, close
#   then   the colour-scheme strip or the games strip when one is open, under the mark that opens it
#   row 2  the tabs (Phases, Tests, Learn), with their counts
#   then   a rule, the tab, a footer

param(
  [Parameter(Mandatory = $true)][string]$StateFile,
  [string]$SessionId = 'default',
  [string]$Title = '',
  [string]$Root = '',
  [string]$WezTerm = 'C:\Program Files\WezTerm\wezterm.exe',
  [int]$PadLeft = 12,
  [int]$PadTop = 10,
  [int]$PadBottom = 6,
  # Testing aids: draw the panel to this PNG (whatever window is in front) and exit. A snapshot
  # ignores the saved prefs, so the same arguments always draw the same picture. -SnapshotTab is
  # taken as a click on that tab; -SnapshotStrip draws it with a strip open. -SnapshotDpi is the
  # picture's own (96 = one pixel per unit), never the monitor's, so every run draws the same size.
  [string]$SnapshotPath = '',
  [ValidateSet('', 'phases', 'tests', 'learn', 'releases')][string]$SnapshotTab = '',
  [ValidateSet('', 'open', 'closed')][string]$SnapshotLook = '',
  [ValidateSet('', 'look', 'games')][string]$SnapshotStrip = '',
  [ValidateRange(48, 384)][double]$SnapshotDpi = 96
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

# The colour scheme and see-through every window shares (appearance.json), and the shared pieces.
. (Join-Path $PSScriptRoot 'Theme.ps1')
$T = Initialize-Theme 'panel'
. (Join-Path $PSScriptRoot 'Chrome.ps1')

$WEZTERM_CLASS = 'org.wezfurlong.wezterm'
$GLYPH_CHECK = $UI_GLYPHS.check
$GLYPH_FAILED = $UI_GLYPHS.cross
# One mark for "now": the phase in progress, a live run, a build at work, something new.
$GLYPH_LIVE = $UI_GLYPHS.dot
$GLYPH_DOT = $UI_GLYPHS.middot
$GLYPH_ARROW = $UI_GLYPHS.arrow
$GLYPH_COURSE = [string][char]0x2261
$GLYPH_FULL = [string][char]0x2588
$GLYPH_EMPTY = [string][char]0x2591
# The open/closed mark: solid triangles, drawn small, read better than the shared outline ones.
$GLYPH_COLLAPSE = [string][char]0x25BC
$GLYPH_EXPAND = [string][char]0x25B6
$MIN_SCALE = 0.7
$MAX_SCALE = 2.5
$BAR_CELLS = 18

# Sizes, in the card's own units (the grip scales the whole card).
$PANEL_W = 340                       # fixed, so no tab or line ever moves the left edge
$CONTENT_W = $PANEL_W - 2 - 24       # inside the 1px border and the 12px side padding
$MARK_W = 14                         # the glyph column of runs, Learn and releases: second lines start here
$BOX_W = 28                          # the [x] column of phase rows
$ROW_GAP = 2                         # between the rows of one thing
$GROUP_GAP = 8                       # between things: runs, Learn blocks, releases; and around the rule
$TAB_GAP = 12
$MARK_PULL = 6                       # header marks reach into the padding so their glyphs line up with the text
$TOGGLE_PULL = 7                     # the open/closed mark's small glyph starts at the content edge
$SWATCH_GAP = 6
$RELEASES_SHOWN = 2                  # the footer says how many more there are; the card stays short
$PICKABLE_TABS = @('phases', 'tests', 'learn')
# Which tab gives up its count first when the tabs don't fit: a live test count goes last.
$SHORTEN_ORDER = @('learn', 'phases', 'tests')

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
  # Several WezTerms and none in front: the one whose window is highest (EnumWindows walks the
  # top-level windows from the top), not whichever process happens to be listed first.
  $front = [PhasesWin32]::WindowsOf(0, $WEZTERM_CLASS) | Select-Object -First 1
  if ($front) { return [int][PhasesWin32]::ProcessOf($front) }
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

# --- What the person left it as: where, how big, open or not, which tab -------
# One file for every chat's panel on this machine; the last write wins. A snapshot reads none of
# it and writes none of it.

$prefsFile = Join-Path $env:LOCALAPPDATA 'ClaudePhases\offset.json'
$script:offset = @{ dx = 0; dy = 0 }
$script:isExpanded = $true
$script:scale = 1.0
# The tab the person clicked, or $null while the panel picks (see Show-State).
$script:manualTab = $null
# The newest version whose notes the person has seen in the Releases tab.
$script:seenRelease = $null
# What the panel last showed: the plan's title and the newest run. Saved with the tab, so a start
# whose first state brings neither one new keeps that tab (a plain restart), and one that does is
# news (a relaunch for a new plan or run) and brings its tab forward (see Show-State).
$script:seenPlan = $null
$script:seenFocus = $null
if (-not $SnapshotPath) {
  try {
    if (Test-Path $prefsFile) {
      # UTF-8, as Save-Prefs writes it: a plan's title may be any text.
      $saved = [System.IO.File]::ReadAllText($prefsFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $script:offset = @{ dx = [int]$saved.dx; dy = [int]$saved.dy }
      if ($null -ne $saved.expanded) { $script:isExpanded = [bool]$saved.expanded }
      if ($saved.scale) { $script:scale = [Math]::Max([double]$MIN_SCALE, [Math]::Min([double]$MAX_SCALE, [double]$saved.scale)) }
      # Releases is a look, not a place to come back to: only the other tabs reopen.
      if ($PICKABLE_TABS -contains [string]$saved.tab) { $script:manualTab = [string]$saved.tab }
      if ($saved.seenRelease) { $script:seenRelease = [string]$saved.seenRelease }
      if ($saved.seenPlan) { $script:seenPlan = [string]$saved.seenPlan }
      if ($saved.seenFocus) { $script:seenFocus = [string]$saved.seenFocus }
    }
  } catch {}
}

function Save-Prefs {
  if ($SnapshotPath) { return }
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $prefsFile) | Out-Null
    # Where, how big, which tab and what it showed are this panel's own; the release seen is the
    # newest any panel saw, so one started before Releases was opened elsewhere can't bring the
    # mark back.
    $onDisk = Read-JsonFile $prefsFile
    if ($onDisk -and $onDisk.seenRelease) {
      $seenElsewhere = [string]$onDisk.seenRelease
      if (-not $script:seenRelease -or (Compare-Version $seenElsewhere $script:seenRelease) -gt 0) { $script:seenRelease = $seenElsewhere }
    }
    $json = @{
      dx = $script:offset.dx; dy = $script:offset.dy; expanded = $script:isExpanded; scale = [Math]::Round($script:scale, 3)
      tab = $script:manualTab; seenRelease = $script:seenRelease; seenPlan = $script:seenPlan; seenFocus = $script:seenFocus
    } | ConvertTo-Json -Compress
    # UTF-8 without a BOM, so a plan's title comes back as it was and still matches.
    [System.IO.File]::WriteAllText($prefsFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

# --- Releases: what each version changed, read once from the plugin's own files ---

$PLUGIN_DIR = Split-Path -Parent $PSScriptRoot

function Read-JsonFile([string]$Path) {
  try {
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    return ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
  } catch {
    return $null
  }
}

# -1, 0 or 1, by version number ("0.10.0" after "0.9.1"); text order when one isn't a number.
function Compare-Version([string]$A, [string]$B) {
  $left = $null
  $right = $null
  if ([version]::TryParse(($A -replace '[^0-9.]', ''), [ref]$left) -and [version]::TryParse(($B -replace '[^0-9.]', ''), [ref]$right)) {
    return $left.CompareTo($right)
  }
  return [Math]::Sign([string]::CompareOrdinal($A, $B))
}

function Format-ReleaseDate([string]$Date) {
  $invariant = [System.Globalization.CultureInfo]::InvariantCulture
  try { return [DateTime]::ParseExact($Date, 'yyyy-MM-dd', $invariant).ToString('d MMM', $invariant) } catch { return $Date }
}

$script:releases = New-Object System.Collections.Generic.List[object]
$releaseData = Read-JsonFile (Join-Path $PLUGIN_DIR 'releases.json')
if ($releaseData -and $releaseData.releases) {
  foreach ($entry in @($releaseData.releases)) {
    if (-not $entry -or -not $entry.version) { continue }
    $notes = @(@($entry.notes) | Where-Object { $_ } | ForEach-Object { [string]$_ } | Select-Object -First 3)
    $script:releases.Add(@{ version = [string]$entry.version; date = [string]$entry.date; by = [string]$entry.by; notes = $notes })
  }
}
$pluginData = Read-JsonFile (Join-Path $PLUGIN_DIR '.claude-plugin\plugin.json')
$PLUGIN_VERSION = ''
if ($pluginData -and $pluginData.version) { $PLUGIN_VERSION = [string]$pluginData.version }
elseif ($script:releases.Count -gt 0) { $PLUGIN_VERSION = $script:releases[0].version }
$NEWEST_RELEASE = $PLUGIN_VERSION
if ($script:releases.Count -gt 0) { $NEWEST_RELEASE = $script:releases[0].version }
# What had been seen when the Releases tab last opened: the entries after it wear the new mark.
$script:seenBefore = $script:seenRelease

function Test-ReleaseUnseen {
  if (-not $NEWEST_RELEASE) { return $false }
  if (-not $script:seenRelease) { return $true }
  return (Compare-Version $NEWEST_RELEASE $script:seenRelease) -gt 0
}

# --- The panel ----------------------------------------------------------------

$ink = $T.ink
$dim = $T.dim
$faint = $T.faint
$accent = $T.accent
$green = $T.green
$red = $T.red
$gold = $T.gold
$blue = $T.blue

function New-Text([string]$Text, $Foreground) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.Foreground = $Foreground
  return $block
}

function New-Gap([double]$Left, [double]$Top, [double]$Right, [double]$Bottom) {
  return New-Object System.Windows.Thickness($Left, $Top, $Right, $Bottom)
}

# A glyph in a column of fixed width, so the text after it lines up row to row.
function New-Cell([string]$Glyph, $Foreground, [double]$Width) {
  $cell = New-Text $Glyph $Foreground
  $cell.Width = $Width
  [System.Windows.Controls.DockPanel]::SetDock($cell, 'Left')
  return $cell
}

# A row: the glyph column, then the text, which takes the rest.
function New-MarkRow($Cell, $Text, [double]$Top) {
  $row = New-Object System.Windows.Controls.DockPanel
  $row.Margin = New-Gap 0 $Top 0 0
  [void]$row.Children.Add($Cell)
  [void]$row.Children.Add($Text)
  return $row
}

# A link (blue, underlined while hovered). Its click handler is the caller's; it never starts a drag.
function New-Link([string]$Text, [string]$Tip) {
  $link = New-Text $Text $blue
  $link.Cursor = [System.Windows.Input.Cursors]::Hand
  $link.HorizontalAlignment = 'Left'
  if ($Tip) { $link.ToolTip = $Tip }
  $link.Add_MouseEnter({ param($sender, $e) $sender.TextDecorations = [System.Windows.TextDecorations]::Underline })
  $link.Add_MouseLeave({ param($sender, $e) $sender.TextDecorations = $null })
  $link.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
  return $link
}

$win = New-Object System.Windows.Window
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.ShowInTaskbar = $false
$win.ShowActivated = $false
$win.Topmost = $false
$win.ResizeMode = 'NoResize'
# The width is the card's, fixed; only the height follows what the tab shows.
$win.SizeToContent = 'Height'
$win.Width = $PANEL_W * $script:scale
$win.Left = -32000
$win.Top = -32000
$win.FontFamily = $UI_MONO
$win.FontSize = 12
Add-ThemeResources $win

$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius($UI_CARD_RADIUS)
$card.Background = $T.cardFill
$card.BorderBrush = $T.edge
$card.BorderThickness = New-Object System.Windows.Thickness(1)
$card.Cursor = [System.Windows.Input.Cursors]::SizeAll
$card.Width = $PANEL_W
$cardScale = New-Object System.Windows.Media.ScaleTransform($script:scale, $script:scale)
$card.LayoutTransform = $cardScale

# Row 1: the open/closed mark, the chat's title (the one-line summary when closed), the version
# (the Releases tab, see below) and the marks.
$headRow = New-Object System.Windows.Controls.DockPanel
# Its box overhangs the padding by as much as the glyph leaves empty, and ends where the second
# lines of runs and Learn begin, so the title starts on that column.
$toggleMark = New-UiMark $GLYPH_COLLAPSE 'Collapse' 0 9
$toggleMark.Margin = New-Gap (0 - $TOGGLE_PULL) 0 ($MARK_W - $UI_MARK_SIZE + $TOGGLE_PULL) 0
[System.Windows.Controls.DockPanel]::SetDock($toggleMark, 'Left')
$closeMark = New-UiMark $UI_GLYPHS.close 'Hide until something new'
$closeMark.Margin = New-Gap 2 0 (0 - $MARK_PULL) 0
[System.Windows.Controls.DockPanel]::SetDock($closeMark, 'Right')
$gamesMark = New-UiMark $UI_GLYPHS.games 'Learn and games'
$gamesMark.Margin = New-Gap 2 0 0 0
[System.Windows.Controls.DockPanel]::SetDock($gamesMark, 'Right')
$lookMark = New-UiMark $UI_GLYPHS.look 'Colour scheme and see-through'
$lookMark.Margin = New-Gap 2 0 0 0
[System.Windows.Controls.DockPanel]::SetDock($lookMark, 'Right')

$headText = New-Text 'Progress' $dim
if ($Title) { $headText.Text = $Title; $headText.ToolTip = $Title }
$headText.TextTrimming = 'CharacterEllipsis'
$headText.VerticalAlignment = 'Center'
# Closed, the title gives way to one line about the tab in front: a lead, then the rest. When the
# rest is the count ("2/5"), it is its own block after the lead, so a long lead trims, never it.
$summaryText = New-Object System.Windows.Controls.TextBlock
$summaryText.TextTrimming = 'CharacterEllipsis'
$summaryText.VerticalAlignment = 'Center'
$summaryTail = New-Text '' $dim
$summaryTail.VerticalAlignment = 'Center'
[System.Windows.Controls.DockPanel]::SetDock($summaryTail, 'Right')
$summaryRow = New-Object System.Windows.Controls.DockPanel
$summaryRow.HorizontalAlignment = 'Left'
$summaryRow.Visibility = 'Collapsed'
[void]$summaryRow.Children.Add($summaryTail)
[void]$summaryRow.Children.Add($summaryText)
$headFill = New-Object System.Windows.Controls.Grid
[void]$headFill.Children.Add($headText)
[void]$headFill.Children.Add($summaryRow)

# Row 2: the tabs. A click on one keeps it in front (see Show-State).
function New-Tab([string]$Name) {
  $tab = New-Text '' $dim
  $tab.Cursor = [System.Windows.Input.Cursors]::Hand
  $tab.Padding = New-Gap 0 2 0 2
  $tab.Margin = New-Gap 0 0 $TAB_GAP 0
  $tab.VerticalAlignment = 'Center'
  $tab.Tag = @{ name = $Name; hot = $false }
  $tab.Add_MouseEnter({ param($sender, $e) $sender.Tag.hot = $true; Update-TabLook $sender })
  $tab.Add_MouseLeave({ param($sender, $e) $sender.Tag.hot = $false; Update-TabLook $sender })
  $tab.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
  $tab.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Select-Tab $sender.Tag.name })
  return $tab
}

function Update-TabLook($Tab) {
  if ($script:activeTab -eq $Tab.Tag.name) { $Tab.Foreground = $ink; $Tab.FontWeight = 'Bold' }
  elseif ($Tab.Tag.hot) { $Tab.Foreground = $ink; $Tab.FontWeight = 'Normal' }
  else { $Tab.Foreground = $dim; $Tab.FontWeight = 'Normal' }
}

# The version is the Releases tab, in row 1 just before the marks, so the tabs keep the room
# their counts need. Dim like a tab; the accent dot while there are notes not yet opened.
$releasesTab = New-Tab 'releases'
$releasesTab.Margin = New-Gap 8 0 6 0
$releasesTab.ToolTip = 'Releases: what is new in each version'
[System.Windows.Controls.DockPanel]::SetDock($releasesTab, 'Right')

[void]$headRow.Children.Add($toggleMark)
[void]$headRow.Children.Add($closeMark)
[void]$headRow.Children.Add($gamesMark)
[void]$headRow.Children.Add($lookMark)
[void]$headRow.Children.Add($releasesTab)
[void]$headRow.Children.Add($headFill)

$tabRow = New-Object System.Windows.Controls.StackPanel
$tabRow.Orientation = 'Horizontal'
$tabRow.Margin = New-Gap 0 4 0 0
$phasesTab = New-Tab 'phases'
$testsTab = New-Tab 'tests'
# Learn: courses Claude builds (widget/Learn.ps1). The tab only shows; reading happens in its window.
$learnTab = New-Tab 'learn'
$pickTabs = @($phasesTab, $testsTab, $learnTab)
foreach ($pickTab in $pickTabs) { [void]$tabRow.Children.Add($pickTab) }

# Under the colour-scheme mark: the presets, how see-through each kind of window is, and the way to
# the full editor in Learn. All clicks: the panel never takes the keyboard.
$lookStrip = New-Object System.Windows.Controls.StackPanel
$lookStrip.Margin = New-Gap 0 $GROUP_GAP 0 $GROUP_GAP
$lookStrip.Visibility = 'Collapsed'
# The caption names the scheme in use (or the one under the mouse), since a swatch has no words.
$schemeCaption = New-UiCaption 'Colour scheme'
$schemeCaption.Margin = New-Gap 0 0 0 6
# The swatches share the content width: the last one ends where the percentages below end.
$swatchRow = New-UiSwatchRow
$swatchCount = $swatchRow.Children.Count
if ($swatchCount -gt 0) {
  $swatchWidth = [Math]::Floor(($CONTENT_W - ($swatchCount - 1) * $SWATCH_GAP) / [double]$swatchCount)
  foreach ($swatchBox in $swatchRow.Children) {
    $swatchBox.Width = [Math]::Max([double]40, [double]$swatchWidth)
    $swatchBox.Margin = New-Gap 0 0 $SWATCH_GAP $SWATCH_GAP
    $swatchBox.Add_MouseEnter({ param($sender, $e) Set-SchemeCaption $sender.Tag.preset.label })
    $swatchBox.Add_MouseLeave({ param($sender, $e) Set-SchemeCaption '' })
    # After the swatch's own click (which marks the press handled): the custom link follows, and
    # the halo takes the new card colour.
    $swatchBox.AddHandler([System.Windows.UIElement]::MouseLeftButtonUpEvent, [System.Windows.Input.MouseButtonEventHandler]{ param($sender, $e) Update-LookStrip; Update-UiHalo }, $true)
  }
  $swatchRow.Children[$swatchCount - 1].Margin = New-Gap 0 0 0 $SWATCH_GAP
}
$clearCaption = New-UiCaption 'See-through'
$clearCaption.Margin = New-Gap 0 6 0 6
[void]$lookStrip.Children.Add($schemeCaption)
[void]$lookStrip.Children.Add($swatchRow)
[void]$lookStrip.Children.Add($clearCaption)
# The bar fills what its 52px label and 40px percentage leave, so the percentages end at the edge.
$opacityRows = @()
foreach ($group in @(@('panel', 'Panel'), @('learn', 'Learn'), @('games', 'Games'))) {
  $opacityRow = New-UiOpacityBar $group[0] $group[1] ($CONTENT_W - 52 - 40)
  $opacityRow.Margin = New-Gap 0 0 0 $ROW_GAP
  [void]$lookStrip.Children.Add($opacityRow)
  $opacityRows += $opacityRow
}
$customLink = New-Link "Custom colours $GLYPH_ARROW" "Your own background, accent and text colours, in Learn's settings"
$customLink.Margin = New-Gap 0 6 0 0
[void]$lookStrip.Children.Add($customLink)

# The preset in use, by the test the swatches ring it by; $null for colours of the person's own.
function Get-PresetInUse {
  $current = $script:THEME.appearance
  foreach ($swatchBox in $swatchRow.Children) {
    $preset = $swatchBox.Tag.preset
    if ($current.preset -eq $preset.name -and $current.colors.bg -eq $preset.bg.ToUpperInvariant() -and $current.colors.accent -eq $preset.accent.ToUpperInvariant()) { return $preset }
  }
  return $null
}

# "COLOUR SCHEME . EMBER": the one under the mouse, else the one in use, else Custom.
function Set-SchemeCaption([string]$Hovered) {
  $name = $Hovered
  if (-not $name) {
    $inUse = Get-PresetInUse
    if ($inUse) { $name = $inUse.label } else { $name = 'Custom' }
  }
  $schemeCaption.Text = ('Colour scheme {0} {1}' -f $GLYPH_DOT, $name).ToUpperInvariant()
}

# The strip after the scheme changed (here or in another window): rings, caption, bars, and the
# custom link in bold while the colours are the person's own.
function Update-LookStrip {
  Update-UiSwatchRow $swatchRow
  foreach ($opacityRow in $opacityRows) { Update-UiOpacityRow $opacityRow }
  Set-SchemeCaption ''
  if (Get-PresetInUse) {
    $customLink.Text = "Custom colours $GLYPH_ARROW"
    $customLink.FontWeight = 'Normal'
  } else {
    $customLink.Text = "Custom colours (in use) $GLYPH_ARROW"
    $customLink.FontWeight = 'Bold'
  }
}
Update-LookStrip

# Under the games mark: Learn and the games, each a click away (brought forward when already open).
$gamesStrip = New-Object System.Windows.Controls.StackPanel
$gamesStrip.Margin = New-Gap 0 $GROUP_GAP 0 $GROUP_GAP
$gamesStrip.Visibility = 'Collapsed'
$gameChipRow = New-Object System.Windows.Controls.WrapPanel
[void]$gamesStrip.Children.Add($gameChipRow)
$gameChips = @()
foreach ($sibling in $UI_SIBLINGS) {
  $chip = New-UiChip $sibling.label $false ('Open ' + $sibling.label) -Mono
  # Learn is not a game: a wider gap after it.
  if ($sibling.id -eq 'learn') { $chip.Margin = New-Gap 0 0 12 0 } else { $chip.Margin = New-Gap 0 0 6 0 }
  $chip.Tag.sibling = $sibling.id
  [void]$gameChipRow.Children.Add($chip)
  $gameChips += $chip
}
# And the same in the browser (the web version, served from WSL).
$browserLink = New-Text ("In the browser " + [string][char]0x2197) $blue
$browserLink.Cursor = [System.Windows.Input.Cursors]::Hand
$browserLink.ToolTip = 'Open Learn and the games in your web browser'
$browserLink.HorizontalAlignment = 'Left'
$browserLink.Margin = New-Gap 0 8 0 0
$browserLink.Add_MouseEnter({ param($sender, $e) $sender.TextDecorations = [System.Windows.TextDecorations]::Underline })
$browserLink.Add_MouseLeave({ param($sender, $e) $sender.TextDecorations = $null })
$browserLink.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
[void]$gamesStrip.Children.Add($browserLink)

$rule = New-Object System.Windows.Controls.Border
$rule.Height = 1
$rule.Background = $T.rule
$rule.Margin = New-Gap 0 $GROUP_GAP 0 $GROUP_GAP

$body = New-Object System.Windows.Controls.StackPanel
$footer = New-Text '' $dim
$footer.TextTrimming = 'CharacterEllipsis'
$footer.Margin = New-Gap 0 $GROUP_GAP 0 0

# A strip opens right under the marks that open it, so the tabs stay next to the body they switch.
$STACK_PAD = 10
$stack = New-Object System.Windows.Controls.StackPanel
$stack.Margin = New-Gap 12 $STACK_PAD 12 $STACK_PAD
[void]$stack.Children.Add($headRow)
[void]$stack.Children.Add($lookStrip)
[void]$stack.Children.Add($gamesStrip)
[void]$stack.Children.Add($tabRow)
[void]$stack.Children.Add($rule)
[void]$stack.Children.Add($body)
[void]$stack.Children.Add($footer)

# The resize grip, in the card's bottom-left corner so it scales with the card: the panel is pinned
# by its top-right corner, so pulling the grip out (left or down) grows it toward the chat. The
# glyph sits in the corner of a 14x14 box that takes the mouse, a target bigger than its ink.
$gripGlyph = New-UiGrip 'left'
$gripGlyph.IsHitTestVisible = $false
$grip = New-Object System.Windows.Controls.Border
$grip.Width = 14
$grip.Height = 14
$grip.Background = [System.Windows.Media.Brushes]::Transparent
$grip.HorizontalAlignment = 'Left'
$grip.VerticalAlignment = 'Bottom'
$grip.Margin = New-Gap 2 0 0 2
$grip.Cursor = $gripGlyph.Cursor
$grip.ToolTip = $gripGlyph.ToolTip
$grip.Child = $gripGlyph
$grip.Tag = $gripGlyph
# The glyph takes no mouse, so the box does what the shared grip does: dim at rest, ink hovered.
$grip.Add_MouseEnter({ param($sender, $e) $sender.Tag.Foreground = Get-UiBrush 'ink' })
$grip.Add_MouseLeave({ param($sender, $e) $sender.Tag.Foreground = Get-UiBrush 'dim' })

# Low see-through: the shared halo (Chrome.ps1) round the content and the grip, so the text stands
# off a backdrop of the other lightness as it does in Learn and the games.
$cardBody = New-Object System.Windows.Controls.Grid
[void]$cardBody.Children.Add((New-UiHaloFrame $stack))
[void]$cardBody.Children.Add((New-UiHaloFrame $grip))
$card.Child = $cardBody
Update-UiHalo

# The panel's own bar changes its see-through here at once, past the file's stamp that
# Update-Theme reads, so the halo follows it: as the bar previews (after the bar's own handlers,
# which mark the press handled) and when it is let go. A swatch does the same for the colour.
foreach ($opacityRow in $opacityRows) {
  $opacityBar = $opacityRow.Tag
  if ($opacityBar.Tag.key -ne $script:THEME.group) { continue }
  $opacityBar.AddHandler([System.Windows.UIElement]::MouseLeftButtonDownEvent, [System.Windows.Input.MouseButtonEventHandler]{ param($sender, $e) Update-UiHalo }, $true)
  $opacityBar.Add_MouseMove({ param($sender, $e) if ($sender.IsMouseCaptured) { Update-UiHalo } })
  $opacityBar.Add_LostMouseCapture({ param($sender, $e) Update-UiHalo })
}

$cardHost = New-Object System.Windows.Controls.Grid
[void]$cardHost.Children.Add($card)
$win.Content = $cardHost

# --- Drawing ------------------------------------------------------------------

$script:state = $null
$script:activeTab = 'phases'
if ($script:manualTab) { $script:activeTab = $script:manualTab }
# The strip open under the header: '', 'look' or 'games'.
$script:strip = ''

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
      return @{ glyph = $GLYPH_LIVE; color = $color }
    }
  }
}

# What a tab says when it has nothing: what it is for, and what fills it.
# The hint is read, not glanced at, so it is dim (faint is for labels); the headline is the tab's
# content, in the text colour.
function Add-EmptyState([string]$Headline, [string]$Hint) {
  [void]$body.Children.Add((New-Text $Headline $ink))
  if ($Hint) {
    $hintText = New-Text $Hint $dim
    $hintText.FontSize = 11.5
    $hintText.TextWrapping = 'Wrap'
    $hintText.Margin = New-Gap 0 $ROW_GAP 0 0
    [void]$body.Children.Add($hintText)
  }
}

function Add-PhaseRows($Plan) {
  if ($null -eq $Plan) {
    Add-EmptyState 'No plan yet' 'When Claude plans a task, its phases show here as it works through them.'
    return
  }
  $heading = New-Text ([string]$Plan.title) $ink
  $heading.FontWeight = 'Bold'
  $heading.TextWrapping = 'Wrap'
  $heading.Margin = New-Gap 0 0 0 6
  [void]$body.Children.Add($heading)
  $top = 0
  foreach ($item in @($Plan.items)) {
    $name = New-Text ([string]$item.name) $ink
    $name.TextWrapping = 'Wrap'
    switch ([string]$item.status) {
      'done' { $box = New-Cell "[$GLYPH_CHECK]" $green $BOX_W; $name.Foreground = $dim }
      'in_progress' {
        $box = New-Cell "[$GLYPH_LIVE]" $accent $BOX_W; $box.FontWeight = 'Bold'
        $name.Foreground = $accent; $name.FontWeight = 'Bold'
      }
      default { $box = New-Cell '[ ]' $dim $BOX_W }
    }
    [void]$body.Children.Add((New-MarkRow $box $name $top))
    $top = $ROW_GAP
  }
  $footer.Text = "$($Plan.done) of $($Plan.total) done"
}

function Add-RunRows($Runs) {
  $list = @($Runs)
  if ($list.Count -eq 0) {
    Add-EmptyState 'No test runs yet' 'Test commands Claude runs show here as they go, with their counts.'
    return
  }
  [array]::Reverse($list)
  $top = 0
  foreach ($run in $list) {
    $look = Get-RunLook $run
    $isLive = [string]$run.status -eq 'running'
    $label = New-Text ([string]$run.label) $ink
    $label.TextTrimming = 'CharacterEllipsis'
    if (-not $isLive) { $label.Foreground = $dim }
    [void]$body.Children.Add((New-MarkRow (New-Cell $look.glyph $look.color $MARK_W) $label $top))
    $top = $GROUP_GAP

    $counts = New-Object System.Windows.Controls.TextBlock
    $counts.Margin = New-Gap $MARK_W $ROW_GAP 0 0
    $counts.TextTrimming = 'CharacterEllipsis'
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
    [void]$body.Children.Add($counts)
  }
  # All the runs shown, together; failures first (in red), so a trim takes the least of it.
  $totals = $script:state.totals
  if ($totals -and [int]$totals.tests -gt 0) {
    $runWord = 'runs'
    if ([int]$totals.runs -eq 1) { $runWord = 'run' }
    $rest = "$($totals.passed) passed $GLYPH_DOT $($totals.tests) tests in $($totals.runs) $runWord"
    if ([int]$totals.failed -gt 0) {
      $failedRun = New-Object System.Windows.Documents.Run("$($totals.failed) failed")
      $failedRun.Foreground = $red
      [void]$footer.Inlines.Add($failedRun)
      [void]$footer.Inlines.Add((New-Object System.Windows.Documents.Run(" $GLYPH_DOT $rest")))
    } else {
      $footer.Text = $rest
    }
  }
}

# A link that opens the Learn window (at a view and a course, when given).
function New-LearnLink([string]$Text, [string]$View, [string]$CourseId) {
  $link = New-Link $Text ''
  $link.Tag = @{ view = $View; course = $CourseId }
  $link.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Open-PanelSibling 'learn' $sender.Tag.view $sender.Tag.course })
  return $link
}

# Learn's link, and beside it the same in the browser (the web version, served from WSL).
function New-LearnLinks([string]$Text, [string]$View, [string]$CourseId) {
  $row = New-Object System.Windows.Controls.StackPanel
  $row.Orientation = 'Horizontal'
  $row.HorizontalAlignment = 'Left'
  [void]$row.Children.Add((New-LearnLink $Text $View $CourseId))
  $web = New-Link ("In the browser " + [string][char]0x2197) 'Open Learn in your web browser instead'
  $web.Margin = New-Gap 16 0 0 0
  $web.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Open-InBrowser 'learn' })
  [void]$row.Children.Add($web)
  return $row
}

function Get-BuildColor([string]$State) {
  switch ($State) { 'failed' { return $red } 'waiting-picks' { return $gold } 'done' { return $green } default { return $accent } }
}

# What Claude is on, at the top of the Learn tab, so the plan stays in sight while you read:
# the phase in progress (or the next, or 'all done'), its count, and a bar. A click opens Phases.
function Add-PlanGlance($Plan) {
  $items = @()
  if ($Plan) { $items = @($Plan.items) }
  if ($items.Count -eq 0) { return }
  $done = [int]$Plan.done
  $total = [int]$Plan.total
  $now = $items | Where-Object { [string]$_.status -eq 'in_progress' } | Select-Object -First 1
  $next = $items | Where-Object { [string]$_.status -eq 'todo' } | Select-Object -First 1
  if ($now) { $glyph = $GLYPH_LIVE; $color = $accent; $name = [string]$now.name }
  elseif ($done -ge $total) { $glyph = $GLYPH_CHECK; $color = $green; $name = 'All phases done' }
  elseif ($next) { $glyph = $GLYPH_LIVE; $color = $dim; $name = 'Next: ' + [string]$next.name }
  else { return }
  # The count docks right, so a long phase name trims and the count always shows.
  $text = New-Text $name $ink
  $text.TextTrimming = 'CharacterEllipsis'
  $count = New-Text "$done/$total" $dim
  $count.Margin = New-Gap 8 0 0 0
  [System.Windows.Controls.DockPanel]::SetDock($count, 'Right')
  $row = New-Object System.Windows.Controls.DockPanel
  [void]$row.Children.Add((New-Cell $glyph $color $MARK_W))
  [void]$row.Children.Add($count)
  [void]$row.Children.Add($text)
  $bar = New-Text (Get-Bar ([double]$done / [double][Math]::Max(1, $total))) $color
  $bar.Margin = New-Gap $MARK_W $ROW_GAP 0 0
  $glanceBox = New-Object System.Windows.Controls.StackPanel
  $glanceBox.Background = [System.Windows.Media.Brushes]::Transparent
  $glanceBox.Cursor = [System.Windows.Input.Cursors]::Hand
  $glanceBox.ToolTip = ('{0}: open Phases' -f [string]$Plan.title)
  [void]$glanceBox.Children.Add($row)
  [void]$glanceBox.Children.Add($bar)
  $glanceBox.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
  $glanceBox.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Select-Tab 'phases' })
  [void]$body.Children.Add($glanceBox)
  $split = New-Object System.Windows.Controls.Border
  $split.Height = 1
  $split.Background = $T.rule
  $split.Margin = New-Gap 0 $GROUP_GAP 0 $GROUP_GAP
  [void]$body.Children.Add($split)
}

function Add-LearnRows($Learn) {
  $build = if ($Learn) { $Learn.build } else { $null }
  $course = if ($Learn) { $Learn.course } else { $null }
  if (-not $build -and -not $course) {
    Add-EmptyState 'No course yet' 'Courses Claude builds from free videos and docs, to read while it works.'
    $link = New-LearnLinks "Open Learn $GLYPH_ARROW" ''
    $link.Margin = New-Gap 0 6 0 0
    [void]$body.Children.Add($link)
    return
  }
  if ($build) {
    $buildState = [string]$build.state
    $color = Get-BuildColor $buildState
    $glyph = switch ($buildState) { 'done' { $GLYPH_CHECK } 'failed' { $GLYPH_FAILED } default { $GLYPH_LIVE } }
    $topic = New-Text ([string]$build.topic) $ink
    $topic.TextTrimming = 'CharacterEllipsis'
    [void]$body.Children.Add((New-MarkRow (New-Cell $glyph $color $MARK_W) $topic 0))
    $message = New-Text ([string]$build.message) $dim
    $message.TextWrapping = 'Wrap'
    $message.Margin = New-Gap $MARK_W $ROW_GAP 0 0
    [void]$body.Children.Add($message)
    if ([int]$build.total -gt 0 -and $buildState -ne 'done') {
      $counts = New-Object System.Windows.Controls.TextBlock
      $counts.Margin = New-Gap $MARK_W $ROW_GAP 0 0
      $counts.TextTrimming = 'CharacterEllipsis'
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
    $courseTitle = New-Text ([string]$course.title) $ink
    $courseTitle.FontWeight = 'Bold'
    $courseTitle.TextWrapping = 'Wrap'
    $top = 0
    if ($build) { $top = $GROUP_GAP }
    [void]$body.Children.Add((New-MarkRow (New-Cell $GLYPH_COURSE $dim $MARK_W) $courseTitle $top))
    $where = "Page $([int]$course.page) of $([int]$course.total)"
    if ($course.next) { $where += " $GLYPH_DOT next: $([string]$course.next)" }
    $line = New-Text $where $dim
    $line.TextWrapping = 'Wrap'
    $line.Margin = New-Gap $MARK_W $ROW_GAP 0 0
    [void]$body.Children.Add($line)
  }
  # The course this tab names, not whichever Learn had open last.
  if ($course) { $link = New-LearnLinks "Carry on reading $GLYPH_ARROW" 'course' ([string]$course.id) } else { $link = New-LearnLinks "Open Learn $GLYPH_ARROW" '' }
  $link.Margin = New-Gap $MARK_W 6 0 0
  [void]$body.Children.Add($link)
}

# Newest first: "0.2.0 . 29 Oct . Mahmood", then its notes. The entries the person had not seen
# when they opened the tab wear the new mark (with nothing seen before, the newest alone).
function Add-ReleaseRows {
  $list = $script:releases
  $top = 0
  if ($PLUGIN_VERSION -and $NEWEST_RELEASE -and (Compare-Version $PLUGIN_VERSION $NEWEST_RELEASE) -gt 0) {
    # A version shipped without its entry in releases.json: say so where its author will see it.
    $missing = New-Text "v$PLUGIN_VERSION has no release note yet" $red
    $missing.TextTrimming = 'CharacterEllipsis'
    [void]$body.Children.Add($missing)
    $top = $GROUP_GAP
  }
  if ($list.Count -eq 0) {
    Add-EmptyState 'No release notes' 'This copy of the plugin has no releases.json beside its widget folder.'
    return
  }
  $shown = [Math]::Min($list.Count, $RELEASES_SHOWN)
  for ($i = 0; $i -lt $shown; $i++) {
    $release = $list[$i]
    $isNew = $false
    if ($script:seenBefore) { $isNew = (Compare-Version $release.version $script:seenBefore) -gt 0 } else { $isNew = $i -eq 0 }
    $mark = ''
    if ($isNew) { $mark = $GLYPH_LIVE }
    $head = New-Object System.Windows.Controls.TextBlock
    $head.TextTrimming = 'CharacterEllipsis'
    $versionRun = New-Object System.Windows.Documents.Run($release.version)
    $versionRun.Foreground = $ink
    $versionRun.FontWeight = 'Bold'
    [void]$head.Inlines.Add($versionRun)
    $meta = ''
    if ($release.date) { $meta += " $GLYPH_DOT $(Format-ReleaseDate $release.date)" }
    if ($release.by) { $meta += " $GLYPH_DOT $($release.by)" }
    $metaRun = New-Object System.Windows.Documents.Run($meta)
    $metaRun.Foreground = $dim
    [void]$head.Inlines.Add($metaRun)
    [void]$body.Children.Add((New-MarkRow (New-Cell $mark $accent $MARK_W) $head $top))
    $top = $GROUP_GAP
    foreach ($note in $release.notes) {
      $noteText = New-Text $note $ink
      $noteText.TextWrapping = 'Wrap'
      $noteRow = New-MarkRow (New-Cell $GLYPH_DOT $dim $MARK_W) $noteText $ROW_GAP
      $noteRow.Margin = New-Gap $MARK_W $ROW_GAP 0 0
      [void]$body.Children.Add($noteRow)
    }
  }
  $noun = 'releases'
  if ($list.Count -eq 1) { $noun = 'release' }
  if ($shown -lt $list.Count) { $footer.Text = "Newest $shown of $($list.Count) $noun" } else { $footer.Text = "$($list.Count) $noun" }
}

# The collapsed card's one line: a lead (bold, in its colour) and the rest (dim). -KeepRest when
# the rest is the count: it then follows the lead in a block of its own, which never trims.
function Set-Summary([string]$Lead, $LeadBrush, [string]$Rest, [switch]$Plain, [switch]$KeepRest) {
  $summaryText.Inlines.Clear()
  $leadRun = New-Object System.Windows.Documents.Run($Lead)
  $leadRun.Foreground = $LeadBrush
  if (-not $Plain) { $leadRun.FontWeight = 'Bold' }
  [void]$summaryText.Inlines.Add($leadRun)
  $summaryTail.Text = ''
  $summaryTail.Visibility = 'Collapsed'
  if (-not $Rest) { return }
  if ($KeepRest) {
    $summaryTail.Text = $Rest
    $summaryTail.Visibility = 'Visible'
    return
  }
  $restRun = New-Object System.Windows.Documents.Run($Rest)
  $restRun.Foreground = $dim
  [void]$summaryText.Inlines.Add($restRun)
}

function Show-Summary($Plan, $Runs, $Learn) {
  $learnBuild = if ($Learn) { $Learn.build } else { $null }
  switch ($script:activeTab) {
    'releases' {
      $rest = ''
      if ($script:releases.Count -gt 0 -and $script:releases[0].notes.Count -gt 0) { $rest = " $GLYPH_DOT $($script:releases[0].notes[0])" }
      if ($PLUGIN_VERSION) { Set-Summary "v$PLUGIN_VERSION" $ink $rest } else { Set-Summary 'Releases' $ink $rest }
    }
    'learn' {
      if ($learnBuild) { Set-Summary 'Learn' (Get-BuildColor ([string]$learnBuild.state)) " $GLYPH_DOT $([string]$learnBuild.message)" }
      elseif ($Learn -and $Learn.course) { Set-Summary 'Learn' $ink " $GLYPH_DOT $([string]$Learn.course.title)" }
      else { Set-Summary 'Learn' $ink " $GLYPH_DOT no course yet" }
    }
    'tests' {
      if ($Runs.Count -gt 0) {
        $run = $Runs[-1]
        $look = Get-RunLook $run
        Set-Summary "$($look.glyph) $($run.count)" $look.color " $([string]$run.label)"
      } else {
        Set-Summary 'No test runs yet' $dim '' -Plain
      }
    }
    default {
      if ($Plan) {
        $current = @($Plan.items) | Where-Object { $_.status -eq 'in_progress' } | Select-Object -First 1
        if (-not $current) { $current = @($Plan.items) | Where-Object { $_.status -eq 'todo' } | Select-Object -First 1 }
        if ($current) { Set-Summary ([string]$current.name) $accent " $GLYPH_DOT $($Plan.done)/$($Plan.total)" -KeepRest }
        else { Set-Summary 'All done' $green " $GLYPH_DOT $($Plan.done)/$($Plan.total)" -KeepRest }
      } else {
        Set-Summary 'No plan yet' $dim '' -Plain
      }
    }
  }
}

# Full labels when they fit the row. Else the tabs not in front give up their counts one at a time
# ($SHORTEN_ORDER: the live test count last) until they fit; the tab in front gives up its own last.
function Set-TabLabels($Full, $Short) {
  $infinite = New-Object System.Windows.Size([double]::PositiveInfinity, [double]::PositiveInfinity)
  $order = @($SHORTEN_ORDER | Where-Object { $_ -ne $script:activeTab })
  if ($PICKABLE_TABS -contains $script:activeTab) { $order += $script:activeTab }
  $shortened = @()
  for ($step = 0; $step -le $order.Count; $step++) {
    if ($step -gt 0) { $shortened += $order[$step - 1] }
    # Each tab is measured itself: a panel's own Measure would hand back its last size, since a
    # child's new text only marks the child. The last tab's gap after it takes no room.
    $used = 0 - $TAB_GAP
    foreach ($tab in $pickTabs) {
      $tabName = $tab.Tag.name
      if ($shortened -contains $tabName) { $tab.Text = $Short[$tabName] } else { $tab.Text = $Full[$tabName] }
      Update-TabLook $tab
      $tab.Measure($infinite)
      $used += $tab.DesiredSize.Width
    }
    if ($used -le $CONTENT_W) { return }
  }
}

function Show-State {
  $state = $script:state
  if ($null -eq $state) { $state = @{ plan = $null; runs = @(); focus = $null; totals = $null; learn = $null } }
  $plan = $state.plan
  $runs = @($state.runs | Where-Object { $_ })
  $live = @($runs | Where-Object { $_.status -eq 'running' })
  $learn = $state.learn
  $learnBuild = if ($learn) { $learn.build } else { $null }

  # Which tab is in front. Something new (a new test run, a new plan) brings its tab forward and
  # ends the person's pick. Otherwise the tab they clicked stays; with no pick, the panel shows
  # what there is. What is new is measured against what the panel last showed, saved with the tab:
  # a restart whose first state shows the same plan and run keeps the tab, and a relaunch for a
  # new plan or run brings that one forward. Releases outlasts news (it stays until another tab is
  # clicked, or the card closes) and is only ever a click.
  $isNewRun = $false
  $isNewPlan = $false
  # Show-State also runs before anything is read (a missing file): that is no news, and what was
  # last shown stands.
  if ($null -ne $script:state) {
    $planTitle = $null
    if ($plan) { $planTitle = [string]$plan.title }
    $focus = $null
    if ($state.focus) { $focus = [string]$state.focus }
    if ($focus -and $focus -ne $script:seenFocus) {
      if ($null -ne $script:seenFocus -or $live.Count -gt 0) { $isNewRun = $true }
      $script:seenFocus = $focus
    }
    if ($planTitle -and $planTitle -ne $script:seenPlan -and -not $isNewRun) { $isNewPlan = $true }
    $script:seenPlan = $planTitle
  }
  if ($script:manualTab -ne 'releases' -and ($isNewRun -or $isNewPlan)) {
    if ($isNewRun) { $script:activeTab = 'tests' } else { $script:activeTab = 'phases' }
    # The pick news ended is gone from disk too, so the next start doesn't bring it back.
    if ($script:manualTab) { $script:manualTab = $null; Save-Prefs }
  }
  if ($script:manualTab) {
    $script:activeTab = $script:manualTab
  } else {
    if ($script:activeTab -eq 'releases') { $script:activeTab = 'phases' }
    if ($null -eq $plan -and $runs.Count -gt 0 -and $script:activeTab -ne 'learn') { $script:activeTab = 'tests' }
    if ($runs.Count -eq 0 -and $script:activeTab -eq 'tests') {
      if ($plan -or -not $learnBuild) { $script:activeTab = 'phases' } else { $script:activeTab = 'learn' }
    }
    # With no plan and no tests, a Learn build is what there is to show.
    if ($null -eq $plan -and $runs.Count -eq 0 -and $learnBuild) { $script:activeTab = 'learn' }
  }

  # The version, with the new mark while there are notes the person has not opened.
  $releasesTab.Inlines.Clear()
  $versionLabel = 'Releases'
  if ($PLUGIN_VERSION) { $versionLabel = "v$PLUGIN_VERSION" }
  [void]$releasesTab.Inlines.Add((New-Object System.Windows.Documents.Run($versionLabel)))
  if (Test-ReleaseUnseen) {
    $newRun = New-Object System.Windows.Documents.Run(" $GLYPH_LIVE")
    $newRun.Foreground = $accent
    [void]$releasesTab.Inlines.Add($newRun)
  }
  Update-TabLook $releasesTab

  $full = @{ phases = 'Phases'; tests = 'Tests'; learn = 'Learn' }
  $short = @{ phases = 'Phases'; tests = 'Tests'; learn = 'Learn' }
  if ($plan) { $full.phases = "Phases $($plan.done)/$($plan.total)" }
  if ($live.Count -gt 0) {
    $full.tests = "Tests $GLYPH_LIVE $($live[-1].count)"
    $short.tests = "Tests $GLYPH_LIVE"
  } elseif ($runs.Count -gt 0) {
    $full.tests = "Tests $((Get-RunLook $runs[-1]).glyph)"
    $short.tests = $full.tests
  }
  if ($learnBuild -and [string]$learnBuild.state -eq 'running') {
    $short.learn = "Learn $GLYPH_LIVE"
    $full.learn = $short.learn
    if ([int]$learnBuild.total -gt 0) { $full.learn = "Learn $([int]$learnBuild.done)/$([int]$learnBuild.total)" }
  }
  Set-TabLabels $full $short

  $body.Children.Clear()
  $footer.Text = ''
  if (-not $script:isExpanded) {
    # Collapsed: one line for the tab in front, and the close mark.
    Set-UiMarkGlyph $toggleMark $GLYPH_EXPAND
    $toggleMark.ToolTip = 'Expand'
    $headText.Visibility = 'Collapsed'
    $summaryRow.Visibility = 'Visible'
    $releasesTab.Visibility = 'Collapsed'
    $lookMark.Visibility = 'Collapsed'
    $gamesMark.Visibility = 'Collapsed'
    $tabRow.Visibility = 'Collapsed'
    $lookStrip.Visibility = 'Collapsed'
    $gamesStrip.Visibility = 'Collapsed'
    $rule.Visibility = 'Collapsed'
    $body.Visibility = 'Collapsed'
    $footer.Visibility = 'Collapsed'
    $grip.Visibility = 'Collapsed'
    $stack.Margin = New-Gap 12 $STACK_PAD 12 $STACK_PAD
    Show-Summary $plan $runs $learn
    return
  }

  Set-UiMarkGlyph $toggleMark $GLYPH_COLLAPSE
  $toggleMark.ToolTip = 'Collapse'
  $headText.Visibility = 'Visible'
  $summaryRow.Visibility = 'Collapsed'
  $releasesTab.Visibility = 'Visible'
  $lookMark.Visibility = 'Visible'
  $gamesMark.Visibility = 'Visible'
  $tabRow.Visibility = 'Visible'
  if ($script:strip -eq 'look') { $lookStrip.Visibility = 'Visible' } else { $lookStrip.Visibility = 'Collapsed' }
  if ($script:strip -eq 'games') { $gamesStrip.Visibility = 'Visible' } else { $gamesStrip.Visibility = 'Collapsed' }
  $rule.Visibility = 'Visible'
  $body.Visibility = 'Visible'
  $grip.Visibility = 'Visible'
  switch ($script:activeTab) {
    'tests' { Add-RunRows $runs }
    'learn' { Add-PlanGlance $plan; Add-LearnRows $learn }
    'releases' { Add-ReleaseRows }
    default { Add-PhaseRows $plan }
  }
  # The footer shows when the tab wrote one. (Its Text reads empty when it was built from runs, as
  # the tests footer is.)
  $hasFooter = [bool]$footer.Text
  foreach ($inline in $footer.Inlines) { if ($inline -is [System.Windows.Documents.Run] -and $inline.Text) { $hasFooter = $true } }
  if ($hasFooter) { $footer.Visibility = 'Visible' } else { $footer.Visibility = 'Collapsed' }
  # The last line, footer or not, sits a little higher, clear of the grip in the corner below it.
  $stack.Margin = New-Gap 12 $STACK_PAD 12 ($STACK_PAD + 2)
}

function Update-Panel {
  Show-State
  $win.UpdateLayout()
  Set-CardPosition
}

# A tab click: that tab stays in front until something new comes (see Show-State). Opening
# Releases marks its newest version seen.
function Select-Tab([string]$Name) {
  if ($Name -eq 'releases' -and $script:activeTab -ne 'releases') {
    $script:seenBefore = $script:seenRelease
    if ($NEWEST_RELEASE) { $script:seenRelease = $NEWEST_RELEASE }
  }
  $script:manualTab = $Name
  $script:activeTab = $Name
  Save-Prefs
  Update-Panel
}

# Opens a strip under the header ('look' or 'games'; '' closes it). One at a time; its mark shows it.
function Set-Strip([string]$Name) {
  $script:strip = $Name
  Set-UiMarkOn $lookMark ($Name -eq 'look')
  Set-UiMarkOn $gamesMark ($Name -eq 'games')
  # The choice may have changed in another window since the strip was last drawn.
  if ($Name -eq 'look') { Update-LookStrip }
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
  # A strip belongs to the open card: closing the card closes it. So does Releases, a look for the
  # open card: closed, the one line follows what is live, and no news is hidden behind it.
  if (-not $script:isExpanded) {
    Set-Strip ''
    if ($script:manualTab -eq 'releases') { $script:manualTab = $null }
  }
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
  $script:scale = [Math]::Max([double]$MIN_SCALE, [Math]::Min([double]$MAX_SCALE, [double]$next))
  $cardScale.ScaleX = $script:scale
  $cardScale.ScaleY = $script:scale
  $win.Width = $PANEL_W * $script:scale
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

# The marks take their own presses (they never start a drag or count toward a double-click).
$toggleMark.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Switch-Expanded })
$lookMark.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  if ($script:strip -eq 'look') { Set-Strip '' } else { Set-Strip 'look' }
  Update-Panel
})
$gamesMark.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  if ($script:strip -eq 'games') { Set-Strip '' } else { Set-Strip 'games' }
  Update-Panel
})
foreach ($chip in $gameChips) {
  $chip.Add_MouseLeftButtonUp({
    param($sender, $e)
    $e.Handled = $true
    Set-Strip ''
    Update-Panel
    Open-PanelSibling $sender.Tag.sibling ''
  })
}
$browserLink.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  Set-Strip ''
  Update-Panel
  Open-InBrowser 'learn'
})
$customLink.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  Set-Strip ''
  Update-Panel
  Open-PanelSibling 'learn' 'settings'
})
$closeMark.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  [void](Send-Event @{ event = 'closed' })
  $win.Close()
})

# --- Learn and the games: each its own process, so it outlives the panel -------

# Opens one of the other windows ($UI_SIBLINGS), owned by the chat's WezTerm window; Learn can be
# sent to a view and a course. One open already comes forward at once, through this panel's own
# Win32 (the shared Open-Sibling compiles its own the first time); a new one starts through
# Open-Sibling.
function Open-PanelSibling([string]$Id, [string]$View, [string]$CourseId) {
  try {
    $sibling = $UI_SIBLINGS | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if (-not $sibling) { return }
    $windowText = $sibling.title
    if (-not $sibling.shared) { $windowText = '{0}:{1}' -f $sibling.title, $SessionId }
    $existing = [PhasesWin32]::WindowByText($windowText)
    if ($existing -ne [IntPtr]::Zero) {
      if ($sibling.id -eq 'learn') { Write-LearnRequest $View $CourseId }
      # The panel just took the click, so it may hand the foreground over.
      [void][PhasesWin32]::SetForegroundWindow($existing)
      return
    }
    Open-Sibling $Id ([int64]$owner) $SessionId -View $View -CourseId $CourseId
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
  if ($SnapshotTab) { Select-Tab $SnapshotTab }
  if ($SnapshotLook) { $script:isExpanded = $SnapshotLook -eq 'open' }
  if ($SnapshotStrip -and $script:isExpanded) { Set-Strip $SnapshotStrip }
  Show-State
  $win.UpdateLayout()
  $dpi = [double]$SnapshotDpi
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
$script:isThemeStale = $false
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$timer.Add_Tick({
  # A colour scheme or see-through change made in another window (at most one look a second):
  # the brushes repaint themselves and the halo follows at once; the strip's swatches and bars
  # follow and the tab is redrawn, once no drag is under way. (A change made here moves the halo
  # itself: see the panel's bar and the swatches.)
  if (Update-Theme) { $script:isThemeStale = $true; Update-UiHalo }
  if ($script:isThemeStale -and -not $script:dragging -and -not $script:resizing) {
    $script:isThemeStale = $false
    Update-LookStrip
    Update-Panel
  }
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
# Nothing to read yet (or a snapshot of a missing file): still draw the header and an empty tab.
if ($null -eq $script:state) { Show-State }
$owned = New-Object System.Windows.Interop.WindowInteropHelper($win)
$owned.Owner = $owner
$timer.Start()
$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnMainWindowClose'
[void]$app.Run($win)
$timer.Stop()
try { $mutex.ReleaseMutex() } catch {}
exit 0
