# Learn's views, dot-sourced by Learn.ps1: Library, Course (contents, page, chat),
# Learned, Ask and Settings. Every change goes to the helper (Invoke-Helper) and the
# view redraws from its answer. Script state is always $script:, never a bare name.

$script:ui = @{}
$script:library = $null
$script:buildMode = 'pick'
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

# A list of rows whose text starts on the column's own left edge while their hover fill reaches
# $Overhang past it on both sides: the scroll area sticks out by that much, and its content is
# inset by the same, so the rows' negative margins land inside it (a scroll area clips).
function New-RowScroll($Content, [double]$Overhang) {
  $scroll = New-Scroll $Content
  $scroll.Margin = New-Gap (-$Overhang) 0 (-$Overhang) 0
  $Content.Margin = New-Gap $Overhang 0 $Overhang 0
  return $scroll
}

# A view's content, no wider than $CONTENT_MAX: stretched, so on a wide window WPF centres it.
function Set-ViewColumn($Content) {
  $Content.MaxWidth = $CONTENT_MAX
  $Content.HorizontalAlignment = 'Stretch'
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
  $heading.Margin = New-Gap 0 0 0 8
  [void]$newStack.Children.Add($heading)

  $row = New-Object System.Windows.Controls.Grid
  $row.ColumnDefinitions.Add((New-Column '*'))
  $row.ColumnDefinitions.Add((New-Column '200'))
  $row.ColumnDefinitions.Add((New-Column 'auto'))
  $row.ColumnDefinitions.Add((New-Column 'auto'))
  $topic = New-InputBox 'A topic to learn, or a YouTube video, playlist or docs link'
  $topic.holder.VerticalAlignment = 'Top'
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
  $pickChip = New-Chip 'Let me pick' 'pick' $true
  $autoChip = New-Chip 'Just build it' 'auto' $false
  $pickChip.Margin = New-Gap 0 0 6 0
  $autoChip.Margin = New-Gap 0 0 0 0
  $pickChip.ToolTip = 'Research first, then you tick which videos and pages the course is built from'
  $autoChip.ToolTip = 'Claude picks the sources and builds the course straight away'
  [void]$modes.Children.Add($pickChip)
  [void]$modes.Children.Add($autoChip)
  $buildButton = New-Button 'Build' 'primary'
  $buildButton.Margin = New-Gap 8 0 0 0
  $buildButton.ToolTip = 'Start building the course (Enter)'
  [System.Windows.Controls.Grid]::SetColumn($buildButton, 3)
  [void]$row.Children.Add($topic.holder)
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
  $topic.box.Add_KeyDown({ param($sender, $e) if ($e.Key -eq 'Return') { $e.Handled = $true; try { Submit-NewCourse } catch { Write-Failure $_ } } })
  $search.box.Add_TextChanged({ param($sender, $e) try { if ($script:library) { Show-Courses } } catch { Write-Failure $_ } })
}

function Set-BuildMode([string]$Mode) {
  $script:buildMode = $Mode
  Set-ChipOn $script:ui.pickChip ($Mode -eq 'pick')
  Set-ChipOn $script:ui.autoChip ($Mode -eq 'auto')
}

function Submit-NewCourse {
  $topic = $script:ui.topic.Text.Trim()
  if (-not $topic) { Show-Toast 'Type a topic, or paste a link'; return }
  $category = $script:ui.category.Text.Trim()
  if (-not $category) { $category = 'General' }
  Start-Build $topic $category $script:buildMode
  $script:ui.topic.Text = ''
}

function Start-Build([string]$Topic, [string]$Category, [string]$Mode) {
  $fields = @{ category = $Category; mode = $Mode }
  if ($Topic -match '^https?://') { $fields.link = $Topic } else { $fields.topic = $Topic }
  Invoke-Helper 'build.start' $fields {
    param($Result, $Context)
    Show-Toast "Building: $($Result.topic). It carries on if you close this window."
    Update-Library
  }
}

function Update-Library {
  $script:lastLibraryAt = [DateTime]::UtcNow
  Invoke-Helper 'library.get' $null {
    param($Result, $Context)
    $script:library = $Result
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
  $title = New-Text ([string]$Job.topic) $ink
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
    $why = New-Text (Get-Short ([string]$Job.error) 300) $faint
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
    $tick = New-Text $(if ($script:picks[$id]) { $GLYPH_TICKED } else { $GLYPH_BOX }) $(if ($script:picks[$id]) { $accent } else { $dim })
    $tick.FontSize = 16
    $tick.Margin = New-Gap 0 -1 10 0
    $tick.VerticalAlignment = 'Top'
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
  [void]$contentsTop.Children.Add($hideLink)
  [System.Windows.Controls.DockPanel]::SetDock($contentsTop, 'Top')
  $pageList = New-Object System.Windows.Controls.StackPanel
  [void]$contents.Children.Add($contentsTop)
  [void]$contents.Children.Add((New-RowScroll $pageList 6))
  [System.Windows.Controls.Grid]::SetColumn($contents, 0)

  # Page: capped to a reading width and centred in its column on a wide window.
  $pageArea = New-Object System.Windows.Controls.Grid
  $pageArea.MaxWidth = $READING_MAX
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
  $nav = New-Object System.Windows.Controls.DockPanel
  $nav.Margin = New-Gap -4 8 0 0
  [System.Windows.Controls.DockPanel]::SetDock($nav, 'Bottom')
  $prevLink = New-Pressable "$GLYPH_LEFT Previous" $null $dim
  $prevLink.ToolTip = 'The page before  (Left arrow)'
  $nextLink = New-Pressable "Next $GLYPH_RIGHT" $null $accent
  $nextLink.ToolTip = 'The next page  (Right arrow)'
  $skipLink = New-Pressable 'Skip this page' $null $faint
  $skipLink.ToolTip = 'Leave it out of the course; Next steps over it'
  [System.Windows.Controls.DockPanel]::SetDock($prevLink, 'Left')
  [System.Windows.Controls.DockPanel]::SetDock($nextLink, 'Right')
  $skipLink.HorizontalAlignment = 'Center'
  [void]$nav.Children.Add($prevLink)
  [void]$nav.Children.Add($nextLink)
  [void]$nav.Children.Add($skipLink)
  $reader = New-Reader
  [void]$pagePanel.Children.Add($pageTop)
  [void]$pagePanel.Children.Add($nav)
  [void]$pagePanel.Children.Add($reader)
  [void]$pageArea.Children.Add($pagePanel)

  # The overlap screen is a step of its own in the page's place (the page is collapsed while it
  # shows), drawn on the card itself, with its heading where the page's title is.
  $overlap = New-Object System.Windows.Controls.Border
  $overlap.Background = $noFill
  $overlap.Visibility = 'Collapsed'
  $overlapStack = New-Object System.Windows.Controls.StackPanel
  $overlapStack.Margin = New-Gap 0 0 8 0
  $overlap.Child = New-Scroll $overlapStack
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
  $chatInput = New-InputBox 'Ask, or answer a check question' $true
  $chatInput.box.Height = 64
  [void]$chatBottom.Children.Add($sendButton)
  [void]$chatBottom.Children.Add($chatInput.holder)
  $chatReader = New-Reader
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
  $script:ui.overlapLink = $overlapLink
  $script:ui.pageList = $pageList
  $script:ui.pageCount = $pageCount
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
  $list = $script:ui.pageList
  $list.Children.Clear()
  $position = 0
  foreach ($page in $pages) {
    $position++
    $n = [int]$page.n
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
    # Rename, reorder, rewrite and remove: under the page you're on, so the list stays tight.
    # Lined up under the title: the glyph column's width, less the action's own padding.
    $actions = New-Object System.Windows.Controls.WrapPanel
    $actions.Margin = New-Gap ($PAGE_GLYPH_WIDTH - 4) 2 0 0
    foreach ($action in @(@{ text = 'rename'; key = 'rename' }, @{ text = $GLYPH_UP; key = 'up' }, @{ text = $GLYPH_DOWN; key = 'down' }, @{ text = 'rewrite'; key = 'rewrite' }, @{ text = 'remove'; key = 'remove' })) {
      $press = New-SmallAction $action.text { param($Data, $Sender) Invoke-PageAction $Data.key $Data.n $Sender } @{ key = $action.key; n = $n }
      if ($action.key -eq 'up' -or $action.key -eq 'down') { $press.ToolTip = if ($action.key -eq 'up') { 'Move up' } else { 'Move down' } }
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
  $state = if ($pageInfo -and [string]$pageInfo.status -ne 'written' -and $script:pageData -and $script:pageData.page) { "  $GLYPH_DOT  BEING REWRITTEN" } else { '' }
  $script:ui.pageCount.Text = "PAGE $position OF $total$state"
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

  Add-Blocks $doc.Blocks $page.blocks $size
  $checks = @($page.checks)
  if ($checks.Count -gt 0) {
    $rule = New-Object System.Windows.Controls.Border
    $rule.Height = 1
    $rule.Background = $line
    $ruleHolder = New-Object System.Windows.Documents.BlockUIContainer($rule)
    $ruleHolder.Margin = New-Gap 0 8 0 12
    [void]$doc.Blocks.Add($ruleHolder)
    $heading = New-Paragraph ($size * 1.2) $accent
    $heading.FontWeight = 'SemiBold'
    [void]$heading.Inlines.Add((New-Object System.Windows.Documents.Run('Check yourself')))
    [void]$doc.Blocks.Add($heading)
    $hint = New-Paragraph ($size * 0.9) $dim
    [void]$hint.Inlines.Add((New-Object System.Windows.Documents.Run('Answer in the chat. Claude says what you got right and what you missed; when you have it, you can mark it learned.')))
    [void]$doc.Blocks.Add($hint)
    for ($k = 0; $k -lt $checks.Count; $k++) {
      $question = New-Paragraph $size $ink
      [void]$question.Inlines.Add((New-Object System.Windows.Documents.Run(("{0}. {1}  " -f ($k + 1), [string]$checks[$k].q))))
      $answer = New-Object System.Windows.Documents.Hyperlink((New-Object System.Windows.Documents.Run("answer $GLYPH_RIGHT")))
      $answer.Foreground = $blue
      $answer.TextDecorations = $null
      $answer.Cursor = [System.Windows.Input.Cursors]::Hand
      $answer.Tag = "Check $($k + 1): $([string]$checks[$k].q)`nMy answer: "
      $answer.Add_Click({
        param($sender, $e)
        try {
          Set-InputText $script:ui.chatInput ([string]$sender.Tag)
          [void]$script:ui.chatInput.Focus()
        } catch { Write-Failure $_ }
      })
      [void]$question.Inlines.Add($answer)
      [void]$doc.Blocks.Add($question)
    }
  }
  $script:ui.reader.Document = $doc
  $progress = $result.progress
  if ($progress -and [int]$progress.page -eq $script:pageNumber -and [double]$progress.scroll -gt 0) {
    $script:pendingScroll = @{ ratio = [double]$progress.scroll; tries = 0 }
  } else {
    $script:pendingScroll = @{ ratio = 0.0; tries = 0 }
  }
  Show-Chat (Get-PageKey) @($result.chat.messages) $script:ui.chatReader
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
  if ($state -eq 'seen') { Set-ChipBorder $chip $blueSoft }
  $tip = [string]$Concept.definition
  $tip += if ($state -eq 'learned') { "`n`nLearned. Click to unmark." } else { "`n`nClick to mark it learned." }
  $chip.ToolTip = $tip.Trim()
  Set-Click $chip {
    param($Data, $Sender)
    $makeLearned = [string]$Data.state -ne 'learned'
    Set-ConceptLearned ([string]$Data.id) $makeLearned
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
  $courseTitle = { param($Id) $entry = $titles.PSObject.Properties[[string]$Id]; if ($entry) { [string]$entry.Value } else { 'an earlier course' } }
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
  # Kept on one line: "here: page 4" never breaks before its number.
  $pagesText = { param($Pages) $list = @($Pages); if ($list.Count -eq 1) { "here:$($GLYPH_NBSP)page$($GLYPH_NBSP)$($list[0])" } else { "here:$($GLYPH_NBSP)pages$($GLYPH_NBSP)" + ($list -join ", ") } }

  if (@($Data.covered).Count -gt 0) {
    [void]$stack.Children.Add((New-Label ("Already learned  {0}" -f @($Data.covered).Count) 11 $green))
    foreach ($item in @($Data.covered)) {
      $when = if ($item.learned) { "learned $(Format-Date ([string]$item.learned.at))" + $(if ($item.learned.course) { " in $(& $courseTitle $item.learned.course)" } else { '' }) } else { 'learned' }
      [void]$stack.Children.Add((New-OverlapLine "$GLYPH_CHECK $($item.name)" "$when  $GLYPH_DOT  $(& $pagesText $item.pages)" $green))
    }
  }
  if (@($Data.partly).Count -gt 0) {
    [void]$stack.Children.Add((New-Label ("Partly covered  {0}" -f @($Data.partly).Count) 11 $blue))
    foreach ($item in @($Data.partly)) {
      [void]$stack.Children.Add((New-OverlapLine "$GLYPH_HALF $($item.name)" "you have $($item.have.name); this goes further  $GLYPH_DOT  $(& $pagesText $item.pages)" $blue))
    }
  }
  if (@($Data.mentioned).Count -gt 0) {
    [void]$stack.Children.Add((New-Label ("Read before, not marked learned  {0}" -f @($Data.mentioned).Count) 11 $dim))
    foreach ($item in @($Data.mentioned)) {
      $where = @($item.seen | ForEach-Object { & $courseTitle $_.course } | Select-Object -Unique) -join ', '
      [void]$stack.Children.Add((New-OverlapLine "$GLYPH_EMPTY $($item.name)" "read in $where  $GLYPH_DOT  $(& $pagesText $item.pages)" $dim))
    }
  }
  $fresh = @($Data.fresh)
  if ($fresh.Count -gt 0) {
    [void]$stack.Children.Add((New-Label ("New to you  {0}" -f $fresh.Count) 11 $accent))
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

function New-OverlapLine([string]$Name, [string]$Detail, $Fore) {
  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Margin = New-Gap 0 2 0 4
  $nameText = New-Text $Name $Fore
  $nameText.FontSize = 14
  $nameText.TextWrapping = 'Wrap'
  $detailText = New-Text $Detail $faint
  $detailText.FontSize = 11.5
  $detailText.TextWrapping = 'Wrap'
  $detailText.Margin = New-Gap 16 0 0 0
  [void]$panel.Children.Add($nameText)
  [void]$panel.Children.Add($detailText)
  return $panel
}

function Show-SkipPicks {
  $list = $script:ui.skipList
  $list.Children.Clear()
  foreach ($n in @($script:overlapData.skippablePages)) {
    $page = @($script:courseData.course.pages) | Where-Object { [int]$_.n -eq [int]$n } | Select-Object -First 1
    $ticked = $script:overlapPicks.ContainsKey([string]$n)
    $text = New-Text ("{0}  {1}. {2}" -f $(if ($ticked) { $GLYPH_TICKED } else { $GLYPH_BOX }), (Get-PagePosition ([int]$n)), $(if ($page) { [string]$page.title } else { '' })) $(if ($ticked) { $accent } else { $ink })
    $text.TextWrapping = 'Wrap'
    $text.Margin = New-Gap 0 2 0 2
    Set-Click $text {
      param($Data, $Sender)
      if ($script:overlapPicks.ContainsKey($Data)) { $script:overlapPicks.Remove($Data) } else { $script:overlapPicks[$Data] = $true }
      Show-SkipPicks
    } ([string]$n)
    [void]$list.Children.Add($text)
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
# both start on one left edge.
function Add-MessageSection($Doc, $Message, [string]$Key) {
  $size = (Get-TextSize) * 0.93
  if ([string]$Message.role -eq 'user') {
    $bubble = New-Object System.Windows.Controls.Border
    $bubble.Background = $surface2
    $bubble.CornerRadius = New-Object System.Windows.CornerRadius($UI_RADIUS)
    $bubble.Padding = New-Gap 10 6 10 8
    $inside = New-Object System.Windows.Controls.StackPanel
    $whoText = New-Text 'YOU' $dim
    $whoText.FontFamily = $monoFont
    $whoText.FontSize = $size * 0.8
    $whoText.Margin = New-Gap 0 0 0 2
    $saidText = ([string]$Message.text).Replace("`r", '')
    $said = New-Text $saidText $ink
    $said.FontSize = $size
    $said.LineHeight = $size * 1.5
    $said.TextWrapping = 'Wrap'
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
  $section.Padding = New-Gap 10 0 10 0
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
  if ($offers.Count -gt 0 -and $Key -ne 'advisor') { [void]$section.Blocks.Add((New-OfferButton $offers)) }
  foreach ($build in @($Message.builds)) { if ($build) { [void]$section.Blocks.Add((New-BuildButton $build)) } }
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

function New-BuildButton($Build) {
  $topic = [string]$Build.topic
  $button = New-DocButton ("Build this: {0}  ({1})" -f $topic, [string]$Build.category) $accentSoft $ink {
    param($Data, $Sender)
    Start-Build ([string]$Data.topic) ([string]$Data.category) 'pick'
    Set-DocButtonDone $Sender ("Building: {0}. Pick its sources in the Library" -f (Get-Short ([string]$Data.topic) 48)) $surface
    # A second click goes to the Library, where the build waits for your picks.
    $Sender.Cursor = [System.Windows.Input.Cursors]::Hand
    $Sender.ToolTip = 'Open the Library'
    $Sender.Tag = @{ action = { param($Data2, $Sender2) Show-View 'library' }; data = $null }
  } @{ topic = $topic; category = [string]$Build.category }
  $button.ToolTip = 'Start building this course; you pick its sources in the Library'
  return (New-DocBlock $button 4 4)
}

function Show-Chat([string]$Key, $Messages, $Viewer) {
  $state = Get-ChatState $Key
  if (-not $state.busy) {
    $state.messages = @($Messages)
    $state.doc = New-Document ((Get-TextSize) * 0.93)
    if ($state.messages.Count -eq 0) {
      $empty = New-Paragraph ((Get-TextSize) * 0.9) $faint
      $emptyText = if ($Key -eq 'advisor') { 'Ask what to learn next. Claude looks at what you have learned and read, and at the work folders you set in Settings, to suggest what would help you most.' } else { 'Ask about anything on this page, or answer one of its check questions. Claude knows the page and its sources.' }
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
  $button = if ($Key -eq 'advisor') { $script:ui.askSend } else { $script:ui.send }
  $shownKey = if ($Key -eq 'advisor') { 'advisor' } else { Get-PageKey }
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
  $live.Padding = New-Gap 10 0 10 0
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
  $glyph.ToolTip = if ($state -eq 'learned') { 'Learned: click to unmark' } else { 'Click to mark learned' }
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
  $where = ''
  if ($Concept.learned) {
    $where = "learned $(Format-Date ([string]$Concept.learned.at))"
    if ($Concept.learned.course) { $where += " $GLYPH_DOT $(Get-Short (Get-CourseTitle ([string]$Concept.learned.course)) 30)" }
  } elseif (@($Concept.seen).Count -gt 0) {
    $courses = @($Concept.seen | ForEach-Object { [string]$_.course } | Select-Object -Unique)
    $where = if ($courses.Count -eq 1) { "read in $(Get-Short (Get-CourseTitle $courses[0]) 30)" } else { "read in $($courses.Count) courses" }
  }
  $whereText = $null
  if ($where) {
    $whereText = New-Text $where $faint
    $whereText.FontSize = 11.5
    $whereText.MaxWidth = 260
    $whereText.TextTrimming = 'CharacterEllipsis'
    $whereText.VerticalAlignment = 'Center'
    $whereText.Margin = New-Gap 12 0 4 0
    $whereText.ToolTip = $where
    [void]$actions.Children.Add($whereText)
  }
  $keys = if ($script:mergeFrom -and $script:mergeFrom -ne $id) { @('into') }
    elseif ($script:nestFrom -and $script:nestFrom -ne $id) { @('under') }
    elseif ($script:nestFrom -eq $id) { @('top level', 'cancel') }
    else { @('rename', 'edit', 'nest', 'move', 'merge') }
  $isTarget = $keys[0] -eq 'into' -or $keys[0] -eq 'under' -or $keys[0] -eq 'top level'
  # The actions take the place of the 'learned ...' line while the pointer is on the row (they
  # are always there while picking a merge or nest target, or editing this one); otherwise they
  # take no room, so names and definitions use the whole width.
  $tools = New-Object System.Windows.Controls.StackPanel
  $tools.Orientation = 'Horizontal'
  $tools.Margin = New-Gap 12 0 0 0
  $toolsShown = $isTarget -or $script:renamingConcept -eq $id -or $script:movingConcept -eq $id -or $script:editingDefinition -eq $id
  $tools.Visibility = if ($toolsShown) { 'Visible' } else { 'Collapsed' }
  if ($toolsShown -and $whereText) { $whereText.Visibility = 'Collapsed' }
  foreach ($key in $keys) {
    $press = New-SmallAction $key { param($Data, $Sender) Invoke-ConceptAction $Data.key $Data.id $Sender } @{ key = $key; id = $id } $(if ($isTarget -and $key -ne 'cancel') { $accent } else { $faint })
    [void]$tools.Children.Add($press)
  }
  [void]$actions.Children.Add($tools)
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
    $row.Add_MouseEnter({ param($sender, $e) $sender.Resources['tools'].Visibility = 'Visible'; if ($sender.Resources['where']) { $sender.Resources['where'].Visibility = 'Collapsed' } })
    $row.Add_MouseLeave({ param($sender, $e) $sender.Resources['tools'].Visibility = 'Collapsed'; if ($sender.Resources['where']) { $sender.Resources['where'].Visibility = 'Visible' } })
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
    $definition = New-Text ([string]$Concept.definition) $faint
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
  $newChat = New-Pressable 'new conversation' $null $faint
  $newChat.FontSize = 11.5
  $newChat.Margin = New-Gap 0 0 -4 0
  $newChat.VerticalAlignment = 'Center'
  $newChat.ToolTip = 'Start the Advisor afresh'
  [System.Windows.Controls.DockPanel]::SetDock($newChat, 'Right')
  $title = New-Text 'What should I learn next?' $ink
  $title.FontSize = 15
  $title.FontWeight = 'SemiBold'
  $title.VerticalAlignment = 'Center'
  [void]$head.Children.Add($newChat)
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
  [void]$bottom.Children.Add($send)
  [void]$bottom.Children.Add($askInput.holder)
  $reader = New-Reader
  [void]$root.Children.Add($top)
  [void]$root.Children.Add($bottom)
  [void]$root.Children.Add($reader)
  $script:viewHosts['ask'].Child = $root
  $script:ui.askInput = $askInput.box
  $script:ui.askReader = $reader
  $script:ui.askSend = $send
  Set-Click $send { param($Data, $Sender) Submit-Advisor }
  Set-Click $newChat { param($Data, $Sender) Reset-Chat 'advisor' @{ advisor = $true } $script:ui.askReader }
  $askInput.box.Add_PreviewKeyDown({
    param($sender, $e)
    try {
      $shift = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Shift) -ne 0
      if ($e.Key -eq 'Return' -and -not $shift) { $e.Handled = $true; Submit-Advisor }
    } catch { Write-Failure $_ }
  })
}

function Open-Advisor {
  $state = Get-ChatState 'advisor'
  if ($state.busy) { Show-Chat 'advisor' $state.messages $script:ui.askReader; return }
  Invoke-Helper 'chat.get' @{ advisor = $true } {
    param($Result, $Context)
    Show-Chat 'advisor' @($Result.messages) $script:ui.askReader
  }
}

function Submit-Advisor { Submit-Chat 'advisor' @{ advisor = $true } $script:ui.askInput $script:ui.askReader }

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
        if ($sender.IsKeyboardFocused) { Use-CustomColors -Quiet }
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
# they changed (a swatch, another window, Reset), never while you are typing in one.
function Update-AppearanceSection {
  if (-not $script:ui.swatchRow) { return }
  $current = $script:THEME.appearance
  $script:shownAppearance = Get-AppearanceKey
  foreach ($cell in $script:ui.swatches) {
    Update-UiSwatch $cell.swatch
    $inUse = $current.preset -eq $cell.swatch.Tag.preset.name
    $cell.name.Foreground = if ($inUse) { $ink } else { $dim }
  }
  foreach ($row in $script:ui.opacityRows) { Update-UiOpacityRow $row }
  $colorsKey = '{0}|{1}|{2}' -f $current.colors.bg, $current.colors.accent, $current.colors.text
  if ($colorsKey -ne $script:shownColors) {
    $script:shownColors = $colorsKey
    foreach ($key in @('bg', 'accent', 'text')) {
      $box = $script:ui.customBoxes[$key]
      if ($box.IsKeyboardFocused) { continue }
      $box.Text = [string]$current.colors[$key]
    }
  }
  foreach ($key in @('bg', 'accent', 'text')) { Update-CustomWell $key }
}

function Get-AppearanceKey {
  $current = $script:THEME.appearance
  return '{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f $current.preset, $current.colors.bg, $current.colors.accent, $current.colors.text, $current.opacity.panel, $current.opacity.learn, $current.opacity.games
}

# Called every tick while Settings shows: a swatch or a bar here changed the scheme.
function Sync-AppearanceSection {
  if ($script:view -ne 'settings' -or -not $script:ui.swatchRow) { return }
  if ((Get-AppearanceKey) -ne $script:shownAppearance) { Update-AppearanceSection }
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
  Update-AppearanceSection
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

  foreach ($which in @(@{ key = 'build'; title = 'Model that builds courses'; note = 'Research, planning and writing the pages.' }, @{ key = 'chat'; title = 'Model for chat'; note = 'The page chats, the Advisor, and filing concepts you add.' })) {
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

function Update-TextSize {
  foreach ($key in @($script:chats.Keys)) { if (-not $script:chats[$key].busy) { $script:chats.Remove($key) } }
  if ($script:view -eq 'course' -and $script:pageData) { Show-Page }
  if ($script:view -eq 'ask') { Open-Advisor }
}

function Update-FromStatus {
  $build = if ($script:status) { $script:status.build } else { $null }
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
