# The small pieces every window is built from, so they look and behave the same everywhere:
# header marks, buttons, chips, stat boxes, the resize grip, colour-scheme swatches, opacity bars,
# and the list of windows with the way to open one from another.
# Dot-sourced after Theme.ps1 and Initialize-Theme (everything here paints with $script:THEME).
# Kept to ASCII. Event handlers never close over locals: what they need rides in .Tag.
#
# The visual system, in numbers:
#   spacing 2 4 6 8 12 16 24; controls radius 6, cards 10, chips a pill; lines 1px
#   marks: a glyph centred in a 22x22 box; titles mono 20 Bold accent; captions mono 11 UPPERCASE
#   mono = Cascadia Mono, Consolas; sans = Segoe UI

$UI_MONO = New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas')
$UI_SANS = New-Object System.Windows.Media.FontFamily('Segoe UI')
$UI_RADIUS = 6
$UI_CARD_RADIUS = 10
$UI_MARK_SIZE = 22
$UI_GLYPHS = @{
  close = [string][char]0x2715
  # A game controller: Segoe MDL2 Assets' Game icon (New-UiMark draws it in that font).
  games = [string][char]0xE7FC
  look = [string][char]0x25D0
  collapse = [string][char]0x25BC
  expand = [string][char]0x25B6
  gripLeft = [string][char]0x25E3
  gripRight = [string][char]0x25E2
  dot = [string][char]0x25CF
  check = [string][char]0x2713
  cross = [string][char]0x2717
  middot = [string][char]0x00B7
  arrow = [string][char]0x2192
}

# Glyphs drawn from an icon font rather than the text font.
$UI_GLYPH_FONTS = @{ ([string][char]0xE7FC) = (New-Object System.Windows.Media.FontFamily('Segoe MDL2 Assets')) }

# Every window the panel can open: one list, so each window can open the others.
# A game is one per chat (its window title ends in :<session>). Learn is the web page in an
# Edge app window: Learn.ps1 only opens it, and keeps it to one window (so no title here).
$UI_SIBLINGS = @(
  @{ id = 'learn'; label = 'Learn'; script = 'Learn.ps1'; title = ''; shared = $true },
  @{ id = 'sudoku'; label = 'Sudoku'; script = 'Sudoku.ps1'; title = 'ClaudeSudoku'; shared = $false },
  @{ id = '2048'; label = '2048'; script = 'Game2048.ps1'; title = 'Claude2048'; shared = $false },
  @{ id = 'typing'; label = 'Typing'; script = 'TypeTest.ps1'; title = 'ClaudeTypeTest'; shared = $false },
  @{ id = 'chess'; label = 'Chess'; script = 'ChessPuzzles.ps1'; title = 'ClaudeChess'; shared = $false }
)

function Get-UiBrush([string]$Role) { return $script:THEME.brushes[$Role] }

# A secondary button rests on the 'button' fill; hovered and pressed it steps further toward the text.
$UI_BUTTON_HOT = New-ThemeTint 'ink' 0.20
$UI_BUTTON_DOWN = New-ThemeTint 'ink' 0.27

function New-UiThickness([double]$Left, [double]$Top, [double]$Right, [double]$Bottom) {
  return New-Object System.Windows.Thickness($Left, $Top, $Right, $Bottom)
}

# --- Text ------------------------------------------------------------------------------------

function New-UiText([string]$Text, [string]$Role = 'ink', [double]$Size = 0, [switch]$Bold, [switch]$Mono) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.Foreground = Get-UiBrush $Role
  if ($Size -gt 0) { $block.FontSize = $Size }
  if ($Bold) { $block.FontWeight = 'Bold' }
  if ($Mono) { $block.FontFamily = $UI_MONO }
  return $block
}

# A window's name: mono 20 Bold in the accent.
function New-UiTitle([string]$Text) {
  $title = New-UiText $Text 'accent' 20 -Bold -Mono
  $title.VerticalAlignment = 'Center'
  return $title
}

# A section label: mono 11, upper case, faint.
function New-UiCaption([string]$Text, [string]$Role = 'faint') {
  $caption = New-UiText $Text.ToUpperInvariant() $Role 11 -Mono
  $caption.VerticalAlignment = 'Center'
  return $caption
}

# --- Marks: the glyph buttons in a header ------------------------------------------------------

# A glyph centred in a fixed box, dim until hovered. Add a MouseLeftButtonUp handler to use it;
# Set-UiMarkOn shows a toggled state (the glyph in the accent).
function New-UiMark([string]$Glyph, [string]$Tip, [double]$Size = 0, [double]$GlyphSize = 13) {
  if ($Size -le 0) { $Size = $UI_MARK_SIZE }
  $box = New-Object System.Windows.Controls.Border
  $box.Width = $Size
  $box.Height = $Size
  $box.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $box.Background = [System.Windows.Media.Brushes]::Transparent
  $box.Cursor = [System.Windows.Input.Cursors]::Hand
  $box.VerticalAlignment = 'Center'
  if ($Tip) { $box.ToolTip = $Tip }
  $glyphText = New-Object System.Windows.Controls.TextBlock
  $glyphText.Text = $Glyph
  $glyphText.FontSize = $GlyphSize
  $glyphText.FontFamily = $UI_SANS
  if ($UI_GLYPH_FONTS.ContainsKey($Glyph)) { $glyphText.FontFamily = $UI_GLYPH_FONTS[$Glyph] }
  $glyphText.Foreground = Get-UiBrush 'dim'
  $glyphText.HorizontalAlignment = 'Center'
  $glyphText.VerticalAlignment = 'Center'
  $glyphText.TextAlignment = 'Center'
  $glyphText.IsHitTestVisible = $false
  $box.Child = $glyphText
  $box.Tag = @{ glyph = $glyphText; on = $false; hot = $false }
  $box.Add_MouseEnter({ param($sender, $e) $sender.Tag.hot = $true; Update-UiMark $sender })
  $box.Add_MouseLeave({ param($sender, $e) $sender.Tag.hot = $false; Update-UiMark $sender })
  $box.Add_MouseLeftButtonDown({ param($sender, $e) $sender.Background = Get-UiBrush 'pressed'; $e.Handled = $true })
  $box.Add_MouseLeftButtonUp({ param($sender, $e) Update-UiMark $sender })
  return $box
}

function Update-UiMark($Mark) {
  $state = $Mark.Tag
  if ($state.hot) { $Mark.Background = Get-UiBrush 'hover' } else { $Mark.Background = [System.Windows.Media.Brushes]::Transparent }
  if ($state.on) { $state.glyph.Foreground = Get-UiBrush 'accent' }
  elseif ($state.hot) { $state.glyph.Foreground = Get-UiBrush 'ink' }
  else { $state.glyph.Foreground = Get-UiBrush 'dim' }
}

function Set-UiMarkOn($Mark, [bool]$On) {
  $Mark.Tag.on = $On
  Update-UiMark $Mark
}

function Set-UiMarkGlyph($Mark, [string]$Glyph) { $Mark.Tag.glyph.Text = $Glyph }

# --- Buttons and chips -------------------------------------------------------------------------

# 'primary' (accent fill), 'secondary' (a surface fill) or 'plain' (text only). Add a
# MouseLeftButtonUp handler; Set-UiEnabled greys it out.
function New-UiButton([string]$Text, [string]$Kind = 'secondary', [switch]$Mono, [string]$Tip) {
  $button = New-Object System.Windows.Controls.Border
  $button.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $button.Padding = New-UiThickness 12 4 12 5
  # One height for every text button, here and on the web (.ui-btn).
  $button.MinHeight = 28
  $button.Cursor = [System.Windows.Input.Cursors]::Hand
  $button.VerticalAlignment = 'Center'
  if ($Tip) { $button.ToolTip = $Tip }
  $label = New-Object System.Windows.Controls.TextBlock
  $label.Text = $Text
  $label.HorizontalAlignment = 'Center'
  $label.VerticalAlignment = 'Center'
  $label.IsHitTestVisible = $false
  if ($Mono) { $label.FontFamily = $UI_MONO }
  switch ($Kind) {
    'primary' { $fill = 'accent'; $role = 'onAccent'; $label.FontWeight = 'Bold' }
    'plain' { $fill = $null; $role = 'dim'; $button.Padding = New-UiThickness 4 2 4 2; $button.MinHeight = 0 }
    default { $fill = 'button'; $role = 'ink' }
  }
  $label.Foreground = Get-UiBrush $role
  if ($fill) { $button.Background = Get-UiBrush $fill } else { $button.Background = [System.Windows.Media.Brushes]::Transparent }
  $button.Child = $label
  $button.Tag = @{ label = $label; kind = $Kind; fill = $fill; role = $role; enabled = $true }
  $button.Add_MouseEnter({ param($sender, $e) if ($sender.Tag.enabled) { Set-UiButtonLook $sender 'hot' } })
  $button.Add_MouseLeave({ param($sender, $e) Set-UiButtonLook $sender 'rest' })
  $button.Add_MouseLeftButtonDown({ param($sender, $e) if ($sender.Tag.enabled) { Set-UiButtonLook $sender 'down' }; $e.Handled = $true })
  $button.Add_MouseLeftButtonUp({ param($sender, $e) if ($sender.Tag.enabled) { Set-UiButtonLook $sender 'hot' } })
  return $button
}

function Set-UiButtonLook($Button, [string]$Look) {
  $state = $Button.Tag
  $Button.Opacity = 1.0
  if (-not $state.enabled) { $Button.Opacity = 0.45; return }
  switch ($state.kind) {
    'primary' { if ($Look -eq 'hot') { $Button.Opacity = 0.88 } elseif ($Look -eq 'down') { $Button.Opacity = 0.76 } }
    'plain' { if ($Look -eq 'rest') { $state.label.Foreground = Get-UiBrush $state.role } else { $state.label.Foreground = Get-UiBrush 'ink' } }
    default {
      if ($Look -eq 'hot') { $Button.Background = $UI_BUTTON_HOT }
      elseif ($Look -eq 'down') { $Button.Background = $UI_BUTTON_DOWN }
      else { $Button.Background = Get-UiBrush $state.fill }
    }
  }
}

function Set-UiButtonText($Button, [string]$Text) { $Button.Tag.label.Text = $Text }

function Set-UiEnabled($Button, [bool]$Enabled) {
  $Button.Tag.enabled = $Enabled
  if ($Enabled) { $Button.Cursor = [System.Windows.Input.Cursors]::Hand } else { $Button.Cursor = [System.Windows.Input.Cursors]::Arrow }
  Set-UiButtonLook $Button 'rest'
}

# A pill: one of a set of choices (Set-UiChipOn marks the chosen one), or a small link-like pick.
function New-UiChip([string]$Text, [bool]$On = $false, [string]$Tip, [switch]$Mono) {
  $chip = New-Object System.Windows.Controls.Border
  $chip.CornerRadius = New-Object System.Windows.CornerRadius(11)
  $chip.Height = 22
  $chip.Padding = New-UiThickness 9 0 9 0
  $chip.BorderThickness = New-UiThickness 1 1 1 1
  $chip.Cursor = [System.Windows.Input.Cursors]::Hand
  $chip.VerticalAlignment = 'Center'
  if ($Tip) { $chip.ToolTip = $Tip }
  $label = New-Object System.Windows.Controls.TextBlock
  $label.Text = $Text
  $label.FontSize = 11.5
  $label.VerticalAlignment = 'Center'
  $label.IsHitTestVisible = $false
  if ($Mono) { $label.FontFamily = $UI_MONO }
  $chip.Child = $label
  $chip.Tag = @{ label = $label; on = $On; hot = $false }
  $chip.Add_MouseEnter({ param($sender, $e) $sender.Tag.hot = $true; Update-UiChip $sender })
  $chip.Add_MouseLeave({ param($sender, $e) $sender.Tag.hot = $false; Update-UiChip $sender })
  $chip.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
  Update-UiChip $chip
  return $chip
}

function Update-UiChip($Chip) {
  $state = $Chip.Tag
  if ($state.on) {
    $Chip.Background = Get-UiBrush 'accentSoft'
    $Chip.BorderBrush = Get-UiBrush 'accentSoft'
    $state.label.Foreground = Get-UiBrush 'ink'
  } else {
    if ($state.hot) { $Chip.Background = Get-UiBrush 'hover' } else { $Chip.Background = [System.Windows.Media.Brushes]::Transparent }
    $Chip.BorderBrush = Get-UiBrush 'line'
    if ($state.hot) { $state.label.Foreground = Get-UiBrush 'ink' } else { $state.label.Foreground = Get-UiBrush 'dim' }
  }
}

function Set-UiChipOn($Chip, [bool]$On) {
  $Chip.Tag.on = $On
  Update-UiChip $Chip
}

# --- Boxes and the grip ------------------------------------------------------------------------

# A labelled number (2048's score, the chess rating). Set-UiStatValue changes the number.
function New-UiStatBox([string]$Label, [string]$Value = '0') {
  $box = New-Object System.Windows.Controls.Border
  $box.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $box.Background = Get-UiBrush 'surface'
  $box.Padding = New-UiThickness 10 3 10 4
  $box.MinWidth = 68
  $box.VerticalAlignment = 'Center'
  $stack = New-Object System.Windows.Controls.StackPanel
  $caption = New-UiCaption $Label 'dim'
  $caption.HorizontalAlignment = 'Center'
  $number = New-UiText $Value 'ink' 15 -Bold -Mono
  $number.HorizontalAlignment = 'Center'
  [void]$stack.Children.Add($caption)
  [void]$stack.Children.Add($number)
  $box.Child = $stack
  $box.Tag = @{ value = $number; label = $caption }
  return $box
}

function Set-UiStatValue($Box, [string]$Value) { $Box.Tag.value.Text = $Value }

# The resize grip: a small faint corner glyph. Put it INSIDE the card (in a Grid cell over the
# content, aligned to the corner) so it scales with the card; 'left' for a card pinned by its
# top-right corner (the panel), 'right' for the others.
function New-UiGrip([string]$Corner = 'right') {
  $grip = New-Object System.Windows.Controls.TextBlock
  if ($Corner -eq 'left') {
    $grip.Text = $UI_GLYPHS.gripLeft
    $grip.HorizontalAlignment = 'Left'
    $grip.Cursor = [System.Windows.Input.Cursors]::SizeNESW
  } else {
    $grip.Text = $UI_GLYPHS.gripRight
    $grip.HorizontalAlignment = 'Right'
    $grip.Cursor = [System.Windows.Input.Cursors]::SizeNWSE
  }
  $grip.FontSize = 10
  $grip.FontFamily = $UI_SANS
  $grip.VerticalAlignment = 'Bottom'
  $grip.Foreground = Get-UiBrush 'dim'
  $grip.ToolTip = 'Drag to resize'
  $grip.Add_MouseEnter({ param($sender, $e) $sender.Foreground = Get-UiBrush 'ink' })
  $grip.Add_MouseLeave({ param($sender, $e) $sender.Foreground = Get-UiBrush 'dim' })
  return $grip
}

# --- Colour schemes and see-through ---------------------------------------------------------------

# A preset as a small swatch: its own background with its accent and text as two dots, ringed
# in the accent while it is the scheme in use. A click switches every window to it.
function New-UiSwatch($Preset, [double]$Width = 56, [double]$Height = 26) {
  $swatch = New-Object System.Windows.Controls.Border
  $swatch.Width = $Width
  $swatch.Height = $Height
  $swatch.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $swatch.BorderThickness = New-UiThickness 2 2 2 2
  $swatch.Background = New-Object System.Windows.Media.SolidColorBrush((ConvertTo-ThemeMediaColor $Preset.bg))
  $swatch.Cursor = [System.Windows.Input.Cursors]::Hand
  $swatch.ToolTip = $Preset.label
  $dots = New-Object System.Windows.Controls.StackPanel
  $dots.Orientation = 'Horizontal'
  $dots.HorizontalAlignment = 'Center'
  $dots.VerticalAlignment = 'Center'
  $dots.IsHitTestVisible = $false
  foreach ($hex in @($Preset.accent, $Preset.text)) {
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 8
    $dot.Height = 8
    $dot.Margin = New-UiThickness 2 0 2 0
    $dot.Fill = New-Object System.Windows.Media.SolidColorBrush((ConvertTo-ThemeMediaColor $hex))
    [void]$dots.Children.Add($dot)
  }
  $swatch.Child = $dots
  $swatch.Tag = @{ preset = $Preset; hot = $false }
  $swatch.Add_MouseEnter({ param($sender, $e) $sender.Tag.hot = $true; Update-UiSwatch $sender })
  $swatch.Add_MouseLeave({ param($sender, $e) $sender.Tag.hot = $false; Update-UiSwatch $sender })
  $swatch.Add_MouseLeftButtonDown({ param($sender, $e) $e.Handled = $true })
  $swatch.Add_MouseLeftButtonUp({
    param($sender, $e)
    $e.Handled = $true
    $preset = $sender.Tag.preset
    $next = Copy-Appearance
    $next.preset = $preset.name
    $next.colors = @{ bg = $preset.bg; accent = $preset.accent; text = $preset.text }
    try { Set-Appearance $next } catch {}
    if ($sender.Parent) { foreach ($sibling in $sender.Parent.Children) { if ($sibling.Tag -is [hashtable] -and $sibling.Tag.preset) { Update-UiSwatch $sibling } } }
  })
  Update-UiSwatch $swatch
  return $swatch
}

function Update-UiSwatch($Swatch) {
  $current = $script:THEME.appearance
  $preset = $Swatch.Tag.preset
  $inUse = $current.preset -eq $preset.name -and $current.colors.bg -eq $preset.bg.ToUpperInvariant() -and $current.colors.accent -eq $preset.accent.ToUpperInvariant()
  if ($inUse) { $Swatch.BorderBrush = Get-UiBrush 'accent' }
  elseif ($Swatch.Tag.hot) { $Swatch.BorderBrush = Get-UiBrush 'dim' }
  else { $Swatch.BorderBrush = Get-UiBrush 'line' }
}

# A row of every preset's swatch.
function New-UiSwatchRow([double]$SwatchWidth = 56) {
  $row = New-Object System.Windows.Controls.WrapPanel
  foreach ($preset in (Get-ThemePresets)) {
    $swatch = New-UiSwatch $preset $SwatchWidth
    $swatch.Margin = New-UiThickness 0 0 6 6
    [void]$row.Children.Add($swatch)
  }
  return $row
}

# Re-rings a row of swatches after the scheme changed somewhere else.
function Update-UiSwatchRow($Row) {
  foreach ($swatch in $Row.Children) { if ($swatch.Tag -is [hashtable] -and $swatch.Tag.preset) { Update-UiSwatch $swatch } }
}

# How see-through one group of windows is ('panel', 'learn' or 'games'): a bar to click or drag,
# with its percentage. This window repaints as it moves; the file is written when it is let go,
# and the other windows follow on their timers. Click-only, so it works in the panel too.
function New-UiOpacityBar([string]$Key, [string]$Label, [double]$Width = 150) {
  $row = New-Object System.Windows.Controls.DockPanel
  $row.LastChildFill = $false
  $name = New-UiText $Label 'dim' 11.5
  $name.Width = 52
  $name.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($name, 'Left')
  [void]$row.Children.Add($name)

  $bar = New-Object System.Windows.Controls.Grid
  $bar.Width = $Width
  $bar.Height = 18
  $bar.Background = [System.Windows.Media.Brushes]::Transparent
  $bar.Cursor = [System.Windows.Input.Cursors]::Hand
  $bar.VerticalAlignment = 'Center'
  $track = New-Object System.Windows.Controls.Border
  $track.Height = 4
  $track.CornerRadius = New-Object System.Windows.CornerRadius(2)
  $track.Background = Get-UiBrush 'line'
  $track.VerticalAlignment = 'Center'
  $fill = New-Object System.Windows.Controls.Border
  $fill.Height = 4
  $fill.CornerRadius = New-Object System.Windows.CornerRadius(2)
  $fill.Background = Get-UiBrush 'accent'
  $fill.HorizontalAlignment = 'Left'
  $fill.VerticalAlignment = 'Center'
  $knob = New-Object System.Windows.Shapes.Ellipse
  $knob.Width = 10
  $knob.Height = 10
  $knob.Fill = Get-UiBrush 'ink'
  $knob.HorizontalAlignment = 'Left'
  $knob.VerticalAlignment = 'Center'
  foreach ($part in @($track, $fill, $knob)) { $part.IsHitTestVisible = $false; [void]$bar.Children.Add($part) }
  [System.Windows.Controls.DockPanel]::SetDock($bar, 'Left')
  [void]$row.Children.Add($bar)

  $percent = New-UiText '' 'dim' 11.5 -Mono
  $percent.Width = 40
  $percent.TextAlignment = 'Right'
  $percent.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($percent, 'Left')
  [void]$row.Children.Add($percent)

  $bar.Tag = @{ key = $Key; width = $Width; fill = $fill; knob = $knob; percent = $percent; value = $script:THEME.appearance.opacity[$Key]; dirty = $false; previewAt = $null }
  $row.Tag = $bar
  $bar.Add_MouseLeftButtonDown({
    param($sender, $e)
    $e.Handled = $true
    [void]$sender.CaptureMouse()
    Set-UiOpacityFromMouse $sender $e
  })
  $bar.Add_MouseMove({
    param($sender, $e)
    if ($sender.IsMouseCaptured) { Set-UiOpacityFromMouse $sender $e }
  })
  $bar.Add_MouseLeftButtonUp({
    param($sender, $e)
    $e.Handled = $true
    if ($sender.IsMouseCaptured) { $sender.ReleaseMouseCapture() }
  })
  # Let go, or capture lost some other way: the value is saved either way.
  $bar.Add_LostMouseCapture({ param($sender, $e) Save-UiOpacity $sender })
  Update-UiOpacityBar $bar
  return $row
}

function Set-UiOpacityFromMouse($Bar, $MouseEvent) {
  $x = $MouseEvent.GetPosition($Bar).X
  $value = [Math]::Round([Math]::Max($THEME_MIN_OPACITY, [Math]::Min(1.0, [double]$x / [double]$Bar.Tag.width)), 2)
  if ($value -eq $Bar.Tag.value) { return }
  $Bar.Tag.value = $value
  $Bar.Tag.dirty = $true
  Update-UiOpacityBar $Bar
  # This window shows it as it moves when the bar is its own group's, at most every 60 ms.
  if ($Bar.Tag.key -eq $script:THEME.group) {
    $now = [Environment]::TickCount
    if ($Bar.Tag.previewAt -and [Math]::Abs($now - $Bar.Tag.previewAt) -lt 60) { return }
    $Bar.Tag.previewAt = $now
    $preview = Copy-Appearance
    $preview.opacity[$Bar.Tag.key] = $value
    Set-ThemeAppearance $preview
  }
}

function Save-UiOpacity($Bar) {
  if (-not $Bar.Tag.dirty) { return }
  $Bar.Tag.dirty = $false
  $Bar.Tag.previewAt = $null
  $next = Copy-Appearance
  $next.opacity[$Bar.Tag.key] = $Bar.Tag.value
  try { Set-Appearance $next } catch {}
}

function Update-UiOpacityBar($Bar) {
  $state = $Bar.Tag
  $ratio = [double]$state.value
  $state.fill.Width = [Math]::Max(0.0, $ratio * $state.width)
  $state.knob.Margin = New-UiThickness ([Math]::Max(0.0, $ratio * $state.width - 5)) 0 0 0
  $state.percent.Text = ('{0}%' -f [int][Math]::Round($ratio * 100))
}

# Moves an opacity bar row to the saved value after the scheme changed somewhere else.
function Update-UiOpacityRow($Row) {
  $bar = $Row.Tag
  if ($bar.IsMouseCaptured) { return }
  $bar.Tag.value = $script:THEME.appearance.opacity[$bar.Tag.key]
  Update-UiOpacityBar $bar
}

# --- Legible at low see-through ---------------------------------------------------------------

# At a low see-through whatever is behind a window can be as bright as its text (a dark scheme
# over a light window, or the other way round), and secondary text vanishes into it. So below
# $UI_HALO_BELOW the text gets a halo in the card's own colour, solid: a tight one that edges
# every letter, and over it a soft one that quiets what shows through around the text. The
# background still fades; the text stands off what is behind it. Wrap each part with text in
# New-UiHaloFrame where it would be added (never a part that animates, such as a board), and call
# Update-UiHalo after Initialize-Theme and whenever Update-Theme returns $true.
$UI_HALO_BELOW = 0.85

function New-UiHaloEffect([double]$Radius) {
  $effect = New-Object System.Windows.Media.Effects.DropShadowEffect
  $effect.ShadowDepth = 0
  $effect.BlurRadius = $Radius
  $effect.Opacity = 1
  return $effect
}
$UI_HALO_EDGE = New-UiHaloEffect 3
$UI_HALO_SOFT = New-UiHaloEffect 6
$script:uiHaloHosts = New-Object System.Collections.Generic.List[object]

# A frame for an element with text: build the element, then add the frame where it would go.
# The frame takes the element's alignment, so it is only as big as what it holds.
function New-UiHaloFrame($Element) {
  $frame = New-Object System.Windows.Controls.Border
  $frame.HorizontalAlignment = $Element.HorizontalAlignment
  $frame.VerticalAlignment = $Element.VerticalAlignment
  $frame.IsHitTestVisible = $Element.IsHitTestVisible
  $frame.Child = $Element
  $script:uiHaloHosts.Add(@{ edge = $Element; soft = $frame })
  return $frame
}

function Update-UiHalo {
  $fill = $script:THEME.brushes.cardFill.Color
  $solid = [System.Windows.Media.Color]::FromRgb($fill.R, $fill.G, $fill.B)
  $UI_HALO_EDGE.Color = $solid
  $UI_HALO_SOFT.Color = $solid
  $opacity = [double]$script:THEME.appearance.opacity[$script:THEME.group]
  $isOn = $opacity -lt $UI_HALO_BELOW
  # It comes in gently below the threshold and is full by 50%.
  $strength = [Math]::Min([double]1, [Math]::Max([double]0.25, ($UI_HALO_BELOW - $opacity) / 0.35))
  $UI_HALO_EDGE.Opacity = $strength
  $UI_HALO_SOFT.Opacity = $strength
  foreach ($pair in $script:uiHaloHosts) {
    if ($isOn) { $edge = $UI_HALO_EDGE; $soft = $UI_HALO_SOFT } else { $edge = $null; $soft = $null }
    if ($pair.edge.Effect -ne $edge) { $pair.edge.Effect = $edge }
    if ($pair.soft.Effect -ne $soft) { $pair.soft.Effect = $soft }
  }
}

# --- Opening one window from another --------------------------------------------------------------

function Initialize-UiWin32 {
  if ('ClaudeUiWin32' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ClaudeUiWin32 {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);

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
}

# Opens a sibling window by id ('learn', 'sudoku', '2048', 'typing', 'chess'), or brings it
# forward when it is already open. Learn can be sent to a view and a course: its launcher
# (Learn.ps1) always runs, and brings an open Learn forward itself.
function Open-Sibling([string]$Id, [int64]$OwnerHwnd, [string]$SessionId, [string]$View, [string]$CourseId) {
  try {
    $sibling = $UI_SIBLINGS | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if (-not $sibling) { return }
    Initialize-UiWin32
    $extra = ''
    if ($sibling.id -eq 'learn') {
      if ($View -match '^[a-z]{1,20}$') { $extra += " -View $View" }
      if ($CourseId -match '^[\w.-]{1,160}$') { $extra += " -CourseId $CourseId" }
    } else {
      $title = if ($sibling.shared) { $sibling.title } else { '{0}:{1}' -f $sibling.title, $SessionId }
      $existing = [ClaudeUiWin32]::WindowByText($title)
      if ($existing -ne [IntPtr]::Zero) { [void][ClaudeUiWin32]::SetForegroundWindow($existing); return }
    }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = 'powershell.exe'
    $start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\$($sibling.script)`" -OwnerHwnd $OwnerHwnd -SessionId $SessionId$extra"
    # Shell-started: it inherits no handle, so whoever watches this window's output still sees it end.
    $start.UseShellExecute = $true
    $start.WindowStyle = 'Hidden'
    $start.WorkingDirectory = $env:TEMP
    $child = [System.Diagnostics.Process]::Start($start)
    if ($child) { [void][ClaudeUiWin32]::AllowSetForegroundWindow($child.Id) }
  } catch {}
}

# Opens a page of the web version ('learn', 'games' or 'games/<name>') in the browser. The plugin's
# web server runs inside WSL or on Windows itself: WebOpen.ps1 starts `server.mjs open` (wsl.exe and
# web/web.sh, or node.exe), which starts (or finds) it and answers a one-time link, and this window
# opens that link with Windows' own default browser. (Asking WSL to start the browser fails when the
# wsl.exe it ran in ends at once, as it does here.) A timer waits for the answer, so the window never
# blocks. Each attempt is noted in %TEMP%\claude-panel-browser.log.
. (Join-Path $PSScriptRoot 'WebOpen.ps1')

# A one-time link for this machine's browser. An app window is Edge with no tabs or address bar:
# every Windows has it, and it sits beside the Learn window. Any other way, the default browser.
function Start-LaunchLink([string]$Link, [bool]$AppWindow) {
  if ($AppWindow) {
    foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
      if (-not $root) { continue }
      $edge = Join-Path $root 'Microsoft\Edge\Application\msedge.exe'
      if (Test-Path -LiteralPath $edge) {
        [void][System.Diagnostics.Process]::Start($edge, "--app=$Link")
        return
      }
    }
  }
  [void][System.Diagnostics.Process]::Start($Link)
}

function Open-InBrowser([string]$Page = 'learn', [string]$Extra = '', [switch]$AppWindow) {
  try {
    $start = New-WebOpenStart $Page $Extra
    if (-not $start) { Write-UiBrowserLog (Get-WebOpenTrouble); return }
    $child = [System.Diagnostics.Process]::Start($start)
    Write-UiBrowserLog "asked the web server for $Page (pid $($child.Id))"
    $wait = New-Object System.Windows.Threading.DispatcherTimer
    $wait.Interval = [TimeSpan]::FromMilliseconds(200)
    $wait.Tag = @{ child = $child; until = [DateTime]::UtcNow.AddSeconds(30); app = [bool]$AppWindow }
    $wait.Add_Tick({
      param($sender, $e)
      $state = $sender.Tag
      if (-not $state.child.HasExited -and [DateTime]::UtcNow -lt $state.until) { return }
      $sender.Stop()
      try {
        if (-not $state.child.HasExited) { Write-UiBrowserLog 'no answer from the web server in 30 s'; return }
        $lines = @($state.child.StandardOutput.ReadToEnd() -split "`n" | Where-Object { $_.Trim() })
        $answer = if ($lines.Count) { $lines[$lines.Count - 1] | ConvertFrom-Json } else { $null }
        # The link is <page>/?launch=<nonce> (a server older than 0.8.0 answers /launch/<nonce>).
        if ($answer -and $answer.ok -and $answer.launch -match '^http://127\.0\.0\.1:\d+/([a-z0-9/-]+/\?launch=|launch/)[0-9a-f]+$') {
          Start-LaunchLink ([string]$answer.launch) ([bool]$state.app)
          Write-UiBrowserLog "opened $($answer.url)"
        } else {
          Write-UiBrowserLog ("no link from the web server: " + ($lines -join ' | '))
        }
      } catch { Write-UiBrowserLog "failed: $_" }
    })
    $wait.Start()
  } catch { Write-UiBrowserLog "failed: $_" }
}

function Write-UiBrowserLog([string]$Text) {
  try { [System.IO.File]::AppendAllText((Join-Path $env:TEMP 'claude-panel-browser.log'), ('{0} {1}' -f (Get-Date -Format s), $Text) + [Environment]::NewLine) } catch {}
}

# The other windows as a row of chips (this one left out); a pick opens it and closes the row.
# Games put this under their games mark, as the panel does, and set $row.Tag = @{ mark = $mark }.
function New-UiSwitcherRow([string]$Current, [int64]$OwnerHwnd, [string]$SessionId) {
  $row = New-Object System.Windows.Controls.WrapPanel
  foreach ($sibling in $UI_SIBLINGS) {
    if ($sibling.id -eq $Current) { continue }
    $chip = New-UiChip $sibling.label $false ('Open ' + $sibling.label)
    $chip.Margin = New-UiThickness 0 0 6 0
    $chip.Tag.sibling = $sibling.id
    $chip.Tag.owner = $OwnerHwnd
    $chip.Tag.session = $SessionId
    $chip.Add_MouseLeftButtonUp({
      param($sender, $e)
      $e.Handled = $true
      # The row closes after a pick; a window that set $row.Tag = @{ mark = <its games mark> }
      # gets that mark switched off too.
      $row = $sender.Parent
      if ($row) {
        $row.Visibility = 'Collapsed'
        if ($row.Tag -is [hashtable] -and $row.Tag.mark) { Set-UiMarkOn $row.Tag.mark $false }
      }
      Open-Sibling $sender.Tag.sibling $sender.Tag.owner $sender.Tag.session
    })
    [void]$row.Children.Add($chip)
  }
  # The last chip ends flush with the row, so a right-aligned row lines up with the marks above.
  if ($row.Children.Count -gt 0) { $row.Children[$row.Children.Count - 1].Margin = New-UiThickness 0 0 0 0 }
  return $row
}
