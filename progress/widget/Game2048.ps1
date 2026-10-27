#Requires -Version 5.1
# 2048, opened from the progress panel's games row.
#
# The original's rules: a 4x4 board, arrow keys (or WASD, or HJKL) slide every
# tile as far as it goes, two equal tiles that meet merge into their sum once
# per move (the pair nearest the wall first), and each move that changes the
# board drops a new tile: a 2, or a 4 one time in ten. Reaching 2048 wins, and
# you may keep going; a full board with no merge left ends the game. R starts
# over. The game and the best score are kept, as the original keeps them.
#
# Its own process, owned by the chat's WezTerm window (-OwnerHwnd), like the
# Sudoku. PowerShell names ignore case: constants are $*_PX / $GLYPH_* so no
# local can shadow them, and no local reuses a parameter's name. Kept to ASCII:
# every non-ASCII glyph is built from its code point.

param(
  [int64]$OwnerHwnd = 0,
  [string]$SessionId = 'default',
  [int]$Seed = 0,
  # Testing aids: check the rules and exit, or draw the window to a PNG and exit.
  [switch]$SelfTest,
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
using System.Runtime.InteropServices;
using System.Text;

public static class G2048Win32 {
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

public sealed class G2048Move {
  public int[] Board;
  public bool Moved;
  public int Gained;
  // Where each tile went (From[k] to To[k]); two tiles going to one cell merged there.
  public int[] From;
  public int[] To;
  public int[] Merged;
}

public static class G2048 {
  public const int Side = 4;

  // The k-th cell of a line, counted from the wall the tiles move toward.
  // dir: 0 up, 1 right, 2 down, 3 left.
  public static int CellOf(int dir, int line, int k) {
    switch (dir) {
      case 0: return k * Side + line;
      case 1: return line * Side + (Side - 1 - k);
      case 2: return (Side - 1 - k) * Side + line;
      default: return line * Side + k;
    }
  }

  // Every tile slides toward the wall; a tile meeting an equal one that has
  // not merged this move merges with it. [2,2,2,2] left is [4,4,0,0].
  public static G2048Move Move(int[] board, int dir) {
    var next = new int[Side * Side];
    var from = new List<int>();
    var to = new List<int>();
    var merged = new List<int>();
    int gained = 0;
    for (int line = 0; line < Side; line++) {
      int write = 0;
      int lastValue = 0;
      bool canMerge = false;
      for (int k = 0; k < Side; k++) {
        int cell = CellOf(dir, line, k);
        int v = board[cell];
        if (v == 0) continue;
        if (canMerge && lastValue == v) {
          int into = CellOf(dir, line, write - 1);
          next[into] = v * 2;
          gained += v * 2;
          merged.Add(into);
          from.Add(cell);
          to.Add(into);
          canMerge = false;
        } else {
          int into = CellOf(dir, line, write);
          next[into] = v;
          from.Add(cell);
          to.Add(into);
          lastValue = v;
          canMerge = true;
          write++;
        }
      }
    }
    var result = new G2048Move();
    result.Board = next;
    result.Gained = gained;
    result.From = from.ToArray();
    result.To = to.ToArray();
    result.Merged = merged.ToArray();
    result.Moved = false;
    for (int i = 0; i < next.Length; i++) {
      if (next[i] != board[i]) { result.Moved = true; break; }
    }
    return result;
  }

  // A move is left while a cell is empty or two equal tiles touch.
  public static bool CanMove(int[] board) {
    for (int i = 0; i < board.Length; i++) {
      if (board[i] == 0) return true;
      int r = i / Side, c = i % Side;
      if (c + 1 < Side && board[i + 1] == board[i]) return true;
      if (r + 1 < Side && board[i + Side] == board[i]) return true;
    }
    return false;
  }

  // One new tile in a random empty cell: a 2, or a 4 one time in ten.
  public static int Spawn(int[] board, Random rng) {
    var empty = new List<int>();
    for (int i = 0; i < board.Length; i++) if (board[i] == 0) empty.Add(i);
    if (empty.Count == 0) return -1;
    int at = empty[rng.Next(empty.Count)];
    board[at] = rng.NextDouble() < 0.9 ? 2 : 4;
    return at;
  }
}
'@

# --- Self-test: the original's rules, line by line --------------------------------

function Test-Line([int[]]$Before, [int]$Dir, [int[]]$After, [int]$Gain) {
  $move = [G2048]::Move($Before, $Dir)
  return (($move.Board -join ',') -eq ($After -join ',')) -and $move.Gained -eq $Gain
}

if ($SelfTest) {
  $checks = [ordered]@{}
  $z = @(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  # Left on the top row (the rest empty).
  $checks.fourEqualMakeTwoPairs = Test-Line (@(2, 2, 2, 2) + $z) 3 (@(4, 4, 0, 0) + $z) 8
  $checks.threeEqualMergeNearWall = Test-Line (@(2, 2, 2, 0) + $z) 3 (@(4, 2, 0, 0) + $z) 4
  $checks.threeEqualRightMergeNearWall = Test-Line (@(2, 2, 2, 0) + $z) 1 (@(0, 0, 2, 4) + $z) 4
  $checks.mergedTileMergesOnce = Test-Line (@(4, 4, 8, 0) + $z) 3 (@(8, 8, 0, 0) + $z) 8
  $checks.gapsClose = Test-Line (@(2, 0, 2, 4) + $z) 3 (@(4, 4, 0, 0) + $z) 4
  $checks.unequalOnlySlide = Test-Line (@(0, 2, 0, 4) + $z) 3 (@(2, 4, 0, 0) + $z) 0
  # Up on the first column.
  $column = @(2, 0, 0, 0, 2, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0)
  $checks.upMergesColumns = Test-Line $column 0 @(4, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) 12
  $checks.downMergesColumns = Test-Line $column 2 @(0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 8, 0, 0, 0) 12
  # A move into a wall that changes nothing is no move: no new tile.
  $checks.blockedIsNoMove = -not ([G2048]::Move((@(2, 4, 8, 16) + $z), 3)).Moved
  # Game over only when full with no equal neighbours.
  $full = @(2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2)
  $checks.fullNoPairsIsOver = -not [G2048]::CanMove($full)
  $pair = [int[]]$full.Clone(); $pair[15] = 4
  $checks.fullWithPairCanMove = [G2048]::CanMove($pair)
  # New tiles: 2s about nine times in ten, into empty cells only.
  $testRng = New-Object System.Random(7)
  $fours = 0
  for ($i = 0; $i -lt 10000; $i++) {
    $one = [int[]]::new(16); $one[0] = 8
    $at = [G2048]::Spawn($one, $testRng)
    if ($at -eq 0) { $fours = -1; break }
    if ($one[$at] -eq 4) { $fours++ }
  }
  $checks.spawnsFourOneInTen = $fours -gt 850 -and $fours -lt 1150
  $ok = $true
  foreach ($key in @($checks.Keys)) { if (-not $checks[$key]) { $ok = $false } }
  $checks.ok = $ok
  Send-Event $checks
  if ($ok) { exit 0 } else { exit 1 }
}

# --- One game per chat ------------------------------------------------------------

[void][G2048Win32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$WINDOW_TITLE = "Claude2048:$SessionId"
$mutex = New-Object System.Threading.Mutex($false, "Local\Claude2048-$SessionId")
try {
  $isOwner = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $isOwner = $true
}
if (-not $isOwner -and -not $SnapshotPath) {
  $existing = [G2048Win32]::WindowByText($WINDOW_TITLE)
  if ($existing -ne [IntPtr]::Zero) { [void][G2048Win32]::SetForegroundWindow($existing) }
  exit 0
}

$owner = [IntPtr]$OwnerHwnd
$hasOwner = $owner -ne [IntPtr]::Zero -and [G2048Win32]::IsWindow($owner)

$GLYPH_CLOSE = [string][char]0x2715
$GLYPH_GRIP = [string][char]0x25E2
$GLYPH_DOT = [string][char]0x00B7
$MIN_SCALE = 0.7
$MAX_SCALE = 2.5
$TILE_PX = 76
$GAP_PX = 10
$BOARD_PX = 4 * $TILE_PX + 5 * $GAP_PX
$SLIDE_MS = 100

# --- What the person left: where, how big, the best score, the game -----------------

$prefsFile = Join-Path $env:LOCALAPPDATA 'ClaudePhases\2048.json'
$script:offset = $null
$script:scale = 1.0
$script:best = 0
$savedGame = $null
try {
  if (Test-Path $prefsFile) {
    $saved = Get-Content $prefsFile -Raw | ConvertFrom-Json
    if ($null -ne $saved.dx) { $script:offset = @{ dx = [int]$saved.dx; dy = [int]$saved.dy } }
    if ($saved.scale) { $script:scale = [Math]::Max([double]$MIN_SCALE, [Math]::Min([double]$MAX_SCALE, [double]$saved.scale)) }
    if ($saved.best) { $script:best = [int]$saved.best }
    if ($saved.game -and @($saved.game.board).Count -eq 16) { $savedGame = $saved.game }
  }
} catch {}

function Save-Prefs {
  # Test runs leave the person's game alone.
  if ($SnapshotPath) { return }
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $prefsFile) | Out-Null
    $prefs = @{ scale = [Math]::Round($script:scale, 3); best = $script:best }
    if ($script:offset) { $prefs.dx = $script:offset.dx; $prefs.dy = $script:offset.dy }
    # A finished game is not kept: the next window starts a fresh one.
    if (-not $script:isOver) {
      $prefs.game = @{ board = @($script:board); score = $script:score; won = $script:hasWon; keepPlaying = $script:keepPlaying }
    }
    $prefs | ConvertTo-Json -Compress -Depth 4 | Set-Content -Path $prefsFile -Encoding ASCII
  } catch {}
}

# --- The window ---------------------------------------------------------------

function Brush([string]$Hex) { return [System.Windows.Media.BrushConverter]::new().ConvertFromString($Hex) }
$ink = Brush '#E8E6E3'
$dim = Brush '#8B8A88'
$accent = Brush '#E08A5F'
$noFill = [System.Windows.Media.Brushes]::Transparent
$font = New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas')

# Each value its own colour, on the original's path: warm neutrals, then
# oranges into red, then golds up to 2048, then cool colours past it.
$TILE_LOOKS = @{
  2 = @('#4B4840', '#EDE6DA'); 4 = @('#5E5644', '#F2E8D5'); 8 = @('#C2703F', '#FBF3EA')
  16 = @('#D9783C', '#FBF3EA'); 32 = @('#E5643A', '#FBF3EA'); 64 = @('#E8472F', '#FBF3EA')
  128 = @('#E3C15A', '#26231C'); 256 = @('#E6BE47', '#26231C'); 512 = @('#EABA33', '#26231C')
  1024 = @('#EEB521', '#26231C'); 2048 = @('#F5C400', '#26231C'); 4096 = @('#8E5BD6', '#F4F0FB')
  8192 = @('#6F55D9', '#F4F0FB'); 16384 = @('#4F63D6', '#F0F3FC'); 32768 = @('#3687D1', '#EFF6FC')
  65536 = @('#2AA3A8', '#EEFAFA'); 131072 = @('#3FAF7A', '#EEFAF3')
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

# A score box: its label, its number, and the "+N" that rises out of it.
function New-ScoreBox([string]$Label) {
  $box = New-Object System.Windows.Controls.Border
  $box.Background = Brush '#2B2C31'
  $box.CornerRadius = New-Object System.Windows.CornerRadius(5)
  $box.Padding = New-Gap 10 3 10 4
  $box.Margin = New-Gap 6 0 0 0
  $box.MinWidth = 64
  $inside = New-Object System.Windows.Controls.StackPanel
  $name = New-Text $Label $dim
  $name.FontSize = 9
  $name.HorizontalAlignment = 'Center'
  $number = New-Text '0' $ink
  $number.FontSize = 15
  $number.FontWeight = 'Bold'
  $number.HorizontalAlignment = 'Center'
  [void]$inside.Children.Add($name)
  [void]$inside.Children.Add($number)
  $layers = New-Object System.Windows.Controls.Grid
  [void]$layers.Children.Add($inside)
  $rise = New-Text '' $accent
  $rise.FontSize = 13
  $rise.FontWeight = 'Bold'
  $rise.HorizontalAlignment = 'Center'
  $rise.VerticalAlignment = 'Bottom'
  $rise.Opacity = 0
  $rise.IsHitTestVisible = $false
  $rise.RenderTransform = New-Object System.Windows.Media.TranslateTransform(0, 0)
  [void]$layers.Children.Add($rise)
  $box.Child = $layers
  [System.Windows.Controls.DockPanel]::SetDock($box, 'Right')
  return @{ box = $box; number = $number; rise = $rise }
}

# Header: the name, the score and best, the close mark. Dragging it moves the window.
$header = New-Object System.Windows.Controls.DockPanel
$header.Cursor = [System.Windows.Input.Cursors]::SizeAll
$header.Background = $noFill
$titleText = New-Text '2048' $accent
$titleText.FontSize = 22
$titleText.FontWeight = 'Bold'
$titleText.VerticalAlignment = 'Center'
[System.Windows.Controls.DockPanel]::SetDock($titleText, 'Left')
$closeText = New-Text $GLYPH_CLOSE $dim
$closeText.Margin = New-Gap 12 0 0 0
$closeText.VerticalAlignment = 'Top'
$closeText.Cursor = [System.Windows.Input.Cursors]::Hand
[System.Windows.Controls.DockPanel]::SetDock($closeText, 'Right')
$bestBox = New-ScoreBox 'BEST'
$scoreBox = New-ScoreBox 'SCORE'
[void]$header.Children.Add($titleText)
[void]$header.Children.Add($closeText)
[void]$header.Children.Add($bestBox.box)
[void]$header.Children.Add($scoreBox.box)
[void]$header.Children.Add((New-Object System.Windows.Controls.Border))

# The board: empty cells drawn once, tiles on a layer above them, and the
# win / game-over message over both.
$boardBack = New-Object System.Windows.Controls.Border
$boardBack.Background = Brush '#202125'
$boardBack.CornerRadius = New-Object System.Windows.CornerRadius(8)
$boardBack.Width = $BOARD_PX
$boardBack.Height = $BOARD_PX
$boardBack.Margin = New-Gap 0 12 0 0
$boardBack.HorizontalAlignment = 'Center'
$boardLayers = New-Object System.Windows.Controls.Grid
$cellLayer = New-Object System.Windows.Controls.Canvas
$tileLayer = New-Object System.Windows.Controls.Canvas
$tileLayer.ClipToBounds = $true

function Get-CellX([int]$Index) { return $GAP_PX + ($Index % 4) * ($TILE_PX + $GAP_PX) }
function Get-CellY([int]$Index) { return $GAP_PX + [Math]::Floor($Index / 4) * ($TILE_PX + $GAP_PX) }

for ($i = 0; $i -lt 16; $i++) {
  $slot = New-Object System.Windows.Controls.Border
  $slot.Width = $TILE_PX
  $slot.Height = $TILE_PX
  $slot.CornerRadius = New-Object System.Windows.CornerRadius(6)
  $slot.Background = Brush '#2B2C31'
  [System.Windows.Controls.Canvas]::SetLeft($slot, (Get-CellX $i))
  [System.Windows.Controls.Canvas]::SetTop($slot, (Get-CellY $i))
  [void]$cellLayer.Children.Add($slot)
}

$overlay = New-Object System.Windows.Controls.Border
$overlay.Background = Brush '#D91C1D20'
$overlay.CornerRadius = New-Object System.Windows.CornerRadius(8)
$overlay.Visibility = 'Collapsed'
$overlayStack = New-Object System.Windows.Controls.StackPanel
$overlayStack.VerticalAlignment = 'Center'
$overlayStack.HorizontalAlignment = 'Center'
$overlayText = New-Text '' $ink
$overlayText.FontSize = 30
$overlayText.FontWeight = 'Bold'
$overlayText.HorizontalAlignment = 'Center'
$overlayButtons = New-Object System.Windows.Controls.StackPanel
$overlayButtons.Orientation = 'Horizontal'
$overlayButtons.HorizontalAlignment = 'Center'
$overlayButtons.Margin = New-Gap 0 14 0 0

function New-Button([string]$Text, $Background, $Foreground) {
  $button = New-Object System.Windows.Controls.Border
  $button.Background = $Background
  $button.CornerRadius = New-Object System.Windows.CornerRadius(5)
  $button.Padding = New-Gap 12 5 12 6
  $button.Margin = New-Gap 5 0 5 0
  $button.Cursor = [System.Windows.Input.Cursors]::Hand
  $label = New-Text $Text $Foreground
  $label.FontWeight = 'Bold'
  $button.Child = $label
  return $button
}

$keepButton = New-Button 'Keep going' (Brush '#F5C400') (Brush '#26231C')
$againButton = New-Button 'Try again' (Brush '#3A3B41') $ink
[void]$overlayButtons.Children.Add($keepButton)
[void]$overlayButtons.Children.Add($againButton)
[void]$overlayStack.Children.Add($overlayText)
[void]$overlayStack.Children.Add($overlayButtons)
$overlay.Child = $overlayStack

[void]$boardLayers.Children.Add($cellLayer)
[void]$boardLayers.Children.Add($tileLayer)
[void]$boardLayers.Children.Add($overlay)
$boardBack.Child = $boardLayers

# Footer: how to play, and a new game.
$footer = New-Object System.Windows.Controls.DockPanel
$footer.Margin = New-Gap 0 10 0 0
$newButton = New-Text 'New game' $ink
$newButton.FontWeight = 'Bold'
$newButton.Cursor = [System.Windows.Input.Cursors]::Hand
$newButton.ToolTip = 'Start over (R)'
$newButton.Margin = New-Gap 12 0 12 0
[System.Windows.Controls.DockPanel]::SetDock($newButton, 'Right')
$hintText = New-Text "Arrows, WASD or HJKL $GLYPH_DOT R restarts" $dim
[void]$footer.Children.Add($newButton)
[void]$footer.Children.Add($hintText)

$stack = New-Object System.Windows.Controls.StackPanel
[void]$stack.Children.Add($header)
[void]$stack.Children.Add($boardBack)
[void]$stack.Children.Add($footer)
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

$script:board = [int[]]::new(16)
$script:score = 0
$script:isOver = $false
$script:hasWon = $false
$script:keepPlaying = $false
$script:rng = if ($Seed -ne 0) { New-Object System.Random($Seed) } else { New-Object System.Random }
$script:tiles = @{}
$script:isSliding = $false
$script:afterSlide = $null

function New-Tile([int]$Value, [int]$Index) {
  $look = $TILE_LOOKS[$Value]
  if (-not $look) { $look = $TILE_LOOKS[131072] }
  $piece = New-Object System.Windows.Controls.Border
  $piece.Width = $TILE_PX
  $piece.Height = $TILE_PX
  $piece.CornerRadius = New-Object System.Windows.CornerRadius(6)
  $piece.Background = Brush $look[0]
  $digits = ([string]$Value).Length
  $text = New-Text ([string]$Value) (Brush $look[1])
  $text.FontWeight = 'Bold'
  $text.FontSize = @{ 1 = 32; 2 = 30; 3 = 25; 4 = 20; 5 = 16 }[[Math]::Min(5, $digits)]
  if ($digits -gt 5) { $text.FontSize = 13 }
  $text.HorizontalAlignment = 'Center'
  $text.VerticalAlignment = 'Center'
  $piece.Child = $text
  # 2048 and past it glow.
  if ($Value -ge 2048) {
    $glow = New-Object System.Windows.Media.Effects.DropShadowEffect
    $glow.Color = ([System.Windows.Media.SolidColorBrush](Brush $look[0])).Color
    $glow.BlurRadius = 18
    $glow.ShadowDepth = 0
    $glow.Opacity = 0.7
    $piece.Effect = $glow
  }
  $piece.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)
  $piece.RenderTransform = New-Object System.Windows.Media.ScaleTransform(1, 1)
  [System.Windows.Controls.Canvas]::SetLeft($piece, (Get-CellX $Index))
  [System.Windows.Controls.Canvas]::SetTop($piece, (Get-CellY $Index))
  [void]$tileLayer.Children.Add($piece)
  return $piece
}

function Start-Scale($Piece, [double]$From, [int]$Ms) {
  $grow = New-Object System.Windows.Media.Animation.DoubleAnimation($From, 1.0, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds($Ms))))
  $grow.EasingFunction = New-Object System.Windows.Media.Animation.QuadraticEase
  $Piece.RenderTransform.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $grow)
  $Piece.RenderTransform.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $grow)
}

# Draws the board as it is: merged tiles pop, the new tile grows in.
function Show-Board([int[]]$Merged = @(), [int]$Spawned = -1) {
  $tileLayer.Children.Clear()
  $script:tiles = @{}
  for ($i = 0; $i -lt 16; $i++) {
    if ($script:board[$i] -eq 0) { continue }
    $piece = New-Tile $script:board[$i] $i
    $script:tiles[$i] = $piece
    if ($Merged -contains $i) { Start-Scale $piece 1.2 150 }
    elseif ($i -eq $Spawned) { Start-Scale $piece 0.0 150 }
  }
  Update-Scores
  Update-Overlay
}

function Update-Scores {
  $scoreBox.number.Text = [string]$script:score
  $bestBox.number.Text = [string]$script:best
}

# "+N" rises out of the score and fades, as in the original.
function Show-Gain([int]$Gain) {
  $rise = $scoreBox.rise
  $rise.Text = "+$Gain"
  $time = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(600))
  $rise.RenderTransform.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, -28.0, $time)))
  $rise.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0, $time)))
}

function Update-Overlay {
  if ($script:isOver) {
    $overlayText.Text = 'Game over!'
    $overlayText.Foreground = $ink
    $keepButton.Visibility = 'Collapsed'
    $overlay.Visibility = 'Visible'
  } elseif ($script:hasWon -and -not $script:keepPlaying) {
    $overlayText.Text = 'You win!'
    $overlayText.Foreground = Brush '#F5C400'
    $keepButton.Visibility = 'Visible'
    $overlay.Visibility = 'Visible'
  } else {
    $overlay.Visibility = 'Collapsed'
  }
}

$slideTimer = New-Object System.Windows.Threading.DispatcherTimer
$slideTimer.Interval = [TimeSpan]::FromMilliseconds($SLIDE_MS)
$slideTimer.Add_Tick({ Complete-Slide })

# The tiles slide to where the move put them; then the board is drawn whole.
function Start-Slide($Move, [int]$Spawned) {
  $time = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds($SLIDE_MS))
  for ($k = 0; $k -lt $Move.From.Length; $k++) {
    $piece = $script:tiles[$Move.From[$k]]
    if (-not $piece) { continue }
    $piece.BeginAnimation([System.Windows.Controls.Canvas]::LeftProperty, (New-Object System.Windows.Media.Animation.DoubleAnimation([double](Get-CellX $Move.To[$k]), $time)))
    $piece.BeginAnimation([System.Windows.Controls.Canvas]::TopProperty, (New-Object System.Windows.Media.Animation.DoubleAnimation([double](Get-CellY $Move.To[$k]), $time)))
  }
  $script:afterSlide = @{ merged = [int[]]$Move.Merged; spawned = $Spawned }
  $script:isSliding = $true
  $slideTimer.Start()
}

function Complete-Slide {
  $slideTimer.Stop()
  if (-not $script:isSliding) { return }
  $script:isSliding = $false
  Show-Board $script:afterSlide.merged $script:afterSlide.spawned
}

function New-Game {
  $slideTimer.Stop()
  $script:isSliding = $false
  $script:board = [int[]]::new(16)
  $script:score = 0
  $script:isOver = $false
  $script:hasWon = $false
  $script:keepPlaying = $false
  [void][G2048]::Spawn($script:board, $script:rng)
  [void][G2048]::Spawn($script:board, $script:rng)
  Show-Board
  Save-Prefs
}

# dir: 0 up, 1 right, 2 down, 3 left.
function Invoke-Move([int]$Dir) {
  if ($script:isOver -or ($script:hasWon -and -not $script:keepPlaying)) { return }
  # A key during a slide finishes it at once, so quick play never waits.
  if ($script:isSliding) { Complete-Slide }
  $move = [G2048]::Move($script:board, $Dir)
  if (-not $move.Moved) { return }
  $script:board = $move.Board
  $script:score += $move.Gained
  if ($script:score -gt $script:best) { $script:best = $script:score }
  $spawned = [G2048]::Spawn($script:board, $script:rng)
  if (-not $script:hasWon -and $move.Merged.Length -gt 0 -and ($script:board -contains 2048)) { $script:hasWon = $true }
  if (-not [G2048]::CanMove($script:board)) { $script:isOver = $true }
  Save-Prefs
  if ($move.Gained -gt 0) { Show-Gain $move.Gained }
  Update-Scores
  Start-Slide $move $spawned
}

# --- Keys and clicks ------------------------------------------------------------

$MOVE_KEYS = @{
  Up = 0; W = 0; K = 0
  Right = 1; D = 1; L = 1
  Down = 2; S = 2; J = 2
  Left = 3; A = 3; H = 3
}

$win.Add_PreviewKeyDown({
  param($sender, $e)
  # As in the original, keys with Ctrl, Alt or Windows held are not moves.
  if ((([int][System.Windows.Input.Keyboard]::Modifiers) -band 11) -ne 0) { return }
  $name = [string]$e.Key
  if ($MOVE_KEYS.ContainsKey($name)) { Invoke-Move $MOVE_KEYS[$name]; $e.Handled = $true; return }
  if ($name -eq 'R') { New-Game; $e.Handled = $true }
})

foreach ($button in @($keepButton, $againButton, $newButton, $closeText)) {
  $button.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
}
$keepButton.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  $script:keepPlaying = $true
  Update-Overlay
  Save-Prefs
})
$againButton.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; New-Game })
$newButton.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; New-Game })
$closeText.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $win.Close() })

# --- Placement: over the WezTerm window, where the person last dragged it -------

$script:me = [IntPtr]::Zero
$script:lastOwner = $null
$script:dragging = $false
$script:resizing = $false
$script:resizeStart = $null

function Get-Rect([IntPtr]$Hwnd) {
  $r = New-Object G2048Win32+RECT
  [void][G2048Win32]::GetWindowRect($Hwnd, [ref]$r)
  return $r
}

function Get-Cursor {
  $cursor = New-Object G2048Win32+POINT
  [void][G2048Win32]::GetCursorPos([ref]$cursor)
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
  [void][G2048Win32]::SetWindowPos($script:me, [IntPtr]::Zero, $x, $y, 0, 0, 0x15)
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
})

$win.Add_SourceInitialized({
  $script:me = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
  if ($hasOwner) {
    # WS_EX_TOOLWINDOW: no Alt-Tab entry; the owner stands for it.
    $style = [G2048Win32]::GetWindowLong($script:me, -20)
    [void][G2048Win32]::SetWindowLong($script:me, -20, ($style -bor 0x80))
  }
})

# --- Snapshot: every tile colour on one board, drawn to a PNG -----------------------

function Show-Demo {
  $script:board = [int[]]@(2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536)
  $script:score = 31412
  $script:best = 52768
  Show-Board
}

function Save-Snapshot {
  if ($SnapshotDemo) { Show-Demo }
  $win.UpdateLayout()
  $dpi = 96.0
  if ($script:me -ne [IntPtr]::Zero) { $dpi = [double][G2048Win32]::GetDpiForWindow($script:me) }
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
  Send-Event @{ event = 'ready' }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
  if (-not $hasOwner) { return }
  if (-not [G2048Win32]::IsWindow($owner)) { $win.Close(); return }
  if ($script:dragging -or $script:resizing -or [G2048Win32]::IsIconic($owner)) { return }
  $now = Get-Rect $owner
  $was = $script:lastOwner
  if ($null -eq $was -or $now.Left -ne $was.Left -or $now.Top -ne $was.Top -or $now.Right -ne $was.Right -or $now.Bottom -ne $was.Bottom) {
    $script:lastOwner = $now
    Set-Place
  }
})

# The kept game comes back as it was; anything else starts fresh.
$restored = $false
if ($savedGame -and -not $SnapshotPath) {
  try {
    $cells = [int[]]@($savedGame.board | ForEach-Object { [int]$_ })
    if ($cells.Length -eq 16 -and [G2048]::CanMove($cells)) {
      $script:board = $cells
      $script:score = [int]$savedGame.score
      $script:hasWon = [bool]$savedGame.won
      $script:keepPlaying = [bool]$savedGame.keepPlaying
      if ($script:score -gt $script:best) { $script:best = $script:score }
      Show-Board
      $restored = $true
    }
  } catch {}
}
if (-not $restored) { New-Game }

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
