#Requires -Version 5.1
# A typing test in Monkeytype's image: words mode, 10 words from its English
# 200 list, its caret, its result screen, and its themes, picked with Esc or the
# theme name in the footer. The first, 'auto' ("follow colour scheme"), is the
# colour scheme every window shares (Theme.ps1) and follows its changes; the
# rest are all of Monkeytype's colour themes, read from TypeThemes.txt (made
# from Monkeytype's themes.ts). In every theme the card takes the games'
# background see-through from the appearance file; text stays solid.
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
  [string]$SnapshotTheme = '',
  # Draws the snapshot with the other-windows row open under the games mark.
  [switch]$SnapshotSwitcher
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

# --- Theme colours: Monkeytype's roles and the shared scheme's, both ways -------------
# Pure (no window): -SelfTest checks them. They call Theme.ps1, dot-sourced before any call.

function ConvertTo-Color([string]$Hex) { return [System.Windows.Media.Color][System.Windows.Media.ColorConverter]::ConvertFromString($Hex) }
function Brush([string]$Hex) { return New-Object System.Windows.Media.SolidColorBrush((ConvertTo-Color $Hex)) }

function Get-Rgb([string]$Hex) {
  $color = ConvertTo-Color $Hex
  return @([int]$color.R, [int]$color.G, [int]$color.B)
}

# A colour at an alpha of its own (0-1), whatever alpha its hex had.
function Get-AlphaColor([string]$Hex, [double]$Alpha) {
  $color = ConvertTo-Color $Hex
  return [System.Windows.Media.Color]::FromArgb((Get-ThemeByte ($Alpha * 255)), $color.R, $color.G, $color.B)
}

# A theme is bg, main, caret, sub, subAlt, text, error, errorExtra. 'auto' is the colour scheme.
$AUTO_THEME = 'auto'
$SERIKA_DARK = @('#323437', '#E2B714', '#E2B714', '#646669', '#2C2E31', '#D1D0C5', '#CA4754', '#7E2A33')
# Saves from before 'auto' wrote 'serika_dark', the old default, on every drag, resize and new
# best, chosen or not. A save without this mark that names it follows the colour scheme instead,
# once: every save from now on carries the mark and keeps whatever theme it names.
$SAVE_THEME_SET = 2

# The theme a save names, as this version reads it.
function Get-SavedTheme([string]$Theme, $ThemeSet) {
  if (-not $Theme) { return $AUTO_THEME }
  $isMarked = $null -ne $ThemeSet -and [string]$ThemeSet -eq [string]$SAVE_THEME_SET
  if ($Theme -eq 'serika_dark' -and -not $isMarked) { return $AUTO_THEME }
  return $Theme
}

# The scheme (a Theme.ps1 palette and its bg) as a Monkeytype theme: bg the card's colour, main
# and caret the accent, sub the dim text, subAlt a step toward the text, text the ink, error the
# red, errorExtra the red 45% of the way to the card. Solid, for its swatch; the window itself
# wears the scheme's own brushes.
function Get-SchemeAsTheme($Palette, [string]$BgHex) {
  $bg = Get-Rgb $BgHex
  return [string[]]@(
    (Format-ThemeColor $bg), $Palette.accent, $Palette.accent, $Palette.dim,
    (Format-ThemeColor (Get-ThemeMix $bg (Get-Rgb $Palette.ink) 0.08)), $Palette.ink, $Palette.red,
    (Format-ThemeColor (Get-ThemeMix (Get-Rgb $Palette.red) $bg 0.45)))
}

# A Monkeytype theme as the scheme's roles (role -> Color), plus 'subAlt': every role worked
# out from its bg, main and text the way the scheme's are (so the card takes the see-through
# and text stays solid), then its own sub, error and edge (sub at alpha 80, as before). subAlt,
# for fills and the graph's lines, takes the card's see-through too: Monkeytype means it as a
# shade barely off the background, which a solid one on a see-through card no longer is.
function Get-ThemeLook($Colors, [double]$Opacity) {
  $palette = Get-ThemePalette @{ bg = $Colors[0]; accent = $Colors[1]; text = $Colors[5] } $Opacity
  $look = @{}
  foreach ($role in $THEME_ROLES) { $look[$role] = ConvertTo-Color $palette[$role] }
  $look.dim = ConvertTo-Color $Colors[3]
  $look.red = ConvertTo-Color $Colors[6]
  $look.edge = Get-AlphaColor $Colors[3] (80 / 255)
  $look.subAlt = Get-AlphaColor $Colors[4] $Opacity
  return $look
}

# The letters still to type, in 'auto': the scheme's dim at full opacity. The shared dim moves
# toward the text as the card clears, so labels read on their own over what shows through; the
# letters keep the full step from the typed ones, the window's main cue, and the halo carries
# their legibility. A Monkeytype theme paints them in its own sub (Get-ThemeLook's dim).
function Get-SchemeUntypedColor($SchemeColors) {
  return ConvertTo-Color (Get-ThemePalette $SchemeColors 1.0).dim
}

# --- Self-test: the scoring, on small cases, and the theme colours ----------------------

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
  # The themes: the Ember scheme as 'auto', and a Monkeytype theme at 40% see-through.
  Add-Type -AssemblyName PresentationCore, WindowsBase
  . (Join-Path $PSScriptRoot 'Theme.ps1')
  $ember = Get-ThemePalette @{ bg = '#1C1D20'; accent = '#E08A5F'; text = '#E8E6E3' } 0.95
  $auto = Get-SchemeAsTheme $ember '#1C1D20'
  $checks.autoBgIsTheCardColourSolid = $auto[0] -eq '#FF1C1D20'
  $checks.autoMainAndCaretAreTheAccent = $auto[1] -eq '#FFE08A5F' -and $auto[2] -eq '#FFE08A5F'
  $checks.autoSubIsTheDimText = $auto[3] -eq '#FF90908F'
  $checks.autoSubAltIsAStepTowardTheText = $auto[4] -eq '#FF2C2D30'
  $checks.autoTextIsInkErrorIsRed = $auto[5] -eq '#FFE8E6E3' -and $auto[6] -eq '#FFE0696B'
  $checks.autoErrorExtraIsRedTowardTheCard = $auto[7] -eq '#FF884749'
  # The letters still to type keep the full-opacity dim, so they stay a clear step (2.2:1 or
  # more) off the typed ink at 40% see-through, where the shared dim has moved up to the ink.
  $emberColors = @{ bg = '#1C1D20'; accent = '#E08A5F'; text = '#E8E6E3' }
  $paperColors = @{ bg = '#F5F2EB'; accent = '#C2602F'; text = '#1F1E1C' }
  $emberUntyped = Get-SchemeUntypedColor $emberColors
  $paperUntyped = Get-SchemeUntypedColor $paperColors
  $checks.untypedIsTheFullOpacityDim = $emberUntyped.ToString() -eq '#FF90908F' -and $paperUntyped.ToString() -eq '#FF6C6A67'
  $emberShared = ConvertTo-Color (Get-ThemePalette $emberColors 0.4).dim
  $checks.sharedDimStillMovesForLabels = $emberShared.ToString() -eq '#FFC6C5C3'
  $emberGap = Get-ThemeContrast (Get-Rgb '#E8E6E3') (Get-Rgb $emberUntyped.ToString())
  $paperGap = Get-ThemeContrast (Get-Rgb '#1F1E1C') (Get-Rgb $paperUntyped.ToString())
  $checks.untypedStandsOffTheTypedInk = $emberGap -ge 2.2 -and $paperGap -ge 2.2
  $look = Get-ThemeLook $SERIKA_DARK 0.4
  $checks.cardTakesTheGamesSeeThrough = $look.cardFill.ToString() -eq '#66323437'
  $checks.textAndMainStaySolid = $look.ink.ToString() -eq '#FFD1D0C5' -and $look.accent.ToString() -eq '#FFE2B714'
  $checks.subAndErrorAreTheThemesOwn = $look.dim.ToString() -eq '#FF646669' -and $look.red.ToString() -eq '#FFCA4754'
  $checks.edgeIsSubAtAlpha80 = $look.edge.ToString() -eq '#50646669'
  $checks.subAltFadesWithTheCard = $look.subAlt.ToString() -eq '#662C2E31'
  # A save's theme: the old default, unmarked, follows the scheme; anything chosen is kept.
  $checks.oldDefaultSaveFollowsTheScheme = (Get-SavedTheme 'serika_dark' $null) -eq $AUTO_THEME
  $checks.markedSaveKeepsSerika = (Get-SavedTheme 'serika_dark' 2) -eq 'serika_dark'
  $checks.oldChosenThemeIsKept = (Get-SavedTheme 'incognito' $null) -eq 'incognito'
  $checks.noSavedThemeFollowsTheScheme = (Get-SavedTheme '' $null) -eq $AUTO_THEME
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

$GLYPH_CROWN = [string][char]0x265B
$MIN_SCALE = 0.7
$MAX_SCALE = 2.5
$WORD_COUNT = 10
$EXTRA_LIMIT = 10
$WORDS_WIDTH = 640
$LETTER_SIZE = 26
# The theme picker's grid: as many swatches of at least this width as fit across, this far apart,
# its scrollbar in the card's right padding so the grid spans exactly the search box's width.
# The scroller reaches this far into the padding (16): its 9px bar sits in the middle of it.
$SWATCH_MIN_W = 150
$SWATCH_H = 34
$SWATCH_GAP = 8
$SCROLL_GUTTER = 12
# The result's labels: over the big wpm and acc, and over the details row.
$BIG_LABEL_SIZE = 18
$DETAIL_LABEL_SIZE = 15

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
# With no theme saved, the colour scheme every window shares (Get-SavedTheme).
$script:themeName = $AUTO_THEME
$script:themeMoved = $false
try {
  if (Test-Path $prefsFile) {
    $saved = Get-Content $prefsFile -Raw | ConvertFrom-Json
    if ($null -ne $saved.dx) { $script:offset = @{ dx = [int]$saved.dx; dy = [int]$saved.dy } }
    if ($saved.scale) { $script:scale = [Math]::Max([double]$MIN_SCALE, [Math]::Min([double]$MAX_SCALE, [double]$saved.scale)) }
    if ($saved.pb) { $script:best = [double]$saved.pb }
    $script:themeName = Get-SavedTheme ([string]$saved.theme) $saved.themeSet
    # The old default just became 'auto': saved at once (below), so it happens only this once.
    $script:themeMoved = [string]$saved.theme -and $script:themeName -ne [string]$saved.theme
  }
} catch {}

function Save-Prefs {
  # Test runs leave the person's record alone.
  if ($SnapshotPath) { return }
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $prefsFile) | Out-Null
    $prefs = @{ scale = [Math]::Round($script:scale, 3); pb = [Math]::Round($script:best, 2); theme = $script:themeName; themeSet = $SAVE_THEME_SET }
    if ($script:offset) { $prefs.dx = $script:offset.dx; $prefs.dy = $script:offset.dy }
    $prefs | ConvertTo-Json -Compress | Set-Content -Path $prefsFile -Encoding ASCII
  } catch {}
}

# --- The window, in the chosen theme ----------------------------------------------------

# The colour scheme and see-through every window shares (appearance.json), and the shared pieces.
. (Join-Path $PSScriptRoot 'Theme.ps1')
$T = Initialize-Theme 'games'
. (Join-Path $PSScriptRoot 'Chrome.ps1')

# The scheme in use as a Monkeytype theme, for 'auto's swatch.
function Get-AutoColors { return Get-SchemeAsTheme $script:THEME.palette $script:THEME.appearance.colors.bg }

# The themes: first 'auto', the colour scheme, then Monkeytype's. A line with a colour that is
# not a hex colour is left out, so one bad line can't break the window.
$script:themes = [ordered]@{}
$script:themes[$AUTO_THEME] = Get-AutoColors
try {
  foreach ($line in Get-Content (Join-Path $PSScriptRoot 'TypeThemes.txt')) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $fields = $line.Split('|')
    if ($fields.Length -ne 9 -or $fields[0] -eq $AUTO_THEME) { continue }
    $isValid = $true
    foreach ($hex in $fields[1..8]) { if ($hex -notmatch '^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$') { $isValid = $false } }
    if ($isValid) { $script:themes[$fields[0]] = [string[]]$fields[1..8] }
  }
} catch {}
if (-not $script:themes.Contains('serika_dark')) { $script:themes['serika_dark'] = $SERIKA_DARK }
if (-not $script:themes.Contains($script:themeName)) { $script:themeName = $AUTO_THEME }
if ($script:themeMoved) { Save-Prefs }

# Live brushes, changed in place with the theme, so whatever is painted with one follows it.
# The roles every window shares are this window's own scheme brushes ($T). A Monkeytype theme
# repaints them in its colours (Set-Colors), so the marks, chips, grip, tooltips and scrollbar
# wear the theme too; 'auto' leaves them as the scheme paints them. The card is cardFill: the
# theme's background at the games' see-through, in every theme.
$bgBrush = $T.cardFill
$mainBrush = $T.accent
$subBrush = $T.dim
$textBrush = $T.ink
$errorBrush = $T.red
$edgeBrush = $T.edge
$caretBrush = Brush $SERIKA_DARK[2]
$extraBrush = Brush $SERIKA_DARK[7]
# The letters still to type: a brush of their own, a full step off the typed ones at any
# see-through (Get-SchemeUntypedColor). Labels and hints stay on the shared dim.
$untypedBrush = Brush $SERIKA_DARK[3]
# The key chips' and search box's fill: subAlt at the card's see-through, so it fades with it.
$subAltBrush = Brush $SERIKA_DARK[4]
$gridBrush = Brush $SERIKA_DARK[4]
$noFill = [System.Windows.Media.Brushes]::Transparent
$script:shownTheme = ''
$script:themeLooks = @{}
# The roles Theme.ps1's scrollbar and tooltip styles look up by name (Sync-ThemeResources).
$RESOURCE_ROLES = @('scroll', 'ink', 'popup', 'line')

# Points those names at brushes of the colours now on $T: a new brush whenever a colour changed,
# since the one a style already used is frozen.
function Sync-ThemeResources {
  if (-not $win) { return }
  foreach ($role in $RESOURCE_ROLES) {
    $key = 'Theme.' + $role
    $color = $T[$role].Color
    $current = $win.Resources[$key]
    if ($current -is [System.Windows.Media.SolidColorBrush] -and $current.Color -eq $color) { continue }
    $win.Resources[$key] = [System.Windows.Media.Brush](New-Object System.Windows.Media.SolidColorBrush($color))
  }
}

function Set-Colors([string]$Name) {
  $colors = $script:themes[$Name]
  if (-not $colors) { return }
  $script:shownTheme = $Name
  $opacity = [double]$script:THEME.appearance.opacity.games
  $caretBrush.Color = ConvertTo-Color $colors[2]
  $extraBrush.Color = ConvertTo-Color $colors[7]
  if ($Name -eq $AUTO_THEME) {
    # The scheme's brushes, as every other window wears them.
    Set-ThemeAppearance $script:THEME.appearance
    $untypedBrush.Color = Get-SchemeUntypedColor $script:THEME.appearance.colors
    $subAltBrush.Color = $T.surface.Color
    $gridBrush.Color = $T.rule.Color
    Sync-ThemeResources
    Update-UiHalo
    return
  }
  # A Monkeytype theme (Get-ThemeLook), kept per theme and see-through, so walking the picker
  # stays quick.
  $key = '{0}|{1}' -f $Name, $opacity
  $look = $script:themeLooks[$key]
  if (-not $look) {
    $look = Get-ThemeLook $colors $opacity
    $script:themeLooks[$key] = $look
  }
  foreach ($role in $THEME_ROLES) { $T[$role].Color = $look[$role] }
  $untypedBrush.Color = $look.dim
  $subAltBrush.Color = $look.subAlt
  $gridBrush.Color = $look.subAlt
  Sync-ThemeResources
  Update-UiHalo
}

# The halo for low see-through is the shared one (Chrome.ps1 New-UiHaloFrame / Update-UiHalo).
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

# How far a line of this font (the window's, unless given) at this size reaches below its
# baseline: the gap that lines up text of two sizes on one baseline when both sit on the same
# bottom edge.
function Get-Descent([double]$Size, $Family = $null, [switch]$Heavy) {
  try {
    $fontFamily = $Family
    if (-not $fontFamily) { $fontFamily = $typeFont }
    $weight = [System.Windows.FontWeights]::Normal
    if ($Heavy) { $weight = [System.Windows.FontWeights]::Bold }
    $face = New-Object System.Windows.Media.Typeface($fontFamily, [System.Windows.FontStyles]::Normal, $weight, [System.Windows.FontStretches]::Normal)
    $sample = New-Object System.Windows.Media.FormattedText('Ag', [System.Globalization.CultureInfo]::InvariantCulture, [System.Windows.FlowDirection]::LeftToRight, $face, $Size, $textBrush)
    return [double]($sample.Height - $sample.Baseline)
  } catch { return $Size * 0.24 }
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
$card.CornerRadius = New-Object System.Windows.CornerRadius($UI_CARD_RADIUS)
$card.Background = $bgBrush
$card.BorderBrush = $edgeBrush
$card.BorderThickness = New-Object System.Windows.Thickness(1)

# Header, as every game's: the name (the title role), the test's settings, the other windows
# (games mark) and the close mark. The name and the settings share one baseline, the marks are
# centred on the row. Dragging it moves the window.
$header = New-Object System.Windows.Controls.DockPanel
$header.Cursor = [System.Windows.Input.Cursors]::SizeAll
$header.Background = $noFill
$logo = New-UiTitle 'typetest'
$logo.VerticalAlignment = 'Bottom'
[System.Windows.Controls.DockPanel]::SetDock($logo, 'Left')
$closeMark = New-UiMark $UI_GLYPHS.close 'Close'
$closeMark.Margin = New-Gap 4 0 0 0
[System.Windows.Controls.DockPanel]::SetDock($closeMark, 'Right')
$gamesMark = New-UiMark $UI_GLYPHS.games 'Learn and the other games'
$gamesMark.Margin = New-Gap 8 0 0 0
[System.Windows.Controls.DockPanel]::SetDock($gamesMark, 'Right')
$settingsText = New-Object System.Windows.Controls.TextBlock
$settingsText.FontSize = 13
$settingsText.VerticalAlignment = 'Bottom'
$settingsText.Margin = New-Gap 0 0 0 ([Math]::Max(0.0, (Get-Descent 20 $UI_MONO -Heavy) - (Get-Descent 13)))
[System.Windows.Controls.DockPanel]::SetDock($settingsText, 'Right')
foreach ($part in @(@('words ', $mainBrush), @("$WORD_COUNT", $mainBrush), @('  english', $subBrush))) {
  $run = New-Object System.Windows.Documents.Run($part[0])
  $run.Foreground = $part[1]
  [void]$settingsText.Inlines.Add($run)
}
[void]$header.Children.Add($logo)
[void]$header.Children.Add($closeMark)
[void]$header.Children.Add($gamesMark)
[void]$header.Children.Add($settingsText)
[void]$header.Children.Add((New-Object System.Windows.Controls.Border))

# Under the games mark: Learn and the other games, a click away. The row ends on the close
# mark's right edge, and closes (switching the mark off) after a pick.
$switcher = New-UiSwitcherRow 'typing' $OwnerHwnd $SessionId
$switcher.Tag = @{ mark = $gamesMark }
$switcher.Margin = New-Gap 0 8 0 0
$switcher.HorizontalAlignment = 'Right'
$switcher.Visibility = 'Collapsed'

# The typing view: the live count, the words, the caret over them, and the
# "click to focus" veil Monkeytype shows when the window is not in front. It
# sits in the middle of the space the result view holds, as Monkeytype's does.
$typingView = New-Object System.Windows.Controls.StackPanel
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
# The words wear the blur themselves (out of focus), so their halo goes on a holder of their own.
$wordsHolder = New-Object System.Windows.Controls.Border
$wordsHolder.Child = $wordsPanel
[void]$wordsHost.Children.Add((New-UiHaloFrame $wordsHolder))
[void]$wordsHost.Children.Add($caretLayer)
[void]$wordsHost.Children.Add((New-UiHaloFrame $focusVeil))
[void]$typingView.Children.Add((New-UiHaloFrame $progressText))
[void]$typingView.Children.Add($wordsHost)

# The result view: wpm and acc large on the left, the speed graph on the right,
# then the details row.
$resultView = New-Object System.Windows.Controls.Grid
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
  $name = New-Text $Label $subBrush $BIG_LABEL_SIZE
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

# The details row: the labels on one line, the values on one baseline under them. Each value sits
# on its row's bottom edge; the two-line test type is lifted by the difference in descent so its
# last line shares the numbers' baseline.
$DETAIL_COUNT = 5
$details = New-Object System.Windows.Controls.Grid
$details.Margin = New-Gap 0 16 0 0
for ($k = 0; $k -lt 2; $k++) {
  $row = New-Object System.Windows.Controls.RowDefinition
  $row.Height = [System.Windows.GridLength]::Auto
  [void]$details.RowDefinitions.Add($row)
}
for ($k = 0; $k -lt $DETAIL_COUNT; $k++) {
  $column = New-Object System.Windows.Controls.ColumnDefinition
  $column.Width = [System.Windows.GridLength]::Auto
  [void]$details.ColumnDefinitions.Add($column)
}
[System.Windows.Controls.Grid]::SetRow($details, 1)
[System.Windows.Controls.Grid]::SetColumnSpan($details, 2)

function New-DetailStat([string]$Label, [int]$At, [double]$ValueSize = 30) {
  $space = 40
  if ($At -eq $DETAIL_COUNT - 1) { $space = 0 }
  $name = New-Text $Label $subBrush $DETAIL_LABEL_SIZE
  $name.Margin = New-Gap 0 0 $space 0
  $value = New-Text '-' $mainBrush $ValueSize
  $value.Margin = New-Gap 0 -2 $space 0
  $value.VerticalAlignment = 'Bottom'
  [System.Windows.Controls.Grid]::SetRow($name, 0)
  [System.Windows.Controls.Grid]::SetColumn($name, $At)
  [System.Windows.Controls.Grid]::SetRow($value, 1)
  [System.Windows.Controls.Grid]::SetColumn($value, $At)
  [void]$details.Children.Add($name)
  [void]$details.Children.Add($value)
  return @{ name = $name; value = $value }
}

$typeStat = New-DetailStat 'test type' 0 14
$typeStat.value.Text = "words $WORD_COUNT`nenglish"
$typeStat.value.Margin = New-Gap 0 -2 40 ((Get-Descent 30) - (Get-Descent 14))
$rawStat = New-DetailStat 'raw' 1
$charsStat = New-DetailStat 'characters' 2
$charsStat.name.ToolTip = 'correct, incorrect, extra, and missed'
$charsStat.value.ToolTip = $charsStat.name.ToolTip
$consistencyStat = New-DetailStat 'consistency' 3
$timeStat = New-DetailStat 'time' 4
[void]$resultView.Children.Add($details)

# The two views share one place; the hidden one still holds the size, so the
# window does not jump between them.
$testLayer = New-Object System.Windows.Controls.Grid
[void]$testLayer.Children.Add($typingView)
[void]$testLayer.Children.Add((New-UiHaloFrame $resultView))

# The theme picker: a search box and every theme as a swatch, in the theme's
# own colours. It takes the test's place while open (the test is hidden under
# it, so the see-through card shows nothing behind the swatches).
$picker = New-Object System.Windows.Controls.DockPanel
$picker.Background = $noFill
$picker.Visibility = 'Collapsed'
$searchHost = New-Object System.Windows.Controls.Border
$searchHost.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
$searchHost.Background = $subAltBrush
[System.Windows.Controls.DockPanel]::SetDock($searchHost, 'Top')
$searchLayers = New-Object System.Windows.Controls.Grid
$searchBox = New-Object System.Windows.Controls.TextBox
$searchBox.Background = $noFill
$searchBox.Foreground = $textBrush
$searchBox.CaretBrush = $caretBrush
$searchBox.SelectionBrush = $mainBrush
$searchBox.BorderThickness = New-Object System.Windows.Thickness(0)
$searchBox.FontFamily = $typeFont
$searchBox.FontSize = 15
$searchBox.Padding = New-Gap 10 6 10 6
$searchBox.VerticalContentAlignment = 'Center'
$searchBox.FocusVisualStyle = $null
# The hint starts where typed text does: the box's padding plus the text box's own 2px.
$searchHint = New-Text 'search themes...' $subBrush 15
$searchHint.Margin = New-Gap 12 0 12 0
$searchHint.VerticalAlignment = 'Center'
$searchHint.TextTrimming = 'CharacterEllipsis'
$searchHint.IsHitTestVisible = $false
[void]$searchLayers.Children.Add($searchBox)
[void]$searchLayers.Children.Add($searchHint)
$searchHost.Child = New-UiHaloFrame $searchLayers
$themeScroll = New-Object System.Windows.Controls.ScrollViewer
$themeScroll.VerticalScrollBarVisibility = 'Auto'
$themeScroll.HorizontalScrollBarVisibility = 'Disabled'
$themeScroll.Margin = New-Gap 0 8 (-$SCROLL_GUTTER) 0
$themeScroll.Focusable = $false
# Its height is a whole number of rows (Set-PickerRows), so no row is cut in half at the bottom;
# the last row's gap is taken back, so scrolled to the end the rows still start at the top.
$themeScroll.VerticalAlignment = 'Top'
$themeGrid = New-Object System.Windows.Controls.WrapPanel
$themeGrid.HorizontalAlignment = 'Left'
$themeGrid.Margin = New-Gap 0 0 0 (-$SWATCH_GAP)
$themeScroll.Content = $themeGrid
[void]$picker.Children.Add($searchHost)
[void]$picker.Children.Add($themeScroll)

$views = New-Object System.Windows.Controls.Grid
$views.Margin = New-Gap 0 12 0 0
[void]$views.Children.Add($testLayer)
[void]$views.Children.Add($picker)

# Footer, three columns: the keys in the middle, centred on the card, and the
# theme's name on the right (trimmed rather than running into the keys). Tab
# restarts, Esc or a click on the name picks a theme.
function New-KeyChip([string]$Key) {
  $chip = New-Object System.Windows.Controls.Border
  $chip.Background = $subAltBrush
  $chip.CornerRadius = New-Object System.Windows.CornerRadius(4)
  $chip.Padding = New-Gap 6 1 6 2
  $chip.VerticalAlignment = 'Center'
  $chip.Child = New-Text $Key $textBrush 12
  return $chip
}

function New-KeyHint([string]$Text) {
  $hint = New-Text $Text $subBrush 12
  $hint.VerticalAlignment = 'Center'
  return $hint
}

$footer = New-Object System.Windows.Controls.Grid
$footer.Margin = New-Gap 0 12 0 0
foreach ($width in @('*', 'Auto', '*')) {
  $column = New-Object System.Windows.Controls.ColumnDefinition
  if ($width -eq 'Auto') { $column.Width = [System.Windows.GridLength]::Auto } else { $column.Width = New-Object System.Windows.GridLength(1, 'Star') }
  [void]$footer.ColumnDefinitions.Add($column)
}
$hints = New-Object System.Windows.Controls.StackPanel
$hints.Orientation = 'Horizontal'
$hints.VerticalAlignment = 'Center'
[void]$hints.Children.Add((New-KeyChip 'tab'))
[void]$hints.Children.Add((New-KeyHint ' - restart test'))
$escChip = New-KeyChip 'esc'
$escChip.Margin = New-Gap 18 0 0 0
[void]$hints.Children.Add($escChip)
[void]$hints.Children.Add((New-KeyHint ' - themes'))
[System.Windows.Controls.Grid]::SetColumn($hints, 1)
$themeButton = New-Object System.Windows.Controls.DockPanel
$themeButton.HorizontalAlignment = 'Right'
$themeButton.VerticalAlignment = 'Center'
# The right margin keeps the label clear of the resize grip in the card's corner.
$themeButton.Margin = New-Gap 16 0 10 0
$themeButton.Cursor = [System.Windows.Input.Cursors]::Hand
$themeButton.Background = $noFill
$themeDot = New-Object System.Windows.Shapes.Ellipse
$themeDot.Width = 9
$themeDot.Height = 9
$themeDot.Fill = $mainBrush
$themeDot.VerticalAlignment = 'Center'
$themeDot.Margin = New-Gap 0 1 6 0
[System.Windows.Controls.DockPanel]::SetDock($themeDot, 'Left')
$themeLabel = New-Text '' $subBrush 12
$themeLabel.VerticalAlignment = 'Center'
$themeLabel.TextTrimming = 'CharacterEllipsis'
$themeLabel.MaxWidth = 160
[void]$themeButton.Children.Add($themeDot)
[void]$themeButton.Children.Add($themeLabel)
[System.Windows.Controls.Grid]::SetColumn($themeButton, 2)
$themeButton.Add_MouseEnter({ $themeLabel.Foreground = $textBrush })
$themeButton.Add_MouseLeave({ $themeLabel.Foreground = $subBrush })
[void]$footer.Children.Add($hints)
[void]$footer.Children.Add($themeButton)

# The card's content, at the games' padding (Monkeytype's air is in the test area, which
# holds the result's height); the grip sits in the padding's corner, inside the card, so it
# scales with it.
$stackAll = New-Object System.Windows.Controls.StackPanel
$stackAll.Margin = New-Gap 16 12 16 14
[void]$stackAll.Children.Add((New-UiHaloFrame $header))
[void]$stackAll.Children.Add((New-UiHaloFrame $switcher))
[void]$stackAll.Children.Add($views)
[void]$stackAll.Children.Add((New-UiHaloFrame $footer))

# The resize grip, bottom-right: the window is pinned by its top-left corner,
# so pulling the grip out (right or down) grows it.
$grip = New-UiGrip 'right'
$grip.Margin = New-Gap 0 0 5 3

$cardBody = New-Object System.Windows.Controls.Grid
[void]$cardBody.Children.Add($stackAll)
[void]$cardBody.Children.Add((New-UiHaloFrame $grip))
$card.Child = $cardBody

$cardScale = New-Object System.Windows.Media.ScaleTransform($script:scale, $script:scale)
$card.LayoutTransform = $cardScale

$cardHost = New-Object System.Windows.Controls.Grid
[void]$cardHost.Children.Add($card)
Add-ThemeResources $win
# Theme.ps1 paints the styles' names from the scheme; this points the four the scrollbar and
# tooltips use at the Monkeytype theme's colours when one is in use.
Sync-ThemeResources
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
    $color = $untypedBrush
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

function Get-ThemeTitle([string]$Name) {
  if ($Name -eq $AUTO_THEME) { return 'follow colour scheme' }
  return $Name.Replace('_', ' ')
}

# What a search looks in: the title, and for 'auto' the other words someone might try.
function Get-ThemeKeywords([string]$Name) {
  if ($Name -eq $AUTO_THEME) { return 'follow colour scheme color auto default' }
  return Get-ThemeTitle $Name
}

# The scheme in use, by its preset's name, or 'custom' for colours of one's own.
function Get-SchemeName {
  $current = $script:THEME.appearance
  foreach ($preset in (Get-ThemePresets)) {
    $isSame = $preset.name -eq $current.preset -and $preset.bg.ToUpperInvariant() -eq $current.colors.bg -and $preset.accent.ToUpperInvariant() -eq $current.colors.accent -and $preset.text.ToUpperInvariant() -eq $current.colors.text
    if ($isSame) { return $preset.label.ToLowerInvariant() }
  }
  return 'custom'
}

function Set-Theme([string]$Name) {
  $script:themeName = $Name
  Set-Colors $Name
  Update-ThemeLabel
}

# The footer names the theme in use; for 'auto', the scheme it follows, as a name (ember, paper).
function Update-ThemeLabel {
  if ($script:themeName -eq $AUTO_THEME) {
    $themeLabel.Text = Get-SchemeName
    $themeButton.ToolTip = 'Follows the colour scheme (Esc for themes)'
  } else {
    $themeLabel.Text = Get-ThemeTitle $script:themeName
    $themeButton.ToolTip = 'Themes (Esc)'
  }
}

# One swatch: the theme's name in its main colour on its background, and dots of its text and
# sub colours. 'auto' spans the whole first row and names the scheme it follows.
function New-Swatch([string]$Name, [int]$Index) {
  $swatch = New-Object System.Windows.Controls.Border
  $swatch.Height = $SWATCH_H
  $swatch.Margin = New-Gap 0 0 $SWATCH_GAP $SWATCH_GAP
  $swatch.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $swatch.Cursor = [System.Windows.Input.Cursors]::Hand
  $swatch.Tag = $Index
  # The ring is a layer of its own over the fill, so a swatch's fill reaches the grid's edges
  # whether or not it is the one chosen, and choosing one moves nothing (Set-SwatchRing).
  $ring = New-Object System.Windows.Controls.Border
  $ring.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $ring.BorderThickness = New-Object System.Windows.Thickness(2)
  $ring.BorderBrush = $noFill
  $ring.IsHitTestVisible = $false
  $entry = @{
    name = $Name; swatch = $swatch; ring = $ring; note = $null
    fill = Brush '#000000'; main = Brush '#000000'; text = Brush '#000000'; sub = Brush '#000000'
  }
  $swatch.Background = $entry.fill
  $inside = New-Object System.Windows.Controls.DockPanel
  $inside.Margin = New-Gap 9 0 8 0
  $dots = New-Object System.Windows.Controls.StackPanel
  $dots.Orientation = 'Horizontal'
  $dots.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($dots, 'Right')
  foreach ($fill in @($entry.text, $entry.sub)) {
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 7
    $dot.Height = 7
    $dot.Margin = New-Gap 3 0 0 0
    $dot.Fill = $fill
    [void]$dots.Children.Add($dot)
  }
  [void]$inside.Children.Add($dots)
  if ($Name -eq $AUTO_THEME) {
    $swatch.ToolTip = 'The colour scheme every window shares'
    $entry.note = New-Text '' $entry.sub 12
    $entry.note.VerticalAlignment = 'Center'
    $entry.note.Margin = New-Gap 12 0 6 0
    [System.Windows.Controls.DockPanel]::SetDock($entry.note, 'Right')
    [void]$inside.Children.Add($entry.note)
  }
  $title = New-Text (Get-ThemeTitle $Name) $entry.main 12
  $title.VerticalAlignment = 'Center'
  $title.TextTrimming = 'CharacterEllipsis'
  [void]$inside.Children.Add($title)
  $layers = New-Object System.Windows.Controls.Grid
  [void]$layers.Children.Add($inside)
  [void]$layers.Children.Add($ring)
  $swatch.Child = $layers
  $swatch.Add_MouseEnter({ param($sender, $e) Select-Swatch ([array]::IndexOf($script:shown, $script:swatches[[int]$sender.Tag])) })
  $swatch.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; Close-Picker $true })
  Update-SwatchLook $entry
  return $entry
}

# The chosen swatch is ringed in the text colour of the theme it previews.
function Set-SwatchRing($Entry, [bool]$On) {
  if ($On) { $Entry.ring.BorderBrush = $textBrush } else { $Entry.ring.BorderBrush = $noFill }
}

function Update-SwatchLook($Entry) {
  $colors = $script:themes[$Entry.name]
  $Entry.fill.Color = ConvertTo-Color $colors[0]
  $Entry.main.Color = ConvertTo-Color $colors[1]
  $Entry.text.Color = ConvertTo-Color $colors[5]
  $Entry.sub.Color = ConvertTo-Color $colors[3]
  if ($Entry.note) { $Entry.note.Text = Get-SchemeName }
}

# Every swatch, built the first time the picker opens.
function Build-Swatches {
  if ($script:swatches.Count -gt 0) { return }
  $built = @()
  foreach ($name in $script:themes.Keys) {
    $entry = New-Swatch $name $built.Count
    [void]$themeGrid.Children.Add($entry.swatch)
    $built += , $entry
  }
  $script:swatches = $built
}

# Sizes the grid from the width the picker really has: as many columns as fit, the swatches
# stretched to fill it, so the grid's edges are the search box's edges. The trailing gap of each
# row falls outside the scroll area, and the scrollbar sits in the card's right padding.
function Set-SwatchSizes {
  $width = [Math]::Floor([double]$views.ActualWidth)
  if ($width -le 0) { $width = [double]$WORDS_WIDTH }
  $columns = [Math]::Max(1, [int][Math]::Floor(($width + $SWATCH_GAP) / ($SWATCH_MIN_W + $SWATCH_GAP)))
  $each = [Math]::Floor(($width - ($columns - 1) * $SWATCH_GAP) / $columns)
  $themeGrid.Width = $columns * ($each + $SWATCH_GAP)
  $themeScroll.Width = $width + $SCROLL_GUTTER
  foreach ($entry in $script:swatches) {
    if ($entry.name -eq $AUTO_THEME) { $entry.swatch.Width = $width } else { $entry.swatch.Width = $each }
  }
}

# Moves the choice to the index-th shown swatch and previews its theme.
function Select-Swatch([int]$Index) {
  if ($script:shown.Count -eq 0 -or $Index -lt 0) { return }
  $Index = [Math]::Min($script:shown.Count - 1, $Index)
  if ($script:pickIndex -ge 0 -and $script:pickIndex -lt $script:shown.Count) { Set-SwatchRing $script:shown[$script:pickIndex] $false }
  $script:pickIndex = $Index
  $chosen = $script:shown[$Index]
  Set-SwatchRing $chosen $true
  $chosen.swatch.BringIntoView()
  Set-Colors $chosen.name
}

# Typing in the search box keeps the themes whose name has it.
function Update-Filter {
  $query = $searchBox.Text.Trim().ToLowerInvariant().Replace('_', ' ')
  if ($query) { $searchHint.Visibility = 'Hidden' } else { $searchHint.Visibility = 'Visible' }
  $kept = @()
  foreach ($entry in $script:swatches) {
    $isKept = -not $query -or (Get-ThemeKeywords $entry.name).Contains($query)
    if ($isKept) { $entry.swatch.Visibility = 'Visible'; $kept += , $entry } else { $entry.swatch.Visibility = 'Collapsed' }
    Set-SwatchRing $entry $false
  }
  $script:shown = $kept
  $script:pickIndex = -1
  if ($kept.Count -gt 0) { Select-Swatch 0 } else { Set-Colors $script:themeBefore }
}

function Open-Picker {
  if ($script:isPicking) { return }
  Build-Swatches
  Set-SwatchSizes
  $script:isPicking = $true
  $script:themeBefore = $script:themeName
  $picker.Height = [Math]::Max(240, $testLayer.ActualHeight)
  $searchBox.Text = ''
  Update-Filter
  $current = 0
  for ($k = 0; $k -lt $script:shown.Count; $k++) { if ($script:shown[$k].name -eq $script:themeName) { $current = $k; break } }
  $testLayer.Visibility = 'Hidden'
  $picker.Visibility = 'Visible'
  $caret.Visibility = 'Hidden'
  $win.UpdateLayout()
  Set-PickerRows
  $win.UpdateLayout()
  Select-Swatch $current
  [void][System.Windows.Input.Keyboard]::Focus($searchBox)
}

# The swatches' area shows whole rows: as many as fit under the search box in the picker's height.
function Set-PickerRows {
  $room = [double]$picker.Height - [double]$searchHost.ActualHeight - [double]$themeScroll.Margin.Top
  $rows = [Math]::Max(1, [int][Math]::Floor(($room + $SWATCH_GAP) / ($SWATCH_H + $SWATCH_GAP)))
  $themeScroll.Height = $rows * ($SWATCH_H + $SWATCH_GAP) - $SWATCH_GAP
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
  $testLayer.Visibility = 'Visible'
  [void]$win.Focus()
  [void][System.Windows.Input.Keyboard]::Focus($win)
  if (-not $script:isFinished) { $caret.Visibility = 'Visible'; Move-Caret -Jump }
}

# Where a swatch sits in the grid (its top-left corner), for walking it with the arrows.
function Get-SwatchSpot($Swatch) {
  return $Swatch.TranslatePoint((New-Object System.Windows.Point(0, 0)), $themeGrid)
}

# Left and Right step through the themes in order; Up and Down go to the nearest row above or
# below, to the swatch whose left edge is nearest. Read from the grid as laid out, so it holds
# for any width, and for the 'auto' row that spans it.
function Move-Pick([int]$Columns, [int]$Rows) {
  if ($script:shown.Count -eq 0) { return }
  if ($script:pickIndex -lt 0) { Select-Swatch 0; return }
  if ($Rows -eq 0) {
    Select-Swatch ([Math]::Max(0, [Math]::Min($script:shown.Count - 1, $script:pickIndex + $Columns)))
    return
  }
  $themeGrid.UpdateLayout()
  $from = Get-SwatchSpot $script:shown[$script:pickIndex].swatch
  $best = -1
  $bestDy = [double]::MaxValue
  $bestDx = [double]::MaxValue
  for ($k = 0; $k -lt $script:shown.Count; $k++) {
    $spot = Get-SwatchSpot $script:shown[$k].swatch
    $dy = ($spot.Y - $from.Y) * $Rows
    if ($dy -lt 1) { continue }
    $dx = [Math]::Abs($spot.X - $from.X)
    $isNearerRow = $dy -lt $bestDy - 1
    $isSameRow = [Math]::Abs($dy - $bestDy) -le 1
    if ($isNearerRow -or ($isSameRow -and $dx -lt $bestDx)) { $best = $k; $bestDy = $dy; $bestDx = $dx }
  }
  if ($best -ge 0) { Select-Swatch $best }
}

# The colour scheme changed in another window: 'auto' takes the new scheme, and every theme the
# games' new see-through. The scheme's brushes were just repainted from the file, so a Monkeytype
# theme in use (or being previewed) is laid over them again.
function Update-SchemeColors {
  $script:themes[$AUTO_THEME] = Get-AutoColors
  foreach ($entry in $script:swatches) { if ($entry.name -eq $AUTO_THEME) { Update-SwatchLook $entry } }
  Set-Colors $script:shownTheme
  Update-ThemeLabel
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

$closeMark.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $win.Close() })
$gamesMark.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  $isOpen = $switcher.Visibility -ne 'Visible'
  $switcher.Visibility = if ($isOpen) { 'Visible' } else { 'Collapsed' }
  Set-UiMarkOn $gamesMark $isOpen
})

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
  if ($SnapshotSwitcher) {
    $switcher.Visibility = 'Visible'
    Set-UiMarkOn $gamesMark $true
  }
  # 'themes': the picker open on the theme in use, scrolled to it.
  if ($SnapshotView -eq 'themes') {
    Open-Picker
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
  # A colour scheme or see-through change made in another window: the scheme's brushes repaint
  # themselves, and the theme in use is laid over them again. A failed recolour is logged, never
  # allowed to take the window down.
  try { if (Update-Theme) { Update-SchemeColors } } catch { Write-Failure $_ }
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
