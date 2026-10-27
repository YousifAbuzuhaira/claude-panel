# CLAUDE.md: claude-panel

For Claude working in, installing, or porting this repo. Humans: start at README.md.

The author's setup is Windows 10/11 + Claude Code in WSL2 (Ubuntu) + WezTerm, and only that setup has been run. Everything platform-specific sits in the front ends (the PowerShell windows). The core is two plain contracts, below, that any new front end can use.

## Layout

```
.claude-plugin/marketplace.json   marketplace "claude-panel" → plugin "progress" at ./progress
progress/
  .claude-plugin/plugin.json
  hooks/register.tsx              the plugin: hooks, the phases_write tool, /phases, panel life, Learn status poll
  hooks/*.ts                      pure helpers (phases schema + guide, test-command wrapping, output parsing, panel state)
  widget/PhasesWidget.ps1         the floating panel (Windows PowerShell 5.1 + WPF)
  widget/Learn.ps1 (+ LearnRender.ps1, LearnViews.ps1, LearnCore.cs)   the Learn window
  widget/{Sudoku,Game2048,TypeTest,ChessPuzzles}.ps1, ChessCore.cs, *.txt   the games and their data
  learn/*.mjs, learn/learn.sh     Learn's helper (Node 22, no dependencies): library, builds, chats, prompts
  tools/build-*.mjs               rebuild the chess puzzles / pieces from their public sources
  tests/, learn/tests/            plugin tests (claude-code/testing) and Learn helper tests (node:test)
```

## How it fits

```
Claude ─ phases_write tool ─┐
Claude ─ Bash test command ─┤  hooks/register.tsx
                            ▼
      /tmp/claude-progress/<session>/phases.json   ← contract 1, rewritten on every change
                            │  (author's setup: read over \\wsl.localhost by PhasesWidget.ps1)
                            ▼
      a panel (today: PowerShell + WPF, owned by the WezTerm window)

Learn window ─ JSON lines ─ learn/learn.sh serve   ← contract 2
                                 │ builds run detached: learn.mjs build run <job>
                                 ▼
      <library>/ (default ~/.claude/learn)  +  ~/.config/claude-learn/{settings,status}.json
```

`register.tsx` starts the panel only when `TERM_PROGRAM=WezTerm` and `WSL_DISTRO_NAME` are set (`panelDistro`). Elsewhere it shows one toast and keeps writing the state file.

## Contract 1: the panel state file

`/tmp/claude-progress/<session>/phases.json`, rewritten whole on every change, version 2:

```json
{
  "v": 2,
  "sessionId": "…",
  "plan": { "title": "…", "items": [{ "name": "…", "status": "todo|in_progress|done" }], "done": 1, "total": 3 },
  "runs": [{ "id": "…", "label": "pnpm test", "status": "running|passed|failed", "count": "12/40", "ratio": 0.3, "passed": 12, "failed": 0, "skipped": 0 }],
  "focus": "<id of the newest run>",
  "totals": { "runs": 1, "tests": 12, "passed": 12, "failed": 0 },
  "learn": { "build": { "topic": "…", "state": "running|waiting-picks|paused|failed|done", "message": "…", "done": 4, "total": 12 } | null,
             "course": { "title": "…", "page": 3, "total": 12, "next": "…" } | null } | null
}
```

`plan` is `null` with no plan open. When the file disappears, the session is over and the panel should close (today's panel does so 2 s later).

A panel prints one JSON line per event on stdout: `{"event":"ready"}` once drawn, and `{"event":"closed"}` when the person dismisses it. `register.tsx` treats `closed` as "hide until a new plan, a new run, or `/phases`". It starts the panel with `$.process.spawn({ argv })`, using the argv from `widgetArgv` in `hooks/widget.ts`. That's the one place to change for another platform.

## Contract 2: Learn's helper

Start it with `bash learn/learn.sh serve`, which finds Node 22 and `claude` even under a bare PATH. Then talk to it in JSON lines:

- **Request:** `{"rid": 1, "cmd": "page.get", "courseId": "…", "n": 3}`. It's `rid`, not `id`, because many commands carry an `id` of their own.
- **Answer:** `{"rid": 1, "ok": true, "result": …}` or `{"rid": 1, "ok": false, "error": "…"}`.
- **Events** (no `rid`):
  - `ready`;
  - `status`: the content of `~/.config/claude-learn/status.json`, whenever it changes;
  - `chat.delta` `{key, text}`, `chat.tool` `{key, text}`, `chat.done` `{key, message}` and `chat.error` `{key, error}`;
  - `fatal`.
- Output is ASCII, with everything else `\u`-escaped. The helper exits when stdin closes.

**Commands** (fields after the name):

| Area | Commands |
|---|---|
| start | `hello` → `{settings, status, ytDlp, resumed}` |
| settings | `settings.get`, `settings.set {change}` (`library`, `models.build`, `models.chat`, `workFolders`) |
| library | `library.get` → `{categories, courses, jobs, status}` |
| categories | `category.add {name}`, `category.rename {id, name}`, `category.remove {id, moveTo}` |
| courses | `course.get {id}`, `course.update {id, title?, summary?}`, `course.setCategory {id, category}`, `course.remove {id}` |
| pages | `page.get {courseId, n}` (also marks its concepts Seen), `page.rename {courseId, n, title}`, `page.move {courseId, n, delta}`, `page.remove {courseId, n}`, `page.skip {courseId, n, skip}`, `page.rewrite {courseId, n, note}`, `page.add {courseId, topic, after}`, `progress.set {courseId, n, scroll}` |
| concepts | `concept.list`, `concept.learn {id, learned, courseId?, n?}`, `concept.add {text, category}`, `concept.update {id, name?, definition?, parent?}`, `concept.move {id, category}`, `concept.merge {keep, drop}`, `concept.remove {id}`, `concept.tidy` |
| overlap | `overlap.get {courseId}`, `overlap.apply {courseId, skip}` |
| chats | `chat.get {courseId, n \| advisor:true}`, `chat.send {…, text}` (answers `{key}`, then streams events), `chat.stop {key}`, `chat.clear {…}` |
| builds | `build.start {topic \| link, category, mode: pick\|auto}`, `build.pick {jobId, picks}`, `build.resume {jobId}`, `build.cancel {jobId}`, `build.dismiss {jobId}`, `jobs.list` |
| tools | `deps.check`, `deps.install` (yt-dlp) |

**Rules a front end must keep:**

- A page's `n` is its permanent id. Its **order** is its position in `course.pages`; show "page X of Y" by position.
- **Learned** is set only by the person's own action: a tick, or the *Mark learned* button. Never mark anything learned automatically.
- A chat reply's `offers` (concept ids) become a *Mark learned* button, and its `builds` (`{topic, category}`) become *Build this* buttons.

The helper also works as a CLI (`learn.sh build start|list|run|pick|resume|cancel`, `settings`, `deps`, `library`, `status`, `transcript <url>`, `ping`), which is enough for macOS and Linux today.

**Every Claude call Learn makes** runs:

```
claude -p --safe-mode --restricted --strict-mcp-config --permission-mode dontAsk
```

- The prompt goes on **stdin**, because `--tools` takes several values and would swallow a trailing prompt.
- Tools go in **both** `--tools` and `--allowedTools`, because `dontAsk` denies anything else.
- `--bare` can't be used: it only accepts `ANTHROPIC_API_KEY`, not a subscription login.
- `CLAUDE_PROGRESS_OFF=1` makes this plugin step aside inside those runs.

## Porting recipes

Keep the contracts. Replace only the front end, and the line in `register.tsx` that starts it.

**macOS**

- **Panel:** a small always-on-top window that polls the state file every ~500 ms. A SwiftUI app, a menu-bar app (SwiftBar/xbar reading the JSON), or a Python/Tk window all work. Start it from `register.tsx`, where `widgetArgv` builds the PowerShell argv (gate on `process.platform`/env instead of `panelDistro`). Print `{"event":"ready"}` and `{"event":"closed"}` on stdout.
- **Learn:** a window (or a local web page served by a tiny Node script) that spawns `bash learn/learn.sh serve` and speaks contract 2. Start with Library, then a reader for page `blocks` (`learn/markdown.mjs` documents the block shapes), then the chat.
- **Test tracking:** it wraps commands only when `$SHELL` is bash (`tool.call` in `register.tsx`). Adding zsh means extending `wrap.ts`.

**Linux / plain bash.** The same as macOS. A tmux pane (`tmux split-window`) running a small TUI over the state file is the simplest panel.

**Windows, Claude Code in PowerShell (no WSL)**

- The hooks run under Windows: the state file path and the `powershell.exe` argv need Windows forms, so look at `STATE_ROOT`, `windowsPath` and `widgetArgv` in `hooks/widget.ts`.
- `Learn.ps1` starts the helper with `wsl.exe -d <distro> -e bash …/learn.sh serve` (`Start-Helper`). Make it start `node <path>\learn\learn.mjs serve` instead. The helper is plain Node and runs on Windows apart from `learn.sh`, which is a bash wrapper.
- Both windows find their owner by walking up to WezTerm. Without an owner they open centred and show in the taskbar, which works fine.

**Windows + WSL with another terminal.** Today Learn and the games open by command (README). For the panel, let `panelDistro` accept other terminals and let `PhasesWidget.ps1` run unowned and topmost when no WezTerm window is found.

## Rules that bite

- **`register.tsx`:** a function that takes `$` must be declared there. Passing `$` into an imported module stops it loading, so keep other files pure. Install only one copy of the plugin, or test commands get wrapped twice.
- **Windows PowerShell 5.1:**
  - Variable names ignore case: give constants `$UPPER_SNAKE` names, never reuse a parameter's name, and keep script state as `$script:`.
  - `$input`, `$args`, `$host`, `$event`, `$matches` and `$home` are automatic variables.
  - `[Math]::Min(1, 0.5)` picks the integer overload, so cast to `[double]`.
  - A function returns everything it outputs. `[void]` any method that returns a value (`ApplyTemplate()` bit us).
  - `-f` binds looser than `,`, so wrap `"…" -f $a, $b` in parentheses inside arrays.
  - `-and` and `-or` share the same precedence.
  - `@($list)` on a `List[object]` of hashtables throws, so use `.ToArray()`.
  - Event-handler scriptblocks don't close over locals: pass data in `.Tag`.
  - Keep files ASCII and build glyphs from code points. Catch `AbandonedMutexException`.
- **C# in the widgets** is compiled by the legacy C# 5 compiler: no `$"…"`, no `?.`, no `out var`. No PowerShell may run on a background thread, so C# threads fill fields that a `DispatcherTimer` drains.
- **WPF FlowDocument:** clickable things inside a document must be real `Button`s. The text selection takes the mouse on press, so a `Border` with `MouseLeftButtonUp` never fires.
- **From WSL,** `powershell.exe` sometimes fails with `UtilAcceptVsock accept4 failed 110`. Retry it.

## Checks before you share a change

- `claude plugin validate ./progress`
- Parse every `.ps1` you touched:

  ```bash
  powershell.exe -NoProfile -Command '[void][System.Management.Automation.Language.Parser]::ParseFile("<\\wsl.localhost path>", [ref]$null, [ref]$e); $e'
  ```
- Draw a window you touched to a PNG and look at it:
  - the panel: `PhasesWidget.ps1 -StateFile <fixture> -SnapshotPath x.png -SnapshotTab phases|tests|learn -SnapshotLook open`;
  - Learn: `Learn.ps1 -SnapshotPath x.png -SnapshotView library|course|overlap|learned|ask|settings -SnapshotLibrary <a COPY of a library> -SnapshotConfig <an empty folder>`. Never point it at a real library.
- `node --check` every `learn/*.mjs` you touched.
- Tests: `claude plugin test ./progress` and `node --test progress/learn/tests/`. Run them only as your own working rules allow.
