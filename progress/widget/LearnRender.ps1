# Learn's drawing helpers, dot-sourced by Learn.ps1: small controls, and the blocks the
# helper sends (a lesson page, a chat reply) drawn into a WPF FlowDocument. Kept to ASCII:
# glyphs come from code points. Script state is always $script:, never a bare name.
#
# Every colour is a shared brush from Theme.ps1 (Learn.ps1 maps the roles to $ink, $dim and the
# rest), so a change of colour scheme repaints what is already drawn. The numbers follow the
# visual system in Chrome.ps1: controls radius 6, chips a pill 22 high, inputs and buttons 30.
# A control's own state (hover, on, kind) rides in its child's Tag or its Resources, because
# its Tag carries its click (Set-Click).

function New-Text([string]$Text, $Foreground) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.Foreground = $Foreground
  return $block
}

function New-Gap([double]$Left, [double]$Top, [double]$Right, [double]$Bottom) {
  return New-Object System.Windows.Thickness($Left, $Top, $Right, $Bottom)
}

# Text that acts as a button. It never takes focus, so typing stays where it was. On hover a
# dim or faint one turns to the text colour; a coloured one (a link, a status) is underlined.
function New-Pressable([string]$Text, $Tag, $Foreground = $null) {
  $fore = if ($Foreground) { $Foreground } else { $dim }
  $block = New-Text $Text $fore
  $block.Tag = $Tag
  $block.Cursor = [System.Windows.Input.Cursors]::Hand
  $block.Padding = New-Gap 4 2 4 2
  $block.Add_MouseEnter({ param($sender, $e) Set-PressableHot $sender $true })
  $block.Add_MouseLeave({ param($sender, $e) Set-PressableHot $sender $false })
  return $block
}

function Set-PressableHot($Block, [bool]$Hot) {
  if ($Hot) {
    if (-not $Block.IsEnabled) { return }
    $rest = if ($Block.Foreground -eq $dim) { 'dim' } elseif ($Block.Foreground -eq $faint) { 'faint' } else { '' }
    if ($rest) {
      $Block.Resources['pressRest'] = $rest
      $Block.Foreground = $ink
    } else {
      $Block.TextDecorations = [System.Windows.TextDecorations]::Underline
    }
    return
  }
  $Block.TextDecorations = $null
  $rest = [string]$Block.Resources['pressRest']
  if (-not $rest) { return }
  $Block.Resources.Remove('pressRest')
  # Something that recoloured it meanwhile (an armed "remove?") keeps its colour.
  if ($Block.Foreground -eq $ink) { $Block.Foreground = if ($rest -eq 'dim') { $dim } else { $faint } }
}

# A button: 'primary' (the accent), 'good' (green: something becomes learned) or 'secondary'
# (a quiet fill). Chrome.ps1's New-UiButton with two things Learn needs: the 'good' kind, and a
# height of 30, so it lines up with the inputs beside it. Hover and press step the same way.
function New-Button([string]$Text, [string]$Kind = 'secondary') {
  $button = New-Object System.Windows.Controls.Border
  $button.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $button.Padding = New-Gap 12 0 12 1
  $button.MinHeight = 30
  $button.Cursor = [System.Windows.Input.Cursors]::Hand
  $button.VerticalAlignment = 'Top'
  $label = New-Text $Text $ink
  $label.HorizontalAlignment = 'Center'
  $label.VerticalAlignment = 'Center'
  $label.IsHitTestVisible = $false
  $label.Tag = @{ kind = $Kind; enabled = $true }
  $button.Child = $label
  Set-ButtonKind $button $Kind
  $button.Add_MouseEnter({ param($sender, $e) Set-ButtonLook $sender 'hot' })
  $button.Add_MouseLeave({ param($sender, $e) Set-ButtonLook $sender 'rest' })
  $button.Add_MouseLeftButtonDown({ param($sender, $e) Set-ButtonLook $sender 'down' })
  $button.Add_PreviewMouseLeftButtonUp({ param($sender, $e) Set-ButtonLook $sender 'hot' })
  return $button
}

function Set-ButtonKind($Button, [string]$Kind) {
  $state = $Button.Child.Tag
  $state.kind = $Kind
  switch ($Kind) {
    'primary' { $Button.Child.Foreground = $onAccent; $Button.Child.FontWeight = 'Bold' }
    'good' { $Button.Child.Foreground = $onAccent; $Button.Child.FontWeight = 'Bold' }
    default { $Button.Child.Foreground = $ink; $Button.Child.FontWeight = 'SemiBold' }
  }
  Set-ButtonLook $Button 'rest'
}

function Set-ButtonLook($Button, [string]$Look) {
  $state = $Button.Child.Tag
  if (-not $state.enabled) { $Look = 'rest' }
  switch ($state.kind) {
    'primary' { $Button.Background = $accent }
    'good' { $Button.Background = $green }
    default { $Button.Background = if ($Look -eq 'hot') { $UI_BUTTON_HOT } elseif ($Look -eq 'down') { $UI_BUTTON_DOWN } else { $buttonFill } }
  }
  $Button.Opacity = if (-not $state.enabled) { 0.45 } elseif ($state.kind -eq 'secondary') { 1.0 } elseif ($Look -eq 'hot') { 0.88 } elseif ($Look -eq 'down') { 0.76 } else { 1.0 }
}

function Set-ButtonEnabled($Button, [bool]$Enabled) {
  $Button.Child.Tag.enabled = $Enabled
  $Button.Cursor = if ($Enabled) { [System.Windows.Input.Cursors]::Hand } else { [System.Windows.Input.Cursors]::Arrow }
  Set-ButtonLook $Button 'rest'
}

function Set-ButtonText($Button, [string]$Text) { $Button.Child.Text = $Text }

# A button inside a chat or a page. It has to be a real Button: the document's text
# selection takes the mouse on a press, so a plain Border there never hears the release.
$DOC_BUTTON_XAML = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="Button">
  <Border x:Name="Bd" Background="{TemplateBinding Background}" CornerRadius="6" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="Left" VerticalAlignment="Center"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Bd" Property="Opacity" Value="0.88"/></Trigger>
    <Trigger Property="IsPressed" Value="True"><Setter TargetName="Bd" Property="Opacity" Value="0.76"/></Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@
$script:docButtonTemplate = [System.Windows.Markup.XamlReader]::Parse($DOC_BUTTON_XAML)

# $Action gets ($Data, $Button) when it's clicked.
function New-DocButton([string]$Text, $Background, $Foreground, [scriptblock]$Action, $Data = $null) {
  $button = New-Object System.Windows.Controls.Button
  $button.Template = $script:docButtonTemplate
  $button.Background = $Background
  $button.Padding = New-Gap 12 5 12 6
  $button.HorizontalAlignment = 'Left'
  $button.Cursor = [System.Windows.Input.Cursors]::Hand
  $button.Focusable = $false
  [System.Windows.Controls.ToolTipService]::SetShowOnDisabled($button, $true)
  $label = New-Text $Text $Foreground
  $label.FontWeight = 'SemiBold'
  $label.FontSize = 13
  $label.TextWrapping = 'Wrap'
  $button.Content = $label
  $button.Tag = @{ action = $Action; data = $Data }
  $button.Add_Click({
    param($sender, $e)
    $e.Handled = $true
    try { if ($sender.Tag.action) { & $sender.Tag.action $sender.Tag.data $sender } } catch { Write-Failure $_ }
  })
  return $button
}

# A doc button as a block of its own. It sits in a DockPanel docked left, so it is as wide as
# its label (wrapping only when the column is narrower), not a bar the width of the column.
function New-DocBlock($Button, [double]$Top = 2, [double]$Bottom = 4) {
  $dock = New-Object System.Windows.Controls.DockPanel
  $dock.LastChildFill = $false
  [System.Windows.Controls.DockPanel]::SetDock($Button, 'Left')
  [void]$dock.Children.Add($Button)
  $holder = New-Object System.Windows.Documents.BlockUIContainer($dock)
  $holder.Margin = New-Gap 0 $Top 0 $Bottom
  return $holder
}

# After a click: a new label and colour, and no second click.
function Set-DocButtonDone($Button, [string]$Text, $Background) {
  $Button.Content.Text = $Text
  $Button.Background = $Background
  $Button.Cursor = [System.Windows.Input.Cursors]::Arrow
  $Button.Tag = @{ action = $null; data = $null }
}

# Done for good: plain green text where the button was, its names still in the tooltip.
function Set-DocButtonLearned($Button) {
  Set-DocButtonDone $Button "$GLYPH_CHECK Learned" $noFill
  $Button.Content.Foreground = $green
  $Button.Padding = New-Gap 0 5 0 6
  $Button.IsEnabled = $false
}

# A chip: a pill 22 high, filled when on, with New-UiChip's numbers. Hovering an off chip lights it.
# Learn's own because its Tag carries its click (Set-Click) and an on chip can take another fill.
function New-Chip([string]$Text, $Tag, [bool]$IsOn, $OnFill = $null) {
  $chip = New-Object System.Windows.Controls.Border
  $chip.CornerRadius = New-Object System.Windows.CornerRadius(11)
  $chip.Height = 22
  $chip.Padding = New-Gap 9 0 9 0
  $chip.Margin = New-Gap 0 0 6 6
  $chip.VerticalAlignment = 'Center'
  $chip.Cursor = [System.Windows.Input.Cursors]::Hand
  $chip.Tag = $Tag
  $chip.BorderThickness = New-Object System.Windows.Thickness(1)
  $label = New-Text $Text $ink
  $label.FontSize = 11.5
  $label.VerticalAlignment = 'Center'
  $label.IsHitTestVisible = $false
  $label.Tag = @{ on = $IsOn; fill = $OnFill; border = $null; hot = $false }
  $chip.Child = $label
  $chip.Add_MouseEnter({ param($sender, $e) $sender.Child.Tag.hot = $true; Update-Chip $sender })
  $chip.Add_MouseLeave({ param($sender, $e) $sender.Child.Tag.hot = $false; Update-Chip $sender })
  Update-Chip $chip
  return $chip
}

function Update-Chip($Chip) {
  $state = $Chip.Child.Tag
  if ($state.on) {
    $Chip.Background = if ($state.fill) { $state.fill } else { $accentSoft }
    $Chip.BorderBrush = $Chip.Background
    $Chip.Child.Foreground = $ink
    $Chip.Opacity = if ($state.hot) { 0.85 } else { 1.0 }
  } else {
    $Chip.Background = if ($state.hot) { $hover } else { $noFill }
    $Chip.BorderBrush = if ($state.border) { $state.border } else { $line }
    $Chip.Child.Foreground = if ($state.hot) { $ink } else { $dim }
    $Chip.Opacity = 1.0
  }
}

function Set-ChipOn($Chip, [bool]$IsOn, $OnFill = $null) {
  $Chip.Child.Tag.on = $IsOn
  $Chip.Child.Tag.fill = $OnFill
  Update-Chip $Chip
}

# An off chip's outline in another colour (a concept you have read but not learned).
function Set-ChipBorder($Chip, $Border) {
  $Chip.Child.Tag.border = $Border
  Update-Chip $Chip
}

# A rounded text box: a quiet fill, a line border that lightens on hover and turns to the
# accent while you type (instead of the system's blue). The grey hint is in the box's own font,
# where the typed text starts, trimmed with an ellipsis when the box is narrow.
$INPUT_XAML = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="TextBox">
  <Border x:Name="Bd" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="6" SnapsToDevicePixels="True">
    <ScrollViewer x:Name="PART_ContentHost" Focusable="False" HorizontalScrollBarVisibility="Hidden" VerticalScrollBarVisibility="Hidden"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Bd" Property="BorderBrush" Value="{DynamicResource Theme.faint}"/></Trigger>
    <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="Bd" Property="BorderBrush" Value="{DynamicResource Theme.accent}"/></Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@
$script:inputTemplate = [System.Windows.Markup.XamlReader]::Parse($INPUT_XAML)
$INPUT_HEIGHT = 30

# Text you can select and copy that looks like a TextBlock: a read-only TextBox with no border,
# whose text sits in a Decorator rather than a ScrollViewer, so the wheel still scrolls the chat.
$SELECTABLE_XAML = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="TextBox">
  <Border Background="{TemplateBinding Background}"><Decorator x:Name="PART_ContentHost"/></Border>
</ControlTemplate>
'@
$script:selectableTemplate = [System.Windows.Markup.XamlReader]::Parse($SELECTABLE_XAML)

function New-SelectableText([string]$Text, $Foreground, [double]$Size) {
  $box = New-Object System.Windows.Controls.TextBox
  $box.Template = $script:selectableTemplate
  $box.Text = $Text
  $box.IsReadOnly = $true
  $box.TextWrapping = 'Wrap'
  $box.Background = $noFill
  $box.Foreground = $Foreground
  $box.SelectionBrush = $accent
  $box.BorderThickness = New-Object System.Windows.Thickness(0)
  $box.FontSize = $Size
  [System.Windows.Controls.TextBlock]::SetLineHeight($box, $Size * 1.5)
  # A text box draws its text 2 in from its edges; this puts it where a TextBlock's would be.
  $box.Margin = New-Gap -2 0 -2 0
  return $box
}

# Returns @{ holder; box }. -Mono for paths and colours.
function New-InputBox([string]$Hint, [bool]$Multiline = $false, [switch]$Mono) {
  $font = if ($Mono) { $monoFont } else { $readFont }
  $grid = New-Object System.Windows.Controls.Grid
  $box = New-Object System.Windows.Controls.TextBox
  $box.Template = $script:inputTemplate
  $box.Background = $surface2
  $box.Foreground = $ink
  $box.CaretBrush = $ink
  $box.SelectionBrush = $accent
  $box.BorderBrush = $line
  $box.BorderThickness = New-Object System.Windows.Thickness(1)
  $box.Padding = New-Gap 8 5 8 5
  $box.FontFamily = $font
  $box.FontSize = 13
  $box.VerticalContentAlignment = 'Center'
  $box.Height = $INPUT_HEIGHT
  if ($Multiline) {
    $box.Height = [double]::NaN
    $box.AcceptsReturn = $true
    $box.TextWrapping = 'Wrap'
    $box.VerticalContentAlignment = 'Top'
    $box.VerticalScrollBarVisibility = 'Auto'
  }
  $hintText = New-Text $Hint $faint
  $hintText.FontFamily = $font
  $hintText.FontSize = 13
  $hintText.TextTrimming = 'CharacterEllipsis'
  $hintText.IsHitTestVisible = $false
  # The border (1), the padding (8) and the text box's own 2 before the caret.
  if ($Multiline) {
    $hintText.Margin = New-Gap 11 6 9 0
    $hintText.VerticalAlignment = 'Top'
  } else {
    $hintText.Margin = New-Gap 11 0 9 0
    $hintText.VerticalAlignment = 'Center'
  }
  $box.Tag = $hintText
  $box.Add_TextChanged({ param($sender, $e) $sender.Tag.Visibility = if ($sender.Text.Length -eq 0) { 'Visible' } else { 'Collapsed' } })
  [void]$grid.Children.Add($box)
  [void]$grid.Children.Add($hintText)
  return @{ holder = $grid; box = $box }
}

function Set-InputText($Box, [string]$Text) {
  $Box.Text = $Text
  $Box.CaretIndex = $Box.Text.Length
}

function New-Divider {
  $rule = New-Object System.Windows.Controls.Border
  $rule.Height = 1
  $rule.Background = $line
  $rule.Margin = New-Gap 0 8 0 8
  return $rule
}

# A thin progress bar: a track with a filled part.
function New-Bar([double]$Ratio, [double]$Width) {
  $track = New-Object System.Windows.Controls.Border
  $track.Width = $Width
  $track.Height = 5
  $track.CornerRadius = New-Object System.Windows.CornerRadius(2.5)
  $track.Background = $surface
  $track.VerticalAlignment = 'Center'
  $fill = New-Object System.Windows.Controls.Border
  $fill.CornerRadius = New-Object System.Windows.CornerRadius(2.5)
  $fill.Background = $accent
  $fill.HorizontalAlignment = 'Left'
  $fill.Width = [Math]::Max([double]0, [Math]::Min([double]$Width, [double]$Width * $Ratio))
  $track.Child = $fill
  return $track
}

function Format-Date([string]$Iso) {
  if (-not $Iso) { return '' }
  $when = [DateTime]::MinValue
  if (-not [DateTime]::TryParse($Iso, [ref]$when)) { return '' }
  return $when.ToLocalTime().ToString('d MMM yyyy')
}

# '27 Oct' this year, '27 Oct 2025' before it. $Now is for the self-test.
function Format-ShortDate([string]$Iso, $Now = $null) {
  if (-not $Iso) { return '' }
  $when = [DateTime]::MinValue
  if (-not [DateTime]::TryParse($Iso, [ref]$when)) { return '' }
  $shown = $when.ToLocalTime()
  $today = if ($Now) { [DateTime]$Now } else { [DateTime]::Now }
  if ($shown.Year -eq $today.Year) { return $shown.ToString('d MMM') }
  return $shown.ToString('d MMM yyyy')
}

# A tick box for a list of picks: 16 square in a fixed place, so a ticked and an unticked row's
# text starts at the same x (the ballot-box glyphs fall back to fonts of different sizes).
# Ticked it is filled with the accent and carries a check; unticked, an outline you can see.
function New-Tick([bool]$Ticked) {
  $box = New-Object System.Windows.Controls.Border
  $box.Width = 16
  $box.Height = 16
  $box.CornerRadius = New-Object System.Windows.CornerRadius(4)
  $box.BorderThickness = New-Object System.Windows.Thickness(1)
  $box.VerticalAlignment = 'Top'
  if ($Ticked) {
    $box.Background = $accent
    $box.BorderBrush = $accent
    $check = New-Text $GLYPH_CHECK $onAccent
    $check.FontSize = 11
    $check.FontWeight = 'Bold'
    $check.HorizontalAlignment = 'Center'
    $check.VerticalAlignment = 'Center'
    $check.Margin = New-Gap 0 -1 0 0
    $box.Child = $check
  } else {
    $box.Background = $surface2
    $box.BorderBrush = $faint
  }
  return $box
}

function Get-Short([string]$Text, [int]$Max) {
  if (-not $Text) { return '' }
  if ($Text.Length -le $Max) { return $Text }
  return $Text.Substring(0, $Max - 1).TrimEnd() + $GLYPH_ELLIPSIS
}

# --- Blocks into a FlowDocument -----------------------------------------------------------------

function Open-Link([string]$Url) {
  if ($Url -notmatch '^https?://') { return }
  try { [void][System.Diagnostics.Process]::Start($Url) } catch { Write-Failure $_ }
}

function Add-Inlines($Target, $Inlines, [double]$Size) {
  foreach ($item in $Inlines) {
    $text = [string]$item.s
    # A no-break space: the play mark never ends a line without its time.
    if ($item.time) { $text = $GLYPH_PLAY + $GLYPH_NBSP + $text }
    $run = New-Object System.Windows.Documents.Run($text)
    if ($item.code) {
      $run.FontFamily = $monoFont
      $run.FontSize = $Size * 0.92
      $run.Background = $codeInline
      $run.Foreground = $codeInk
    }
    if ($item.b) { $run.FontWeight = 'SemiBold' }
    if ($item.i) { $run.FontStyle = 'Italic' }
    if ($item.added) {
      $run.Foreground = $gold
      $run.FontSize = $Size * 0.85
    }
    if ($item.link) {
      $link = New-Object System.Windows.Documents.Hyperlink($run)
      try { $link.NavigateUri = New-Object System.Uri([string]$item.link) } catch {}
      $link.Foreground = $blue
      $link.TextDecorations = $null
      $link.Cursor = [System.Windows.Input.Cursors]::Hand
      $link.ToolTip = if ($item.time) { 'Watch from here' } else { [string]$item.link }
      Add-LinkHover $link
      $link.Add_Click({ param($sender, $e) try { if ($sender.NavigateUri) { Open-Link $sender.NavigateUri.AbsoluteUri } } catch { Write-Failure $_ } })
      [void]$Target.Add($link)
    } else {
      if ($item.added) { $run.ToolTip = 'Claude added this: it is not in the sources' }
      [void]$Target.Add($run)
    }
  }
}

# A link in a document is underlined while the pointer is on it.
function Add-LinkHover($Link) {
  $Link.Add_MouseEnter({ param($sender, $e) $sender.TextDecorations = [System.Windows.TextDecorations]::Underline })
  $Link.Add_MouseLeave({ param($sender, $e) $sender.TextDecorations = $null })
}

function New-Paragraph([double]$Size, $Foreground) {
  $paragraph = New-Object System.Windows.Documents.Paragraph
  $paragraph.FontSize = $Size
  $paragraph.Foreground = $Foreground
  $paragraph.Margin = New-Gap 0 0 0 ($Size * 0.75)
  $paragraph.LineHeight = $Size * 1.55
  return $paragraph
}

function New-CodeBlock([string]$Text, [string]$Lang, [double]$Size) {
  $section = New-Object System.Windows.Documents.Section
  $section.Margin = New-Gap 0 2 0 ($Size * 0.9)
  $top = New-Object System.Windows.Documents.Paragraph
  $top.Margin = New-Gap 0 0 0 0
  $top.Padding = New-Gap 12 4 12 0
  $top.Background = $codeBg
  $top.FontSize = $Size * 0.78
  $top.TextAlignment = 'Right'
  if ($Lang) {
    [void]$top.Inlines.Add((New-Object System.Windows.Documents.Run($Lang)))
    # A fixed gap, not spaces, so it stays the same in any font and size.
    $gap = New-Object System.Windows.Controls.Border
    $gap.Width = 12
    [void]$top.Inlines.Add((New-Object System.Windows.Documents.InlineUIContainer($gap)))
  }
  $top.Foreground = $faint
  $copy = New-Object System.Windows.Documents.Hyperlink((New-Object System.Windows.Documents.Run('copy')))
  $copy.Foreground = $dim
  $copy.TextDecorations = $null
  $copy.Cursor = [System.Windows.Input.Cursors]::Hand
  $copy.ToolTip = 'Copy the code'
  Add-LinkHover $copy
  $copy.Tag = $Text
  $copy.Add_Click({
    param($sender, $e)
    try {
      [System.Windows.Clipboard]::SetText([string]$sender.Tag)
      Show-Toast 'Copied'
    } catch { Write-Failure $_ }
  })
  [void]$top.Inlines.Add($copy)
  [void]$section.Blocks.Add($top)
  $body = New-Object System.Windows.Documents.Paragraph
  $body.Margin = New-Gap 0 0 0 0
  $body.Padding = New-Gap 12 4 12 10
  $body.Background = $codeBg
  $body.FontFamily = $monoFont
  $body.FontSize = $Size * 0.86
  $body.Foreground = $codeInk
  $body.LineHeight = $Size * 1.3
  $lines = $Text.Replace("`r", '').Split("`n")
  for ($k = 0; $k -lt $lines.Length; $k++) {
    if ($k -gt 0) { [void]$body.Inlines.Add((New-Object System.Windows.Documents.LineBreak)) }
    [void]$body.Inlines.Add((New-Object System.Windows.Documents.Run($lines[$k])))
  }
  [void]$section.Blocks.Add($body)
  return $section
}

function New-TableBlock($Rows, [double]$Size) {
  $table = New-Object System.Windows.Documents.Table
  $table.CellSpacing = 0
  $table.Margin = New-Gap 0 2 0 ($Size * 0.9)
  $table.BorderBrush = $line
  $table.BorderThickness = New-Object System.Windows.Thickness(1)
  $columns = 0
  foreach ($row in $Rows) { $columns = [Math]::Max($columns, @($row).Count) }
  for ($k = 0; $k -lt $columns; $k++) { $table.Columns.Add((New-Object System.Windows.Documents.TableColumn)) }
  $group = New-Object System.Windows.Documents.TableRowGroup
  $first = $true
  foreach ($row in $Rows) {
    $tableRow = New-Object System.Windows.Documents.TableRow
    if ($first) { $tableRow.Background = $surface }
    foreach ($cell in @($row)) {
      $paragraph = New-Paragraph ($Size * 0.92) $ink
      $paragraph.Margin = New-Gap 0 0 0 0
      if ($first) { $paragraph.FontWeight = 'SemiBold' }
      Add-Inlines $paragraph.Inlines $cell ($Size * 0.92)
      $tableCell = New-Object System.Windows.Documents.TableCell($paragraph)
      $tableCell.Padding = New-Gap 8 4 8 4
      $tableCell.BorderBrush = $line
      $tableCell.BorderThickness = New-Object System.Windows.Thickness(0, 0, 1, 1)
      $tableRow.Cells.Add($tableCell)
    }
    $group.Rows.Add($tableRow)
    $first = $false
  }
  $table.RowGroups.Add($group)
  return $table
}

# Adds the helper's blocks to a FlowDocument block collection, at text size $Size.
function Add-Blocks($Target, $Blocks, [double]$Size) {
  foreach ($block in $Blocks) {
    switch ([string]$block.t) {
      'h' {
        $level = [int]$block.level
        $scale = switch ($level) { 1 { 1.55 } 2 { 1.32 } 3 { 1.14 } default { 1.02 } }
        $paragraph = New-Paragraph ($Size * $scale) $ink
        $paragraph.FontWeight = 'SemiBold'
        $paragraph.Margin = New-Gap 0 ($Size * 0.9) 0 ($Size * 0.4)
        Add-Inlines $paragraph.Inlines $block.inlines ($Size * $scale)
        [void]$Target.Add($paragraph)
      }
      'p' {
        $paragraph = New-Paragraph $Size $ink
        Add-Inlines $paragraph.Inlines $block.inlines $Size
        [void]$Target.Add($paragraph)
      }
      'quote' {
        $paragraph = New-Paragraph $Size $dim
        $paragraph.BorderBrush = $accent
        $paragraph.BorderThickness = New-Object System.Windows.Thickness(3, 0, 0, 0)
        $paragraph.Padding = New-Gap 12 2 0 2
        Add-Inlines $paragraph.Inlines $block.inlines $Size
        [void]$Target.Add($paragraph)
      }
      'code' { [void]$Target.Add((New-CodeBlock ([string]$block.text) ([string]$block.lang) $Size)) }
      'table' { [void]$Target.Add((New-TableBlock $block.rows $Size)) }
      'hr' {
        $rule = New-Object System.Windows.Controls.Border
        $rule.Height = 1
        $rule.Background = $line
        $holder = New-Object System.Windows.Documents.BlockUIContainer($rule)
        $holder.Margin = New-Gap 0 6 0 12
        [void]$Target.Add($holder)
      }
      { $_ -eq 'ul' -or $_ -eq 'ol' } {
        $list = New-List ([string]$block.t -eq 'ol') $Size
        if ($block.start -and [int]$block.start -gt 1) { $list.StartIndex = [int]$block.start }
        $list.Margin = New-Gap 0 0 0 ($Size * 0.75)
        # A deeper item goes into a list of its own inside the item above it.
        $lists = @{ 0 = $list }
        $lastItems = @{}
        foreach ($item in $block.items) {
          $depth = [int]$item.depth
          while ($depth -gt 0 -and -not $lastItems.ContainsKey($depth - 1)) { $depth-- }
          if ($depth -gt 0 -and -not $lists.ContainsKey($depth)) {
            $nested = New-List ([bool]$item.ordered) $Size
            [void]$lastItems[$depth - 1].Blocks.Add($nested)
            $lists[$depth] = $nested
          }
          $paragraph = New-Paragraph $Size $ink
          $paragraph.Margin = New-Gap 0 0 0 ($Size * 0.3)
          Add-Inlines $paragraph.Inlines $item.inlines $Size
          $listItem = New-Object System.Windows.Documents.ListItem($paragraph)
          [void]$lists[$depth].ListItems.Add($listItem)
          $lastItems[$depth] = $listItem
          foreach ($deeper in @($lists.Keys | Where-Object { $_ -gt $depth })) { $lists.Remove($deeper); $lastItems.Remove($deeper) }
        }
        [void]$Target.Add($list)
      }
    }
  }
}

function New-List([bool]$Ordered, [double]$Size) {
  $list = New-Object System.Windows.Documents.List
  $list.MarkerStyle = if ($Ordered) { 'Decimal' } else { 'Disc' }
  $list.Margin = New-Gap 0 2 0 2
  $list.Padding = New-Gap ($Size * 1.4) 0 0 0
  $list.Foreground = $ink
  return $list
}

function New-Document([double]$Size) {
  $doc = New-Object System.Windows.Documents.FlowDocument
  $doc.FontFamily = $readFont
  $doc.FontSize = $Size
  $doc.Foreground = $ink
  $doc.Background = $noFill
  $doc.PagePadding = New-Gap 2 2 14 2
  $doc.TextAlignment = 'Left'
  return $doc
}

function New-Reader {
  $viewer = New-Object System.Windows.Controls.FlowDocumentScrollViewer
  $viewer.VerticalScrollBarVisibility = 'Auto'
  $viewer.HorizontalScrollBarVisibility = 'Disabled'
  $viewer.IsToolBarVisible = $false
  $viewer.Background = $noFill
  $viewer.Foreground = $ink
  $viewer.SelectionBrush = $accent
  return $viewer
}

# The ScrollViewer inside a FlowDocumentScrollViewer (once it has drawn).
function Get-ReaderScroll($Viewer) {
  try {
    [void]$Viewer.ApplyTemplate()
    return $Viewer.Template.FindName('PART_ContentHost', $Viewer)
  } catch { return $null }
}
