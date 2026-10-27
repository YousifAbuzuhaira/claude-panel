#Requires -Version 5.1
# Sudoku, opened from the progress panel's header button.
#
# Its own process, so a game outlives the panel. Owned by the chat's WezTerm
# window (-OwnerHwnd): it sits above that window, hides when it minimizes and
# goes when it closes. Unlike the panel it takes keyboard focus. Three sizes
# are the three difficulties: 4x4, 6x6, 9x9. Every puzzle has exactly one
# solution and is solved by plain deduction (naked and hidden singles), so no
# answer ever needs a guess: a wrong digit costs a life, three lives lost
# starts a fresh puzzle.
#
# PowerShell names ignore case: the board size lives in $script:n and no local
# may reuse a parameter's name ($size, $count, $seed...). Kept to ASCII:
# Windows PowerShell reads a .ps1 without a BOM as ANSI, so every non-ASCII
# glyph is built from its code point as $GLYPH_*.

param(
  [int64]$OwnerHwnd = 0,
  [string]$SessionId = 'default',
  [ValidateSet(0, 4, 6, 9)][int]$Size = 0,
  [int]$Seed = 0,
  # Testing aids: check the generator, play the rules through, or draw the
  # window to a PNG; each exits when done.
  [switch]$SelfTest,
  [int]$Count = 10,
  [switch]$PlayTest,
  [string]$SnapshotPath = '',
  [switch]$SnapshotDemo
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
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class SudokuWin32 {
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

public sealed class SudokuPuzzle {
  public int[] Givens;
  public int[] Solution;
  public int Clues;
  public long Ms;
}

// Grids are flat int[n*n], 0 for empty; boxes are boxRows x boxCols.
public static class SudokuGen {
  sealed class Board {
    public int N, BoxRows, BoxCols, Full;
    public int[] Cells, Rows, Cols, Boxes;
    public Random Rng;
  }

  static int BoxOf(Board b, int i) {
    int r = i / b.N, c = i % b.N;
    return (r / b.BoxRows) * (b.N / b.BoxCols) + c / b.BoxCols;
  }

  static int Bits(int mask) { int k = 0; while (mask != 0) { mask &= mask - 1; k++; } return k; }

  static Board Load(int[] grid, int n, int boxRows, int boxCols) {
    var b = new Board();
    b.N = n; b.BoxRows = boxRows; b.BoxCols = boxCols;
    b.Full = ((1 << (n + 1)) - 1) & ~1;
    b.Cells = (int[])grid.Clone();
    b.Rows = new int[n]; b.Cols = new int[n]; b.Boxes = new int[n];
    for (int i = 0; i < n * n; i++) {
      int d = b.Cells[i];
      if (d == 0) continue;
      if (d < 1 || d > n || !CanPlace(b, i, d)) return null;
      Place(b, i, d);
    }
    return b;
  }

  static bool CanPlace(Board b, int i, int d) {
    int bit = 1 << d;
    return ((b.Rows[i / b.N] | b.Cols[i % b.N] | b.Boxes[BoxOf(b, i)]) & bit) == 0;
  }

  static void Place(Board b, int i, int d) {
    int bit = 1 << d;
    b.Cells[i] = d; b.Rows[i / b.N] |= bit; b.Cols[i % b.N] |= bit; b.Boxes[BoxOf(b, i)] |= bit;
  }

  static void Unplace(Board b, int i) {
    int bit = ~(1 << b.Cells[i]);
    b.Rows[i / b.N] &= bit; b.Cols[i % b.N] &= bit; b.Boxes[BoxOf(b, i)] &= bit; b.Cells[i] = 0;
  }

  static int Free(Board b, int i) {
    return b.Full & ~(b.Rows[i / b.N] | b.Cols[i % b.N] | b.Boxes[BoxOf(b, i)]);
  }

  // Backtracking on the most constrained cell. Counts solutions up to limit;
  // with keepFirst the first solution is left in the board.
  static int Search(Board b, int limit, bool keepFirst) {
    int n = b.N, best = -1, bestFree = 0, bestBits = n + 1;
    for (int i = 0; i < n * n; i++) {
      if (b.Cells[i] != 0) continue;
      int free = Free(b, i);
      int k = Bits(free);
      if (k == 0) return 0;
      if (k < bestBits) { best = i; bestFree = free; bestBits = k; if (k == 1) break; }
    }
    if (best < 0) return 1;

    var digits = new List<int>();
    for (int d = 1; d <= n; d++) if ((bestFree & (1 << d)) != 0) digits.Add(d);
    if (b.Rng != null) {
      for (int k = digits.Count - 1; k > 0; k--) { int j = b.Rng.Next(k + 1); int t = digits[k]; digits[k] = digits[j]; digits[j] = t; }
    }

    int total = 0;
    foreach (int d in digits) {
      Place(b, best, d);
      total += Search(b, limit - total, keepFirst);
      if (total >= limit && keepFirst) return total;
      Unplace(b, best);
      if (total >= limit) return total;
    }
    return total;
  }

  public static int CountSolutions(int[] grid, int n, int boxRows, int boxCols, int limit) {
    var b = Load(grid, n, boxRows, boxCols);
    return b == null ? 0 : Search(b, limit, false);
  }

  static int[][] Units(int n, int boxRows, int boxCols) {
    var units = new int[3 * n][];
    for (int u = 0; u < n; u++) {
      units[u] = new int[n]; units[n + u] = new int[n]; units[2 * n + u] = new int[n];
      int top = (u / (n / boxCols)) * boxRows, left = (u % (n / boxCols)) * boxCols;
      for (int k = 0; k < n; k++) {
        units[u][k] = u * n + k;
        units[n + u][k] = k * n + u;
        units[2 * n + u][k] = (top + k / boxCols) * n + left + k % boxCols;
      }
    }
    return units;
  }

  // True when naked and hidden singles alone fill the grid: every step is
  // forced, so the solution is unique and a person never has to guess.
  public static bool SolvesBySingles(int[] grid, int n, int boxRows, int boxCols) {
    var b = Load(grid, n, boxRows, boxCols);
    if (b == null) return false;
    var units = Units(n, boxRows, boxCols);
    bool moved = true;
    while (moved) {
      moved = false;
      for (int i = 0; i < n * n; i++) {
        if (b.Cells[i] != 0) continue;
        int free = Free(b, i);
        if (free == 0) return false;
        if (Bits(free) == 1) { int d = 1; while ((free & (1 << d)) == 0) d++; Place(b, i, d); moved = true; }
      }
      foreach (var unit in units) {
        for (int d = 1; d <= n; d++) {
          int at = -1, places = 0;
          bool isPlaced = false;
          foreach (int i in unit) {
            if (b.Cells[i] == d) { isPlaced = true; break; }
            if (b.Cells[i] == 0 && (Free(b, i) & (1 << d)) != 0) { at = i; places++; }
          }
          if (isPlaced) continue;
          if (places == 0) return false;
          if (places == 1) { Place(b, at, d); moved = true; }
        }
      }
    }
    for (int i = 0; i < n * n; i++) if (b.Cells[i] == 0) return false;
    return true;
  }

  public static bool IsValidSolution(int[] grid, int n, int boxRows, int boxCols) {
    if (grid.Length != n * n) return false;
    foreach (int d in grid) if (d < 1 || d > n) return false;
    return Load(grid, n, boxRows, boxCols) != null;
  }

  public static bool GivensMatch(int[] givens, int[] solution) {
    for (int i = 0; i < givens.Length; i++) if (givens[i] != 0 && givens[i] != solution[i]) return false;
    return true;
  }

  // A full random grid, then givens taken away in random order while the
  // puzzle still solves by singles. Out of time only leaves more givens.
  public static SudokuPuzzle Generate(int n, int boxRows, int boxCols, int targetClues, int seed, int budgetMs) {
    var watch = Stopwatch.StartNew();
    var rng = seed == 0 ? new Random(Guid.NewGuid().GetHashCode()) : new Random(seed);
    var b = Load(new int[n * n], n, boxRows, boxCols);
    b.Rng = rng;
    Search(b, 1, true);

    var puzzle = new SudokuPuzzle();
    puzzle.Solution = (int[])b.Cells.Clone();
    puzzle.Givens = (int[])b.Cells.Clone();
    var order = new int[n * n];
    for (int i = 0; i < order.Length; i++) order[i] = i;
    for (int k = order.Length - 1; k > 0; k--) { int j = rng.Next(k + 1); int t = order[k]; order[k] = order[j]; order[j] = t; }

    int clues = n * n;
    foreach (int i in order) {
      if (clues <= targetClues || watch.ElapsedMilliseconds > budgetMs) break;
      int kept = puzzle.Givens[i];
      puzzle.Givens[i] = 0;
      if (SolvesBySingles(puzzle.Givens, n, boxRows, boxCols)) clues--;
      else puzzle.Givens[i] = kept;
    }
    puzzle.Clues = clues;
    puzzle.Ms = watch.ElapsedMilliseconds;
    return puzzle;
  }
}
'@

# Box shape (rows, cols) and how many givens each size aims for.
$SHAPES = @{ 4 = @(2, 2); 6 = @(2, 3); 9 = @(3, 3) }
$CLUES = @{ 4 = 6; 6 = 14; 9 = 30 }
$BUDGET_MS = 1500
$MAX_LIVES = 3

function New-Puzzle([int]$Side, [int]$PuzzleSeed) {
  $shape = $SHAPES[$Side]
  return [SudokuGen]::Generate($Side, $shape[0], $shape[1], $CLUES[$Side], $PuzzleSeed, $BUDGET_MS)
}

# --- Self-test: every puzzle unique, consistent and solvable without guessing --

if ($SelfTest) {
  $allOk = $true
  foreach ($side in 4, 6, 9) {
    $shape = $SHAPES[$side]
    $unique = 0; $valid = 0; $logical = 0; $maxMs = 0; $totalMs = 0; $maxClues = 0; $minClues = $side * $side
    for ($i = 0; $i -lt $Count; $i++) {
      $puzzleSeed = 0
      if ($Seed -ne 0) { $puzzleSeed = $Seed + $i }
      $p = New-Puzzle $side $puzzleSeed
      if ([SudokuGen]::CountSolutions($p.Givens, $side, $shape[0], $shape[1], 2) -eq 1) { $unique++ }
      if ([SudokuGen]::IsValidSolution($p.Solution, $side, $shape[0], $shape[1]) -and [SudokuGen]::GivensMatch($p.Givens, $p.Solution)) { $valid++ }
      if ([SudokuGen]::SolvesBySingles($p.Givens, $side, $shape[0], $shape[1])) { $logical++ }
      $totalMs += $p.Ms
      $maxMs = [Math]::Max($maxMs, [int]$p.Ms)
      $maxClues = [Math]::Max($maxClues, $p.Clues)
      $minClues = [Math]::Min($minClues, $p.Clues)
    }
    $ok = $unique -eq $Count -and $valid -eq $Count -and $logical -eq $Count
    if (-not $ok) { $allOk = $false }
    Send-Event @{ event = 'selftest'; size = $side; count = $Count; unique = $unique; valid = $valid; logical = $logical
      avgMs = [Math]::Round($totalMs / [double]$Count, 1); maxMs = $maxMs; minClues = $minClues; maxClues = $maxClues; ok = $ok }
  }
  Send-Event @{ event = 'selftest'; ok = $allOk }
  if ($allOk) { exit 0 } else { exit 1 }
}

# --- One game per chat ----------------------------------------------------------

[void][SudokuWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$WINDOW_TITLE = "ClaudeSudoku:$SessionId"
$mutex = New-Object System.Threading.Mutex($false, "Local\ClaudeSudoku-$SessionId")
try {
  $isOwner = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $isOwner = $true
}
if (-not $isOwner -and -not $SnapshotPath -and -not $PlayTest) {
  $existing = [SudokuWin32]::WindowByText($WINDOW_TITLE)
  if ($existing -ne [IntPtr]::Zero) { [void][SudokuWin32]::SetForegroundWindow($existing) }
  exit 0
}

$owner = [IntPtr]$OwnerHwnd
$hasOwner = $owner -ne [IntPtr]::Zero -and [SudokuWin32]::IsWindow($owner)

$GLYPH_HEART = [string][char]0x2665
$GLYPH_CLOSE = [string][char]0x2715
$GLYPH_ERASE = [string][char]0x232B
$GLYPH_DOT = [string][char]0x00B7
$GLYPH_DASH = [string][char]0x2014
$GLYPH_GRIP = [string][char]0x25E2
$MIN_SCALE = 0.7
$MAX_SCALE = 2.5

# --- What the person left it as: where, how big, which size, and the game ----------

$prefsFile = Join-Path $env:LOCALAPPDATA 'ClaudePhases\sudoku.json'
$script:offset = $null
$script:scale = 1.0
$startSide = 9
$savedGame = $null
try {
  if (Test-Path $prefsFile) {
    $saved = Get-Content $prefsFile -Raw | ConvertFrom-Json
    if ($null -ne $saved.dx) { $script:offset = @{ dx = [int]$saved.dx; dy = [int]$saved.dy } }
    if ($SHAPES.ContainsKey([int]$saved.size)) { $startSide = [int]$saved.size }
    if ($saved.scale) { $script:scale = [Math]::Max([double]$MIN_SCALE, [Math]::Min([double]$MAX_SCALE, [double]$saved.scale)) }
    if ($saved.game) { $savedGame = $saved.game }
  }
} catch {}
if ($Size -ne 0) { $startSide = $Size }

function Save-Prefs {
  # Test runs leave the person's choices alone.
  if ($SnapshotPath -or $PlayTest) { return }
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $prefsFile) | Out-Null
    $prefs = @{ size = $script:n; scale = [Math]::Round($script:scale, 3) }
    if ($script:offset) { $prefs.dx = $script:offset.dx; $prefs.dy = $script:offset.dy }
    # The game in play is kept, as 2048 keeps its game; a solved one is not,
    # so the next window starts a fresh puzzle.
    if (-not $script:isSolved -and $script:solution.Length -gt 0) {
      $prefs.game = @{
        size = $script:n; solution = $script:solution; values = $script:values; given = $script:given
        wrong = $script:wrong; notes = $script:notes; lives = $script:lives; mode = $script:mode
      }
    }
    $prefs | ConvertTo-Json -Compress -Depth 4 | Set-Content -Path $prefsFile -Encoding ASCII
  } catch {}
}

# --- The window ---------------------------------------------------------------

function Brush([string]$Hex) { return [System.Windows.Media.BrushConverter]::new().ConvertFromString($Hex) }
$ink = Brush '#E8E6E3'
$dim = Brush '#8B8A88'
$green = Brush '#5FB98A'
$red = Brush '#E0696B'
$accent = Brush '#E08A5F'
$thinLine = Brush '#26FFFFFF'
$boxLine = Brush '#73FFFFFF'
$selectedFill = Brush '#4DE08A5F'
$noteSelectFill = Brush '#5C5C8FCC'
$peerFill = Brush '#12FFFFFF'
$sameFill = Brush '#26E08A5F'
$noFill = [System.Windows.Media.Brushes]::Transparent
$font = New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas')

# Cell px, value and note font size, by board size.
$LOOKS = @{
  4 = @{ cell = 58; value = 24; note = 12 }
  6 = @{ cell = 48; value = 21; note = 10 }
  9 = @{ cell = 38; value = 18; note = 9 }
}

function New-Text([string]$Text, $Foreground) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.Foreground = $Foreground
  return $block
}

function New-Gap([double]$Left, [double]$Top, [double]$Right, [double]$Bottom) {
  return New-Object System.Windows.Thickness($Left, $Top, $Right, $Bottom)
}

# A piece of text that acts as a button: it never takes focus, so the keys keep
# going to the window.
function New-Pressable([string]$Text, $Tag) {
  $block = New-Text $Text $dim
  $block.Tag = $Tag
  $block.Cursor = [System.Windows.Input.Cursors]::Hand
  $block.Padding = New-Gap 4 2 4 2
  return $block
}

$win = New-Object System.Windows.Window
$win.Title = $WINDOW_TITLE
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.ShowInTaskbar = -not $hasOwner
$win.ResizeMode = 'NoResize'
$win.SizeToContent = 'WidthAndHeight'
$win.FontFamily = $font
$win.FontSize = 12
if ($hasOwner) {
  $win.Left = -32000
  $win.Top = -32000
} else {
  $win.WindowStartupLocation = 'CenterScreen'
}

$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius(10)
$card.Background = Brush '#F21C1D20'
$card.BorderBrush = Brush '#33FFFFFF'
$card.BorderThickness = New-Object System.Windows.Thickness(1)
$card.Padding = New-Gap 14 10 14 12

# Header: the title, the lives, the close mark. Dragging it moves the window.
$header = New-Object System.Windows.Controls.DockPanel
$header.Cursor = [System.Windows.Input.Cursors]::SizeAll
$header.Background = $noFill
$titleText = New-Text '' $ink
$titleText.FontWeight = 'Bold'
[System.Windows.Controls.DockPanel]::SetDock($titleText, 'Left')
$closeText = New-Text $GLYPH_CLOSE $dim
$closeText.Margin = New-Gap 12 0 0 0
$closeText.Cursor = [System.Windows.Input.Cursors]::Hand
[System.Windows.Controls.DockPanel]::SetDock($closeText, 'Right')
$heartsText = New-Object System.Windows.Controls.TextBlock
$heartsText.FontSize = 14
$heartsText.HorizontalAlignment = 'Right'
$heartsText.ToolTip = 'Lives: a wrong answer costs one'
[void]$header.Children.Add($titleText)
[void]$header.Children.Add($closeText)
[void]$header.Children.Add($heartsText)

$rule = New-Object System.Windows.Controls.Border
$rule.Height = 1
$rule.Background = Brush '#26FFFFFF'
$rule.Margin = New-Gap 0 8 0 10

# The board sits in a frame that draws its outer edge.
$boardFrame = New-Object System.Windows.Controls.Border
$boardFrame.BorderBrush = $boxLine
$boardFrame.BorderThickness = New-Object System.Windows.Thickness(2)
$boardFrame.HorizontalAlignment = 'Center'

$statusText = New-Text '' $dim
$statusText.Margin = New-Gap 0 8 0 0
$statusText.HorizontalAlignment = 'Center'

$pad = New-Object System.Windows.Controls.StackPanel
$pad.Orientation = 'Horizontal'
$pad.HorizontalAlignment = 'Center'
$pad.Margin = New-Gap 0 8 0 0

# Controls: the mode, a new puzzle, the size.
$controls = New-Object System.Windows.Controls.DockPanel
$controls.Margin = New-Gap 0 10 0 0
$modes = New-Object System.Windows.Controls.StackPanel
$modes.Orientation = 'Horizontal'
[System.Windows.Controls.DockPanel]::SetDock($modes, 'Left')
$answerMode = New-Pressable 'Answer' 'answer'
$answerMode.ToolTip = 'Answer mode (Space switches; hold Shift or Ctrl to note)'
$notesMode = New-Pressable 'Notes' 'notes'
$notesMode.ToolTip = 'Notes mode (Space switches; hold Shift or Ctrl to answer)'
[void]$modes.Children.Add($answerMode)
[void]$modes.Children.Add($notesMode)
$sizes = New-Object System.Windows.Controls.StackPanel
$sizes.Orientation = 'Horizontal'
[System.Windows.Controls.DockPanel]::SetDock($sizes, 'Right')
$sizeButtons = @{}
foreach ($side in 4, 6, 9) {
  $button = New-Pressable "${side}x$side" $side
  $button.ToolTip = @{ 4 = 'Easy'; 6 = 'Medium'; 9 = 'Hard' }[$side]
  $sizeButtons[$side] = $button
  [void]$sizes.Children.Add($button)
}
$newButton = New-Pressable 'New' 'new'
$newButton.HorizontalAlignment = 'Center'
$newButton.ToolTip = 'A fresh puzzle'
[void]$controls.Children.Add($modes)
[void]$controls.Children.Add($sizes)
[void]$controls.Children.Add($newButton)

$stack = New-Object System.Windows.Controls.StackPanel
[void]$stack.Children.Add($header)
[void]$stack.Children.Add($rule)
[void]$stack.Children.Add($boardFrame)
[void]$stack.Children.Add($statusText)
[void]$stack.Children.Add($pad)
[void]$stack.Children.Add($controls)
$card.Child = $stack
$cardScale = New-Object System.Windows.Media.ScaleTransform($script:scale, $script:scale)
$card.LayoutTransform = $cardScale

# The resize grip, bottom-right: the window is pinned by its top-left corner,
# so pulling the grip out (right or down) grows it.
$grip = New-Text $GLYPH_GRIP $dim
$grip.FontSize = 11
$grip.Margin = New-Gap 0 0 7 5
$grip.HorizontalAlignment = 'Right'
$grip.VerticalAlignment = 'Bottom'
$grip.Cursor = [System.Windows.Input.Cursors]::SizeNWSE
$grip.ToolTip = 'Drag to resize'

$cardHost = New-Object System.Windows.Controls.Grid
[void]$cardHost.Children.Add($card)
[void]$cardHost.Children.Add($grip)
$win.Content = $cardHost

# --- The game -----------------------------------------------------------------

$script:n = 0
$script:boxRows = 0
$script:boxCols = 0
$script:values = @()
$script:solution = @()
$script:given = @()
$script:wrong = @()
$script:notes = @()
$script:selected = -1
$script:picked = New-Object System.Collections.Generic.List[int]
$script:history = New-Object System.Collections.Generic.List[object]
$script:dragSelecting = $false
$script:lives = $MAX_LIVES
$script:mode = 'answer'
$script:isSolved = $false
$script:status = ''
$script:statusBrush = $dim
$script:cells = @()
$script:padButtons = @()
$UNDO_KEPT = 200

function Get-Row([int]$Index) { return [int][Math]::Floor($Index / $script:n) }

# Every cell sharing a row, a column or a box with this one, itself included.
function Get-Peers([int]$Index) {
  $side = $script:n
  $r = Get-Row $Index
  $c = $Index % $side
  $top = $r - ($r % $script:boxRows)
  $left = $c - ($c % $script:boxCols)
  $peers = New-Object System.Collections.Generic.HashSet[int]
  for ($k = 0; $k -lt $side; $k++) {
    [void]$peers.Add($r * $side + $k)
    [void]$peers.Add($k * $side + $c)
  }
  for ($dr = 0; $dr -lt $script:boxRows; $dr++) {
    for ($dc = 0; $dc -lt $script:boxCols; $dc++) { [void]$peers.Add(($top + $dr) * $side + $left + $dc) }
  }
  return , $peers
}

# The selected squares. $script:selected is the one picked last: the arrows
# move from it and an answer goes into it.
function Select-Only([int]$Index) {
  $script:picked.Clear()
  if ($Index -ge 0) { $script:picked.Add($Index) }
  $script:selected = $Index
}

function Select-Add([int]$Index) {
  if (-not $script:picked.Contains($Index)) { $script:picked.Add($Index) }
  $script:selected = $Index
}

function Select-Toggle([int]$Index) {
  if ($script:picked.Contains($Index) -and $script:picked.Count -gt 1) {
    [void]$script:picked.Remove($Index)
    $script:selected = $script:picked[$script:picked.Count - 1]
  } else {
    Select-Add $Index
  }
}

# Shift or Ctrl held: a digit goes the other way, note for answer or answer for note.
function Test-NoteKey { return (([int][System.Windows.Input.Keyboard]::Modifiers) -band 6) -ne 0 }

function Build-Board {
  $side = $script:n
  $look = $LOOKS[$side]
  $grid = New-Object System.Windows.Controls.Grid
  for ($k = 0; $k -lt $side; $k++) {
    $row = New-Object System.Windows.Controls.RowDefinition
    $row.Height = New-Object System.Windows.GridLength($look.cell)
    [void]$grid.RowDefinitions.Add($row)
    $col = New-Object System.Windows.Controls.ColumnDefinition
    $col.Width = New-Object System.Windows.GridLength($look.cell)
    [void]$grid.ColumnDefinitions.Add($col)
  }

  $cells = @()
  for ($i = 0; $i -lt $side * $side; $i++) {
    $r = Get-Row $i
    $c = $i % $side
    # Each cell draws its own thin top and left line; the boxes draw over them.
    $cell = New-Object System.Windows.Controls.Border
    $cell.BorderThickness = New-Gap ([int]($c -gt 0)) ([int]($r -gt 0)) 0 0
    $cell.BorderBrush = $thinLine
    $cell.Background = $noFill
    $cell.Cursor = [System.Windows.Input.Cursors]::Hand
    $cell.Tag = $i

    $inside = New-Object System.Windows.Controls.Grid
    $noteGrid = New-Object System.Windows.Controls.Primitives.UniformGrid
    $noteGrid.Rows = $script:boxRows
    $noteGrid.Columns = $script:boxCols
    $noteGrid.Margin = New-Gap 2 1 2 1
    $noteTexts = @()
    for ($d = 1; $d -le $side; $d++) {
      $note = New-Text '' $dim
      $note.FontSize = $look.note
      $note.HorizontalAlignment = 'Center'
      $note.VerticalAlignment = 'Center'
      [void]$noteGrid.Children.Add($note)
      $noteTexts += $note
    }
    $value = New-Text '' $ink
    $value.FontSize = $look.value
    $value.HorizontalAlignment = 'Center'
    $value.VerticalAlignment = 'Center'
    [void]$inside.Children.Add($noteGrid)
    [void]$inside.Children.Add($value)
    $cell.Child = $inside
    $cell.Add_MouseLeftButtonDown({
      param($sender, $e)
      $e.Handled = $true
      $index = [int]$sender.Tag
      $mods = [int][System.Windows.Input.Keyboard]::Modifiers
      if ($mods -band 2) { Select-Toggle $index }
      elseif ($mods -band 4) { Select-Add $index }
      else { Select-Only $index }
      $script:dragSelecting = $true
      Update-Board
    })
    $cell.Add_MouseEnter({
      param($sender, $e)
      if (-not $script:dragSelecting) { return }
      if ($e.LeftButton -ne [System.Windows.Input.MouseButtonState]::Pressed) { $script:dragSelecting = $false; return }
      Select-Add ([int]$sender.Tag)
      Update-Board
    })

    [System.Windows.Controls.Grid]::SetRow($cell, $r)
    [System.Windows.Controls.Grid]::SetColumn($cell, $c)
    [void]$grid.Children.Add($cell)
    $cells += , @{ border = $cell; value = $value; noteGrid = $noteGrid; notes = $noteTexts }
  }
  # The box lines, thick, on top of the cells; the frame draws the outer edge.
  for ($boxRow = 0; $boxRow -lt $side / $script:boxRows; $boxRow++) {
    for ($boxCol = 0; $boxCol -lt $side / $script:boxCols; $boxCol++) {
      $box = New-Object System.Windows.Controls.Border
      $box.BorderBrush = $boxLine
      $box.BorderThickness = New-Gap (2 * [int]($boxCol -gt 0)) (2 * [int]($boxRow -gt 0)) 0 0
      $box.IsHitTestVisible = $false
      [System.Windows.Controls.Grid]::SetRow($box, $boxRow * $script:boxRows)
      [System.Windows.Controls.Grid]::SetColumn($box, $boxCol * $script:boxCols)
      [System.Windows.Controls.Grid]::SetRowSpan($box, $script:boxRows)
      [System.Windows.Controls.Grid]::SetColumnSpan($box, $script:boxCols)
      [void]$grid.Children.Add($box)
    }
  }
  $script:cells = $cells
  $boardFrame.Child = $grid

  $pad.Children.Clear()
  $buttons = @()
  for ($d = 1; $d -le $side; $d++) {
    $button = New-Pressable ([string]$d) $d
    $button.FontSize = 16
    $button.Padding = New-Gap 7 2 7 2
    $button.Foreground = $ink
    $button.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Enter-Digit ([int]$sender.Tag) -Flip:(Test-NoteKey) })
    [void]$pad.Children.Add($button)
    $buttons += $button
  }
  $erase = New-Pressable $GLYPH_ERASE 'erase'
  $erase.FontSize = 16
  $erase.Padding = New-Gap 9 2 7 2
  $erase.ToolTip = 'Erase (Backspace); Ctrl+Z undoes'
  $erase.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Clear-Cell })
  [void]$pad.Children.Add($erase)
  $script:padButtons = $buttons
}

function Update-Board {
  $side = $script:n
  $sel = $script:selected
  $peers = $null
  $selValue = 0
  if ($script:picked.Count -eq 1) {
    $peers = Get-Peers $sel
    if (-not $script:wrong[$sel]) { $selValue = $script:values[$sel] }
  }
  # The selection's colour says where a plain digit goes now: orange answers,
  # blue notes. Holding Shift or Ctrl flips it at once.
  $pickFill = $selectedFill
  if (($script:mode -eq 'notes') -xor (Test-NoteKey)) { $pickFill = $noteSelectFill }
  for ($i = 0; $i -lt $side * $side; $i++) {
    $cell = $script:cells[$i]
    $v = $script:values[$i]
    if ($script:picked.Contains($i)) { $cell.border.Background = $pickFill }
    elseif ($selValue -ne 0 -and $v -eq $selValue -and -not $script:wrong[$i]) { $cell.border.Background = $sameFill }
    elseif ($null -ne $peers -and $peers.Contains($i)) { $cell.border.Background = $peerFill }
    else { $cell.border.Background = $noFill }

    if ($v -ne 0) {
      $cell.value.Text = [string]$v
      $cell.value.Visibility = 'Visible'
      $cell.noteGrid.Visibility = 'Hidden'
      if ($script:given[$i]) { $cell.value.Foreground = $ink; $cell.value.FontWeight = 'Bold' }
      elseif ($script:wrong[$i]) { $cell.value.Foreground = $red; $cell.value.FontWeight = 'Normal' }
      else { $cell.value.Foreground = $green; $cell.value.FontWeight = 'Normal' }
    } else {
      $cell.value.Visibility = 'Collapsed'
      $cell.noteGrid.Visibility = 'Visible'
      $mask = $script:notes[$i]
      for ($d = 1; $d -le $side; $d++) {
        $note = $cell.notes[$d - 1]
        if ($mask -band (1 -shl $d)) { $note.Text = [string]$d } else { $note.Text = '' }
        # Notes of the selected square's number stand out with its squares.
        if ($d -eq $selValue) { $note.Foreground = $accent; $note.FontWeight = 'Bold'; $note.Background = $sameFill }
        else { $note.Foreground = $dim; $note.FontWeight = 'Normal'; $note.Background = $noFill }
      }
    }
  }
  Update-Chrome
}

function Update-Chrome {
  $side = $script:n
  $titleText.Text = "Sudoku ${side}x$side"
  $heartsText.Inlines.Clear()
  for ($k = 0; $k -lt $MAX_LIVES; $k++) {
    # A lost life stays as a grey heart: the outline heart has no glyph in these fonts.
    $heart = New-Object System.Windows.Documents.Run($GLYPH_HEART)
    $heart.Foreground = $red
    if ($k -ge $script:lives) { $heart.Foreground = $thinLine }
    [void]$heartsText.Inlines.Add($heart)
  }

  foreach ($button in @($answerMode, $notesMode)) {
    if ($button.Tag -eq $script:mode) { $button.Foreground = $ink; $button.FontWeight = 'Bold' }
    else { $button.Foreground = $dim; $button.FontWeight = 'Normal' }
  }
  foreach ($key in $sizeButtons.Keys) {
    $button = $sizeButtons[$key]
    if ($key -eq $side) { $button.Foreground = $ink; $button.FontWeight = 'Bold' }
    else { $button.Foreground = $dim; $button.FontWeight = 'Normal' }
  }

  # A digit already placed everywhere it goes is dimmed on the pad.
  $placed = @{}
  for ($i = 0; $i -lt $side * $side; $i++) {
    $v = $script:values[$i]
    if ($v -ne 0 -and -not $script:wrong[$i]) { $placed[$v] = 1 + [int]$placed[$v] }
  }
  for ($d = 1; $d -le $side; $d++) {
    if ([int]$placed[$d] -ge $side) { $script:padButtons[$d - 1].Foreground = $dim } else { $script:padButtons[$d - 1].Foreground = $ink }
  }

  $text = $script:status
  $brush = $script:statusBrush
  if (-not $text) {
    $brush = $dim
    if ($script:mode -eq 'notes') { $text = "Notes $GLYPH_DOT Shift+digit answers $GLYPH_DOT Space switches" }
    else { $text = "Answer $GLYPH_DOT Shift+digit notes $GLYPH_DOT Space switches" }
  }
  $statusText.Text = $text
  $statusText.Foreground = $brush
}

function Set-Status([string]$Text, $Brush) {
  $script:status = $Text
  $script:statusBrush = $Brush
}

function New-Game([int]$Side, [int]$PuzzleSeed = 0) {
  $shape = $SHAPES[$Side]
  $sizeChanged = $Side -ne $script:n
  $script:n = $Side
  $script:boxRows = $shape[0]
  $script:boxCols = $shape[1]
  $puzzle = New-Puzzle $Side $PuzzleSeed
  $script:solution = [int[]]$puzzle.Solution
  $script:values = [int[]]$puzzle.Givens.Clone()
  $script:given = [bool[]]::new($Side * $Side)
  for ($i = 0; $i -lt $Side * $Side; $i++) { $script:given[$i] = $script:values[$i] -ne 0 }
  $script:wrong = [bool[]]::new($Side * $Side)
  $script:notes = [int[]]::new($Side * $Side)
  Select-Only -1
  $script:history.Clear()
  $script:dragSelecting = $false
  $script:lives = $MAX_LIVES
  $script:isSolved = $false
  Set-Status '' $dim
  if ($sizeChanged) { Build-Board }
  Update-Board
  Save-Prefs
}

# The kept game, checked before it is trusted: its solution must be a full
# valid grid and its givens must agree with it. Anything off starts fresh.
function Restore-Game($Game) {
  try {
    $side = [int]$Game.size
    if (-not $SHAPES.ContainsKey($side)) { return $false }
    $shape = $SHAPES[$side]
    $total = $side * $side
    # Plain casts, not @( ): PowerShell 5.1's array binder has thrown on these.
    $solution = [int[]]$Game.solution
    $values = [int[]]$Game.values
    $given = [bool[]]$Game.given
    $wrong = [bool[]]$Game.wrong
    $notes = [int[]]$Game.notes
    foreach ($list in $solution, $values, $given, $wrong, $notes) { if ($null -eq $list -or $list.Length -ne $total) { return $false } }
    if (-not [SudokuGen]::IsValidSolution($solution, $side, $shape[0], $shape[1])) { return $false }
    for ($i = 0; $i -lt $total; $i++) {
      if ($given[$i] -and $values[$i] -ne $solution[$i]) { return $false }
    }
    $script:n = $side
    $script:boxRows = $shape[0]
    $script:boxCols = $shape[1]
    $script:solution = $solution
    $script:values = $values
    $script:given = $given
    $script:wrong = $wrong
    $script:notes = $notes
    $script:lives = [Math]::Max(1, [Math]::Min($MAX_LIVES, [int]$Game.lives))
    if ($Game.mode -eq 'notes') { $script:mode = 'notes' } else { $script:mode = 'answer' }
    $script:isSolved = $false
    Select-Only -1
    $script:history.Clear()
    Set-Status '' $dim
    Build-Board | Out-Null
    Update-Board | Out-Null
    return $true
  } catch {
    return $false
  }
}

# A correct answer settles its cell: its own notes go, and so does that digit
# from the notes of every cell in its row, column and box.
function Remove-PeerNotes([int]$Index, [int]$Digit) {
  $keep = -bnot (1 -shl $Digit)
  foreach ($peer in (Get-Peers $Index)) { $script:notes[$peer] = $script:notes[$peer] -band $keep }
  $script:notes[$Index] = 0
}

function Save-Undo {
  $script:history.Add(@{ values = [int[]]$script:values.Clone(); wrong = [bool[]]$script:wrong.Clone(); notes = [int[]]$script:notes.Clone() })
  if ($script:history.Count -gt $UNDO_KEPT) { $script:history.RemoveAt(0) }
}

# Undo takes back squares and notes, never a lost life.
function Undo-Step {
  if ($script:isSolved -or $script:history.Count -eq 0) { return }
  $last = $script:history[$script:history.Count - 1]
  $script:history.RemoveAt($script:history.Count - 1)
  $script:values = $last.values
  $script:wrong = $last.wrong
  $script:notes = $last.notes
  Set-Status '' $dim
  Save-Prefs
  Update-Board
}

# A digit goes in as a note or an answer: the mode decides, and -Flip (Shift or
# Ctrl held) turns it the other way for this one digit.
function Enter-Digit([int]$Digit, [switch]$Flip) {
  if ($script:isSolved -or $script:picked.Count -eq 0 -or $Digit -lt 1 -or $Digit -gt $script:n) { return }
  if (($script:mode -eq 'notes') -xor $Flip.IsPresent) { Write-Note $Digit; return }
  if ($script:picked.Count -gt 1) {
    Set-Status 'Answers go in one square at a time' $dim
    Update-Chrome
    return
  }
  $i = $script:selected
  if ($script:given[$i]) { return }
  # A right answer is final.
  if ($script:values[$i] -ne 0 -and -not $script:wrong[$i]) { return }
  # The same wrong digit twice costs one life, not two.
  if ($script:wrong[$i] -and $script:values[$i] -eq $Digit) { return }
  Set-Status '' $dim
  Save-Undo

  if ($Digit -eq $script:solution[$i]) {
    $script:values[$i] = $Digit
    $script:wrong[$i] = $false
    Remove-PeerNotes $i $Digit
    $isDone = $true
    for ($k = 0; $k -lt $script:values.Length; $k++) {
      if ($script:values[$k] -ne $script:solution[$k]) { $isDone = $false; break }
    }
    if ($isDone) {
      $script:isSolved = $true
      Select-Only -1
      Set-Status "Solved! $GLYPH_DOT New for another" $green
    }
  } else {
    # A wrong digit stays red, until erased or typed over.
    $script:values[$i] = $Digit
    $script:wrong[$i] = $true
    $script:lives--
    if ($script:lives -le 0) {
      New-Game $script:n
      Set-Status "Out of lives $GLYPH_DASH new puzzle" $red
      Update-Chrome
      return
    }
  }
  Save-Prefs
  Update-Board
}

# A pencil mark goes into every open selected square, or comes out of all of
# them when they all have it. It replaces a red answer, as typing over it would.
function Write-Note([int]$Digit) {
  $open = @($script:picked | Where-Object { -not $script:given[$_] -and ($script:values[$_] -eq 0 -or $script:wrong[$_]) })
  if ($open.Count -eq 0) { return }
  Save-Undo
  $bit = 1 -shl $Digit
  $isEverywhere = @($open | Where-Object { $script:wrong[$_] -or ($script:notes[$_] -band $bit) -eq 0 }).Count -eq 0
  foreach ($i in $open) {
    $script:values[$i] = 0
    $script:wrong[$i] = $false
    if ($isEverywhere) { $script:notes[$i] = $script:notes[$i] -band (-bnot $bit) }
    else { $script:notes[$i] = $script:notes[$i] -bor $bit }
  }
  Set-Status '' $dim
  Save-Prefs
  Update-Board
}

function Clear-Cell {
  if ($script:isSolved) { return }
  $open = @($script:picked | Where-Object {
    -not $script:given[$_] -and ($script:wrong[$_] -or ($script:values[$_] -eq 0 -and $script:notes[$_] -ne 0))
  })
  if ($open.Count -eq 0) { return }
  Save-Undo
  foreach ($i in $open) {
    # Erasing a red answer brings back the notes under it.
    if ($script:wrong[$i]) { $script:values[$i] = 0; $script:wrong[$i] = $false }
    else { $script:notes[$i] = 0 }
  }
  Set-Status '' $dim
  Save-Prefs
  Update-Board
}

# The arrows move the selection; with Shift or Ctrl held they grow it.
function Move-Selection([int]$Rows, [int]$Cols, [bool]$Extend) {
  $side = $script:n
  if ($script:isSolved) { return }
  if ($script:selected -lt 0) { Select-Only 0; Update-Board; return }
  $r = [Math]::Max(0, [Math]::Min($side - 1, (Get-Row $script:selected) + $Rows))
  $c = [Math]::Max(0, [Math]::Min($side - 1, ($script:selected % $side) + $Cols))
  if ($Extend) { Select-Add ($r * $side + $c) } else { Select-Only ($r * $side + $c) }
  Update-Board
}

function Switch-Mode {
  if ($script:mode -eq 'answer') { $script:mode = 'notes' } else { $script:mode = 'answer' }
  Set-Status '' $dim
  Save-Prefs
  Update-Board
}

# --- Keys and clicks ------------------------------------------------------------

# Digits answer, Shift or Ctrl + digit notes (Ctrl for the number pad: Windows
# turns Shift + number pad into arrows and Home/End). Space or N switches the
# mode, Ctrl+Z undoes, arrows move and with Shift or Ctrl grow the selection.
$NOTE_KEYS = @('LeftShift', 'RightShift', 'LeftCtrl', 'RightCtrl')

$win.Add_PreviewKeyDown({
  param($sender, $e)
  $key = $e.Key
  $Keys = [System.Windows.Input.Key]
  $isFlip = Test-NoteKey
  if ($key -ge $Keys::D1 -and $key -le $Keys::D9) { Enter-Digit ([int]$key - [int]$Keys::D0) -Flip:$isFlip; $e.Handled = $true; return }
  if ($key -ge $Keys::NumPad1 -and $key -le $Keys::NumPad9) { Enter-Digit ([int]$key - [int]$Keys::NumPad0) -Flip:$isFlip; $e.Handled = $true; return }
  # Holding Shift or Ctrl recolours the selection at once.
  if ($NOTE_KEYS -contains [string]$key) { if (-not $e.IsRepeat) { Update-Board }; return }
  $isCtrl = (([int][System.Windows.Input.Keyboard]::Modifiers) -band 2) -ne 0
  if ($key -eq $Keys::Z -and $isCtrl) { Undo-Step; $e.Handled = $true; return }
  switch ($key) {
    'Up' { Move-Selection -1 0 $isFlip }
    'Down' { Move-Selection 1 0 $isFlip }
    'Left' { Move-Selection 0 -1 $isFlip }
    'Right' { Move-Selection 0 1 $isFlip }
    'Space' { Switch-Mode }
    'N' { Switch-Mode }
    'Back' { Clear-Cell }
    'Delete' { Clear-Cell }
    'D0' { Clear-Cell }
    'NumPad0' { Clear-Cell }
    'Escape' { Select-Only -1; Update-Board }
    default { return }
  }
  $e.Handled = $true
})

$win.Add_PreviewKeyUp({
  param($sender, $e)
  if ($NOTE_KEYS -contains [string]$e.Key) { Update-Board }
})

$win.Add_PreviewMouseLeftButtonUp({ $script:dragSelecting = $false })

foreach ($control in @($answerMode, $notesMode)) {
  $control.Add_MouseLeftButtonUp({
    param($sender, $e)
    $e.Handled = $true
    if ($script:mode -ne $sender.Tag) { Switch-Mode }
  })
}
foreach ($side in $sizeButtons.Keys) {
  $sizeButtons[$side].Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; New-Game ([int]$sender.Tag) })
}
$newButton.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; New-Game $script:n })
$closeText.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
$closeText.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $win.Close() })

# --- Placement: over the WezTerm window, where the person last dragged it -------

$script:me = [IntPtr]::Zero
$script:lastOwner = $null
$script:dragging = $false

function Get-Rect([IntPtr]$Hwnd) {
  $r = New-Object SudokuWin32+RECT
  [void][SudokuWin32]::GetWindowRect($Hwnd, [ref]$r)
  return $r
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
  [void][SudokuWin32]::SetWindowPos($script:me, [IntPtr]::Zero, $x, $y, 0, 0, 0x15)
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

function Get-Cursor {
  $cursor = New-Object SudokuWin32+POINT
  [void][SudokuWin32]::GetCursorPos([ref]$cursor)
  return $cursor
}

$script:resizing = $false
$script:resizeStart = $null

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
})

$win.Add_SourceInitialized({
  $script:me = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
  if ($hasOwner) {
    # WS_EX_TOOLWINDOW: no Alt-Tab entry; the owner stands for it.
    $style = [SudokuWin32]::GetWindowLong($script:me, -20)
    [void][SudokuWin32]::SetWindowLong($script:me, -20, ($style -bor 0x80))
  }
})

# --- Snapshot: every look on one board, drawn to a PNG ----------------------------

function Show-Demo {
  # One right answer, one wrong, a lost life, notes, a selection, Notes mode.
  $side = $script:n
  $empty = @()
  for ($i = 0; $i -lt $side * $side; $i++) { if (-not $script:given[$i]) { $empty += $i } }
  Select-Only $empty[0]
  Enter-Digit $script:solution[$empty[0]]
  Select-Only $empty[1]
  Enter-Digit (($script:solution[$empty[1]] % $side) + 1)
  $script:mode = 'notes'
  for ($k = 2; $k -lt [Math]::Min(6, $empty.Count); $k++) {
    Select-Only $empty[$k]
    Enter-Digit $script:solution[$empty[$k]]
    Enter-Digit (($script:solution[$empty[$k]] % $side) + 1)
  }
  Select-Only $empty[2]
  $noted = $script:solution[$empty[2]]
  for ($i = 0; $i -lt $side * $side; $i++) {
    if ($script:given[$i] -and $script:values[$i] -eq $noted) { Select-Only $i; break }
  }
  Update-Board
}

function Save-Snapshot {
  if ($SnapshotDemo) { Show-Demo }
  $win.UpdateLayout()
  $dpi = 96.0
  if ($script:me -ne [IntPtr]::Zero) { $dpi = [double][SudokuWin32]::GetDpiForWindow($script:me) }
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
  Send-Event @{ event = 'ready'; size = $script:n }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
  if (-not $hasOwner) { return }
  if (-not [SudokuWin32]::IsWindow($owner)) { $win.Close(); return }
  if ($script:dragging -or $script:resizing -or [SudokuWin32]::IsIconic($owner)) { return }
  $now = Get-Rect $owner
  $was = $script:lastOwner
  if ($null -eq $was -or $now.Left -ne $was.Left -or $now.Top -ne $was.Top -or $now.Right -ne $was.Right -or $now.Bottom -ne $was.Bottom) {
    $script:lastOwner = $now
    Set-Place
  }
})

# The game left open comes back as it was; anything else starts a new puzzle.
$restored = $false
if ($savedGame -and -not $SnapshotPath -and -not $PlayTest) { $restored = Restore-Game $savedGame }
if (-not $restored) { New-Game $startSide $Seed }

# --- Play-test: the rules, played through on a real board ------------------------

function Test-Rules {
  $checks = [ordered]@{}
  $side = $script:n
  $empty = @()
  for ($i = 0; $i -lt $side * $side; $i++) { if (-not $script:given[$i]) { $empty += $i } }
  $target = $empty[0]
  $digit = $script:solution[$target]
  $peerSet = Get-Peers $target
  $peers = @($peerSet | Where-Object { $_ -ne $target -and -not $script:given[$_] -and $script:values[$_] -eq 0 })
  $far = @($empty | Where-Object { -not $peerSet.Contains($_) }) | Select-Object -First 1

  # Notes: the digit pencilled into the target, its open peers and a far cell.
  $script:mode = 'notes'
  foreach ($cell in @($target) + $peers + @($far)) { Select-Only $cell; Enter-Digit $digit }
  $other = ($digit % $side) + 1
  Select-Only $target; Enter-Digit $other
  $checks.notesWritten = ($script:notes[$target] -band (1 -shl $digit)) -ne 0

  # A wrong answer: red, stays, one life, notes left alone; the same digit again costs nothing.
  $script:mode = 'answer'
  $wrongDigit = ($script:solution[$far] % $side) + 1
  Select-Only $far; Enter-Digit $wrongDigit; Enter-Digit $wrongDigit
  $checks.wrongStaysRed = $script:wrong[$far] -and $script:values[$far] -eq $wrongDigit
  $checks.wrongCostsOneLife = $script:lives -eq ($MAX_LIVES - 1)
  $checks.wrongKeepsNotes = @($peers | Where-Object { ($script:notes[$_] -band (1 -shl $digit)) -eq 0 }).Count -eq 0
  Clear-Cell
  $checks.eraseClearsRed = $script:values[$far] -eq 0 -and -not $script:wrong[$far] -and ($script:notes[$far] -band (1 -shl $digit)) -ne 0

  # A right answer: green, its own notes gone, the digit gone from every peer's notes.
  Select-Only $target; Enter-Digit $digit
  $checks.rightIsKept = $script:values[$target] -eq $digit -and -not $script:wrong[$target]
  $checks.ownNotesCleared = $script:notes[$target] -eq 0
  $checks.peerNotesCleared = @($peers | Where-Object { ($script:notes[$_] -band (1 -shl $digit)) -ne 0 }).Count -eq 0
  $checks.farNotesKept = ($script:notes[$far] -band (1 -shl $digit)) -ne 0
  $farNote = $script:cells[$far].notes[$digit - 1]
  $checks.selectedNumberLightsNotes = $farNote.Text -eq [string]$digit -and $farNote.Foreground -eq $accent
  Select-Only $far; Update-Board
  $checks.otherNotesStayDim = $farNote.Foreground -eq $dim

  # Several squares at once: a held-key note goes into all of them and comes
  # out of all of them the second time; an answer needs a single square.
  $two = @($empty | Where-Object { $script:values[$_] -eq 0 -and -not $script:wrong[$_] } | Select-Object -First 2)
  $free = 1
  while ($free -le $side -and (($script:notes[$two[0]] -bor $script:notes[$two[1]]) -band (1 -shl $free))) { $free++ }
  Select-Only $two[0]; Select-Add $two[1]
  Enter-Digit $free -Flip
  $checks.heldKeyNotesIntoAll = (($script:notes[$two[0]] -band $script:notes[$two[1]]) -band (1 -shl $free)) -ne 0
  Enter-Digit $free -Flip
  $checks.heldKeyNoteComesOutOfAll = (($script:notes[$two[0]] -bor $script:notes[$two[1]]) -band (1 -shl $free)) -eq 0
  $livesBefore = $script:lives
  Enter-Digit $script:solution[$two[0]]
  $checks.oneAnswerAtATime = $script:values[$two[0]] -eq 0 -and $script:lives -eq $livesBefore

  # In Notes mode the held key answers.
  $script:mode = 'notes'
  Select-Only $two[1]; Enter-Digit $script:solution[$two[1]] -Flip
  $checks.heldKeyAnswersInNotes = $script:values[$two[1]] -eq $script:solution[$two[1]] -and -not $script:wrong[$two[1]]
  $script:mode = 'answer'

  # Undo takes back a wrong answer, but not the life it cost.
  Select-Only $two[0]; Enter-Digit (($script:solution[$two[0]] % $side) + 1)
  $livesAfterWrong = $script:lives
  Undo-Step
  $checks.undoTakesBackWrong = $script:values[$two[0]] -eq 0 -and -not $script:wrong[$two[0]]
  $checks.undoKeepsLifeLost = $script:lives -eq $livesAfterWrong
  $checks.hasPeers = $peers.Count -gt 0
  $checks.peerCount = $peers.Count

  # The kept game comes back exactly, through the same JSON the file holds;
  # a game that does not fit is refused.
  $keptGame = @{ size = $script:n; solution = $script:solution; values = $script:values; given = $script:given
    wrong = $script:wrong; notes = $script:notes; lives = $script:lives; mode = 'notes' } | ConvertTo-Json -Compress -Depth 4 | ConvertFrom-Json
  $keptState = "$($script:values -join ',')|$($script:wrong -join ',')|$($script:notes -join ',')|$($script:lives)"
  $isRestored = Restore-Game $keptGame
  $checks.restoresKeptGame = $isRestored -and "$($script:values -join ',')|$($script:wrong -join ',')|$($script:notes -join ',')|$($script:lives)" -eq $keptState -and $script:mode -eq 'notes'
  $script:mode = 'answer'
  $brokenGame = $keptGame | ConvertTo-Json -Compress -Depth 4 | ConvertFrom-Json
  $brokenGame.size = 4
  $checks.refusesMisfitGame = -not (Restore-Game $brokenGame)

  # Out of lives: a fresh puzzle, three lives.
  $before = ($script:solution -join '')
  $open = @(); for ($i = 0; $i -lt $side * $side; $i++) { if ($script:values[$i] -eq 0) { $open += $i } }
  foreach ($cell in $open[0..($script:lives - 1)]) { Select-Only $cell; Enter-Digit (($script:solution[$cell] % $side) + 1) }
  $checks.outOfLivesNewPuzzle = ($script:solution -join '') -ne $before -and $script:lives -eq $MAX_LIVES
  $checks.outOfLivesSaysSo = $script:status -like 'Out of lives*'

  # Solving every cell wins.
  for ($i = 0; $i -lt $side * $side; $i++) { if (-not $script:given[$i]) { Select-Only $i; Enter-Digit $script:solution[$i] } }
  $checks.solved = $script:isSolved -and $script:status -like 'Solved*'

  $ok = $true
  foreach ($key in @($checks.Keys)) { if ($checks[$key] -is [bool] -and -not $checks[$key]) { $ok = $false } }
  $checks.size = $side
  $checks.ok = $ok
  Send-Event $checks
  return $ok
}

if ($PlayTest) {
  if (Test-Rules) { exit 0 } else { exit 1 }
}
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
