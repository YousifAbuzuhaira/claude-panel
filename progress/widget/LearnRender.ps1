# Learn's drawing helpers, dot-sourced by Learn.ps1: small controls, and the blocks the
# helper sends (a lesson page, a chat reply) drawn into a WPF FlowDocument. Kept to ASCII:
# glyphs come from code points. Script state is always $script:, never a bare name.

function New-Text([string]$Text, $Foreground) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.Foreground = $Foreground
  return $block
}

function New-Gap([double]$Left, [double]$Top, [double]$Right, [double]$Bottom) {
  return New-Object System.Windows.Thickness($Left, $Top, $Right, $Bottom)
}

# Text that acts as a button. It never takes focus, so typing stays where it was.
function New-Pressable([string]$Text, $Tag, $Foreground = $null) {
  $fore = if ($Foreground) { $Foreground } else { $dim }
  $block = New-Text $Text $fore
  $block.Tag = $Tag
  $block.Cursor = [System.Windows.Input.Cursors]::Hand
  $block.Padding = New-Gap 4 2 4 2
  $block.Add_MouseEnter({ param($sender, $e) if (-not $sender.IsEnabled) { return }; $sender.TextDecorations = [System.Windows.TextDecorations]::Underline })
  $block.Add_MouseLeave({ param($sender, $e) $sender.TextDecorations = $null })
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

function Set-ButtonText($Button, [string]$Text) { $Button.Child.Text = $Text }

# A button inside a chat or a page. It has to be a real Button: the document's text
# selection takes the mouse on a press, so a plain Border there never hears the release.
$DOC_BUTTON_XAML = @'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button">
  <Border Background="{TemplateBinding Background}" CornerRadius="5" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="Left" VerticalAlignment="Center"/>
  </Border>
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
  $label = New-Text $Text $Foreground
  $label.FontWeight = 'Bold'
  $label.FontSize = 12
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

# After a click: a new label and colour, and no second click.
function Set-DocButtonDone($Button, [string]$Text, $Background) {
  $Button.Content.Text = $Text
  $Button.Background = $Background
  $Button.Cursor = [System.Windows.Input.Cursors]::Arrow
  $Button.Tag = @{ action = $null; data = $null }
}

# A chip: a rounded label, filled when on.
function New-Chip([string]$Text, $Tag, [bool]$IsOn, $OnFill = $null) {
  $chip = New-Object System.Windows.Controls.Border
  $chip.CornerRadius = New-Object System.Windows.CornerRadius(10)
  $chip.Padding = New-Gap 9 2 9 3
  $chip.Margin = New-Gap 0 0 6 6
  $chip.Cursor = [System.Windows.Input.Cursors]::Hand
  $chip.Tag = $Tag
  $chip.BorderThickness = New-Object System.Windows.Thickness(1)
  $label = New-Text $Text $ink
  $label.FontSize = 11.5
  $chip.Child = $label
  Set-ChipOn $chip $IsOn $OnFill
  return $chip
}

function Set-ChipOn($Chip, [bool]$IsOn, $OnFill = $null) {
  if ($IsOn) {
    $Chip.Background = if ($OnFill) { $OnFill } else { $accentSoft }
    $Chip.BorderBrush = $Chip.Background
    $Chip.Child.Foreground = $ink
  } else {
    $Chip.Background = $noFill
    $Chip.BorderBrush = $line
    $Chip.Child.Foreground = $dim
  }
}

# A text box with a grey hint shown while it is empty. Returns @{ holder; box }.
function New-InputBox([string]$Hint, [bool]$Multiline = $false) {
  $grid = New-Object System.Windows.Controls.Grid
  $box = New-Object System.Windows.Controls.TextBox
  $box.Background = $surface2
  $box.Foreground = $ink
  $box.CaretBrush = $ink
  $box.SelectionBrush = $accent
  $box.BorderBrush = $line
  $box.BorderThickness = New-Object System.Windows.Thickness(1)
  $box.Padding = New-Gap 6 5 6 5
  $box.FontFamily = $readFont
  $box.FontSize = 13
  $box.VerticalContentAlignment = 'Center'
  if ($Multiline) {
    $box.AcceptsReturn = $true
    $box.TextWrapping = 'Wrap'
    $box.VerticalContentAlignment = 'Top'
    $box.VerticalScrollBarVisibility = 'Auto'
  }
  $hintText = New-Text $Hint $faint
  $hintText.FontFamily = $readFont
  $hintText.FontSize = 13
  $hintText.Margin = New-Gap 9 6 6 0
  $hintText.IsHitTestVisible = $false
  $hintText.VerticalAlignment = if ($Multiline) { 'Top' } else { 'Center' }
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
    if ($item.time) { $text = "$GLYPH_PLAY $text" }
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
      $link.Add_Click({ param($sender, $e) try { if ($sender.NavigateUri) { Open-Link $sender.NavigateUri.AbsoluteUri } } catch { Write-Failure $_ } })
      [void]$Target.Add($link)
    } else {
      if ($item.added) { $run.ToolTip = 'Claude added this: it is not in the sources' }
      [void]$Target.Add($run)
    }
  }
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
  $top.Padding = New-Gap 10 4 10 0
  $top.Background = $codeBg
  $top.FontSize = $Size * 0.78
  $top.TextAlignment = 'Right'
  if ($Lang) { [void]$top.Inlines.Add((New-Object System.Windows.Documents.Run("$Lang   "))) }
  $top.Foreground = $faint
  $copy = New-Object System.Windows.Documents.Hyperlink((New-Object System.Windows.Documents.Run('copy')))
  $copy.Foreground = $dim
  $copy.TextDecorations = $null
  $copy.Cursor = [System.Windows.Input.Cursors]::Hand
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
