# Learn's views, dot-sourced by Learn.ps1: Library, Course (contents, page, chat),
# Review, Learned, Ask and Settings. Every change goes to the helper (Invoke-Helper) and the
# view redraws from its answer. Script state is always $script:, never a bare name.

$script:ui = @{}
$script:library = $null
$script:buildMode = 'auto'
$script:pickingJob = $null
$script:picks = @{}
$script:movingCourse = $null
$script:renamingCourse = $null
$script:editingSummary = $null
$script:shownPageStatus = ''
$script:renamingPage = $null
$script:rewritingPage = $null
$script:addingPage = $false
$script:editingDefinition = $null
$script:nestFrom = $null
$script:armed = $null
$script:courseData = $null
$script:pageNumber = 0
$script:pageData = $null
$script:chats = @{}
$script:advisorChatId = $null   # the Ask chat in front
$script:newSource = 'topic'     # what a new course is built from: topic, document or chat
$script:newDocument = $null     # @{ path; name } of the document picked for it
$DOCUMENT_EXTENSIONS = @('.pdf', '.docx', '.md', '.markdown', '.txt', '.text', '.html', '.htm')
$DOCUMENT_HINT = 'Choose a PDF, Word, Markdown, text or HTML file, or drop one here'
$NEW_SOURCES = @(
  @{ key = 'topic'; text = 'A topic or link'; tip = 'Claude researches the topic (or reads the video, playlist or page you paste) and finds the sources' },
  @{ key = 'document'; text = 'A document'; tip = 'A PDF, Word, Markdown, text or HTML file on this computer: the course is built from it' },
  @{ key = 'chat'; text = 'A Claude chat'; tip = 'Something you did in one of your Claude Code chats: Learn reads that chat and teaches it' }
)
$script:newChat = $null         # @{ id; title } of the Claude chat picked for a new course
$script:claudeChats = $null     # claudeChats.list, loaded when the picker first opens
$script:advisorChats = @()      # advisor.list: { id, title, createdAt, updatedAt, count }
$script:concepts = $null
$script:learnedFilter = 'all'
$script:learnedCategory = ''
$script:renamingConcept = $null
$script:movingConcept = $null
$script:mergeFrom = $null
$script:tidy = $null
$script:settings = $null
$script:lastLibraryAt = [DateTime]::MinValue
$script:lastCourseAt = [DateTime]::MinValue
$script:lastVideoAt = [DateTime]::MinValue
$script:pageVideo = $null
$script:courseVideos = $null
$script:videosFor = $null
$script:videoPanel = $null
$script:scrollSeen = -1.0
$script:scrollSavedAt = [DateTime]::MinValue
$script:scrollSaved = -1.0
$script:pendingScroll = $null

# A click on any element runs $Action with $Data; the handler finds both in the Tag.
function Set-Click($Element, [scriptblock]$Action, $Data = $null) {
  $Element.Tag = @{ action = $Action; data = $Data }
  $Element.Cursor = [System.Windows.Input.Cursors]::Hand
  $Element.Add_MouseLeftButtonUp({
    param($sender, $e)
    $e.Handled = $true
    try { & $sender.Tag.action $sender.Tag.data $sender } catch { Write-Failure $_ }
  })
}

function Set-Hover($Element) {
  $Element.Background = $noFill
  $Element.Add_MouseEnter({ param($sender, $e) if ($sender.Background -ne $selected) { $sender.Background = $hover } })
  $Element.Add_MouseLeave({ param($sender, $e) if ($sender.Background -ne $selected) { $sender.Background = $noFill } })
}

function New-Label([string]$Text, [double]$Size = 11, $Foreground = $null) {
  $fore = if ($Foreground) { $Foreground } else { $faint }
  $label = New-Text $Text.ToUpperInvariant() $fore
  $label.FontFamily = $monoFont
  $label.FontSize = $Size
  $label.Margin = New-Gap 0 12 0 6
  return $label
}

# A caption and its count, a fixed gap apart: 'ALREADY LEARNED  15' without spaces doing the gap.
function New-CountLabel([string]$Text, [string]$Count, $Foreground) {
  $line = New-Object System.Windows.Controls.StackPanel
  $line.Orientation = 'Horizontal'
  $line.Margin = New-Gap 0 12 0 6
  $label = New-Label $Text 11 $Foreground
  $label.Margin = New-Gap 0 0 0 0
  $countText = New-Label $Count 11 $faint
  $countText.Margin = New-Gap 8 0 0 0
  [void]$line.Children.Add($label)
  [void]$line.Children.Add($countText)
  return $line
}

function New-Column([string]$Width) {
  $column = New-Object System.Windows.Controls.ColumnDefinition
  if ($Width -eq '*') { $column.Width = New-Object System.Windows.GridLength(1, 'Star') }
  elseif ($Width -eq 'auto') { $column.Width = [System.Windows.GridLength]::Auto }
  else { $column.Width = New-Object System.Windows.GridLength([double]$Width) }
  return $column
}

function New-Scroll($Content) {
  $scroll = New-Object System.Windows.Controls.ScrollViewer
  $scroll.VerticalScrollBarVisibility = 'Auto'
  $scroll.HorizontalScrollBarVisibility = 'Disabled'
  $scroll.Content = $Content
  return $scroll
}

# A list of rows whose text starts and ends on the column's own edges while their hover fill
# reaches $Overhang past them on both sides: the scroll area sticks out by that much, and its
# content is inset by the same, so the rows' negative margins land inside it (a scroll area clips).
# The scrollbar keeps its lane past the right overhang whether the list scrolls or not (with
# nothing to scroll the bar draws nothing), so the rows' right edge never moves.
function New-RowScroll($Content, [double]$Overhang) {
  $scroll = New-Scroll $Content
  $scroll.VerticalScrollBarVisibility = 'Visible'
  $scroll.Margin = New-Gap (-$Overhang) 0 (-$Overhang - $SCROLL_LANE) 0
  $Content.Margin = New-Gap $Overhang 0 $Overhang 0
  return $scroll
}

# A view's content (Library, Learned, Ask, Settings). It starts on the header's left edge and is no
# wider than $CONTENT_MAX (Update-ViewColumns in Learn.ps1); on its right it leaves the lane its
# lists' scrollbars use, so the bar never reaches the card's own edge.
function Set-ViewColumn($Content) {
  $Content.HorizontalAlignment = 'Stretch'
  $Content.Margin = New-Gap 0 0 $SCROLL_LANE 0
}

# Armed actions (remove) need a second click within a few seconds. The first click turns the
# link into a red "remove?" right where it is; it goes back by itself when the time is up.
function Test-Armed([string]$Key, $Sender = $null, [string]$Prompt = 'remove?') {
  if ($script:armed -and $script:armed.key -eq $Key -and [DateTime]::UtcNow -lt $script:armed.until) {
    $script:armed = $null
    return $true
  }
  Reset-Armed
  $script:armed = @{ key = $Key; until = [DateTime]::UtcNow.AddSeconds(4); sender = $null; text = ''; fore = $null }
  if ($Sender -is [System.Windows.Controls.TextBlock]) {
    $rest = [string]$Sender.Resources['pressRest']
    $script:armed.sender = $Sender
    $script:armed.text = $Sender.Text
    $script:armed.fore = if ($rest -eq 'dim') { $dim } elseif ($rest -eq 'faint') { $faint } else { $Sender.Foreground }
    $Sender.Text = $Prompt
    $Sender.Foreground = $red
  }
  Show-Toast 'Click again to remove'
  return $false
}

# Puts an armed link back the way it was (its time ran out, or another was armed).
function Reset-Armed {
  $armed = $script:armed
  $script:armed = $null
  if (-not $armed -or -not $armed.sender) { return }
  $armed.sender.Text = $armed.text
  $armed.sender.Foreground = $armed.fore
}

# A text box in place of something being edited: Enter saves (Shift+Enter is a new line in a
# multi-line one), Esc cancels. Both callbacks get the text and $Data. It takes focus once drawn.
function New-InlineEdit([string]$Hint, [string]$Text, [scriptblock]$OnSave, [scriptblock]$OnCancel, $Data = $null, [switch]$Multiline) {
  $edit = New-InputBox $Hint ([bool]$Multiline)
  $edit.box.Text = $Text
  if ($Multiline) { $edit.box.Height = 64 }
  $edit.holder.Tag = @{ save = $OnSave; cancel = $OnCancel; data = $Data; multiline = [bool]$Multiline }
  $edit.box.Add_PreviewKeyDown({
    param($sender, $e)
    try {
      $spec = $sender.Parent.Tag
      $shift = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Shift) -ne 0
      if ($e.Key -eq 'Return' -and -not ($spec.multiline -and $shift)) { $e.Handled = $true; & $spec.save $sender.Text.Trim() $spec.data }
      elseif ($e.Key -eq 'Escape') { $e.Handled = $true; & $spec.cancel $sender.Text $spec.data }
    } catch { Write-Failure $_ }
  })
  $script:focusLater = $edit.box
  return $edit.holder
}

# A row's own small action (rename, move, remove): one size and padding everywhere.
function New-SmallAction([string]$Text, [scriptblock]$Action, $Data, $Foreground = $null) {
  $press = New-Pressable $Text $null $(if ($Foreground) { $Foreground } else { $faint })
  $press.FontSize = 11.5
  $press.Padding = New-Gap 4 1 4 1
  $press.VerticalAlignment = 'Center'
  Set-Click $press $Action $Data
  return $press
}

# A category's heading with rename and remove. $Reload redraws the view it sits in.
$script:renamingCategory = $null
function New-CategoryHeader([string]$Id, [string]$Text, [string]$Count, [scriptblock]$Reload, $Categories) {
  $head = New-Object System.Windows.Controls.DockPanel
  $head.Margin = New-Gap 0 16 0 4
  $head.MinHeight = 20
  $head.Background = $noFill
  $actions = New-Object System.Windows.Controls.StackPanel
  $actions.Orientation = 'Horizontal'
  $actions.Visibility = 'Hidden'
  [System.Windows.Controls.DockPanel]::SetDock($actions, 'Right')
  $head.Tag = $actions
  $head.Add_MouseEnter({ param($sender, $e) $sender.Tag.Visibility = 'Visible' })
  $head.Add_MouseLeave({ param($sender, $e) $sender.Tag.Visibility = 'Hidden' })
  [void]$actions.Children.Add((New-SmallAction 'rename' { param($Data, $Sender) $script:renamingCategory = $Data.id; & $Data.reload } @{ id = $Id; reload = $Reload }))
  [void]$actions.Children.Add((New-SmallAction 'remove' { param($Data, $Sender) Remove-Category $Data.id $Data.categories $Data.reload $Sender } @{ id = $Id; categories = @($Categories); reload = $Reload }))
  [void]$head.Children.Add($actions)
  if ($script:renamingCategory -eq $Id) {
    $edit = New-InlineEdit 'Category name' (Get-CategoryName $Id) {
      param($Text, $Data)
      Invoke-Helper 'category.rename' @{ id = $Data.id; name = $Text } { param($Result, $Context) $script:renamingCategory = $null; Update-Library; Update-Learned } $null
    } { param($Text, $Data) $script:renamingCategory = $null; & $Data.reload } @{ id = $Id; reload = $Reload }
    $edit.Width = 260
    $edit.HorizontalAlignment = 'Left'
    [void]$head.Children.Add($edit)
    return @{ head = $head; label = $null }
  }
  $label = New-Label $Text 11.5 $accent
  $label.Margin = New-Gap 0 0 0 0
  $label.VerticalAlignment = 'Center'
  $label.TextTrimming = 'CharacterEllipsis'
  [System.Windows.Controls.DockPanel]::SetDock($label, 'Left')
  [void]$head.Children.Add($label)
  if ($Count) {
    $countText = New-Label $Count 11 $faint
    $countText.Margin = New-Gap 8 0 0 0
    $countText.VerticalAlignment = 'Center'
    [System.Windows.Controls.DockPanel]::SetDock($countText, 'Left')
    [void]$head.Children.Add($countText)
  }
  [void]$head.Children.Add((New-Object System.Windows.Controls.Border))
  return @{ head = $head; label = $label }
}

# A remove needs a second click: the first turns the link into a red "remove?" right where it is.
function Test-ArmedHere($Sender, [string]$Key, [string]$Prompt = 'remove?') {
  return (Test-Armed $Key $Sender $Prompt)
}

function Get-CategoryName([string]$Id) {
  $categories = if ($script:library) { $script:library.categories } elseif ($script:concepts) { $script:concepts.categories } else { @() }
  foreach ($category in $categories) { if ([string]$category.id -eq $Id) { return [string]$category.name } }
  return 'General'
}

function Build-Views {
  Build-LibraryView
  Build-CourseView
  Build-ReviewView
  Build-LearnedView
  Build-AskView
  Build-SettingsView
}

# ===================================================================================================
# Library
# ===================================================================================================

function Build-LibraryView {
  $root = New-Object System.Windows.Controls.DockPanel
  $root.LastChildFill = $true
  Set-ViewColumn $root

  # New course: one line 30 high (topic, category, how to build, Build); the category's
  # suggestions sit under its own box.
  $newStack = New-Object System.Windows.Controls.StackPanel
  $newStack.Margin = New-Gap 0 0 0 16
  [System.Windows.Controls.DockPanel]::SetDock($newStack, 'Top')
  $heading = New-Text 'New course' $ink
  $heading.FontSize = 15
  $heading.FontWeight = 'SemiBold'
  $heading.VerticalAlignment = 'Center'
  $heading.Margin = New-Gap 0 0 16 0
  # What it is built from: a topic or link (researched), a document, or a Claude chat.
  $headRow = New-Object System.Windows.Controls.StackPanel
  $headRow.Orientation = 'Horizontal'
  $headRow.Margin = New-Gap 0 0 0 8
  [void]$headRow.Children.Add($heading)
  $fromLabel = New-Text 'From' $faint
  $fromLabel.FontSize = 11.5
  $fromLabel.VerticalAlignment = 'Center'
  $fromLabel.Margin = New-Gap 0 0 8 0
  [void]$headRow.Children.Add($fromLabel)
  $script:ui.sourceChips = [ordered]@{}
  foreach ($item in $NEW_SOURCES) {
    $chip = New-Chip $item.text $item.key ($item.key -eq $script:newSource)
    $chip.Margin = New-Gap 0 0 6 0
    $chip.ToolTip = $item.tip
    Set-Click $chip { param($Data, $Sender) Set-NewSource $Data } $item.key
    [void]$headRow.Children.Add($chip)
    $script:ui.sourceChips[$item.key] = $chip
  }
  [void]$newStack.Children.Add($headRow)

  $row = New-Object System.Windows.Controls.Grid
  $row.ColumnDefinitions.Add((New-Column '*'))
  $row.ColumnDefinitions.Add((New-Column '200'))
  $row.ColumnDefinitions.Add((New-Column 'auto'))
  $row.ColumnDefinitions.Add((New-Column 'auto'))
  $topic = New-InputBox 'A topic to learn, or a YouTube video, playlist or docs link'
  $topic.holder.VerticalAlignment = 'Top'
  # The document in place of the topic: shown like a box; a click (or a file dropped on the
  # library) picks it.
  $docBox = New-Object System.Windows.Controls.Border
  $docBox.Height = $INPUT_HEIGHT
  $docBox.VerticalAlignment = 'Top'
  $docBox.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $docBox.Background = $surface2
  $docBox.BorderBrush = $line
  $docBox.BorderThickness = New-Object System.Windows.Thickness(1)
  $docBox.Visibility = 'Collapsed'
  $docBox.ToolTip = 'A PDF, Word (.docx), Markdown, text or HTML file, up to 64 MB'
  $docDock = New-Object System.Windows.Controls.DockPanel
  $docChoose = New-Pressable "Choose$GLYPH_ELLIPSIS" $null $blue
  $docChoose.VerticalAlignment = 'Center'
  $docChoose.Margin = New-Gap 0 0 6 0
  [System.Windows.Controls.DockPanel]::SetDock($docChoose, 'Right')
  $docClear = New-Pressable $GLYPH_CLOSE $null $faint
  $docClear.VerticalAlignment = 'Center'
  $docClear.FontSize = 11
  $docClear.Visibility = 'Collapsed'
  $docClear.ToolTip = 'Choose another'
  [System.Windows.Controls.DockPanel]::SetDock($docClear, 'Right')
  $docText = New-Text $DOCUMENT_HINT $faint
  $docText.FontSize = 13
  $docText.VerticalAlignment = 'Center'
  $docText.Margin = New-Gap 10 0 8 0
  $docText.TextTrimming = 'CharacterEllipsis'
  [void]$docDock.Children.Add($docChoose)
  [void]$docDock.Children.Add($docClear)
  [void]$docDock.Children.Add($docText)
  $docBox.Child = $docDock
  $categoryColumn = New-Object System.Windows.Controls.StackPanel
  $categoryColumn.Margin = New-Gap 8 0 0 0
  [System.Windows.Controls.Grid]::SetColumn($categoryColumn, 1)
  $category = New-InputBox 'Category'
  $categoryChips = New-Object System.Windows.Controls.WrapPanel
  $categoryChips.Margin = New-Gap 0 6 0 0
  [void]$categoryColumn.Children.Add($category.holder)
  [void]$categoryColumn.Children.Add($categoryChips)
  $modes = New-Object System.Windows.Controls.StackPanel
  $modes.Orientation = 'Horizontal'
  $modes.Margin = New-Gap 12 0 4 0
  $modes.Height = $INPUT_HEIGHT
  $modes.VerticalAlignment = 'Top'
  [System.Windows.Controls.Grid]::SetColumn($modes, 2)
  $autoChip = New-Chip 'Just build it' 'auto' $true
  $pickChip = New-Chip 'Let me pick' 'pick' $false
  $autoChip.Margin = New-Gap 0 0 6 0
  $pickChip.Margin = New-Gap 0 0 0 0
  $autoChip.ToolTip = 'Claude picks sources that cover everything you named, and builds the course straight away'
  $pickChip.ToolTip = 'Research first, then you tick which videos and pages the course is built from'
  [void]$modes.Children.Add($autoChip)
  [void]$modes.Children.Add($pickChip)
  $buildButton = New-Button 'Build' 'primary'
  $buildButton.Margin = New-Gap 8 0 0 0
  $buildButton.ToolTip = 'Start building the course (Enter)'
  [System.Windows.Controls.Grid]::SetColumn($buildButton, 3)
  # A Claude chat in place of the topic: the chat (a list opens under it) and what to cover.
  $chatBox = New-Object System.Windows.Controls.DockPanel
  $chatBox.VerticalAlignment = 'Top'
  $chatBox.Visibility = 'Collapsed'
  $chatPick = New-Object System.Windows.Controls.Border
  $chatPick.Width = 280
  $chatPick.Height = $INPUT_HEIGHT
  $chatPick.Margin = New-Gap 0 0 8 0
  $chatPick.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $chatPick.Background = $surface2
  $chatPick.BorderBrush = $line
  $chatPick.BorderThickness = New-Object System.Windows.Thickness(1)
  $chatPick.ToolTip = 'The chat the course is about'
  [System.Windows.Controls.DockPanel]::SetDock($chatPick, 'Left')
  $chatPickDock = New-Object System.Windows.Controls.DockPanel
  $chatCaret = New-Text ([string][char]0x25BE) $dim
  $chatCaret.VerticalAlignment = 'Center'
  $chatCaret.Margin = New-Gap 0 0 8 0
  [System.Windows.Controls.DockPanel]::SetDock($chatCaret, 'Right')
  $chatPickText = New-Text "Pick a chat$GLYPH_ELLIPSIS" $faint
  $chatPickText.FontSize = 13
  $chatPickText.VerticalAlignment = 'Center'
  $chatPickText.Margin = New-Gap 10 0 6 0
  $chatPickText.TextTrimming = 'CharacterEllipsis'
  [void]$chatPickDock.Children.Add($chatCaret)
  [void]$chatPickDock.Children.Add($chatPickText)
  $chatPick.Child = $chatPickDock
  $chatFocus = New-InputBox 'What should the course cover? (e.g. how we fixed the browser link)'
  [void]$chatBox.Children.Add($chatPick)
  [void]$chatBox.Children.Add($chatFocus.holder)
  $chatPopup = New-Object System.Windows.Controls.Primitives.Popup
  $chatPopup.PlacementTarget = $chatPick
  $chatPopup.Placement = 'Bottom'
  $chatPopup.VerticalOffset = 4
  $chatPopup.StaysOpen = $false
  $chatPopup.AllowsTransparency = $true
  $chatFrame = New-Object System.Windows.Controls.Border
  $chatFrame.Width = 460
  $chatFrame.Background = $T.popup
  $chatFrame.BorderBrush = $T.edge
  $chatFrame.BorderThickness = New-Object System.Windows.Thickness(1)
  $chatFrame.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $chatFrame.Padding = New-Gap 4 4 4 4
  $chatScroll = New-Object System.Windows.Controls.ScrollViewer
  $chatScroll.MaxHeight = 360
  $chatScroll.VerticalScrollBarVisibility = 'Auto'
  $chatList = New-Object System.Windows.Controls.StackPanel
  $chatScroll.Content = $chatList
  $chatFrame.Child = $chatScroll
  $chatPopup.Child = $chatFrame
  [void]$row.Children.Add($topic.holder)
  [void]$row.Children.Add($docBox)
  [void]$row.Children.Add($chatBox)
  [void]$row.Children.Add($categoryColumn)
  [void]$row.Children.Add($modes)
  [void]$row.Children.Add($buildButton)
  [void]$newStack.Children.Add($row)

  $search = New-InputBox 'Search your courses'
  $search.holder.Margin = New-Gap 0 0 0 4
  [System.Windows.Controls.DockPanel]::SetDock($search.holder, 'Top')

  $listStack = New-Object System.Windows.Controls.StackPanel
  $jobs = New-Object System.Windows.Controls.StackPanel
  $courses = New-Object System.Windows.Controls.StackPanel
  [void]$listStack.Children.Add($jobs)
  [void]$listStack.Children.Add($courses)
  $scroll = New-RowScroll $listStack 10

  [void]$root.Children.Add($newStack)
  [void]$root.Children.Add($search.holder)
  [void]$root.Children.Add($scroll)
  $script:viewHosts['library'].Child = $root

  $script:ui.topic = $topic.box
  $script:ui.topicHolder = $topic.holder
  $script:ui.docBox = $docBox
  $script:ui.chatBox = $chatBox
  $script:ui.chatPickText = $chatPickText
  $script:ui.chatFocus = $chatFocus.box
  $script:ui.chatPopup = $chatPopup
  $script:ui.chatList = $chatList
  $script:ui.docText = $docText
  $script:ui.docClear = $docClear
  $script:ui.modes = $modes
  $script:ui.category = $category.box
  $script:ui.pickChip = $pickChip
  $script:ui.autoChip = $autoChip
  $script:ui.categoryChips = $categoryChips
  $script:ui.search = $search.box
  $script:ui.jobs = $jobs
  $script:ui.courses = $courses

  Set-Click $pickChip { param($Data, $Sender) Set-BuildMode 'pick' }
  Set-Click $autoChip { param($Data, $Sender) Set-BuildMode 'auto' }
  Set-Click $buildButton { param($Data, $Sender) Submit-NewCourse }
  Set-Click $docBox { param($Data, $Sender) Select-Document }
  Set-Click $docChoose { param($Data, $Sender) Select-Document }
  Set-Click $docClear { param($Data, $Sender) Clear-NewDocument }
  Set-Click $chatPick { param($Data, $Sender) Open-ChatPicker -Show }
  $chatFocus.box.Add_KeyDown({ param($sender, $e) if ($e.Key -eq 'Return') { $e.Handled = $true; try { Submit-NewCourse } catch { Write-Failure $_ } } })
  # A file dropped anywhere on the Library is the document to build from.
  $root.AllowDrop = $true
  $root.Add_PreviewDragOver({
    param($sender, $e)
    try {
      if ($e.Data.GetDataPresent([System.Windows.DataFormats]::FileDrop)) {
        $e.Effects = [System.Windows.DragDropEffects]::Copy
        $e.Handled = $true
      }
    } catch { Write-Failure $_ }
  })
  $root.Add_PreviewDrop({
    param($sender, $e)
    try {
      if ($e.Data.GetDataPresent([System.Windows.DataFormats]::FileDrop)) {
        $files = @($e.Data.GetData([System.Windows.DataFormats]::FileDrop))
        if ($files.Count -gt 0) { Set-NewDocument ([string]$files[0]) }
        $e.Handled = $true
      }
    } catch { Write-Failure $_ }
  })
  $topic.box.Add_KeyDown({ param($sender, $e) if ($e.Key -eq 'Return') { $e.Handled = $true; try { Submit-NewCourse } catch { Write-Failure $_ } } })
  $search.box.Add_TextChanged({ param($sender, $e) try { if ($script:library) { Show-Courses } } catch { Write-Failure $_ } })
}

# What a new course is built from, and the document picked for one.
function Set-NewSource([string]$Source) {
  $script:newSource = $Source
  foreach ($key in @($script:ui.sourceChips.Keys)) { Set-ChipOn $script:ui.sourceChips[$key] ($key -eq $Source) }
  $script:ui.topicHolder.Visibility = if ($Source -eq 'topic') { 'Visible' } else { 'Collapsed' }
  $script:ui.docBox.Visibility = if ($Source -eq 'document') { 'Visible' } else { 'Collapsed' }
  if ($script:ui.chatBox) { $script:ui.chatBox.Visibility = if ($Source -eq 'chat') { 'Visible' } else { 'Collapsed' } }
  # Picking sources is for a researched topic; a document or a chat is its own source.
  $script:ui.modes.Visibility = if ($Source -eq 'topic') { 'Visible' } else { 'Collapsed' }
  if ($Source -eq 'topic') { [void]$script:ui.topic.Focus() }
  if ($Source -eq 'chat') { if ($script:newChat) { [void]$script:ui.chatFocus.Focus() } else { Open-ChatPicker -Show } }
}

function Select-Document {
  $dialog = New-Object Microsoft.Win32.OpenFileDialog
  $dialog.Title = 'A document to build a course from'
  $dialog.Filter = 'Documents (PDF, Word, Markdown, text, HTML)|*.pdf;*.docx;*.md;*.markdown;*.txt;*.text;*.html;*.htm|All files|*.*'
  $dialog.CheckFileExists = $true
  if ($dialog.ShowDialog($win)) { Set-NewDocument $dialog.FileName }
}

function Format-FileSize([double]$Bytes) {
  if ($Bytes -ge 1048576) { return ('{0:0.#} MB' -f ($Bytes / 1048576)) }
  return ('{0:0} KB' -f [Math]::Max(1, $Bytes / 1024))
}

function Set-NewDocument([string]$Path) {
  $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($DOCUMENT_EXTENSIONS -notcontains $extension) { Show-Toast 'Learn reads PDF, Word (.docx), Markdown, text and HTML files'; return }
  $size = 0
  try { $size = (Get-Item -LiteralPath $Path).Length } catch {}
  if ($size -gt 64MB) { Show-Toast 'That file is over 64 MB'; return }
  $name = [System.IO.Path]::GetFileName($Path)
  $script:newDocument = @{ path = $Path; name = $name }
  $script:ui.docText.Text = "$name  $GLYPH_DOT  $(Format-FileSize $size)"
  $script:ui.docText.Foreground = $ink
  $script:ui.docText.ToolTip = $Path
  $script:ui.docClear.Visibility = 'Visible'
  Set-NewSource 'document'
}

function Clear-NewDocument {
  $script:newDocument = $null
  $script:ui.docText.Text = $DOCUMENT_HINT
  $script:ui.docText.Foreground = $faint
  $script:ui.docText.ToolTip = $null
  $script:ui.docClear.Visibility = 'Collapsed'
}

# --- A course from a Claude chat: the picker -----------------------------------------------------

function Open-ChatPicker([switch]$Show) {
  if ($null -ne $script:claudeChats) {
    Show-ChatPicker
    if ($Show) { $script:ui.chatPopup.IsOpen = $true }
    return
  }
  $script:ui.chatList.Children.Clear()
  $wait = New-Text "Finding your chats$GLYPH_ELLIPSIS" $dim
  $wait.Margin = New-Gap 8 6 8 6
  [void]$script:ui.chatList.Children.Add($wait)
  if ($Show) { $script:ui.chatPopup.IsOpen = $true }
  Invoke-Helper 'claudeChats.list' @{} {
    param($Result, $Context)
    $script:claudeChats = @($Result | Where-Object { $_ })
    Show-ChatPicker
  }
}

function Show-ChatPicker {
  $list = $script:ui.chatList
  $list.Children.Clear()
  if (@($script:claudeChats).Count -eq 0) {
    $none = New-Text 'No Claude Code chats found on this computer.' $dim
    $none.Margin = New-Gap 8 6 8 6
    [void]$list.Children.Add($none)
    return
  }
  foreach ($chat in @($script:claudeChats)) {
    $row = New-Object System.Windows.Controls.Border
    $row.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
    $row.Padding = New-Gap 8 5 8 6
    Set-Hover $row
    if ($script:newChat -and $script:newChat.id -eq [string]$chat.id) { $row.Background = $selected }
    $stack = New-Object System.Windows.Controls.StackPanel
    $name = New-Text ([string]$chat.title) $ink
    $name.FontSize = 13
    $name.TextTrimming = 'CharacterEllipsis'
    $where = @([string]$chat.project, (Format-ChatWhen ([string]$chat.at))) | Where-Object { $_ }
    $detail = New-Text ($where -join "  $GLYPH_DOT  ") $faint
    $detail.FontSize = 11
    [void]$stack.Children.Add($name)
    [void]$stack.Children.Add($detail)
    $row.Child = $stack
    $row.ToolTip = [string]$chat.cwd
    Set-Click $row { param($Data, $Sender) Select-NewChat $Data } @{ id = [string]$chat.id; title = [string]$chat.title }
    [void]$list.Children.Add($row)
  }
}

function Select-NewChat($Chat) {
  $script:newChat = $Chat
  $script:ui.chatPickText.Text = $Chat.title
  $script:ui.chatPickText.Foreground = $ink
  $script:ui.chatPopup.IsOpen = $false
  [void]$script:ui.chatFocus.Focus()
}

function Submit-ChatCourse([string]$Category) {
  if (-not $script:newChat) { Open-ChatPicker -Show; return }
  $focus = $script:ui.chatFocus.Text.Trim()
  if (-not $focus) { Show-Toast 'Say what the course should cover'; [void]$script:ui.chatFocus.Focus(); return }
  $chat = $script:newChat
  Invoke-Helper 'build.start' @{ chat = $chat.id; focus = $focus; category = $Category } {
    param($Result, $Context)
    Show-Toast "Reading $($Context.title) for $($Context.focus). It carries on if you close this window."
    Update-Library
  } @{ title = $chat.title; focus = $focus }
  $script:ui.chatFocus.Text = ''
}

function Set-BuildMode([string]$Mode) {
  $script:buildMode = $Mode
  Set-ChipOn $script:ui.pickChip ($Mode -eq 'pick')
  Set-ChipOn $script:ui.autoChip ($Mode -eq 'auto')
}

function Submit-NewCourse {
  $category = $script:ui.category.Text.Trim()
  if (-not $category) { $category = 'General' }
  if ($script:newSource -eq 'document') {
    if (-not $script:newDocument) { Select-Document; return }
    $document = $script:newDocument
    Invoke-Helper 'build.start' @{ category = $category; file = $document.path; name = $document.name } {
      param($Result, $Context)
      Show-Toast "Reading $($Context.name). The course builds from it, and carries on if you close this window."
      Update-Library
    } @{ name = $document.name }
    Clear-NewDocument
    return
  }
  if ($script:newSource -eq 'chat') { Submit-ChatCourse $category; return }
  $topic = $script:ui.topic.Text.Trim()
  if (-not $topic) { Show-Toast 'Type a topic, or paste a link'; return }
  Start-Build $topic $category $script:buildMode
  $script:ui.topic.Text = ''
}

function Start-Build([string]$Topic, [string]$Category, [string]$Mode) {
  $fields = @{ category = $Category; mode = $Mode }
  if ($Topic -match '^https?://') { $fields.link = $Topic } else { $fields.topic = $Topic }
  Invoke-Helper 'build.start' $fields {
    param($Result, $Context)
    Show-Toast "Building: $(Get-Short ([string]$Result.topic) 80). It carries on if you close this window."
    Update-Library
  }
}

function Update-Library {
  $script:lastLibraryAt = [DateTime]::UtcNow
  Invoke-Helper 'library.get' $null {
    param($Result, $Context)
    $script:library = $Result
    Set-ReviewCount ([int]$Result.reviewDue)
    Show-Library
  }
}

function Show-Library {
  $chips = $script:ui.categoryChips
  $chips.Children.Clear()
  foreach ($category in $script:library.categories) {
    $chip = New-Chip ([string]$category.name) $null $false
    $chip.Margin = New-Gap 0 0 6 4
    $chip.ToolTip = 'Put the new course in this category'
    Set-Click $chip { param($Data, $Sender) Set-InputText $script:ui.category $Data } ([string]$category.name)
    [void]$chips.Children.Add($chip)
  }
  # A snapshot shows the source picker open, when a build is waiting for one.
  if ($SnapshotPath -and -not $script:pickingJob) {
    foreach ($job in @($script:library.jobs)) { if ([string]$job.state -eq 'waiting-picks') { Switch-Picker ([string]$job.id); break } }
  }
  Show-Jobs
  Show-Courses
}

# --- Builds -------------------------------------------------------------------------------------

function Show-Jobs {
  $panel = $script:ui.jobs
  $panel.Children.Clear()
  $jobs = @($script:library.jobs)
  if ($jobs.Count -eq 0) { return }
  [void]$panel.Children.Add((New-Label 'Builds'))
  foreach ($job in $jobs) { [void]$panel.Children.Add((New-JobRow $job)) }
}

function New-JobRow($Job) {
  # A box whose text starts on the column's edge, like the course rows'; the box reaches 10 past
  # it on both sides, where their hover fill does (New-RowScroll).
  $row = New-Object System.Windows.Controls.Border
  $row.Background = $surface2
  $row.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $row.Padding = New-Gap 10 8 10 9
  $row.Margin = New-Gap -10 0 -10 6
  $stack = New-Object System.Windows.Controls.StackPanel
  $row.Child = $stack
  $top = New-Object System.Windows.Controls.DockPanel
  $actions = New-Object System.Windows.Controls.StackPanel
  $actions.Orientation = 'Horizontal'
  [System.Windows.Controls.DockPanel]::SetDock($actions, 'Right')
  $actions.VerticalAlignment = 'Center'
  $title = New-Text (Get-Short ([string]$(if ($Job.courseTitle) { $Job.courseTitle } else { $Job.topic })) 120) $ink
  $title.FontSize = 14
  $title.FontWeight = 'SemiBold'
  $title.TextTrimming = 'CharacterEllipsis'
  $title.VerticalAlignment = 'Center'
  $title.ToolTip = [string]$Job.topic
  [void]$top.Children.Add($actions)
  [void]$top.Children.Add($title)
  [void]$stack.Children.Add($top)

  $state = [string]$Job.state
  $addAction = {
    param([string]$Text, [scriptblock]$Action, $Fore)
    $press = New-Pressable $Text $null $Fore
    $press.Margin = New-Gap 6 0 0 0
    $press.VerticalAlignment = 'Center'
    Set-Click $press $Action ([string]$Job.id)
    [void]$actions.Children.Add($press)
  }
  switch ($state) {
    'running' { & $addAction 'Pause' { param($Data, $Sender) Invoke-Helper 'build.cancel' @{ jobId = $Data } { param($Result, $Context) Update-Library } } $dim }
    'waiting-picks' {
      & $addAction $(if ($script:pickingJob -eq [string]$Job.id) { 'Hide sources' } else { 'Pick sources' }) { param($Data, $Sender) Switch-Picker $Data } $gold
      & $addAction 'Dismiss' { param($Data, $Sender) Invoke-Helper 'build.dismiss' @{ jobId = $Data } { param($Result, $Context) Update-Library } } $dim
    }
    { $_ -eq 'paused' -or $_ -eq 'failed' } {
      & $addAction 'Carry on' { param($Data, $Sender) Invoke-Helper 'build.resume' @{ jobId = $Data } { param($Result, $Context) Update-Library } } $accent
      & $addAction 'Dismiss' { param($Data, $Sender) Invoke-Helper 'build.dismiss' @{ jobId = $Data } { param($Result, $Context) Update-Library } } $dim
    }
    'done' {
      if ($Job.courseId) { & $addAction 'Open course' { param($Data, $Sender) Open-CourseFromJob $Data } $green }
      & $addAction 'Dismiss' { param($Data, $Sender) Invoke-Helper 'build.dismiss' @{ jobId = $Data } { param($Result, $Context) Update-Library } } $dim
    }
  }

  $messageFore = if ($state -eq 'failed') { $red } elseif ($state -eq 'waiting-picks') { $gold } else { $dim }
  $message = New-Text ([string]$Job.message) $messageFore
  $message.TextWrapping = 'Wrap'
  $message.Margin = New-Gap 0 3 0 0
  [void]$stack.Children.Add($message)
  if ($state -eq 'failed' -and $Job.error) {
    $why = New-Text (Get-Short ([string]$Job.error) 300) $dim
    $why.TextWrapping = 'Wrap'
    $why.FontSize = 11.5
    [void]$stack.Children.Add($why)
  }
  if ([int]$Job.total -gt 0 -and $state -ne 'done') {
    $barRow = New-Object System.Windows.Controls.StackPanel
    $barRow.Orientation = 'Horizontal'
    $barRow.Margin = New-Gap 0 6 0 0
    [void]$barRow.Children.Add((New-Bar ([double]$Job.done / [double]$Job.total) 260))
    $count = New-Text ("{0}/{1} pages" -f [int]$Job.done, [int]$Job.total) $dim
    $count.FontFamily = $monoFont
    $count.FontSize = 11
    $count.Margin = New-Gap 8 0 0 0
    $count.VerticalAlignment = 'Center'
    [void]$barRow.Children.Add($count)
    [void]$stack.Children.Add($barRow)
  }
  if ($state -eq 'waiting-picks' -and $script:pickingJob -eq [string]$Job.id) { [void]$stack.Children.Add((New-Picker $Job)) }
  return $row
}

function Open-CourseFromJob([string]$JobId) {
  foreach ($job in @($script:library.jobs)) {
    if ([string]$job.id -eq $JobId -and $job.courseId) { Open-Course ([string]$job.courseId) $null; return }
  }
}

function Switch-Picker([string]$JobId) {
  if ($script:pickingJob -eq $JobId) { $script:pickingJob = $null; Show-Jobs; return }
  $script:pickingJob = $JobId
  $script:picks = @{}
  foreach ($job in @($script:library.jobs)) {
    if ([string]$job.id -ne $JobId) { continue }
    foreach ($candidate in @($job.candidates)) { if ($candidate.recommended) { $script:picks[[string]$candidate.id] = $true } }
  }
  Show-Jobs
}

function New-Picker($Job) {
  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Margin = New-Gap 0 8 0 0
  if ($Job.summary) {
    $summary = New-Text ([string]$Job.summary) $dim
    $summary.TextWrapping = 'Wrap'
    $summary.Margin = New-Gap 0 0 0 6
    [void]$panel.Children.Add($summary)
  }
  $asks = @($Job.asks | Where-Object { $_ })
  if ($asks.Count -gt 0) {
    $gaps = @()
    for ($number = 0; $number -lt $asks.Count; $number++) {
      $has = $false
      foreach ($candidate in @($Job.candidates)) {
        if ($script:picks[[string]$candidate.id] -and (@($candidate.covers) -contains $number)) { $has = $true }
      }
      if (-not $has) { $gaps += [string]$asks[$number] }
    }
    $coverText = if ($gaps.Count -gt 0) { "Not covered by what's ticked: $($gaps -join ', ')" } else { "Covers everything you named: $($asks -join ', ')" }
    $cover = New-Text $coverText $(if ($gaps.Count -gt 0) { $gold } else { $green })
    $cover.TextWrapping = 'Wrap'
    $cover.FontSize = 12
    $cover.Margin = New-Gap 0 0 0 6
    [void]$panel.Children.Add($cover)
  }
  foreach ($candidate in @($Job.candidates)) {
    $id = [string]$candidate.id
    # A rounded row whose hover fill reaches a little past the text on both sides.
    $itemBox = New-Object System.Windows.Controls.Border
    $itemBox.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
    $itemBox.Padding = New-Gap 8 6 8 6
    $itemBox.Margin = New-Gap -8 1 -8 1
    Set-Hover $itemBox
    $item = New-Object System.Windows.Controls.DockPanel
    $itemBox.Child = $item
    # A drawn box, not a glyph, so ticked and unticked titles start at the same x.
    $tick = New-Tick ([bool]$script:picks[$id])
    $tick.Margin = New-Gap 0 1 10 0
    [System.Windows.Controls.DockPanel]::SetDock($tick, 'Left')
    $text = New-Object System.Windows.Controls.StackPanel
    $kind = if ([string]$candidate.kind -eq 'youtube') { "$GLYPH_PLAY video" } else { "$GLYPH_LINK page" }
    $length = if ($candidate.lengthMin) { "$([int]$candidate.lengthMin) min" } else { '' }
    $name = New-Text ([string]$candidate.title) $ink
    $name.TextWrapping = 'Wrap'
    $metaParts = @($kind, [string]$candidate.channel, $length, [string]$candidate.level) | Where-Object { $_ }
    $meta = New-Text ($metaParts -join "  $GLYPH_DOT  ") $faint
    $meta.FontSize = 11.5
    $meta.TextTrimming = 'CharacterEllipsis'
    $meta.Margin = New-Gap 0 1 0 2
    $why = New-Text ([string]$candidate.why) $dim
    $why.TextWrapping = 'Wrap'
    $why.FontSize = 12
    [void]$text.Children.Add($name)
    [void]$text.Children.Add($meta)
    [void]$text.Children.Add($why)
    [void]$item.Children.Add($tick)
    [void]$item.Children.Add($text)
    Set-Click $itemBox {
      param($Data, $Sender)
      if ($script:picks[$Data]) { $script:picks.Remove($Data) } else { $script:picks[$Data] = $true }
      Show-Jobs
    } $id
    $link = New-Pressable "open $GLYPH_LINK" $null $blue
    $link.FontSize = 11.5
    $link.VerticalAlignment = 'Top'
    $link.Margin = New-Gap 8 0 0 0
    $link.ToolTip = [string]$candidate.url
    Set-Click $link { param($Data, $Sender) Open-Link $Data } ([string]$candidate.url)
    [System.Windows.Controls.DockPanel]::SetDock($link, 'Right')
    $item.Children.Insert(0, $link)
    [void]$panel.Children.Add($itemBox)
  }
  $useAll = New-Pressable 'Use all' $null $blue
  $useAll.FontSize = 12
  $useAll.Margin = New-Gap 0 8 0 0
  $useAll.HorizontalAlignment = 'Left'
  Set-Click $useAll {
    param($Data, $Sender)
    foreach ($id in $Data) { $script:picks[[string]$id] = $true }
    Show-Jobs
  } @(@($Job.candidates) | ForEach-Object { [string]$_.id })
  [void]$panel.Children.Add($useAll)
  $count = $script:picks.Count
  $go = New-Button $(if ($count -eq 1) { 'Build from 1 source' } else { "Build from $count sources" }) 'primary'
  $go.HorizontalAlignment = 'Left'
  $go.Margin = New-Gap 0 10 0 2
  Set-Click $go {
    param($Data, $Sender)
    $chosen = @($script:picks.Keys)
    if ($chosen.Count -eq 0) { Show-Toast 'Tick at least one source'; return }
    Invoke-Helper 'build.pick' @{ jobId = $Data; picks = $chosen } {
      param($Result, $Context)
      $script:pickingJob = $null
      Show-Toast 'Building from your picks'
      Update-Library
    }
  } ([string]$Job.id)
  [void]$panel.Children.Add($go)
  return $panel
}

# --- Courses --------------------------------------------------------------------------------------

function Show-Courses {
  $panel = $script:ui.courses
  $panel.Children.Clear()
  $all = @($script:library.courses)
  if ($all.Count -eq 0) {
    $empty = New-Text "No courses yet. Type a topic above, for example 'Kubernetes deployments' or 'Postgres indexes', and Claude researches free videos and docs and writes you a course you read page by page, with a chat beside each page." $dim
    $empty.TextWrapping = 'Wrap'
    $empty.Margin = New-Gap 0 16 0 0
    $empty.MaxWidth = 640
    $empty.HorizontalAlignment = 'Left'
    [void]$panel.Children.Add($empty)
    return
  }
  $query = $script:ui.search.Text.Trim().ToLowerInvariant()
  $shown = @($all | Where-Object { -not $query -or ([string]$_.title).ToLowerInvariant().Contains($query) -or ([string]$_.topic).ToLowerInvariant().Contains($query) })
  $order = New-Object System.Collections.Generic.List[string]
  foreach ($category in $script:library.categories) { $order.Add([string]$category.id) }
  foreach ($course in $shown) { if (-not $order.Contains([string]$course.category)) { $order.Add([string]$course.category) } }
  foreach ($categoryId in $order) {
    $inCategory = @($shown | Where-Object { [string]$_.category -eq $categoryId })
    if ($inCategory.Count -eq 0) { continue }
    $header = New-CategoryHeader $categoryId (Get-CategoryName $categoryId) ([string]$inCategory.Count) { Show-Courses } $script:library.categories
    [void]$panel.Children.Add($header.head)
    foreach ($course in $inCategory) { [void]$panel.Children.Add((New-CourseRow $course)) }
  }
  if ($shown.Count -eq 0) {
    $none = New-Text 'No course matches.' $dim
    $none.Margin = New-Gap 0 16 0 0
    [void]$panel.Children.Add($none)
  }
}

function New-CourseRow($Course) {
  $id = [string]$Course.id
  # Its text on the column's edge; the hover fill reaches 10 past it (New-RowScroll).
  $row = New-Object System.Windows.Controls.Border
  $row.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $row.Padding = New-Gap 10 7 10 8
  $row.Margin = New-Gap -10 1 -10 1
  Set-Hover $row
  $stack = New-Object System.Windows.Controls.StackPanel
  $row.Child = $stack
  $top = New-Object System.Windows.Controls.DockPanel
  $counts = New-Text ("{0}/{1} read  {2}  {3}/{4} learned" -f [int]$Course.read, [int]$Course.pages, $GLYPH_DOT, [int]$Course.learned, [int]$Course.concepts) $dim
  $counts.FontFamily = $monoFont
  $counts.FontSize = 11
  $counts.Margin = New-Gap 12 0 0 0
  $counts.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($counts, 'Right')
  [void]$top.Children.Add($counts)
  if ($script:renamingCourse -eq $id) {
    [void]$top.Children.Add((New-InlineEdit 'Course name' ([string]$Course.title) {
      param($Text, $Data)
      Invoke-Helper 'course.update' @{ id = $Data; title = $Text } { param($Result, $Context) $script:renamingCourse = $null; Update-Library }
    } { param($Text, $Data) $script:renamingCourse = $null; Show-Courses } $id))
  } else {
    $title = New-Text ([string]$Course.title) $ink
    $title.FontSize = 14
    $title.FontWeight = 'SemiBold'
    $title.TextTrimming = 'CharacterEllipsis'
    $title.VerticalAlignment = 'Center'
    $title.ToolTip = [string]$Course.title
    [void]$top.Children.Add($title)
  }
  [void]$stack.Children.Add($top)
  if ($script:editingSummary -eq $id) {
    $summaryEdit = New-InlineEdit 'What the course is about (Enter saves, Shift+Enter for a new line)' ([string]$Course.summary) {
      param($Text, $Data)
      Invoke-Helper 'course.update' @{ id = $Data; summary = $Text } { param($Result, $Context) $script:editingSummary = $null; Update-Library }
    } { param($Text, $Data) $script:editingSummary = $null; Show-Courses } $id -Multiline
    $summaryEdit.Margin = New-Gap 0 4 0 0
    [void]$stack.Children.Add($summaryEdit)
  } elseif ($Course.summary) {
    $summary = New-Text (Get-Short ([string]$Course.summary) 220) $dim
    $summary.TextWrapping = 'Wrap'
    $summary.Margin = New-Gap 0 2 0 0
    [void]$stack.Children.Add($summary)
  }
  # The row's facts, then its actions: the first action's text starts after a 12 gap.
  $foot = New-Object System.Windows.Controls.StackPanel
  $foot.Orientation = 'Horizontal'
  $foot.Margin = New-Gap 0 4 0 0
  if ([string]$Course.status -ne 'ready') {
    $note = New-Text ("Being written: {0} of {1} pages so far" -f [int]$Course.written, [int]$Course.pages) $gold
    $note.FontSize = 11.5
    $note.Margin = New-Gap 0 0 8 0
    $note.VerticalAlignment = 'Center'
    [void]$foot.Children.Add($note)
  }
  if ($Course.lastOpened) {
    $opened = New-Text ("Opened {0}" -f (Format-Date ([string]$Course.lastOpened))) $faint
    $opened.FontSize = 11.5
    $opened.Margin = New-Gap 0 0 8 0
    $opened.VerticalAlignment = 'Center'
    [void]$foot.Children.Add($opened)
  }
  foreach ($action in @(@{ text = 'move'; key = 'move' }, @{ text = 'rename'; key = 'rename' }, @{ text = 'edit summary'; key = 'summary' }, @{ text = 'remove'; key = 'remove' })) {
    $press = New-Pressable $action.text $null $faint
    $press.FontSize = 11.5
    $press.Padding = New-Gap 4 1 4 1
    $press.VerticalAlignment = 'Center'
    # With nothing before it, the first action's text sits on the row's edge too.
    if ($foot.Children.Count -eq 0) { $press.Margin = New-Gap -4 0 0 0 }
    Set-Click $press {
      param($Data, $Sender)
      switch ($Data.key) {
        'move' { $script:movingCourse = if ($script:movingCourse -eq $Data.id) { $null } else { $Data.id }; Show-Courses }
        'rename' { $script:renamingCourse = $Data.id; Show-Courses }
        'summary' { $script:editingSummary = $Data.id; Show-Courses }
        'remove' {
          if (Test-ArmedHere $Sender "course:$($Data.id)") {
            Invoke-Helper 'course.remove' @{ id = $Data.id } {
              param($Result, $Context)
              if ($script:courseId -eq $Context) { $script:courseId = $null; $script:courseData = $null; $script:pageData = $null }
              $count = [int]$Result.removedConcepts
              Show-Toast $(if ($count -eq 1) { 'Course removed, with the 1 concept only it taught.' } else { "Course removed, with the $count concepts only it taught." })
              $script:concepts = $null
              Update-Library
            } $Data.id
          }
        }
      }
    } @{ key = $action.key; id = $id }
    [void]$foot.Children.Add($press)
  }
  [void]$stack.Children.Add($foot)
  if ($script:movingCourse -eq $id) {
    $wrap = New-Object System.Windows.Controls.WrapPanel
    $wrap.Margin = New-Gap 0 8 0 0
    foreach ($category in $script:library.categories) {
      $chip = New-Chip ([string]$category.name) $null ([string]$category.id -eq [string]$Course.category)
      Set-Click $chip { param($Data, $Sender) Invoke-Helper 'course.setCategory' @{ id = $Data.course; category = $Data.category } { param($Result, $Context) $script:movingCourse = $null; Update-Library } } @{ course = $id; category = [string]$category.id }
      [void]$wrap.Children.Add($chip)
    }
    $newCategory = New-InputBox 'New category'
    $newCategory.holder.Width = 160
    $newCategory.holder.Margin = New-Gap 4 0 0 6
    $newCategory.holder.VerticalAlignment = 'Center'
    $newCategory.box.Add_KeyDown({
      param($sender, $e)
      if ($e.Key -ne 'Return' -or -not $sender.Text.Trim()) { return }
      $e.Handled = $true
      try {
        Invoke-Helper 'category.add' @{ name = $sender.Text.Trim() } {
          param($Result, $Context)
          Invoke-Helper 'course.setCategory' @{ id = $Context; category = [string]$Result.id } { param($Result2, $Context2) $script:movingCourse = $null; Update-Library }
        } $script:movingCourse
      } catch { Write-Failure $_ }
    })
    [void]$wrap.Children.Add($newCategory.holder)
    [void]$stack.Children.Add($wrap)
  }
  Set-Click $row { param($Data, $Sender) if ($script:renamingCourse -ne $Data -and $script:editingSummary -ne $Data) { Open-Course $Data $null } } $id
  return $row
}

# ===================================================================================================
# Course: contents, page, chat
# ===================================================================================================

function Build-CourseView {
  $grid = New-Object System.Windows.Controls.Grid
  $grid.ColumnDefinitions.Add((New-Column ([string]$CONTENTS_WIDTH)))
  $grid.ColumnDefinitions.Add((New-Column '*'))
  $grid.ColumnDefinitions.Add((New-Column ([string]$CHAT_WIDTH)))

  # Contents
  $contents = New-Object System.Windows.Controls.DockPanel
  $contents.Margin = New-Gap 0 0 16 0
  $courseTitle = New-Text '' $ink
  $courseTitle.FontSize = 15
  $courseTitle.FontWeight = 'SemiBold'
  $courseTitle.TextWrapping = 'Wrap'
  $courseMeta = New-Text '' $dim
  $courseMeta.FontSize = 11.5
  $courseMeta.TextWrapping = 'Wrap'
  $courseMeta.Margin = New-Gap 0 3 0 0
  $hideLink = New-Pressable 'hide contents' $null $faint
  $hideLink.FontSize = 11.5
  $hideLink.HorizontalAlignment = 'Left'
  $hideLink.Margin = New-Gap -4 4 0 8
  $hideLink.ToolTip = 'More room for the page; show it again beside PAGE x OF y'
  $contentsTop = New-Object System.Windows.Controls.StackPanel
  [void]$contentsTop.Children.Add($courseTitle)
  [void]$contentsTop.Children.Add($courseMeta)
  $courseGap = New-Text '' $gold
  $courseGap.FontSize = 11.5
  $courseGap.TextWrapping = 'Wrap'
  $courseGap.Margin = New-Gap 0 5 0 0
  $courseGap.Visibility = 'Collapsed'
  $courseGap.ToolTip = 'You asked for this, but no source or page covers it. Add a page in Contents.'
  [void]$contentsTop.Children.Add($courseGap)
  $updateLink = New-Pressable 'Update this course' $null $blue
  $updateLink.FontSize = 11.5
  $updateLink.Margin = New-Gap 0 5 0 0
  $updateLink.HorizontalAlignment = 'Left'
  $updateLink.Visibility = 'Collapsed'
  $updateLink.ToolTip = 'Builds a new copy from the same sources, with terms, quick checks and closing questions. This one stays until you remove it.'
  Set-Click $updateLink {
    param($Data, $Sender)
    if (-not (Test-ArmedHere $Sender "update:$($script:courseId)" 'Build it again? click to confirm')) { return }
    Invoke-Helper 'course.refresh' @{ id = $script:courseId } {
      param($Result, $Context)
      Show-Toast 'Building the new version. This one stays until you remove it.'
      Show-View 'library'
    }
  }
  [void]$contentsTop.Children.Add($updateLink)
  $videosLink = New-Pressable '' $null $blue
  $videosLink.FontSize = 11.5
  $videosLink.Margin = New-Gap 0 5 0 0
  $videosLink.HorizontalAlignment = 'Left'
  $videosLink.TextWrapping = 'Wrap'
  $videosLink.Visibility = 'Collapsed'
  $videosLink.ToolTip = 'Records in the background at low priority. Your work comes first, so it takes longer while you use the machine.'
  Set-Click $videosLink {
    param($Data, $Sender)
    $videos = $script:courseVideos
    if (-not $videos -or @($videos.wanted).Count -eq 0 -or [int]$videos.waiting -gt 0) { return }
    $setup = if ($videos.voice.needsSetup) { ", plus a $([int]$videos.voice.setupMb) MB one-time download" } else { '' }
    $prompt = "About $(Format-VideoTime ([int]$videos.estimate.recordingMinutes)) and $([int]$videos.estimate.mb) MB$setup. Click to start"
    if (-not (Test-ArmedHere $Sender "videos:$($script:courseId)" $prompt)) { return }
    Invoke-Helper 'video.queue' @{ courseId = $script:courseId } {
      param($Result, $Context)
      $script:courseVideos = $Result
      Show-CourseVideos
      Update-PageVideo
      Show-Toast 'Making the videos in the background, at low priority. You can keep working.'
    }
  }
  [void]$contentsTop.Children.Add($videosLink)
  [void]$contentsTop.Children.Add($hideLink)
  [System.Windows.Controls.DockPanel]::SetDock($contentsTop, 'Top')
  $pageList = New-Object System.Windows.Controls.StackPanel
  [void]$contents.Children.Add($contentsTop)
  # The pages' scrollbar lane comes out of the column, not out of the 16 before the page: the bar
  # stays clear of the page's text, and the title and its line above keep the column's width.
  $pageScroll = New-RowScroll $pageList 6
  $pageScroll.Margin = New-Gap -6 0 -6 0
  [void]$contents.Children.Add($pageScroll)
  [System.Windows.Controls.Grid]::SetColumn($contents, 0)

  # Page: capped to a reading width (in ems, so it follows the text size) and centred in its
  # column on a wide window.
  $pageArea = New-Object System.Windows.Controls.Grid
  $pageArea.MaxWidth = (Get-TextSize) * $READING_EMS
  [System.Windows.Controls.Grid]::SetColumn($pageArea, 1)
  $pagePanel = New-Object System.Windows.Controls.DockPanel
  $pageTop = New-Object System.Windows.Controls.StackPanel
  $pageTop.Margin = New-Gap 0 0 0 6
  [System.Windows.Controls.DockPanel]::SetDock($pageTop, 'Top')
  # PAGE x OF y, and on its right what you already know (always reachable) and, while the
  # contents are hidden, the way back to them.
  $countRow = New-Object System.Windows.Controls.DockPanel
  $countRow.MinHeight = 20
  $pageCount = New-Label '' 11 $faint
  $pageCount.Margin = New-Gap 0 0 0 0
  $pageCount.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($pageCount, 'Left')
  # BEING REWRITTEN, a fixed gap after it (not spaces).
  $pageState = New-Label '' 11 $gold
  $pageState.Margin = New-Gap 7 0 0 0
  $pageState.VerticalAlignment = 'Center'
  $pageState.Visibility = 'Collapsed'
  [System.Windows.Controls.DockPanel]::SetDock($pageState, 'Left')
  $showContents = New-Pressable 'show contents' $null $faint
  $showContents.FontSize = 11.5
  $showContents.VerticalAlignment = 'Center'
  $showContents.Visibility = 'Collapsed'
  [System.Windows.Controls.DockPanel]::SetDock($showContents, 'Right')
  $overlapLink = New-Pressable 'What I already know' $null $blue
  $overlapLink.FontSize = 11.5
  $overlapLink.VerticalAlignment = 'Center'
  $overlapLink.Margin = New-Gap 8 0 -4 0
  $overlapLink.ToolTip = 'What this course covers that you have met before, and pages you could skip'
  [System.Windows.Controls.DockPanel]::SetDock($overlapLink, 'Right')
  [void]$countRow.Children.Add($pageCount)
  [void]$countRow.Children.Add($pageState)
  [void]$countRow.Children.Add($overlapLink)
  [void]$countRow.Children.Add($showContents)
  [void]$countRow.Children.Add((New-Object System.Windows.Controls.Border))
  $pageTitle = New-Text '' $ink
  $pageTitle.FontSize = 22
  $pageTitle.FontWeight = 'SemiBold'
  $pageTitle.TextWrapping = 'Wrap'
  $pageTitle.Margin = New-Gap 0 2 0 4
  $sourceLine = New-Object System.Windows.Controls.WrapPanel
  $sourceLine.Margin = New-Gap -4 0 0 0
  $conceptChips = New-Object System.Windows.Controls.WrapPanel
  $conceptChips.Margin = New-Gap 0 6 0 0
  [void]$pageTop.Children.Add($countRow)
  [void]$pageTop.Children.Add($pageTitle)
  [void]$pageTop.Children.Add($sourceLine)
  [void]$pageTop.Children.Add($conceptChips)
  # Previous on the left, Next on the right, and Skip in the middle of the page, however wide
  # the other two are: three columns, the outer two of equal share. Their text sits on the page's
  # edges (the links' own padding hangs past them).
  $nav = New-Object System.Windows.Controls.Grid
  $nav.Margin = New-Gap -4 8 -4 0
  $nav.ColumnDefinitions.Add((New-Column '*'))
  $nav.ColumnDefinitions.Add((New-Column 'auto'))
  $nav.ColumnDefinitions.Add((New-Column '*'))
  [System.Windows.Controls.DockPanel]::SetDock($nav, 'Bottom')
  $prevLink = New-Pressable "$GLYPH_LEFT Previous" $null $dim
  $prevLink.ToolTip = 'The page before  (Left arrow)'
  $prevLink.HorizontalAlignment = 'Left'
  $nextLink = New-Pressable "Next $GLYPH_RIGHT" $null $accent
  $nextLink.ToolTip = 'The next page  (Right arrow)'
  $nextLink.HorizontalAlignment = 'Right'
  $skipLink = New-Pressable 'Skip this page' $null $dim
  $skipLink.ToolTip = 'Leave it out of the course; Next steps over it'
  [System.Windows.Controls.Grid]::SetColumn($skipLink, 1)
  [System.Windows.Controls.Grid]::SetColumn($nextLink, 2)
  [void]$nav.Children.Add($prevLink)
  [void]$nav.Children.Add($skipLink)
  [void]$nav.Children.Add($nextLink)
  $reader = New-Reader
  [void]$pagePanel.Children.Add($pageTop)
  [void]$pagePanel.Children.Add($nav)
  [void]$pagePanel.Children.Add($reader)
  [void]$pageArea.Children.Add($pagePanel)

  # The overlap screen is a step of its own in the page's place (the page is collapsed while it
  # shows), drawn on the card itself, with its heading where the page's title is. A list of rows
  # like the others: its text on the page's own edges (so the way back ends where 'What I already
  # know' does), its scrollbar in the gap before the chat.
  $overlap = New-Object System.Windows.Controls.Border
  $overlap.Background = $noFill
  $overlap.Visibility = 'Collapsed'
  $overlapStack = New-Object System.Windows.Controls.StackPanel
  $overlap.Child = New-RowScroll $overlapStack 6
  [void]$pageArea.Children.Add($overlap)

  # Chat
  $chat = New-Object System.Windows.Controls.Border
  $chat.BorderBrush = $line
  $chat.BorderThickness = New-Object System.Windows.Thickness(1, 0, 0, 0)
  $chat.Padding = New-Gap 16 0 0 0
  $chat.Margin = New-Gap 16 0 0 0
  [System.Windows.Controls.Grid]::SetColumn($chat, 2)
  $chatInner = New-Object System.Windows.Controls.DockPanel
  $chat.Child = $chatInner
  $chatHead = New-Object System.Windows.Controls.DockPanel
  $chatHead.Margin = New-Gap 0 0 0 6
  $chatHead.MinHeight = 20
  [System.Windows.Controls.DockPanel]::SetDock($chatHead, 'Top')
  $newThread = New-Pressable 'new thread' $null $faint
  $newThread.FontSize = 11.5
  $newThread.Margin = New-Gap 0 0 -4 0
  $newThread.VerticalAlignment = 'Center'
  $newThread.ToolTip = "Start this page's chat again"
  [System.Windows.Controls.DockPanel]::SetDock($newThread, 'Right')
  $chatTitle = New-Text 'Ask about this page' $ink
  $chatTitle.FontWeight = 'SemiBold'
  $chatTitle.VerticalAlignment = 'Center'
  [void]$chatHead.Children.Add($newThread)
  [void]$chatHead.Children.Add($chatTitle)
  $chatBottom = New-Object System.Windows.Controls.DockPanel
  $chatBottom.Margin = New-Gap 0 8 0 0
  [System.Windows.Controls.DockPanel]::SetDock($chatBottom, 'Bottom')
  $sendButton = New-Button 'Send' 'primary'
  $sendButton.VerticalAlignment = 'Bottom'
  $sendButton.Margin = New-Gap 6 0 0 0
  $sendButton.ToolTip = 'Send  (Enter; Shift+Enter for a new line)'
  [System.Windows.Controls.DockPanel]::SetDock($sendButton, 'Right')
  $chatInput = New-InputBox 'Ask, or answer a closing question' $true
  $chatInput.box.Height = 64
  [void]$chatBottom.Children.Add($sendButton)
  [void]$chatBottom.Children.Add($chatInput.holder)
  # The messages' text on the column's edge, like the title and the box; your own message's fill
  # hangs into the gap (Add-MessageSection).
  $chatReader = New-Reader
  $chatReader.Margin = New-Gap (-$MESSAGE_INSET - 2) 0 0 0
  [void]$chatInner.Children.Add($chatHead)
  [void]$chatInner.Children.Add($chatBottom)
  [void]$chatInner.Children.Add($chatReader)

  [void]$grid.Children.Add($contents)
  [void]$grid.Children.Add($pageArea)
  [void]$grid.Children.Add($chat)
  $script:viewHosts['course'].Child = $grid

  $script:ui.courseGrid = $grid
  $grid.Add_SizeChanged({ param($sender, $e) try { Update-CourseColumns } catch { Write-Failure $_ } })
  $script:ui.contents = $contents
  $script:ui.courseTitle = $courseTitle
  $script:ui.courseMeta = $courseMeta
  $script:ui.courseGap = $courseGap
  $script:ui.updateLink = $updateLink
  $script:ui.videosLink = $videosLink
  $script:ui.overlapLink = $overlapLink
  $script:ui.pageList = $pageList
  $script:ui.pageCount = $pageCount
  $script:ui.pageState = $pageState
  $script:ui.pageArea = $pageArea
  $script:ui.showContents = $showContents
  $script:ui.pageTitle = $pageTitle
  $script:ui.sourceLine = $sourceLine
  $script:ui.conceptChips = $conceptChips
  $script:ui.reader = $reader
  $script:ui.prev = $prevLink
  $script:ui.next = $nextLink
  $script:ui.skip = $skipLink
  $script:ui.overlap = $overlap
  $script:ui.pagePanel = $pagePanel
  $script:ui.overlapStack = $overlapStack
  $script:ui.chatReader = $chatReader
  $script:ui.chatInput = $chatInput.box
  $script:ui.send = $sendButton
  Set-ChatInputSize $chatInput.box

  Set-Click $prevLink { param($Data, $Sender) Step-Page -1 }
  Set-Click $nextLink { param($Data, $Sender) Step-Page 1 }
  Set-Click $skipLink { param($Data, $Sender) Switch-Skip }
  Set-Click $overlapLink { param($Data, $Sender) Open-Overlap $true }
  Set-Click $hideLink { param($Data, $Sender) Set-ContentsShown $false }
  Set-Click $showContents { param($Data, $Sender) Set-ContentsShown $true }
  Set-Click $newThread { param($Data, $Sender) Reset-Chat (Get-PageKey) @{ courseId = $script:courseId; n = $script:pageNumber } $script:ui.chatReader }
  Set-Click $sendButton { param($Data, $Sender) Submit-PageChat }
  $chatInput.box.Add_PreviewKeyDown({
    param($sender, $e)
    try {
      $shift = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Shift) -ne 0
      if ($e.Key -eq 'Return' -and -not $shift) { $e.Handled = $true; Submit-PageChat }
    } catch { Write-Failure $_ }
  })
  Set-ContentsShown $script:showContents
}

# The contents and the chat at their own widths, unless that leaves the page narrower than
# $PAGE_MIN_WIDTH: then the chat, and after it the contents, give up some of theirs.
function Get-CourseColumns([double]$Total, [bool]$WithContents) {
  $contents = if ($WithContents) { [double]$CONTENTS_WIDTH } else { 0.0 }
  $chat = [double]$CHAT_WIDTH
  if ($Total -gt 0) {
    $short = [double]$PAGE_MIN_WIDTH - ($Total - $contents - $chat)
    if ($short -gt 0) {
      $give = [Math]::Min($short, $chat - [double]$CHAT_MIN_WIDTH)
      $chat -= $give
      $short -= $give
    }
    if ($short -gt 0 -and $contents -gt 0) { $contents -= [Math]::Min($short, $contents - [double]$CONTENTS_MIN_WIDTH) }
  }
  return @{ contents = $contents; chat = $chat }
}

function Update-CourseColumns {
  $grid = $script:ui.courseGrid
  if (-not $grid) { return }
  $widths = Get-CourseColumns ([double]$grid.ActualWidth) ([bool]$script:showContents)
  if ($grid.ColumnDefinitions[0].Width.Value -ne $widths.contents) { $grid.ColumnDefinitions[0].Width = New-Object System.Windows.GridLength($widths.contents) }
  if ($grid.ColumnDefinitions[2].Width.Value -ne $widths.chat) { $grid.ColumnDefinitions[2].Width = New-Object System.Windows.GridLength($widths.chat) }
}

function Set-ContentsShown([bool]$Shown) {
  $script:showContents = $Shown
  $script:ui.contents.Visibility = if ($Shown) { 'Visible' } else { 'Collapsed' }
  Update-CourseColumns
  $script:ui.showContents.Visibility = if ($Shown) { 'Collapsed' } else { 'Visible' }
  Save-Prefs
}

function Get-PageKey { return "$($script:courseId):$($script:pageNumber)" }

function Open-Course([string]$Id, $Page) {
  if (-not $Id) { Show-View 'library'; return }
  $sameCourse = $script:courseData -and [string]$script:courseData.course.id -eq $Id
  $script:courseId = $Id
  if ($script:view -ne 'course' -or $tabTexts['course'].Visibility -ne 'Visible') {
    Set-ViewShown 'course'
    Save-Prefs
  }
  $script:lastCourseAt = [DateTime]::UtcNow
  Invoke-Helper 'course.get' @{ id = $Id } {
    param($Result, $Context)
    $script:courseData = $Result
    Show-Contents
    $course = $Result.course
    $target = 0
    if ($Context.page) { $target = [int]$Context.page }
    elseif ($Context.same -and $script:pageNumber -gt 0) { $target = $script:pageNumber }
    elseif ($course.progress -and $course.progress.page) { $target = [int]$course.progress.page }
    else {
      $skipped = @($course.skipped)
      foreach ($page in @($course.pages)) { if ($skipped -notcontains [int]$page.n) { $target = [int]$page.n; break } }
      if ($target -eq 0) { $target = 1 }
    }
    if (-not $Context.same -or $script:pageNumber -ne $target) { Open-Page $target }
    $isFresh = $course.overlap -and -not $course.overlap.seen
    if ($isFresh -or $SnapshotView -eq 'overlap') { Open-Overlap $false }
  } @{ page = $Page; same = $sameCourse } {
    param($Message, $Context)
    Show-Toast $Message 'error'
    $script:courseId = $null
    Show-View 'library'
  }
}

function Show-Contents {
  $course = $script:courseData.course
  $script:ui.courseTitle.Text = [string]$course.title
  $pages = @($course.pages)
  $read = @($course.read)
  $skipped = @($course.skipped)
  $learned = 0
  $total = 0
  foreach ($property in $script:courseData.concepts.PSObject.Properties) {
    $total++
    if ([string]$property.Value.state -eq 'learned') { $learned++ }
  }
  $metaParts = @("$($pages.Count) pages", "$($read.Count) read", "$learned/$total concepts learned")
  if ([string]$course.status -ne 'ready') {
    $written = @($pages | Where-Object { [string]$_.status -eq 'written' }).Count
    $metaParts += "being written: $written/$($pages.Count)"
  }
  $script:ui.courseMeta.Text = $metaParts -join "  $GLYPH_DOT  "
  $gaps = @($course.notCovered | Where-Object { $_ })
  $script:ui.courseGap.Text = if ($gaps.Count -gt 0) { "Not covered: $($gaps -join ', ')" } else { '' }
  $script:ui.courseGap.Visibility = if ($gaps.Count -gt 0) { 'Visible' } else { 'Collapsed' }
  # A course from before terms and quick checks.
  $script:ui.updateLink.Visibility = if ($null -eq $course.terms -and [string]$course.status -eq 'ready') { 'Visible' } else { 'Collapsed' }
  if ($script:videosFor -ne $script:courseId) { Update-CourseVideos }
  $list = $script:ui.pageList
  $list.Children.Clear()
  $position = 0
  $lastPart = ''
  foreach ($page in $pages) {
    $position++
    $n = [int]$page.n
    # A part's name above its first page.
    $part = [string]$page.part
    if ($part -and $part -ne $lastPart) {
      $partHead = New-Text $part $dim
      $partHead.FontSize = 11.5
      $partHead.FontWeight = 'SemiBold'
      $partHead.TextWrapping = 'Wrap'
      $partHead.Margin = New-Gap 0 $(if ($position -eq 1) { 0 } else { 12 }) 0 3
      [void]$list.Children.Add($partHead)
    }
    $lastPart = $part
    $row = New-Object System.Windows.Controls.DockPanel
    $outer = New-Object System.Windows.Controls.StackPanel
    [void]$outer.Children.Add($row)
    # Text on the column's edge, the hover and current-page fill 6 past it (New-RowScroll).
    $border = New-Object System.Windows.Controls.Border
    $border.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
    $border.Padding = New-Gap 6 4 6 5
    $border.Margin = New-Gap -6 1 -6 1
    $border.Child = $outer
    Set-Hover $border
    if ($n -eq $script:pageNumber) { $border.Background = $selected }
    $isSkipped = $skipped -contains $n
    $isRead = $read -contains $n
    $isWritten = [string]$page.status -eq 'written'
    $mark = if (-not $isWritten) { $GLYPH_PENDING } elseif ($isSkipped) { $GLYPH_SKIP } elseif ($isRead) { $GLYPH_FULL } else { $GLYPH_EMPTY }
    $markFore = if (-not $isWritten -or $isSkipped) { $faint } elseif ($isRead) { $green } else { $dim }
    $glyph = New-Text $mark $markFore
    $glyph.Width = $PAGE_GLYPH_WIDTH
    $glyph.Margin = New-Gap 0 1 0 0
    $glyph.VerticalAlignment = 'Top'
    $glyph.ToolTip = if (-not $isWritten) { 'Not written yet' } elseif ($isSkipped) { 'Skipped' } elseif ($isRead) { 'Read' } else { 'Not read yet' }
    [System.Windows.Controls.DockPanel]::SetDock($glyph, 'Left')
    [void]$row.Children.Add($glyph)
    if ($script:renamingPage -eq $n) {
      [void]$row.Children.Add((New-InlineEdit 'Page title' ([string]$page.title) {
        param($Text, $Data)
        Invoke-Helper 'page.rename' @{ courseId = $script:courseId; n = $Data; title = $Text } { param($Result, $Context) $script:renamingPage = $null; Update-CoursePages $Result }
      } { param($Text, $Data) $script:renamingPage = $null; Show-Contents } $n))
    } else {
      $title = New-Text ("{0}. {1}" -f $position, [string]$page.title) $(if ($isSkipped -or -not $isWritten) { $faint } else { $ink })
      $title.TextWrapping = 'Wrap'
      $title.FontSize = 13
      [void]$row.Children.Add($title)
    }
    # Rename, reorder, rewrite and remove: under the page you're on, so the list stays tight, and
    # on one line in the narrowest contents (remove is the same mark as a concept's).
    # Lined up under the title: the glyph column's width, less the action's own padding.
    $actions = New-Object System.Windows.Controls.WrapPanel
    $actions.Margin = New-Gap ($PAGE_GLYPH_WIDTH - 4) 2 0 0
    $actionTips = @{ up = 'Move up'; down = 'Move down'; remove = 'Remove this page' }
    foreach ($action in @(@{ text = 'rename'; key = 'rename' }, @{ text = $GLYPH_UP; key = 'up' }, @{ text = $GLYPH_DOWN; key = 'down' }, @{ text = 'rewrite'; key = 'rewrite' }, @{ text = $GLYPH_CLOSE; key = 'remove' })) {
      $press = New-SmallAction $action.text { param($Data, $Sender) Invoke-PageAction $Data.key $Data.n $Sender } @{ key = $action.key; n = $n }
      if ($actionTips[$action.key]) { $press.ToolTip = $actionTips[$action.key] }
      [void]$actions.Children.Add($press)
    }
    [void]$outer.Children.Add($actions)
    $actions.Visibility = if ($n -eq $script:pageNumber -or $script:rewritingPage -eq $n -or $script:renamingPage -eq $n) { 'Visible' } else { 'Collapsed' }
    if ($script:rewritingPage -eq $n) {
      $rewrite = New-InlineEdit 'What should change? (optional) Enter rewrites' '' {
        param($Text, $Data)
        Invoke-Helper 'page.rewrite' @{ courseId = $script:courseId; n = $Data; note = $Text } {
          param($Result, $Context)
          $script:rewritingPage = $null
          Show-Toast 'Rewriting the page. It carries on if you close this window.'
          Refresh-Course
        }
      } { param($Text, $Data) $script:rewritingPage = $null; Show-Contents } $n -Multiline
      $rewrite.Margin = New-Gap $PAGE_GLYPH_WIDTH 4 0 2
      [void]$outer.Children.Add($rewrite)
    }
    Set-Click $border { param($Data, $Sender) if ($script:renamingPage -ne $Data -and $script:rewritingPage -ne $Data) { Open-Page $Data } } $n
    [void]$list.Children.Add($border)
  }

  # A page of your own: Claude plans it from the course's sources and writes it.
  if ($script:addingPage) {
    $add = New-InlineEdit 'What the new page is about (Enter adds it after this page)' '' {
      param($Text, $Data)
      if (-not $Text) { return }
      Invoke-Helper 'page.add' @{ courseId = $script:courseId; topic = $Text; after = $script:pageNumber } {
        param($Result, $Context)
        $script:addingPage = $false
        Show-Toast 'Writing your page. It carries on if you close this window.'
        Refresh-Course
      }
    } { param($Text, $Data) $script:addingPage = $false; Show-Contents } $null -Multiline
    $add.Margin = New-Gap 0 8 0 0
    [void]$list.Children.Add($add)
  } else {
    $addLink = New-Pressable '+ Add a page' $null $blue
    $addLink.FontSize = 12
    $addLink.HorizontalAlignment = 'Left'
    $addLink.Margin = New-Gap -4 8 0 0
    $addLink.ToolTip = 'Claude plans a page of your own from the course sources and writes it'
    Set-Click $addLink { param($Data, $Sender) $script:addingPage = $true; Show-Contents }
    [void]$list.Children.Add($addLink)
  }
}

# A page's place in the course (1-based); its `n` is only its id.
function Get-PagePosition([int]$N) {
  $pages = @($script:courseData.course.pages)
  for ($k = 0; $k -lt $pages.Count; $k++) { if ([int]$pages[$k].n -eq $N) { return $k + 1 } }
  return 0
}

function Update-CoursePages($Pages) {
  $script:courseData.course.pages = @($Pages)
  Show-Contents
  if ($script:pageData) { Show-PageHeader }
}

function Refresh-Course {
  $script:lastCourseAt = [DateTime]::UtcNow
  Invoke-Helper 'course.get' @{ id = $script:courseId } {
    param($Result, $Context)
    if ([string]$Result.course.id -ne $script:courseId) { return }
    $script:courseData = $Result
    Show-Contents
    if ($script:pageData) { Show-PageHeader }
  }
}

function Invoke-PageAction([string]$Key, [int]$N, $Sender = $null) {
  switch ($Key) {
    'rename' { $script:renamingPage = $N; $script:rewritingPage = $null; Show-Contents }
    'rewrite' { $script:rewritingPage = $N; $script:renamingPage = $null; Show-Contents }
    { $_ -eq 'up' -or $_ -eq 'down' } {
      $delta = if ($Key -eq 'up') { -1 } else { 1 }
      Invoke-Helper 'page.move' @{ courseId = $script:courseId; n = $N; delta = $delta } { param($Result, $Context) Update-CoursePages $Result }
    }
    'remove' {
      if (-not (Test-ArmedHere $Sender "page:$($script:courseId):$N")) { return }
      Invoke-Helper 'page.remove' @{ courseId = $script:courseId; n = $N } {
        param($Result, $Context)
        $script:courseData.course = $Result
        $script:chats.Remove("$($script:courseId):$Context")
        Show-Toast 'Page removed. Its concepts stay in your Learned list.'
        if ($script:pageNumber -eq $Context) {
          $first = @($Result.pages) | Select-Object -First 1
          Open-Page ([int]$first.n)
        } else { Show-Contents; Show-PageHeader }
      } $N
    }
  }
}

function Save-Progress {
  if ($SnapshotPath -or -not $script:courseId -or $script:pageNumber -le 0) { return }
  $scroll = Get-ReaderScroll $script:ui.reader
  if (-not $scroll) { return }
  $ratio = if ($scroll.ScrollableHeight -gt 0) { [double]$scroll.VerticalOffset / [double]$scroll.ScrollableHeight } else { 0.0 }
  if ([Math]::Abs($ratio - $script:scrollSaved) -lt 0.005) { return }
  $script:scrollSaved = $ratio
  Invoke-Helper 'progress.set' @{ courseId = $script:courseId; n = $script:pageNumber; scroll = [Math]::Round($ratio, 4) }
}

function Open-Page([int]$N) {
  if (-not $script:courseData) { return }
  Save-Progress
  $script:pageNumber = $N
  $script:scrollSaved = -1.0
  Show-Contents
  Close-Overlays
  Invoke-Helper 'page.get' @{ courseId = $script:courseId; n = $N } {
    param($Result, $Context)
    if ($Context -ne $script:pageNumber) { return }
    $script:pageData = $Result
    Show-Page
    # Reading it marked it read: the contents and the Library counts move.
    $course = $script:courseData.course
    if (@($course.read) -notcontains $Context -and $Result.page) { $course.read = @(@($course.read) + $Context) }
    Show-Contents
  } $N
}

function Step-Page([int]$Delta) {
  if (-not $script:courseData) { return }
  $pages = @($script:courseData.course.pages)
  $skipped = @($script:courseData.course.skipped)
  $index = (Get-PagePosition $script:pageNumber) - 1 + $Delta
  while ($index -ge 0 -and $index -lt $pages.Count -and $skipped -contains [int]$pages[$index].n) { $index += $Delta }
  if ($index -lt 0 -or $index -ge $pages.Count) {
    if ($Delta -gt 0) { Show-Toast 'That was the last page.' }
    return
  }
  Open-Page ([int]$pages[$index].n)
}

function Switch-Skip {
  $n = $script:pageNumber
  $isSkipped = @($script:courseData.course.skipped) -contains $n
  Invoke-Helper 'page.skip' @{ courseId = $script:courseId; n = $n; skip = (-not $isSkipped) } {
    param($Result, $Context)
    $script:courseData.course.skipped = @($Result)
    Show-Contents
    $script:ui.skip.Text = if (@($Result) -contains $script:pageNumber) { 'Skipped: undo' } else { 'Skip this page' }
    if (@($Result) -contains $script:pageNumber) { Step-Page 1 }
  }
}

function Get-ConceptGlyph([string]$State) {
  switch ($State) { 'learned' { return $GLYPH_CHECK } 'seen' { return $GLYPH_HALF } default { return $GLYPH_EMPTY } }
}

# The page's number, title and arrows: by its place in the course.
function Show-PageHeader {
  $size = Get-TextSize
  $total = @($script:courseData.course.pages).Count
  $position = Get-PagePosition $script:pageNumber
  $pageInfo = @($script:courseData.course.pages) | Where-Object { [int]$_.n -eq $script:pageNumber } | Select-Object -First 1
  $rewriting = $pageInfo -and [string]$pageInfo.status -ne 'written' -and $script:pageData -and $script:pageData.page
  $script:ui.pageCount.Text = "PAGE $position OF $total"
  $script:ui.pageState.Text = "$GLYPH_DOT BEING REWRITTEN"
  $script:ui.pageState.Visibility = if ($rewriting) { 'Visible' } else { 'Collapsed' }
  $script:ui.pageTitle.Text = if ($pageInfo) { [string]$pageInfo.title } else { '' }
  $script:ui.pageTitle.FontSize = $size * 1.55
  $script:ui.skip.Text = if (@($script:courseData.course.skipped) -contains $script:pageNumber) { 'Skipped: undo' } else { 'Skip this page' }
  $script:ui.prev.Visibility = if ($position -gt 1) { 'Visible' } else { 'Hidden' }
  $script:ui.next.Visibility = if ($position -lt $total) { 'Visible' } else { 'Hidden' }
  $script:shownPageStatus = if ($pageInfo) { [string]$pageInfo.status } else { '' }
}

function Show-Page {
  $result = $script:pageData
  $size = Get-TextSize
  Show-PageHeader
  $script:ui.sourceLine.Children.Clear()
  $script:ui.conceptChips.Children.Clear()
  $doc = New-Document $size
  if (-not $result.page) {
    $wait = New-Paragraph $size $dim
    [void]$wait.Inlines.Add((New-Object System.Windows.Documents.Run('This page is still being written. The build carries on in the background; it shows here when it is done.')))
    [void]$doc.Blocks.Add($wait)
    $script:ui.reader.Document = $doc
    Show-Chat (Get-PageKey) @() $script:ui.chatReader
    return
  }
  $page = $result.page

  # Where it comes from: the video at its time, or the page's sections.
  $source = $page.source
  $sources = @(@{ url = [string]$source.url; title = [string]$source.title; kind = [string]$source.kind; from = $source.fromSec; to = $source.toSec; videoId = [string]$source.videoId })
  foreach ($item in @($page.support)) { if ($item.url) { $sources += @{ url = [string]$item.url; title = [string]$item.title; kind = $(if ([string]$item.url -match 'youtu') { 'youtube' } else { 'web' }); from = $item.fromSec; to = $item.toSec; videoId = '' } } }
  # A document: its stored copy opens in this computer's own app for it; a chat brief has nothing to open.
  if ([string]$source.kind -eq 'doc' -or [string]$source.kind -eq 'chat') {
    $sources = @()
    $isDoc = [string]$source.kind -eq 'doc'
    $label = if ($isDoc) { "$GLYPH_DOC $(Get-Short ([string]$source.title) 70)" } else { "$GLYPH_CHAT From your chat: $(Get-Short ([string]$source.title) 60)" }
    $press = if ($isDoc -and $source.file) { New-Pressable $label $null $blue } else { New-Text $label $dim }
    $press.FontSize = 12
    $press.Margin = New-Gap 0 0 10 0
    $press.TextTrimming = 'CharacterEllipsis'
    if ($isDoc -and $source.file) {
      $local = "\\wsl.localhost\$DISTRO" + ([string]$source.file).Replace('/', '\')
      $press.ToolTip = "Open $([string]$source.fileName)"
      Set-Click $press {
        param($Data, $Sender)
        if (Test-Path -LiteralPath $Data) { [void][System.Diagnostics.Process]::Start($Data) } else { Show-Toast 'The document is no longer in the library' }
      } $local
    }
    [void]$script:ui.sourceLine.Children.Add($press)
  }
  foreach ($item in $sources) {
    $isVideo = $item.kind -eq 'youtube'
    $label = if ($isVideo -and $null -ne $item.from) { "$GLYPH_PLAY Watch {0}-{1}" -f (Format-Clock $item.from), (Format-Clock $item.to) } elseif ($isVideo) { "$GLYPH_PLAY Watch" } else { "$GLYPH_LINK Read" }
    $url = $item.url
    if ($isVideo -and $null -ne $item.from -and [int]$item.from -gt 0) { $url = if ($url.Contains('?')) { "$url&t=$([int]$item.from)s" } else { "$url?t=$([int]$item.from)s" } }
    $press = New-Pressable ("{0}: {1}" -f $label, (Get-Short $item.title 70)) $null $blue
    $press.FontSize = 12
    $press.Margin = New-Gap 0 0 10 0
    $press.TextTrimming = 'CharacterEllipsis'
    $press.ToolTip = $item.url
    Set-Click $press { param($Data, $Sender) Open-Link $Data } $url
    [void]$script:ui.sourceLine.Children.Add($press)
  }

  foreach ($concept in @($result.concepts)) { [void]$script:ui.conceptChips.Children.Add((New-ConceptChip $concept)) }

  $script:pageGlossary = @($result.glossary)
  $script:drawCheck = { param($Block, $Size) New-PageCheck $Block $Size }
  Add-VideoRow $doc $result.video $size
  Add-PageIntro $doc $page $size
  Add-Blocks $doc.Blocks $page.blocks $size
  $script:drawCheck = $null
  Add-ClosingQuestions $doc $page $size
  $script:ui.reader.Document = $doc
  $progress = $result.progress
  if ($progress -and [int]$progress.page -eq $script:pageNumber -and [double]$progress.scroll -gt 0) {
    $script:pendingScroll = @{ ratio = [double]$progress.scroll; tries = 0 }
  } else {
    $script:pendingScroll = @{ ratio = 0.0; tries = 0 }
  }
  Show-Chat (Get-PageKey) @($result.chat.messages) $script:ui.chatReader
}

# What the page sets out to do, and the words to have before you start.
# The page's video, above its text. This window has no web engine, so a video opens in a window
# of its own beside this one.
function Add-VideoRow($Doc, $Video, [double]$Size) {
  $script:pageVideo = $Video
  $script:videoPanel = $null
  if (-not $Video) { return }
  $script:videoPanel = New-Object System.Windows.Controls.WrapPanel
  $holder = New-Object System.Windows.Documents.BlockUIContainer($script:videoPanel)
  $holder.Margin = New-Gap 0 0 0 ($Size * 0.6)
  [void]$Doc.Blocks.Add($holder)
  Show-VideoRow
}

function Open-PageVideo {
  $course = [string]$script:courseId
  if ($course -notmatch '^[\w.-]{1,160}$') { return }
  Open-InBrowser 'learn/video' "--course $course --page $([int]$script:pageNumber)" -AppWindow
}

function Add-VideoLink([string]$Text, [scriptblock]$Action) {
  $press = New-Pressable $Text $null $blue
  $press.Margin = New-Gap 0 0 10 0
  Set-Click $press $Action
  [void]$script:videoPanel.Children.Add($press)
}

function Add-VideoNote([string]$Text) {
  $note = New-Text $Text $dim
  $note.Padding = New-Gap 4 2 10 2
  $note.TextWrapping = 'Wrap'
  [void]$script:videoPanel.Children.Add($note)
}

function Show-VideoRow {
  $video = $script:pageVideo
  if (-not $script:videoPanel -or -not $video) { return }
  $script:videoPanel.Children.Clear()
  $state = [string]$video.state
  $minutes = if ($video.minutes) { " $GLYPH_DOT $([Math]::Round([double]$video.minutes)) min" } else { '' }
  $watch = "$GLYPH_PLAY Watch this page$minutes"
  $make = {
    param($Data, $Sender)
    $video = $script:pageVideo
    $setup = if ($video.voice.needsSetup) { ", plus a $([int]$video.voice.setupMb) MB one-time download" } else { '' }
    if (-not (Test-ArmedHere $Sender "video:$($script:courseId):$($script:pageNumber)" "About $([int]$video.estimate.recordingMinutes) min to make$setup. Click to start")) { return }
    Invoke-Helper 'video.queue' @{ courseId = $script:courseId; n = [int]$script:pageNumber } {
      param($Result, $Context)
      Show-Toast 'Making the video in the background. You can keep working.'
      Update-PageVideo
    }
  }
  if ($video.voice.reason -and $state -ne 'ready') { Add-VideoNote ([string]$video.voice.reason); return }
  switch ($state) {
    'ready' { Add-VideoLink $watch { Open-PageVideo } }
    'stale' {
      Add-VideoLink $watch { Open-PageVideo }
      Add-VideoNote 'This page changed since the video was made.'
      Add-VideoLink 'Update the video' $make
    }
    'making' { Add-VideoNote "Making this video: $(if ($video.message) { [string]$video.message } else { 'starting' })" }
    'queued' { Add-VideoNote 'Waiting for its turn to be made' }
    'old' {
      Add-VideoLink 'Update this course first' {
        param($Data, $Sender)
        if (-not (Test-ArmedHere $Sender "update:$($script:courseId)" 'Build it again? click to confirm')) { return }
        Invoke-Helper 'course.refresh' @{ id = $script:courseId } {
          param($Result, $Context)
          Show-Toast 'Building the new version. This one stays until you remove it.'
          Show-View 'library'
        }
      }
      $script:videoPanel.Children[0].ToolTip = "A video asks this page's quick questions, and this older page has none."
    }
    default { Add-VideoLink 'Make a video of this page' $make }
  }
}

function Format-VideoTime([int]$Minutes) {
  if ($Minutes -lt 60) { return "$Minutes min" }
  return "$([Math]::Round($Minutes / 60.0, 1)) hours"
}

function Update-CourseVideos {
  $script:videosFor = $script:courseId
  Invoke-Helper 'video.course' @{ courseId = $script:courseId } {
    param($Result, $Context)
    if ($Context -ne $script:courseId) { return }
    $script:courseVideos = $Result
    Show-CourseVideos
  } $script:courseId
}

# In Contents: how the course's videos stand, and the press that makes the rest. Nothing shows
# where this machine can't record, or where every page needs the course updated first.
function Show-CourseVideos {
  $videos = $script:courseVideos
  $link = $script:ui.videosLink
  if (-not $videos -or $videos.voice.reason -or [int]$videos.old -ge [int]$videos.total) { $link.Visibility = 'Collapsed'; return }
  $link.Visibility = 'Visible'
  $left = @($videos.wanted).Count
  if ([int]$videos.waiting -gt 0) {
    $link.Text = "Making videos: $([int]$videos.ready) of $([int]$videos.total) ready"
    $link.Foreground = $dim
  } elseif ($left -gt 0) {
    $link.Text = "Make videos ($left $(if ($left -eq 1) { 'page' } else { 'pages' }))"
    $link.Foreground = $blue
  } else {
    $link.Text = "All $([int]$videos.total) videos ready"
    $link.Foreground = $dim
  }
}

function Update-PageVideo {
  if (-not $script:pageData -or -not $script:videoPanel) { return }
  Invoke-Helper 'video.page' @{ courseId = $script:courseId; n = [int]$script:pageNumber } {
    param($Result, $Context)
    if (-not $Result -or $Context -ne $script:pageNumber) { return }
    $script:pageVideo = $Result
    Show-VideoRow
  } $script:pageNumber
}

function Add-PageIntro($Doc, $Page, [double]$Size) {
  $outcomes = @($Page.outcomes | Where-Object { $_ })
  $terms = @($Page.terms | Where-Object { $_.key } | Select-Object -First 6)
  if ($outcomes.Count -eq 0 -and $terms.Count -eq 0) { return }
  $section = New-Object System.Windows.Documents.Section
  $section.BorderBrush = $line
  $section.BorderThickness = New-Object System.Windows.Thickness(1)
  $section.Padding = New-Gap 14 10 14 4
  $section.Margin = New-Gap 0 0 0 ($Size * 1.1)
  $add = {
    param($Title)
    $head = New-Paragraph ($Size * 0.84) $accent
    $head.FontWeight = 'SemiBold'
    $head.Margin = New-Gap 0 0 0 3
    [void]$head.Inlines.Add((New-Object System.Windows.Documents.Run($Title)))
    [void]$section.Blocks.Add($head)
  }
  if ($outcomes.Count -gt 0) {
    & $add "You'll be able to"
    foreach ($outcome in $outcomes) {
      $item = New-Paragraph ($Size * 0.95) $ink
      $item.Margin = New-Gap 0 0 0 ($Size * 0.25)
      [void]$item.Inlines.Add((New-Object System.Windows.Documents.Run("$GLYPH_DOT $([string]$outcome)")))
      [void]$section.Blocks.Add($item)
    }
  }
  if ($terms.Count -gt 0) {
    & $add 'Key terms'
    foreach ($term in $terms) {
      $item = New-Paragraph ($Size * 0.95) $dim
      $item.Margin = New-Gap 0 0 0 ($Size * 0.3)
      $name = New-Object System.Windows.Documents.Run([string]$term.term)
      $name.FontWeight = 'SemiBold'
      $name.Foreground = $ink
      [void]$item.Inlines.Add($name)
      [void]$item.Inlines.Add((New-Object System.Windows.Documents.Run("  $([string]$term.def)")))
      [void]$section.Blocks.Add($item)
    }
  }
  [void]$Doc.Blocks.Add($section)
}

# The real test of a page: answered in the chat, and what opens a concept's lock.
function Add-ClosingQuestions($Doc, $Page, [double]$Size) {
  $checks = @($Page.checks | Where-Object { $_ })
  if ($checks.Count -eq 0) { return }
  $rule = New-Object System.Windows.Controls.Border
  $rule.Height = 1
  $rule.Background = $line
  $ruleHolder = New-Object System.Windows.Documents.BlockUIContainer($rule)
  $ruleHolder.Margin = New-Gap 0 8 0 12
  [void]$Doc.Blocks.Add($ruleHolder)
  $heading = New-Paragraph ($Size * 1.2) $accent
  $heading.FontWeight = 'SemiBold'
  $heading.Tag = 'closing questions'
  [void]$heading.Inlines.Add((New-Object System.Windows.Documents.Run('Closing questions')))
  [void]$Doc.Blocks.Add($heading)
  $hint = New-Paragraph ($Size * 0.9) $dim
  [void]$hint.Inlines.Add((New-Object System.Windows.Documents.Run('Answer in the chat, in your own words. Passing one lets you mark its concepts as learned.')))
  [void]$Doc.Blocks.Add($hint)
  $concepts = @{}
  foreach ($concept in @($script:pageData.concepts)) { if ($concept) { $concepts[[string]$concept.id] = $concept } }
  for ($k = 0; $k -lt $checks.Count; $k++) {
    $check = $checks[$k]
    $question = New-Paragraph $Size $ink
    $question.Margin = New-Gap 0 0 0 2
    [void]$question.Inlines.Add((New-Object System.Windows.Documents.Run(("{0}. {1}  " -f ($k + 1), [string]$check.q))))
    $answer = New-Object System.Windows.Documents.Hyperlink((New-Object System.Windows.Documents.Run("answer $GLYPH_RIGHT")))
    $answer.Foreground = $blue
    $answer.TextDecorations = $null
    $answer.Cursor = [System.Windows.Input.Cursors]::Hand
    $answer.Tag = "Question $($k + 1): $([string]$check.q)`nMy answer: "
    $answer.Add_Click({
      param($sender, $e)
      try {
        Set-InputText $script:ui.chatInput ([string]$sender.Tag)
        [void]$script:ui.chatInput.Focus()
      } catch { Write-Failure $_ }
    })
    [void]$question.Inlines.Add($answer)
    [void]$Doc.Blocks.Add($question)
    $unlocks = @(@($check.concepts) | ForEach-Object { $concepts[[string]$_] } | Where-Object { $_ })
    $done = $unlocks.Count -gt 0 -and @($unlocks | Where-Object { $_.passed -or [string]$_.state -eq 'learned' }).Count -eq $unlocks.Count
    $meta = New-Paragraph ($Size * 0.86) $(if ($done) { $green } else { $dim })
    $meta.Margin = New-Gap 0 0 0 ($Size * 0.7)
    if ($check.section) {
      $from = New-Object System.Windows.Documents.Hyperlink((New-Object System.Windows.Documents.Run("From: $([string]$check.section)")))
      $from.Foreground = $faint
      $from.TextDecorations = $null
      $from.Cursor = [System.Windows.Input.Cursors]::Hand
      $from.Tag = [string]$check.section
      Add-LinkHover $from
      $from.Add_Click({ param($sender, $e) try { Show-PageSection ([string]$sender.Tag) } catch { Write-Failure $_ } })
      [void]$meta.Inlines.Add($from)
      [void]$meta.Inlines.Add((New-Object System.Windows.Documents.Run('    ')))
    }
    if ($unlocks.Count -gt 0) {
      $names = @($unlocks | ForEach-Object { [string]$_.name }) -join ', '
      [void]$meta.Inlines.Add((New-Object System.Windows.Documents.Run($(if ($done) { "$GLYPH_CHECK Passed: $names" } else { "Unlocks: $names" }))))
    }
    [void]$Doc.Blocks.Add($meta)
  }
}

# Scrolls the page to a heading, or to the closing questions.
function Show-PageSection([string]$Name) {
  $wanted = $Name.Trim().ToLowerInvariant()
  foreach ($block in $script:ui.reader.Document.Blocks) {
    if ([string]$block.Tag -eq $wanted) {
      $block.BringIntoView()
      return
    }
  }
}

function New-PageCheck($Block, [double]$Size) {
  $chosen = $null
  $answers = $script:pageData.answers
  if ($answers) {
    $saved = $answers.PSObject.Properties[[string]$Block.id]
    if ($saved) { $chosen = [int]$saved.Value }
  }
  $hooks = @{
    onAnswer = {
      param($State, $Choice)
      if ($script:pageData.answers) { $script:pageData.answers | Add-Member -Force -NotePropertyName ([string]$State.block.id) -NotePropertyValue $Choice }
      Invoke-Helper 'check.answer' @{ courseId = $script:courseId; n = $script:pageNumber; id = [string]$State.block.id; choice = $Choice }
    }
    onWrong = {
      param($State)
      Invoke-Helper 'check.flag' @{ key = "$($script:courseId)/$($script:pageNumber)/$([string]$State.block.id)" } {
        param($Result, $Context)
        [void]$Context.holder.SiblingBlocks.Remove($Context.holder)
        Show-Toast 'Removed from this page and from Review'
      } $State
    }
  }
  $state = New-QuickCheck $Block $Size $chosen '' $hooks
  $state.holder = New-Object System.Windows.Documents.BlockUIContainer($state.box)
  $state.holder.Margin = New-Gap 0 ($Size * 0.3) 0 ($Size * 1.1)
  return $state.holder
}

function Format-Clock($Seconds) {
  if ($null -eq $Seconds) { return '' }
  $total = [int]$Seconds
  $h = [int][Math]::Floor($total / 3600)
  $m = [int][Math]::Floor(($total % 3600) / 60)
  $s = $total % 60
  if ($h -gt 0) { return ('{0}:{1:00}:{2:00}' -f $h, $m, $s) }
  return ('{0}:{1:00}' -f $m, $s)
}

function New-ConceptChip($Concept) {
  $state = [string]$Concept.state
  $fill = if ($state -eq 'learned') { $greenSoft } else { $null }
  $chip = New-Chip ("{0} {1}" -f (Get-ConceptGlyph $state), [string]$Concept.name) $null ($state -eq 'learned') $fill
  $open = $state -eq 'learned' -or [bool]$Concept.passed
  if (-not $open) { Set-ChipBorder $chip $faint; $chip.Child.Foreground = $dim }
  elseif ($state -ne 'learned') { Set-ChipBorder $chip $green }
  $tip = [string]$Concept.definition
  $tip += if ($state -eq 'learned') { "`n`nLearned. Click to unmark." } elseif ($open) { "`n`nYou passed its closing question. Click to mark it learned." } else { "`n`nLocked: answer its closing question to mark it learned." }
  if ($Concept.recall) { $tip += "`nRecalled after $([int]$Concept.recall) $(if ([int]$Concept.recall -eq 1) { 'day' } else { 'days' })." }
  $chip.ToolTip = $tip.Trim()
  Set-Click $chip {
    param($Data, $Sender)
    if ([string]$Data.state -eq 'learned' -or $Data.passed) {
      Set-ConceptLearned ([string]$Data.id) ([string]$Data.state -ne 'learned')
    } else {
      Show-PageSection 'closing questions'
      Show-Toast 'Answer its closing question to unlock it'
    }
  } $Concept
  return $chip
}

# The person's own tick: the only way anything becomes Learned.
function Set-ConceptLearned([string]$Id, [bool]$Learned) {
  Invoke-Helper 'concept.learn' @{ id = $Id; learned = $Learned; courseId = $script:courseId; n = $script:pageNumber } {
    param($Result, $Context)
    if ($script:pageData) {
      foreach ($concept in @($script:pageData.concepts)) { if ([string]$concept.id -eq [string]$Result.id) { $concept.state = [string]$Result.state } }
      $script:ui.conceptChips.Children.Clear()
      foreach ($concept in @($script:pageData.concepts)) { [void]$script:ui.conceptChips.Children.Add((New-ConceptChip $concept)) }
    }
    if ($script:courseData) {
      $entry = $script:courseData.concepts.PSObject.Properties[[string]$Result.id]
      if ($entry) { $entry.Value.state = [string]$Result.state }
      Show-Contents
    }
    Show-Toast $(if ([string]$Result.state -eq 'learned') { "Learned: $($Result.name)" } else { "Not marked learned: $($Result.name)" })
  }
}

# --- The overlap screen -------------------------------------------------------------------------

function Open-Overlap([bool]$Always) {
  Invoke-Helper 'overlap.get' @{ courseId = $script:courseId } {
    param($Result, $Context)
    $known = @($Result.covered).Count + @($Result.partly).Count + @($Result.mentioned).Count
    if ($known -eq 0 -and -not $Context) {
      # Nothing here you have met before: no screen, just remember it was checked.
      Invoke-Helper 'overlap.apply' @{ courseId = $script:courseId; skip = @() }
      return
    }
    Show-Overlap $Result
  } $Always
}

$script:overlapPicks = @{}
function Show-Overlap($Data) {
  $stack = $script:ui.overlapStack
  $stack.Children.Clear()
  $script:overlapData = $Data
  $titles = $Data.courseTitles
  # The course you are in is 'here', not its title again on every line.
  $courseTitle = { param($Id) if ([string]$Id -eq [string]$script:courseId) { 'here' } else { $entry = $titles.PSObject.Properties[[string]$Id]; if ($entry) { [string]$entry.Value } else { 'an earlier course' } } }
  # The same top as the page: a caption line where PAGE x OF y is, then the heading where the
  # page's title is, at the same size.
  $captionRow = New-Object System.Windows.Controls.DockPanel
  $captionRow.MinHeight = 20
  $caption = New-Label 'What you already know' 11 $faint
  $caption.Margin = New-Gap 0 0 0 0
  $caption.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($caption, 'Left')
  # Where the page has "What I already know", the way back to it.
  $backLink = New-Pressable "$GLYPH_LEFT Back to the page" $null $blue
  $backLink.FontSize = 11.5
  $backLink.VerticalAlignment = 'Center'
  $backLink.Margin = New-Gap 8 0 -4 0
  $backLink.ToolTip = 'Nothing is skipped  (Esc)'
  [System.Windows.Controls.DockPanel]::SetDock($backLink, 'Right')
  Set-Click $backLink { param($Data, $Sender) Set-OverlapShown $false }
  [void]$captionRow.Children.Add($caption)
  [void]$captionRow.Children.Add($backLink)
  [void]$captionRow.Children.Add((New-Object System.Windows.Controls.Border))
  [void]$stack.Children.Add($captionRow)
  $heading = New-Text 'Before you start' $ink
  $heading.FontSize = (Get-TextSize) * 1.55
  $heading.FontWeight = 'SemiBold'
  $heading.TextWrapping = 'Wrap'
  $heading.Margin = New-Gap 0 2 0 4
  [void]$stack.Children.Add($heading)
  $intro = New-Text 'What this course covers that you have met before. Nothing is skipped unless you tick it.' $dim
  $intro.TextWrapping = 'Wrap'
  $intro.Margin = New-Gap 0 0 0 4
  [void]$stack.Children.Add($intro)
  # Each line: the page it is on first, then what you know of it ('page 1 . learned here, 27 Oct').
  if (@($Data.covered).Count -gt 0) {
    [void]$stack.Children.Add((New-CountLabel 'Already learned' ([string]@($Data.covered).Count) $green))
    foreach ($item in @($Data.covered)) {
      $when = 'learned'
      if ($item.learned) {
        $date = Format-ShortDate ([string]$item.learned.at)
        $place = if ($item.learned.course) { & $courseTitle $item.learned.course } else { '' }
        $when = if ($place -eq 'here') { "learned here, $date" } elseif ($place) { "learned $date in $place" } else { "learned $date" }
      }
      [void]$stack.Children.Add((New-OverlapLine "$GLYPH_CHECK $($item.name)" (Join-OverlapDetail (Get-OverlapPages $item.pages) $when) $green))
    }
  }
  if (@($Data.partly).Count -gt 0) {
    [void]$stack.Children.Add((New-CountLabel 'Partly covered' ([string]@($Data.partly).Count) $blue))
    foreach ($item in @($Data.partly)) {
      [void]$stack.Children.Add((New-OverlapLine "$GLYPH_HALF $($item.name)" (Join-OverlapDetail (Get-OverlapPages $item.pages) "you have $($item.have.name); this goes further") $blue))
    }
  }
  if (@($Data.mentioned).Count -gt 0) {
    [void]$stack.Children.Add((New-CountLabel 'Read before, not marked learned' ([string]@($Data.mentioned).Count) $dim))
    foreach ($item in @($Data.mentioned)) {
      $where = @($item.seen | ForEach-Object { & $courseTitle $_.course } | Select-Object -Unique) -join ', '
      $read = if ($where -eq 'here') { 'read here' } else { "read in $where" }
      [void]$stack.Children.Add((New-OverlapLine "$GLYPH_EMPTY $($item.name)" (Join-OverlapDetail (Get-OverlapPages $item.pages) $read) $dim))
    }
  }
  $fresh = @($Data.fresh)
  if ($fresh.Count -gt 0) {
    [void]$stack.Children.Add((New-CountLabel 'New to you' ([string]$fresh.Count) $accent))
    $names = New-Text (($fresh | ForEach-Object { [string]$_.name }) -join "  $GLYPH_DOT  ") $ink
    $names.TextWrapping = 'Wrap'
    [void]$stack.Children.Add($names)
  }

  $skippable = @($Data.skippablePages)
  $script:overlapPicks = @{}
  if ($skippable.Count -gt 0) {
    [void]$stack.Children.Add((New-Label 'Pages you could skip (everything on them is learned)' 11 $faint))
    $script:ui.skipList = New-Object System.Windows.Controls.StackPanel
    [void]$stack.Children.Add($script:ui.skipList)
    Show-SkipPicks
  }
  $buttons = New-Object System.Windows.Controls.StackPanel
  $buttons.Orientation = 'Horizontal'
  $buttons.Margin = New-Gap 0 16 0 8
  $start = New-Button 'Start the course' 'primary'
  $start.ToolTip = 'Skip the pages you ticked and start reading'
  Set-Click $start {
    param($Data, $Sender)
    $skip = @($script:overlapPicks.Keys | ForEach-Object { [int]$_ })
    Invoke-Helper 'overlap.apply' @{ courseId = $script:courseId; skip = $skip } {
      param($Result, $Context)
      Set-OverlapShown $false
      $script:courseData.course.skipped = @($Result)
      Show-Contents
      if (@($Result) -contains $script:pageNumber) { Step-Page 1 }
    }
  }
  [void]$buttons.Children.Add($start)
  $later = New-Pressable 'close' $null $dim
  $later.Margin = New-Gap 12 0 0 0
  $later.VerticalAlignment = 'Center'
  $later.ToolTip = 'Back to the page; nothing is skipped  (Esc)'
  Set-Click $later { param($Data, $Sender) Set-OverlapShown $false }
  [void]$buttons.Children.Add($later)
  [void]$stack.Children.Add($buttons)
  Set-OverlapShown $true
}

# The overlap screen takes the page's place while it is up: the page is collapsed, not covered.
function Set-OverlapShown([bool]$Shown) {
  $script:ui.overlap.Visibility = if ($Shown) { 'Visible' } else { 'Collapsed' }
  $script:ui.pagePanel.Visibility = if ($Shown) { 'Collapsed' } else { 'Visible' }
}

# Where a concept is in this course: 'page 4' or 'pages 2, 14', the number never on a line of its own.
function Get-OverlapPages($Pages) {
  $list = @(@($Pages) | Where-Object { $null -ne $_ -and [string]$_ -ne '' } | ForEach-Object { [string]$_ })
  if ($list.Count -eq 0) { return '' }
  if ($list.Count -eq 1) { return 'page' + $GLYPH_NBSP + $list[0] }
  return 'pages' + $GLYPH_NBSP + ($list -join ', ')
}

# The page, a dot, then the rest: no-break spaces round the dot, so it never ends a line.
function Join-OverlapDetail([string]$Where, [string]$Rest) {
  if (-not $Where) { return $Rest }
  if (-not $Rest) { return $Where }
  return $Where + $GLYPH_NBSP + $GLYPH_DOT + $GLYPH_NBSP + $Rest
}

function New-OverlapLine([string]$Name, [string]$Detail, $Fore) {
  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Margin = New-Gap 0 2 0 4
  $nameText = New-Text $Name $Fore
  $nameText.FontSize = 14
  $nameText.TextWrapping = 'Wrap'
  $detailText = New-Text $Detail $dim
  $detailText.FontSize = 11.5
  $detailText.TextWrapping = 'Wrap'
  $detailText.Margin = New-Gap 16 0 0 0
  [void]$panel.Children.Add($nameText)
  [void]$panel.Children.Add($detailText)
  return $panel
}

# The pages you could skip, each a row with a tick box in a fixed place (as in the source picker),
# its fill reaching 6 past the text like the other lists' rows.
function Show-SkipPicks {
  $list = $script:ui.skipList
  $list.Children.Clear()
  foreach ($n in @($script:overlapData.skippablePages)) {
    $page = @($script:courseData.course.pages) | Where-Object { [int]$_.n -eq [int]$n } | Select-Object -First 1
    $ticked = $script:overlapPicks.ContainsKey([string]$n)
    $itemBox = New-Object System.Windows.Controls.Border
    $itemBox.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
    $itemBox.Padding = New-Gap 6 4 6 4
    $itemBox.Margin = New-Gap -6 1 -6 1
    Set-Hover $itemBox
    $item = New-Object System.Windows.Controls.DockPanel
    $tick = New-Tick $ticked
    $tick.Margin = New-Gap 0 1 10 0
    [System.Windows.Controls.DockPanel]::SetDock($tick, 'Left')
    $text = New-Text ("{0}. {1}" -f (Get-PagePosition ([int]$n)), $(if ($page) { [string]$page.title } else { '' })) $ink
    $text.TextWrapping = 'Wrap'
    [void]$item.Children.Add($tick)
    [void]$item.Children.Add($text)
    $itemBox.Child = $item
    Set-Click $itemBox {
      param($Data, $Sender)
      if ($script:overlapPicks.ContainsKey($Data)) { $script:overlapPicks.Remove($Data) } else { $script:overlapPicks[$Data] = $true }
      Show-SkipPicks
    } ([string]$n)
    [void]$list.Children.Add($itemBox)
  }
}

function Close-Overlays {
  if ($script:ui.overlap) { Set-OverlapShown $false }
  $changed = $script:renamingConcept -or $script:movingConcept -or $script:mergeFrom -or $script:nestFrom -or $script:editingDefinition
  $script:renamingConcept = $null
  $script:movingConcept = $null
  $script:mergeFrom = $null
  $script:nestFrom = $null
  $script:editingDefinition = $null
  if ($changed -and $script:view -eq 'learned' -and $script:concepts) { Show-Learned }
}

# --- Chats (a page's and the Advisor's) --------------------------------------------------------------

function Get-ChatState([string]$Key) {
  if (-not $script:chats.ContainsKey($Key)) {
    $script:chats[$Key] = @{ doc = (New-Document ((Get-TextSize) * 0.93)); messages = @(); busy = $false; live = $null; tool = $null; liveSection = $null; fields = $null }
  }
  return $script:chats[$Key]
}

# A message in a chat. Yours is a rounded box; Claude's has the same inset with no fill, so
# both start on one left edge, and the reader is pulled left by that inset (and the document's
# own 2), so the text lines up with the chat's title and box while your box hangs past them.
# Your text is selectable, as Claude's is.
function Add-MessageSection($Doc, $Message, [string]$Key) {
  $size = (Get-TextSize) * 0.93
  if ([string]$Message.role -eq 'user') {
    $bubble = New-Object System.Windows.Controls.Border
    $bubble.Background = $surface2
    $bubble.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
    $bubble.Padding = New-Gap $MESSAGE_INSET 6 $MESSAGE_INSET 8
    $inside = New-Object System.Windows.Controls.StackPanel
    $whoText = New-Text 'YOU' $dim
    $whoText.FontFamily = $monoFont
    $whoText.FontSize = $size * 0.8
    $whoText.Margin = New-Gap 0 0 0 2
    $saidText = ([string]$Message.text).Replace("`r", '')
    $said = New-SelectableText $saidText $ink $size
    [void]$inside.Children.Add($whoText)
    [void]$inside.Children.Add($said)
    $bubble.Child = $inside
    $holder = New-Object System.Windows.Documents.BlockUIContainer($bubble)
    $holder.Margin = New-Gap 0 0 0 10
    [void]$Doc.Blocks.Add($holder)
    return $holder
  }
  $section = New-Object System.Windows.Documents.Section
  $section.Margin = New-Gap 0 0 0 10
  $section.Padding = New-Gap $MESSAGE_INSET 0 $MESSAGE_INSET 0
  $who = New-Paragraph ($size * 0.8) $blue
  $who.Margin = New-Gap 0 0 0 2
  $who.FontFamily = $monoFont
  [void]$who.Inlines.Add((New-Object System.Windows.Documents.Run('CLAUDE')))
  [void]$section.Blocks.Add($who)
  if ($Message.blocks) { Add-Blocks $section.Blocks $Message.blocks $size }
  else {
    $text = New-Paragraph $size $ink
    [void]$text.Inlines.Add((New-Object System.Windows.Documents.Run([string]$Message.text)))
    [void]$section.Blocks.Add($text)
  }
  $offers = @($Message.offers)
  if ($offers.Count -gt 0 -and -not (Test-AdvisorKey $Key)) { [void]$section.Blocks.Add((New-OfferButton $offers)) }
  $builds = @($Message.builds | Where-Object { $_ })
  foreach ($build in $builds) { [void]$section.Blocks.Add((New-BuildButton $build)) }
  if ($builds.Count -gt 1) { [void]$section.Blocks.Add((New-BuildAllButton $builds)) }
  [void]$Doc.Blocks.Add($section)
  return $section
}

function Get-ConceptName([string]$Id) {
  if ($script:pageData) { foreach ($concept in @($script:pageData.concepts)) { if ([string]$concept.id -eq $Id) { return [string]$concept.name } } }
  if ($script:courseData) {
    $entry = $script:courseData.concepts.PSObject.Properties[$Id]
    if ($entry) { return [string]$entry.Value.name }
  }
  return $Id
}

function Test-AllLearned($Ids) {
  if (-not $script:pageData) { return $false }
  foreach ($id in $Ids) {
    $found = $false
    foreach ($concept in @($script:pageData.concepts)) { if ([string]$concept.id -eq [string]$id -and [string]$concept.state -eq 'learned') { $found = $true } }
    if (-not $found) { return $false }
  }
  return $true
}

# "Mark learned" after a correct answer: nothing is marked until the person clicks it. The
# label stays short ("Mark 2 learned"); the names are in the tooltip.
function New-OfferButton($Ids) {
  $list = @($Ids | ForEach-Object { Get-ConceptName ([string]$_) })
  $names = $list -join ', '
  if (Test-AllLearned $Ids) {
    $button = New-DocButton "$GLYPH_CHECK Learned" $noFill $green $null
    Set-DocButtonLearned $button
  } else {
    $label = if ($list.Count -eq 1) { "Mark learned: $(Get-Short $list[0] 32)" } else { "Mark $($list.Count) learned" }
    $button = New-DocButton $label $green $onAccent {
      param($Data, $Sender)
      foreach ($id in $Data) { Set-ConceptLearned ([string]$id) $true }
      Set-DocButtonLearned $Sender
    } @($Ids)
  }
  $button.ToolTip = if ($list.Count -eq 1) { "Marks '$names' as learned" } else { "Marks these as learned: $names" }
  return (New-DocBlock $button 4 4)
}

# A course the Advisor suggests: a quiet button with the topic trimmed (the whole of it, and its
# category, in the tooltip). Once clicked it is a plain blue line that opens the Library.
function New-BuildButton($Build, [string]$Label = '') {
  $topic = [string]$Build.topic
  $category = [string]$Build.category
  $text = if ($Label) { $Label } else { "Build: {0}" -f (Get-Short $topic 48) }
  $button = New-DocButton $text $buttonFill $ink {
    param($Data, $Sender)
    Start-Build ([string]$Data.topic) ([string]$Data.category) 'auto'
    Set-DocButtonDone $Sender ("Building {0} follow it in the Library {1}" -f $GLYPH_DOT, $GLYPH_RIGHT) $noFill
    $Sender.Content.Foreground = $blue
    $Sender.Padding = New-Gap 0 5 0 6
    # A click now goes to the Library, where the build shows.
    $Sender.Cursor = [System.Windows.Input.Cursors]::Hand
    $Sender.ToolTip = "Building '$([string]$Data.topic)': follow it in the Library"
    $Sender.Tag = @{ action = { param($Data2, $Sender2) Show-View 'library' }; data = $null }
  } @{ topic = $topic; category = $category }
  $button.Content.FontWeight = 'Normal'
  $button.ToolTip = if ($category) { "Build a course on '$topic' (in $category), straight away" } else { "Build a course on '$topic', straight away" }
  return (New-DocBlock $button 4 4)
}

# Several suggestions: everything in them, as one course.
function New-BuildAllButton($Builds) {
  $topics = @($Builds | ForEach-Object { [string]$_.topic }) -join '; '
  return (New-BuildButton @{ topic = $topics; category = [string]@($Builds)[0].category } 'Build all as one course')
}

function Show-Chat([string]$Key, $Messages, $Viewer) {
  $state = Get-ChatState $Key
  if (-not $state.busy) {
    $state.messages = @($Messages)
    $state.doc = New-Document ((Get-TextSize) * 0.93)
    if ($state.messages.Count -eq 0) {
      $empty = New-Paragraph ((Get-TextSize) * 0.9) $dim
      $empty.Padding = New-Gap $MESSAGE_INSET 0 $MESSAGE_INSET 0
      $emptyText = if (Test-AdvisorKey $Key) { 'Ask what to learn next. Claude looks at what you have learned and read, and at the work folders you set in Settings, to suggest what would help you most.' } else { 'Ask about anything on this page, or answer one of its closing questions. Claude knows the page and its sources.' }
      [void]$empty.Inlines.Add((New-Object System.Windows.Documents.Run($emptyText)))
      [void]$state.doc.Blocks.Add($empty)
    }
    foreach ($message in $state.messages) { [void](Add-MessageSection $state.doc $message $Key) }
  }
  $Viewer.Document = $state.doc
  $state.viewer = $Viewer
  Update-SendButton $Key
  Move-ChatToEnd $Key
}

function Move-ChatToEnd([string]$Key) {
  $state = Get-ChatState $Key
  if (-not $state.viewer -or $state.viewer.Document -ne $state.doc) { return }
  $scroll = Get-ReaderScroll $state.viewer
  if ($scroll) { $scroll.ScrollToEnd() }
}

function Update-SendButton([string]$Key) {
  $state = Get-ChatState $Key
  $button = if (Test-AdvisorKey $Key) { $script:ui.askSend } else { $script:ui.send }
  $shownKey = if (Test-AdvisorKey $Key) { Get-AdvisorKey } else { Get-PageKey }
  if ($Key -ne $shownKey) { return }
  if ($state.busy) { Set-ButtonText $button 'Stop'; Set-ButtonKind $button 'secondary' }
  else { Set-ButtonText $button 'Send'; Set-ButtonKind $button 'primary' }
}

function Submit-Chat([string]$Key, $Fields, $InputBox, $Viewer) {
  $state = Get-ChatState $Key
  if ($state.busy) {
    Invoke-Helper 'chat.stop' @{ key = $Key }
    return
  }
  $text = $InputBox.Text.Trim()
  if (-not $text) { return }
  $state.busy = $true
  $state.fields = $Fields
  if ($state.messages.Count -eq 0) { $state.doc.Blocks.Clear() }
  [void](Add-MessageSection $state.doc @{ role = 'user'; text = $text } $Key)
  $size = (Get-TextSize) * 0.93
  $live = New-Object System.Windows.Documents.Section
  $live.Margin = New-Gap 0 0 0 10
  $live.Padding = New-Gap $MESSAGE_INSET 0 $MESSAGE_INSET 0
  $who = New-Paragraph ($size * 0.8) $blue
  $who.FontFamily = $monoFont
  $who.Margin = New-Gap 0 0 0 2
  [void]$who.Inlines.Add((New-Object System.Windows.Documents.Run('CLAUDE')))
  $tool = New-Object System.Windows.Documents.Run('  thinking')
  $tool.Foreground = $faint
  [void]$who.Inlines.Add($tool)
  [void]$live.Blocks.Add($who)
  $body = New-Paragraph $size $ink
  $run = New-Object System.Windows.Documents.Run('')
  [void]$body.Inlines.Add($run)
  [void]$live.Blocks.Add($body)
  [void]$state.doc.Blocks.Add($live)
  $state.live = $run
  $state.tool = $tool
  $state.liveSection = $live
  $state.messages = @($state.messages) + @(@{ role = 'user'; text = $text })
  $InputBox.Text = ''
  Update-SendButton $Key
  Move-ChatToEnd $Key
  $request = @{ text = $text }
  foreach ($name in @($Fields.Keys)) { $request[$name] = $Fields[$name] }
  Invoke-Helper 'chat.send' $request $null $Key { param($Message, $Context) Stop-ChatWithError $Context $Message }
}

function Submit-PageChat {
  if (-not $script:pageData -or -not $script:pageData.page) { Show-Toast 'Open a written page first'; return }
  Submit-Chat (Get-PageKey) @{ courseId = $script:courseId; n = $script:pageNumber } $script:ui.chatInput $script:ui.chatReader
}

function Add-ChatDelta([string]$Key, [string]$Text) {
  if (-not $script:chats.ContainsKey($Key)) { return }
  $state = $script:chats[$Key]
  if (-not $state.live) { return }
  $state.live.Text = $state.live.Text + $Text
  if ($state.tool) { $state.tool.Text = '' }
  Move-ChatToEnd $Key
}

function Add-ChatTool([string]$Key, [string]$Text) {
  if (-not $script:chats.ContainsKey($Key)) { return }
  $state = $script:chats[$Key]
  if ($state.tool) { $state.tool.Text = "  $Text" }
}

function Complete-Chat([string]$Key, $Message) {
  if (-not $script:chats.ContainsKey($Key)) { return }
  $state = $script:chats[$Key]
  if ($state.liveSection) { [void]$state.doc.Blocks.Remove($state.liveSection) }
  $state.live = $null
  $state.tool = $null
  $state.liveSection = $null
  $state.busy = $false
  $state.messages = @($state.messages) + @($Message)
  [void](Add-MessageSection $state.doc $Message $Key)
  Update-SendButton $Key
  Move-ChatToEnd $Key
  if (Test-AdvisorKey $Key) { Update-AdvisorList }
  # Claude passed a closing question: its concepts open.
  $offers = @($Message.offers | Where-Object { $_ })
  if ($offers.Count -gt 0 -and $script:pageData -and $Key -eq (Get-PageKey)) {
    foreach ($concept in @($script:pageData.concepts)) { if ($offers -contains [string]$concept.id) { $concept.passed = $true } }
    $script:ui.conceptChips.Children.Clear()
    foreach ($concept in @($script:pageData.concepts)) { [void]$script:ui.conceptChips.Children.Add((New-ConceptChip $concept)) }
  }
}

function Stop-ChatWithError([string]$Key, [string]$Text) {
  if (-not $script:chats.ContainsKey($Key)) { return }
  $state = $script:chats[$Key]
  if ($state.live) {
    $state.live.Text = $(if ($state.live.Text) { $state.live.Text + "`n`n" } else { '' }) + $Text
    $state.live.Foreground = if ($Text -eq 'Stopped') { $dim } else { $red }
  }
  if ($state.tool) { $state.tool.Text = '' }
  $state.live = $null
  $state.tool = $null
  $state.liveSection = $null
  $state.busy = $false
  Update-SendButton $Key
}

function Reset-Chat([string]$Key, $Fields, $Viewer) {
  $state = Get-ChatState $Key
  if ($state.busy) { Show-Toast 'Wait for the answer, or stop it first'; return }
  Invoke-Helper 'chat.clear' $Fields {
    param($Result, $Context)
    Show-Chat $Context.key @() $Context.viewer
  } @{ key = $Key; viewer = $Viewer }
}

# ===================================================================================================
# Learned
# ===================================================================================================

# --- Review: quick checks coming back, one at a time ---------------------------------------------

$script:review = @{ items = @(); at = 0; right = 0; seen = 0; next = $null }

function Build-ReviewView {
  $root = New-Object System.Windows.Controls.StackPanel
  Set-ViewColumn $root
  $root.MaxWidth = 720
  $root.HorizontalAlignment = 'Left'
  $head = New-Object System.Windows.Controls.StackPanel
  $head.Orientation = 'Horizontal'
  $title = New-Text 'Review' $ink
  $title.FontSize = 20
  $title.FontWeight = 'SemiBold'
  $count = New-Text '' $dim
  $count.Margin = New-Gap 12 0 0 0
  $count.VerticalAlignment = 'Bottom'
  [void]$head.Children.Add($title)
  [void]$head.Children.Add($count)
  [void]$root.Children.Add($head)
  $body = New-Object System.Windows.Controls.StackPanel
  $body.Margin = New-Gap 0 14 0 0
  [void]$root.Children.Add($body)
  $scroll = New-Object System.Windows.Controls.ScrollViewer
  $scroll.VerticalScrollBarVisibility = 'Auto'
  $scroll.Content = $root
  $script:ui.reviewCount = $count
  $script:ui.reviewBody = $body
  $script:viewHosts['review'].Child = $scroll
}

function Update-Review {
  Invoke-Helper 'review.list' $null {
    param($Result, $Context)
    $script:review = @{ items = @($Result.items | Where-Object { $_ }); at = 0; right = 0; seen = 0; next = $Result.next }
    Show-Review
  }
}

function Set-ReviewCount([int]$Count) {
  $tabTexts['review'].Text = if ($Count -gt 0) { "Review $Count" } else { 'Review' }
}

function Add-ReviewLine([string]$Text, $Color) {
  $line2 = New-Text $Text $Color
  $line2.TextWrapping = 'Wrap'
  $line2.Margin = New-Gap 0 0 0 8
  [void]$script:ui.reviewBody.Children.Add($line2)
}

function Show-Review {
  $body = $script:ui.reviewBody
  $body.Children.Clear()
  $review = $script:review
  $items = @($review.items)
  Set-ReviewCount ([Math]::Max(0, $items.Count - $review.at))
  if ($review.at -ge $items.Count) {
    $script:ui.reviewCount.Text = ''
    if ($review.seen -gt 0) { Add-ReviewLine "$($review.right) of $($review.seen) right today." $ink }
    Add-ReviewLine $(if ($review.seen -gt 0) { 'That is enough for today.' } else { 'Nothing to review right now.' }) $dim
    $next = if ($review.next) { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$review.next).LocalDateTime.ToString('d MMM') } else { '' }
    Add-ReviewLine $(if ($next) { "The next one comes back on $next." } else { 'Quick checks you answer on a page come back here after a day, then after longer and longer gaps.' }) $dim
    return
  }
  $item = $items[$review.at]
  $script:ui.reviewCount.Text = "$($review.at + 1) of $($items.Count)"
  $foot = New-Object System.Windows.Controls.DockPanel
  $foot.Margin = New-Gap 0 10 0 0
  $go = New-Button $(if ($review.at + 1 -lt $items.Count) { 'Next' } else { 'Finish' }) 'primary'
  $go.Visibility = 'Hidden'
  [System.Windows.Controls.DockPanel]::SetDock($go, 'Right')
  Set-Click $go { param($Data, $Sender) $script:review.at++; Show-Review }
  [void]$foot.Children.Add($go)
  $from = New-Pressable ("{0} {1} {2}" -f (Get-Short ([string]$item.courseTitle) 40), $GLYPH_DOT, (Get-Short ([string]$item.pageTitle) 50)) $null $faint
  $from.FontSize = 12
  $from.VerticalAlignment = 'Center'
  $from.ToolTip = 'Open this page'
  Set-Click $from { param($Data, $Sender) Open-Course ([string]$Data.courseId) ([int]$Data.n) } $item
  [void]$foot.Children.Add($from)
  $hooks = @{
    go = $go
    item = $item
    onAnswer = {
      param($State, $Choice)
      Invoke-Helper 'review.answer' @{ key = [string]$State.hooks.item.key; choice = $Choice } {
        param($Result, $Context)
        $script:review.seen++
        if ($Result.right) { $script:review.right++ }
        $Context.Visibility = 'Visible'
      } $State.hooks.go
    }
    onWrong = {
      param($State)
      Invoke-Helper 'check.flag' @{ key = [string]$State.hooks.item.key } {
        param($Result, $Context)
        Show-Toast 'Removed from this page and from Review'
        $script:review.at++
        Show-Review
      }
    }
  }
  $state = New-QuickCheck $item.check (Get-TextSize) $null 'Remember this?' $hooks
  [void]$body.Children.Add($state.box)
  [void]$body.Children.Add($foot)
}

function Build-LearnedView {
  $root = New-Object System.Windows.Controls.DockPanel
  Set-ViewColumn $root
  $top = New-Object System.Windows.Controls.StackPanel
  [System.Windows.Controls.DockPanel]::SetDock($top, 'Top')

  $addRow = New-Object System.Windows.Controls.Grid
  $addRow.ColumnDefinitions.Add((New-Column '*'))
  $addRow.ColumnDefinitions.Add((New-Column 'auto'))
  $addBox = New-InputBox 'Add something you already know, e.g. "Git rebase" (Claude files it)'
  $addButton = New-Button 'Add as learned' 'good'
  $addButton.Margin = New-Gap 8 0 0 0
  $addButton.ToolTip = 'Claude files it under a category, marked learned (Enter)'
  [System.Windows.Controls.Grid]::SetColumn($addButton, 1)
  [void]$addRow.Children.Add($addBox.holder)
  [void]$addRow.Children.Add($addButton)
  [void]$top.Children.Add($addRow)

  # Filters, the tidy link and a new category, on one line of 30 (chips centred in it).
  $filters = New-Object System.Windows.Controls.WrapPanel
  $filters.Margin = New-Gap 0 8 0 0
  $script:ui.filterChips = @{}
  foreach ($filter in @(@{ key = 'all'; label = 'All' }, @{ key = 'learned'; label = "$GLYPH_CHECK Learned" }, @{ key = 'seen'; label = "$GLYPH_HALF Read" }, @{ key = 'new'; label = "$GLYPH_EMPTY New" })) {
    $chip = New-Chip $filter.label $null ($filter.key -eq 'all')
    $chip.Margin = New-Gap 0 4 6 4
    Set-Click $chip { param($Data, $Sender) $script:learnedFilter = $Data; foreach ($key in @($script:ui.filterChips.Keys)) { Set-ChipOn $script:ui.filterChips[$key] ($key -eq $Data) }; Show-Learned } $filter.key
    $script:ui.filterChips[$filter.key] = $chip
    [void]$filters.Children.Add($chip)
  }
  $tidyLink = New-Pressable 'Tidy concepts' $null $blue
  $tidyLink.ToolTip = 'Claude looks for concepts that are the same idea under two names, and suggests merges'
  $tidyLink.Margin = New-Gap 6 0 0 0
  $tidyLink.VerticalAlignment = 'Center'
  [void]$filters.Children.Add($tidyLink)
  $newCategory = New-InputBox 'New category'
  $newCategory.holder.Width = 170
  $newCategory.holder.Margin = New-Gap 12 0 0 0
  $newCategory.holder.VerticalAlignment = 'Center'
  $newCategory.holder.ToolTip = 'Type a name and press Enter'
  [void]$filters.Children.Add($newCategory.holder)
  [void]$top.Children.Add($filters)
  $search = New-InputBox 'Search concepts'
  $search.holder.Margin = New-Gap 0 8 0 4
  [void]$top.Children.Add($search.holder)
  $tidyPanel = New-Object System.Windows.Controls.StackPanel
  [void]$top.Children.Add($tidyPanel)
  $note = New-Text '' $gold
  $note.TextWrapping = 'Wrap'
  $note.Margin = New-Gap 0 8 0 0
  $note.Visibility = 'Collapsed'
  [void]$top.Children.Add($note)

  $list = New-Object System.Windows.Controls.StackPanel
  [void]$root.Children.Add($top)
  [void]$root.Children.Add((New-RowScroll $list 6))
  $script:viewHosts['learned'].Child = $root

  $script:ui.addConcept = $addBox.box
  $script:ui.conceptSearch = $search.box
  $script:ui.tidyPanel = $tidyPanel
  $script:ui.learnedNote = $note
  $script:ui.conceptList = $list

  Set-Click $addButton { param($Data, $Sender) Add-KnownConcept }
  $addBox.box.Add_KeyDown({ param($sender, $e) if ($e.Key -eq 'Return') { $e.Handled = $true; try { Add-KnownConcept } catch { Write-Failure $_ } } })
  $search.box.Add_TextChanged({ param($sender, $e) try { if ($script:concepts) { Show-Learned } } catch { Write-Failure $_ } })
  Set-Click $tidyLink { param($Data, $Sender) Start-Tidy }
  $newCategory.box.Add_KeyDown({
    param($sender, $e)
    if ($e.Key -ne 'Return' -or -not $sender.Text.Trim()) { return }
    $e.Handled = $true
    try { Invoke-Helper 'category.add' @{ name = $sender.Text.Trim() } { param($Result, $Context) Show-Toast "Category: $($Result.name)"; Update-Learned }; $sender.Text = '' } catch { Write-Failure $_ }
  })
}

function Update-Learned {
  Invoke-Helper 'concept.list' $null {
    param($Result, $Context)
    $script:concepts = $Result
    Show-Learned
  }
}

function Add-KnownConcept {
  $text = $script:ui.addConcept.Text.Trim()
  if (-not $text) { return }
  $category = if ($script:learnedCategory) { $script:learnedCategory } else { '' }
  Show-Toast "Filing: $text"
  Invoke-Helper 'concept.add' @{ text = $text; category = $category } {
    param($Result, $Context)
    Show-Toast "Learned: $($Result.name)"
    Update-Learned
  }
  $script:ui.addConcept.Text = ''
}

function Start-Tidy {
  $panel = $script:ui.tidyPanel
  $panel.Children.Clear()
  [void]$panel.Children.Add((New-Text 'Claude is reading your concepts for duplicates...' $dim))
  Invoke-Helper 'concept.tidy' $null {
    param($Result, $Context)
    $script:tidy = @($Result)
    Show-Tidy
  } $null {
    param($Message, $Context)
    $script:ui.tidyPanel.Children.Clear()
    Show-Toast $Message 'error'
  }
}

function Show-Tidy {
  $panel = $script:ui.tidyPanel
  $panel.Children.Clear()
  if (@($script:tidy).Count -eq 0) {
    [void]$panel.Children.Add((New-Text 'No duplicates found.' $green))
    return
  }
  [void]$panel.Children.Add((New-Label 'Same idea, two names?' 11 $blue))
  foreach ($merge in @($script:tidy)) {
    $row = New-Object System.Windows.Controls.DockPanel
    $row.Margin = New-Gap 0 2 0 4
    $actions = New-Object System.Windows.Controls.StackPanel
    $actions.Orientation = 'Horizontal'
    [System.Windows.Controls.DockPanel]::SetDock($actions, 'Right')
    $mergeLink = New-Pressable 'merge' $null $accent
    Set-Click $mergeLink {
      param($Data, $Sender)
      Invoke-Helper 'concept.merge' @{ keep = $Data.keep; drop = $Data.drop } {
        param($Result, $Context)
        $script:tidy = @($script:tidy | Where-Object { [string]$_.drop -ne $Context -and [string]$_.keep -ne $Context })
        Show-Tidy
        Update-Learned
      } $Data.drop
    } @{ keep = [string]$merge.keep; drop = [string]$merge.drop }
    $skipLink = New-Pressable 'not the same' $null $faint
    Set-Click $skipLink { param($Data, $Sender) $script:tidy = @($script:tidy | Where-Object { [string]$_.drop -ne $Data }); Show-Tidy } ([string]$merge.drop)
    [void]$actions.Children.Add($mergeLink)
    [void]$actions.Children.Add($skipLink)
    $text = New-Text ("'{0}' into '{1}': {2}" -f [string]$merge.dropName, [string]$merge.keepName, [string]$merge.reason) $ink
    $text.TextWrapping = 'Wrap'
    [void]$row.Children.Add($actions)
    [void]$row.Children.Add($text)
    [void]$panel.Children.Add($row)
  }
}

function Show-Learned {
  $list = $script:ui.conceptList
  $list.Children.Clear()
  $data = $script:concepts
  $all = @($data.concepts)
  $script:ui.learnedNote.Visibility = if ($script:mergeFrom -or $script:nestFrom) { 'Visible' } else { 'Collapsed' }
  $script:ui.learnedNote.Text = if ($script:mergeFrom) { "Merging '$(Get-LearnedName $script:mergeFrom)': click 'into' on the concept to keep. Esc cancels." } elseif ($script:nestFrom) { "Nesting '$(Get-LearnedName $script:nestFrom)': click 'under' on its new parent, or 'top level' on its own row. Esc cancels." } else { '' }
  if ($all.Count -eq 0) {
    $empty = New-Text 'No concepts yet. Each course adds the concepts it teaches here; you mark them learned on the page. You can also add what you already know above.' $dim
    $empty.TextWrapping = 'Wrap'
    $empty.MaxWidth = 640
    $empty.HorizontalAlignment = 'Left'
    [void]$list.Children.Add($empty)
    return
  }
  $query = $script:ui.conceptSearch.Text.Trim().ToLowerInvariant()
  $byId = @{}
  foreach ($concept in $all) { $byId[[string]$concept.id] = $concept }
  $matches2 = @{}
  foreach ($concept in $all) {
    $okState = $script:learnedFilter -eq 'all' -or [string]$concept.state -eq $script:learnedFilter
    $okText = -not $query -or ([string]$concept.name).ToLowerInvariant().Contains($query) -or ((@($concept.aliases) -join ' ').ToLowerInvariant().Contains($query))
    if ($okState -and $okText) { $matches2[[string]$concept.id] = $true }
  }
  foreach ($category in @($data.categories)) {
    $categoryId = [string]$category.id
    $inCategory = @($all | Where-Object { [string]$_.category -eq $categoryId })
    $shown = @($inCategory | Where-Object { $matches2.ContainsKey([string]$_.id) })
    if ($shown.Count -eq 0 -and ($query -or $script:learnedFilter -ne 'all')) { continue }
    $learnedCount = @($inCategory | Where-Object { [string]$_.state -eq 'learned' }).Count
    $header = New-CategoryHeader $categoryId ([string]$category.name) ("{0} learned of {1}" -f $learnedCount, $inCategory.Count) { Show-Learned } $data.categories
    $headText = $header.label
    if ($headText) {
      if ($script:learnedCategory -eq $categoryId) { $headText.TextDecorations = [System.Windows.TextDecorations]::Underline }
      $headText.ToolTip = 'Concepts you add go into the underlined category'
      Set-Click $headText { param($Data, $Sender) $script:learnedCategory = if ($script:learnedCategory -eq $Data) { '' } else { $Data }; Show-Learned } $categoryId
    }
    [void]$list.Children.Add($header.head)
    # A tree: each concept under its parent when the parent is in the same category.
    $inSet = @{}
    foreach ($concept in $inCategory) { $inSet[[string]$concept.id] = $true }
    $roots = @($inCategory | Where-Object { -not $_.parent -or -not $inSet.ContainsKey([string]$_.parent) } | Sort-Object { [string]$_.name })
    foreach ($concept in $roots) { Add-ConceptTree $list $concept $inCategory $matches2 0 }
  }
}

function Add-ConceptTree($List, $Concept, $InCategory, $Shown, [int]$Depth) {
  if ($Depth -gt 6) { return }
  if ($Shown.ContainsKey([string]$Concept.id)) { [void]$List.Children.Add((New-ConceptRow $Concept $Depth)) }
  $children = @($InCategory | Where-Object { [string]$_.parent -eq [string]$Concept.id } | Sort-Object { [string]$_.name })
  foreach ($child in $children) { Add-ConceptTree $List $child $InCategory $Shown ($Depth + 1) }
}

function Get-LearnedName([string]$Id) {
  foreach ($concept in @($script:concepts.concepts)) { if ([string]$concept.id -eq $Id) { return [string]$concept.name } }
  return $Id
}

function Get-CourseTitle([string]$Id) {
  if (-not $script:concepts -or -not $Id) { return 'a course' }
  $entry = $script:concepts.courseTitles.PSObject.Properties[$Id]
  if ($entry) { return [string]$entry.Value }
  return 'a removed course'
}

# A concept's 'where' on its row: the date it was learned (or how many courses it was read in),
# short, with the course in the tooltip, so the same course title is not on every row.
# Returns @{ text; tip } (both '' when there is nothing to say). $Now is for the self-test.
function Get-ConceptWhere($Concept, $Now = $null) {
  if ($Concept.learned) {
    $text = 'learned ' + (Format-ShortDate ([string]$Concept.learned.at) $Now)
    $recall = if ($Concept.recall) { "  $GLYPH_DOT  recalled after $([int]$Concept.recall) $(if ([int]$Concept.recall -eq 1) { 'day' } else { 'days' })" } else { '' }
    $tip = 'Learned ' + (Format-Date ([string]$Concept.learned.at))
    if ($Concept.learned.course) { $tip += ' in ' + (Get-CourseTitle ([string]$Concept.learned.course)) }
    return @{ text = $text.Trim() + $recall; tip = $tip.Trim() }
  }
  $courses = @(@($Concept.seen) | Where-Object { $_ } | ForEach-Object { [string]$_.course } | Select-Object -Unique)
  if ($courses.Count -gt 0) {
    $text = if ($courses.Count -eq 1) { 'read in 1 course' } else { "read in $($courses.Count) courses" }
    $tip = 'Read in ' + (@($courses | ForEach-Object { Get-CourseTitle $_ }) -join ', ')
    return @{ text = $text; tip = $tip }
  }
  return @{ text = ''; tip = '' }
}

function New-ConceptRow($Concept, [int]$Depth) {
  $id = [string]$Concept.id
  $state = [string]$Concept.state
  # Text on the column's edge (plus its depth), the hover fill 6 past it (New-RowScroll).
  $row = New-Object System.Windows.Controls.Border
  $row.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $row.Padding = New-Gap (6 + $Depth * 20) 4 6 5
  $row.Margin = New-Gap -6 1 -6 1
  Set-Hover $row
  $dock = New-Object System.Windows.Controls.DockPanel
  $row.Child = $dock
  $glyphFore = switch ($state) { 'learned' { $green } 'seen' { $blue } default { $faint } }
  $glyph = New-Text (Get-ConceptGlyph $state) $glyphFore
  $glyph.FontSize = 14
  $glyph.Width = $PAGE_GLYPH_WIDTH
  $glyph.VerticalAlignment = 'Top'
  $glyph.Cursor = [System.Windows.Input.Cursors]::Hand
  $glyph.ToolTip = if ($state -eq 'learned') { 'Learned: click to unmark' } elseif ($Concept.passed) { 'You passed its closing question: click to mark learned' } else { 'Locked: answer its closing question in its course, or type it above if you already know it' }
  Set-Click $glyph {
    param($Data, $Sender)
    Invoke-Helper 'concept.learn' @{ id = $Data.id; learned = ($Data.state -ne 'learned') } { param($Result, $Context) Update-Learned }
  } @{ id = $id; state = $state }
  [System.Windows.Controls.DockPanel]::SetDock($glyph, 'Left')
  [void]$dock.Children.Add($glyph)

  $actions = New-Object System.Windows.Controls.StackPanel
  $actions.Orientation = 'Horizontal'
  $actions.VerticalAlignment = 'Top'
  [System.Windows.Controls.DockPanel]::SetDock($actions, 'Right')
  $where = Get-ConceptWhere $Concept
  $keys = if ($script:mergeFrom -and $script:mergeFrom -ne $id) { @('into') }
    elseif ($script:nestFrom -and $script:nestFrom -ne $id) { @('under') }
    elseif ($script:nestFrom -eq $id) { @('top level', 'cancel') }
    else { @('rename', 'edit', 'nest', 'move', 'merge') }
  $isTarget = $keys[0] -eq 'into' -or $keys[0] -eq 'under' -or $keys[0] -eq 'top level'
  # The 'learned 27 Oct' line and the row's tools share one cell on the right, as wide as the
  # wider of the two whichever shows: the tools take its place while the pointer is on the row
  # (and always while picking a merge or nest target, or editing this one). Nothing beside it
  # changes width, so the row never re-wraps under the pointer.
  $cell = New-Object System.Windows.Controls.Grid
  $cell.Margin = New-Gap 12 0 0 0
  $whereText = $null
  if ($where.text) {
    $whereText = New-Text $where.text $faint
    $whereText.FontSize = 11.5
    $whereText.HorizontalAlignment = 'Right'
    $whereText.VerticalAlignment = 'Center'
    $whereText.Margin = New-Gap 0 0 4 0
    $whereText.ToolTip = $where.tip
    [void]$cell.Children.Add($whereText)
  }
  $tools = New-Object System.Windows.Controls.StackPanel
  $tools.Orientation = 'Horizontal'
  $tools.HorizontalAlignment = 'Right'
  $toolsShown = $isTarget -or $script:renamingConcept -eq $id -or $script:movingConcept -eq $id -or $script:editingDefinition -eq $id
  $tools.Visibility = if ($toolsShown) { 'Visible' } else { 'Hidden' }
  if ($toolsShown -and $whereText) { $whereText.Visibility = 'Hidden' }
  foreach ($key in $keys) {
    $press = New-SmallAction $key { param($Data, $Sender) Invoke-ConceptAction $Data.key $Data.id $Sender } @{ key = $key; id = $id } $(if ($isTarget -and $key -ne 'cancel') { $accent } else { $faint })
    [void]$tools.Children.Add($press)
  }
  [void]$cell.Children.Add($tools)
  [void]$actions.Children.Add($cell)
  if (-not $isTarget) {
    # Always there, so removing never depends on finding the hover actions.
    $removeMark = New-SmallAction $GLYPH_CLOSE { param($Data, $Sender) Invoke-ConceptAction 'remove' $Data $Sender } $id
    $removeMark.ToolTip = 'Remove this concept'
    $removeMark.Margin = New-Gap 4 0 0 0
    [void]$actions.Children.Add($removeMark)
  }
  if (-not $isTarget -and -not $toolsShown) {
    # Set-Hover owns the row's Tag-free hover fill; the tools ride in the row's Resources.
    $row.Resources['tools'] = $tools
    if ($whereText) { $row.Resources['where'] = $whereText }
    $row.Add_MouseEnter({ param($sender, $e) $sender.Resources['tools'].Visibility = 'Visible'; if ($sender.Resources['where']) { $sender.Resources['where'].Visibility = 'Hidden' } })
    $row.Add_MouseLeave({ param($sender, $e) $sender.Resources['tools'].Visibility = 'Hidden'; if ($sender.Resources['where']) { $sender.Resources['where'].Visibility = 'Visible' } })
  }
  [void]$dock.Children.Add($actions)

  $text = New-Object System.Windows.Controls.StackPanel
  if ($script:renamingConcept -eq $id) {
    [void]$text.Children.Add((New-InlineEdit 'Name' ([string]$Concept.name) {
      param($Text, $Data)
      Invoke-Helper 'concept.update' @{ id = $Data; name = $Text } { param($Result, $Context) $script:renamingConcept = $null; Update-Learned }
    } { param($Text, $Data) $script:renamingConcept = $null; Show-Learned } $id))
  } else {
    $name = New-Text ([string]$Concept.name) $(if ($state -eq 'new') { $dim } else { $ink })
    $name.FontSize = 14
    $name.TextWrapping = 'Wrap'
    [void]$text.Children.Add($name)
  }
  if ($script:editingDefinition -eq $id) {
    $definitionEdit = New-InlineEdit 'What it is, in one line' ([string]$Concept.definition) {
      param($Text, $Data)
      Invoke-Helper 'concept.update' @{ id = $Data; definition = $Text } { param($Result, $Context) $script:editingDefinition = $null; Update-Learned }
    } { param($Text, $Data) $script:editingDefinition = $null; Show-Learned } $id
    $definitionEdit.Margin = New-Gap 0 3 0 0
    [void]$text.Children.Add($definitionEdit)
  } elseif ($Concept.definition) {
    $definition = New-Text ([string]$Concept.definition) $dim
    $definition.FontSize = 11.5
    $definition.TextWrapping = 'Wrap'
    [void]$text.Children.Add($definition)
  }
  $also = @($Concept.alsoUsedIn)
  if ($also.Count -gt 0) {
    $alsoText = New-Text ("also used in " + (@($also | ForEach-Object { Get-CategoryName ([string]$_) }) -join ', ')) $faint
    $alsoText.FontSize = 11.5
    [void]$text.Children.Add($alsoText)
  }
  if ($script:movingConcept -eq $id) {
    $wrap = New-Object System.Windows.Controls.WrapPanel
    $wrap.Margin = New-Gap 0 4 0 0
    foreach ($category in @($script:concepts.categories)) {
      $chip = New-Chip ([string]$category.name) $null ([string]$category.id -eq [string]$Concept.category)
      Set-Click $chip { param($Data, $Sender) Invoke-Helper 'concept.move' @{ id = $Data.id; category = $Data.category } { param($Result, $Context) $script:movingConcept = $null; Update-Learned } } @{ id = $id; category = [string]$category.id }
      [void]$wrap.Children.Add($chip)
    }
    [void]$text.Children.Add($wrap)
  }
  if (@($Concept.aliases).Count -gt 0) { $row.ToolTip = 'Also called: ' + (@($Concept.aliases) -join ', ') }
  [void]$dock.Children.Add($text)
  return $row
}

function Invoke-ConceptAction([string]$Key, [string]$Id, $Sender = $null) {
  switch ($Key) {
    'rename' { $script:renamingConcept = $Id; $script:movingConcept = $null; $script:editingDefinition = $null; Show-Learned }
    'edit' { $script:editingDefinition = $Id; $script:renamingConcept = $null; $script:movingConcept = $null; Show-Learned }
    'nest' { $script:nestFrom = $Id; Show-Learned }
    'cancel' { $script:nestFrom = $null; Show-Learned }
    { $_ -eq 'under' -or $_ -eq 'top level' } {
      $child = $script:nestFrom
      $script:nestFrom = $null
      $parent = if ($Key -eq 'under') { $Id } else { $null }
      Invoke-Helper 'concept.update' @{ id = $child; parent = $parent } { param($Result, $Context) Update-Learned } $null { param($Message, $Context) Show-Toast $Message 'error'; Show-Learned }
    }
    'move' { $script:movingConcept = if ($script:movingConcept -eq $Id) { $null } else { $Id }; $script:renamingConcept = $null; Show-Learned }
    'merge' { $script:mergeFrom = $Id; Show-Learned }
    'into' {
      $drop = $script:mergeFrom
      $script:mergeFrom = $null
      Invoke-Helper 'concept.merge' @{ keep = $Id; drop = $drop } { param($Result, $Context) Show-Toast "Merged into $($Result.name)"; Update-Learned }
    }
    'remove' {
      if (Test-ArmedHere $Sender "concept:$Id") {
        Invoke-Helper 'concept.remove' @{ id = $Id } { param($Result, $Context) Show-Toast "Removed: $Context"; Update-Learned } (Get-LearnedName $Id)
      }
    }
  }
}

function Remove-Category([string]$Id, $Categories, [scriptblock]$Reload, $Sender = $null) {
  $others = @($Categories | Where-Object { [string]$_.id -ne $Id })
  if ($others.Count -eq 0) { Show-Toast 'This is your only category'; return }
  if (-not (Test-ArmedHere $Sender "category:$Id")) { return }
  $target = $others | Where-Object { [string]$_.name -eq 'General' } | Select-Object -First 1
  if (-not $target) { $target = $others[0] }
  Invoke-Helper 'category.remove' @{ id = $Id; moveTo = [string]$target.id } {
    param($Result, $Context)
    Show-Toast "Removed. Its courses and concepts moved to $Context."
    Update-Learned
    Update-Library
  } ([string]$target.name)
}

# ===================================================================================================
# Ask (the Advisor)
# ===================================================================================================

function Build-AskView {
  $root = New-Object System.Windows.Controls.DockPanel
  Set-ViewColumn $root
  $top = New-Object System.Windows.Controls.StackPanel
  $top.Margin = New-Gap 0 0 0 8
  [System.Windows.Controls.DockPanel]::SetDock($top, 'Top')
  $head = New-Object System.Windows.Controls.DockPanel
  $head.MinHeight = 22
  $title = New-Text 'What should I learn next?' $ink
  $title.FontSize = 15
  $title.FontWeight = 'SemiBold'
  $title.VerticalAlignment = 'Center'
  [void]$head.Children.Add($title)
  [void]$top.Children.Add($head)
  $suggest = New-Object System.Windows.Controls.WrapPanel
  $suggest.Margin = New-Gap 0 8 0 0
  foreach ($prompt in @('What should I learn next?', 'What am I missing for the stack I work in?', 'Plan my next month of learning', 'What would make me a stronger senior engineer?')) {
    $chip = New-Chip $prompt $null $false
    $chip.ToolTip = 'Ask this now'
    Set-Click $chip { param($Data, $Sender) Set-InputText $script:ui.askInput $Data; Submit-Advisor } $prompt
    [void]$suggest.Children.Add($chip)
  }
  [void]$top.Children.Add($suggest)
  $bottom = New-Object System.Windows.Controls.DockPanel
  $bottom.Margin = New-Gap 0 8 0 0
  [System.Windows.Controls.DockPanel]::SetDock($bottom, 'Bottom')
  $send = New-Button 'Send' 'primary'
  $send.VerticalAlignment = 'Bottom'
  $send.Margin = New-Gap 6 0 0 0
  $send.ToolTip = 'Send  (Enter; Shift+Enter for a new line)'
  [System.Windows.Controls.DockPanel]::SetDock($send, 'Right')
  $askInput = New-InputBox 'Ask what to learn, or how to go about it' $true
  $askInput.box.Height = 64
  Set-ChatInputSize $askInput.box
  [void]$bottom.Children.Add($send)
  [void]$bottom.Children.Add($askInput.holder)
  # The messages' text on the view's edge (Add-MessageSection). The reader hangs as far past the
  # column on the right as on the left, plus the lane, so its scrollbar is where the lists' bars are.
  $reader = New-Reader
  $reader.Margin = New-Gap (-$MESSAGE_INSET - 2) 0 (-$MESSAGE_INSET - 2 - $SCROLL_LANE) 0
  [void]$root.Children.Add($top)
  [void]$root.Children.Add($bottom)
  [void]$root.Children.Add($reader)
  # The chats, the one used last on top, in a column on the left; the chat beside it.
  $outer = New-Object System.Windows.Controls.DockPanel
  Set-ViewColumn $outer
  $root.Margin = New-Gap 0 0 0 0
  $side = New-Object System.Windows.Controls.DockPanel
  $side.Width = 232
  $side.Margin = New-Gap 0 0 20 0
  [System.Windows.Controls.DockPanel]::SetDock($side, 'Left')
  $sideHead = New-Object System.Windows.Controls.DockPanel
  $sideHead.MinHeight = 22
  $sideHead.Margin = New-Gap 0 0 0 6
  [System.Windows.Controls.DockPanel]::SetDock($sideHead, 'Top')
  $newChat = New-Pressable "+ New chat" $null $dim
  $newChat.FontSize = 12.5
  $newChat.Margin = New-Gap 0 0 -4 0
  $newChat.VerticalAlignment = 'Center'
  $newChat.ToolTip = 'Start a new chat; the others stay in this list'
  [System.Windows.Controls.DockPanel]::SetDock($newChat, 'Right')
  $chatsLabel = New-Label 'Chats'
  $chatsLabel.Margin = New-Gap 0 0 0 0
  $chatsLabel.VerticalAlignment = 'Center'
  [void]$sideHead.Children.Add($newChat)
  [void]$sideHead.Children.Add($chatsLabel)
  $listScroll = New-Object System.Windows.Controls.ScrollViewer
  $listScroll.VerticalScrollBarVisibility = 'Auto'
  $listScroll.HorizontalScrollBarVisibility = 'Disabled'
  $list = New-Object System.Windows.Controls.StackPanel
  $listScroll.Content = $list
  [void]$side.Children.Add($sideHead)
  [void]$side.Children.Add($listScroll)
  $rule = New-Object System.Windows.Controls.Border
  $rule.Width = 1
  $rule.Background = $line
  $rule.Margin = New-Gap 0 0 20 0
  [System.Windows.Controls.DockPanel]::SetDock($rule, 'Left')
  [void]$outer.Children.Add($side)
  [void]$outer.Children.Add($rule)
  [void]$outer.Children.Add($root)
  $script:viewHosts['ask'].Child = $outer
  $script:ui.askList = $list
  $script:ui.askInput = $askInput.box
  $script:ui.askReader = $reader
  $script:ui.askSend = $send
  Set-Click $send { param($Data, $Sender) Submit-Advisor }
  Set-Click $newChat { param($Data, $Sender) New-AdvisorChat }
  $askInput.box.Add_PreviewKeyDown({
    param($sender, $e)
    try {
      $shift = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Shift) -ne 0
      if ($e.Key -eq 'Return' -and -not $shift) { $e.Handled = $true; Submit-Advisor }
    } catch { Write-Failure $_ }
  })
}

# The Advisor's chats: the helper keeps them (advisor.list); the window makes a new one's id, so
# its key (advisor:<id>) is the same from the first word streamed to the last.
function Get-AdvisorKey { return "advisor:$($script:advisorChatId)" }
function Test-AdvisorKey([string]$Key) { return $Key.StartsWith('advisor:') }

function New-AdvisorChatId {
  $ms = [long]([DateTime]::UtcNow - [DateTime]::new(1970, 1, 1)).TotalMilliseconds
  $letters = '0123456789abcdefghijklmnopqrstuvwxyz'
  $random = -join (1..4 | ForEach-Object { $letters[(Get-Random -Maximum 36)] })
  return 'a' + [Convert]::ToString($ms, 16) + $random
}

function Open-Advisor {
  Invoke-Helper 'advisor.list' @{} {
    param($Result, $Context)
    $script:advisorChats = @($Result | Where-Object { $_ })
    if (-not $script:advisorChatId) {
      $script:advisorChatId = if ($script:advisorChats.Count -gt 0) { [string]$script:advisorChats[0].id } else { New-AdvisorChatId }
    }
    Show-AdvisorList
    Show-AdvisorChat
  }
}

function Update-AdvisorList {
  Invoke-Helper 'advisor.list' @{} {
    param($Result, $Context)
    $script:advisorChats = @($Result | Where-Object { $_ })
    Show-AdvisorList
  }
}

function Test-AdvisorSaved([string]$Id) { return @($script:advisorChats | Where-Object { [string]$_.id -eq $Id }).Count -gt 0 }

function Show-AdvisorChat {
  $key = Get-AdvisorKey
  $state = Get-ChatState $key
  if ($state.busy -or -not (Test-AdvisorSaved $script:advisorChatId)) { Show-Chat $key $state.messages $script:ui.askReader; return }
  Invoke-Helper 'chat.get' @{ advisor = $true; chatId = $script:advisorChatId } {
    param($Result, $Context)
    # Another chat was picked while this one loaded.
    if ($Context.key -ne (Get-AdvisorKey)) { return }
    Show-Chat $Context.key @($Result.messages) $script:ui.askReader
  } @{ key = $key }
}

function Select-AdvisorChat([string]$Id) {
  if ($Id -eq $script:advisorChatId) { return }
  $script:advisorChatId = $Id
  Show-AdvisorList
  Show-AdvisorChat
}

function New-AdvisorChat {
  # The chat in front is new and still empty: it is the new chat.
  $state = Get-ChatState (Get-AdvisorKey)
  if (-not (Test-AdvisorSaved $script:advisorChatId) -and -not $state.busy -and @($state.messages).Count -eq 0) { [void]$script:ui.askInput.Focus(); return }
  $script:advisorChatId = New-AdvisorChatId
  Show-AdvisorList
  Show-Chat (Get-AdvisorKey) @() $script:ui.askReader
  [void]$script:ui.askInput.Focus()
}

function Remove-AdvisorChat([string]$Id, $Sender) {
  if (-not (Test-Armed "advisor-remove:$Id" $Sender 'delete?')) { return }
  Invoke-Helper 'advisor.remove' @{ chatId = $Id } {
    param($Result, $Context)
    [void]$script:chats.Remove("advisor:$($Context.id)")
    $script:advisorChats = @($script:advisorChats | Where-Object { [string]$_.id -ne $Context.id })
    if ($script:advisorChatId -eq $Context.id) {
      $script:advisorChatId = if ($script:advisorChats.Count -gt 0) { [string]$script:advisorChats[0].id } else { New-AdvisorChatId }
      Show-AdvisorChat
    }
    Show-AdvisorList
    Show-Toast 'Chat deleted'
  } @{ id = $Id }
}

# When a chat was last used: the time today, else the day.
function Format-ChatWhen([string]$Iso) {
  $when = [DateTime]::MinValue
  if (-not $Iso -or -not [DateTime]::TryParse($Iso, [ref]$when)) { return '' }
  $local = $when.ToLocalTime()
  if ($local.Date -eq [DateTime]::Now.Date) { return $local.ToString('HH:mm') }
  return Format-ShortDate $Iso
}

function New-AdvisorRow([string]$Id, [string]$Title, [string]$When, [bool]$Current, [bool]$Saved) {
  $row = New-Object System.Windows.Controls.Border
  $row.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
  $row.Padding = New-Gap 8 5 2 6
  $row.Margin = New-Gap 0 0 0 2
  Set-Hover $row
  if ($Current) { $row.Background = $selected }
  $dock = New-Object System.Windows.Controls.DockPanel
  $dock.LastChildFill = $true
  if ($Saved) {
    # Delete: shown while the pointer is on the row (or the row is the open chat); two clicks.
    $remove = New-Pressable $GLYPH_CLOSE $null $faint
    $remove.FontSize = 11
    $remove.VerticalAlignment = 'Top'
    $remove.ToolTip = 'Delete this chat (click twice)'
    $remove.Opacity = if ($Current) { 1 } else { 0 }
    [System.Windows.Controls.DockPanel]::SetDock($remove, 'Right')
    Set-Click $remove { param($Data, $Sender) Remove-AdvisorChat $Data $Sender } $Id
    [void]$dock.Children.Add($remove)
    $row.Resources['remove'] = $remove
    $row.Add_MouseEnter({ param($sender, $e) $sender.Resources['remove'].Opacity = 1 })
    if (-not $Current) { $row.Add_MouseLeave({ param($sender, $e) if ($sender.Resources['remove'].Text -eq $GLYPH_CLOSE) { $sender.Resources['remove'].Opacity = 0 } }) }
  }
  $stack = New-Object System.Windows.Controls.StackPanel
  $name = New-Text $Title $ink
  $name.FontSize = 13
  $name.TextTrimming = 'CharacterEllipsis'
  $name.ToolTip = $Title
  [void]$stack.Children.Add($name)
  if ($When) {
    $whenText = New-Text $When $faint
    $whenText.FontSize = 11
    $whenText.Margin = New-Gap 0 1 0 0
    [void]$stack.Children.Add($whenText)
  }
  [void]$dock.Children.Add($stack)
  $row.Child = $dock
  Set-Click $row { param($Data, $Sender) Select-AdvisorChat $Data } $Id
  return $row
}

function Show-AdvisorList {
  $list = $script:ui.askList
  if (-not $list) { return }
  $list.Children.Clear()
  if (-not (Test-AdvisorSaved $script:advisorChatId)) {
    [void]$list.Children.Add((New-AdvisorRow $script:advisorChatId 'New chat' '' $true $false))
  }
  foreach ($chat in @($script:advisorChats)) {
    $title = if ($chat.title) { [string]$chat.title } else { 'Untitled chat' }
    [void]$list.Children.Add((New-AdvisorRow ([string]$chat.id) $title (Format-ChatWhen ([string]$chat.updatedAt)) ([string]$chat.id -eq $script:advisorChatId) $true))
  }
}

function Submit-Advisor {
  $first = -not (Test-AdvisorSaved $script:advisorChatId)
  Submit-Chat (Get-AdvisorKey) @{ advisor = $true; chatId = $script:advisorChatId } $script:ui.askInput $script:ui.askReader
  # The question is saved before the answer comes: a new chat joins the list now.
  if ($first) { Update-AdvisorList }
}

# ===================================================================================================
# Settings
# ===================================================================================================

# Two parts: Appearance, which is this machine's and goes to appearance.json (never through
# settings.set, which keeps only the library's own settings), built once and kept in step; and
# the library's settings, redrawn from the helper's answer.
function Build-SettingsView {
  $column = New-Object System.Windows.Controls.DockPanel
  Set-ViewColumn $column
  $stack = New-Object System.Windows.Controls.StackPanel
  $appearance = New-Object System.Windows.Controls.StackPanel
  $body = New-Object System.Windows.Controls.StackPanel
  [void]$stack.Children.Add($appearance)
  $rule = New-Object System.Windows.Controls.Border
  $rule.Height = 1
  $rule.Background = $line
  $rule.Margin = New-Gap 0 20 0 4
  [void]$stack.Children.Add($rule)
  [void]$stack.Children.Add($body)
  $script:ui.settingsStack = $body
  $script:ui.appearance = $appearance
  $scroll = New-RowScroll $stack 10
  $stack.Margin = New-Gap 10 0 10 8
  [void]$column.Children.Add($scroll)
  $script:viewHosts['settings'].Child = $column
  Build-AppearanceSection
}

# A section's caption (the same as every other caption in Learn), with a line under it saying
# what the setting does.
function New-SettingTitle([string]$Text, [string]$Note, [double]$Top = 18) {
  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Margin = New-Gap 0 $Top 0 8
  $title = New-Label $Text 11 $faint
  $title.Margin = New-Gap 0 0 0 0
  [void]$panel.Children.Add($title)
  if ($Note) {
    $noteText = New-Text $Note $dim
    $noteText.TextWrapping = 'Wrap'
    $noteText.FontSize = 12
    $noteText.Margin = New-Gap 0 3 0 0
    [void]$panel.Children.Add($noteText)
  }
  return $panel
}

# --- Appearance: the colour scheme and see-through of every window ---------------------------------

$script:shownAppearance = ''
$script:shownColors = ''
$script:fillingColorBoxes = $false

function Get-ColorText([string]$Text) {
  $hex = $Text.Trim()
  if ($hex -and -not $hex.StartsWith('#')) { $hex = '#' + $hex }
  if ($hex -match '^#[0-9A-Fa-f]{6}$') { return $hex.ToUpperInvariant() }
  return $null
}

function Build-AppearanceSection {
  $section = $script:ui.appearance
  $section.Children.Clear()

  [void]$section.Children.Add((New-SettingTitle 'Colour scheme' 'Every window takes it at once: the panel, Learn and the games.' 0))
  # Each preset's swatch (a click switches every window) with its name under it.
  $swatches = New-Object System.Windows.Controls.WrapPanel
  $script:ui.swatches = @()
  foreach ($preset in (Get-ThemePresets)) {
    $cell = New-Object System.Windows.Controls.StackPanel
    $cell.Margin = New-Gap 0 0 10 0
    $swatch = New-UiSwatch $preset 64 28
    $name = New-Text ([string]$preset.label) $dim
    $name.FontSize = 11.5
    $name.HorizontalAlignment = 'Center'
    $name.Margin = New-Gap 0 4 0 0
    [void]$cell.Children.Add($swatch)
    [void]$cell.Children.Add($name)
    [void]$swatches.Children.Add($cell)
    $script:ui.swatches += @{ swatch = $swatch; name = $name }
  }
  [void]$section.Children.Add($swatches)
  $script:ui.swatchRow = $swatches

  [void]$section.Children.Add((New-SettingTitle 'Custom' 'Your own background, accent and text, as #RRGGBB. Every window follows as soon as all three are colours; the rest of the palette comes from them.'))
  $customRow = New-Object System.Windows.Controls.WrapPanel
  $script:ui.customBoxes = @{}
  $script:ui.customWells = @{}
  foreach ($part in @(@{ key = 'bg'; label = 'Background' }, @{ key = 'accent'; label = 'Accent' }, @{ key = 'text'; label = 'Text' })) {
    $group = New-Object System.Windows.Controls.StackPanel
    $group.Margin = New-Gap 0 0 16 6
    $label = New-Text $part.label $dim
    $label.FontSize = 11.5
    $label.Margin = New-Gap 0 0 0 4
    [void]$group.Children.Add($label)
    $line2 = New-Object System.Windows.Controls.StackPanel
    $line2.Orientation = 'Horizontal'
    # The colour as you type it; an empty box with a red edge until it is a colour.
    $well = New-Object System.Windows.Controls.Border
    $well.Width = $INPUT_HEIGHT
    $well.Height = $INPUT_HEIGHT
    $well.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
    $well.BorderThickness = New-Object System.Windows.Thickness(1)
    $well.BorderBrush = $line
    $well.Margin = New-Gap 0 0 6 0
    $colorBox = New-InputBox '#RRGGBB' -Mono
    $colorBox.holder.Width = 104
    $colorBox.box.MaxLength = 7
    $colorBox.box.Tag.Margin = New-Gap 11 0 6 0
    $colorBox.box.Resources['part'] = $part.key
    # While you type in it: its well follows, and once all three are colours, every window does.
    $colorBox.box.Add_TextChanged({
      param($sender, $e)
      try {
        Update-CustomWell ([string]$sender.Resources['part'])
        if ($sender.IsKeyboardFocused -and -not $script:fillingColorBoxes) { Use-CustomColors -Quiet }
      } catch { Write-Failure $_ }
    })
    $colorBox.box.Add_KeyDown({ param($sender, $e) if ($e.Key -eq 'Return') { $e.Handled = $true; try { Use-CustomColors } catch { Write-Failure $_ } } })
    [void]$line2.Children.Add($well)
    [void]$line2.Children.Add($colorBox.holder)
    [void]$group.Children.Add($line2)
    [void]$customRow.Children.Add($group)
    $script:ui.customBoxes[$part.key] = $colorBox.box
    $script:ui.customWells[$part.key] = $well
  }
  $use = New-Button 'Use these' 'secondary'
  $use.VerticalAlignment = 'Bottom'
  $use.Margin = New-Gap 0 0 0 6
  $use.ToolTip = 'Switch every window to these three colours (Enter)'
  Set-Click $use { param($Data, $Sender) Use-CustomColors }
  [void]$customRow.Children.Add($use)
  $script:ui.useCustom = $use
  [void]$section.Children.Add($customRow)

  [void]$section.Children.Add((New-SettingTitle 'See-through' 'The background only: text and lines stay solid. The panel, Learn and the games each have their own.'))
  $script:ui.opacityRows = @()
  foreach ($windowGroup in @(@{ key = 'panel'; label = 'Panel' }, @{ key = 'learn'; label = 'Learn' }, @{ key = 'games'; label = 'Games' })) {
    $bar = New-UiOpacityBar $windowGroup.key $windowGroup.label 220
    $bar.Margin = New-Gap 0 0 0 4
    $bar.ToolTip = "How much of what is behind the $($windowGroup.label.ToLowerInvariant()) shows through. Click or drag."
    [void]$section.Children.Add($bar)
    $script:ui.opacityRows += $bar
  }
  # Said while any bar is low: over a busy or opposite-coloured window, text can get hard to read.
  # In the text colour, the one that stays readable longest as the background clears.
  $lowNote = New-Text "Below $([int]($SEE_THROUGH_LOW * 100))% text can get hard to read over a busy window, or one much lighter or darker than this scheme." $ink
  $lowNote.FontSize = 12
  $lowNote.TextWrapping = 'Wrap'
  $lowNote.Margin = New-Gap 0 4 0 0
  $lowNote.Visibility = 'Collapsed'
  [void]$section.Children.Add($lowNote)
  $script:ui.seeThroughNote = $lowNote

  $reset = New-Button 'Reset to Ember' 'secondary'
  $reset.HorizontalAlignment = 'Left'
  $reset.Margin = New-Gap 0 16 0 0
  $reset.ToolTip = 'The default colours and see-through, in every window'
  Set-Click $reset {
    param($Data, $Sender)
    $next = @{
      preset = 'ember'
      colors = @{ bg = $THEME_DEFAULT_COLORS.bg; accent = $THEME_DEFAULT_COLORS.accent; text = $THEME_DEFAULT_COLORS.text }
      opacity = @{ panel = $THEME_DEFAULT_OPACITY.panel; learn = $THEME_DEFAULT_OPACITY.learn; games = $THEME_DEFAULT_OPACITY.games }
    }
    Set-Appearance $next
    Update-AppearanceSection
    Show-Toast 'Back to Ember'
  }
  [void]$section.Children.Add($reset)
  $script:shownAppearance = ''
  $script:shownColors = ''
  Update-AppearanceSection
}

# Moves the swatch ring and the bars to the scheme in use, and puts its colours in the boxes when
# they changed (a swatch, another window, Reset). -KeepFocused is for the as-you-type case only: the
# box being typed in keeps its text. Anything else refreshes every box, so a box left focused
# never keeps showing an old colour that 'Use these' would then apply.
function Update-AppearanceSection([switch]$KeepFocused) {
  if (-not $script:ui.swatchRow) { return }
  $current = $script:THEME.appearance
  $script:shownAppearance = Get-AppearanceKey
  foreach ($cell in $script:ui.swatches) {
    Update-UiSwatch $cell.swatch
    $inUse = $current.preset -eq $cell.swatch.Tag.preset.name
    $cell.name.Foreground = if ($inUse) { $ink } else { $dim }
  }
  foreach ($row in $script:ui.opacityRows) { Update-UiOpacityRow $row }
  if ($script:ui.seeThroughNote) {
    $low = $false
    foreach ($group in @('panel', 'learn', 'games')) { if ([double]$current.opacity[$group] -lt $SEE_THROUGH_LOW - 0.001) { $low = $true } }
    $script:ui.seeThroughNote.Visibility = if ($low) { 'Visible' } else { 'Collapsed' }
  }
  $colorsKey = '{0}|{1}|{2}' -f $current.colors.bg, $current.colors.accent, $current.colors.text
  if ($colorsKey -ne $script:shownColors) {
    $script:shownColors = $colorsKey
    # Filled one at a time, so a focused box must not apply the three while the others are old.
    $script:fillingColorBoxes = $true
    try {
      foreach ($key in @('bg', 'accent', 'text')) {
        $box = $script:ui.customBoxes[$key]
        if ($KeepFocused -and $box.IsKeyboardFocused) { continue }
        if ($box.Text -ne [string]$current.colors[$key]) { Set-InputText $box ([string]$current.colors[$key]) }
      }
    } finally { $script:fillingColorBoxes = $false }
  }
  foreach ($key in @('bg', 'accent', 'text')) { Update-CustomWell $key }
}

function Get-AppearanceKey {
  $current = $script:THEME.appearance
  return '{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f $current.preset, $current.colors.bg, $current.colors.accent, $current.colors.text, $current.opacity.panel, $current.opacity.learn, $current.opacity.games
}

# The halo for low see-through (Chrome.ps1) in step with Learn's see-through and background, and
# the appearance it was set for.
$script:haloAppearance = ''
function Update-LearnHalo {
  $script:haloAppearance = Get-AppearanceKey
  Update-UiHalo
}

# Called every tick. A swatch, Reset, the custom colours or a bar here changed the scheme: the halo
# follows whatever the change, since a bar being dragged only previews (Set-ThemeAppearance) and
# never reaches Update-Theme; and while Settings shows, its swatch ring and bars do too.
function Sync-AppearanceSection {
  $key = Get-AppearanceKey
  if ($key -ne $script:haloAppearance) { Update-LearnHalo }
  if ($script:view -ne 'settings' -or -not $script:ui.swatchRow) { return }
  if ($key -ne $script:shownAppearance) { Update-AppearanceSection }
}

function Update-CustomWell([string]$Key) {
  $box = $script:ui.customBoxes[$Key]
  $well = $script:ui.customWells[$Key]
  if (-not $box -or -not $well) { return }
  $hex = Get-ColorText $box.Text
  if ($hex) {
    $well.Background = New-Object System.Windows.Media.SolidColorBrush((ConvertTo-ThemeMediaColor $hex))
    $well.BorderBrush = $line
    $well.ToolTip = $hex
  } else {
    $well.Background = $noFill
    $well.BorderBrush = $red
    $well.ToolTip = 'Not a colour yet: #RRGGBB'
  }
  $allValid = $true
  foreach ($part in @('bg', 'accent', 'text')) { if (-not (Get-ColorText $script:ui.customBoxes[$part].Text)) { $allValid = $false } }
  if ($script:ui.useCustom) { Set-ButtonEnabled $script:ui.useCustom $allValid }
}

# The three boxes become the scheme of every window, when all three are colours. -Quiet is the
# as-you-type case: nothing is said, and nothing is written while a box is not a colour yet or
# the three are the scheme already.
function Use-CustomColors([switch]$Quiet) {
  $colors = @{}
  foreach ($part in @('bg', 'accent', 'text')) {
    $hex = Get-ColorText $script:ui.customBoxes[$part].Text
    if (-not $hex) {
      if (-not $Quiet) { Show-Toast 'Each colour is # and six hex digits, like #1C1D20' 'error' }
      return
    }
    $colors[$part] = $hex
  }
  $current = $script:THEME.appearance
  $same = $current.colors.bg -eq $colors.bg -and $current.colors.accent -eq $colors.accent -and $current.colors.text -eq $colors.text
  if ($Quiet -and $same) { return }
  $next = Copy-Appearance
  # The same three colours as a preset are that preset (its swatch rings); anything else is yours.
  $next.preset = 'custom'
  foreach ($preset in (Get-ThemePresets)) {
    if ($preset.bg.ToUpperInvariant() -eq $colors.bg -and $preset.accent.ToUpperInvariant() -eq $colors.accent -and $preset.text.ToUpperInvariant() -eq $colors.text) { $next.preset = $preset.name }
  }
  $next.colors = $colors
  Set-Appearance $next
  $script:shownColors = ''
  Update-AppearanceSection -KeepFocused:$Quiet
  if (-not $Quiet) { Show-Toast 'Your colours, in every window' }
}

# --- The library's settings ----------------------------------------------------------------------

function Update-Settings {
  Invoke-Helper 'settings.get' $null {
    param($Result, $Context)
    $script:settings = $Result
    Show-Settings
  }
  # Asked once each time Settings opens, not on every change.
  Invoke-Helper 'deps.check' $null {
    param($Result, $Context)
    $script:ytVersion = if ($Result) { "yt-dlp $($Result.version)" } else { 'yt-dlp: not downloaded yet (it comes with the first build)' }
    if ($script:ui.ytText) { $script:ui.ytText.Text = $script:ytVersion }
  }
}

function Save-Setting($Change) {
  Invoke-Helper 'settings.set' @{ change = $Change } {
    param($Result, $Context)
    if ([string]$Result.library -ne [string]$script:settings.library) {
      # Another library: nothing on screen belongs to it.
      $script:library = $null
      $script:courseData = $null
      $script:courseId = $null
      $script:pageData = $null
      $script:concepts = $null
      $script:chats = @{}
      $script:advisorChatId = $null
      $script:advisorChats = @()
      $tabTexts['course'].Visibility = 'Collapsed'
    }
    $script:settings = $Result
    Show-Settings
    Show-Toast 'Saved'
  }
}

$script:ytVersion = 'yt-dlp'
function Show-Settings {
  $stack = $script:ui.settingsStack
  $stack.Children.Clear()
  $settings = $script:settings

  [void]$stack.Children.Add((New-SettingTitle 'Library folder' 'Where your courses, concepts and chats are kept: a WSL path (~/...) or a Windows one (C:\Users\...\OneDrive\Learn). Changing it starts using that folder; nothing is moved.'))
  $libraryRow = New-Object System.Windows.Controls.Grid
  $libraryRow.ColumnDefinitions.Add((New-Column '*'))
  $libraryRow.ColumnDefinitions.Add((New-Column 'auto'))
  $libraryBox = New-InputBox 'Library folder' -Mono
  $libraryBox.box.Text = [string]$settings.library
  $libraryBox.holder.ToolTip = [string]$settings.library
  $useButton = New-Button 'Use this folder' 'secondary'
  $useButton.Margin = New-Gap 8 0 0 0
  [System.Windows.Controls.Grid]::SetColumn($useButton, 1)
  Set-Click $useButton { param($Data, $Sender) Save-Setting @{ library = $Data.Text.Trim() } } $libraryBox.box
  [void]$libraryRow.Children.Add($libraryBox.holder)
  [void]$libraryRow.Children.Add($useButton)
  [void]$stack.Children.Add($libraryRow)

  foreach ($which in @(@{ key = 'build'; title = 'Model that builds courses'; note = 'Research, planning and writing the pages.' }, @{ key = 'video'; title = 'Model that makes videos'; note = 'Writes each video''s script. Opus runs at low effort, the others at high.' }, @{ key = 'chat'; title = 'Model for chat'; note = 'The page chats, the Advisor, and filing concepts you add.' })) {
    [void]$stack.Children.Add((New-SettingTitle $which.title $which.note))
    $chips = New-Object System.Windows.Controls.WrapPanel
    $chips.Margin = New-Gap 0 0 0 -6
    $current = [string]$settings.models.($which.key)
    foreach ($choice in $MODEL_CHOICES) {
      $chip = New-Chip $choice.label $null ($current -eq $choice.key)
      Set-Click $chip { param($Data, $Sender) $models = @{}; $models[[string]$Data.which] = [string]$Data.model; Save-Setting @{ models = $models } } @{ which = $which.key; model = $choice.key }
      [void]$chips.Children.Add($chip)
    }
    [void]$stack.Children.Add($chips)
  }

  [void]$stack.Children.Add((New-SettingTitle 'Work folders the Advisor may read' 'It reads them (never writes) to see the stack you really use: package.json, Dockerfiles, CI config, source.'))
  foreach ($folder in @($settings.workFolders)) {
    $row = New-Object System.Windows.Controls.DockPanel
    $row.Margin = New-Gap 0 1 0 3
    $remove = New-SmallAction 'remove' {
      param($Data, $Sender)
      if (Test-ArmedHere $Sender "folder:$Data") { Save-Setting @{ workFolders = @($script:settings.workFolders | Where-Object { [string]$_ -ne $Data }) } }
    } ([string]$folder)
    $remove.Margin = New-Gap 12 0 -4 0
    [System.Windows.Controls.DockPanel]::SetDock($remove, 'Right')
    $path = New-Text ([string]$folder) $ink
    $path.FontFamily = $monoFont
    $path.FontSize = 12
    $path.VerticalAlignment = 'Center'
    $path.TextTrimming = 'CharacterEllipsis'
    $path.ToolTip = [string]$folder
    [void]$row.Children.Add($remove)
    [void]$row.Children.Add($path)
    [void]$stack.Children.Add($row)
  }
  $folderRow = New-Object System.Windows.Controls.Grid
  $folderRow.ColumnDefinitions.Add((New-Column '*'))
  $folderRow.ColumnDefinitions.Add((New-Column 'auto'))
  $folderBox = New-InputBox 'A folder, e.g. ~/code/my-app' -Mono
  $addButton = New-Button 'Add' 'secondary'
  $addButton.Margin = New-Gap 8 0 0 0
  [System.Windows.Controls.Grid]::SetColumn($addButton, 1)
  Set-Click $addButton {
    param($Data, $Sender)
    $path = $Data.Text.Trim()
    if (-not $path) { return }
    Save-Setting @{ workFolders = @(@($script:settings.workFolders) + $path) }
  } $folderBox.box
  [void]$folderRow.Children.Add($folderBox.holder)
  [void]$folderRow.Children.Add($addButton)
  $folderRow.Margin = New-Gap 0 4 0 0
  [void]$stack.Children.Add($folderRow)

  [void]$stack.Children.Add((New-SettingTitle 'Text size' 'The pages and the chats. Also Ctrl+plus and Ctrl+minus.'))
  $sizeRow = New-Object System.Windows.Controls.StackPanel
  $sizeRow.Orientation = 'Horizontal'
  $smaller = New-Button 'A-' 'secondary'
  $smaller.ToolTip = 'Smaller  (Ctrl+minus)'
  $bigger = New-Button 'A+' 'secondary'
  $bigger.ToolTip = 'Bigger  (Ctrl+plus)'
  $sizeText = New-Text ("{0}%" -f [int]($script:textScale * 100)) $ink
  $sizeText.FontFamily = $monoFont
  $sizeText.FontSize = 12
  $sizeText.Width = 52
  $sizeText.TextAlignment = 'Center'
  $sizeText.VerticalAlignment = 'Center'
  $script:ui.textSizeValue = $sizeText
  Set-Click $smaller { param($Data, $Sender) Set-TextScale ($script:textScale - 0.1) }
  Set-Click $bigger { param($Data, $Sender) Set-TextScale ($script:textScale + 0.1) }
  [void]$sizeRow.Children.Add($smaller)
  [void]$sizeRow.Children.Add($sizeText)
  [void]$sizeRow.Children.Add($bigger)
  [void]$stack.Children.Add($sizeRow)

  $usage = if ($script:status) { $script:status.usage } else { $null }
  [void]$stack.Children.Add((New-SettingTitle 'Your Claude usage' 'Builds and chats run on your own Claude subscription, through your logged-in Claude Code. They count toward the same limits as your work.'))
  $usageText = if ($usage -and $null -ne $usage.fiveHour) { "Last reading: {0}% of the 5-hour limit, {1}% of the weekly limit ({2})." -f [int]([double]$usage.fiveHour * 100), [int]([double]$usage.sevenDay * 100), (Format-Date ([string]$usage.at)) } else { 'No reading yet: it shows after the first build or chat.' }
  $usageLine = New-Text $usageText $ink
  $usageLine.TextWrapping = 'Wrap'
  [void]$stack.Children.Add($usageLine)

  [void]$stack.Children.Add((New-SettingTitle 'Transcripts' 'Video captions come through yt-dlp, which Learn downloads and keeps up to date itself.'))
  $ytRow = New-Object System.Windows.Controls.StackPanel
  $ytRow.Orientation = 'Horizontal'
  $ytText = New-Text $script:ytVersion $ink
  $ytText.VerticalAlignment = 'Center'
  $ytText.Margin = New-Gap 0 0 8 0
  $script:ui.ytText = $ytText
  $update = New-Pressable 'update now' $null $blue
  $update.VerticalAlignment = 'Center'
  $update.ToolTip = 'Download the newest yt-dlp'
  Set-Click $update {
    param($Data, $Sender)
    $Sender.Text = 'updating...'
    Invoke-Helper 'deps.install' $null { param($Result, $Context) $Context.Text = "updated: $($Result.version)" } $Sender { param($Message, $Context) $Context.Text = 'update failed'; Show-Toast $Message 'error' }
  }
  [void]$ytRow.Children.Add($ytText)
  [void]$ytRow.Children.Add($update)
  [void]$stack.Children.Add($ytRow)
}

# ===================================================================================================
# Every tick, and after status changes
# ===================================================================================================

# The chat and Ask boxes' text follows the text size, as the messages above them do.
function Set-ChatInputSize($Box) {
  $size = [Math]::Round((Get-TextSize) * 0.93, 1)
  $Box.FontSize = $size
  if ($Box.Tag -is [System.Windows.Controls.TextBlock]) { $Box.Tag.FontSize = $size }
  $Box.Height = [Math]::Round(64 * [Math]::Max(1.0, [double]$script:textScale))
}

function Update-TextSize {
  foreach ($key in @($script:chats.Keys)) { if (-not $script:chats[$key].busy) { $script:chats.Remove($key) } }
  if ($script:ui.pageArea) { $script:ui.pageArea.MaxWidth = (Get-TextSize) * $READING_EMS }
  foreach ($box in @($script:ui.chatInput, $script:ui.askInput)) { if ($box) { Set-ChatInputSize $box } }
  if ($script:view -eq 'course' -and $script:pageData) { Show-Page }
  if ($script:view -eq 'ask') { Open-Advisor }
}

function Update-FromStatus {
  $build = if ($script:status) { $script:status.build } else { $null }
  # The video job moved: the page's row and the course's line follow, at most every 3 s, and its
  # last word always lands.
  if ($script:view -eq 'course' -and $build -and [string]$build.kind -eq 'video' -and ([string]$build.state -ne 'running' -or ([DateTime]::UtcNow - $script:lastVideoAt).TotalSeconds -gt 3)) {
    $script:lastVideoAt = [DateTime]::UtcNow
    Update-PageVideo
    Update-CourseVideos
  }
  if ($script:view -eq 'library' -and ([DateTime]::UtcNow - $script:lastLibraryAt).TotalSeconds -gt 2) { Update-Library }
  # While a build runs on the open course, its contents refresh at most every 3 s; its last word always lands.
  $isDue = $build -and ([string]$build.state -ne 'running' -or ([DateTime]::UtcNow - $script:lastCourseAt).TotalSeconds -gt 3)
  if ($script:view -eq 'course' -and $build -and [string]$build.courseId -eq $script:courseId -and $isDue) {
    $script:lastCourseAt = [DateTime]::UtcNow
    Invoke-Helper 'course.get' @{ id = $script:courseId } {
      param($Result, $Context)
      if ([string]$Result.course.id -ne $script:courseId) { return }
      $script:courseData = $Result
      Show-Contents
      # The page on screen was waiting to be written, or rewritten: show the new one.
      $info = @($Result.course.pages) | Where-Object { [int]$_.n -eq $script:pageNumber } | Select-Object -First 1
      $wasWaiting = ($script:pageData -and -not $script:pageData.page) -or $script:shownPageStatus -eq 'todo'
      if ($info -and [string]$info.status -eq 'written' -and $wasWaiting) { Open-Page $script:pageNumber }
      elseif ($script:pageData) { Show-PageHeader }
    }
  }
}

$script:focusLater = $null
function Step-Views {
  if ($script:focusLater) {
    [void]$script:focusLater.Focus()
    $script:focusLater.SelectAll()
    $script:focusLater = $null
  }
  # An armed "remove?" goes back to what it said once its time is up.
  if ($script:armed -and [DateTime]::UtcNow -ge $script:armed.until) { Reset-Armed }
  Sync-AppearanceSection
  # Restore a page's scroll once it has laid out.
  if ($script:pendingScroll -and $script:view -eq 'course') {
    $scroll = Get-ReaderScroll $script:ui.reader
    $script:pendingScroll.tries++
    if ($scroll -and ($scroll.ScrollableHeight -gt 0 -or $script:pendingScroll.tries -gt 10)) {
      $scroll.ScrollToVerticalOffset($script:pendingScroll.ratio * $scroll.ScrollableHeight)
      $script:scrollSaved = $script:pendingScroll.ratio
      $script:pendingScroll = $null
    } elseif ($script:pendingScroll.tries -gt 30) { $script:pendingScroll = $null }
    return
  }
  # Remember where the page was read to, a second after it stops moving.
  if ($script:view -eq 'course' -and $script:pageData -and $script:pageData.page) {
    $scroll = Get-ReaderScroll $script:ui.reader
    if (-not $scroll) { return }
    $ratio = if ($scroll.ScrollableHeight -gt 0) { [double]$scroll.VerticalOffset / [double]$scroll.ScrollableHeight } else { 0.0 }
    if ([Math]::Abs($ratio - $script:scrollSeen) -gt 0.001) {
      $script:scrollSeen = $ratio
      $script:scrollSavedAt = [DateTime]::UtcNow
      return
    }
    if (([DateTime]::UtcNow - $script:scrollSavedAt).TotalMilliseconds -gt 1000 -and [Math]::Abs($ratio - $script:scrollSaved) -gt 0.01) { Save-Progress }
  }
}
