#Requires -Version 5.1
# Chess puzzles, opened from the progress panel's games row.
#
# The puzzles are from the Lichess puzzle database (ChessPuzzles.txt, built by
# tools/build-puzzles.mjs). The opponent plays the first move; then find the
# best line. Every move is explained from the position itself (the Narrator in
# ChessCore.cs), never guessed. A wrong move is answered by Stockfish,
# downloaded once into %LOCALAPPDATA%\ClaudePhases\stockfish. A Glicko-2 rating,
# as on Lichess, moves with each result and picks the next puzzle near it.
# Everything is saved after every change, so closing the window loses nothing.
#
# Its own process, owned by the chat's WezTerm window (-OwnerHwnd), like the
# other games. PowerShell names ignore case: constants are $UPPER_SNAKE so no
# local can shadow them, and no local reuses a parameter's name. Piece and
# colour logic stays in C#, where 'K' and 'k' differ. No PowerShell runs on a
# background thread: the engine, the download and the puzzle loader write
# fields that DispatcherTimers read. Kept to ASCII: every non-ASCII glyph is
# built from its code point.

param(
  [int64]$OwnerHwnd = 0,
  [string]$SessionId = 'default',
  [int]$Seed = 0,
  # Testing aids: check the rules and exit; play a puzzle through the real
  # handlers and exit; or draw the window to a PNG and exit.
  [switch]$SelfTest,
  [switch]$PlayTest,
  [string]$SnapshotPath = '',
  [ValidateSet('board', 'hint', 'wrong', 'review', 'picker', 'played', 'pieces')][string]$SnapshotView = 'board',
  [string]$SnapshotPuzzle = '',
  # A snapshot that saves to this file instead of chess.json, or, when the file
  # exists, opens from it: the real save-and-resume path, drawn.
  [string]$SnapshotSave = '',
  [ValidateSet('', 'normal', 'climb')][string]$SnapshotMode = '',
  # No Stockfish at all; or, in a snapshot, wait for the real one.
  [switch]$NoEngine,
  [switch]$UseEngine
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Send-Event($Event) {
  try {
    [Console]::Out.WriteLine(($Event | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
  } catch {}
}

# A failure inside a handler is written to %TEMP%\chess-error.log, so a broken
# step shows up somewhere instead of silently stopping the game.
function Write-Failure($Failure) {
  try {
    $text = "$([DateTime]::Now.ToString('s')) $($Failure.Exception.Message)`n$($Failure.ScriptStackTrace)`n"
    Add-Content -Path (Join-Path $env:TEMP 'chess-error.log') -Value $text -Encoding ASCII
  } catch {}
}

# --- The C# core, compiled once per version and kept as a DLL ---------------------
# Compiling it takes most of a second, and a DLL can't be loaded from the
# \\wsl.localhost path, so the build is cached under %LOCALAPPDATA%, one folder
# per source hash (the assembly keeps its name). Any trouble: compile in memory.

$CORE_REFERENCES = @('System.dll', 'System.Core.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll')
$CORE_SALT = 'chess-core-1'

function Import-Core {
  if ('ChessCore.Board' -as [type]) { return }
  $source = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'ChessCore.cs'), [System.Text.Encoding]::ASCII)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $salted = [System.Text.Encoding]::ASCII.GetBytes($source + $CORE_SALT + ($CORE_REFERENCES -join ',') + $PSVersionTable.PSVersion.Major)
  $hash = ([BitConverter]::ToString($sha.ComputeHash($salted))).Replace('-', '').Substring(0, 16)
  $cacheRoot = Join-Path $env:LOCALAPPDATA 'ClaudePhases\cache'
  $dir = Join-Path $cacheRoot $hash
  $dll = Join-Path $dir 'ChessCore.dll'
  try {
    if (-not [System.IO.File]::Exists($dll)) {
      [void][System.IO.Directory]::CreateDirectory($dir)
      $temp = Join-Path $dir "build-$PID.dll"
      Add-Type -TypeDefinition $source -ReferencedAssemblies $CORE_REFERENCES -OutputAssembly $temp -OutputType Library
      # Copied, not moved: the compile may still hold the file it wrote.
      if (-not [System.IO.File]::Exists($dll)) { Copy-Item -LiteralPath $temp -Destination $dll -ErrorAction SilentlyContinue }
      Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue
    }
    if (-not ('ChessCore.Board' -as [type])) { Add-Type -Path $dll }
    foreach ($old in [System.IO.Directory]::GetDirectories($cacheRoot)) {
      if ((Split-Path $old -Leaf) -ne $hash) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
    }
  } catch {
    Write-Failure $_
    if (-not ('ChessCore.Board' -as [type])) { Add-Type -TypeDefinition $source -ReferencedAssemblies $CORE_REFERENCES }
  }
}

Import-Core

# --- Self-test: the rules, checked without a window --------------------------------

if ($SelfTest) {
  $checks = [ordered]@{}
  function Test-Perft([string]$Fen, [long[]]$Counts) {
    $start = [ChessCore.Board]::FromFen($Fen)
    for ($depth = 1; $depth -le $Counts.Length; $depth++) {
      if ([ChessCore.Board]::Perft($start, $depth) -ne $Counts[$depth - 1]) { return $false }
    }
    return $true
  }
  $checks.perftStart = Test-Perft 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' @(20, 400, 8902, 197281)
  $checks.perftKiwipete = Test-Perft 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' @(48, 2039, 97862)
  $checks.perftEndgame = Test-Perft '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1' @(14, 191, 2812, 43238)
  $checks.perftPromotions = Test-Perft 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1' @(6, 264, 9467)
  $checks.perftCastles = Test-Perft 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8' @(44, 1486, 62379)

  $fens = @('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1')
  $checks.fenRoundTrip = @($fens | Where-Object { [ChessCore.Board]::FromFen($_).ToFen() -ne $_ }).Count -eq 0
  $kiwi = [ChessCore.Board]::FromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1')
  $sanOk = $true
  foreach ($m in $kiwi.LegalMoves()) {
    $back = $kiwi.ParseSan($kiwi.San($m))
    if (-not $back -or $back.Uci() -ne $m.Uci()) { $sanOk = $false }
  }
  $checks.sanRoundTrip = $sanOk
  $twoKnights = [ChessCore.Board]::FromFen('4k3/8/8/8/8/2N3N1/8/4K3 w - - 0 1')
  $checks.sanDisambiguates = $twoKnights.San($twoKnights.ParseUci('c3e4')) -ceq 'Nce4'
  $passant = [ChessCore.Board]::FromFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2')
  $checks.sanEnPassant = $passant.San($passant.ParseUci('e5d6')) -ceq 'exd6'
  $promote = [ChessCore.Board]::FromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1')
  $checks.sanPromotionCheck = $promote.San($promote.ParseUci('a7a8q')) -ceq 'a8=Q+'
  $castle = [ChessCore.Board]::FromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1')
  $checks.altCastle = $castle.ParseUci('e1h1').Uci() -eq 'e1g1' -and $castle.San($castle.ParseUci('e1c1')) -ceq 'O-O-O'

  $store = [ChessCore.PuzzleStore]::Load((Join-Path $PSScriptRoot 'ChessPuzzles.txt'))
  $problems = [ChessCore.PuzzleCheck]::Problems($store)
  $checks.puzzlesLoaded = $store.Count -gt 20000
  $checks.puzzlesLegal = $problems.Length -eq 0
  $checks.puzzleProblems = @($problems | Select-Object -First 5)

  # Glickman's worked example (tau 0.5): 1500/200/0.06 beats 1400/30, loses to 1550/100 and 1700/300.
  $player = New-Object ChessCore.GlickoRating
  $player.Rating = 1500; $player.Deviation = 200; $player.Volatility = 0.06
  $paper = [ChessCore.Glicko2]::UpdateMany($player, [double[]]@(1400, 1550, 1700), [double[]]@(30, 100, 300), [double[]]@(1, 0, 0), 0.5)
  $checks.glickoPaper = [Math]::Abs($paper.Rating - 1464.06) -lt 0.05 -and [Math]::Abs($paper.Deviation - 151.52) -lt 0.05 -and [Math]::Abs($paper.Volatility - 0.05999) -lt 0.0001
  $fresh = New-Object ChessCore.GlickoRating
  $win1 = [ChessCore.Glicko2]::Update($fresh, 1500, 75, 1)
  $half = [ChessCore.Glicko2]::Update($fresh, 1500, 75, 0.5)
  $loss = [ChessCore.Glicko2]::Update($fresh, 1500, 75, 0)
  $checks.glickoOrder = $win1.Rating -gt $half.Rating -and $half.Rating -gt $loss.Rating -and $win1.Deviation -ge 45

  # The narrator on pinned puzzles: each fact must name the squares it is about.
  function Get-Note([string]$Id, [int]$Ply) {
    $puzzle = $store.Get($Id)
    $position = [ChessCore.Board]::FromFen($puzzle.Fen)
    for ($k = 0; $k -lt $Ply; $k++) { $position = $position.Play($position.ParseUci($puzzle.Moves[$k])) }
    $move = $position.ParseUci($puzzle.Moves[$Ply])
    return [ChessCore.Narrator]::Describe($position, $move, $null)
  }
  $mateNote = Get-Note '0YtJI' 1
  $checks.narratorBackRank = $mateNote.Has('mate') -and $mateNote.Text.Contains('g8')
  $checks.narratorFork = (Get-Note 'Qroza' 1).Kinds.Count -gt 0
  $mate = [ChessCore.Board]::FromFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1')
  $mated = $mate.Play($mate.ParseUci('a1a8'))
  $why = [ChessCore.Narrator]::MateExplanation($mated)
  $checks.mateExplanation = $why.Contains('f7, g7 and h7 are blocked by its own pawns') -and $why.Contains('covered by the rook on a8')
  $fork = [ChessCore.Board]::FromFen('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1')
  $forkNote = [ChessCore.Narrator]::Describe($fork, $fork.ParseUci('b5c7'), $null)
  $checks.forkNamesBoth = $forkNote.Has('fork') -and $forkNote.Text.Contains('the king on e8') -and $forkNote.Text.Contains('the rook on a8')
  $pin = [ChessCore.Board]::FromFen('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1')
  $checks.pinToKing = ([ChessCore.Narrator]::Describe($pin, $pin.ParseUci('f1b5'), $null)).Text.Contains('Pins the knight on c6 to the king')
  $quiet = [ChessCore.Board]::FromFen('6k1/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 1')
  $checks.ideaNullWhenUnconfirmed = $null -eq [ChessCore.Narrator]::IdeaHint($quiet, $quiet.ParseUci('h7h6'), $null, [string[]]@('clearance'), 2)
  $race = [ChessCore.Board]::FromFen('8/8/2k5/8/p7/8/8/6K1 b - - 0 1')
  $checks.ruleOfTheSquare = ([ChessCore.Narrator]::Describe($race, $race.ParseUci('a4a3'), $null)).Has('outrunsKing')

  # The picker widens toward rare ratings and falls back to the whole set.
  $lines = @('a1|4k3/8/8/8/8/8/8/4K3 w - - 0 1|e1e2 e8e7|2150|70|90|500|zugzwang|x', 'a2|4k3/8/8/8/8/8/8/4K3 w - - 0 1|e1e2 e8e7|1000|70|90|500|fork|x', 'a3|4k3/8/8/8/8/8/8/4K3 w - - 0 1|e1e2 e8e7|1050|70|90|500|fork|x')
  $tiny = [ChessCore.PuzzleStore]::FromLines([string[]]$lines)
  $none = New-Object 'System.Collections.Generic.HashSet[string]'
  $rng = New-Object System.Random(1)
  $far = $tiny.Pick('zugzwang', 1000, $none, $rng)
  $checks.pickWidens = $far.Puzzle.Id -eq 'a1' -and $far.Window -ge 1100
  $gone = New-Object 'System.Collections.Generic.HashSet[string]'
  [void]$gone.Add('a1')
  $mixed = $tiny.Pick('zugzwang', 1000, $gone, $rng)
  $checks.pickFallsBackToMix = $mixed.FellBackToMix -and $mixed.Puzzle.Id -ne 'a1'

  $parsed = New-Object ChessCore.UciResult
  [ChessCore.UciEngine]::ParseInfo('info depth 18 seldepth 24 multipv 1 score cp -35 nodes 1000 pv e2e4 e7e5 g1f3', $parsed)
  $mateLine = New-Object ChessCore.UciResult
  [ChessCore.UciEngine]::ParseInfo('info depth 9 score mate -2 pv h7h8 g7g8', $mateLine)
  $checks.uciParse = $parsed.ScoreCp -eq -35 -and $parsed.Depth -eq 18 -and $parsed.Pv.Length -eq 3 -and $parsed.Pv[1] -eq 'e7e5'
  $checks.uciMate = $mateLine.IsMate -and $mateLine.MateIn -eq -2 -and $mateLine.Value -eq -99998

  $failed = @($checks.Keys | Where-Object { $checks[$_] -is [bool] -and -not $checks[$_] })
  $checks.ok = $failed.Count -eq 0
  $checks.failed = $failed
  Send-Event $checks
  if ($checks.ok) { exit 0 } else { exit 1 }
}

# --- One window per chat ------------------------------------------------------------

[void][ChessCore.ChessWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$WINDOW_TITLE = "ClaudeChess:$SessionId"
$mutex = New-Object System.Threading.Mutex($false, "Local\ClaudeChess-$SessionId")
try {
  $isOwner = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $isOwner = $true
}
if (-not $isOwner -and -not $SnapshotPath -and -not $PlayTest) {
  $existing = [ChessCore.ChessWin32]::WindowByText($WINDOW_TITLE)
  if ($existing -ne [IntPtr]::Zero) { [void][ChessCore.ChessWin32]::SetForegroundWindow($existing) }
  exit 0
}

# The puzzles load on their own thread while the window is built.
$puzzleLoader = [ChessCore.PuzzleLoader]::Begin((Join-Path $PSScriptRoot 'ChessPuzzles.txt'))

$owner = [IntPtr]$OwnerHwnd
$hasOwner = $owner -ne [IntPtr]::Zero -and [ChessCore.ChessWin32]::IsWindow($owner)

$GLYPH_CLOSE = [string][char]0x2715
$GLYPH_GRIP = [string][char]0x25E2
$GLYPH_DOT = [string][char]0x00B7
$GLYPH_DOWN = [string][char]0x25BE
$GLYPH_LEFT = [string][char]0x2190
$GLYPH_RIGHT = [string][char]0x2192
$GLYPH_LINK = [string][char]0x2197
$MIN_SCALE = 0.6
$MAX_SCALE = 2.2
$SQUARE_PX = 52
$BOARD_PX = 8 * $SQUARE_PX
$SIDE_W = 292
$SLIDE_MS = 170
$SETUP_MS = 450
$REPLY_MS = 400
$REFUTE_MS = 1900
$FALLBACK_MS = 1400
$FEED_MAX = 60
$HISTORY_MAX = 60
$RETRY_GAP = 20
$LIST_THRESHOLD = 60
$PROVISIONAL_RD = 110
# Glicko-2 starts unsure (deviation 500), so one early result could move the
# rating by hundreds; no single puzzle moves it more than this.
$MAX_RATING_STEP = 200
# Climb mode: its own level, started low, a fixed step up for a clean solve and a
# bigger one down for a miss, so it settles where about 2 in 3 are solved.
$CLIMB_START = 600
$CLIMB_UP = 50
$CLIMB_DOWN = 100
$CLIMB_MIN = 400
$CLIMB_MAX = 3000
$SKIP_CONFIRM_MS = 3000
$ENGINE_DIR = Join-Path $env:LOCALAPPDATA 'ClaudePhases\stockfish'
$DIFFICULTIES = @(
  @{ key = 'easiest'; label = 'Easiest'; offset = -600 }
  @{ key = 'easier'; label = 'Easier'; offset = -300 }
  @{ key = 'normal'; label = 'Normal'; offset = 0 }
  @{ key = 'harder'; label = 'Harder'; offset = 300 }
  @{ key = 'hardest'; label = 'Hardest'; offset = 600 }
)
# Light and dark squares; brown is Lichess's default board.
$BOARD_LOOKS = [ordered]@{
  brown = @('#F0D9B5', '#B58863')
  blue = @('#DEE3E6', '#8CA2AD')
  green = @('#FFFFDD', '#86A666')
  grey = @('#DCDCDC', '#ABABAB')
}
$THEME_GROUPS = [ordered]@{ tactics = 'Tactics'; mates = 'Mates'; phases = 'Phases and endgames'; length = 'Length'; special = 'Game source' }

# --- What the person left: where, how big, settings, rating, the puzzle -------------

$prefsFile = if ($SnapshotSave) { $SnapshotSave } else { Join-Path $env:LOCALAPPDATA 'ClaudePhases\chess.json' }
$script:offset = $null
$script:scale = 1.0
$script:settings = @{ theme = 'mix'; difficulty = 'normal'; board = 'brown'; mode = 'normal' }
$script:climb = @{ level = $CLIMB_START; best = $CLIMB_START; games = 0; history = (New-Object System.Collections.Generic.List[double]) }
$script:rating = @{ r = 1500.0; rd = 500.0; vol = 0.09; games = 0; history = (New-Object System.Collections.Generic.List[double]) }
$script:solved = New-Object 'System.Collections.Generic.HashSet[string]'
$script:retry = New-Object System.Collections.Generic.List[object]
$script:counter = 0
$script:engineFailedAt = ''
$savedPuzzle = $null
$savedSettings = $null

# The main file, or its backup when the main one is missing or broken.
function Read-SavedJson {
  foreach ($path in @($prefsFile, "$prefsFile.bak")) {
    $text = [ChessCore.SafeFile]::Read($path)
    if (-not $text) { continue }
    try { return ($text | ConvertFrom-Json) } catch {}
  }
  return $null
}

function Get-Clamped([double]$Value, [double]$Low, [double]$High, [double]$Fallback) {
  if ([double]::IsNaN($Value) -or $Value -lt $Low -or $Value -gt $High) { return $Fallback }
  return $Value
}

# Each part is read on its own: a bad part is dropped alone, never the rating.
$saved = $null
if ((-not $SnapshotPath -or $SnapshotSave) -and -not $PlayTest) { $saved = Read-SavedJson }
if ($saved) {
  try {
    if ($null -ne $saved.dx) { $script:offset = @{ dx = [int]$saved.dx; dy = [int]$saved.dy } }
    if ($saved.scale) { $script:scale = [Math]::Max([double]$MIN_SCALE, [Math]::Min([double]$MAX_SCALE, [double]$saved.scale)) }
  } catch {}
  try {
    $r = $saved.rating
    if ($r) {
      $script:rating.r = Get-Clamped ([double]$r.r) 100 4000 1500
      $script:rating.rd = Get-Clamped ([double]$r.rd) 30 500 500
      $script:rating.vol = Get-Clamped ([double]$r.vol) 0.01 1 0.09
      $script:rating.games = [int](Get-Clamped ([double]$r.games) 0 10000000 0)
      foreach ($point in $r.history) {
        $value = [double]$point
        if ($value -ge 100 -and $value -le 4000) { $script:rating.history.Add($value) }
      }
    }
  } catch {}
  try {
    $c = $saved.climb
    if ($c) {
      $script:climb.level = [int](Get-Clamped ([double]$c.level) $CLIMB_MIN $CLIMB_MAX $CLIMB_START)
      $script:climb.best = [int](Get-Clamped ([double]$c.best) $CLIMB_MIN $CLIMB_MAX $script:climb.level)
      $script:climb.games = [int](Get-Clamped ([double]$c.games) 0 10000000 0)
      foreach ($point in $c.history) {
        $value = [double]$point
        if ($value -ge $CLIMB_MIN -and $value -le $CLIMB_MAX) { $script:climb.history.Add($value) }
      }
    }
  } catch {}
  try { foreach ($id in ([string]$saved.solved).Split(' ')) { if ($id) { [void]$script:solved.Add($id) } } } catch {}
  try { $script:counter = [int](Get-Clamped ([double]$saved.counter) 0 10000000 0) } catch {}
  try {
    foreach ($entry in $saved.retry) {
      if (-not $entry.id) { continue }
      $from = if ([string]$entry.mode -eq 'climb') { 'climb' } else { 'normal' }
      $script:retry.Add(@{ id = [string]$entry.id; due = [int]$entry.due; mode = $from })
    }
  } catch {}
  try { if ($saved.engineFailedAt) { $script:engineFailedAt = [string]$saved.engineFailedAt } } catch {}
  $savedSettings = $saved.settings
  $savedPuzzle = $saved.puzzle
}
while ($script:rating.history.Count -gt $HISTORY_MAX) { $script:rating.history.RemoveAt(0) }
while ($script:climb.history.Count -gt $HISTORY_MAX) { $script:climb.history.RemoveAt(0) }

function Save-Prefs {
  # Test runs leave the person's game alone.
  if (($SnapshotPath -and -not $SnapshotSave) -or $PlayTest) { return }
  try {
    $prefs = [ordered]@{
      version = 1
      scale = [Math]::Round($script:scale, 3)
      settings = $script:settings
      rating = @{
        r = [Math]::Round($script:rating.r, 2); rd = [Math]::Round($script:rating.rd, 2)
        vol = [Math]::Round($script:rating.vol, 6); games = $script:rating.games
        history = $script:rating.history.ToArray()
      }
      climb = @{ level = $script:climb.level; best = $script:climb.best; games = $script:climb.games; history = $script:climb.history.ToArray() }
      solved = ($script:solved -join ' ')
      counter = $script:counter
      retry = $script:retry.ToArray()
      engineFailedAt = $script:engineFailedAt
    }
    if ($script:offset) { $prefs.dx = $script:offset.dx; $prefs.dy = $script:offset.dy }
    if ($script:p) { $prefs.puzzle = Get-PuzzleSave }
    [ChessCore.SafeFile]::WriteAtomic($prefsFile, ($prefs | ConvertTo-Json -Compress -Depth 6))
  } catch { Write-Failure $_ }
}

# --- The window ---------------------------------------------------------------

function Brush([string]$Hex) { return [System.Windows.Media.BrushConverter]::new().ConvertFromString($Hex) }
function ConvertTo-Color([string]$Hex) { return [System.Windows.Media.ColorConverter]::ConvertFromString($Hex) }
$ink = Brush '#E8E6E3'
$dim = Brush '#8B8A88'
$faint = Brush '#5E5D5B'
$accent = Brush '#E08A5F'
$green = Brush '#5FB98A'
$red = Brush '#E0696B'
$gold = Brush '#E6BE47'
$blue = Brush '#7FB2E5'
$surface = Brush '#2B2C31'
$noFill = [System.Windows.Media.Brushes]::Transparent
$font = New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas')
# The squares' brushes change colour in place, so a new board colour repaints at once.
$lightBrush = New-Object System.Windows.Media.SolidColorBrush (ConvertTo-Color '#F0D9B5')
$darkBrush = New-Object System.Windows.Media.SolidColorBrush (ConvertTo-Color '#B58863')
# Lichess's own highlight colours.
$lastMoveFill = Brush '#699BC700'
$selectedFill = Brush '#8014551E'
$destFill = Brush '#8014551E'
$hintFill = Brush '#A0E6BE47'
$wrongFill = Brush '#90E0696B'
$hoverFill = Brush '#7067A3E0'
$arrowFill = Brush '#CC15781B'

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

function New-Button([string]$Text, $Background, $Foreground) {
  $button = New-Object System.Windows.Controls.Border
  $button.Background = $Background
  $button.CornerRadius = New-Object System.Windows.CornerRadius(5)
  $button.Padding = New-Gap 12 5 12 6
  $button.Cursor = [System.Windows.Input.Cursors]::Hand
  $label = New-Text $Text $Foreground
  $label.FontWeight = 'Bold'
  $label.HorizontalAlignment = 'Center'
  $button.Child = $label
  return $button
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

# Header: the name, the rating with its recent curve, the close mark. Dragging it moves the window.
$header = New-Object System.Windows.Controls.DockPanel
$header.Cursor = [System.Windows.Input.Cursors]::SizeAll
$header.Background = $noFill
$titleText = New-Text 'Puzzles' $accent
$titleText.FontSize = 22
$titleText.FontWeight = 'Bold'
$titleText.VerticalAlignment = 'Center'
[System.Windows.Controls.DockPanel]::SetDock($titleText, 'Left')
$closeText = New-Text $GLYPH_CLOSE $dim
$closeText.Margin = New-Gap 12 0 0 0
$closeText.VerticalAlignment = 'Top'
$closeText.Cursor = [System.Windows.Input.Cursors]::Hand
[System.Windows.Controls.DockPanel]::SetDock($closeText, 'Right')

$ratingBox = New-Object System.Windows.Controls.Border
$ratingBox.Background = $surface
$ratingBox.CornerRadius = New-Object System.Windows.CornerRadius(5)
$ratingBox.Padding = New-Gap 10 3 10 4
$ratingBox.MinWidth = 70
$ratingBox.ToolTip = 'Your puzzle rating (Glicko-2, as on Lichess). A ? means it is still settling.'
[System.Windows.Controls.DockPanel]::SetDock($ratingBox, 'Right')
$ratingInside = New-Object System.Windows.Controls.StackPanel
$ratingLabel = New-Text 'RATING' $dim
$ratingLabel.FontSize = 9
$ratingLabel.HorizontalAlignment = 'Center'
$ratingNumber = New-Text '1500' $ink
$ratingNumber.FontSize = 15
$ratingNumber.FontWeight = 'Bold'
$ratingNumber.HorizontalAlignment = 'Center'
[void]$ratingInside.Children.Add($ratingLabel)
[void]$ratingInside.Children.Add($ratingNumber)
$ratingLayers = New-Object System.Windows.Controls.Grid
[void]$ratingLayers.Children.Add($ratingInside)
$ratingFlash = New-Text '' $green
$ratingFlash.FontSize = 13
$ratingFlash.FontWeight = 'Bold'
$ratingFlash.HorizontalAlignment = 'Center'
$ratingFlash.VerticalAlignment = 'Bottom'
$ratingFlash.Opacity = 0
$ratingFlash.IsHitTestVisible = $false
$ratingFlash.RenderTransform = New-Object System.Windows.Media.TranslateTransform(0, 0)
[void]$ratingLayers.Children.Add($ratingFlash)
$ratingBox.Child = $ratingLayers

$sparkHost = New-Object System.Windows.Controls.Canvas
$sparkHost.Width = 96
$sparkHost.Height = 26
$sparkHost.Margin = New-Gap 0 0 10 0
$sparkHost.VerticalAlignment = 'Center'
$sparkHost.ToolTip = 'Your rating over the last puzzles'
[System.Windows.Controls.DockPanel]::SetDock($sparkHost, 'Right')
$sparkLine = New-Object System.Windows.Shapes.Polyline
$sparkLine.Stroke = $accent
$sparkLine.StrokeThickness = 1.5
$sparkLine.StrokeLineJoin = 'Round'
[void]$sparkHost.Children.Add($sparkLine)

[void]$header.Children.Add($titleText)
[void]$header.Children.Add($closeText)
[void]$header.Children.Add($ratingBox)
[void]$header.Children.Add($sparkHost)
[void]$header.Children.Add((New-Object System.Windows.Controls.Border))

# --- The board: squares, coordinates, marks, dots, pieces, arrow, pickers -----------

$boardHost = New-Object System.Windows.Controls.Grid
$boardHost.Width = $BOARD_PX
$boardHost.Height = $BOARD_PX
$boardHost.ClipToBounds = $true
$boardHost.Background = $noFill
$boardFrame = New-Object System.Windows.Controls.Border
$boardFrame.CornerRadius = New-Object System.Windows.CornerRadius(4)
$boardFrame.ClipToBounds = $true
$boardFrame.Child = $boardHost
$boardFrame.Margin = New-Gap 0 12 0 0
$boardFrame.VerticalAlignment = 'Top'

function New-Layer {
  $layer = New-Object System.Windows.Controls.Canvas
  $layer.Width = $BOARD_PX
  $layer.Height = $BOARD_PX
  [void]$boardHost.Children.Add($layer)
  return $layer
}
$squareLayer = New-Layer
$markLayer = New-Layer
$dotLayer = New-Layer
$pieceLayer = New-Layer
$coordLayer = New-Layer
$arrowLayer = New-Layer
$promoLayer = New-Layer
foreach ($layer in @($markLayer, $coordLayer, $dotLayer, $arrowLayer)) { $layer.IsHitTestVisible = $false }
$pieceLayer.IsHitTestVisible = $false

$veil = New-Object System.Windows.Controls.Border
$veil.Background = Brush '#661C1D20'
$veil.Visibility = 'Collapsed'
$veil.IsHitTestVisible = $false
$veilText = New-Text '' $ink
$veilText.FontSize = 14
$veilText.FontWeight = 'Bold'
$veilText.HorizontalAlignment = 'Center'
$veilText.VerticalAlignment = 'Center'
$veilBack = New-Object System.Windows.Controls.Border
$veilBack.Background = Brush '#E61C1D20'
$veilBack.CornerRadius = New-Object System.Windows.CornerRadius(6)
$veilBack.Padding = New-Gap 14 8 14 9
$veilBack.HorizontalAlignment = 'Center'
$veilBack.VerticalAlignment = 'Center'
$veilBack.Child = $veilText
$veil.Child = $veilBack
[void]$boardHost.Children.Add($veil)

$script:flipped = $false
$script:squares = New-Object 'System.Windows.Shapes.Rectangle[]' 64
for ($sq = 0; $sq -lt 64; $sq++) {
  $rect = New-Object System.Windows.Shapes.Rectangle
  $rect.Width = $SQUARE_PX
  $rect.Height = $SQUARE_PX
  if ((([Math]::Floor($sq / 8)) + ($sq % 8)) % 2 -eq 0) { $rect.Fill = $darkBrush } else { $rect.Fill = $lightBrush }
  $script:squares[$sq] = $rect
  [void]$squareLayer.Children.Add($rect)
}

function Get-SquareX([int]$Square) {
  if ($script:flipped) { return (7 - ($Square % 8)) * $SQUARE_PX }
  return ($Square % 8) * $SQUARE_PX
}
function Get-SquareY([int]$Square) {
  $rank = [Math]::Floor($Square / 8)
  if ($script:flipped) { return $rank * $SQUARE_PX }
  return (7 - $rank) * $SQUARE_PX
}
function Get-SquareAt([double]$X, [double]$Y) {
  if ($X -lt 0 -or $Y -lt 0 -or $X -ge $BOARD_PX -or $Y -ge $BOARD_PX) { return -1 }
  $column = [int][Math]::Floor($X / $SQUARE_PX)
  $row = [int][Math]::Floor($Y / $SQUARE_PX)
  if ($script:flipped) { return $row * 8 + (7 - $column) }
  return (7 - $row) * 8 + $column
}

# Squares and coordinates follow the board's orientation; the solver sits at the bottom.
function Set-Orientation([bool]$Flipped) {
  $script:flipped = $Flipped
  for ($sq = 0; $sq -lt 64; $sq++) {
    [System.Windows.Controls.Canvas]::SetLeft($script:squares[$sq], (Get-SquareX $sq))
    [System.Windows.Controls.Canvas]::SetTop($script:squares[$sq], (Get-SquareY $sq))
  }
  $coordLayer.Children.Clear()
  for ($k = 0; $k -lt 8; $k++) {
    # Files along the bottom edge, ranks down the left edge, in the other square's colour.
    $fileSquare = if ($Flipped) { 56 + (7 - $k) } else { $k }
    $rankSquare = if ($Flipped) { $k * 8 + 7 } else { (7 - $k) * 8 }
    $fileText = New-Text ([string][char](97 + ($fileSquare % 8))) $(if ($script:squares[$fileSquare].Fill -eq $darkBrush) { $lightBrush } else { $darkBrush })
    $fileText.FontSize = 10
    $fileText.FontWeight = 'Bold'
    [System.Windows.Controls.Canvas]::SetLeft($fileText, $k * $SQUARE_PX + $SQUARE_PX - 9)
    [System.Windows.Controls.Canvas]::SetTop($fileText, $BOARD_PX - 14)
    [void]$coordLayer.Children.Add($fileText)
    $rankText = New-Text ([string](1 + [Math]::Floor($rankSquare / 8))) $(if ($script:squares[$rankSquare].Fill -eq $darkBrush) { $lightBrush } else { $darkBrush })
    $rankText.FontSize = 10
    $rankText.FontWeight = 'Bold'
    [System.Windows.Controls.Canvas]::SetLeft($rankText, 3)
    [System.Windows.Controls.Canvas]::SetTop($rankText, $k * $SQUARE_PX + 1)
    [void]$coordLayer.Children.Add($rankText)
  }
}

function Set-BoardColour([string]$Name) {
  if (-not $BOARD_LOOKS.Contains($Name)) { $Name = 'brown' }
  $script:settings.board = $Name
  $lightBrush.Color = ConvertTo-Color $BOARD_LOOKS[$Name][0]
  $darkBrush.Color = ConvertTo-Color $BOARD_LOOKS[$Name][1]
  if ($boardSwatchLight) {
    $boardSwatchLight.Background = Brush $BOARD_LOOKS[$Name][0]
    $boardSwatchDark.Background = Brush $BOARD_LOOKS[$Name][1]
  }
}

# --- Pieces: Lichess's cburnett set, drawn from ChessPieces.txt ---------------------

$PIECE_CODES = @{ wP = 1; wN = 2; wB = 3; wR = 4; wQ = 5; wK = 6; bP = -1; bN = -2; bB = -3; bR = -4; bQ = -5; bK = -6 }
$script:pieceArt = New-Object 'object[]' 13

function Get-LineCap([string]$Name) {
  switch ($Name) { 'round' { return [System.Windows.Media.PenLineCap]::Round } 'square' { return [System.Windows.Media.PenLineCap]::Square } default { return [System.Windows.Media.PenLineCap]::Flat } }
}
function Get-LineJoin([string]$Name) {
  switch ($Name) { 'round' { return [System.Windows.Media.PenLineJoin]::Round } 'bevel' { return [System.Windows.Media.PenLineJoin]::Bevel } default { return [System.Windows.Media.PenLineJoin]::Miter } }
}

function Import-PieceArt {
  $groups = @{}
  foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $PSScriptRoot 'ChessPieces.txt'), [System.Text.Encoding]::ASCII)) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $f = $line.Split('|')
    $code = $PIECE_CODES[$f[0]]
    if (-not $groups.ContainsKey($code)) {
      $group = New-Object System.Windows.Media.DrawingGroup
      $group.ClipGeometry = New-Object System.Windows.Media.RectangleGeometry((New-Object System.Windows.Rect(0, 0, 45, 45)))
      $groups[$code] = $group
    }
    $drawing = New-Object System.Windows.Media.GeometryDrawing
    $drawing.Geometry = [System.Windows.Media.Geometry]::Parse("$($f[7]) $($f[8])")
    if ($f[2] -ne 'none') { $drawing.Brush = Brush $f[2] }
    if ($f[3] -ne 'none') {
      $pen = New-Object System.Windows.Media.Pen((Brush $f[3]), [double]$f[4])
      $pen.StartLineCap = Get-LineCap $f[5]
      $pen.EndLineCap = Get-LineCap $f[5]
      $pen.LineJoin = Get-LineJoin $f[6]
      $pen.MiterLimit = 4
      $drawing.Pen = $pen
    }
    [void]$groups[$code].Children.Add($drawing)
  }
  foreach ($code in $groups.Keys) {
    $image = New-Object System.Windows.Media.DrawingImage($groups[$code])
    $image.Freeze()
    $script:pieceArt[$code + 6] = $image
  }
}
Import-PieceArt

function New-PieceImage([int]$Piece) {
  $image = New-Object System.Windows.Controls.Image
  $image.Source = $script:pieceArt[$Piece + 6]
  $image.Width = $SQUARE_PX
  $image.Height = $SQUARE_PX
  $image.IsHitTestVisible = $false
  return $image
}

$script:pieceViews = New-Object 'object[]' 64
$script:viewBoard = $null

# Draws a position whole: the only full redraw of the pieces.
function Show-Position($Position) {
  $script:viewBoard = $Position
  $pieceLayer.Children.Clear()
  for ($sq = 0; $sq -lt 64; $sq++) {
    $script:pieceViews[$sq] = $null
    $piece = [int]$Position.Squares[$sq]
    if ($piece -eq 0) { continue }
    $image = New-PieceImage $piece
    [System.Windows.Controls.Canvas]::SetLeft($image, (Get-SquareX $sq))
    [System.Windows.Controls.Canvas]::SetTop($image, (Get-SquareY $sq))
    [void]$pieceLayer.Children.Add($image)
    $script:pieceViews[$sq] = $image
  }
  Update-Marks
}

# --- Marks: last move, selection, check, hint, a wrong move, hovered squares ---------

$script:lastMove = $null
$script:selected = -1
$script:targets = @()
$script:hintSquare = -1
$script:arrow = $null
$script:wrongSquares = @()
$script:hoverSquares = @()

function Add-SquareMark([int]$Square, $Fill) {
  $rect = New-Object System.Windows.Shapes.Rectangle
  $rect.Width = $SQUARE_PX
  $rect.Height = $SQUARE_PX
  $rect.Fill = $Fill
  [System.Windows.Controls.Canvas]::SetLeft($rect, (Get-SquareX $Square))
  [System.Windows.Controls.Canvas]::SetTop($rect, (Get-SquareY $Square))
  [void]$markLayer.Children.Add($rect)
}

$checkGlow = New-Object System.Windows.Media.RadialGradientBrush
foreach ($stop in @(@('#FFFF0000', 0.0), @('#FFE70000', 0.25), @('#00A90000', 0.89), @('#009E0000', 1.0))) {
  $checkGlow.GradientStops.Add((New-Object System.Windows.Media.GradientStop((ConvertTo-Color $stop[0]), [double]$stop[1])))
}
$checkGlow.Freeze()

function Update-Marks {
  $markLayer.Children.Clear()
  $dotLayer.Children.Clear()
  $arrowLayer.Children.Clear()
  if ($script:lastMove) {
    Add-SquareMark $script:lastMove.From $lastMoveFill
    Add-SquareMark $script:lastMove.To $lastMoveFill
  }
  foreach ($sq in $script:wrongSquares) { Add-SquareMark $sq $wrongFill }
  if ($script:hintSquare -ge 0) { Add-SquareMark $script:hintSquare $hintFill }
  if ($script:selected -ge 0) { Add-SquareMark $script:selected $selectedFill }
  foreach ($sq in $script:hoverSquares) { Add-SquareMark $sq $hoverFill }
  $view = $script:viewBoard
  if ($view -and $view.InCheck()) {
    $king = $view.KingSquare($view.WhiteToMove)
    if ($king -ge 0) { Add-SquareMark $king $checkGlow }
  }
  foreach ($sq in $script:targets) {
    $dot = New-Object System.Windows.Shapes.Ellipse
    if ($view -and [int]$view.Squares[$sq] -ne 0) {
      # A capture: a ring round the square, as Lichess draws it.
      $dot.Width = $SQUARE_PX - 4
      $dot.Height = $SQUARE_PX - 4
      $dot.Stroke = $destFill
      $dot.StrokeThickness = 5
      [System.Windows.Controls.Canvas]::SetLeft($dot, (Get-SquareX $sq) + 2)
      [System.Windows.Controls.Canvas]::SetTop($dot, (Get-SquareY $sq) + 2)
    } else {
      $size = [Math]::Round($SQUARE_PX * 0.3)
      $dot.Width = $size
      $dot.Height = $size
      $dot.Fill = $destFill
      [System.Windows.Controls.Canvas]::SetLeft($dot, (Get-SquareX $sq) + ($SQUARE_PX - $size) / 2)
      [System.Windows.Controls.Canvas]::SetTop($dot, (Get-SquareY $sq) + ($SQUARE_PX - $size) / 2)
    }
    [void]$dotLayer.Children.Add($dot)
  }
  if ($script:arrow) { Show-Arrow $script:arrow.From $script:arrow.To }
}

# A Lichess-style green arrow from one square's centre to another's.
function Show-Arrow([int]$From, [int]$To) {
  $half = $SQUARE_PX / 2
  $x1 = (Get-SquareX $From) + $half; $y1 = (Get-SquareY $From) + $half
  $x2 = (Get-SquareX $To) + $half; $y2 = (Get-SquareY $To) + $half
  $length = [Math]::Sqrt(($x2 - $x1) * ($x2 - $x1) + ($y2 - $y1) * ($y2 - $y1))
  if ($length -lt 1) { return }
  $ux = ($x2 - $x1) / $length; $uy = ($y2 - $y1) / $length
  $head = $SQUARE_PX * 0.42
  $width = $SQUARE_PX * 0.16
  $tipX = $x2 - $ux * $SQUARE_PX * 0.12; $tipY = $y2 - $uy * $SQUARE_PX * 0.12
  $baseX = $tipX - $ux * $head; $baseY = $tipY - $uy * $head
  $shaft = New-Object System.Windows.Shapes.Line
  $shaft.X1 = $x1 + $ux * $SQUARE_PX * 0.2; $shaft.Y1 = $y1 + $uy * $SQUARE_PX * 0.2
  $shaft.X2 = $baseX; $shaft.Y2 = $baseY
  $shaft.Stroke = $arrowFill
  $shaft.StrokeThickness = $width
  $shaft.StrokeStartLineCap = 'Round'
  [void]$arrowLayer.Children.Add($shaft)
  $tipShape = New-Object System.Windows.Shapes.Polygon
  $tipShape.Fill = $arrowFill
  $points = New-Object System.Windows.Media.PointCollection
  $points.Add((New-Object System.Windows.Point($tipX, $tipY)))
  $points.Add((New-Object System.Windows.Point(($baseX - $uy * $head * 0.55), ($baseY + $ux * $head * 0.55))))
  $points.Add((New-Object System.Windows.Point(($baseX + $uy * $head * 0.55), ($baseY - $ux * $head * 0.55))))
  $tipShape.Points = $points
  [void]$arrowLayer.Children.Add($tipShape)
}

# --- Moving pieces on screen ---------------------------------------------------------

$script:animTarget = $null
$script:afterAnimation = $null
$script:isInstant = [bool]($SnapshotPath -or $PlayTest)
$animTimer = New-Object System.Windows.Threading.DispatcherTimer
$animTimer.Interval = [TimeSpan]::FromMilliseconds($SLIDE_MS + 15)
$animTimer.Add_Tick({ try { Complete-Animation } catch { Write-Failure $_ } })

function Start-Slide($Image, [int]$To) {
  if (-not $Image) { return }
  $time = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds($SLIDE_MS))
  $ease = New-Object System.Windows.Media.Animation.QuadraticEase
  $ease.EasingMode = 'EaseOut'
  $toX = New-Object System.Windows.Media.Animation.DoubleAnimation([double](Get-SquareX $To), $time)
  $toX.EasingFunction = $ease
  $toY = New-Object System.Windows.Media.Animation.DoubleAnimation([double](Get-SquareY $To), $time)
  $toY.EasingFunction = $ease
  [System.Windows.Controls.Panel]::SetZIndex($Image, 5)
  $Image.BeginAnimation([System.Windows.Controls.Canvas]::LeftProperty, $toX)
  $Image.BeginAnimation([System.Windows.Controls.Canvas]::TopProperty, $toY)
}

function Start-Fade($Image) {
  if (-not $Image) { return }
  $fade = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds($SLIDE_MS))))
  $Image.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
}

# Slides a move (or takes it back with -Reverse), then draws the result whole and
# runs Then. A new animation first finishes the one still running.
function Invoke-Animation($Before, $Move, [scriptblock]$Then, [switch]$Reverse) {
  Complete-Animation
  $after = $Before.Play($Move)
  $end = if ($Reverse) { $Before } else { $after }
  if ($script:isInstant) {
    Show-Position $end
    if ($Then) { & $Then }
    return
  }
  $rookFrom = -1; $rookTo = -1
  if ($Move.IsCastle) {
    if ($Move.To -gt $Move.From) { $rookFrom = $Move.From + 3; $rookTo = $Move.From + 1 } else { $rookFrom = $Move.From - 4; $rookTo = $Move.From - 1 }
  }
  if (-not $Reverse) {
    if ($script:viewBoard -ne $Before) { Show-Position $Before }
    $taken = $Move.To
    if ($Move.IsEnPassant) { $taken = if ($Before.WhiteToMove) { $Move.To - 8 } else { $Move.To + 8 } }
    if ($Move.IsCapture) { Start-Fade $script:pieceViews[$taken] }
    Start-Slide $script:pieceViews[$Move.From] $Move.To
    if ($rookFrom -ge 0) { Start-Slide $script:pieceViews[$rookFrom] $rookTo }
  } else {
    Show-Position $after
    Start-Slide $script:pieceViews[$Move.To] $Move.From
    if ($rookTo -ge 0) { Start-Slide $script:pieceViews[$rookTo] $rookFrom }
  }
  $script:animTarget = $end
  $script:afterAnimation = $Then
  $animTimer.Start()
}

function Complete-Animation {
  if (-not $animTimer.IsEnabled) { return }
  $animTimer.Stop()
  Show-Position $script:animTarget
  $then = $script:afterAnimation
  $script:afterAnimation = $null
  if ($then) { & $then }
}

# --- The side column: status, explanations, hints, settings -------------------------

$side = New-Object System.Windows.Controls.DockPanel
$side.Width = $SIDE_W
$side.Height = $BOARD_PX
$side.LastChildFill = $true

$infoLine = New-Object System.Windows.Controls.TextBlock
$infoLine.Foreground = $dim
$infoLine.FontSize = 11
$infoLine.TextTrimming = 'CharacterEllipsis'
[System.Windows.Controls.DockPanel]::SetDock($infoLine, 'Top')

$statusRow = New-Object System.Windows.Controls.StackPanel
$statusRow.Orientation = 'Horizontal'
$statusRow.Margin = New-Gap 0 4 0 6
[System.Windows.Controls.DockPanel]::SetDock($statusRow, 'Top')
$sideDot = New-Object System.Windows.Shapes.Ellipse
$sideDot.Width = 13
$sideDot.Height = 13
$sideDot.Stroke = $dim
$sideDot.StrokeThickness = 1
$sideDot.Margin = New-Gap 0 0 8 0
$sideDot.VerticalAlignment = 'Center'
$statusText = New-Text '' $ink
$statusText.FontSize = 16
$statusText.FontWeight = 'Bold'
[void]$statusRow.Children.Add($sideDot)
[void]$statusRow.Children.Add($statusText)

# Bottom: the solution's moves (in review), the buttons, the settings, the links.
$bottom = New-Object System.Windows.Controls.StackPanel
[System.Windows.Controls.DockPanel]::SetDock($bottom, 'Bottom')
$moveStrip = New-Object System.Windows.Controls.WrapPanel
$moveStrip.Margin = New-Gap 0 6 0 2
$moveStrip.Visibility = 'Collapsed'
$buttonRow = New-Object System.Windows.Controls.Grid
$buttonRow.Margin = New-Gap 0 8 0 0
foreach ($k in 0, 1) {
  $column = New-Object System.Windows.Controls.ColumnDefinition
  [void]$buttonRow.ColumnDefinitions.Add($column)
}
$hintButton = New-Button 'Hint' (Brush '#3A3B41') $ink
$hintButton.Margin = New-Gap 0 0 4 0
$hintButton.ToolTip = 'H. First the idea (half credit), then the piece, then the move (no credit).'
$nextButton = New-Button 'Next puzzle' $accent (Brush '#1C1D20')
$nextButton.Margin = New-Gap 4 0 0 0
$nextButton.ToolTip = 'N or Enter'
[System.Windows.Controls.Grid]::SetColumn($nextButton, 1)
[void]$buttonRow.Children.Add($hintButton)
[void]$buttonRow.Children.Add($nextButton)

# Normal: puzzles near your rating. Climb: start low and work your way up.
$modeRow = New-Object System.Windows.Controls.StackPanel
$modeRow.Orientation = 'Horizontal'
$modeRow.Margin = New-Gap 0 10 0 0
$modeLabel = New-Text 'Mode' $faint
$modeLabel.FontSize = 11
$modeLabel.Margin = New-Gap 0 2 4 2
[void]$modeRow.Children.Add($modeLabel)
$script:modeViews = @()
foreach ($choice in @(
    @{ key = 'normal'; label = 'Normal'; tip = 'Puzzles near your rating; the rating moves with each result.' }
    @{ key = 'climb'; label = 'Climb'; tip = "Start at $CLIMB_START and work up: +$CLIMB_UP for a clean solve, -$CLIMB_DOWN for a miss." })) {
  $pick = New-Pressable $choice.label $choice.key
  $pick.ToolTip = $choice.tip
  [void]$modeRow.Children.Add($pick)
  $script:modeViews += $pick
}
$climbNote = New-Text '' $dim
$climbNote.FontSize = 11
$climbNote.Margin = New-Gap 0 4 0 0
$climbNote.Visibility = 'Collapsed'

$difficultyRow = New-Object System.Windows.Controls.StackPanel
$difficultyRow.Orientation = 'Horizontal'
$difficultyRow.Margin = New-Gap 0 4 0 0
$difficultyRow.ToolTip = 'How far from your rating the next puzzle is picked'
$script:difficultyViews = @()
foreach ($level in $DIFFICULTIES) {
  $pick = New-Pressable $level.label $level.key
  $pick.FontSize = 11
  $pick.Padding = New-Gap 3 2 3 2
  [void]$difficultyRow.Children.Add($pick)
  $script:difficultyViews += $pick
}

$settingsRow = New-Object System.Windows.Controls.DockPanel
$settingsRow.Margin = New-Gap 0 6 0 0
$boardSwatch = New-Object System.Windows.Controls.StackPanel
$boardSwatch.Orientation = 'Horizontal'
$boardSwatch.Cursor = [System.Windows.Input.Cursors]::Hand
$boardSwatch.ToolTip = 'Board colour'
$boardSwatch.VerticalAlignment = 'Center'
$boardSwatch.Margin = New-Gap 8 0 0 0
[System.Windows.Controls.DockPanel]::SetDock($boardSwatch, 'Right')
$boardSwatchLight = New-Object System.Windows.Controls.Border
$boardSwatchDark = New-Object System.Windows.Controls.Border
foreach ($half in @($boardSwatchLight, $boardSwatchDark)) {
  $half.Width = 10
  $half.Height = 16
  [void]$boardSwatch.Children.Add($half)
}
$boardSwatchLight.CornerRadius = New-Object System.Windows.CornerRadius(3, 0, 0, 3)
$boardSwatchDark.CornerRadius = New-Object System.Windows.CornerRadius(0, 3, 3, 0)
$themeChip = New-Object System.Windows.Controls.Border
$themeChip.Background = $surface
$themeChip.CornerRadius = New-Object System.Windows.CornerRadius(5)
$themeChip.Padding = New-Gap 8 3 8 4
$themeChip.Cursor = [System.Windows.Input.Cursors]::Hand
$themeChip.ToolTip = 'Practise one theme, or a mix (T)'
$themeLabel = New-Text '' $ink
$themeLabel.TextTrimming = 'CharacterEllipsis'
$themeChip.Child = $themeLabel
[void]$settingsRow.Children.Add($boardSwatch)
[void]$settingsRow.Children.Add($themeChip)

$linkRow = New-Object System.Windows.Controls.StackPanel
$linkRow.Orientation = 'Horizontal'
$linkRow.Margin = New-Gap 0 6 0 0
$puzzleLink = New-Pressable "Lichess puzzle $GLYPH_LINK" 'puzzle'
$gameLink = New-Pressable "Source game $GLYPH_LINK" 'game'
foreach ($link in @($puzzleLink, $gameLink)) {
  $link.FontSize = 11
  $link.Padding = New-Gap 0 2 12 2
  [void]$linkRow.Children.Add($link)
}

[void]$bottom.Children.Add($moveStrip)
[void]$bottom.Children.Add($buttonRow)
[void]$bottom.Children.Add($modeRow)
[void]$bottom.Children.Add($difficultyRow)
[void]$bottom.Children.Add($climbNote)
[void]$bottom.Children.Add($settingsRow)
[void]$bottom.Children.Add($linkRow)

$feedScroll = New-Object System.Windows.Controls.ScrollViewer
$feedScroll.VerticalScrollBarVisibility = 'Hidden'
$feedScroll.Focusable = $false
$feedPanel = New-Object System.Windows.Controls.StackPanel
$feedScroll.Content = $feedPanel

[void]$side.Children.Add($infoLine)
[void]$side.Children.Add($statusRow)
[void]$side.Children.Add($bottom)
[void]$side.Children.Add($feedScroll)

# The theme picker covers the side column while open.
$picker = New-Object System.Windows.Controls.DockPanel
$picker.Width = $SIDE_W
$picker.Height = $BOARD_PX
$picker.Background = Brush '#1C1D20'
$picker.Visibility = 'Collapsed'
$searchHost = New-Object System.Windows.Controls.Grid
[System.Windows.Controls.DockPanel]::SetDock($searchHost, 'Top')
$searchBox = New-Object System.Windows.Controls.TextBox
$searchBox.Background = $surface
$searchBox.Foreground = $ink
$searchBox.CaretBrush = $accent
$searchBox.BorderThickness = New-Object System.Windows.Thickness(0)
$searchBox.FontFamily = $font
$searchBox.FontSize = 13
$searchBox.Padding = New-Gap 8 5 8 5
$searchHint = New-Text 'search themes...' $dim
$searchHint.FontSize = 13
$searchHint.Margin = New-Gap 11 5 0 0
$searchHint.IsHitTestVisible = $false
[void]$searchHost.Children.Add($searchBox)
[void]$searchHost.Children.Add($searchHint)
$pickerScroll = New-Object System.Windows.Controls.ScrollViewer
$pickerScroll.VerticalScrollBarVisibility = 'Hidden'
$pickerScroll.Margin = New-Gap 0 8 0 0
$pickerScroll.Focusable = $false
$pickerList = New-Object System.Windows.Controls.StackPanel
$pickerScroll.Content = $pickerList
[void]$picker.Children.Add($searchHost)
[void]$picker.Children.Add($pickerScroll)

$sideHost = New-Object System.Windows.Controls.Grid
$sideHost.Margin = New-Gap 14 12 0 0
[void]$sideHost.Children.Add($side)
[void]$sideHost.Children.Add($picker)

$body = New-Object System.Windows.Controls.StackPanel
$body.Orientation = 'Horizontal'
[void]$body.Children.Add($boardFrame)
[void]$body.Children.Add($sideHost)

$footer = New-Object System.Windows.Controls.DockPanel
$footer.Margin = New-Gap 0 10 0 0
$credits = New-Text 'Puzzles: Lichess (CC0) - Pieces: cburnett (GPLv2+)' $faint
$credits.FontSize = 10
$credits.VerticalAlignment = 'Center'
[System.Windows.Controls.DockPanel]::SetDock($credits, 'Right')
$keysText = New-Text "Drag or click $GLYPH_DOT H hint $GLYPH_DOT N next $GLYPH_DOT $GLYPH_LEFT $GLYPH_RIGHT replay $GLYPH_DOT T themes" $dim
$keysText.FontSize = 11
[void]$footer.Children.Add($credits)
[void]$footer.Children.Add($keysText)

$stack = New-Object System.Windows.Controls.StackPanel
[void]$stack.Children.Add($header)
[void]$stack.Children.Add($body)
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

# --- The puzzles, the glossary -------------------------------------------------------

$store = $puzzleLoader.Wait()
$script:glossary = [ordered]@{}
foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $PSScriptRoot 'ChessThemes.txt'), [System.Text.Encoding]::ASCII)) {
  if (-not $line -or $line.StartsWith('#')) { continue }
  $f = $line.Split('|')
  if ($f.Length -ne 4) { continue }
  $script:glossary[$f[0]] = @{ group = $f[1]; title = $f[2]; line = $f[3] }
}

function Get-ThemeTitle([string]$Key) {
  if (-not $Key -or $Key -eq 'mix') { return 'Mix' }
  if ($script:glossary.Contains($Key)) { return $script:glossary[$Key].title }
  return $Key
}

function Test-ThemeListed([string]$Key) {
  if ($Key -eq 'mix') { return $true }
  if (-not $script:glossary.Contains($Key)) { return $false }
  return $script:glossary[$Key].group -ne 'meta' -and $store.ThemeCount($Key) -ge $LIST_THRESHOLD
}

if ($savedSettings) {
  try {
    if ($savedSettings.theme -and (Test-ThemeListed ([string]$savedSettings.theme))) { $script:settings.theme = [string]$savedSettings.theme }
    if (@($DIFFICULTIES | Where-Object { $_.key -eq [string]$savedSettings.difficulty }).Count -eq 1) { $script:settings.difficulty = [string]$savedSettings.difficulty }
    if ($savedSettings.board -and $BOARD_LOOKS.Contains([string]$savedSettings.board)) { $script:settings.board = [string]$savedSettings.board }
    if ([string]$savedSettings.mode -eq 'climb') { $script:settings.mode = 'climb' }
  } catch {}
}

# --- Rating ----------------------------------------------------------------------------

# The mode of the puzzle on screen, or the one the next puzzle will use.
function Get-ShownMode {
  if ($script:p) { return $script:p.mode }
  return $script:settings.mode
}

function Update-Rating {
  if ((Get-ShownMode) -eq 'climb') {
    $ratingLabel.Text = 'LEVEL'
    $ratingNumber.Text = [string]$script:climb.level
    $ratingBox.ToolTip = "Climb level (best $($script:climb.best)): +$CLIMB_UP for a clean solve, -$CLIMB_DOWN for a miss."
    $points = $script:climb.history
  } else {
    $ratingLabel.Text = 'RATING'
    $shown = [string][int][Math]::Round($script:rating.r)
    if ($script:rating.rd -gt $PROVISIONAL_RD) { $shown += '?' }
    $ratingNumber.Text = $shown
    $ratingBox.ToolTip = 'Your puzzle rating (Glicko-2, as on Lichess). A ? means it is still settling.'
    $points = $script:rating.history
  }
  if ($script:modeViews) { Update-Mode }
  $line = New-Object System.Windows.Media.PointCollection
  $sparkLine.Points = $line
  if ($points.Count -lt 2) { return }
  $low = [double]::MaxValue; $high = [double]::MinValue
  foreach ($value in $points) { $low = [Math]::Min($low, $value); $high = [Math]::Max($high, $value) }
  $span = [Math]::Max(20.0, $high - $low)
  for ($k = 0; $k -lt $points.Count; $k++) {
    $x = $k * ($sparkHost.Width - 2) / ($points.Count - 1) + 1
    $y = ($sparkHost.Height - 3) - ($points[$k] - $low) / $span * ($sparkHost.Height - 6)
    $line.Add((New-Object System.Windows.Point($x, $y)))
  }
}

function Show-RatingFlash([int]$Delta) {
  $ratingFlash.Text = $(if ($Delta -ge 0) { "+$Delta" } else { "$Delta" })
  $ratingFlash.Foreground = $(if ($Delta -ge 0) { $green } else { $red })
  # A snapshot shows the change beside the number instead of rising out of it.
  if ($script:isInstant) { $ratingFlash.Opacity = 1; $ratingFlash.RenderTransform.X = -58; $ratingFlash.RenderTransform.Y = -12; return }
  $time = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(1600))
  $rise = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, -26.0, $time)
  $rise.EasingFunction = New-Object System.Windows.Media.Animation.QuadraticEase
  $fade = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0, $time)
  $ratingFlash.RenderTransform.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $rise)
  $ratingFlash.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
}

# The result is applied once per puzzle, the moment it is decided; retries don't count.
function Set-Result([double]$Score) {
  $p = $script:p
  if (-not $p -or -not $p.rated) { return }
  if ($p.result -and $p.result.applied) { return }
  if ($p.mode -eq 'climb') {
    $step = if ($Score -ge 1) { $CLIMB_UP } elseif ($Score -gt 0) { [int]($CLIMB_UP / 2) } else { -$CLIMB_DOWN }
    $old = $script:climb.level
    if ($script:climb.history.Count -eq 0) { $script:climb.history.Add($old) }
    $script:climb.level = [Math]::Max($CLIMB_MIN, [Math]::Min($CLIMB_MAX, $old + $step))
    $isBest = $script:climb.level -gt $script:climb.best
    if ($isBest) { $script:climb.best = $script:climb.level }
    $script:climb.games++
    $script:climb.history.Add($script:climb.level)
    while ($script:climb.history.Count -gt $HISTORY_MAX) { $script:climb.history.RemoveAt(0) }
    $p.result = @{ score = $Score; delta = $script:climb.level - $old; applied = $true; best = $isBest }
    Update-Rating
    Show-RatingFlash ($script:climb.level - $old)
    return
  }
  $player = New-Object ChessCore.GlickoRating
  $player.Rating = $script:rating.r
  $player.Deviation = $script:rating.rd
  $player.Volatility = $script:rating.vol
  $next = [ChessCore.Glicko2]::Update($player, [double]$p.puzzle.Rating, [double]$p.puzzle.Deviation, $Score)
  $next.Rating = [Math]::Max($script:rating.r - $MAX_RATING_STEP, [Math]::Min($script:rating.r + $MAX_RATING_STEP, $next.Rating))
  $delta = [int][Math]::Round($next.Rating - $script:rating.r)
  if ($script:rating.history.Count -eq 0) { $script:rating.history.Add([Math]::Round($script:rating.r, 1)) }
  $script:rating.r = $next.Rating
  $script:rating.rd = $next.Deviation
  $script:rating.vol = $next.Volatility
  $script:rating.games++
  $script:rating.history.Add([Math]::Round($next.Rating, 1))
  while ($script:rating.history.Count -gt $HISTORY_MAX) { $script:rating.history.RemoveAt(0) }
  $p.result = @{ score = $Score; delta = $delta; applied = $true }
  Update-Rating
  Show-RatingFlash $delta
}

# --- The explanation feed --------------------------------------------------------------

$FEED_LOOKS = @{
  info = @{ san = $dim; text = $dim; back = $null }
  progress = @{ san = $dim; text = $dim; back = $null }
  move = @{ san = $accent; text = $ink; back = $null }
  reply = @{ san = $dim; text = $dim; back = $null }
  wrong = @{ san = $red; text = $red; back = (Brush '#1FE0696B') }
  engine = @{ san = $blue; text = $ink; back = (Brush '#1A7FB2E5') }
  hint = @{ san = $gold; text = $gold; back = (Brush '#1AE6BE47') }
  summary = @{ san = $ink; text = $ink; back = $surface }
  theme = @{ san = $accent; text = $dim; back = $null }
}

function Add-FeedView($Entry) {
  $look = $FEED_LOOKS[[string]$Entry.kind]
  if (-not $look) { $look = $FEED_LOOKS.info }
  $box = New-Object System.Windows.Controls.Border
  $box.Padding = New-Gap 6 3 6 4
  $box.Margin = New-Gap 0 0 4 3
  $box.CornerRadius = New-Object System.Windows.CornerRadius(5)
  if ($look.back) { $box.Background = $look.back } else { $box.Background = $noFill }
  $block = New-Object System.Windows.Controls.TextBlock
  $block.TextWrapping = 'Wrap'
  if ($Entry.san) {
    $lead = New-Object System.Windows.Documents.Run(([string]$Entry.san + ' '))
    $lead.FontWeight = 'Bold'
    $lead.Foreground = $look.san
    $block.Inlines.Add($lead)
  }
  $rest = New-Object System.Windows.Documents.Run([string]$Entry.text)
  $rest.Foreground = $look.text
  $block.Inlines.Add($rest)
  $box.Child = $block
  $squares = [int[]]@($Entry.squares | Where-Object { $null -ne $_ } | ForEach-Object { [int]$_ })
  if ($squares.Length -gt 0) {
    $box.Tag = $squares
    $box.Add_MouseEnter({ param($sender, $e) try { $script:hoverSquares = [int[]]$sender.Tag; Update-Marks } catch { Write-Failure $_ } })
    $box.Add_MouseLeave({ param($sender, $e) try { $script:hoverSquares = @(); Update-Marks } catch { Write-Failure $_ } })
  }
  [void]$feedPanel.Children.Add($box)
  while ($feedPanel.Children.Count -gt $FEED_MAX) { $feedPanel.Children.RemoveAt(0) }
  $feedScroll.ScrollToEnd()
  return $block
}

function Add-Feed([string]$Kind, [string]$San, [string]$Text, $Squares) {
  $entry = @{ kind = $Kind; san = $San; text = $Text; squares = [int[]]@($Squares | Where-Object { $null -ne $_ }) }
  if ($Kind -ne 'progress') {
    $script:p.feed.Add($entry)
    while ($script:p.feed.Count -gt $FEED_MAX) { $script:p.feed.RemoveAt(0) }
  }
  return (Add-FeedView $entry)
}

function Clear-Feed {
  $feedPanel.Children.Clear()
  $script:progressLine = $null
}

# --- Status and info -------------------------------------------------------------------

function Set-Status([string]$Text, $Foreground) {
  $statusText.Text = $Text
  $statusText.Foreground = $Foreground
}

function Update-SideDot {
  $solverWhite = $script:p -and $script:p.solverWhite
  $sideDot.Fill = $(if ($solverWhite) { Brush '#F4F2EE' } else { Brush '#1A1A1A' })
}

function Update-Info {
  $p = $script:p
  if (-not $p) { $infoLine.Text = ''; return }
  $colour = if ($p.solverWhite) { 'White' } else { 'Black' }
  $label = "#$($p.puzzle.Id) $GLYPH_DOT $($p.puzzle.Rating) $GLYPH_DOT you play $colour"
  if (-not $p.rated) { $label += " $GLYPH_DOT unrated retry" } elseif ($p.mode -eq 'climb') { $label += " $GLYPH_DOT climb" }
  $infoLine.Text = $label
  $themeLabel.Text = "Theme: $(Get-ThemeTitle $script:settings.theme) $GLYPH_DOWN"
}

function Update-HintButton {
  $label = $hintButton.Child
  $p = $script:p
  if (-not $p -or $p.phase -ne 'play') { $hintButton.Opacity = 0.4; $label.Text = 'Hint'; return }
  $hintButton.Opacity = 1
  switch ([int]$p.hintNow) {
    0 { $label.Text = 'Hint' }
    1 { $label.Text = 'Hint: piece' }
    2 { $label.Text = 'Hint: move' }
    default { $label.Text = 'No more hints'; $hintButton.Opacity = 0.4 }
  }
}

function Update-Mode {
  foreach ($view in $script:modeViews) {
    if ($view.Tag -eq $script:settings.mode) { $view.Foreground = $accent; $view.FontWeight = 'Bold' } else { $view.Foreground = $dim; $view.FontWeight = 'Normal' }
  }
  if ($script:settings.mode -eq 'climb') {
    $difficultyRow.Visibility = 'Collapsed'
    $climbNote.Visibility = 'Visible'
    $climbNote.Text = "Best $($script:climb.best) $GLYPH_DOT +$CLIMB_UP a solve $GLYPH_DOT -$CLIMB_DOWN a miss"
  } else {
    $difficultyRow.Visibility = 'Visible'
    $climbNote.Visibility = 'Collapsed'
  }
}

function Update-Difficulty {
  foreach ($view in $script:difficultyViews) {
    if ($view.Tag -eq $script:settings.difficulty) { $view.Foreground = $accent; $view.FontWeight = 'Bold' } else { $view.Foreground = $dim; $view.FontWeight = 'Normal' }
  }
}

# --- A puzzle from start to end ----------------------------------------------------------
# $script:p holds the puzzle being played. step = how many of its moves are on the
# board (0 = not even the opponent's first move); line = the moves actually
# played, which can end in a different mate than the puzzle's own.

$script:p = $null
$script:analysis = $null
$script:skipAskedAt = [DateTime]::MinValue
$script:rng = if ($Seed -ne 0) { New-Object System.Random($Seed) } else { New-Object System.Random }

function Get-PuzzleSave {
  $p = $script:p
  $phase = if ($p.phase -eq 'review') { 'review' } else { 'play' }
  return [ordered]@{
    id = $p.puzzle.Id; mode = $p.mode; step = $p.step; line = $p.line.ToArray(); phase = $phase
    hint = $p.hint; hintNow = $p.hintNow; mistakes = $p.mistakes; pendingWrong = $p.pendingWrong
    rated = $p.rated; result = $p.result; reviewPly = $p.reviewPly
    feed = $p.feed.ToArray()
  }
}

# The position after the first Count moves of the line.
function Get-LineBoard([int]$Count) {
  $position = [ChessCore.Board]::FromFen($script:p.puzzle.Fen)
  for ($k = 0; $k -lt $Count; $k++) {
    $move = $position.ParseUci($script:p.line[$k])
    if (-not $move) { return $null }
    $position = $position.Play($move)
  }
  return $position
}

function New-PuzzleState($Puzzle, [bool]$Rated, [string]$Mode) {
  $start = [ChessCore.Board]::FromFen($Puzzle.Fen)
  if ($Mode -ne 'climb') { $Mode = 'normal' }
  return @{
    puzzle = $Puzzle; rated = $Rated; mode = $Mode; step = 0; phase = 'play'
    line = (New-Object System.Collections.Generic.List[string])
    hint = 0; hintNow = 0; mistakes = 0; pendingWrong = $null; result = $null; reviewPly = 0
    feed = (New-Object System.Collections.Generic.List[object])
    solverWhite = -not $start.WhiteToMove
  }
}

function Set-PuzzleView {
  $p = $script:p
  Set-Orientation (-not $p.solverWhite)
  Update-SideDot
  Update-Info
  Update-Rating
  $moveStrip.Visibility = 'Collapsed'
  $moveStrip.Children.Clear()
  $nextButton.Child.Text = 'Next puzzle'
  Update-HintButton
}

function Clear-Marks {
  $script:selected = -1
  $script:targets = @()
  $script:hintSquare = -1
  $script:arrow = $null
  $script:wrongSquares = @()
  $script:hoverSquares = @()
}

function Start-Puzzle($Puzzle, [bool]$Rated, [string]$Note, [string]$Mode = $script:settings.mode) {
  Complete-Animation
  $setupTimer.Stop(); $replyTimer.Stop(); $refuteTimer.Stop()
  $script:analysis = $null
  $veil.Visibility = 'Collapsed'
  $script:p = New-PuzzleState $Puzzle $Rated $Mode
  Clear-Marks
  $script:lastMove = $null
  Clear-Feed
  Set-PuzzleView
  if ($Note) { [void](Add-Feed 'info' '' $Note @()) }
  $script:board = [ChessCore.Board]::FromFen($Puzzle.Fen)
  Show-Position $script:board
  Set-Status 'Watch their move' $dim
  Save-Prefs
  if ($script:isInstant) { Invoke-Setup } else { $setupTimer.Start() }
}

$setupTimer = New-Object System.Windows.Threading.DispatcherTimer
$setupTimer.Interval = [TimeSpan]::FromMilliseconds($SETUP_MS)
$setupTimer.Add_Tick({ $setupTimer.Stop(); try { Invoke-Setup } catch { Write-Failure $_ } })

# The opponent's move that sets the puzzle.
function Invoke-Setup {
  $p = $script:p
  if ($p.step -ne 0) { return }
  $before = $script:board
  $move = $before.ParseUci($p.puzzle.Moves[0])
  $san = $before.San($move)
  $note = [ChessCore.Narrator]::Describe($before, $move, $null)
  [void](Add-Feed 'reply' $san $(if ($note.Text) { $note.Text } else { 'Their move.' }) $note.SquareArray())
  $script:board = $before.Play($move)
  $p.line.Add($move.Uci())
  $p.step = 1
  $script:lastMove = $move
  Save-Prefs
  Invoke-Animation $before $move { Set-YourMove }
}

function Set-YourMove {
  $colour = if ($script:p.solverWhite) { 'White' } else { 'Black' }
  Set-Status 'Your move' $ink
  if ($feedPanel.Children.Count -le 2 -and $script:p.step -eq 1) { [void](Add-Feed 'info' '' "Find the best move for $colour." @()) }
  Update-HintButton
}

# A move made on the board by the solver.
function Submit-UserMove($Move) {
  $p = $script:p
  if (-not $p -or $p.phase -ne 'play' -or $p.step % 2 -ne 1 -or $script:analysis) { return }
  Clear-Selection
  $before = $script:board
  $expected = $before.ParseUci($p.puzzle.Moves[$p.step])
  $after = $before.Play($Move)
  # As on Lichess: the puzzle's move, or any move that mates.
  $isRight = ($expected -and $expected.Uci() -eq $Move.Uci()) -or ($after.InCheck() -and $after.LegalMoves().Length -eq 0)
  if ($isRight) { Approve-Move $Move } else { Deny-Move $Move }
}

function Approve-Move($Move) {
  $p = $script:p
  $before = $script:board
  $after = $before.Play($Move)
  # The same side's next move, two plies on, so the note can say what this one sets up.
  $followUp = $null
  if ($p.step + 2 -lt $p.puzzle.Moves.Length) {
    $reply = $after.ParseUci($p.puzzle.Moves[$p.step + 1])
    if ($reply) { $followUp = $after.Play($reply).ParseUci($p.puzzle.Moves[$p.step + 2]) }
  }
  $note = [ChessCore.Narrator]::Describe($before, $Move, $followUp)
  [void](Add-Feed 'move' $before.San($Move) $(if ($note.Text) { $note.Text } else { 'The right move.' }) $note.SquareArray())
  $script:board = $after
  $p.line.Add($Move.Uci())
  $p.step++
  $p.hintNow = 0
  $script:hintSquare = -1
  $script:arrow = $null
  $script:wrongSquares = @()
  $script:lastMove = $Move
  $isDone = $p.step -ge $p.puzzle.Moves.Length -or ($after.InCheck() -and $after.LegalMoves().Length -eq 0)
  if ($isDone) {
    Complete-Puzzle
    Invoke-Animation $before $Move { Show-Review }
    return
  }
  Set-Status 'Good move' $green
  Update-HintButton
  Save-Prefs
  Invoke-Animation $before $Move {
    if ($script:isInstant) { Invoke-Reply } else { $replyTimer.Start() }
  }
}

$replyTimer = New-Object System.Windows.Threading.DispatcherTimer
$replyTimer.Interval = [TimeSpan]::FromMilliseconds($REPLY_MS)
$replyTimer.Add_Tick({ $replyTimer.Stop(); try { Invoke-Reply } catch { Write-Failure $_ } })

# The opponent's answer from the puzzle's line.
function Invoke-Reply {
  $p = $script:p
  if (-not $p -or $p.phase -ne 'play' -or $p.step % 2 -ne 0 -or $p.step -ge $p.puzzle.Moves.Length) { return }
  $before = $script:board
  $reply = $before.ParseUci($p.puzzle.Moves[$p.step])
  $previous = $null
  if ($p.line.Count -ge 1) {
    $back = Get-LineBoard ($p.line.Count - 1)
    if ($back) { $previous = $back.ParseUci($p.line[$p.line.Count - 1]) }
  }
  $after = $before.Play($reply)
  $next = $null
  if ($p.step + 1 -lt $p.puzzle.Moves.Length) { $next = $after.ParseUci($p.puzzle.Moves[$p.step + 1]) }
  $note = [ChessCore.Narrator]::ReplyNote($before, $reply, $previous, $next)
  [void](Add-Feed 'reply' $before.San($reply) $note.Text $note.SquareArray())
  $script:board = $after
  $p.line.Add($reply.Uci())
  $p.step++
  $script:lastMove = $reply
  Save-Prefs
  Invoke-Animation $before $reply { Set-YourMove }
}

# --- A wrong move: Stockfish's answer, or the facts of the move -------------------------

$refuteTimer = New-Object System.Windows.Threading.DispatcherTimer
$refuteTimer.Interval = [TimeSpan]::FromMilliseconds($REFUTE_MS)
$refuteTimer.Add_Tick({ $refuteTimer.Stop(); try { Restore-AfterWrong } catch { Write-Failure $_ } })

$engineTimer = New-Object System.Windows.Threading.DispatcherTimer
$engineTimer.Interval = [TimeSpan]::FromMilliseconds(100)
$engineTimer.Add_Tick({ try { Step-Analysis } catch { Write-Failure $_; Stop-Analysis } })

function Deny-Move($Move) {
  $p = $script:p
  $before = $script:board
  $san = $before.San($Move)
  $p.mistakes++
  $p.pendingWrong = $Move.Uci()
  $script:wrongBefore = $before
  $script:wrongMove = $Move
  $script:wrongReply = $null
  $script:wrongSquares = @($Move.From, $Move.To)
  $p.phase = 'wrong'
  [void](Add-Feed 'wrong' $san 'Not the move.' @($Move.From, $Move.To))
  Set-Status 'Not the move' $red
  Update-HintButton
  Save-Prefs
  Invoke-Animation $before $Move {
    if (Start-Analysis) { return }
    Show-OwnMoveFacts
  }
}

# Without the engine: what the move itself does, then try again.
function Show-OwnMoveFacts {
  $p = $script:p
  Set-Result 0
  $p.pendingWrong = $null
  $note = [ChessCore.Narrator]::Describe($script:wrongBefore, $script:wrongMove, $null)
  $san = $script:wrongBefore.San($script:wrongMove)
  $text = if ($note.Text) { "Your ${san}: $($note.Text)" } else { "Your $san doesn't capture, check, or attack anything of value." }
  if (-not $script:engine -and -not $NoEngine) { $text += ' (Stockfish would show the refutation once it is installed.)' }
  [void](Add-Feed 'info' '' $text $note.SquareArray())
  $p.phase = 'refuting'
  Set-Status 'Not the move' $red
  Save-Prefs
  if (-not $script:isInstant) { $refuteTimer.Interval = [TimeSpan]::FromMilliseconds($FALLBACK_MS); $refuteTimer.Start() }
}

# Asks Stockfish about the wrong move: its value, and the puzzle move's value.
function Start-Analysis {
  if (-not (Confirm-Engine)) { return $false }
  $p = $script:p
  $moves = [string[]]@(for ($k = 0; $k -lt $p.step; $k++) { $p.line[$k] })
  $mateTag = @($p.puzzle.Themes | Where-Object { $_ -like 'mateIn*' })
  $left = [int][Math]::Floor(($p.puzzle.Moves.Length - $p.step + 1) / 2)
  $script:analysis = @{
    stage = 'user'; moves = $moves; user = $null; puzzle = $null; pv = @()
    expected = $p.puzzle.Moves[$p.step]
    knownPuzzle = $(if ($mateTag.Count -gt 0) { 100000 - $left } else { $null })
  }
  $script:analysis.request = $script:engine.Analyse($p.puzzle.Fen, $moves, 700, [string[]]@($script:wrongMove.Uci()))
  if ($script:analysis.request -le 0) { $script:analysis = $null; return $false }
  $veilText.Text = 'Stockfish is looking...'
  $veil.Visibility = 'Visible'
  $p.phase = 'analysing'
  if (-not $script:isInstant) { $engineTimer.Start() }
  return $true
}

function Stop-Analysis {
  $engineTimer.Stop()
  $veil.Visibility = 'Collapsed'
  if ($script:analysis) {
    $script:analysis = $null
    Show-OwnMoveFacts
  }
}

function Step-Analysis {
  $a = $script:analysis
  if (-not $a) { $engineTimer.Stop(); return }
  $result = $script:engine.Poll()
  if ($result.Id -ne $a.request -or -not $result.Done) { return }
  if ($result.Error -or -not $result.HasScore) {
    Write-Failure @{ Exception = @{ Message = "stockfish: $($result.Error) $(([string[]]$script:engine.DrainLog()) -join ' | ')" }; ScriptStackTrace = '' }
    Stop-Analysis
    return
  }
  if ($a.stage -eq 'user') {
    $a.user = $result.Value
    $a.pv = [string[]]$result.Pv
    if ($null -ne $a.knownPuzzle) { $a.puzzle = $a.knownPuzzle; Complete-Analysis; return }
    $a.stage = 'puzzle'
    $a.request = $script:engine.Analyse($script:p.puzzle.Fen, [string[]]$a.moves, 350, [string[]]@($a.expected))
    if ($a.request -le 0) { Stop-Analysis }
    return
  }
  $a.puzzle = $result.Value
  Complete-Analysis
}

function Format-Score([int]$Value) {
  if ($Value -ge 99000) { return "mate in $(100000 - $Value)" }
  if ($Value -le -99000) { return "mated in $(100000 + $Value)" }
  $pawns = $Value / 100.0
  return $(if ($pawns -ge 0) { '+' } else { '' }) + $pawns.ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Complete-Analysis {
  $engineTimer.Stop()
  $veil.Visibility = 'Collapsed'
  $a = $script:analysis
  $script:analysis = $null
  $p = $script:p
  $before = $script:wrongBefore
  $userSan = $before.San($script:wrongMove)
  $puzzleMove = $before.ParseUci($a.expected)
  $puzzleSan = if ($puzzleMove) { $before.San($puzzleMove) } else { $a.expected }
  $verdict = "Your $userSan scores $(Format-Score $a.user); the puzzle's move scores $(Format-Score $a.puzzle)."
  $bothMate = $a.user -ge 99000 -and $a.puzzle -ge 99000
  if ($bothMate -or ($a.user -ge $a.puzzle - 30 -and $a.user -ge 150)) {
    # Just as good: no penalty, but the puzzle wants its own line.
    $p.mistakes--
    $p.pendingWrong = $null
    [void](Add-Feed 'engine' '' "That also wins. $verdict Find the puzzle's line." @())
    $p.phase = 'refuting'
    Set-Status 'Also good' $gold
    Save-Prefs
    if (-not $script:isInstant) { $refuteTimer.Interval = [TimeSpan]::FromMilliseconds($FALLBACK_MS); $refuteTimer.Start() }
    return
  }
  Set-Result 0
  $p.pendingWrong = $null
  $after = $before.Play($script:wrongMove)
  $reply = $null
  if ($a.pv.Length -ge 2) { $reply = $after.ParseUci($a.pv[1]) }
  $p.phase = 'refuting'
  Set-Status 'Not the move' $red
  if (-not $reply) {
    [void](Add-Feed 'engine' '' $verdict @())
    Save-Prefs
    if (-not $script:isInstant) { $refuteTimer.Interval = [TimeSpan]::FromMilliseconds($FALLBACK_MS); $refuteTimer.Start() }
    return
  }
  $note = [ChessCore.Narrator]::Describe($after, $reply, $null)
  $replySan = $after.San($reply)
  $text = if ($note.Text) { "$($note.Text) $verdict" } else { $verdict }
  # The engine's own continuation, so a quiet answer still shows where it leads.
  $line = [ChessCore.Narrator]::LineSan($after, [string[]]($a.pv | Select-Object -Skip 1), 6)
  if ($line) { $text += " Stockfish's line: $line." }
  [void](Add-Feed 'engine' $replySan $text $note.SquareArray())
  $script:wrongReply = $reply
  $script:lastMove = $reply
  Save-Prefs
  Invoke-Animation $after $reply {
    if (-not $script:isInstant) { $refuteTimer.Interval = [TimeSpan]::FromMilliseconds($REFUTE_MS); $refuteTimer.Start() }
  }
}

# Takes back the wrong move (and Stockfish's answer) so the solver can try again.
function Restore-AfterWrong {
  $p = $script:p
  if (-not $p -or $p.phase -ne 'refuting') { return }
  $refuteTimer.Stop()
  Complete-Animation
  $p.phase = 'play'
  $script:wrongSquares = @()
  $script:lastMove = $null
  if ($p.line.Count -ge 1) {
    $back = Get-LineBoard ($p.line.Count - 1)
    if ($back) { $script:lastMove = $back.ParseUci($p.line[$p.line.Count - 1]) }
  }
  $afterWrong = $script:wrongBefore.Play($script:wrongMove)
  $reply = $script:wrongReply
  $script:wrongReply = $null
  Set-Status 'Try again' $ink
  Update-HintButton
  Save-Prefs
  if ($reply) {
    Invoke-Animation $afterWrong $reply { Invoke-Animation $script:wrongBefore $script:wrongMove { Show-Position $script:board } -Reverse } -Reverse
  } else {
    Invoke-Animation $script:wrongBefore $script:wrongMove { Show-Position $script:board } -Reverse
  }
}

# --- Stockfish: found, started, or downloaded ---------------------------------------------

$script:engine = $null
$script:engineRestarts = 0
$script:installer = New-Object ChessCore.EngineInstaller
$script:installTries = 0
$script:progressLine = $null

function Confirm-Engine {
  if ($NoEngine -or ($SnapshotPath -and -not $UseEngine) -or $PlayTest) { return $false }
  if ($script:engine -and $script:engine.Status -ne 'dead') { return $true }
  if ($script:engine) {
    if ($script:engineRestarts -ge 1) { return $false }
    $script:engineRestarts++
    $script:engine = $null
  }
  $exe = [ChessCore.EngineInstaller]::Find($ENGINE_DIR)
  if ($exe) {
    try {
      $script:engine = [ChessCore.UciEngine]::Start($exe, 2, 64)
      return $true
    } catch {
      Write-Failure $_
      return $false
    }
  }
  Start-Install -Announce
  return $false
}

$installTimer = New-Object System.Windows.Threading.DispatcherTimer
$installTimer.Interval = [TimeSpan]::FromMilliseconds(300)
$installTimer.Add_Tick({ try { Step-Install } catch { Write-Failure $_; $installTimer.Stop() } })

# One download per launch, plus one retry; it never blocks the game.
function Start-Install([switch]$Announce) {
  if ($NoEngine -or ($SnapshotPath -and -not $UseEngine) -or $PlayTest) { return }
  $status = $script:installer.Status
  if ($status -in @('downloading', 'verifying', 'extracting', 'done')) {
    if ($Announce -and $script:p) { [void](Add-Feed 'info' '' 'Stockfish is still downloading; this miss is explained without it.' @()) }
    return
  }
  if ($script:installTries -ge 2) { return }
  $script:installTries++
  $script:installer.Begin($ENGINE_DIR)
  if ($script:p) { $script:progressLine = Add-Feed 'progress' '' 'Downloading Stockfish 19 (78 MB, once)...' @() }
  $installTimer.Start()
}

function Step-Install {
  $installer = $script:installer
  if ($script:progressLine) {
    $label = switch ($installer.Status) {
      'downloading' { "Downloading Stockfish 19 $GLYPH_DOT $($installer.Percent)%" }
      'verifying' { 'Checking the Stockfish download...' }
      'extracting' { 'Unpacking Stockfish...' }
      'done' { 'Stockfish is ready: wrong moves now get its answer.' }
      'failed' { "Stockfish download failed: $($installer.Error)" }
      default { '' }
    }
    if ($label) { $script:progressLine.Inlines.Clear(); $script:progressLine.Inlines.Add((New-Object System.Windows.Documents.Run($label))) }
  }
  if ($installer.Status -eq 'done') { $installTimer.Stop(); $script:engineFailedAt = ''; Save-Prefs; return }
  if ($installer.Status -eq 'failed') {
    $installTimer.Stop()
    $script:engineFailedAt = [DateTime]::UtcNow.ToString('o')
    Write-Failure @{ Exception = @{ Message = "stockfish download: $($installer.Error)" }; ScriptStackTrace = '' }
    Save-Prefs
  }
}

# --- Hints: the idea, the piece, the move ----------------------------------------------------

function Show-Hint {
  $p = $script:p
  if (-not $p -or $p.phase -ne 'play' -or $p.step % 2 -ne 1) { return }
  $before = $script:board
  $solution = $before.ParseUci($p.puzzle.Moves[$p.step])
  if (-not $solution) { return }
  if ($p.hintNow -eq 0) {
    $followUp = $null
    if ($p.step + 2 -lt $p.puzzle.Moves.Length) {
      $afterSolution = $before.Play($solution)
      $reply = $afterSolution.ParseUci($p.puzzle.Moves[$p.step + 1])
      if ($reply) { $followUp = $afterSolution.Play($reply).ParseUci($p.puzzle.Moves[$p.step + 2]) }
    }
    $left = [int][Math]::Floor(($p.puzzle.Moves.Length - $p.step + 1) / 2)
    $idea = [ChessCore.Narrator]::IdeaHint($before, $solution, $followUp, [string[]]$p.puzzle.Themes, $left)
    if ($idea) {
      $p.hintNow = 1
      $p.hint = [Math]::Max([int]$p.hint, 1)
      [void](Add-Feed 'hint' 'Hint:' $idea @())
      Update-HintButton
      Save-Prefs
      return
    }
  }
  if ($p.hintNow -le 1) {
    $p.hintNow = 2
    $p.hint = [Math]::Max([int]$p.hint, 2)
    $script:hintSquare = $solution.From
    Set-Result 0
    [void](Add-Feed 'hint' 'Hint:' "Move $([ChessCore.Narrator]::PieceOn($before, $solution.From))." @($solution.From))
  } elseif ($p.hintNow -eq 2) {
    $p.hintNow = 3
    $p.hint = 3
    $script:arrow = @{ From = $solution.From; To = $solution.To }
    [void](Add-Feed 'hint' 'Hint:' "Play $($before.San($solution))." @($solution.From, $solution.To))
  } else { return }
  Update-Marks
  Update-HintButton
  Save-Prefs
}

# --- The end: result, summary, review ----------------------------------------------------------

function Complete-Puzzle {
  $p = $script:p
  $p.phase = 'review'
  $score = 1.0
  if ($p.mistakes -gt 0 -or $p.hint -ge 2) { $score = 0.0 } elseif ($p.hint -eq 1) { $score = 0.5 }
  Set-Result $score
  $script:counter++
  [void]$script:solved.Add($p.puzzle.Id)
  for ($k = $script:retry.Count - 1; $k -ge 0; $k--) { if ($script:retry[$k].id -eq $p.puzzle.Id) { $script:retry.RemoveAt($k) } }
  if ($score -lt 1 -and $p.rated -and ($p.mistakes -gt 0 -or $p.hint -ge 2)) { $script:retry.Add(@{ id = $p.puzzle.Id; due = $script:counter + $RETRY_GAP; mode = $p.mode }) }

  $faced = Get-LineBoard 1
  $solverMoves = [int][Math]::Floor($p.line.Count / 2)
  $summary = [ChessCore.Narrator]::Summary($faced, $script:board, [bool]$p.solverWhite, [string[]]$p.puzzle.Themes, $solverMoves)
  $heading = if ($score -ge 1) { 'Solved.' } elseif ($score -gt 0) { 'Solved with the idea hint.' } elseif ($p.mistakes -gt 0) { 'Solved after a miss.' } else { 'Solved with hints.' }
  if (-not $p.rated) { $heading = 'Retry done (unrated).' }
  elseif ($p.mode -eq 'climb' -and $p.result) {
    $change = [int]$p.result.delta
    $heading += " Level $(if ($change -ge 0) { '+' })$change to $($script:climb.level)."
    if ($p.result.best) { $heading += ' New best!' }
  }
  [void](Add-Feed 'summary' $heading $summary @())
  $hasMateIn = @($p.puzzle.Themes | Where-Object { $_ -like 'mateIn*' }).Count -gt 0
  foreach ($theme in $p.puzzle.Themes) {
    if (-not $script:glossary.Contains($theme) -or ($theme -eq 'mate' -and $hasMateIn)) { continue }
    $entry = $script:glossary[$theme]
    if ($entry.group -notin @('tactics', 'mates')) { continue }
    [void](Add-Feed 'theme' $entry.title $entry.line @())
  }
  $p.reviewPly = $p.line.Count
  Save-Prefs
}

function Show-Review {
  $p = $script:p
  $result = $p.result
  if (-not $p.rated) { Set-Status 'Retry done' $ink }
  elseif ($result -and $result.score -ge 1) { Set-Status 'Solved!' $green }
  elseif ($result -and $result.score -gt 0) { Set-Status 'Solved, half credit' $gold }
  else { Set-Status 'Solved, no credit' $dim }
  $nextButton.Child.Text = 'Next puzzle'
  Update-HintButton
  Build-MoveStrip
  $moveStrip.Visibility = 'Visible'
  Clear-Marks
  Update-Marks
}

# The line as clickable moves; the chosen one is lit.
function Build-MoveStrip {
  $moveStrip.Children.Clear()
  $p = $script:p
  $position = [ChessCore.Board]::FromFen($p.puzzle.Fen)
  for ($k = 0; $k -lt $p.line.Count; $k++) {
    $move = $position.ParseUci($p.line[$k])
    if (-not $move) { break }
    $label = $position.San($move)
    if ($position.WhiteToMove) { $label = "$($position.FullMove). $label" } elseif ($k -eq 0) { $label = "$($position.FullMove)... $label" }
    $chip = New-Pressable $label ($k + 1)
    $chip.FontSize = 11
    if ($k + 1 -eq $p.reviewPly) { $chip.Foreground = $accent; $chip.FontWeight = 'Bold' }
    $chip.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
    $chip.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { Set-ReviewPly ([int]$sender.Tag) } catch { Write-Failure $_ } })
    [void]$moveStrip.Children.Add($chip)
    $position = $position.Play($move)
  }
}

function Set-ReviewPly([int]$Ply) {
  $p = $script:p
  if (-not $p -or $p.phase -ne 'review') { return }
  $Ply = [Math]::Max(1, [Math]::Min($p.line.Count, $Ply))
  $was = $p.reviewPly
  $p.reviewPly = $Ply
  $before = Get-LineBoard ($Ply - 1)
  $move = $before.ParseUci($p.line[$Ply - 1])
  $script:lastMove = $move
  Build-MoveStrip
  Save-Prefs
  if ($Ply -eq $was + 1) { Invoke-Animation $before $move $null }
  elseif ($Ply -eq $was - 1) {
    $shownBefore = Get-LineBoard $Ply
    $undo = $shownBefore.ParseUci($p.line[$Ply])
    if ($undo) { Invoke-Animation $shownBefore $undo $null -Reverse } else { Show-Position $shownBefore }
  } else { Show-Position ($before.Play($move)) }
}

# --- The next puzzle -----------------------------------------------------------------------------

# Nothing played yet beyond the opponent's first move: leaving it costs nothing.
function Test-Untouched {
  $p = $script:p
  return $p -and $p.phase -eq 'play' -and $p.step -le 1 -and $p.hint -eq 0 -and $p.mistakes -eq 0 -and -not $p.result
}

function Select-NextPuzzle([switch]$Fresh) {
  $p = $script:p
  if ($p -and $p.phase -ne 'review' -and -not $Fresh) {
    # Leaving a puzzle unsolved counts as a miss, so ask once before doing it.
    if (-not $script:isInstant -and ([DateTime]::UtcNow - $script:skipAskedAt).TotalMilliseconds -gt $SKIP_CONFIRM_MS) {
      $script:skipAskedAt = [DateTime]::UtcNow
      Set-Status 'Skip? Press N again' $gold
      [void](Add-Feed 'info' '' 'Skipping counts as a miss. Press N (or Next) again to skip.' @())
      return
    }
    Set-Result 0
    $script:counter++
    [void]$script:solved.Add($p.puzzle.Id)
    if ($p.rated) { $script:retry.Add(@{ id = $p.puzzle.Id; due = $script:counter + $RETRY_GAP; mode = $p.mode }) }
    else { for ($k = $script:retry.Count - 1; $k -ge 0; $k--) { if ($script:retry[$k].id -eq $p.puzzle.Id) { $script:retry.RemoveAt($k) } } }
  }
  $script:skipAskedAt = [DateTime]::MinValue
  # A missed puzzle comes back once, unrated.
  $due = $null
  foreach ($entry in $script:retry) { if ($entry.due -le $script:counter -and $entry.mode -eq $script:settings.mode) { $due = $entry; break } }
  if ($due) {
    [void]$script:retry.Remove($due)
    $again = $store.Get($due.id)
    if ($again) { Start-Puzzle $again $false 'A second try at a puzzle you missed earlier (unrated).'; return }
  }
  if ($script:settings.mode -eq 'climb') {
    $target = [int]$script:climb.level
  } else {
    $shift = ($DIFFICULTIES | Where-Object { $_.key -eq $script:settings.difficulty } | Select-Object -First 1).offset
    $target = [int][Math]::Round($script:rating.r) + [int]$shift
  }
  $exclude = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($id in $script:solved) { [void]$exclude.Add($id) }
  foreach ($entry in $script:retry) { [void]$exclude.Add($entry.id) }
  if ($p) { [void]$exclude.Add($p.puzzle.Id) }
  $pick = $store.Pick($script:settings.theme, $target, $exclude, $script:rng)
  $note = "Theme: $(Get-ThemeTitle $script:settings.theme) $GLYPH_DOT aiming for $target"
  if ($script:settings.mode -eq 'climb') { $note = "Climb $GLYPH_DOT level $target $GLYPH_DOT theme: $(Get-ThemeTitle $script:settings.theme)" }
  if ($pick.FellBackToMix) { $note = "No unplayed $(Get-ThemeTitle $script:settings.theme) puzzles left, so a mixed one $GLYPH_DOT aiming for $target" }
  elseif ($pick.Nearest) { $note += " $GLYPH_DOT nearest available: $($pick.Puzzle.Rating)" }
  Start-Puzzle $pick.Puzzle $true $note
}

# --- Coming back: the saved puzzle, checked move by move ----------------------------------------

function Restore-Puzzle($Saved) {
  try {
    $puzzle = $store.Get([string]$Saved.id)
    if (-not $puzzle) { return $false }
    $state = New-PuzzleState $puzzle ([bool]$Saved.rated) ([string]$Saved.mode)
    $moves = [string[]]$Saved.line
    if (-not $moves) { $moves = [string[]]@() }
    if ($moves.Length -gt $puzzle.Moves.Length) { return $false }
    $position = [ChessCore.Board]::FromFen($puzzle.Fen)
    $last = $null
    for ($k = 0; $k -lt $moves.Length; $k++) {
      $move = $position.ParseUci($moves[$k])
      if (-not $move) { return $false }
      # Only the final move may differ from the puzzle's line (another mate).
      $isMate = $position.Play($move).IsCheckmate()
      if ($moves[$k] -ne $puzzle.Moves[$k] -and -not ($k -eq $moves.Length - 1 -and $isMate)) {
        $official = $position.ParseUci($puzzle.Moves[$k])
        if (-not $official -or $official.Uci() -ne $move.Uci()) { return $false }
      }
      $state.line.Add($move.Uci())
      $position = $position.Play($move)
      $last = $move
    }
    $state.step = $moves.Length
    $phase = [string]$Saved.phase
    $isFinished = $moves.Length -eq $puzzle.Moves.Length -or $position.IsCheckmate()
    if ($phase -eq 'review' -and -not $isFinished) { return $false }
    if ($phase -ne 'review' -and $isFinished) { $phase = 'review' }
    $state.phase = $phase
    $state.hint = [int](Get-Clamped ([double]$Saved.hint) 0 3 0)
    $state.hintNow = [int](Get-Clamped ([double]$Saved.hintNow) 0 3 0)
    $state.mistakes = [int](Get-Clamped ([double]$Saved.mistakes) 0 1000 0)
    if ($Saved.result -and $null -ne $Saved.result.score) {
      $score = [double]$Saved.result.score
      if ($score -in @(0.0, 0.5, 1.0)) { $state.result = @{ score = $score; delta = [int]$Saved.result.delta; applied = [bool]$Saved.result.applied; best = [bool]$Saved.result.best } }
    }
    $state.reviewPly = [int](Get-Clamped ([double]$Saved.reviewPly) 0 $moves.Length $moves.Length)
    foreach ($entry in $Saved.feed) {
      if (-not ($entry.kind -is [string]) -or $null -eq $entry.text) { continue }
      $state.feed.Add(@{ kind = [string]$entry.kind; san = [string]$entry.san; text = [string]$entry.text; squares = [int[]]@($entry.squares | Where-Object { $null -ne $_ } | ForEach-Object { [int]$_ }) })
    }

    $script:p = $state
    Clear-Marks
    Clear-Feed
    foreach ($entry in $state.feed) { [void](Add-FeedView $entry) }
    Set-PuzzleView
    $script:board = $position
    $script:lastMove = $last
    # A window closed in the middle of a wrong move: the miss still counts.
    if ($Saved.pendingWrong) {
      Set-Result 0
      Update-Rating
    }
    $state.pendingWrong = $null
    if ($phase -eq 'review') {
      $shown = Get-LineBoard $state.reviewPly
      if ($state.reviewPly -ge 1) { $script:lastMove = (Get-LineBoard ($state.reviewPly - 1)).ParseUci($state.line[$state.reviewPly - 1]) }
      Show-Position $shown
      Show-Review
    } else {
      Show-Position $position
      if ($state.step -eq 0) { Set-Status 'Watch their move' $dim; $setupTimer.Start() }
      elseif ($state.step % 2 -eq 0) { Set-Status 'Their move' $dim; $replyTimer.Start() }
      else { Set-Status 'Your move' $ink; if ($state.hintNow -ge 2) { $script:hintSquare = $position.ParseUci($puzzle.Moves[$state.step]).From }; if ($state.hintNow -ge 3) { $solution = $position.ParseUci($puzzle.Moves[$state.step]); $script:arrow = @{ From = $solution.From; To = $solution.To } }; Update-Marks }
      Update-HintButton
    }
    return $true
  } catch {
    Write-Failure $_
    return $false
  }
}

# --- The theme picker ----------------------------------------------------------------------------

$script:isPicking = $false
$script:chips = @()
$script:shownChips = @()
$script:pickIndex = -1
$script:groupHeadings = @{}
$CHIP_W = [Math]::Floor(($SIDE_W - 16) / 2)

function Build-Chips {
  if ($script:chips.Count -gt 0) { return }
  $built = @()
  $entries = @(@{ key = 'mix'; group = 'mix'; title = 'Mix'; line = 'Puzzles of every kind.' })
  foreach ($key in $script:glossary.Keys) {
    if (Test-ThemeListed $key) {
      $g = $script:glossary[$key]
      $entries += , @{ key = $key; group = $g.group; title = $g.title; line = $g.line }
    }
  }
  $groupNames = [ordered]@{ mix = 'All' }
  foreach ($name in $THEME_GROUPS.Keys) { $groupNames[$name] = $THEME_GROUPS[$name] }
  foreach ($groupKey in $groupNames.Keys) {
    $members = @($entries | Where-Object { $_.group -eq $groupKey })
    if ($members.Count -eq 0) { continue }
    $heading = New-Text $groupNames[$groupKey].ToUpperInvariant() $dim
    $heading.FontSize = 10
    $heading.Margin = New-Gap 2 8 0 3
    [void]$pickerList.Children.Add($heading)
    $wrap = New-Object System.Windows.Controls.WrapPanel
    [void]$pickerList.Children.Add($wrap)
    $script:groupHeadings[$groupKey] = @{ heading = $heading; wrap = $wrap }
    foreach ($entry in $members) {
      $chip = New-Object System.Windows.Controls.Border
      $chip.Width = $CHIP_W
      $chip.Margin = New-Gap 2 2 2 2
      $chip.Padding = New-Gap 7 4 7 5
      $chip.CornerRadius = New-Object System.Windows.CornerRadius(5)
      $chip.Background = $surface
      $chip.BorderThickness = New-Object System.Windows.Thickness(1.5)
      $chip.BorderBrush = $noFill
      $chip.Cursor = [System.Windows.Input.Cursors]::Hand
      $chip.ToolTip = $entry.line
      $chip.Tag = $built.Count
      $inside = New-Object System.Windows.Controls.DockPanel
      $count = New-Text $(if ($entry.key -eq 'mix') { [string]$store.Count } else { [string]$store.ThemeCount($entry.key) }) $faint
      $count.FontSize = 10
      $count.Margin = New-Gap 6 0 0 0
      $count.VerticalAlignment = 'Center'
      [System.Windows.Controls.DockPanel]::SetDock($count, 'Right')
      $title = New-Text $entry.title $ink
      $title.FontSize = 11
      $title.TextTrimming = 'CharacterEllipsis'
      [void]$inside.Children.Add($count)
      [void]$inside.Children.Add($title)
      $chip.Child = $inside
      $chip.Add_MouseEnter({ param($sender, $e) try { Select-Chip ([array]::IndexOf($script:shownChips, $script:chips[[int]$sender.Tag])) } catch { Write-Failure $_ } })
      $chip.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
      $chip.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { Close-Picker $true } catch { Write-Failure $_ } })
      [void]$wrap.Children.Add($chip)
      $built += , @{ key = $entry.key; title = $entry.title; group = $groupKey; chip = $chip }
    }
  }
  $script:chips = $built
}

function Select-Chip([int]$Index) {
  if ($script:shownChips.Count -eq 0 -or $Index -lt 0) { return }
  $Index = [Math]::Min($script:shownChips.Count - 1, $Index)
  if ($script:pickIndex -ge 0 -and $script:pickIndex -lt $script:shownChips.Count) { $script:shownChips[$script:pickIndex].chip.BorderBrush = $noFill }
  $script:pickIndex = $Index
  $script:shownChips[$Index].chip.BorderBrush = $accent
  $script:shownChips[$Index].chip.BringIntoView()
}

function Update-ChipFilter {
  $query = $searchBox.Text.Trim().ToLowerInvariant()
  if ($query) { $searchHint.Visibility = 'Hidden' } else { $searchHint.Visibility = 'Visible' }
  $kept = @()
  foreach ($entry in $script:chips) {
    $isKept = -not $query -or $entry.title.ToLowerInvariant().Contains($query) -or $entry.key.ToLowerInvariant().Contains($query)
    if ($isKept) { $entry.chip.Visibility = 'Visible'; $kept += , $entry } else { $entry.chip.Visibility = 'Collapsed' }
    $entry.chip.BorderBrush = $noFill
  }
  foreach ($groupKey in $script:groupHeadings.Keys) {
    $any = @($kept | Where-Object { $_.group -eq $groupKey }).Count -gt 0
    $script:groupHeadings[$groupKey].heading.Visibility = $(if ($any) { 'Visible' } else { 'Collapsed' })
  }
  $script:shownChips = $kept
  $script:pickIndex = -1
  if ($kept.Count -gt 0) { Select-Chip 0 }
}

function Open-Picker {
  if ($script:isPicking) { return }
  Build-Chips
  $script:isPicking = $true
  $searchBox.Text = ''
  Update-ChipFilter
  $picker.Visibility = 'Visible'
  $win.UpdateLayout()
  for ($k = 0; $k -lt $script:shownChips.Count; $k++) { if ($script:shownChips[$k].key -eq $script:settings.theme) { Select-Chip $k; break } }
  [void][System.Windows.Input.Keyboard]::Focus($searchBox)
}

function Close-Picker([bool]$Keep) {
  if (-not $script:isPicking) { return }
  $script:isPicking = $false
  $picker.Visibility = 'Collapsed'
  if ($Keep -and $script:pickIndex -ge 0 -and $script:pickIndex -lt $script:shownChips.Count) {
    $chosen = $script:shownChips[$script:pickIndex].key
    if ($chosen -ne $script:settings.theme) {
      $script:settings.theme = $chosen
      Update-Info
      Save-Prefs
      if ($script:p -and $script:p.phase -eq 'review') { Select-NextPuzzle }
      elseif ($script:p) { [void](Add-Feed 'info' '' "The next puzzle will be: $(Get-ThemeTitle $chosen)." @()) }
    }
  }
  [void]$win.Focus()
  [void][System.Windows.Input.Keyboard]::Focus($win)
}

function Move-Pick([int]$Step) {
  Select-Chip ([Math]::Max(0, [Math]::Min($script:shownChips.Count - 1, $script:pickIndex + $Step)))
}

$searchBox.Add_TextChanged({ if ($script:isPicking) { try { Update-ChipFilter } catch { Write-Failure $_ } } })

# --- The promotion picker ------------------------------------------------------------------------

$script:promotion = $null

function Show-Promotion([int]$From, [int]$To) {
  $promoLayer.Children.Clear()
  $script:promotion = @{ from = $From; to = $To }
  $white = $script:board.WhiteToMove
  $towardCentre = if ((Get-SquareY $To) -eq 0) { 1 } else { -1 }
  $k = 0
  foreach ($type in @(5, 2, 4, 3)) {
    $choice = New-Object System.Windows.Controls.Border
    $choice.Width = $SQUARE_PX
    $choice.Height = $SQUARE_PX
    $choice.Background = Brush '#F2B0B0B0'
    $choice.CornerRadius = New-Object System.Windows.CornerRadius($SQUARE_PX / 2)
    $choice.Cursor = [System.Windows.Input.Cursors]::Hand
    $choice.Tag = $type
    $piece = New-PieceImage $(if ($white) { $type } else { -$type })
    $choice.Child = $piece
    [System.Windows.Controls.Canvas]::SetLeft($choice, (Get-SquareX $To))
    [System.Windows.Controls.Canvas]::SetTop($choice, (Get-SquareY $To) + $towardCentre * $k * $SQUARE_PX)
    $choice.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
    $choice.Add_MouseLeftButtonUp({
      param($sender, $e)
      $e.Handled = $true
      try {
        $chosen = $script:promotion
        Close-Promotion
        $move = $script:board.FindMove($chosen.from, $chosen.to, [int]$sender.Tag)
        if ($move) { Submit-UserMove $move }
      } catch { Write-Failure $_ }
    })
    [void]$promoLayer.Children.Add($choice)
    $k++
  }
  $promoShade.Visibility = 'Visible'
}

$promoShade = New-Object System.Windows.Shapes.Rectangle
$promoShade.Width = $BOARD_PX
$promoShade.Height = $BOARD_PX
$promoShade.Fill = Brush '#73000000'
$promoShade.Visibility = 'Collapsed'
$boardHost.Children.Insert($boardHost.Children.IndexOf($promoLayer), $promoShade)

function Close-Promotion {
  $promoLayer.Children.Clear()
  $promoShade.Visibility = 'Collapsed'
  $script:promotion = $null
}

# --- Selecting and moving pieces -------------------------------------------------------------------

$script:press = $null
$script:dragging = $false

function Clear-Selection {
  $script:selected = -1
  $script:targets = @()
  Update-Marks
}

function Select-Square([int]$Square) {
  $script:selected = $Square
  $script:targets = [int[]]@($script:board.LegalMovesFrom($Square) | ForEach-Object { $_.To } | Select-Object -Unique)
  Update-Marks
}

function Test-CanMove {
  $p = $script:p
  return $p -and $p.phase -eq 'play' -and $p.step % 2 -eq 1 -and -not $script:analysis -and -not $animTimer.IsEnabled -and -not $script:promotion
}

function Submit-Squares([int]$From, [int]$To) {
  if ($script:board.NeedsPromotion($From, $To)) { Clear-Selection; Show-Promotion $From $To; return }
  $move = $script:board.FindMove($From, $To, 0)
  if ($move) { Submit-UserMove $move }
}

# Mouse down on a square: move there, pick a piece up, or let go of the selection.
function Push-Square([int]$Square, [double]$X, [double]$Y) {
  if ($script:promotion) { Close-Promotion; return }
  $p = $script:p
  if ($p -and $p.phase -eq 'refuting') { Restore-AfterWrong; return }
  if ($p -and $p.phase -eq 'review') { return }
  if ($animTimer.IsEnabled -and $p.phase -eq 'play') { Complete-Animation }
  if (-not (Test-CanMove) -or $Square -lt 0) { return }
  if ($script:selected -ge 0 -and $script:targets -contains $Square) { Submit-Squares $script:selected $Square; return }
  $piece = [int]$script:board.Squares[$Square]
  if ($piece -ne 0 -and (($piece -gt 0) -eq $script:board.WhiteToMove)) {
    $wasSelected = $script:selected -eq $Square
    Select-Square $Square
    $script:press = @{ square = $Square; x = $X; y = $Y; wasSelected = $wasSelected }
    $script:dragging = $false
    [void]$boardHost.CaptureMouse()
  } else {
    Clear-Selection
  }
}

function Move-Pointer([double]$X, [double]$Y) {
  $press = $script:press
  if (-not $press) { return }
  if (-not $script:dragging) {
    if ([Math]::Abs($X - $press.x) + [Math]::Abs($Y - $press.y) -lt 5) { return }
    $script:dragging = $true
  }
  $image = $script:pieceViews[$press.square]
  if (-not $image) { return }
  [System.Windows.Controls.Panel]::SetZIndex($image, 10)
  [System.Windows.Controls.Canvas]::SetLeft($image, $X - $SQUARE_PX / 2)
  [System.Windows.Controls.Canvas]::SetTop($image, $Y - $SQUARE_PX / 2)
}

function Pop-Pointer([double]$X, [double]$Y) {
  $press = $script:press
  $script:press = $null
  $boardHost.ReleaseMouseCapture()
  if (-not $press) { return }
  if ($script:dragging) {
    $script:dragging = $false
    $target = Get-SquareAt $X $Y
    if ($target -ge 0 -and $script:targets -contains $target) { Submit-Squares $press.square $target; return }
    # Dropped off a legal square: the piece goes home, still selected.
    Show-Position $script:board
    return
  }
  if ($press.wasSelected) { Clear-Selection }
}

$boardHost.Add_MouseLeftButtonDown({
  param($sender, $e)
  $e.Handled = $true
  try {
    $at = $e.GetPosition($boardHost)
    Push-Square (Get-SquareAt $at.X $at.Y) $at.X $at.Y
  } catch { Write-Failure $_ }
})
$boardHost.Add_MouseMove({
  param($sender, $e)
  if (-not $script:press) { return }
  try {
    $at = $e.GetPosition($boardHost)
    Move-Pointer $at.X $at.Y
  } catch { Write-Failure $_ }
})
$boardHost.Add_MouseLeftButtonUp({
  param($sender, $e)
  try {
    $at = $e.GetPosition($boardHost)
    Pop-Pointer $at.X $at.Y
  } catch { Write-Failure $_ }
})

# --- Keys and clicks --------------------------------------------------------------------------------

$win.Add_PreviewKeyDown({
  param($sender, $e)
  $name = [string]$e.Key
  try {
    if ($script:isPicking) {
      switch ($name) {
        'Escape' { Close-Picker $false }
        'Return' { Close-Picker $true }
        'Left' { Move-Pick -1 }
        'Right' { Move-Pick 1 }
        'Up' { Move-Pick -2 }
        'Down' { Move-Pick 2 }
        default { return }
      }
      $e.Handled = $true
      return
    }
    if ((([int][System.Windows.Input.Keyboard]::Modifiers) -band 11) -ne 0) { return }
    $p = $script:p
    if ($p -and $p.phase -eq 'refuting' -and $name -ne 'Escape') { Restore-AfterWrong; $e.Handled = $true; return }
    switch ($name) {
      'H' { Show-Hint }
      'N' { Select-NextPuzzle }
      'Return' { if ($p -and $p.phase -eq 'review') { Select-NextPuzzle } }
      'T' { Open-Picker }
      'Left' { if ($p -and $p.phase -eq 'review') { Set-ReviewPly ($p.reviewPly - 1) } }
      'Right' { if ($p -and $p.phase -eq 'review') { Set-ReviewPly ($p.reviewPly + 1) } }
      'Home' { if ($p -and $p.phase -eq 'review') { Set-ReviewPly 1 } }
      'End' { if ($p -and $p.phase -eq 'review') { Set-ReviewPly $p.line.Count } }
      'Escape' { if ($script:promotion) { Close-Promotion } elseif ($p -and $p.phase -eq 'refuting') { Restore-AfterWrong } else { Clear-Selection } }
      default { return }
    }
    $e.Handled = $true
  } catch { Write-Failure $_ }
})

foreach ($control in @($hintButton, $nextButton, $closeText, $themeChip, $boardSwatch, $puzzleLink, $gameLink) + $script:difficultyViews) {
  $control.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
}
$hintButton.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { Show-Hint } catch { Write-Failure $_ } })
$nextButton.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { Select-NextPuzzle } catch { Write-Failure $_ } })
$closeText.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $win.Close() })
$themeChip.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { if ($script:isPicking) { Close-Picker $false } else { Open-Picker } } catch { Write-Failure $_ } })
$boardSwatch.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  try {
    $names = @($BOARD_LOOKS.Keys)
    $next = $names[([array]::IndexOf($names, $script:settings.board) + 1) % $names.Count]
    Set-BoardColour $next
    Set-Orientation $script:flipped
    Save-Prefs
  } catch { Write-Failure $_ }
})
foreach ($view in $script:modeViews) {
  $view.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
  $view.Add_MouseLeftButtonUp({
    param($sender, $e)
    $e.Handled = $true
    try {
      $chosen = [string]$sender.Tag
      if ($chosen -eq $script:settings.mode) { return }
      $script:settings.mode = $chosen
      Update-Mode
      Save-Prefs
      $title = if ($chosen -eq 'climb') { 'Climb' } else { 'Normal' }
      if (-not $script:p -or $script:p.phase -eq 'review') { Select-NextPuzzle }
      elseif (Test-Untouched) { Select-NextPuzzle -Fresh }
      else { [void](Add-Feed 'info' '' "The next puzzle will be in $title mode; this one finishes as it started." @()) }
    } catch { Write-Failure $_ }
  })
}
foreach ($view in $script:difficultyViews) {
  $view.Add_MouseLeftButtonUp({
    param($sender, $e)
    $e.Handled = $true
    try {
      $script:settings.difficulty = [string]$sender.Tag
      Update-Difficulty
      Save-Prefs
      if ($script:p -and $script:p.phase -ne 'review') { [void](Add-Feed 'info' '' "The next puzzle will be $($sender.Text.ToLowerInvariant())." @()) }
    } catch { Write-Failure $_ }
  })
}
$puzzleLink.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { if ($script:p) { Start-Process "https://lichess.org/training/$($script:p.puzzle.Id)" } } catch { Write-Failure $_ } })
$gameLink.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { if ($script:p) { Start-Process "https://lichess.org/$($script:p.puzzle.Game)" } } catch { Write-Failure $_ } })

# --- Placement: over the WezTerm window, where the person last dragged it -------------------------

$script:me = [IntPtr]::Zero
$script:lastOwner = $null
$script:moving = $false
$script:resizing = $false
$script:resizeStart = $null

function Get-Rect([IntPtr]$Hwnd) {
  $r = New-Object ChessCore.ChessWin32+RECT
  [void][ChessCore.ChessWin32]::GetWindowRect($Hwnd, [ref]$r)
  return $r
}

function Get-Cursor {
  $cursor = New-Object ChessCore.ChessWin32+POINT
  [void][ChessCore.ChessWin32]::GetCursorPos([ref]$cursor)
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
  [void][ChessCore.ChessWin32]::SetWindowPos($script:me, [IntPtr]::Zero, $x, $y, 0, 0, 0x15)
}

$header.Add_MouseLeftButtonDown({
  param($sender, $e)
  $script:moving = $true
  try { $win.DragMove() } catch {}
  $script:moving = $false
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
    $style = [ChessCore.ChessWin32]::GetWindowLong($script:me, -20)
    [void][ChessCore.ChessWin32]::SetWindowLong($script:me, -20, ($style -bor 0x80))
  }
})

# Saved on every change already; once more on the way out, and Stockfish stops.
$win.Add_Closing({
  try {
    Complete-Animation
    Save-Prefs
  } catch { Write-Failure $_ }
  try { if ($script:engine) { $script:engine.Quit() } } catch {}
})

# --- Snapshots: the window drawn to a PNG through the real handlers ---------------------------------

function Get-SnapshotPuzzle {
  if ($SnapshotPuzzle) { $chosen = $store.Get($SnapshotPuzzle); if ($chosen) { return $chosen } }
  $none = New-Object 'System.Collections.Generic.HashSet[string]'
  return $store.Pick('fork', 1400, $none, (New-Object System.Random(7))).Puzzle
}

# A click on a square, as the mouse makes it: down and up on its centre.
function Invoke-SquareClick([int]$Square) {
  $x = (Get-SquareX $Square) + $SQUARE_PX / 2
  $y = (Get-SquareY $Square) + $SQUARE_PX / 2
  Push-Square $Square $x $y
  # Capturing the mouse can report where the real (off-screen) pointer is: not a drag.
  $script:dragging = $false
  Pop-Pointer $x $y
}

# Plays the solver's next puzzle move by clicking its two squares.
function Invoke-SolutionClick {
  $p = $script:p
  $move = $script:board.ParseUci($p.puzzle.Moves[$p.step])
  Invoke-SquareClick $move.From
  if ($script:board.NeedsPromotion($move.From, $move.To)) { $script:board.FindMove($move.From, $move.To, $move.Promo) | ForEach-Object { Submit-UserMove $_ }; return }
  Invoke-SquareClick $move.To
}

# A legal move that is neither the puzzle's move nor a mate.
function Invoke-WrongClick {
  $p = $script:p
  $expected = $p.puzzle.Moves[$p.step]
  foreach ($move in $script:board.LegalMoves()) {
    if ($move.Uci() -eq $expected -or $move.Promo -ne 0 -or $script:board.Play($move).IsCheckmate()) { continue }
    Invoke-SquareClick $move.From
    Invoke-SquareClick $move.To
    return
  }
}

# With -UseEngine, on this thread: the download first, then each analysis.
function Wait-Install {
  if ([ChessCore.EngineInstaller]::Find($ENGINE_DIR)) { return }
  Start-Install
  $until = [DateTime]::UtcNow.AddMinutes(6)
  while ([DateTime]::UtcNow -lt $until -and $script:installer.Status -in @('downloading', 'verifying', 'extracting')) { Start-Sleep -Milliseconds 300 }
  Step-Install
}

function Wait-Analysis {
  $until = [DateTime]::UtcNow.AddSeconds(30)
  while ($script:analysis -and [DateTime]::UtcNow -lt $until) {
    Start-Sleep -Milliseconds 100
    Step-Analysis
  }
}

function Invoke-Until([scriptblock]$Step) {
  for ($guard = 0; $guard -lt 30 -and $script:p.phase -eq 'play'; $guard++) { & $Step }
}

function Show-Demo {
  if ($UseEngine) { Wait-Install }
  if ($SnapshotMode) { $script:settings.mode = $SnapshotMode; Update-Mode }
  Start-Puzzle (Get-SnapshotPuzzle) $true 'Theme: Fork (snapshot)'
  switch ($SnapshotView) {
    'hint' { Show-Hint; Show-Hint; Show-Hint }
    'wrong' { Invoke-WrongClick; Wait-Analysis }
    'review' { Invoke-Until { Invoke-SolutionClick } }
    'picker' { Open-Picker; $searchBox.Text = 'mate'; Update-ChipFilter }
    'played' {
      Invoke-WrongClick
      Wait-Analysis
      if ($script:p.phase -eq 'refuting') { Restore-AfterWrong }
      Invoke-Until { Invoke-SolutionClick }
    }
    'pieces' {
      $script:board = [ChessCore.Board]::FromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
      Set-Orientation $false
      $script:lastMove = $null
      Show-Position $script:board
      Select-Square 6
    }
  }
}

function Save-Snapshot {
  try { if (-not $restored) { Show-Demo } } catch { [Console]::Error.WriteLine("snapshot failed: $($_.Exception.Message) $($_.ScriptStackTrace)") }
  # The whole feed as text too: the window only shows its end.
  if ($script:p) { foreach ($entry in $script:p.feed) { [Console]::Out.WriteLine(("  [{0}] {1} {2}" -f $entry.kind, $entry.san, $entry.text)) } }
  $win.UpdateLayout()
  $dpi = 96.0
  if ($script:me -ne [IntPtr]::Zero) { $dpi = [double][ChessCore.ChessWin32]::GetDpiForWindow($script:me) }
  $width = [int][Math]::Ceiling($cardHost.ActualWidth * $dpi / 96.0)
  $height = [int][Math]::Ceiling($cardHost.ActualHeight * $dpi / 96.0)
  $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($width, $height, $dpi, $dpi, [System.Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($cardHost)
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $file = [System.IO.File]::Create($SnapshotPath)
  try { $encoder.Save($file) } finally { $file.Dispose() }
}

# --- Play-test: a puzzle through the real handlers, and a save round trip ---------------------------

function Test-Play {
  $checks = [ordered]@{}
  Start-Puzzle (Get-SnapshotPuzzle) $true ''
  $checks.setupPlayed = $script:p.step -eq 1 -and $script:p.line.Count -eq 1
  $before = $script:rating.r
  Invoke-WrongClick
  $checks.wrongCounted = $script:p.mistakes -eq 1 -and $script:p.result.applied -and $script:rating.r -lt $before
  $checks.wrongWaits = $script:p.phase -eq 'refuting'
  Restore-AfterWrong
  $checks.wrongTakenBack = $script:p.phase -eq 'play' -and $script:board.ToFen() -eq (Get-LineBoard 1).ToFen()
  $ratingAfterMiss = $script:rating.r
  Show-Hint; Show-Hint; Show-Hint
  $checks.hintsWalk = $script:p.hintNow -eq 3 -and $null -ne $script:arrow -and $script:hintSquare -ge 0
  $checks.noDoubleRating = $script:rating.r -eq $ratingAfterMiss
  Invoke-Until { Invoke-SolutionClick }
  $checks.solvedToReview = $script:p.phase -eq 'review' -and $script:p.reviewPly -eq $script:p.line.Count
  $checks.retryQueued = @($script:retry | Where-Object { $_.id -eq $script:p.puzzle.Id }).Count -eq 1
  Set-ReviewPly 1
  $checks.reviewSteps = $script:p.reviewPly -eq 1
  $saved = (Get-PuzzleSave | ConvertTo-Json -Depth 6) | ConvertFrom-Json
  $checks.restores = Restore-Puzzle $saved
  $checks.restoredSame = $script:p.phase -eq 'review' -and $script:p.feed.Count -eq $saved.feed.Count
  $broken = (Get-PuzzleSave | ConvertTo-Json -Depth 6) | ConvertFrom-Json
  $broken.line = @('a1a1')
  $ratingBefore = $script:rating.r
  $checks.refusesBroken = -not (Restore-Puzzle $broken) -and $script:rating.r -eq $ratingBefore
  Select-NextPuzzle
  $checks.nextIsNew = $script:p.step -eq 1 -and $script:p.puzzle.Id -ne $saved.id
  Select-NextPuzzle
  $checks.skipCounts = $script:solved.Count -ge 2
  $script:settings.mode = 'climb'
  Select-NextPuzzle -Fresh
  $checks.climbStartsLow = $script:p.mode -eq 'climb' -and $script:p.puzzle.Rating -le $CLIMB_START + 400
  $level = $script:climb.level
  $ratingNow = $script:rating.r
  Invoke-Until { Invoke-SolutionClick }
  $checks.climbUpOnSolve = $script:climb.level -eq $level + $CLIMB_UP -and $script:rating.r -eq $ratingNow
  Select-NextPuzzle
  Invoke-WrongClick
  $checks.climbDownOnMiss = $script:climb.level -eq [Math]::Max($CLIMB_MIN, $level + $CLIMB_UP - $CLIMB_DOWN) -and $script:rating.r -eq $ratingNow
  $checks.climbSaved = ((Get-PuzzleSave).mode -eq 'climb')
  $failed = @($checks.Keys | Where-Object { -not $checks[$_] })
  $checks.ok = $failed.Count -eq 0
  $checks.failed = $failed
  Send-Event $checks
  return $checks.ok
}

# --- Life ------------------------------------------------------------------------------------------

Set-BoardColour $script:settings.board
Set-Orientation $false
Update-Difficulty
Update-Mode
Update-Rating

if ($PlayTest) {
  $ok = Test-Play
  try { $mutex.ReleaseMutex() } catch {}
  if ($ok) { exit 0 } else { exit 1 }
}

$win.Add_ContentRendered({
  if ($SnapshotPath) { Save-Snapshot; $win.Close(); return }
  $script:lastOwner = if ($hasOwner) { Get-Rect $owner } else { $null }
  Set-Place
  [void]$win.Activate()
  [void]$win.Focus()
  # The engine downloads in the background on the first open, so the first miss can use it.
  try {
    if (-not $NoEngine -and -not [ChessCore.EngineInstaller]::Find($ENGINE_DIR)) {
      $lastFail = [DateTime]::MinValue
      if ($script:engineFailedAt) { [void][DateTime]::TryParse($script:engineFailedAt, [ref]$lastFail) }
      if (([DateTime]::UtcNow - $lastFail.ToUniversalTime()).TotalHours -gt 24) { Start-Install }
    }
  } catch { Write-Failure $_ }
  Send-Event @{ event = 'ready' }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
  if (-not $hasOwner) { return }
  if (-not [ChessCore.ChessWin32]::IsWindow($owner)) { $win.Close(); return }
  if ($script:moving -or $script:resizing -or [ChessCore.ChessWin32]::IsIconic($owner)) { return }
  $now = Get-Rect $owner
  $was = $script:lastOwner
  if ($null -eq $was -or $now.Left -ne $was.Left -or $now.Top -ne $was.Top -or $now.Right -ne $was.Right -or $now.Bottom -ne $was.Bottom) {
    $script:lastOwner = $now
    Set-Place
  }
})

# The kept puzzle comes back as it was; anything else starts a fresh one.
$restored = $false
if ($savedPuzzle -and (-not $SnapshotPath -or $SnapshotSave)) { $restored = Restore-Puzzle $savedPuzzle }
if (-not $restored -and -not $SnapshotPath) { Select-NextPuzzle }

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
