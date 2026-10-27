#Requires -Version 5.1
# A typing test in Monkeytype's image: words mode, 10 words from its English
# 200 list, its caret, its result screen, and its themes: all of Monkeytype's
# colour themes, read from TypeThemes.txt (made from Monkeytype's themes.ts),
# picked with Esc or the theme name in the footer.
#
# The test starts on the first letter and ends when the last word is typed
# right (or a space ends it). Space moves on; a space at a word's start does
# nothing; a word left wrong is underlined, and Backspace at a word's start
# goes back into the word before only when that word is wrong. Ctrl+Backspace
# clears a word. Tab starts a new test at any time.
#
# Scored as Monkeytype scores: wpm counts the letters of correctly typed words
# and the spaces after them, raw counts every letter and space typed, both as
# 5-letter words per minute; accuracy is right keypresses over all keypresses;
# consistency is Monkeytype's kogasa curve over the per-second raw speeds.
#
# Its own process, owned by the chat's WezTerm window (-OwnerHwnd), like the
# other games. PowerShell names ignore case: constants are $*_LIST / $*_COUNT /
# $GLYPH_*, and $input is PowerShell's own, so typed text is $typed. Kept to
# ASCII: every non-ASCII glyph is built from its code point.

param(
  [int64]$OwnerHwnd = 0,
  [string]$SessionId = 'default',
  [int]$Seed = 0,
  # Testing aids: check the scoring and exit, or draw a view to a PNG and exit.
  [switch]$SelfTest,
  [string]$SnapshotPath = '',
  [ValidateSet('typing', 'result', 'played', 'themes')][string]$SnapshotView = 'typing',
  [string]$SnapshotTheme = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Send-Event($Event) {
  try {
    [Console]::Out.WriteLine(($Event | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } catch {}
}

# C# 5 only: Windows PowerShell compiles this with the old compiler.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TypeWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);

  public static IntPtr WindowByText(string text) {
    IntPtr found = IntPtr.Zero;
    var s = new StringBuilder(512);
    EnumWindows((hwnd, l) => {
      s.Length = 0;
      GetWindowText(hwnd, s, 512);
      if (IsWindowVisible(hwnd) && s.ToString() == text) { found = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}

public sealed class TypeCount {
  public int CorrectWordChars, CorrectChars, IncorrectChars, ExtraChars, MissedChars, CorrectSpaces, AllSpaces;
}

// Monkeytype's arithmetic. Words before `submitted` were ended with a space
// (no space follows the test's last word); the word at `submitted` is the one
// being typed. With countPartial, a right start of that word counts toward
// wpm, as the live per-second wpm does.
public static class TypeStats {
  public static TypeCount Count(string[] targets, string[] inputs, int submitted, bool countPartial) {
    var c = new TypeCount();
    for (int i = 0; i < targets.Length && i <= submitted; i++) {
      string target = targets[i];
      string typed = inputs[i] ?? "";
      bool isSubmitted = i < submitted;
      if (!isSubmitted && typed.Length == 0) break;
      bool isRight = typed == target;
      if (isRight) {
        c.CorrectWordChars += target.Length;
        c.CorrectChars += target.Length;
      } else {
        for (int j = 0; j < typed.Length; j++) {
          if (j >= target.Length) c.ExtraChars++;
          else if (typed[j] == target[j]) c.CorrectChars++;
          else c.IncorrectChars++;
        }
        if (isSubmitted) c.MissedChars += Math.Max(0, target.Length - typed.Length);
        else if (countPartial && target.StartsWith(typed, StringComparison.Ordinal)) c.CorrectWordChars += typed.Length;
      }
      if (isSubmitted && i < targets.Length - 1) {
        c.AllSpaces++;
        if (isRight) c.CorrectSpaces++;
      }
    }
    return c;
  }

  public static double Wpm(TypeCount c, double seconds) {
    return seconds <= 0 ? 0 : (c.CorrectWordChars + c.CorrectSpaces) * 60.0 / seconds / 5.0;
  }

  public static double Raw(TypeCount c, double seconds) {
    return seconds <= 0 ? 0 : (c.CorrectChars + c.IncorrectChars + c.ExtraChars + c.AllSpaces) * 60.0 / seconds / 5.0;
  }

  public static double Kogasa(double cov) {
    return 100.0 * (1.0 - Math.Tanh(cov + Math.Pow(cov, 3) / 3.0 + Math.Pow(cov, 5) / 5.0));
  }

  // How even the per-second raw speeds were: 100 when every second was alike.
  public static double Consistency(double[] raw) {
    if (raw == null || raw.Length == 0) return 0;
    double mean = 0;
    foreach (double v in raw) mean += v;
    mean /= raw.Length;
    if (mean <= 0) return 0;
    double squares = 0;
    foreach (double v in raw) squares += (v - mean) * (v - mean);
    return Kogasa(Math.Sqrt(squares / raw.Length) / mean);
  }
}
'@

# --- Self-test: the scoring, on small cases -------------------------------------------

function Test-Near([double]$Value, [double]$Expected) { return [Math]::Abs($Value - $Expected) -lt 0.001 }

if ($SelfTest) {
  $checks = [ordered]@{}
  # Two words typed right in 6 s: 4 letters + 1 space = 5 characters = 1 word in 6 s.
  $right = [TypeStats]::Count([string[]]@('ab', 'cd'), [string[]]@('ab', 'cd'), 1, $false)
  $checks.rightWordsAndSpaceCount = $right.CorrectWordChars -eq 4 -and $right.CorrectSpaces -eq 1 -and $right.AllSpaces -eq 1
  $checks.wpmIsFivePerWord = Test-Near ([TypeStats]::Wpm($right, 6)) 10
  # A wrong word gives no wpm, its right letters still count raw.
  $wrong = [TypeStats]::Count([string[]]@('ab', 'cd'), [string[]]@('ax', 'cd'), 1, $false)
  $checks.wrongWordGivesNoWpm = $wrong.CorrectWordChars -eq 2 -and $wrong.CorrectSpaces -eq 0
  $checks.wrongWordCountsRaw = $wrong.CorrectChars -eq 3 -and $wrong.IncorrectChars -eq 1 -and (Test-Near ([TypeStats]::Raw($wrong, 6)) 10)
  # Extra and missed letters.
  $extra = [TypeStats]::Count([string[]]@('ab', 'c'), [string[]]@('abz', 'c'), 1, $false)
  $checks.extraLetters = $extra.ExtraChars -eq 1 -and $extra.CorrectChars -eq 3
  $missed = [TypeStats]::Count([string[]]@('abc', 'd'), [string[]]@('a', 'd'), 1, $false)
  $checks.missedLetters = $missed.MissedChars -eq 2
  # The last word ended by space adds no space; a right start counts live only.
  $ended = [TypeStats]::Count([string[]]@('ab', 'cd'), [string[]]@('ab', 'c'), 2, $false)
  $checks.lastWordNoSpace = $ended.AllSpaces -eq 1 -and $ended.MissedChars -eq 1
  $live = [TypeStats]::Count([string[]]@('ab', 'cd'), [string[]]@('ab', 'c'), 1, $true)
  $checks.liveCountsRightStart = $live.CorrectWordChars -eq 3
  # Consistency: even speeds are 100, uneven ones lower.
  $checks.evenIsHundred = Test-Near ([TypeStats]::Consistency([double[]]@(80, 80, 80))) 100
  $checks.unevenIsLower = [TypeStats]::Consistency([double[]]@(40, 120, 80)) -lt 80
  $ok = $true
  foreach ($key in @($checks.Keys)) { if (-not $checks[$key]) { $ok = $false } }
  $checks.ok = $ok
  Send-Event $checks
  if ($ok) { exit 0 } else { exit 1 }
}

# --- One test window per chat ---------------------------------------------------------

[void][TypeWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$WINDOW_TITLE = "ClaudeTypeTest:$SessionId"
$mutex = New-Object System.Threading.Mutex($false, "Local\ClaudeTypeTest-$SessionId")
try {
  $isOwner = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $isOwner = $true
}
if (-not $isOwner -and -not $SnapshotPath) {
  $existing = [TypeWin32]::WindowByText($WINDOW_TITLE)
  if ($existing -ne [IntPtr]::Zero) { [void][TypeWin32]::SetForegroundWindow($existing) }
  exit 0
}

$owner = [IntPtr]$OwnerHwnd
$hasOwner = $owner -ne [IntPtr]::Zero -and [TypeWin32]::IsWindow($owner)

$GLYPH_CLOSE = [string][char]0x2715
$GLYPH_GRIP = [string][char]0x25E2
$GLYPH_CROWN = [string][char]0x265B
$MIN_SCALE = 0.7
$MAX_SCALE = 2.5
$WORD_COUNT = 10
$EXTRA_LIMIT = 10
$WORDS_WIDTH = 640
$LETTER_SIZE = 26

# Monkeytype's English 200.
$WORD_LIST = @(('the be of and a to in he have it that for they i with as not on she at by this we you do but from or ' +
  'which one would all will there say who make when can more if no man out other so what time up go about than into could ' +
  'state only new year some take come these know see use get like then first any work now may such give over think most ' +
  'even find day also after way many must look before great back through long where much should well people down own just ' +
  'because good each those feel seem how high too place little world very still nation hand old life tell write become here ' +
  'show house both between need mean call develop under last right move thing general school never same another begin while ' +
  'number part turn real leave might want point form off child few small since against ask late home interest large person ' +
  'end open public follow during present without again hold govern around possible head consider word program problem ' +
  'however lead system set order eye plan run keep face fact group play stand increase early course change help line') -split ' ')

# --- What the person left: where, how big, the best wpm --------------------------------

$prefsFile = Join-Path $env:LOCALAPPDATA 'ClaudePhases\typetest.json'
$script:offset = $null
$script:scale = 1.0
$script:best = 0.0
$script:themeName = 'serika_dark'
try {
  if (Test-Path $prefsFile) {
    $saved = Get-Content $prefsFile -Raw | ConvertFrom-Json
    if ($null -ne $saved.dx) { $script:offset = @{ dx = [int]$saved.dx; dy = [int]$saved.dy } }
    if ($saved.scale) { $script:scale = [Math]::Max([double]$MIN_SCALE, [Math]::Min([double]$MAX_SCALE, [double]$saved.scale)) }
    if ($saved.pb) { $script:best = [double]$saved.pb }
    if ($saved.theme) { $script:themeName = [string]$saved.theme }
  }
} catch {}

function Save-Prefs {
  # Test runs leave the person's record alone.
  if ($SnapshotPath) { return }
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $prefsFile) | Out-Null
    $prefs = @{ scale = [Math]::Round($script:scale, 3); pb = [Math]::Round($script:best, 2); theme = $script:themeName }
    if ($script:offset) { $prefs.dx = $script:offset.dx; $prefs.dy = $script:offset.dy }
    $prefs | ConvertTo-Json -Compress | Set-Content -Path $prefsFile -Encoding ASCII
  } catch {}
}

# --- The window, in the chosen theme ----------------------------------------------------

function ConvertTo-Color([string]$Hex) { return [System.Windows.Media.Color][System.Windows.Media.ColorConverter]::ConvertFromString($Hex) }
function Brush([string]$Hex) { return New-Object System.Windows.Media.SolidColorBrush((ConvertTo-Color $Hex)) }

# Monkeytype's themes: name -> bg, main, caret, sub, subAlt, text, error, errorExtra.
$SERIKA_DARK = @('#323437', '#E2B714', '#E2B714', '#646669', '#2C2E31', '#D1D0C5', '#CA4754', '#7E2A33')
$script:themes = [ordered]@{}
try {
  foreach ($line in Get-Content (Join-Path $PSScriptRoot 'TypeThemes.txt')) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $fields = $line.Split('|')
    if ($fields.Length -eq 9) { $script:themes[$fields[0]] = [string[]]$fields[1..8] }
  }
} catch {}
if (-not $script:themes.Contains('serika_dark')) { $script:themes['serika_dark'] = $SERIKA_DARK }
if (-not $script:themes.Contains($script:themeName)) { $script:themeName = 'serika_dark' }

# Live brushes: every element painted with one of these changes with the theme.
$bgBrush = Brush $SERIKA_DARK[0]
$mainBrush = Brush $SERIKA_DARK[1]
$caretBrush = Brush $SERIKA_DARK[2]
$subBrush = Brush $SERIKA_DARK[3]
$subAltBrush = Brush $SERIKA_DARK[4]
$textBrush = Brush $SERIKA_DARK[5]
$errorBrush = Brush $SERIKA_DARK[6]
$extraBrush = Brush $SERIKA_DARK[7]
$gridBrush = Brush $SERIKA_DARK[4]
$edgeBrush = Brush '#40FFFFFF'
$noFill = [System.Windows.Media.Brushes]::Transparent

function Set-Colors([string]$Name) {
  $colors = $script:themes[$Name]
  if (-not $colors) { return }
  $bgBrush.Color = ConvertTo-Color $colors[0]
  $mainBrush.Color = ConvertTo-Color $colors[1]
  $caretBrush.Color = ConvertTo-Color $colors[2]
  $subBrush.Color = ConvertTo-Color $colors[3]
  $subAltBrush.Color = ConvertTo-Color $colors[4]
  $textBrush.Color = ConvertTo-Color $colors[5]
  $errorBrush.Color = ConvertTo-Color $colors[6]
  $extraBrush.Color = ConvertTo-Color $colors[7]
  $gridBrush.Color = ConvertTo-Color $colors[4]
  $sub = ConvertTo-Color $colors[3]
  $edgeBrush.Color = [System.Windows.Media.Color]::FromArgb(80, $sub.R, $sub.G, $sub.B)
}
$typeFont = New-Object System.Windows.Media.FontFamily('Roboto Mono, Cascadia Mono, Consolas')

function New-Text([string]$Text, $Foreground, [double]$Size = 14) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.Foreground = $Foreground
  $block.FontSize = $Size
  return $block
}

function New-Gap([double]$Left, [double]$Top, [double]$Right, [double]$Bottom) {
  return New-Object System.Windows.Thickness($Left, $Top, $Right, $Bottom)
}

$win = New-Object System.Windows.Window
$win.Title = $WINDOW_TITLE
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.ShowInTaskbar = -not $hasOwner
$win.ResizeMode = 'NoResize'
$win.SizeToContent = 'WidthAndHeight'
$win.FontFamily = $typeFont
$win.FontSize = 14
if ($hasOwner) {
  $win.Left = -32000
  $win.Top = -32000
} else {
  $win.WindowStartupLocation = 'CenterScreen'
}

$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius(10)
$card.Background = $bgBrush
$card.BorderBrush = $edgeBrush
$card.BorderThickness = New-Object System.Windows.Thickness(1)
$card.Padding = New-Gap 26 16 26 18

# Header: the name, the test's settings, the close mark. Dragging it moves the window.
$header = New-Object System.Windows.Controls.DockPanel
$header.Cursor = [System.Windows.Input.Cursors]::SizeAll
$header.Background = $noFill
$logo = New-Object System.Windows.Controls.TextBlock
$logo.FontSize = 20
$logo.FontWeight = 'Bold'
$logoSub = New-Object System.Windows.Documents.Run('type')
$logoSub.Foreground = $subBrush
$logoMain = New-Object System.Windows.Documents.Run('test')
$logoMain.Foreground = $textBrush
[void]$logo.Inlines.Add($logoSub)
[void]$logo.Inlines.Add($logoMain)
[System.Windows.Controls.DockPanel]::SetDock($logo, 'Left')
$closeText = New-Text $GLYPH_CLOSE $subBrush 13
$closeText.Margin = New-Gap 16 0 0 0
$closeText.VerticalAlignment = 'Center'
$closeText.Cursor = [System.Windows.Input.Cursors]::Hand
[System.Windows.Controls.DockPanel]::SetDock($closeText, 'Right')
$settingsText = New-Object System.Windows.Controls.TextBlock
$settingsText.FontSize = 13
$settingsText.VerticalAlignment = 'Center'
$settingsText.HorizontalAlignment = 'Right'
foreach ($part in @(@('words ', $mainBrush), @("$WORD_COUNT", $mainBrush), @('  english', $subBrush))) {
  $run = New-Object System.Windows.Documents.Run($part[0])
  $run.Foreground = $part[1]
  [void]$settingsText.Inlines.Add($run)
}
[void]$header.Children.Add($logo)
[void]$header.Children.Add($closeText)
[void]$header.Children.Add($settingsText)

# The typing view: the live count, the words, the caret over them, and the
# "click to focus" veil Monkeytype shows when the window is not in front.
$typingView = New-Object System.Windows.Controls.StackPanel
$typingView.Margin = New-Gap 0 26 0 0
$typingView.VerticalAlignment = 'Center'
$progressText = New-Text '' $mainBrush 22
$progressText.Visibility = 'Hidden'
$progressText.Margin = New-Gap 0 0 0 6
$wordsHost = New-Object System.Windows.Controls.Grid
$wordsPanel = New-Object System.Windows.Controls.WrapPanel
$wordsPanel.Width = $WORDS_WIDTH
$caretLayer = New-Object System.Windows.Controls.Canvas
$caretLayer.IsHitTestVisible = $false
$caret = New-Object System.Windows.Shapes.Rectangle
$caret.Width = 2.5
$caret.Height = $LETTER_SIZE * 1.15
$caret.RadiusX = 1
$caret.RadiusY = 1
$caret.Fill = $caretBrush
[void]$caretLayer.Children.Add($caret)
$focusVeil = New-Text 'Click here to focus' $textBrush 16
$focusVeil.HorizontalAlignment = 'Center'
$focusVeil.VerticalAlignment = 'Center'
$focusVeil.Visibility = 'Collapsed'
$focusVeil.IsHitTestVisible = $false
[void]$wordsHost.Children.Add($wordsPanel)
[void]$wordsHost.Children.Add($caretLayer)
[void]$wordsHost.Children.Add($focusVeil)
[void]$typingView.Children.Add($progressText)
[void]$typingView.Children.Add($wordsHost)

# The result view: wpm and acc large on the left, the speed graph on the right,
# then the details row.
$resultView = New-Object System.Windows.Controls.Grid
$resultView.Margin = New-Gap 0 22 0 0
$resultView.Visibility = 'Hidden'
foreach ($rowHeight in @('Auto', 'Auto')) {
  $row = New-Object System.Windows.Controls.RowDefinition
  $row.Height = [System.Windows.GridLength]::Auto
  [void]$resultView.RowDefinitions.Add($row)
}
$leftColumn = New-Object System.Windows.Controls.ColumnDefinition
$leftColumn.Width = [System.Windows.GridLength]::Auto
$rightColumn = New-Object System.Windows.Controls.ColumnDefinition
[void]$resultView.ColumnDefinitions.Add($leftColumn)
[void]$resultView.ColumnDefinitions.Add($rightColumn)

function New-Stat([string]$Label, [double]$ValueSize) {
  $stack = New-Object System.Windows.Controls.StackPanel
  $name = New-Text $Label $subBrush ([Math]::Max(14, $ValueSize * 0.38))
  $value = New-Text '-' $mainBrush $ValueSize
  $value.Margin = New-Gap 0 -4 0 0
  [void]$stack.Children.Add($name)
  [void]$stack.Children.Add($value)
  return @{ stack = $stack; value = $value; name = $name }
}

$bigStats = New-Object System.Windows.Controls.StackPanel
$bigStats.Margin = New-Gap 0 0 28 0
$wpmStat = New-Stat 'wpm' 58
$crownText = New-Text '' $mainBrush 22
$crownText.ToolTip = 'new personal best'
$crownText.Visibility = 'Collapsed'
$wpmLine = New-Object System.Windows.Controls.StackPanel
$wpmLine.Orientation = 'Horizontal'
[void]$wpmStat.stack.Children.Remove($wpmStat.value)
[void]$wpmLine.Children.Add($wpmStat.value)
$crownText.Text = $GLYPH_CROWN
$crownText.VerticalAlignment = 'Center'
$crownText.Margin = New-Gap 8 6 0 0
[void]$wpmLine.Children.Add($crownText)
[void]$wpmStat.stack.Children.Add($wpmLine)
$accStat = New-Stat 'acc' 58
$accStat.stack.Margin = New-Gap 0 4 0 0
[void]$bigStats.Children.Add($wpmStat.stack)
[void]$bigStats.Children.Add($accStat.stack)
[System.Windows.Controls.Grid]::SetRow($bigStats, 0)
[System.Windows.Controls.Grid]::SetColumn($bigStats, 0)
[void]$resultView.Children.Add($bigStats)

$GRAPH_W = 440
$GRAPH_H = 170
$graph = New-Object System.Windows.Controls.Canvas
$graph.Width = $GRAPH_W
$graph.Height = $GRAPH_H + 18
$graph.Margin = New-Gap 34 8 0 0
$graph.VerticalAlignment = 'Top'
[System.Windows.Controls.Grid]::SetRow($graph, 0)
[System.Windows.Controls.Grid]::SetColumn($graph, 1)
[void]$resultView.Children.Add($graph)

$details = New-Object System.Windows.Controls.WrapPanel
$details.Margin = New-Gap 0 18 0 0
[System.Windows.Controls.Grid]::SetRow($details, 1)
[System.Windows.Controls.Grid]::SetColumnSpan($details, 2)
$typeStat = New-Stat 'test type' 16
$typeStat.value.Text = "words $WORD_COUNT`nenglish"
$rawStat = New-Stat 'raw' 30
$charsStat = New-Stat 'characters' 30
$charsStat.stack.ToolTip = 'correct, incorrect, extra, and missed'
$consistencyStat = New-Stat 'consistency' 30
$timeStat = New-Stat 'time' 30
foreach ($stat in @($typeStat, $rawStat, $charsStat, $consistencyStat, $timeStat)) {
  $stat.name.FontSize = 15
  $stat.stack.Margin = New-Gap 0 0 40 0
  [void]$details.Children.Add($stat.stack)
}
[void]$resultView.Children.Add($details)

# The two views share one place; the hidden one still holds the size, so the
# window does not jump between them.
$views = New-Object System.Windows.Controls.Grid
[void]$views.Children.Add($typingView)
[void]$views.Children.Add($resultView)

# The theme picker: a search box and every theme as a swatch, in the theme's
# own colours. It covers the test while open.
$THEME_BUTTON_W = 150
$picker = New-Object System.Windows.Controls.DockPanel
$picker.Background = $bgBrush
$picker.Visibility = 'Collapsed'
$picker.Margin = New-Gap 0 12 0 0
$searchHost = New-Object System.Windows.Controls.Grid
[System.Windows.Controls.DockPanel]::SetDock($searchHost, 'Top')
$searchBox = New-Object System.Windows.Controls.TextBox
$searchBox.Background = $subAltBrush
$searchBox.Foreground = $textBrush
$searchBox.CaretBrush = $caretBrush
$searchBox.SelectionBrush = $mainBrush
$searchBox.BorderThickness = New-Object System.Windows.Thickness(0)
$searchBox.FontFamily = $typeFont
$searchBox.FontSize = 15
$searchBox.Padding = New-Gap 10 6 10 6
$searchBox.FocusVisualStyle = $null
$searchHint = New-Text 'search themes...' $subBrush 15
$searchHint.Margin = New-Gap 13 6 0 0
$searchHint.IsHitTestVisible = $false
[void]$searchHost.Children.Add($searchBox)
[void]$searchHost.Children.Add($searchHint)
$themeScroll = New-Object System.Windows.Controls.ScrollViewer
$themeScroll.VerticalScrollBarVisibility = 'Hidden'
$themeScroll.Margin = New-Gap 0 10 0 0
$themeGrid = New-Object System.Windows.Controls.WrapPanel
$themeGrid.Width = $WORDS_WIDTH
$themeScroll.Content = $themeGrid
[void]$picker.Children.Add($searchHost)
[void]$picker.Children.Add($themeScroll)
[void]$views.Children.Add($picker)

# Footer: Tab restarts.
# Footer: Tab restarts, Esc picks a theme; the theme's name sits on the right.
function New-KeyChip([string]$Key) {
  $chip = New-Object System.Windows.Controls.Border
  $chip.Background = $subAltBrush
  $chip.CornerRadius = New-Object System.Windows.CornerRadius(4)
  $chip.Padding = New-Gap 6 1 6 2
  $chip.Child = New-Text $Key $textBrush 12
  return $chip
}
$footer = New-Object System.Windows.Controls.Grid
$footer.Margin = New-Gap 0 26 0 0
$hints = New-Object System.Windows.Controls.StackPanel
$hints.Orientation = 'Horizontal'
$hints.HorizontalAlignment = 'Center'
[void]$hints.Children.Add((New-KeyChip 'tab'))
[void]$hints.Children.Add((New-Text ' - restart test' $subBrush 12))
$escChip = New-KeyChip 'esc'
$escChip.Margin = New-Gap 18 0 0 0
[void]$hints.Children.Add($escChip)
[void]$hints.Children.Add((New-Text ' - themes' $subBrush 12))
$themeButton = New-Object System.Windows.Controls.StackPanel
$themeButton.Orientation = 'Horizontal'
$themeButton.HorizontalAlignment = 'Right'
$themeButton.Cursor = [System.Windows.Input.Cursors]::Hand
$themeButton.ToolTip = 'Themes (Esc)'
$themeButton.Background = $noFill
$themeDot = New-Object System.Windows.Shapes.Ellipse
$themeDot.Width = 9
$themeDot.Height = 9
$themeDot.Fill = $mainBrush
$themeDot.VerticalAlignment = 'Center'
$themeDot.Margin = New-Gap 0 1 6 0
$themeLabel = New-Text '' $subBrush 12
[void]$themeButton.Children.Add($themeDot)
[void]$themeButton.Children.Add($themeLabel)
[void]$footer.Children.Add($hints)
[void]$footer.Children.Add($themeButton)

$stackAll = New-Object System.Windows.Controls.StackPanel
[void]$stackAll.Children.Add($header)
[void]$stackAll.Children.Add($views)
[void]$stackAll.Children.Add($footer)
$card.Child = $stackAll

$cardScale = New-Object System.Windows.Media.ScaleTransform($script:scale, $script:scale)
$card.LayoutTransform = $cardScale

# The resize grip, bottom-right: the window is pinned by its top-left corner,
# so pulling the grip out (right or down) grows it.
$grip = New-Text $GLYPH_GRIP $subBrush 11
$grip.Margin = New-Gap 0 0 7 5
$grip.HorizontalAlignment = 'Right'
$grip.VerticalAlignment = 'Bottom'
$grip.Cursor = [System.Windows.Input.Cursors]::SizeNWSE
$grip.ToolTip = 'Drag to resize'

$cardHost = New-Object System.Windows.Controls.Grid
[void]$cardHost.Children.Add($card)
[void]$cardHost.Children.Add($grip)
$win.Content = $cardHost

# --- The test ---------------------------------------------------------------------

$script:rng = if ($Seed -ne 0) { New-Object System.Random($Seed) } else { New-Object System.Random }
$script:targets = [string[]]@()
$script:typedWords = [string[]]@()
$script:current = 0
$script:isStarted = $false
$script:isFinished = $false
$script:watch = New-Object System.Diagnostics.Stopwatch
$script:keyCount = 0
$script:goodKeys = 0
$script:secondChars = 0
$script:secondErrors = 0
$script:samples = New-Object System.Collections.Generic.List[object]
$script:wordViews = @()
$script:caretPlaced = $false

# A new word never repeats either of the two before it, as Monkeytype picks.
function Get-Words {
  $picked = New-Object System.Collections.Generic.List[string]
  while ($picked.Count -lt $WORD_COUNT) {
    $word = $WORD_LIST[$script:rng.Next($WORD_LIST.Count)]
    if ($picked.Count -ge 1 -and $picked[$picked.Count - 1] -eq $word) { continue }
    if ($picked.Count -ge 2 -and $picked[$picked.Count - 2] -eq $word) { continue }
    $picked.Add($word)
  }
  return , ([string[]]$picked.ToArray())
}

function Build-Words {
  $wordsPanel.Children.Clear()
  $built = @()
  for ($i = 0; $i -lt $script:targets.Length; $i++) {
    $underline = New-Object System.Windows.Controls.Border
    $underline.BorderThickness = New-Gap 0 0 0 2
    $underline.BorderBrush = $noFill
    $underline.Margin = New-Gap 0 4 ($LETTER_SIZE * 0.6) 4
    $letters = New-Object System.Windows.Controls.StackPanel
    $letters.Orientation = 'Horizontal'
    $underline.Child = $letters
    [void]$wordsPanel.Children.Add($underline)
    $built += , @{ border = $underline; letters = $letters }
  }
  $script:wordViews = $built
  for ($i = 0; $i -lt $script:targets.Length; $i++) { Update-Word $i }
}

function New-Letter([string]$Char, $Foreground) {
  $letter = New-Text $Char $Foreground $LETTER_SIZE
  return $letter
}

# One word drawn from what was typed into it: grey still to type, light typed
# right, red typed wrong, dark red typed past its end; underlined red once left
# wrong.
function Update-Word([int]$Index) {
  $view = $script:wordViews[$Index]
  $target = $script:targets[$Index]
  $typed = $script:typedWords[$Index]
  $view.letters.Children.Clear()
  for ($j = 0; $j -lt $target.Length; $j++) {
    $color = $subBrush
    if ($j -lt $typed.Length) {
      if ($typed[$j] -ceq $target[$j]) { $color = $textBrush } else { $color = $errorBrush }
    }
    [void]$view.letters.Children.Add((New-Letter ([string]$target[$j]) $color))
  }
  for ($j = $target.Length; $j -lt $typed.Length; $j++) {
    [void]$view.letters.Children.Add((New-Letter ([string]$typed[$j]) $extraBrush))
  }
  $isLeftWrong = $Index -lt $script:current -and -not ($typed -ceq $target)
  if ($isLeftWrong) { $view.border.BorderBrush = $errorBrush } else { $view.border.BorderBrush = $noFill }
}

# The caret sits before the next letter to type, or after the word's last.
function Move-Caret([switch]$Jump) {
  if ($script:isFinished -or $script:current -ge $script:wordViews.Count) { return }
  $wordsPanel.UpdateLayout()
  $view = $script:wordViews[$script:current]
  $count = $view.letters.Children.Count
  $at = $script:typedWords[$script:current].Length
  if ($count -eq 0) { return }
  if ($at -lt $count) {
    $letter = $view.letters.Children[$at]
    $point = $letter.TranslatePoint((New-Object System.Windows.Point(0, 0)), $caretLayer)
  } else {
    $letter = $view.letters.Children[$count - 1]
    $point = $letter.TranslatePoint((New-Object System.Windows.Point($letter.ActualWidth, 0)), $caretLayer)
  }
  $x = $point.X - 1
  $y = $point.Y + ($letter.ActualHeight - $caret.Height) / 2
  if ($Jump -or -not $script:caretPlaced) {
    $caret.BeginAnimation([System.Windows.Controls.Canvas]::LeftProperty, $null)
    $caret.BeginAnimation([System.Windows.Controls.Canvas]::TopProperty, $null)
    [System.Windows.Controls.Canvas]::SetLeft($caret, $x)
    [System.Windows.Controls.Canvas]::SetTop($caret, $y)
    $script:caretPlaced = $true
    return
  }
  # Monkeytype's smooth caret: it glides to the next letter.
  $time = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(90))
  $caret.BeginAnimation([System.Windows.Controls.Canvas]::LeftProperty, (New-Object System.Windows.Media.Animation.DoubleAnimation([double]$x, $time)))
  $caret.BeginAnimation([System.Windows.Controls.Canvas]::TopProperty, (New-Object System.Windows.Media.Animation.DoubleAnimation([double]$y, $time)))
}

# The caret blinks while nothing is typed, and holds still while typing.
$blink = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(500))))
$blink.AutoReverse = $true
$blink.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
function Start-Blink { $caret.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $blink) }
function Stop-Blink {
  $caret.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $caret.Opacity = 1
}

$idleTimer = New-Object System.Windows.Threading.DispatcherTimer
$idleTimer.Interval = [TimeSpan]::FromMilliseconds(1000)
$idleTimer.Add_Tick({ $idleTimer.Stop(); if (-not $script:isFinished) { Start-Blink } })

function Update-Progress {
  if ($script:isStarted -and -not $script:isFinished) {
    $progressText.Text = "$($script:current)/$WORD_COUNT"
    $progressText.Visibility = 'Visible'
  } else {
    $progressText.Visibility = 'Hidden'
  }
}

# Each second while typing: the wpm so far, the raw speed of that second, and
# its errors, for the graph and the consistency.
$secondTimer = New-Object System.Windows.Threading.DispatcherTimer
$secondTimer.Interval = [TimeSpan]::FromMilliseconds(1000)
$secondTimer.Add_Tick({ Add-Sample 1.0 })

function Add-Sample([double]$Span) {
  $seconds = $script:watch.Elapsed.TotalSeconds
  $tally = [TypeStats]::Count($script:targets, $script:typedWords, $script:current, $true)
  $script:samples.Add(@{
    wpm = [TypeStats]::Wpm($tally, $seconds)
    raw = $script:secondChars * 60.0 / 5.0 / $Span
    errors = $script:secondErrors
  })
  $script:secondChars = 0
  $script:secondErrors = 0
}

function New-Test {
  $secondTimer.Stop()
  $idleTimer.Stop()
  $script:watch.Reset()
  $script:targets = Get-Words
  $script:typedWords = [string[]]::new($WORD_COUNT)
  for ($i = 0; $i -lt $WORD_COUNT; $i++) { $script:typedWords[$i] = '' }
  $script:current = 0
  $script:isStarted = $false
  $script:isFinished = $false
  $script:keyCount = 0
  $script:goodKeys = 0
  $script:secondChars = 0
  $script:secondErrors = 0
  $script:samples.Clear()
  Build-Words
  $resultView.Visibility = 'Hidden'
  $typingView.Visibility = 'Visible'
  $caret.Visibility = 'Visible'
  Update-Progress
  Move-Caret -Jump
  Start-Blink
}

function Start-Test {
  $script:isStarted = $true
  $script:watch.Restart()
  $secondTimer.Start()
}

function Add-Keypress([bool]$IsRight) {
  $script:keyCount++
  $script:secondChars++
  if ($IsRight) { $script:goodKeys++ } else { $script:secondErrors++ }
  Stop-Blink
  $idleTimer.Stop()
  $idleTimer.Start()
}

function Add-Letter([string]$Char) {
  if ($script:isFinished) { return }
  if ($Char -eq ' ') { Submit-Word; return }
  if (-not $script:isStarted) { Start-Test }
  $i = $script:current
  $target = $script:targets[$i]
  $typed = $script:typedWords[$i]
  if ($typed.Length -ge $target.Length + $EXTRA_LIMIT) { return }
  $isRight = $typed.Length -lt $target.Length -and ([string]$target[$typed.Length]) -ceq $Char
  Add-Keypress $isRight
  $script:typedWords[$i] = $typed + $Char
  Update-Word $i
  # The last word typed right ends the test: no space needed.
  if ($i -eq $WORD_COUNT - 1 -and $script:typedWords[$i] -ceq $target) { Complete-Test; return }
  Move-Caret
  Update-Progress
}

# Space ends a word; at a word's start it does nothing.
function Submit-Word {
  $i = $script:current
  $typed = $script:typedWords[$i]
  if ($typed.Length -eq 0) { return }
  Add-Keypress ($typed -ceq $script:targets[$i])
  $script:current++
  Update-Word $i
  if ($script:current -ge $WORD_COUNT) { Complete-Test; return }
  Move-Caret
  Update-Progress
}

# Backspace takes a letter; at a word's start it goes back into the word
# before, only when that word was left wrong. -Word takes the whole word.
function Remove-Letter([switch]$Word) {
  if ($script:isFinished -or -not $script:isStarted) { return }
  $i = $script:current
  if ($script:typedWords[$i].Length -eq 0) {
    if ($i -eq 0 -or $script:typedWords[$i - 1] -ceq $script:targets[$i - 1]) { return }
    $script:current--
    $i = $script:current
    if ($Word) { $script:typedWords[$i] = '' }
    Update-Word ($i + 1)
  } elseif ($Word) {
    $script:typedWords[$i] = ''
  } else {
    $script:typedWords[$i] = $script:typedWords[$i].Substring(0, $script:typedWords[$i].Length - 1)
  }
  Update-Word $i
  Stop-Blink
  $idleTimer.Stop()
  $idleTimer.Start()
  Move-Caret
  Update-Progress
}

function Complete-Test {
  $secondTimer.Stop()
  $idleTimer.Stop()
  $script:watch.Stop()
  $seconds = $script:watch.Elapsed.TotalSeconds
  # The last part-second joins the graph, scaled to a whole second.
  $part = $seconds - $script:samples.Count
  if ($part -gt 0.05 -or $script:samples.Count -eq 0) { Add-Sample ([Math]::Max(0.05, $part)) }
  $script:isFinished = $true
  $tally = [TypeStats]::Count($script:targets, $script:typedWords, $script:current, $false)
  # .ToArray() and plain loops: PowerShell 5.1's binder throws "Argument types
  # do not match" turning this List[object] into an array with @( ).
  $sampleList = $script:samples.ToArray()
  $raws = [double[]]::new($sampleList.Length)
  for ($k = 0; $k -lt $sampleList.Length; $k++) { $raws[$k] = [double]$sampleList[$k].raw }
  $acc = 0.0
  if ($script:keyCount -gt 0) { $acc = 100.0 * $script:goodKeys / $script:keyCount }
  $result = @{
    wpm = [TypeStats]::Wpm($tally, $seconds)
    raw = [TypeStats]::Raw($tally, $seconds)
    acc = $acc
    goodKeys = $script:goodKeys
    badKeys = $script:keyCount - $script:goodKeys
    chars = ('{0}/{1}/{2}/{3}' -f [int]($tally.CorrectChars + $tally.CorrectSpaces), [int]$tally.IncorrectChars, [int]$tally.ExtraChars, [int]$tally.MissedChars)
    consistency = [TypeStats]::Consistency($raws)
    seconds = $seconds
    samples = $sampleList
  }
  $result.isBest = $result.wpm -gt $script:best -and $result.acc -gt 0
  if ($result.isBest) { $script:best = $result.wpm; Save-Prefs }
  Show-Result $result
}

# --- The result screen ------------------------------------------------------------

function Add-Line($Points, $Stroke, [double]$Thickness) {
  $line = New-Object System.Windows.Shapes.Polyline
  $line.Stroke = $Stroke
  $line.StrokeThickness = $Thickness
  $line.StrokeLineJoin = 'Round'
  foreach ($p in $Points) { [void]$line.Points.Add($p) }
  [void]$graph.Children.Add($line)
}

function Add-Label([string]$Text, [double]$X, [double]$Y) {
  $label = New-Text $Text $subBrush 10
  [System.Windows.Controls.Canvas]::SetLeft($label, $X)
  [System.Windows.Controls.Canvas]::SetTop($label, $Y)
  [void]$graph.Children.Add($label)
}

# Monkeytype's graph: wpm in yellow, raw in grey, errors as red crosses, one
# point a second.
function Draw-Graph($Samples) {
  $graph.Children.Clear()
  $Samples = @($Samples)
  $n = $Samples.Count
  if ($n -eq 0) { return }
  $top = 10.0
  foreach ($s in $Samples) { $top = [Math]::Max($top, [Math]::Max([double]$s.wpm, [double]$s.raw)) }
  $step = 20.0
  if ($top -gt 120) { $step = 40.0 }
  if ($top -gt 240) { $step = 80.0 }
  $top = [Math]::Ceiling($top / $step) * $step
  $maxErrors = 1
  foreach ($s in $Samples) { $maxErrors = [Math]::Max($maxErrors, [int]$s.errors) }
  $left = 26.0
  $width = $GRAPH_W - $left
  for ($v = 0.0; $v -le $top; $v += $step) {
    $y = $GRAPH_H - ($v / $top) * $GRAPH_H
    $rule = New-Object System.Windows.Shapes.Line
    $rule.X1 = $left; $rule.X2 = $GRAPH_W; $rule.Y1 = $y; $rule.Y2 = $y
    $rule.Stroke = $gridBrush
    $rule.StrokeThickness = 1
    [void]$graph.Children.Add($rule)
    Add-Label ([string][int]$v) 0 ($y - 7)
  }
  $wpmPoints = @()
  $rawPoints = @()
  for ($k = 0; $k -lt $n; $k++) {
    $s = $Samples[$k]
    $x = $left + $width / 2
    if ($n -gt 1) { $x = $left + $width * $k / ($n - 1) }
    $wpmPoints += New-Object System.Windows.Point($x, ($GRAPH_H - ([double]$s.wpm / $top) * $GRAPH_H))
    $rawPoints += New-Object System.Windows.Point($x, ($GRAPH_H - ([double]$s.raw / $top) * $GRAPH_H))
    Add-Label ([string]($k + 1)) ($x - 3) ($GRAPH_H + 4)
    if ([int]$s.errors -gt 0) {
      $ey = $GRAPH_H - ([double]$s.errors / $maxErrors) * $GRAPH_H * 0.9
      foreach ($d in @(@(-4, -4, 4, 4), @(-4, 4, 4, -4))) {
        $cross = New-Object System.Windows.Shapes.Line
        $cross.X1 = $x + $d[0]; $cross.Y1 = $ey + $d[1]; $cross.X2 = $x + $d[2]; $cross.Y2 = $ey + $d[3]
        $cross.Stroke = $errorBrush
        $cross.StrokeThickness = 2
        [void]$graph.Children.Add($cross)
      }
    }
  }
  Add-Line $rawPoints $subBrush 2
  Add-Line $wpmPoints $mainBrush 2.5
  foreach ($p in $wpmPoints) {
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 5; $dot.Height = 5
    $dot.Fill = $mainBrush
    [System.Windows.Controls.Canvas]::SetLeft($dot, $p.X - 2.5)
    [System.Windows.Controls.Canvas]::SetTop($dot, $p.Y - 2.5)
    [void]$graph.Children.Add($dot)
  }
}

function Show-Result($Result) {
  $wpmStat.value.Text = [string][Math]::Round($Result.wpm)
  $wpmStat.value.ToolTip = ('{0:0.00} wpm' -f $Result.wpm)
  $accStat.value.Text = "$([Math]::Round($Result.acc))%"
  $accStat.value.ToolTip = ('{0:0.00}% ({1} correct / {2} incorrect)' -f $Result.acc, $Result.goodKeys, $Result.badKeys)
  $rawStat.value.Text = [string][Math]::Round($Result.raw)
  $rawStat.value.ToolTip = ('{0:0.00}' -f $Result.raw)
  $charsStat.value.Text = $Result.chars
  $consistencyStat.value.Text = "$([Math]::Round($Result.consistency))%"
  $consistencyStat.value.ToolTip = ('{0:0.00}%' -f $Result.consistency)
  $timeStat.value.Text = "$([Math]::Round($Result.seconds))s"
  $timeStat.value.ToolTip = ('{0:0.00}s' -f $Result.seconds)
  if ($Result.isBest) { $crownText.Visibility = 'Visible' } else { $crownText.Visibility = 'Collapsed' }
  Draw-Graph $Result.samples
  $caret.Visibility = 'Hidden'
  $progressText.Visibility = 'Hidden'
  $typingView.Visibility = 'Hidden'
  $resultView.Visibility = 'Visible'
}

# --- Themes ---------------------------------------------------------------------

$script:isPicking = $false
$script:themeBefore = $script:themeName
$script:swatches = @()
$script:shown = @()
$script:pickIndex = -1

function Get-ThemeTitle([string]$Name) { return $Name.Replace('_', ' ') }

function Set-Theme([string]$Name) {
  $script:themeName = $Name
  Set-Colors $Name
  $themeLabel.Text = Get-ThemeTitle $Name
}

# One swatch per theme, built the first time the picker opens: its name in the
# theme's main colour on its background, and dots of its text and sub colours.
function Build-Swatches {
  if ($script:swatches.Count -gt 0) { return }
  $built = @()
  foreach ($name in $script:themes.Keys) {
    $colors = $script:themes[$name]
    $swatch = New-Object System.Windows.Controls.Border
    $swatch.Width = $THEME_BUTTON_W
    $swatch.Height = 34
    $swatch.Margin = New-Gap 4 4 4 4
    $swatch.CornerRadius = New-Object System.Windows.CornerRadius(6)
    $swatch.Background = Brush $colors[0]
    $swatch.BorderThickness = New-Object System.Windows.Thickness(2)
    $swatch.BorderBrush = $noFill
    $swatch.Cursor = [System.Windows.Input.Cursors]::Hand
    $swatch.Tag = $built.Count
    $inside = New-Object System.Windows.Controls.DockPanel
    $inside.Margin = New-Gap 9 0 8 0
    $dots = New-Object System.Windows.Controls.StackPanel
    $dots.Orientation = 'Horizontal'
    $dots.VerticalAlignment = 'Center'
    [System.Windows.Controls.DockPanel]::SetDock($dots, 'Right')
    foreach ($index in 5, 3) {
      $dot = New-Object System.Windows.Shapes.Ellipse
      $dot.Width = 7
      $dot.Height = 7
      $dot.Margin = New-Gap 3 0 0 0
      $dot.Fill = Brush $colors[$index]
      [void]$dots.Children.Add($dot)
    }
    $title = New-Text (Get-ThemeTitle $name) (Brush $colors[1]) 12
    $title.VerticalAlignment = 'Center'
    $title.TextTrimming = 'CharacterEllipsis'
    [void]$inside.Children.Add($dots)
    [void]$inside.Children.Add($title)
    $swatch.Child = $inside
    $swatch.Add_MouseEnter({ param($sender, $e) Select-Swatch ([array]::IndexOf($script:shown, $script:swatches[[int]$sender.Tag])) })
    $swatch.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Close-Picker $true })
    [void]$themeGrid.Children.Add($swatch)
    $built += , @{ name = $name; swatch = $swatch }
  }
  $script:swatches = $built
}

# Moves the choice to the index-th shown swatch and previews its theme.
function Select-Swatch([int]$Index) {
  if ($script:shown.Count -eq 0 -or $Index -lt 0) { return }
  $Index = [Math]::Min($script:shown.Count - 1, $Index)
  if ($script:pickIndex -ge 0 -and $script:pickIndex -lt $script:shown.Count) { $script:shown[$script:pickIndex].swatch.BorderBrush = $noFill }
  $script:pickIndex = $Index
  $chosen = $script:shown[$Index]
  $chosen.swatch.BorderBrush = $textBrush
  $chosen.swatch.BringIntoView()
  Set-Colors $chosen.name
}

# Typing in the search box keeps the themes whose name has it.
function Update-Filter {
  $query = $searchBox.Text.Trim().ToLowerInvariant().Replace('_', ' ')
  if ($query) { $searchHint.Visibility = 'Hidden' } else { $searchHint.Visibility = 'Visible' }
  $kept = @()
  foreach ($entry in $script:swatches) {
    $isKept = -not $query -or (Get-ThemeTitle $entry.name).Contains($query)
    if ($isKept) { $entry.swatch.Visibility = 'Visible'; $kept += , $entry } else { $entry.swatch.Visibility = 'Collapsed' }
    $entry.swatch.BorderBrush = $noFill
  }
  $script:shown = $kept
  $script:pickIndex = -1
  if ($kept.Count -gt 0) { Select-Swatch 0 } else { Set-Colors $script:themeBefore }
}

function Open-Picker {
  if ($script:isPicking) { return }
  Build-Swatches
  $script:isPicking = $true
  $script:themeBefore = $script:themeName
  $picker.Height = [Math]::Max(240, $views.ActualHeight - 12)
  $searchBox.Text = ''
  Update-Filter
  $current = 0
  for ($k = 0; $k -lt $script:shown.Count; $k++) { if ($script:shown[$k].name -eq $script:themeName) { $current = $k; break } }
  $picker.Visibility = 'Visible'
  $caret.Visibility = 'Hidden'
  $win.UpdateLayout()
  Select-Swatch $current
  [void][System.Windows.Input.Keyboard]::Focus($searchBox)
}

# Keep the chosen theme (Enter, a click) or go back to the one before (Esc).
function Close-Picker([bool]$Keep) {
  if (-not $script:isPicking) { return }
  if ($Keep -and $script:pickIndex -ge 0 -and $script:pickIndex -lt $script:shown.Count) {
    Set-Theme $script:shown[$script:pickIndex].name
    Save-Prefs
  } else {
    Set-Theme $script:themeBefore
  }
  $script:isPicking = $false
  $picker.Visibility = 'Collapsed'
  [void]$win.Focus()
  [void][System.Windows.Input.Keyboard]::Focus($win)
  if (-not $script:isFinished) { $caret.Visibility = 'Visible'; Move-Caret -Jump }
}

# Arrows walk the swatch grid: a row is as many swatches as fit across.
function Move-Pick([int]$Columns, [int]$Rows) {
  $perRow = [Math]::Max(1, [int][Math]::Floor($themeGrid.Width / ($THEME_BUTTON_W + 8)))
  $next = $script:pickIndex + $Columns + $Rows * $perRow
  Select-Swatch ([Math]::Max(0, [Math]::Min($script:shown.Count - 1, $next)))
}

$searchBox.Add_TextChanged({ if ($script:isPicking) { Update-Filter } })
$themeButton.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
$themeButton.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; if ($script:isPicking) { Close-Picker $false } else { Open-Picker } })

# --- Keys and clicks ------------------------------------------------------------

# A failure inside a key handler is written to %TEMP%\typetest-error.log, so
# a broken step shows up somewhere instead of silently eating the result.
function Write-Failure($Failure) {
  try {
    $text = "$([DateTime]::Now.ToString('s')) $($Failure.Exception.Message)`n$($Failure.ScriptStackTrace)`n"
    Add-Content -Path (Join-Path $env:TEMP 'typetest-error.log') -Value $text -Encoding ASCII
  } catch {}
}

# Letters arrive as text, so Shift and the keyboard layout are the system's.
$win.Add_PreviewTextInput({
  param($sender, $e)
  # While the picker is open, letters go to its search box.
  if ($script:isPicking) { return }
  $e.Handled = $true
  try {
    foreach ($ch in $e.Text.ToCharArray()) {
      if ([int]$ch -lt 32 -or [int]$ch -eq 127) { continue }
      Add-Letter ([string]$ch)
    }
  } catch { Write-Failure $_ }
})

$win.Add_PreviewKeyDown({
  param($sender, $e)
  $name = [string]$e.Key
  try {
    if ($script:isPicking) {
      switch ($name) {
        'Escape' { Close-Picker $false }
        'Return' { Close-Picker $true }
        'Enter' { Close-Picker $true }
        'Left' { Move-Pick -1 0 }
        'Right' { Move-Pick 1 0 }
        'Up' { Move-Pick 0 -1 }
        'Down' { Move-Pick 0 1 }
        'Tab' { }
        default { return }
      }
      $e.Handled = $true
      return
    }
    if ($name -eq 'Escape') { $e.Handled = $true; Open-Picker; return }
    if ($name -eq 'Tab') { $e.Handled = $true; New-Test; return }
    if ($name -eq 'Back') {
      $e.Handled = $true
      $isCtrl = (([int][System.Windows.Input.Keyboard]::Modifiers) -band 2) -ne 0
      Remove-Letter -Word:$isCtrl
    }
  } catch { Write-Failure $_ }
})

# Out of focus, the words blur and say how to come back, as Monkeytype's do.
$win.Add_Deactivated({
  if ($script:isFinished) { return }
  $veil = New-Object System.Windows.Media.Effects.BlurEffect
  $veil.Radius = 6
  $wordsPanel.Effect = $veil
  $caret.Visibility = 'Hidden'
  $focusVeil.Visibility = 'Visible'
})
$win.Add_Activated({
  $wordsPanel.Effect = $null
  $focusVeil.Visibility = 'Collapsed'
  if (-not $script:isFinished -and -not $script:isPicking) { $caret.Visibility = 'Visible'; Move-Caret -Jump }
})

$closeText.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
$closeText.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $win.Close() })

# --- Placement: over the WezTerm window, where the person last dragged it -------

$script:me = [IntPtr]::Zero
$script:lastOwner = $null
$script:dragging = $false
$script:resizing = $false
$script:resizeStart = $null

function Get-Rect([IntPtr]$Hwnd) {
  $r = New-Object TypeWin32+RECT
  [void][TypeWin32]::GetWindowRect($Hwnd, [ref]$r)
  return $r
}

function Get-Cursor {
  $cursor = New-Object TypeWin32+POINT
  [void][TypeWin32]::GetCursorPos([ref]$cursor)
  return $cursor
}

function Set-Place {
  if (-not $hasOwner -or $script:me -eq [IntPtr]::Zero) { return }
  $own = Get-Rect $owner
  $mine = Get-Rect $script:me
  $w = $mine.Right - $mine.Left
  $h = $mine.Bottom - $mine.Top
  if ($script:offset) {
    $x = $own.Left + $script:offset.dx
    $y = $own.Top + $script:offset.dy
  } else {
    $x = $own.Left + [int](($own.Right - $own.Left - $w) / 2)
    $y = $own.Top + [int](($own.Bottom - $own.Top - $h) / 2)
  }
  $x = [Math]::Max($own.Left, [Math]::Min($x, $own.Right - $w))
  $y = [Math]::Max($own.Top, [Math]::Min($y, $own.Bottom - $h))
  # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
  [void][TypeWin32]::SetWindowPos($script:me, [IntPtr]::Zero, $x, $y, 0, 0, 0x15)
}

$header.Add_MouseLeftButtonDown({
  param($sender, $e)
  $script:dragging = $true
  try { $win.DragMove() } catch {}
  $script:dragging = $false
  if ($hasOwner) {
    $own = Get-Rect $owner
    $mine = Get-Rect $script:me
    $script:offset = @{ dx = $mine.Left - $own.Left; dy = $mine.Top - $own.Top }
    Save-Prefs
  }
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
  $grow = (($cursor.X - $start.cx) + ($cursor.Y - $start.cy)) / 2
  $next = $start.scale * ($start.width + $grow) / $start.width
  $script:scale = [Math]::Max([double]$MIN_SCALE, [Math]::Min([double]$MAX_SCALE, [double]$next))
  $cardScale.ScaleX = $script:scale
  $cardScale.ScaleY = $script:scale
})

$grip.Add_MouseLeftButtonUp({
  param($sender, $e)
  if (-not $script:resizing) { return }
  $e.Handled = $true
  $script:resizing = $false
  $grip.ReleaseMouseCapture()
  Save-Prefs
  Move-Caret -Jump
})

$win.Add_SourceInitialized({
  $script:me = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
  if ($hasOwner) {
    # WS_EX_TOOLWINDOW: no Alt-Tab entry; the owner stands for it.
    $style = [TypeWin32]::GetWindowLong($script:me, -20)
    [void][TypeWin32]::SetWindowLong($script:me, -20, ($style -bor 0x80))
  }
})

# --- Snapshot: a test halfway, or a result, drawn to a PNG ---------------------------

function Show-Demo {
  if ($SnapshotTheme) { Set-Theme $SnapshotTheme }
  if ($SnapshotView -eq 'themes') {
    Open-Picker
    if ($SnapshotTheme) { $searchBox.Text = (Get-ThemeTitle $SnapshotTheme).Split(' ')[0] }
    return
  }
  # 'played': a whole test typed through the real input path, then its result.
  if ($SnapshotView -eq 'played') {
    for ($i = 0; $i -lt $WORD_COUNT; $i++) {
      foreach ($ch in $script:targets[$i].ToCharArray()) { Add-Letter ([string]$ch); Start-Sleep -Milliseconds 40 }
      if ($i -lt $WORD_COUNT - 1) { Add-Letter ' ' }
    }
    return
  }
  $script:targets = [string[]]@('the', 'world', 'house', 'between', 'point', 'early', 'program', 'hand', 'leave', 'system')
  $script:typedWords = [string[]]@('the', 'wrold', 'house', 'betw', '', '', '', '', '', '')
  $script:current = 3
  $script:isStarted = $true
  Build-Words
  Update-Progress
  Move-Caret -Jump
  if ($SnapshotView -eq 'result') {
    $demoSamples = @(
      @{ wpm = 84; raw = 96; errors = 0 }, @{ wpm = 98; raw = 108; errors = 1 }, @{ wpm = 104; raw = 112; errors = 0 },
      @{ wpm = 101; raw = 96; errors = 2 }, @{ wpm = 107; raw = 120; errors = 0 }, @{ wpm = 109; raw = 114; errors = 0 })
    Show-Result @{ wpm = 109.4; raw = 113.6; acc = 96.2; goodKeys = 51; badKeys = 2; chars = '56/1/0/0'; consistency = 81.3
      seconds = 5.87; samples = $demoSamples; isBest = $true }
  }
}

function Save-Snapshot {
  try { Show-Demo } catch { [Console]::Error.WriteLine("snapshot failed: $($_.Exception.Message)`n$($_.ScriptStackTrace)") }
  $win.UpdateLayout()
  Move-Caret -Jump
  $win.UpdateLayout()
  $dpi = 96.0
  if ($script:me -ne [IntPtr]::Zero) { $dpi = [double][TypeWin32]::GetDpiForWindow($script:me) }
  $width = [int][Math]::Ceiling($cardHost.ActualWidth * $dpi / 96.0)
  $height = [int][Math]::Ceiling($cardHost.ActualHeight * $dpi / 96.0)
  $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($width, $height, $dpi, $dpi, [System.Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($cardHost)
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $file = [System.IO.File]::Create($SnapshotPath)
  try { $encoder.Save($file) } finally { $file.Dispose() }
}

# --- Life ---------------------------------------------------------------------

$win.Add_ContentRendered({
  if ($SnapshotPath) { Save-Snapshot; $win.Close(); return }
  $script:lastOwner = if ($hasOwner) { Get-Rect $owner } else { $null }
  Set-Place
  [void]$win.Activate()
  [void]$win.Focus()
  Move-Caret -Jump
  Send-Event @{ event = 'ready' }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
  if (-not $hasOwner) { return }
  if (-not [TypeWin32]::IsWindow($owner)) { $win.Close(); return }
  if ($script:dragging -or $script:resizing -or [TypeWin32]::IsIconic($owner)) { return }
  $now = Get-Rect $owner
  $was = $script:lastOwner
  if ($null -eq $was -or $now.Left -ne $was.Left -or $now.Top -ne $was.Top -or $now.Right -ne $was.Right -or $now.Bottom -ne $was.Bottom) {
    $script:lastOwner = $now
    Set-Place
  }
})

Set-Theme $script:themeName
New-Test

if ($hasOwner) {
  $owned = New-Object System.Windows.Interop.WindowInteropHelper($win)
  $owned.Owner = $owner
}
if ($SnapshotPath) {
  $win.WindowStartupLocation = 'Manual'
  $win.Left = -32000
  $win.Top = -32000
  $win.ShowActivated = $false
  $win.ShowInTaskbar = $false
}
$timer.Start()
$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnMainWindowClose'
[void]$app.Run($win)
$timer.Stop()
try { $mutex.ReleaseMutex() } catch {}
exit 0
