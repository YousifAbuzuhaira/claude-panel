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
  # Testing aids: check the drawing and the dispatch and exit; or draw a view to a PNG
  # and exit, from a library and config of the snapshot's own (WSL paths).
  [switch]$SelfTest,
  [string]$SnapshotPath = '',
  [ValidateSet('library', 'course', 'overlap', 'learned', 'ask', 'settings')][string]$SnapshotView = 'library',
  [string]$SnapshotLibrary = '',
  [string]$SnapshotConfig = '',
  [string]$SnapshotCourse = '',
  [int]$SnapshotPage = 1
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
$GLYPH_BOX = [string][char]0x2610
$GLYPH_TICKED = [string][char]0x2611
$GLYPH_SKIP = [string][char]0x2298
$GLYPH_DASH = [string][char]0x2014
$GLYPH_ELLIPSIS = [string][char]0x2026
$GLYPH_PENDING = [string][char]0x25CC
$GLYPH_UP = [string][char]0x2191
$GLYPH_DOWN = [string][char]0x2193
$MIN_WIDTH = 760
$MIN_HEIGHT = 480
$DEFAULT_WIDTH = 1180
$DEFAULT_HEIGHT = 780
$MIN_TEXT = 0.8
$MAX_TEXT = 1.5
$BASE_TEXT = 14.5
$TOAST_MS = 5000
$VIEW_NAMES = @('library', 'course', 'learned', 'ask', 'settings')
$VIEW_LABELS = @{ library = 'Library'; course = 'Course'; learned = 'Learned'; ask = 'Ask'; settings = 'Settings' }
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
      $script:width = Get-Clamped ([double]$saved.width) $MIN_WIDTH 4000 $DEFAULT_WIDTH
      $script:height = Get-Clamped ([double]$saved.height) $MIN_HEIGHT 3000 $DEFAULT_HEIGHT
      $script:textScale = Get-Clamped ([double]$saved.textScale) $MIN_TEXT $MAX_TEXT 1.0
      if ($VIEW_NAMES -contains [string]$saved.view) { $script:view = [string]$saved.view }
      if ($saved.courseId) { $script:courseId = [string]$saved.courseId }
      if ($null -ne $saved.showContents) { $script:showContents = [bool]$saved.showContents }
      break
    } catch {}
  }
}

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

function Brush([string]$Hex) { return [System.Windows.Media.BrushConverter]::new().ConvertFromString($Hex) }
$ink = Brush '#E8E6E3'
$dim = Brush '#9A9894'
$faint = Brush '#66645F'
$accent = Brush '#E08A5F'
$accentSoft = Brush '#55E08A5F'
$green = Brush '#5FB98A'
$greenSoft = Brush '#445FB98A'
$red = Brush '#E0696B'
$gold = Brush '#E6BE47'
$blue = Brush '#7FB2E5'
$blueSoft = Brush '#337FB2E5'
$surface = Brush '#2B2C31'
$surface2 = Brush '#232428'
$hover = Brush '#18FFFFFF'
$selected = Brush '#26E08A5F'
$line = Brush '#30FFFFFF'
$codeBg = Brush '#141518'
$codeInline = Brush '#22FFFFFF'
$codeInk = Brush '#E3D9C6'
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

# Thin dark scrollbars everywhere in the window (the default ones are light grey blocks).
$SCROLLBAR_XAML = @'
<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Style x:Key="LearnThumb" TargetType="Thumb">
    <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Thumb"><Border CornerRadius="3" Background="#38FFFFFF"/></ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType="ScrollBar">
    <Setter Property="Width" Value="9"/>
    <Setter Property="MinWidth" Value="9"/>
    <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ScrollBar">
      <Track x:Name="PART_Track" Orientation="Vertical" IsDirectionReversed="True"><Track.Thumb><Thumb Style="{StaticResource LearnThumb}" Margin="2,2,1,2"/></Track.Thumb></Track>
    </ControlTemplate></Setter.Value></Setter>
    <Style.Triggers>
      <Trigger Property="Orientation" Value="Horizontal">
        <Setter Property="Width" Value="Auto"/>
        <Setter Property="MinWidth" Value="0"/>
        <Setter Property="Height" Value="9"/>
        <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ScrollBar">
          <Track x:Name="PART_Track" Orientation="Horizontal"><Track.Thumb><Thumb Style="{StaticResource LearnThumb}" Margin="2,2,2,1"/></Track.Thumb></Track>
        </ControlTemplate></Setter.Value></Setter>
      </Trigger>
    </Style.Triggers>
  </Style>
</ResourceDictionary>
'@
try { $win.Resources.MergedDictionaries.Add([System.Windows.Markup.XamlReader]::Parse($SCROLLBAR_XAML)) } catch { Write-Failure $_ }

$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius(10)
$card.Background = Brush '#F51C1D20'
$card.BorderBrush = Brush '#33FFFFFF'
$card.BorderThickness = New-Object System.Windows.Thickness(1)
$card.Padding = New-Gap 16 10 16 6

$frame = New-Object System.Windows.Controls.DockPanel
$frame.LastChildFill = $true
$card.Child = $frame

# Header: the name, the views, a build line, the close mark. Dragging it moves the window.
$header = New-Object System.Windows.Controls.DockPanel
$header.Background = $noFill
$header.Cursor = [System.Windows.Input.Cursors]::SizeAll
$header.Margin = New-Gap 0 0 0 8
[System.Windows.Controls.DockPanel]::SetDock($header, 'Top')
$titleText = New-Text 'Learn' $accent
$titleText.FontFamily = $monoFont
$titleText.FontSize = 20
$titleText.FontWeight = 'Bold'
$titleText.VerticalAlignment = 'Center'
$titleText.Margin = New-Gap 0 0 18 0
[System.Windows.Controls.DockPanel]::SetDock($titleText, 'Left')
$closeText = New-Pressable $GLYPH_CLOSE 'close'
$closeText.FontSize = 14
$closeText.VerticalAlignment = 'Center'
$closeText.Margin = New-Gap 12 0 0 0
[System.Windows.Controls.DockPanel]::SetDock($closeText, 'Right')
$buildChip = New-Text '' $dim
$buildChip.FontFamily = $monoFont
$buildChip.FontSize = 11.5
$buildChip.VerticalAlignment = 'Center'
$buildChip.Cursor = [System.Windows.Input.Cursors]::Hand
$buildChip.ToolTip = 'A course being built: open the Library to see it'
[System.Windows.Controls.DockPanel]::SetDock($buildChip, 'Right')
$tabsPanel = New-Object System.Windows.Controls.StackPanel
$tabsPanel.Orientation = 'Horizontal'
$tabsPanel.VerticalAlignment = 'Center'
[System.Windows.Controls.DockPanel]::SetDock($tabsPanel, 'Left')
$tabTexts = @{}
foreach ($name in $VIEW_NAMES) {
  $tab = New-Pressable $VIEW_LABELS[$name] $name
  $tab.FontFamily = $monoFont
  $tab.FontSize = 13
  $tab.Margin = New-Gap 0 0 10 0
  $tabTexts[$name] = $tab
  [void]$tabsPanel.Children.Add($tab)
}
[void]$header.Children.Add($titleText)
[void]$header.Children.Add($closeText)
[void]$header.Children.Add($buildChip)
[void]$header.Children.Add($tabsPanel)
[void]$header.Children.Add((New-Object System.Windows.Controls.Border))

# Footer: a line for short messages, and the resize grip.
$footer = New-Object System.Windows.Controls.DockPanel
$footer.Margin = New-Gap 0 4 0 0
[System.Windows.Controls.DockPanel]::SetDock($footer, 'Bottom')
$grip = New-Text $GLYPH_GRIP $faint
$grip.FontSize = 12
$grip.Cursor = [System.Windows.Input.Cursors]::SizeNWSE
$grip.ToolTip = 'Drag to resize'
[System.Windows.Controls.DockPanel]::SetDock($grip, 'Right')
$toastText = New-Text '' $dim
$toastText.FontSize = 11.5
$toastText.TextTrimming = 'CharacterEllipsis'
[void]$footer.Children.Add($grip)
[void]$footer.Children.Add($toastText)

$body = New-Object System.Windows.Controls.Grid
[void]$frame.Children.Add($header)
[void]$frame.Children.Add($footer)
[void]$frame.Children.Add($body)

# A full-width line shown when the helper can't run.
$banner = New-Object System.Windows.Controls.Border
$banner.Background = Brush '#33E0696B'
$banner.CornerRadius = New-Object System.Windows.CornerRadius(5)
$banner.Padding = New-Gap 10 6 10 6
$banner.Margin = New-Gap 0 0 0 8
$banner.Visibility = 'Collapsed'
$bannerText = New-Text '' $ink
$bannerText.TextWrapping = 'Wrap'
$banner.Child = $bannerText
[System.Windows.Controls.DockPanel]::SetDock($banner, 'Top')
$frame.Children.Insert(1, $banner)

$script:viewHosts = @{}
foreach ($name in $VIEW_NAMES) {
  $viewHost = New-Object System.Windows.Controls.Border
  $viewHost.Visibility = 'Collapsed'
  $script:viewHosts[$name] = $viewHost
  [void]$body.Children.Add($viewHost)
}

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

function Update-BuildChip {
  $build = if ($script:status) { $script:status.build } else { $null }
  if (-not $build) { $buildChip.Text = ''; return }
  switch ([string]$build.state) {
    'running' {
      $count = if ([int]$build.total -gt 0) { " $([int]$build.done)/$([int]$build.total)" } else { '' }
      $buildChip.Text = "$GLYPH_HALF $(Get-Short ([string]$build.topic) 28)$count"
      $buildChip.Foreground = $accent
    }
    'waiting-picks' { $buildChip.Text = "$GLYPH_EMPTY Pick sources: $(Get-Short ([string]$build.topic) 24)"; $buildChip.Foreground = $gold }
    'failed' { $buildChip.Text = "$GLYPH_EMPTY Build stopped: $(Get-Short ([string]$build.topic) 24)"; $buildChip.Foreground = $red }
    'done' { $buildChip.Text = "$GLYPH_CHECK $(Get-Short ([string]$build.message) 36)"; $buildChip.Foreground = $green }
    default { $buildChip.Text = '' }
  }
}

. (Join-Path $PSScriptRoot 'LearnViews.ps1')

# --- Switching views ---------------------------------------------------------------------------

function Show-View([string]$Name) {
  if ($Name -eq 'course' -and -not $script:courseId) { $Name = 'library' }
  $script:view = $Name
  foreach ($key in $VIEW_NAMES) {
    $script:viewHosts[$key].Visibility = if ($key -eq $Name) { 'Visible' } else { 'Collapsed' }
    $tab = $tabTexts[$key]
    $tab.Foreground = if ($key -eq $Name) { $ink } else { $dim }
    $tab.FontWeight = if ($key -eq $Name) { 'Bold' } else { 'Normal' }
  }
  $tabTexts['course'].Visibility = if ($script:courseId) { 'Visible' } else { 'Collapsed' }
  switch ($Name) {
    'library' { Update-Library }
    'course' { Open-Course $script:courseId $null }
    'learned' { Update-Learned }
    'ask' { Open-Advisor }
    'settings' { Update-Settings }
  }
  Save-Prefs
}

function Start-FirstView {
  if ($SnapshotPath) { Start-SnapshotView; return }
  Show-View $script:view
}

foreach ($name in $VIEW_NAMES) {
  $tabTexts[$name].Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
  $tabTexts[$name].Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { Show-View ([string]$sender.Tag) } catch { Write-Failure $_ } })
}
$closeText.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
$closeText.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; $win.Close() })
$buildChip.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
$buildChip.Add_MouseLeftButtonUp({ param($sender, $e) $e.Handled = $true; try { Show-View 'library' } catch { Write-Failure $_ } })

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
    $inText = [System.Windows.Input.Keyboard]::FocusedElement -is [System.Windows.Controls.TextBox]
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
  switch ($SnapshotView) {
    'library' { Show-View 'library' }
    'learned' { Show-View 'learned' }
    'ask' { Show-View 'ask' }
    'settings' { Show-View 'settings' }
    default {
      $script:courseId = $SnapshotCourse
      $script:view = 'course'
      foreach ($key in $VIEW_NAMES) { $script:viewHosts[$key].Visibility = if ($key -eq 'course') { 'Visible' } else { 'Collapsed' } }
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

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$script:ownerTick = 0
$timer.Add_Tick({
  try { Step-Helper } catch { Write-Failure $_ }
  try { Step-Views } catch { Write-Failure $_ }
  if ($toastText.Text -and [DateTime]::UtcNow -gt $script:toastUntil) { $toastText.Text = '' }
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
