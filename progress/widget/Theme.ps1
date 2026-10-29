# The colour scheme every window wears, and how see-through each window's background is.
# Dot-sourced by every window, after WPF is loaded. Kept to ASCII.
#
# The choice lives in one file per machine, %LOCALAPPDATA%\ClaudePhases\appearance.json:
#   {"v":1,"preset":"ember","colors":{"bg":"#1C1D20","accent":"#E08A5F","text":"#E8E6E3"},
#    "opacity":{"panel":0.92,"learn":0.96,"games":0.95}}
# Three colours make the whole palette (Get-ThemePalette). web/public/shared/theme.js derives the
# same roles the same way, and tests/theme-vectors.json holds the expected values for both.
# The brushes are made once and recoloured in place, so whatever is painted with one follows a
# change, and code that compares brushes by reference keeps working.
#
# Opacity is the background's only: the card fill carries it, and every surface on the card is a
# tint of the text colour, so it fades with the card. Text, lines and accents stay solid.

$THEME_DEFAULT_COLORS = @{ bg = '#1C1D20'; accent = '#E08A5F'; text = '#E8E6E3' }
$THEME_DEFAULT_OPACITY = @{ panel = 0.92; learn = 0.96; games = 0.95 }
# Below this a layered window's empty card no longer takes clicks or drags.
$THEME_MIN_OPACITY = 0.15
$THEME_CHECK_MS = 1000
$THEME_ROLES = @(
  'ink', 'dim', 'faint', 'accent', 'accentSoft', 'selected', 'onAccent',
  'green', 'red', 'gold', 'blue', 'greenSoft', 'redSoft', 'goldSoft', 'blueSoft',
  'line', 'rule', 'edge', 'hover', 'pressed', 'surface', 'surface2', 'button', 'well',
  'codeBg', 'codeInline', 'codeInk', 'scroll', 'popup', 'cardFill', 'veil'
)

function Get-AppearancePath {
  if ($env:CLAUDE_PANEL_APPEARANCE) { return $env:CLAUDE_PANEL_APPEARANCE }
  return (Join-Path $env:LOCALAPPDATA 'ClaudePhases\appearance.json')
}

# --- Colour arithmetic (bytes, rounded the way theme.js rounds) ------------------------------

function ConvertFrom-ThemeHex([string]$Hex) {
  if ($Hex -notmatch '^#[0-9A-Fa-f]{6}$') { return $null }
  return @([Convert]::ToInt32($Hex.Substring(1, 2), 16), [Convert]::ToInt32($Hex.Substring(3, 2), 16), [Convert]::ToInt32($Hex.Substring(5, 2), 16))
}

function Get-ThemeByte([double]$Value) {
  $byte = [int][Math]::Floor($Value + 0.5)
  if ($byte -lt 0) { return 0 }
  if ($byte -gt 255) { return 255 }
  return $byte
}

# a * (1 - t) + b * t, per channel.
function Get-ThemeMix($A, $B, [double]$T) {
  return @((Get-ThemeByte ($A[0] * (1 - $T) + $B[0] * $T)), (Get-ThemeByte ($A[1] * (1 - $T) + $B[1] * $T)), (Get-ThemeByte ($A[2] * (1 - $T) + $B[2] * $T)))
}

# '#AARRGGBB', the form WPF reads.
function Format-ThemeColor($Rgb, [double]$Alpha = 1.0) {
  return ('#{0:X2}{1:X2}{2:X2}{3:X2}' -f (Get-ThemeByte ($Alpha * 255)), $Rgb[0], $Rgb[1], $Rgb[2])
}

# WCAG relative luminance.
function Get-ThemeLuminance($Rgb) {
  $sum = 0.0
  $weights = @(0.2126, 0.7152, 0.0722)
  for ($i = 0; $i -lt 3; $i++) {
    $c = [double]$Rgb[$i] / 255.0
    if ($c -le 0.03928) { $c = $c / 12.92 } else { $c = [Math]::Pow(($c + 0.055) / 1.055, 2.4) }
    $sum += $weights[$i] * $c
  }
  return $sum
}

function Get-ThemeContrast($A, $B) {
  $la = Get-ThemeLuminance $A
  $lb = Get-ThemeLuminance $B
  return ([Math]::Max($la, $lb) + 0.05) / ([Math]::Min($la, $lb) + 0.05)
}

# --- The palette -------------------------------------------------------------------------------

# Every role, as '#AARRGGBB', from bg / accent / text and this window's background opacity.
function Get-ThemePalette($Colors, [double]$Opacity) {
  $bg = ConvertFrom-ThemeHex $Colors.bg
  $accentRgb = ConvertFrom-ThemeHex $Colors.accent
  $text = ConvertFrom-ThemeHex $Colors.text
  if (-not $bg) { $bg = ConvertFrom-ThemeHex $THEME_DEFAULT_COLORS.bg }
  if (-not $accentRgb) { $accentRgb = ConvertFrom-ThemeHex $THEME_DEFAULT_COLORS.accent }
  if (-not $text) { $text = ConvertFrom-ThemeHex $THEME_DEFAULT_COLORS.text }
  $black = @(0, 0, 0)
  $white = @(255, 255, 255)

  # Dark or light by which of black and white reads better on the background.
  $isDark = (Get-ThemeContrast $bg $white) -ge (Get-ThemeContrast $bg $black)
  if ($isDark) {
    $status = @{ green = '#5FB98A'; red = '#E0696B'; gold = '#E6BE47'; blue = '#7FB2E5' }
  } else {
    $status = @{ green = '#2F8A5B'; red = '#C23B3E'; gold = '#9A6B00'; blue = '#2C6CB0' }
  }

  # Text on an accent fill: whichever of bg and text stands out more, or a plain dark or light.
  $onAccent = $bg
  if ((Get-ThemeContrast $text $accentRgb) -gt (Get-ThemeContrast $bg $accentRgb)) { $onAccent = $text }
  if ((Get-ThemeContrast $onAccent $accentRgb) -lt 3.0) {
    if ((Get-ThemeLuminance $accentRgb) -gt 0.3) { $onAccent = @(0x1C, 0x1D, 0x20) } else { $onAccent = @(0xF5, 0xF3, 0xEF) }
  }

  if ($Opacity -lt $THEME_MIN_OPACITY) { $Opacity = $THEME_MIN_OPACITY }
  if ($Opacity -gt 1) { $Opacity = 1 }

  # Secondary text: further from the text on a dark scheme than a light one, so both read alike;
  # and nearer the text as the background clears, so it stays legible over whatever shows through.
  if ($isDark) { $dimT = 0.43; $faintT = 0.62 } else { $dimT = 0.36; $faintT = 0.52 }
  $clear = [Math]::Max(0.35, [Math]::Min(1.0, ($Opacity - 0.15) / 0.65))

  $p = [ordered]@{}
  $p.ink = Format-ThemeColor $text
  $p.dim = Format-ThemeColor (Get-ThemeMix $text $bg ($dimT * $clear))
  $p.faint = Format-ThemeColor (Get-ThemeMix $text $bg ($faintT * $clear))
  $p.accent = Format-ThemeColor $accentRgb
  $p.accentSoft = Format-ThemeColor $accentRgb 0.33
  $p.selected = Format-ThemeColor $accentRgb 0.15
  $p.onAccent = Format-ThemeColor $onAccent
  foreach ($name in @('green', 'red', 'gold', 'blue')) {
    $rgb = ConvertFrom-ThemeHex $status[$name]
    $p[$name] = Format-ThemeColor $rgb
    $p[$name + 'Soft'] = Format-ThemeColor $rgb 0.27
  }
  $p.line = Format-ThemeColor $text 0.19
  $p.rule = Format-ThemeColor $text 0.15
  $p.edge = Format-ThemeColor $text 0.20
  $p.hover = Format-ThemeColor $text 0.09
  $p.pressed = Format-ThemeColor $text 0.14
  $p.surface = Format-ThemeColor $text 0.08
  $p.surface2 = Format-ThemeColor $text 0.045
  $p.button = Format-ThemeColor $text 0.14
  $p.well = Format-ThemeColor $text 0.03
  if ($isDark) { $p.codeBg = Format-ThemeColor $black 0.30 } else { $p.codeBg = Format-ThemeColor $text 0.05 }
  $p.codeInline = Format-ThemeColor $text 0.13
  $p.codeInk = Format-ThemeColor (Get-ThemeMix $text $accentRgb 0.15)
  $p.scroll = Format-ThemeColor $text 0.22
  # Tooltips and other popups are windows of their own: solid, a step off the background.
  $p.popup = Format-ThemeColor (Get-ThemeMix $bg $text 0.10)
  $p.cardFill = Format-ThemeColor $bg $Opacity
  $p.veil = Format-ThemeColor $bg 0.85
  return $p
}

# --- The appearance file ---------------------------------------------------------------------

function Get-ThemeOpacity($Value, [double]$Default) {
  try {
    $number = [double]$Value
    if ([double]::IsNaN($number)) { return $Default }
    if ($number -lt $THEME_MIN_OPACITY) { return $THEME_MIN_OPACITY }
    if ($number -gt 1) { return 1.0 }
    return $number
  } catch { return $Default }
}

# The person's choice, field by field: anything missing or malformed is today's look.
function Read-Appearance {
  $appearance = @{
    preset = 'ember'
    colors = @{ bg = $THEME_DEFAULT_COLORS.bg; accent = $THEME_DEFAULT_COLORS.accent; text = $THEME_DEFAULT_COLORS.text }
    opacity = @{ panel = $THEME_DEFAULT_OPACITY.panel; learn = $THEME_DEFAULT_OPACITY.learn; games = $THEME_DEFAULT_OPACITY.games }
  }
  try {
    $path = Get-AppearancePath
    if (-not (Test-Path -LiteralPath $path)) { return $appearance }
    $saved = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
    if ($saved.preset -is [string] -and $saved.preset) { $appearance.preset = $saved.preset }
    if ($saved.colors) {
      foreach ($key in @('bg', 'accent', 'text')) {
        $hex = [string]$saved.colors.$key
        if (ConvertFrom-ThemeHex $hex) { $appearance.colors[$key] = $hex.ToUpperInvariant() }
      }
    }
    if ($saved.opacity) {
      foreach ($key in @('panel', 'learn', 'games')) {
        if ($null -ne $saved.opacity.$key) { $appearance.opacity[$key] = Get-ThemeOpacity $saved.opacity.$key $THEME_DEFAULT_OPACITY[$key] }
      }
    }
  } catch {}
  return $appearance
}

# Written whole to a temporary file, then swapped in, as UTF-8 without a BOM.
function Save-Appearance($Appearance) {
  $path = Get-AppearancePath
  $dir = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  $invariant = [System.Globalization.CultureInfo]::InvariantCulture
  $json = '{{"v":1,"preset":"{0}","colors":{{"bg":"{1}","accent":"{2}","text":"{3}"}},"opacity":{{"panel":{4},"learn":{5},"games":{6}}}}}' -f (
    ([string]$Appearance.preset -replace '[^A-Za-z0-9_-]', ''),
    $Appearance.colors.bg, $Appearance.colors.accent, $Appearance.colors.text,
    ([Math]::Round([double]$Appearance.opacity.panel, 2)).ToString($invariant),
    ([Math]::Round([double]$Appearance.opacity.learn, 2)).ToString($invariant),
    ([Math]::Round([double]$Appearance.opacity.games, 2)).ToString($invariant))
  $temp = $path + '.tmp'
  [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $path) { [System.IO.File]::Replace($temp, $path, $null) } else { [System.IO.File]::Move($temp, $path) }
}

# The presets that ship beside this file: @{ name; label; bg; accent; text }, in their order.
function Get-ThemePresets {
  $presets = New-Object System.Collections.Generic.List[object]
  try {
    $data = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Presets.json')) | ConvertFrom-Json
    foreach ($preset in $data.presets) {
      if ((ConvertFrom-ThemeHex $preset.bg) -and (ConvertFrom-ThemeHex $preset.accent) -and (ConvertFrom-ThemeHex $preset.text)) {
        $presets.Add(@{ name = [string]$preset.name; label = [string]$preset.label; bg = [string]$preset.bg; accent = [string]$preset.accent; text = [string]$preset.text })
      }
    }
  } catch {}
  if ($presets.Count -eq 0) {
    $presets.Add(@{ name = 'ember'; label = 'Ember'; bg = $THEME_DEFAULT_COLORS.bg; accent = $THEME_DEFAULT_COLORS.accent; text = $THEME_DEFAULT_COLORS.text })
  }
  return , $presets
}

function Get-AppearanceStamp {
  try {
    $info = New-Object System.IO.FileInfo((Get-AppearancePath))
    if (-not $info.Exists) { return 'none' }
    return '{0}:{1}' -f $info.LastWriteTimeUtc.Ticks, $info.Length
  } catch { return 'none' }
}

# --- The live brushes ------------------------------------------------------------------------

function ConvertTo-ThemeMediaColor([string]$Hex) {
  return [System.Windows.Media.Color][System.Windows.Media.ColorConverter]::ConvertFromString($Hex)
}

# Makes $script:THEME for this window: one SolidColorBrush per role, painted from the appearance
# file for this window's group ('panel', 'learn' or 'games'). Windows map the roles they use to
# their own variable names; the objects are shared, so a later Update-Theme reaches them all.
function Initialize-Theme([string]$Group) {
  $appearance = Read-Appearance
  $opacity = $appearance.opacity[$Group]
  if ($null -eq $opacity) { $opacity = 1.0 }
  $palette = Get-ThemePalette $appearance.colors $opacity
  $brushes = @{}
  foreach ($role in $THEME_ROLES) { $brushes[$role] = New-Object System.Windows.Media.SolidColorBrush((ConvertTo-ThemeMediaColor $palette[$role])) }
  $script:THEME = @{
    group = $Group
    appearance = $appearance
    palette = $palette
    brushes = $brushes
    stamp = Get-AppearanceStamp
    checkedAt = [Environment]::TickCount
    tints = New-Object System.Collections.Generic.List[object]
    resourceHosts = New-Object System.Collections.Generic.List[object]
  }
  return $brushes
}

# For the few colours a window needs that are not a role (a game's own line weight, say): a
# role at an alpha, optionally mixed toward another role first. It is a brush of its own that
# follows the scheme like the roles do.
#   New-ThemeTint 'ink' 0.45                 the text colour at 45%
#   New-ThemeTint 'red' 1.0 'cardFill' 0.45  red, 45% of the way to the background, solid
function New-ThemeTint([string]$Role, [double]$Alpha = 1.0, [string]$MixWith = '', [double]$MixT = 0) {
  $tint = @{ role = $Role; alpha = $Alpha; mixWith = $MixWith; mixT = $MixT; brush = $null }
  $tint.brush = New-Object System.Windows.Media.SolidColorBrush((Get-ThemeTintColor $tint))
  $script:THEME.tints.Add($tint)
  return $tint.brush
}

function Get-ThemeTintColor($Tint) {
  $base = ConvertTo-ThemeMediaColor $script:THEME.palette[$Tint.role]
  $rgb = @([int]$base.R, [int]$base.G, [int]$base.B)
  if ($Tint.mixWith) {
    $other = ConvertTo-ThemeMediaColor $script:THEME.palette[$Tint.mixWith]
    $rgb = Get-ThemeMix $rgb @([int]$other.R, [int]$other.G, [int]$other.B) $Tint.mixT
  }
  return [System.Windows.Media.Color]::FromArgb((Get-ThemeByte ($Tint.alpha * 255)), $rgb[0], $rgb[1], $rgb[2])
}

# Repaints every brush from the given appearance (or the file's), in place.
function Set-ThemeAppearance($Appearance) {
  $opacity = $Appearance.opacity[$script:THEME.group]
  if ($null -eq $opacity) { $opacity = 1.0 }
  $palette = Get-ThemePalette $Appearance.colors $opacity
  foreach ($role in $THEME_ROLES) { $script:THEME.brushes[$role].Color = ConvertTo-ThemeMediaColor $palette[$role] }
  $script:THEME.appearance = $Appearance
  $script:THEME.palette = $palette
  foreach ($tint in $script:THEME.tints) { $tint.brush.Color = Get-ThemeTintColor $tint }
  foreach ($resourceHost in $script:THEME.resourceHosts) { Set-ThemeResourceBrushes $resourceHost }
}

# Call from the window's timer. At most once a second it looks at the file's stamp; when the file
# changed it repaints the brushes and returns $true, so the window can redraw anything it built
# from palette values rather than brushes.
function Update-Theme {
  if (-not $script:THEME) { return $false }
  $now = [Environment]::TickCount
  if ([Math]::Abs($now - $script:THEME.checkedAt) -lt $THEME_CHECK_MS) { return $false }
  $script:THEME.checkedAt = $now
  $stamp = Get-AppearanceStamp
  if ($stamp -eq $script:THEME.stamp) { return $false }
  $script:THEME.stamp = $stamp
  Set-ThemeAppearance (Read-Appearance)
  return $true
}

# Saves a change made in this window and shows it here at once; other windows follow on their timer.
function Set-Appearance($Appearance) {
  Save-Appearance $Appearance
  Set-ThemeAppearance $Appearance
  if ($script:THEME) { $script:THEME.stamp = Get-AppearanceStamp }
}

# A fresh copy of the current appearance, to change and pass to Set-Appearance.
function Copy-Appearance {
  $current = $script:THEME.appearance
  return @{
    preset = $current.preset
    colors = @{ bg = $current.colors.bg; accent = $current.colors.accent; text = $current.colors.text }
    opacity = @{ panel = $current.opacity.panel; learn = $current.opacity.learn; games = $current.opacity.games }
  }
}

# Themed thin scrollbars and tooltips for everything inside $Element (a window, usually).
$THEME_RESOURCES_XAML = @'
<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Style x:Key="ThemeThumb" TargetType="Thumb">
    <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Thumb"><Border CornerRadius="3" Background="{DynamicResource Theme.scroll}"/></ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType="ScrollBar">
    <Setter Property="Width" Value="9"/>
    <Setter Property="MinWidth" Value="9"/>
    <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ScrollBar">
      <Track x:Name="PART_Track" Orientation="Vertical" IsDirectionReversed="True"><Track.Thumb><Thumb Style="{StaticResource ThemeThumb}" Margin="2,2,1,2"/></Track.Thumb></Track>
    </ControlTemplate></Setter.Value></Setter>
    <Style.Triggers>
      <Trigger Property="Orientation" Value="Horizontal">
        <Setter Property="Width" Value="Auto"/>
        <Setter Property="MinWidth" Value="0"/>
        <Setter Property="Height" Value="9"/>
        <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ScrollBar">
          <Track x:Name="PART_Track" Orientation="Horizontal"><Track.Thumb><Thumb Style="{StaticResource ThemeThumb}" Margin="2,2,2,1"/></Track.Thumb></Track>
        </ControlTemplate></Setter.Value></Setter>
      </Trigger>
    </Style.Triggers>
  </Style>
  <Style TargetType="ToolTip">
    <Setter Property="Foreground" Value="{DynamicResource Theme.ink}"/>
    <Setter Property="Background" Value="{DynamicResource Theme.popup}"/>
    <Setter Property="BorderBrush" Value="{DynamicResource Theme.line}"/>
    <Setter Property="FontFamily" Value="Segoe UI"/>
    <Setter Property="FontSize" Value="12"/>
    <Setter Property="HasDropShadow" Value="False"/>
    <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ToolTip">
      <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1" CornerRadius="6" Padding="8,5,8,6">
        <ContentPresenter/>
      </Border>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
</ResourceDictionary>
'@

# The styles find their colours by name ('Theme.<role>'). Each name gets a brush of its own,
# never the live role brush: WPF freezes a brush that a style or template resolves, and a
# PowerShell-made object must be unwrapped before a ResourceDictionary holds it. A change of
# scheme replaces the brushes, which is what moves a DynamicResource.
function Set-ThemeResourceBrushes($Element) {
  foreach ($role in $THEME_ROLES) {
    $color = ConvertTo-ThemeMediaColor $script:THEME.palette[$role]
    $Element.Resources['Theme.' + $role] = [System.Windows.Media.Brush]([System.Windows.Media.SolidColorBrush]::new($color))
  }
}

function Add-ThemeResources($Element) {
  $script:THEME.resourceHosts.Add($Element)
  Set-ThemeResourceBrushes $Element
  $Element.Resources.MergedDictionaries.Add([System.Windows.Markup.XamlReader]::Parse($THEME_RESOURCES_XAML))
}
