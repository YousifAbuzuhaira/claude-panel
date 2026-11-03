#Requires -Version 5.1
# Learn: courses Claude builds from free videos and docs, read page by page with a Claude
# chat beside each page. Opened from the progress panel (its Learn tab or the games row).
#
# Everything about the library lives in WSL and goes through one helper process,
# learn/learn.sh serve, spoken to in JSON lines: this window never touches the library's
# files. Builds run in WSL on their own, so closing the window doesn't stop them. The
# window keeps only its own place, size and text size in %LOCALAPPDATA%\ClaudePhases\learn.json.
#
# One window per machine (the library is one), owned by the WezTerm window it opened
# from. PowerShell names ignore case: constants are $UPPER_SNAKE and script state is
# always $script:. No PowerShell runs on a background thread: the helper's output is
# read by C# threads (LearnCore.cs) and drained by a DispatcherTimer. Kept to ASCII:
# every non-ASCII glyph is built from its code point.

param(
  [int64]$OwnerHwnd = 0,
  [string]$SessionId = 'default',
  # Where to open: -View library|course|learned|ask|settings and -CourseId <id>. A Learn that is
  # already open gets the same through %LOCALAPPDATA%\ClaudePhases\learn-open.json.
  # (Named apart from $script:view and $script:courseId: PowerShell names ignore case.)
  [Alias('View')][string]$StartView = '',
  [Alias('CourseId')][string]$StartCourse = '',
  # Testing aids: check the drawing and the dispatch and exit; or draw a view to a PNG
  # and exit, from a library and config of the snapshot's own (WSL paths).
  [switch]$SelfTest,
  [string]$SnapshotPath = '',
  [ValidateSet('library', 'course', 'overlap', 'learned', 'ask', 'settings')][string]$SnapshotView = 'library',
  [string]$SnapshotLibrary = '',
  [string]$SnapshotConfig = '',
  [string]$SnapshotCourse = '',
  [int]$SnapshotPage = 1,
  # A snapshot at another size than the default (to check the 960x560 minimum, say).
  [int]$SnapshotWidth = 0,
  [int]$SnapshotHeight = 0,
  # A snapshot with the row of other windows open under the header, as the games mark opens it.
  [switch]$SnapshotGames,
  # A Library snapshot with New course set to build from a document or a chat.
  [ValidateSet('', 'topic', 'document', 'chat')][string]$SnapshotSource = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Send-Event($Payload) {
  try {
    [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
  } catch {}
}

# A failure inside a handler goes to %TEMP%\learn-error.log instead of stopping the window.
function Write-Failure($Failure) {
  try {
    $text = "$([DateTime]::Now.ToString('s')) $($Failure.Exception.Message)`n$($Failure.ScriptStackTrace)`n"
    Add-Content -Path (Join-Path $env:TEMP 'learn-error.log') -Value $text -Encoding ASCII
  } catch {}
}

# --- The C# core, compiled once per version and kept as a DLL (as the chess game does) ------

$CORE_REFERENCES = @('System.dll', 'System.Core.dll')
$CORE_SALT = 'learn-core-1'

function Import-Core {
  if ('LearnCore.LineProcess' -as [type]) { return }
  $source = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'LearnCore.cs'), [System.Text.Encoding]::ASCII)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $salted = [System.Text.Encoding]::ASCII.GetBytes($source + $CORE_SALT + ($CORE_REFERENCES -join ',') + $PSVersionTable.PSVersion.Major)
  $hash = ([BitConverter]::ToString($sha.ComputeHash($salted))).Replace('-', '').Substring(0, 16)
  $cacheRoot = Join-Path $env:LOCALAPPDATA 'ClaudePhases\cache-learn'
  $dir = Join-Path $cacheRoot $hash
  $dll = Join-Path $dir 'LearnCore.dll'
  try {
    if (-not [System.IO.File]::Exists($dll)) {
      [void][System.IO.Directory]::CreateDirectory($dir)
      $temp = Join-Path $dir "build-$PID.dll"
      Add-Type -TypeDefinition $source -ReferencedAssemblies $CORE_REFERENCES -OutputAssembly $temp -OutputType Library
      if (-not [System.IO.File]::Exists($dll)) { Copy-Item -LiteralPath $temp -Destination $dll -ErrorAction SilentlyContinue }
      Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue
    }
    if (-not ('LearnCore.LineProcess' -as [type])) { Add-Type -Path $dll }
    foreach ($old in [System.IO.Directory]::GetDirectories($cacheRoot)) {
      if ((Split-Path $old -Leaf) -ne $hash) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
    }
  } catch {
    Write-Failure $_
    if (-not ('LearnCore.LineProcess' -as [type])) { Add-Type -TypeDefinition $source -ReferencedAssemblies $CORE_REFERENCES }
  }
}

Import-Core
[void][LearnCore.LearnWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# The colour scheme and see-through every window shares (appearance.json), and the shared pieces.
. (Join-Path $PSScriptRoot 'Theme.ps1')
$T = Initialize-Theme 'learn'
. (Join-Path $PSScriptRoot 'Chrome.ps1')

# --- Where the helper is: this script sits at \\wsl.localhost\<distro>\...\widget ---------

$scriptRoot = [string]$PSScriptRoot
$wslMatch = [regex]::Match($scriptRoot, '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)$', 'IgnoreCase')
$DISTRO = if ($wslMatch.Success) { $wslMatch.Groups[1].Value } else { '' }
$HELPER_SCRIPT = if ($wslMatch.Success) { ($wslMatch.Groups[2].Value -replace '\\', '/') -replace '/widget$', '/learn/learn.sh' } else { '' }

# --- Constants --------------------------------------------------------------------------

$GLYPH_CLOSE = [string][char]0x2715
$GLYPH_GRIP = [string][char]0x25E2
$GLYPH_DOT = [string][char]0x00B7
$GLYPH_CHECK = [string][char]0x2713
$GLYPH_EMPTY = [string][char]0x25CB
$GLYPH_FULL = [string][char]0x25CF
$GLYPH_HALF = [string][char]0x25D0
$GLYPH_PLAY = [string][char]0x25B6
$GLYPH_LINK = [string][char]0x2197
$GLYPH_LEFT = [string][char]0x2190
$GLYPH_RIGHT = [string][char]0x2192
$GLYPH_SKIP = [string][char]0x2298
$GLYPH_DASH = [string][char]0x2014
$GLYPH_ELLIPSIS = [string][char]0x2026
$GLYPH_PENDING = [string][char]0x25CC
$GLYPH_UP = [string][char]0x2191
$GLYPH_DOWN = [string][char]0x2193
# At 960 the course view's page keeps its 420 with the contents and the chat at their narrowest.
$MIN_WIDTH = 960
$MIN_HEIGHT = 560
$DEFAULT_WIDTH = 1180
$DEFAULT_HEIGHT = 780
$MIN_TEXT = 0.8
$MAX_TEXT = 1.5
$BASE_TEXT = 14.5
$TOAST_MS = 5000
$VIEW_NAMES = @('library', 'course', 'learned', 'ask', 'settings')
$VIEW_LABELS = @{ library = 'Library'; course = 'Course'; learned = 'Learned'; ask = 'Ask'; settings = 'Settings' }
$VIEW_TIPS = @{
  library = 'Your courses, and new ones  (Ctrl+1)'
  course = 'The course you are reading  (Ctrl+2)'
  learned = 'Everything you have learned  (Ctrl+3)'
  ask = 'Ask what to learn next  (Ctrl+4)'
  settings = 'Settings and colours  (Ctrl+5)'
}
# How wide the views can get on a wide window (they start on the header's left edge; the rest is
# left over on the right), and the lesson page's reading width in ems of the text size, so a line
# keeps about 75 characters at any text size.
$CONTENT_MAX = 980
$READING_EMS = 38
# A chat message's inset from its column: your box's padding, and the same for Claude's text.
$MESSAGE_INSET = 8
# Under this see-through, Settings says text can get hard to read over what shows through.
$SEE_THROUGH_LOW = 0.6
# The thin scrollbar's own width. Lists keep this lane for it whether they scroll or not, beside
# their rows' hover fill, so nothing moves when a bar comes or goes.
$SCROLL_LANE = 9
$CONTENTS_WIDTH = 250
$CHAT_WIDTH = 360
# On a narrow window the page keeps at least this much: the chat gives up to 60 first, then the
# contents up to 50.
$PAGE_MIN_WIDTH = 420
$CHAT_MIN_WIDTH = 300
$CONTENTS_MIN_WIDTH = 200
$GLYPH_NBSP = [string][char]0x00A0
$GLYPH_DOC = [string][char]0x25A4   # a page of lines: a document
$GLYPH_CHAT = [string][char]0x275D  # a quote mark: from a chat
$PAGE_GLYPH_WIDTH = 20
$LEARN_REQUEST_FILE = Join-Path $env:LOCALAPPDATA 'ClaudePhases\learn-open.json'
$LEARN_REQUEST_MAX_MS = 15000
$MODEL_CHOICES = @(@{ key = 'sonnet'; label = 'Sonnet' }, @{ key = 'opus'; label = 'Opus' }, @{ key = 'haiku'; label = 'Haiku' })

# --- One window per machine -------------------------------------------------------------

$WINDOW_TITLE = 'ClaudeLearn'
$mutex = New-Object System.Threading.Mutex($false, 'Local\ClaudeLearn')
try {
  $isOwner = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $isOwner = $true
}
if (-not $isOwner -and -not $SnapshotPath -and -not $SelfTest) {
  # The open one picks up where to go from the request file, on its timer.
  Write-LearnRequest $StartView $StartCourse
  $existing = [LearnCore.LearnWin32]::WindowByText($WINDOW_TITLE)
  if ($existing -ne [IntPtr]::Zero) { [void][LearnCore.LearnWin32]::SetForegroundWindow($existing) }
  exit 0
}

$owner = [IntPtr]$OwnerHwnd
$hasOwner = $owner -ne [IntPtr]::Zero -and [LearnCore.LearnWin32]::IsWindow($owner)

# --- The window's own prefs ----------------------------------------------------------------

$prefsFile = Join-Path $env:LOCALAPPDATA 'ClaudePhases\learn.json'
$script:offset = $null
$script:width = [double]$DEFAULT_WIDTH
$script:height = [double]$DEFAULT_HEIGHT
$script:textScale = 1.0
$script:view = 'library'
$script:courseId = $null
$script:showContents = $true

function Get-Clamped([double]$Value, [double]$Low, [double]$High, [double]$Fallback) {
  if ([double]::IsNaN($Value) -or $Value -lt $Low -or $Value -gt $High) { return $Fallback }
  return $Value
}

if (-not $SnapshotPath -and -not $SelfTest) {
  foreach ($path in @($prefsFile, "$prefsFile.bak")) {
    $text = [LearnCore.SafeFile]::Read($path)
    if (-not $text) { continue }
    try {
      $saved = $text | ConvertFrom-Json
      if ($null -ne $saved.dx) { $script:offset = @{ dx = [int]$saved.dx; dy = [int]$saved.dy } }
      # A size saved under today's minimum (it was smaller once) grows to it.
      $script:width = Get-Clamped ([Math]::Max([double]$saved.width, [double]$MIN_WIDTH)) $MIN_WIDTH 4000 $DEFAULT_WIDTH
      $script:height = Get-Clamped ([Math]::Max([double]$saved.height, [double]$MIN_HEIGHT)) $MIN_HEIGHT 3000 $DEFAULT_HEIGHT
      $script:textScale = Get-Clamped ([double]$saved.textScale) $MIN_TEXT $MAX_TEXT 1.0
      if ($VIEW_NAMES -contains [string]$saved.view) { $script:view = [string]$saved.view }
      if ($saved.courseId) { $script:courseId = [string]$saved.courseId }
      if ($null -ne $saved.showContents) { $script:showContents = [bool]$saved.showContents }
      break
    } catch {}
  }
}

# A request from another window to show a view or a course: @{ view; courseId }, or $null when
# there is none or it is older than 15 s (a window that asked and then never opened). Read once.
function Read-LearnRequest([string]$Path = $LEARN_REQUEST_FILE) {
  if (-not [System.IO.File]::Exists($Path)) { return $null }
  $request = $null
  try {
    $data = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$data.at
    if ($age -gt -5000 -and $age -le $LEARN_REQUEST_MAX_MS) {
      $request = @{ view = [string]$data.view; courseId = [string]$data.courseId }
    }
  } catch {}
  try { [System.IO.File]::Delete($Path) } catch {}
  return $request
}

# Where Learn opens: a fresh request, else -View / -CourseId, else where it was left.
if (-not $SnapshotPath -and -not $SelfTest) {
  $startRequest = Read-LearnRequest
  if (-not $startRequest) { $startRequest = @{ view = $StartView; courseId = $StartCourse } }
  if ($startRequest.courseId) {
    $script:courseId = [string]$startRequest.courseId
    $script:view = 'course'
  }
  if ($VIEW_NAMES -contains [string]$startRequest.view) { $script:view = [string]$startRequest.view }
}

if ($SnapshotPath -and $SnapshotWidth -gt 0) { $script:width = [double][Math]::Max($SnapshotWidth, $MIN_WIDTH) }
if ($SnapshotPath -and $SnapshotHeight -gt 0) { $script:height = [double][Math]::Max($SnapshotHeight, $MIN_HEIGHT) }

function Save-Prefs {
  if ($SnapshotPath -or $SelfTest) { return }
  try {
    $prefs = [ordered]@{
      version = 1
      width = [Math]::Round($script:width)
      height = [Math]::Round($script:height)
      textScale = [Math]::Round($script:textScale, 2)
      view = $script:view
      courseId = $script:courseId
      showContents = $script:showContents
    }
    if ($script:offset) { $prefs.dx = $script:offset.dx; $prefs.dy = $script:offset.dy }
    [LearnCore.SafeFile]::WriteAtomic($prefsFile, ($prefs | ConvertTo-Json -Compress))
  } catch { Write-Failure $_ }
}

function Get-TextSize { return [double]$BASE_TEXT * $script:textScale }

# --- Colours and fonts -----------------------------------------------------------------------

# The scheme's roles under the names the views use. They are the shared brushes themselves, so
# a scheme change repaints everything, and the by-reference checks (Set-Hover) keep working.
$ink = $T.ink
$dim = $T.dim
$faint = $T.faint
$accent = $T.accent
$accentSoft = $T.accentSoft
$onAccent = $T.onAccent
$green = $T.green
$greenSoft = $T.greenSoft
$red = $T.red
$redSoft = $T.redSoft
$gold = $T.gold
$blue = $T.blue
$blueSoft = $T.blueSoft
$surface = $T.surface
$surface2 = $T.surface2
$buttonFill = $T.button
$hover = $T.hover
$pressed = $T.pressed
$selected = $T.selected
$line = $T.line
$codeBg = $T.codeBg
$codeInline = $T.codeInline
$codeInk = $T.codeInk
$noFill = [System.Windows.Media.Brushes]::Transparent
$monoFont = New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas')
$readFont = New-Object System.Windows.Media.FontFamily('Segoe UI')

. (Join-Path $PSScriptRoot 'LearnRender.ps1')

# --- The window ------------------------------------------------------------------------------

$win = New-Object System.Windows.Window
$win.Title = $WINDOW_TITLE
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = $noFill
$win.ShowInTaskbar = -not $hasOwner
$win.ResizeMode = 'NoResize'
$win.Width = $script:width
$win.Height = $script:height
$win.FontFamily = $readFont
$win.FontSize = 13
if ($hasOwner) {
  $win.Left = -32000
  $win.Top = -32000
} else {
  $win.WindowStartupLocation = 'CenterScreen'
}

# Themed thin scrollbars and tooltips for everything in the window. They and the templates here
# (the inputs' borders, the text boxes' menu) find their colours as {DynamicResource Theme.<role>},
# which Theme.ps1 keeps in step with the scheme.
Add-ThemeResources $win

# The text boxes' right-click menu in the scheme too (the system's is a light box).
$MENU_XAML = @'
<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Style TargetType="ContextMenu">
    <Setter Property="OverridesDefaultStyle" Value="True"/>
    <Setter Property="SnapsToDevicePixels" Value="True"/>
    <Setter Property="HasDropShadow" Value="False"/>
    <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ContextMenu">
      <Border Background="{DynamicResource Theme.popup}" BorderBrush="{DynamicResource Theme.line}" BorderThickness="1" CornerRadius="6" Padding="4">
        <StackPanel IsItemsHost="True" KeyboardNavigation.DirectionalNavigation="Cycle"/>
      </Border>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType="MenuItem">
    <Setter Property="OverridesDefaultStyle" Value="True"/>
    <Setter Property="Foreground" Value="{DynamicResource Theme.ink}"/>
    <Setter Property="FontFamily" Value="Segoe UI"/>
    <Setter Property="FontSize" Value="12"/>
    <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="MenuItem">
      <Border x:Name="Bd" Background="Transparent" CornerRadius="4" Padding="10,4,10,5" MinWidth="120">
        <DockPanel>
          <TextBlock DockPanel.Dock="Right" Text="{TemplateBinding InputGestureText}" Foreground="{DynamicResource Theme.faint}" Margin="24,0,0,0"/>
          <ContentPresenter ContentSource="Header" RecognizesAccessKey="True"/>
        </DockPanel>
      </Border>
      <ControlTemplate.Triggers>
        <Trigger Property="IsHighlighted" Value="True"><Setter TargetName="Bd" Property="Background" Value="{DynamicResource Theme.hover}"/></Trigger>
        <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.45"/></Trigger>
      </ControlTemplate.Triggers>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
</ResourceDictionary>
'@
try { $win.Resources.MergedDictionaries.Add([System.Windows.Markup.XamlReader]::Parse($MENU_XAML)) } catch { Write-Failure $_ }

# The card is the window: its fill carries Learn's see-through; text and lines stay solid.
$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius($UI_CARD_RADIUS)
$card.Background = $T.cardFill
$card.BorderBrush = $T.edge
$card.BorderThickness = New-Object System.Windows.Thickness(1)

$frame = New-Object System.Windows.Controls.DockPanel
$frame.LastChildFill = $true
$frame.Margin = New-Gap 16 12 16 12

# Header: the name, the views, a build line, then the marks: the games (a row of them under the
# header) and close. Dragging it moves the window.
$header = New-Object System.Windows.Controls.DockPanel
$header.Background = $noFill
$header.Cursor = [System.Windows.Input.Cursors]::SizeAll
$header.MinHeight = 28
$header.Margin = New-Gap 0 0 0 10
[System.Windows.Controls.DockPanel]::SetDock($header, 'Top')
$titleText = New-UiTitle 'Learn'
$titleText.Margin = New-Gap 0 0 14 0
[System.Windows.Controls.DockPanel]::SetDock($titleText, 'Left')
$closeMark = New-UiMark $UI_GLYPHS.close 'Close  (Learn keeps building)'
$closeMark.Margin = New-Gap 4 0 0 0
[System.Windows.Controls.DockPanel]::SetDock($closeMark, 'Right')
$gamesMark = New-UiMark $UI_GLYPHS.games 'The games'
$gamesMark.Margin = New-Gap 12 0 0 0
[System.Windows.Controls.DockPanel]::SetDock($gamesMark, 'Right')
$tabsPanel = New-Object System.Windows.Controls.StackPanel
$tabsPanel.Orientation = 'Horizontal'
$tabsPanel.VerticalAlignment = 'Center'
# Centred, the 13px tabs would sit 2.5 above the 20px title's baseline.
$tabsPanel.Margin = New-Gap 0 5 0 0
[System.Windows.Controls.DockPanel]::SetDock($tabsPanel, 'Left')
$tabTexts = @{}
foreach ($name in $VIEW_NAMES) {
  $tab = New-Text $VIEW_LABELS[$name] $dim
  $tab.Tag = $name
  $tab.FontFamily = $monoFont
  $tab.FontSize = 13
  $tab.Padding = New-Gap 4 2 4 2
  $tab.Margin = New-Gap 0 0 8 0
  $tab.VerticalAlignment = 'Center'
  $tab.Cursor = [System.Windows.Input.Cursors]::Hand
  $tab.ToolTip = $VIEW_TIPS[$name]
  $tab.Add_MouseEnter({ param($sender, $e) if ([string]$sender.Tag -ne $script:view) { $sender.Foreground = $ink } })
  $tab.Add_MouseLeave({ param($sender, $e) if ([string]$sender.Tag -ne $script:view) { $sender.Foreground = $dim } })
  $tabTexts[$name] = $tab
  [void]$tabsPanel.Children.Add($tab)
}
# What a build is doing. It gets what the tabs leave, at most 40% of the header, and trims.
$buildChip = New-Text '' $dim
$buildChip.FontFamily = $monoFont
$buildChip.FontSize = 11.5
$buildChip.VerticalAlignment = 'Center'
$buildChip.HorizontalAlignment = 'Right'
$buildChip.TextTrimming = 'CharacterEllipsis'
$buildChip.Padding = New-Gap 4 2 4 2
$buildChip.Margin = New-Gap 12 5 0 0
$buildChip.Cursor = [System.Windows.Input.Cursors]::Hand
$buildChip.Visibility = 'Collapsed'
[System.Windows.Controls.DockPanel]::SetDock($buildChip, 'Right')
[void]$header.Children.Add($titleText)
[void]$header.Children.Add($closeMark)
[void]$header.Children.Add($gamesMark)
[void]$header.Children.Add($tabsPanel)
[void]$header.Children.Add($buildChip)
[void]$header.Children.Add((New-Object System.Windows.Controls.Border))
$header.Add_SizeChanged({ param($sender, $e) $buildChip.MaxWidth = [Math]::Max(80.0, [double]$sender.ActualWidth * 0.4) })

# Under the games mark: the games, a click away.
$switcher = New-UiSwitcherRow 'learn' $OwnerHwnd $SessionId
$switcher.HorizontalAlignment = 'Right'
$switcher.Margin = New-Gap 0 -2 0 10
$switcher.Visibility = 'Collapsed'
[System.Windows.Controls.DockPanel]::SetDock($switcher, 'Top')

# Footer: a line for short messages.
$footer = New-Object System.Windows.Controls.DockPanel
$footer.Margin = New-Gap 0 6 18 0
[System.Windows.Controls.DockPanel]::SetDock($footer, 'Bottom')
$toastText = New-Text '' $dim
$toastText.FontSize = 11.5
$toastText.TextTrimming = 'CharacterEllipsis'
[void]$footer.Children.Add($toastText)

# Before the messages: what Claude is on while you read, in every chat at work, from the
# panel's own state files. Hidden when no chat has anything on.
$phaseGlance = New-Object System.Windows.Controls.TextBlock
$phaseGlance.FontSize = 11.5
$phaseGlance.TextTrimming = 'CharacterEllipsis'
$phaseGlance.MaxWidth = 820
$phaseGlance.Margin = New-Gap 0 0 16 0
$phaseGlance.Visibility = 'Collapsed'
[System.Windows.Controls.DockPanel]::SetDock($phaseGlance, 'Left')
[void]$footer.Children.Insert(0, $phaseGlance)

$body = New-Object System.Windows.Controls.Grid

# Below 85% see-through the parts with text stand on a halo of the card's own colour (Chrome.ps1;
# Update-LearnHalo keeps it in step). Each part goes in where it would, in its halo frame, docked
# as the part is. The body's frame holds its views from outside their scroll areas, so the halo
# only ever covers what shows, and nothing in Learn animates.
function New-DockedHalo($Element) {
  $haloFrame = New-UiHaloFrame $Element
  [System.Windows.Controls.DockPanel]::SetDock($haloFrame, [System.Windows.Controls.DockPanel]::GetDock($Element))
  return $haloFrame
}
[void]$frame.Children.Add((New-DockedHalo $header))
[void]$frame.Children.Add((New-DockedHalo $switcher))
[void]$frame.Children.Add((New-DockedHalo $footer))
[void]$frame.Children.Add((New-DockedHalo $body))

# A full-width line shown when the helper can't run.
$banner = New-Object System.Windows.Controls.Border
$banner.Background = $redSoft
$banner.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
$banner.Padding = New-Gap 10 6 10 6
$banner.Margin = New-Gap 0 0 0 10
$banner.Visibility = 'Collapsed'
$bannerText = New-Text '' $ink
$bannerText.TextWrapping = 'Wrap'
$banner.Child = $bannerText
[System.Windows.Controls.DockPanel]::SetDock($banner, 'Top')
$frame.Children.Insert(2, (New-DockedHalo $banner))

$script:viewHosts = @{}
foreach ($name in $VIEW_NAMES) {
  $viewHost = New-Object System.Windows.Controls.Border
  $viewHost.Visibility = 'Collapsed'
  $script:viewHosts[$name] = $viewHost
  [void]$body.Children.Add($viewHost)
}

# Library, Learned, Ask and Settings start on the header's left edge, as the Course view does, and
# are no wider than $CONTENT_MAX: what a wide window has left over is the host's right padding.
# (A view stretched to a MaxWidth would be centred, and its left edge would move with the width.)
function Update-ViewColumns([double]$Width) {
  $spare = [Math]::Max(0.0, $Width - [double]$CONTENT_MAX)
  foreach ($name in @('library', 'learned', 'ask', 'settings')) {
    $viewHost = $script:viewHosts[$name]
    if ($viewHost.Padding.Right -ne $spare) { $viewHost.Padding = New-Gap 0 0 $spare 0 }
  }
}
# The card's border (1) and the frame's margin (16) on each side.
Update-ViewColumns ($script:width - 34)
$body.Add_SizeChanged({ param($sender, $e) try { Update-ViewColumns ([double]$sender.ActualWidth) } catch { Write-Failure $_ } })

# The resize grip, in the card's own bottom-right corner (not inside its padding).
$grip = New-UiGrip 'right'
$grip.FontSize = 11
$grip.Margin = New-Gap 0 0 5 3

$cardBody = New-Object System.Windows.Controls.Grid
[void]$cardBody.Children.Add($frame)
[void]$cardBody.Children.Add((New-UiHaloFrame $grip))
$card.Child = $cardBody

$win.Content = $card

function Show-Banner([string]$Text) {
  $bannerText.Text = $Text
  $banner.Visibility = if ($Text) { 'Visible' } else { 'Collapsed' }
}

$script:toastUntil = [DateTime]::MinValue
function Show-Toast([string]$Text, [string]$Kind = 'info') {
  $toastText.Text = $Text
  $toastText.Foreground = if ($Kind -eq 'error') { $red } else { $dim }
  $script:toastUntil = [DateTime]::UtcNow.AddMilliseconds($TOAST_MS)
}

# --- The helper: one wsl.exe process, requests out and answers in -------------------------------

$script:helper = $null
$script:helperReady = $false
$script:helperRestarts = 0
$script:nextId = 0
$script:pending = @{}
$script:status = $null

function Start-Helper {
  if (-not $DISTRO -or -not $HELPER_SCRIPT) {
    Show-Banner 'Learn runs from the mod folder inside WSL (\\wsl.localhost\...); this copy is somewhere else.'
    return
  }
  $envPart = ''
  if ($SnapshotLibrary) { $envPart = "env LEARN_LIBRARY=`"$SnapshotLibrary`" LEARN_CONFIG_DIR=`"$SnapshotConfig`" " }
  $arguments = "-d $DISTRO -e ${envPart}bash `"$HELPER_SCRIPT`" serve"
  $script:helper = [LearnCore.LineProcess]::Start('wsl.exe', $arguments)
  $script:helperReady = $false
  if ($script:helper.StartError) { Show-Banner "Can't start WSL for Learn: $($script:helper.StartError)" }
}

# Sends `cmd` with `$Fields`; `$Then` gets (result, context) back on the window's thread.
function Invoke-Helper([string]$Cmd, $Fields = $null, [scriptblock]$Then = $null, $Context = $null, [scriptblock]$Failed = $null) {
  if (-not $script:helper) { return }
  $script:nextId++
  # `rid`, not `id`: many commands carry an `id` of their own.
  $request = [ordered]@{ rid = $script:nextId; cmd = $Cmd }
  if ($Fields) { foreach ($key in @($Fields.Keys)) { $request[$key] = $Fields[$key] } }
  $script:pending[[string]$script:nextId] = @{ then = $Then; context = $Context; failed = $Failed }
  $json = ConvertTo-Json -InputObject $request -Compress -Depth 10
  if (-not $script:helper.Send($json)) {
    $script:pending.Remove([string]$script:nextId)
    Show-Toast 'Learn lost its helper; starting it again' 'error'
  }
}

function Receive-Line([string]$Text) {
  if (-not $Text.StartsWith('{')) { return }
  try { $message = ConvertFrom-Json -InputObject $Text } catch { return }
  if ($null -ne $message.rid) {
    $key = [string]$message.rid
    $entry = $script:pending[$key]
    if ($null -eq $entry) { return }
    $script:pending.Remove($key)
    try {
      if ($message.ok) {
        if ($entry.then) { & $entry.then $message.result $entry.context }
      } elseif ($entry.failed) {
        & $entry.failed ([string]$message.error) $entry.context
      } else {
        Show-Toast ([string]$message.error) 'error'
      }
    } catch { Write-Failure $_ }
    return
  }
  if ($message.event) {
    try { Receive-HelperEvent $message } catch { Write-Failure $_ }
  }
}

function Step-Helper {
  if (-not $script:helper) { return }
  foreach ($text in $script:helper.Drain()) { Receive-Line $text }
  if (-not $script:helper.IsAlive) {
    $why = $script:helper.Errors().Trim()
    if ($script:helperRestarts -lt 1) {
      $script:helperRestarts++
      $script:pending = @{}
      Start-Helper
      return
    }
    $script:helper = $null
    Show-Banner ("Learn's helper stopped." + $(if ($why) { " It said: $(Get-Short $why 400)" } else { '' }))
  }
}

function Receive-HelperEvent($Message) {
  switch ([string]$Message.event) {
    'ready' {
      $script:helperReady = $true
      Show-Banner ''
      Invoke-Helper 'hello' $null {
        param($Result, $Context)
        $script:settings = $Result.settings
        $script:status = $Result.status
        Update-BuildChip
        if (@($Result.resumed).Count -gt 0) { Show-Toast 'Carrying on with a build that was interrupted' }
        Start-FirstView
      }
    }
    'status' {
      $script:status = $Message.status
      Update-BuildChip
      Update-FromStatus
    }
    'chat.delta' { Add-ChatDelta ([string]$Message.key) ([string]$Message.text) }
    'chat.tool' { Add-ChatTool ([string]$Message.key) ([string]$Message.text) }
    'chat.done' { Complete-Chat ([string]$Message.key) $Message.message }
    'chat.error' { Stop-ChatWithError ([string]$Message.key) ([string]$Message.error) }
    'fatal' { Show-Banner ([string]$Message.error) }
  }
}

# The header's build line: what the newest build is doing, trimmed to fit, the whole of it in
# the tooltip. A click opens the Library, where the build is.
function Update-BuildChip {
  $build = if ($script:status) { $script:status.build } else { $null }
  $text = ''
  $tip = ''
  $topic = [string]$(if ($build) { $build.topic } else { '' })
  switch ([string]$(if ($build) { $build.state } else { '' })) {
    'running' {
      $count = if ([int]$build.total -gt 0) { " $([int]$build.done)/$([int]$build.total)" } else { '' }
      # The count first, so trimming a long topic never hides it.
      $text = if ($count) { "$GLYPH_HALF$count  $topic" } else { "$GLYPH_HALF $topic" }
      $tip = if ([int]$build.total -gt 0) { "Building '$topic': $([int]$build.done) of $([int]$build.total) pages written. It carries on if you close this window." } else { "Building '$topic': researching sources. It carries on if you close this window." }
      $buildChip.Foreground = $accent
    }
    'waiting-picks' {
      $text = "$GLYPH_EMPTY Pick sources: $topic"
      $tip = "'$topic' is waiting for you to pick its sources: click to open the Library."
      $buildChip.Foreground = $gold
    }
    'paused' {
      $text = "$GLYPH_EMPTY Paused: $topic"
      $tip = "'$topic' is paused: click to open the Library and carry on."
      $buildChip.Foreground = $dim
    }
    'failed' {
      $text = "$GLYPH_EMPTY Build stopped: $topic"
      $tip = "'$topic' stopped: click to open the Library to see why and carry on."
      $buildChip.Foreground = $red
    }
    'done' {
      $text = "$GLYPH_CHECK $([string]$build.message)"
      $tip = "$([string]$build.message) Click to open the Library."
      $buildChip.Foreground = $green
    }
  }
  $buildChip.Text = $text
  $buildChip.ToolTip = if ($tip) { $tip } else { $null }
  $buildChip.Visibility = if ($text) { 'Visible' } else { 'Collapsed' }
}

. (Join-Path $PSScriptRoot 'LearnViews.ps1')

# --- Switching views ---------------------------------------------------------------------------

# Shows one view and marks its tab; the one place that does (Open-Course uses it too).
function Set-ViewShown([string]$Name) {
  $script:view = $Name
  foreach ($key in $VIEW_NAMES) {
    $script:viewHosts[$key].Visibility = if ($key -eq $Name) { 'Visible' } else { 'Collapsed' }
    $tab = $tabTexts[$key]
    $tab.Foreground = if ($key -eq $Name) { $ink } else { $dim }
    $tab.FontWeight = if ($key -eq $Name) { 'Bold' } else { 'Normal' }
  }
  $tabTexts['course'].Visibility = if ($script:courseId) { 'Visible' } else { 'Collapsed' }
}

function Show-View([string]$Name) {
  if ($Name -eq 'course' -and -not $script:courseId) { $Name = 'library' }
  Set-ViewShown $Name
  switch ($Name) {
    'library' { Update-Library }
    'course' { Open-Course $script:courseId $null }
    'learned' { Update-Learned }
    'ask' { Open-Advisor }
    'settings' { Update-Settings }
  }
  Save-Prefs
}

$script:firstViewShown = $false
function Start-FirstView {
  $script:firstViewShown = $true
  if ($SnapshotPath) { Start-SnapshotView; return }
  Show-View $script:view
}

# Another window asked for a view or a course (Open-Sibling, /learn <view>): go there.
function Open-LearnRequest($Request) {
  $view = [string]$Request.view
  if ($Request.courseId -and (-not $view -or $view -eq 'course')) { Open-Course ([string]$Request.courseId) $null; return }
  if ($VIEW_NAMES -contains $view) { Show-View $view }
}

foreach ($name in $VIEW_NAMES) {
  $tabTexts[$name].Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
  $tabTexts[$name].Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { Show-View ([string]$sender.Tag) } catch { Write-Failure $_ } })
}
$closeMark.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $win.Close() })
# The games mark opens and closes the row of other windows; picking one closes it again.
function Set-SwitcherShown([bool]$Shown) {
  $switcher.Visibility = if ($Shown) { 'Visible' } else { 'Collapsed' }
  Set-UiMarkOn $gamesMark $Shown
}
$gamesMark.Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  Set-SwitcherShown ($switcher.Visibility -ne 'Visible')
})
# A pick closes the row and switches the mark off (New-UiSwitcherRow does both, through its Tag).
$switcher.Tag = @{ mark = $gamesMark }
$buildChip.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
$buildChip.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { Show-View 'library' } catch { Write-Failure $_ } })

# Left and Right page the course unless a box you type in has them. Your own chat message is a
# read-only text box (so it can be selected and copied): clicking it leaves the arrows to paging.
function Test-TypingFocus($Element) {
  return ($Element -is [System.Windows.Controls.TextBox]) -and -not $Element.IsReadOnly
}

$win.Add_PreviewKeyDown({
  param($sender, $e)
  try {
    $ctrl = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Control) -ne 0
    if ($ctrl -and ($e.Key -eq 'OemPlus' -or $e.Key -eq 'Add')) { Set-TextScale ($script:textScale + 0.1); $e.Handled = $true; return }
    if ($ctrl -and ($e.Key -eq 'OemMinus' -or $e.Key -eq 'Subtract')) { Set-TextScale ($script:textScale - 0.1); $e.Handled = $true; return }
    if ($ctrl -and $e.Key -ge 'D1' -and $e.Key -le 'D5') {
      $index = [int]$e.Key - [int][System.Windows.Input.Key]::D1
      Show-View $VIEW_NAMES[$index]
      $e.Handled = $true
      return
    }
    $inText = Test-TypingFocus ([System.Windows.Input.Keyboard]::FocusedElement)
    if ($script:view -eq 'course' -and -not $inText) {
      if ($e.Key -eq 'Right') { Step-Page 1; $e.Handled = $true }
      elseif ($e.Key -eq 'Left') { Step-Page -1; $e.Handled = $true }
    }
    if ($e.Key -eq 'Escape') { Close-Overlays }
  } catch { Write-Failure $_ }
})

function Set-TextScale([double]$Scale) {
  $script:textScale = [Math]::Max([double]$MIN_TEXT, [Math]::Min([double]$MAX_TEXT, [Math]::Round($Scale, 2)))
  Show-Toast ("Text size {0}%" -f [int]($script:textScale * 100))
  if ($script:ui.textSizeValue) { $script:ui.textSizeValue.Text = ("{0}%" -f [int]($script:textScale * 100)) }
  Update-TextSize
  Save-Prefs
}

# --- Placement: over the WezTerm window, where the person last dragged it -----------------------

$script:me = [IntPtr]::Zero
$script:lastOwner = $null
$script:moving = $false
$script:resizing = $false
$script:resizeStart = $null

function Get-Rect([IntPtr]$Hwnd) {
  $r = New-Object LearnCore.LearnWin32+RECT
  [void][LearnCore.LearnWin32]::GetWindowRect($Hwnd, [ref]$r)
  return $r
}

function Get-Cursor {
  $cursor = New-Object LearnCore.LearnWin32+POINT
  [void][LearnCore.LearnWin32]::GetCursorPos([ref]$cursor)
  return $cursor
}

function Get-Dpi {
  if ($script:me -eq [IntPtr]::Zero) { return 96.0 }
  return [double][LearnCore.LearnWin32]::GetDpiForWindow($script:me)
}

function Set-Place {
  if (-not $hasOwner -or $script:me -eq [IntPtr]::Zero) { return }
  $own = Get-Rect $owner
  $work = [LearnCore.LearnWin32]::WorkArea($owner)
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
  # Kept on the screen the chat is on, even when it is bigger than the chat's window.
  $x = [Math]::Max($work.Left, [Math]::Min($x, $work.Right - $w))
  $y = [Math]::Max($work.Top, [Math]::Min($y, $work.Bottom - $h))
  # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
  [void][LearnCore.LearnWin32]::SetWindowPos($script:me, [IntPtr]::Zero, $x, $y, 0, 0, 0x15)
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
  $script:resizeStart = @{ cx = $cursor.X; cy = $cursor.Y; width = $win.Width; height = $win.Height; dpi = (Get-Dpi) }
  $script:resizing = $true
  [void]$grip.CaptureMouse()
})

$grip.Add_MouseMove({
  if (-not $script:resizing) { return }
  $cursor = Get-Cursor
  $start = $script:resizeStart
  $per = 96.0 / $start.dpi
  $win.Width = [Math]::Max([double]$MIN_WIDTH, [double]($start.width + ($cursor.X - $start.cx) * $per))
  $win.Height = [Math]::Max([double]$MIN_HEIGHT, [double]($start.height + ($cursor.Y - $start.cy) * $per))
})

$grip.Add_MouseLeftButtonUp({
  param($sender, $e)
  if (-not $script:resizing) { return }
  $e.Handled = $true
  $script:resizing = $false
  $grip.ReleaseMouseCapture()
  $script:width = $win.Width
  $script:height = $win.Height
  Save-Prefs
})

$win.Add_SourceInitialized({
  $script:me = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
  if ($hasOwner) {
    # WS_EX_TOOLWINDOW: no Alt-Tab entry; the owner stands for it.
    $style = [LearnCore.LearnWin32]::GetWindowLong($script:me, -20)
    [void][LearnCore.LearnWin32]::SetWindowLong($script:me, -20, ($style -bor 0x80))
  }
})

$win.Add_Closing({
  try {
    Save-Progress
    Save-Prefs
  } catch { Write-Failure $_ }
  try { if ($script:helper) { $script:helper.Stop() } } catch {}
})

# --- Self-test: drawing and dispatch, without a window shown (written; run by hand) ----------------

if ($SelfTest) {
  $checks = [ordered]@{}
  $sample = '[{"t":"h","level":2,"inlines":[{"s":"Why"}]},{"t":"p","inlines":[{"s":"Data "},{"s":"lost","b":1},{"s":"0:37","time":1,"link":"https://www.youtube.com/watch?v=x&t=37s"},{"s":"(added)","added":1}]},{"t":"code","lang":"bash","text":"a\nb"},{"t":"ul","items":[{"depth":0,"inlines":[{"s":"one"}]},{"depth":1,"inlines":[{"s":"two"}]}]},{"t":"table","rows":[[[{"s":"a"}],[{"s":"b"}]],[[{"s":"1"}],[{"s":"2"}]]]},{"t":"hr"},{"t":"quote","inlines":[{"s":"q"}]}]' | ConvertFrom-Json
  $doc = New-Document 14
  Add-Blocks $doc.Blocks $sample 14
  $checks.blockCount = $doc.Blocks.Count -eq 7
  $links = 0
  foreach ($block in $doc.Blocks) { if ($block -is [System.Windows.Documents.Paragraph]) { foreach ($inline in $block.Inlines) { if ($inline -is [System.Windows.Documents.Hyperlink]) { $links++ } } } }
  $checks.timestampIsLink = $links -eq 1
  $checks.codeHasTwoLines = @($doc.Blocks)[2].Blocks.Count -eq 2
  $script:calls = New-Object System.Collections.Generic.List[string]
  $script:pending['7'] = @{ then = { param($Result, $Context) $script:calls.Add("then:$($Result.x):$Context") }; context = 'ctx'; failed = $null }
  $script:pending['8'] = @{ then = $null; context = $null; failed = { param($Message, $Context) $script:calls.Add("failed:$Message") } }
  Receive-Line '{"rid":7,"ok":true,"result":{"x":5}}'
  Receive-Line '{"rid":8,"ok":false,"error":"nope"}'
  Receive-Line 'not json'
  $checks.dispatchThen = $script:calls.Contains('then:5:ctx')
  $checks.dispatchFailed = $script:calls.Contains('failed:nope')
  $checks.pendingCleared = $script:pending.Count -eq 0
  $checks.helperPath = (-not $wslMatch.Success) -or $HELPER_SCRIPT.EndsWith('/learn/learn.sh')
  # A button inside a chat is a real Button, so its click arrives even inside a document.
  $script:docClicked = $null
  $docButton = New-DocButton 'Build this: X' $accentSoft $ink { param($Data, $Sender) $script:docClicked = $Data } 'topic'
  [void](New-Object System.Windows.Documents.BlockUIContainer($docButton))
  $docButton.RaiseEvent((New-Object System.Windows.RoutedEventArgs([System.Windows.Controls.Button]::ClickEvent)))
  $checks.docButtonClicks = $script:docClicked -eq 'topic' -and $docButton -is [System.Windows.Controls.Button]
  # Custom colours: # optional, six hex digits, upper-cased; anything else is not a colour.
  $checks.colorTextBare = (Get-ColorText '1c1d20') -eq '#1C1D20'
  $checks.colorTextHash = (Get-ColorText ' #e08a5f ') -eq '#E08A5F'
  $checks.colorTextBad = ($null -eq (Get-ColorText '#12345')) -and ($null -eq (Get-ColorText '#GGGGGG'))
  # Deep links: a fresh request is read once and deleted; one older than 15 s is ignored.
  $requestPath = Join-Path $env:TEMP "learn-open-selftest-$PID.json"
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [System.IO.File]::WriteAllText($requestPath, ('{{"view":"settings","courseId":"c1","at":{0}}}' -f $now))
  $fresh = Read-LearnRequest $requestPath
  $checks.requestFresh = $fresh -and $fresh.view -eq 'settings' -and $fresh.courseId -eq 'c1' -and -not [System.IO.File]::Exists($requestPath)
  [System.IO.File]::WriteAllText($requestPath, ('{{"view":"ask","at":{0}}}' -f ($now - 60000)))
  $checks.requestStale = ($null -eq (Read-LearnRequest $requestPath)) -and -not [System.IO.File]::Exists($requestPath)
  $checks.requestMissing = $null -eq (Read-LearnRequest $requestPath)
  # Buttons: text on the accent is the scheme's onAccent; a secondary one is the text colour.
  $checks.primaryOnAccent = (New-Button 'Go' 'primary').Child.Foreground -eq $onAccent
  $checks.secondaryInk = (New-Button 'Go' 'secondary').Child.Foreground -eq $ink
  # Mark learned stays short: the names go in the tooltip.
  $offer = New-OfferButton @('a', 'b')
  $offerButton = $offer.Child.Children[0]
  $checks.offerLabel = $offerButton.Content.Text -eq 'Mark 2 learned' -and ([string]$offerButton.ToolTip).Contains('a, b')
  # An armed remove says "remove?" in red, then goes back to its own words.
  $armedLink = New-Pressable 'remove' $null $faint
  [void](Test-Armed 'selftest' $armedLink)
  $wasArmed = $armedLink.Text -eq 'remove?' -and $armedLink.Foreground -eq $red
  Reset-Armed
  $checks.armedReverts = $wasArmed -and $armedLink.Text -eq 'remove' -and $armedLink.Foreground -eq $faint
  # Course columns: their own widths on a wide window; on a narrow one the chat gives up to 60,
  # then the contents up to 50, so the page keeps 420 where it can.
  $wide = Get-CourseColumns 1146 $true
  $narrow = Get-CourseColumns 866 $true
  $bare = Get-CourseColumns 866 $false
  $checks.columnsWide = $wide.contents -eq 250 -and $wide.chat -eq 360
  $checks.columnsNarrow = $narrow.chat -eq 300 -and $narrow.contents -eq 200
  $checks.columnsNoContents = $bare.contents -eq 0 -and $bare.chat -eq 360
  # At the minimum window the page keeps its 420 with both side columns at their narrowest.
  $minimum = Get-CourseColumns ([double]$MIN_WIDTH - 34) $true
  $checks.columnsMinimumPage = ([double]$MIN_WIDTH - 34 - $minimum.contents - $minimum.chat) -ge $PAGE_MIN_WIDTH
  # A chip is a 22-high pill whose label is centred.
  $chip = New-Chip 'x' $null $false
  $checks.chipHeight = $chip.Height -eq 22 -and $chip.Child.VerticalAlignment -eq 'Center'
  # A hovered secondary button steps up from its resting fill (they were the same brush once).
  $quiet = New-Button 'Go' 'secondary'
  Set-ButtonLook $quiet 'hot'
  $hotFill = $quiet.Background
  Set-ButtonLook $quiet 'rest'
  $checks.secondaryHover = $hotFill -eq $UI_BUTTON_HOT -and $quiet.Background -eq $buttonFill
  # Tick boxes are one size ticked or not, so the titles after them start at one x.
  $tickOn = New-Tick $true
  $tickOff = New-Tick $false
  $checks.tickSameSize = $tickOn.Width -eq 16 -and $tickOff.Width -eq 16 -and $tickOn.Height -eq $tickOff.Height -and $tickOn.Background -eq $accent
  # A timestamp's play mark is joined to its time by a no-break space.
  $playRuns = 0
  foreach ($block in $doc.Blocks) { if ($block -is [System.Windows.Documents.Paragraph]) { foreach ($inline in $block.Inlines) { if ($inline -is [System.Windows.Documents.Hyperlink]) { foreach ($run in $inline.Inlines) { if ($run.Text -eq ($GLYPH_PLAY + $GLYPH_NBSP + '0:37')) { $playRuns++ } } } } } }
  $checks.timestampNoBreak = $playRuns -eq 1
  # Dates: the year only when it is not this one.
  $checks.shortDateThisYear = (Format-ShortDate '2026-10-27T10:00:00Z' ([DateTime]'2026-11-01')) -eq ([DateTime]'2026-10-27T10:00:00Z').ToLocalTime().ToString('d MMM')
  $checks.shortDateOtherYear = (Format-ShortDate '2025-03-02T10:00:00Z' ([DateTime]'2026-11-01')).EndsWith('2025')
  # Overlap lines: the page first, glued to what follows, so no line ends on the dot.
  $checks.overlapPages = (Get-OverlapPages @(4)) -eq ('page' + $GLYPH_NBSP + '4') -and (Get-OverlapPages @(2, 14)) -eq ('pages' + $GLYPH_NBSP + '2, 14') -and (Get-OverlapPages @()) -eq ''
  $checks.overlapJoin = (Join-OverlapDetail 'page 1' 'learned here') -eq ('page 1' + $GLYPH_NBSP + $GLYPH_DOT + $GLYPH_NBSP + 'learned here') -and (Join-OverlapDetail '' 'x') -eq 'x'
  # A learned concept's line is its date; the course is only in the tooltip.
  $script:concepts = [pscustomobject]@{ courseTitles = [pscustomobject]@{ c1 = 'A long course title' } }
  $whereLearned = Get-ConceptWhere ([pscustomobject]@{ learned = [pscustomobject]@{ at = '2026-10-27T10:00:00Z'; course = 'c1' } }) ([DateTime]'2026-11-01')
  $checks.conceptWhereDate = $whereLearned.text.StartsWith('learned ') -and -not $whereLearned.text.Contains('course') -and $whereLearned.tip.Contains('A long course title')
  $whereRead = Get-ConceptWhere ([pscustomobject]@{ learned = $null; seen = @([pscustomobject]@{ course = 'c1' }, [pscustomobject]@{ course = 'c1' }) })
  $checks.conceptWhereRead = $whereRead.text -eq 'read in 1 course' -and $whereRead.tip -eq 'Read in A long course title'
  $script:concepts = $null
  # Your own chat message can be selected and copied.
  $selectable = New-SelectableText 'hello' $ink 13
  $checks.messageSelectable = $selectable -is [System.Windows.Controls.TextBox] -and $selectable.IsReadOnly
  # A list keeps its scrollbar's lane past its rows' fill, scrolling or not.
  $listScroll = New-RowScroll (New-Object System.Windows.Controls.StackPanel) 10
  $checks.rowScrollLane = $listScroll.VerticalScrollBarVisibility -eq 'Visible' -and $listScroll.Margin.Right -eq (-10 - $SCROLL_LANE) -and $listScroll.Content.Margin.Right -eq 10
  # The arrows page the course from anywhere but a box you type in: your own message doesn't keep them.
  $checks.arrowsPastMessage = (Test-TypingFocus (New-InputBox 'x').box) -and -not (Test-TypingFocus $selectable) -and -not (Test-TypingFocus $null)
  # A chat box's hint wraps rather than being cut off; a one-line box's still trims.
  $checks.hintWrapsMultiline = (New-InputBox 'x' $true).box.Tag.TextWrapping -eq 'Wrap' -and (New-InputBox 'x').box.Tag.TextTrimming -eq 'CharacterEllipsis'
  # Below 85% see-through every part of the window stands on the halo, and above it none does. A
  # bar dragged here only previews (it never reaches Update-Theme), and the halo still follows it.
  $haloParts = @($header, $switcher, $banner, $footer, $body, $grip)
  $appearanceBefore = $script:THEME.appearance
  $preview = Copy-Appearance
  $preview.opacity.learn = 0.4
  Set-ThemeAppearance $preview
  Sync-AppearanceSection
  $haloOn = $true
  foreach ($part in $haloParts) { if ($null -eq $part.Effect -or $null -eq $part.Parent.Effect) { $haloOn = $false } }
  $preview = Copy-Appearance
  $preview.opacity.learn = 0.96
  Set-ThemeAppearance $preview
  Sync-AppearanceSection
  $haloOff = $true
  foreach ($part in $haloParts) { if ($null -ne $part.Effect -or $null -ne $part.Parent.Effect) { $haloOff = $false } }
  Set-ThemeAppearance $appearanceBefore
  Sync-AppearanceSection
  $checks.haloFollowsPreview = $haloOn -and $haloOff
  $failed = @($checks.Keys | Where-Object { -not $checks[$_] })
  $checks.ok = $failed.Count -eq 0
  $checks.failed = $failed
  Send-Event $checks
  try { $mutex.ReleaseMutex() } catch {}
  if ($checks.ok) { exit 0 } else { exit 1 }
}

# --- Snapshots: a view drawn to a PNG once its data has arrived ------------------------------------

$script:snapshotAt = $null
function Start-SnapshotView {
  if ($SnapshotGames) { Set-SwitcherShown $true }
  switch ($SnapshotView) {
    'library' {
      Show-View 'library'
      if ($SnapshotSource) { Set-NewSource $SnapshotSource }
    }
    'learned' { Show-View 'learned' }
    'ask' { Show-View 'ask' }
    'settings' { Show-View 'settings' }
    default {
      $script:courseId = $SnapshotCourse
      Set-ViewShown 'course'
      Open-Course $SnapshotCourse $SnapshotPage
    }
  }
  $script:snapshotAt = [DateTime]::UtcNow
}

function Save-Snapshot {
  $win.UpdateLayout()
  $dpi = Get-Dpi
  $pixelsWide = [int][Math]::Ceiling($card.ActualWidth * $dpi / 96.0)
  $pixelsHigh = [int][Math]::Ceiling($card.ActualHeight * $dpi / 96.0)
  $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($pixelsWide, $pixelsHigh, $dpi, $dpi, [System.Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($card)
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $file = [System.IO.File]::Create($SnapshotPath)
  try { $encoder.Save($file) } finally { $file.Dispose() }
}

# --- Life ------------------------------------------------------------------------------------------

$win.Add_ContentRendered({
  $script:lastOwner = if ($hasOwner) { Get-Rect $owner } else { $null }
  Set-Place
  if (-not $SnapshotPath) {
    [void]$win.Activate()
    [void]$win.Focus()
  }
  Start-Helper
  Send-Event @{ event = 'ready' }
})

# --- What Claude is on: the panel's state files (contract 1), read every two seconds ------------

$STATE_ROOT = if ($DISTRO) { "\\wsl.localhost\$DISTRO\tmp\claude-progress" } else { '' }
# A snapshot draws the line only from a folder it is given (CLAUDE_PANEL_GLANCE_ROOT, holding
# <any>\phases.json), so it never shows the person's own chats.
if ($SnapshotPath) { $STATE_ROOT = [string]$env:CLAUDE_PANEL_GLANCE_ROOT }
$script:glanceAt = 0
$script:glanceStamp = ''

function Add-GlanceRun([string]$Text, $Foreground) {
  $run = New-Object System.Windows.Documents.Run($Text)
  $run.Foreground = $Foreground
  [void]$phaseGlance.Inlines.Add($run)
}

# One short text, cut with an ellipsis: each chat's part of the line keeps its own room.
function Get-GlanceShort([string]$Text, [int]$Max) {
  if ($Text.Length -le $Max) { return $Text }
  return $Text.Substring(0, [Math]::Max(1, $Max - 1)).TrimEnd() + [string][char]0x2026
}

# Every chat at work, newest first: its title, then the phase it's on and its count (or its live
# test run when it has no plan). A chat shows while its plan has phases left, a test runs, or it
# changed in the last 15 minutes. The tooltip holds each chat's whole plan.
function Update-PhaseGlance {
  if (-not $STATE_ROOT -or $SelfTest) { return }
  $now = [Environment]::TickCount
  if ($script:glanceAt -and [Math]::Abs($now - $script:glanceAt) -lt 2000) { return }
  $script:glanceAt = $now
  $files = New-Object System.Collections.Generic.List[object]
  try {
    foreach ($dir in [System.IO.Directory]::GetDirectories($STATE_ROOT)) {
      $file = New-Object System.IO.FileInfo((Join-Path $dir 'phases.json'))
      if ($file.Exists) { $files.Add($file) }
    }
  } catch {}
  $ordered = @($files | Sort-Object LastWriteTimeUtc -Descending)
  $stamp = ($ordered | ForEach-Object { '{0}|{1}|{2}' -f $_.FullName, $_.LastWriteTimeUtc.Ticks, $_.Length }) -join ';'
  if ($stamp -eq $script:glanceStamp) { return }
  $script:glanceStamp = $stamp
  $phaseGlance.Inlines.Clear()
  $tip = New-Object System.Collections.Generic.List[string]
  $shown = 0
  foreach ($file in $ordered) {
    try { $state = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { continue }
    $items = @()
    if ($state.plan) { $items = @($state.plan.items) }
    $live = @($state.runs) | Where-Object { $_ -and [string]$_.status -eq 'running' } | Select-Object -Last 1
    $left = @($items | Where-Object { [string]$_.status -ne 'done' }).Count
    $isRecent = ([DateTime]::UtcNow - $file.LastWriteTimeUtc).TotalMinutes -lt 15
    if ($left -eq 0 -and -not $live -and -not $isRecent) { continue }
    if ($items.Count -eq 0 -and -not $live) { continue }
    $label = [string]$state.title
    if (-not $label -and $state.plan) { $label = [string]$state.plan.title }
    if (-not $label) { $label = 'chat ' + ([string]$state.sessionId).Substring(0, [Math]::Min(4, ([string]$state.sessionId).Length)) }
    if ($shown -gt 0) { Add-GlanceRun '   |   ' $faint }
    Add-GlanceRun ((Get-GlanceShort $label 24) + '  ') $dim
    if ($items.Count -gt 0) {
      $nowItem = $items | Where-Object { [string]$_.status -eq 'in_progress' } | Select-Object -First 1
      $done = [int]$state.plan.done
      $total = [int]$state.plan.total
      if ($nowItem) { Add-GlanceRun "$GLYPH_FULL " $accent; Add-GlanceRun (Get-GlanceShort ([string]$nowItem.name) 34) $ink }
      elseif ($left -eq 0) { Add-GlanceRun "$GLYPH_CHECK " $green; Add-GlanceRun 'All done' $ink }
      else { Add-GlanceRun "$GLYPH_EMPTY " $dim; Add-GlanceRun (Get-GlanceShort ([string]$state.plan.title) 34) $ink }
      Add-GlanceRun " $done/$total" $dim
    } else {
      Add-GlanceRun 'Tests ' $dim
      Add-GlanceRun "$GLYPH_FULL " $accent
      Add-GlanceRun ([string]$live.count) $ink
    }
    if ($tip.Count -gt 0) { $tip.Add('') }
    $tip.Add($label)
    if ($items.Count -gt 0) {
      $tip.Add('  ' + [string]$state.plan.title)
      foreach ($item in $items) {
        $mark = switch ([string]$item.status) { 'done' { $GLYPH_CHECK } 'in_progress' { $GLYPH_FULL } default { $GLYPH_EMPTY } }
        $tip.Add("    $mark  $([string]$item.name)")
      }
    }
    if ($live) { $tip.Add("  Tests: $([string]$live.label) $([string]$live.count)") }
    $shown++
  }
  if ($shown -eq 0) { $phaseGlance.Visibility = 'Collapsed'; return }
  $phaseGlance.ToolTip = ($tip -join [Environment]::NewLine)
  $phaseGlance.Visibility = 'Visible'
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$script:ownerTick = 0
$timer.Add_Tick({
  # A colour scheme or see-through change made in another window: the brushes repaint themselves,
  # the halo follows, and the Appearance settings move their swatch ring, bars and colour boxes.
  try { if (Update-Theme) { Update-LearnHalo; Update-AppearanceSection } } catch { Write-Failure $_ }
  try { Step-Helper } catch { Write-Failure $_ }
  try { Step-Views } catch { Write-Failure $_ }
  if ($toastText.Text -and [DateTime]::UtcNow -gt $script:toastUntil) { $toastText.Text = '' }
  try { Update-PhaseGlance } catch { Write-Failure $_ }
  if ($SnapshotPath -and $script:snapshotAt) {
    $settled = $script:pending.Count -eq 0 -and ([DateTime]::UtcNow - $script:snapshotAt).TotalMilliseconds -gt 1500
    $tooLong = ([DateTime]::UtcNow - $script:snapshotAt).TotalSeconds -gt 40
    if ($settled -or $tooLong) {
      $script:snapshotAt = $null
      try { Save-Snapshot } catch { [Console]::Error.WriteLine("snapshot failed: $($_.Exception.Message)") }
      $win.Close()
    }
    return
  }
  if ($SnapshotPath) { return }
  $script:ownerTick++
  # Every half second: has another window asked for a view or a course?
  if ($script:firstViewShown -and $script:ownerTick % 5 -eq 0) {
    try {
      $request = Read-LearnRequest
      if ($request) { Open-LearnRequest $request }
    } catch { Write-Failure $_ }
  }
  if (-not $hasOwner -or $script:ownerTick % 2 -ne 0) { return }
  if (-not [LearnCore.LearnWin32]::IsWindow($owner)) { $win.Close(); return }
  if ($script:moving -or $script:resizing -or [LearnCore.LearnWin32]::IsIconic($owner)) { return }
  $now = Get-Rect $owner
  $was = $script:lastOwner
  if ($null -eq $was -or $now.Left -ne $was.Left -or $now.Top -ne $was.Top -or $now.Right -ne $was.Right -or $now.Bottom -ne $was.Bottom) {
    $script:lastOwner = $now
    Set-Place
  }
})

Build-Views
Update-LearnHalo
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
# Something that throws while drawing (not in a handler of ours) is logged with its .NET stack
# before the window goes, so it can be found.
$app.Add_DispatcherUnhandledException({
  param($sender, $e)
  $text = "$([DateTime]::Now.ToString('s')) unhandled: $($e.Exception.ToString())`n"
  try { Add-Content -Path (Join-Path $env:TEMP 'learn-error.log') -Value $text -Encoding ASCII } catch {}
  [Console]::Error.WriteLine($text)
})
[void]$app.Run($win)
$timer.Stop()
try { $mutex.ReleaseMutex() } catch {}
