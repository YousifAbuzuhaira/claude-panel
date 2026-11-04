# CLAUDE.md: claude-panel

For Claude working in, installing, or porting this repo. Humans: start at README.md.

The author's setup is Windows 10/11 + Claude Code in WSL2 (Ubuntu) + WezTerm. A macOS port (any terminal, zsh or bash) sits beside it: a native floating panel and windows (`mac/ClaudePanel.swift`) over browser pages served by `web/server.mjs`. Anywhere else the panel is a Claude Code pane drawn by `register.tsx` and the pages open in the browser. Everything platform-specific sits in the front ends. The core is three plain contracts, below, plus `releases.json`, that any front end can use.

## Layout

```
.claude-plugin/marketplace.json   marketplace "claude-panel" → plugin "progress" at ./progress
progress/
  .claude-plugin/plugin.json
  hooks/register.tsx              the plugin: hooks, the phases_write tool, /phases, panel life, Learn status poll
  hooks/*.ts                      pure helpers (phases schema + guide, test-command wrapping, output parsing, panel state, pane.ts for the pane)
  web/server.mjs, web/web.sh      the local web server (macOS/Linux): Learn + games in the browser, bridged to learn.sh serve
  web/public/                     the browser pages: learn/, games/ (the hub) and games/<sudoku|2048|typing|chess>/
  web/public/shared/              api.js (the server), theme.js + theme.css (the colour scheme, the twin of Theme.ps1), look.js (load/save/follow it)
  web/tests/                      node:test tests for the games, the server, Learn's look, the theme and the releases
  mac/ClaudePanel.swift           the macOS window app (AppKit + WKWebView): server.mjs builds it with swiftc on first use, caches it by source hash, and opens each page in it; the browser is the fallback
                                  also the floating panel (--panel mode, drawing mac/panel.html from phases.json, following the terminal window; iTerm2's exact window via AppleScript)
  widget/Theme.ps1                the colour scheme and see-through every WPF window wears (contract 3): roles, live brushes, appearance.json
  widget/Chrome.ps1               the shared WPF pieces: marks, buttons, chips, stat boxes, grip, swatches, opacity bars, halo, window switcher
  widget/Presets.json             the colour-scheme presets (Ember is today's look and the default)
  widget/PhasesWidget.ps1         the floating panel (Windows PowerShell 5.1 + WPF)
  widget/Learn.ps1 (+ LearnRender.ps1, LearnViews.ps1, LearnCore.cs)   the Learn window
  widget/{Sudoku,Game2048,TypeTest,ChessPuzzles}.ps1, ChessCore.cs, *.txt   the games and their data
  learn/*.mjs, learn/learn.sh     Learn's helper (Node 22, no dependencies): library, builds, chats, prompts
                                  diagram.mjs (Mermaid subset -> laid-out diagram blocks), documents.mjs (PDF via pypdf,
                                  .docx via its own zip reader, Markdown, HTML -> sections), chats.mjs (Claude Code chats
                                  listed, found and shrunk to text, secrets masked)
  releases.json                   what each version brought: the Releases tab in every panel
  hooks/releases.ts, hooks/pages.ts   reading releases.json; the one TypeScript list of pages and windows
  tools/build-*.mjs               rebuild the chess puzzles / pieces from their public sources
  tools/snap.sh, snap-views.sh    draw WPF windows to PNGs in any scheme and opacity, away from the person's prefs
  tools/shoot.mjs                 screenshots of web pages and mac/panel.html, and review sheets (Playwright's Chromium)
  tools/check-releases.mjs        the releases.json lint; tools/fixtures/ holds panel states for snapshots
  tests/, learn/tests/            plugin tests (claude-code/testing) and Learn helper tests (node:test)
  tests/theme-vectors.json        the palettes both theme derivations must give (ThemeVectors.ps1 checks the PowerShell side)
  tsconfig.json                   type-checks the hooks against the engine's types (.claude-plugin/types, written by the engine, not committed)
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

`register.tsx` writes `phases.json` on every setup. It starts the WPF panel only when `TERM_PROGRAM=WezTerm` and `WSL_DISTRO_NAME` are set (`panelDistro`). On macOS it starts the floating panel instead: the window app in panel mode (`macPanelArgv` in `hooks/widget.ts`, binary from `web.sh app-path`), speaking the same ready/closed/alive events as the WPF panel. Anywhere else, or if that panel can't start, it opens a Claude Code pane (`PANE_ID` in `hooks/pane.ts`). Off WSL it also sets a one-line `$.ui.status`, and `/learn` and `/games <name>` open the browser through `web/web.sh open <page>`. On WSL (any terminal) those two commands start the WPF windows instead (`windowArgv` in `hooks/widget.ts`). Test tracking runs under bash and zsh: the wrapper reads `${PIPESTATUS[0]:-${pipestatus[1]}}` and defines its shadows as `function name { …; }`.

## Contract 1: the panel state file

`/tmp/claude-progress/<session>/phases.json`, rewritten whole on every change, version 2:

```json
{
  "v": 2,
  "sessionId": "…",
  "title": "the chat's title (optional)",
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
| start | `hello` → `{settings, status, ytDlp, resumed, reviewDue}` |
| settings | `settings.get`, `settings.set {change}` (`library`, `models.build`, `models.chat`, `workFolders`) |
| library | `library.get` → `{categories, courses, jobs, status, reviewDue}` |
| categories | `category.add {name}`, `category.rename {id, name}`, `category.remove {id, moveTo}` |
| courses | `course.get {id}`, `course.update {id, title?, summary?}`, `course.setCategory {id, category}`, `course.remove {id}` (also removes the concepts only that course taught; not ones added by hand), `course.refresh {id}` (*Update this course*: the same sources built again as a new course) |
| pages | `page.get {courseId, n}` → `{page, glossary, answers, concepts, chat, progress, total, skipped}` (also marks its concepts Seen), `page.rename {courseId, n, title}`, `page.move {courseId, n, delta}`, `page.remove {courseId, n}`, `page.skip {courseId, n, skip}`, `page.rewrite {courseId, n, note}`, `page.add {courseId, topic, after}`, `progress.set {courseId, n, scroll}` |
| checks | `check.answer {courseId, n, id, choice}` → `{right}`, `check.flag {key}` ("this question is wrong"; `key` is `<courseId>/<n>/<id>`), `review.list` → `{items:[{key, courseId, n, courseTitle, pageTitle, check}], waiting, done, cap, next}`, `review.answer {key, choice}` → `{right}` |
| concepts | `concept.list`, `concept.learn {id, learned, courseId?, n?}`, `concept.add {text, category}`, `concept.update {id, name?, definition?, parent?}`, `concept.move {id, category}`, `concept.merge {keep, drop}`, `concept.remove {id}`, `concept.tidy`, `concept.prune` (concepts no course teaches) |
| overlap | `overlap.get {courseId}`, `overlap.apply {courseId, skip}` |
| chats | `chat.get {courseId, n \| advisor:true, chatId}`, `chat.send {…, text}` (answers `{key}`, then streams events), `chat.stop {key}`, `chat.clear {…}`; Ask's chats: `advisor.list` → `[{id, title, createdAt, updatedAt, count}]`, `advisor.remove {chatId}` |
| builds | `build.start {topic \| link \| file, name \| chat, focus; category, mode: pick\|auto}`, `build.pick {jobId, picks}`, `build.resume {jobId}`, `build.cancel {jobId}`, `build.dismiss {jobId}`, `jobs.list`, `claudeChats.list` → `[{id, title, project, cwd, at, size}]` |
| tools | `deps.check`, `deps.install` (yt-dlp) |

**Rules a front end must keep:**

- A page's `n` is its permanent id. Its **order** is its position in `course.pages`; show "page X of Y" by position.
- **Learned** is set only by the person's own action, and only once they've passed. `concept.learn {learned:true}` is refused until the concept has `passed` (Claude judged a closing question right: a reply's `[[mark-learned: …]]`, recorded by `chat.mjs`). Unmarking is always allowed, and `concept.add` (*Add as learned*) stays open for what they already know. Never mark anything learned automatically.
- A chat reply's `offers` (concept ids) become a *Mark learned* button, and its `builds` (`{topic, category}`) become *Build* buttons, which build straight away. Two or more also get *Build all as one course* (their topics joined by `; `).
- **Ask's chats:** a window makes a new chat's id itself (`a` + letters and digits), so the streaming key `advisor:<id>` never changes mid-reply. A chat is saved, titled by its first question, when that question is sent. Before there were several, there was one `advisor/chat.json`; it becomes the first chat and is renamed `chat.json.moved`.
- **Blocks:** a page's and a reply's blocks are `h p code ul ol quote hr table`, plus `callout` (`{kind: example|key|warning|analogy, title, blocks}`, from `> [!example] Title`), `check` (below) and `diagram`. That is a ```mermaid block (`flowchart`/`graph` TD/LR/BT/RL, or `sequenceDiagram`) that `learn/diagram.mjs` laid out: `{w, h, font, line, small, smallLine, nodes:[{x, y, w, h, shape, lines}], edges:[{pts, dash, thick, head, tail, life, label?}], frames, source}`. It carries positions only; a front end draws it in its own colours, scaled by its text size over `font` and never wider than the column. One it can't read stays `code`, and a front end that doesn't know `diagram` skips it.
- **Quick checks:** a `check` block is `{id, guess?, q, options:[{inlines, why, right?, i?}], concepts}`, placed at the end of its section. The window shows the result without asking Claude, and tells the helper with `check.answer`; `page.get`'s `answers` (`{id: choice}`) brings earlier answers back. A front end must show `why` for every option.
- **Terms:** `page.get` marks words as it's read (`terms.mjs`), so an inline's `term` is a place in its `glossary` (`[{term, def}]`). Words come from the page, its course (`course.terms`) and the catalogue, at first use in each section, leaving out what's Learned. `page.terms` entries with `key` show at the top with `page.outcomes`.
- **A page's making** (`makePage` in `build.mjs`, rules in `teach.mjs`): one call writes it, a second reads the finished page and writes `terms`, quick checks and closing questions (`page.checks`), a third sees only the page and answers blind. A question stays only if its quote is on the page, a quick check's quote isn't marked (added), and the blind reader agrees. One repair, then what fails is dropped. Every concept ends with a closing question. `page.stats` counts all this.
- **What was asked for:** `job.asks` and `course.asks` list each thing named, sources and pages say what they cover (`covers`), and `course.notCovered` shows what nothing covers. Pages have `part` and `outcomes`.
- **Review** (`review.mjs`, `review.json`): a quick check's first answer puts it on a fixed ladder of 1, 3, 7, 21 and 60 days; wrong goes back to tomorrow. At most 8 a day, and what's over waits unshown. A guess never comes back, and a flagged question is gone from the page and from review. A concept's `recall` is the longest gap a right answer crossed.
- **Sources:** `youtube` and `web` come from research. `doc` is a document: the build keeps a copy, `courses/<id>/sources/<sid>.document.<ext>` (`page.source.file`). `chat` is a brief written from a Claude Code chat. Both have sections and are cited `[sec: Heading]` with no link. A web page's upload goes to `<config>/uploads/` (`POST /api/upload`), and `build.start` moves it in.

The helper also works as a CLI (`learn.sh build start|list|run|pick|resume|cancel`, `chats`, `extract <file>`, `settings`, `deps`, `library`, `status`, `transcript <url>`, `ping`). `/course <what>` in a chat runs `learn.sh build start --chat <session> --focus <what>` (`courseArgv` in `hooks/learn.ts`).

**Every Claude call Learn makes** runs:

```
claude -p --safe-mode --restricted --strict-mcp-config --permission-mode dontAsk
```

- The prompt goes on **stdin**, because `--tools` takes several values and would swallow a trailing prompt.
- Tools go in **both** `--tools` and `--allowedTools`, because `dontAsk` denies anything else.
- `--bare` can't be used: it only accepts `ANTHROPIC_API_KEY`, not a subscription login.
- `CLAUDE_PROGRESS_OFF=1` makes this plugin step aside inside those runs.
- A course from a chat makes one run with `Read`, `Grep` and `Glob` only, in a folder holding just the chat's text (`jobs/<id>.chat/chat.txt`, removed afterwards). It also gets `--add-dir` for the chat's working folder, so it can read the code as it is now. Nothing ever writes to the chat it reads.
- A PDF's text comes from pypdf, run with `python3 -I` straight from its wheel (`deps.mjs ensurePypdf`: PyPI's sha256 checked, refreshed after 30 days). Claude reads only pages with no usable text. Its `Read` tool takes a whole PDF of 10 pages or fewer without poppler, so pypdf cuts those pages out first.

## Contract 3: the appearance

One file per machine holds the colour scheme and how see-through each group of windows is: `%LOCALAPPDATA%\ClaudePhases\appearance.json` on Windows (read by every WPF window), `~/.config/claude-panel/appearance.json` on macOS and Linux (read by the Swift panel and windows and by `server.mjs`; `CLAUDE_PANEL_APPEARANCE` overrides both for tests and snapshots). Written whole, atomically, UTF-8 without a BOM:

```json
{ "v": 1, "preset": "ember", "colors": { "bg": "#1C1D20", "accent": "#E08A5F", "text": "#E8E6E3" },
  "opacity": { "panel": 0.92, "learn": 0.96, "games": 0.95 } }
```

- Missing or bad fields fall back one by one to these defaults (today's look). `colors` is always written in full; `preset` only says which swatch to ring (`custom` once edited).
- **Three colours make every role** (`ink dim faint accent accentSoft selected onAccent green red gold blue *Soft line rule edge hover pressed surface surface2 button well codeBg codeInline codeInk scroll popup cardFill veil`). The derivation exists twice, `Get-ThemePalette` in `widget/Theme.ps1` and `derivePalette` in `web/public/shared/theme.js`, and both must give exactly `tests/theme-vectors.json`. Change them together and regenerate the vectors on purpose. Swift never derives: `mac/panel.html` loads `theme.js`.
- **Opacity is the background's only:** `cardFill` carries it (never below 0.15, where a layered window stops taking clicks); every surface is a tint of the text, so it fades with the card; text, lines and accents stay solid. Secondary text moves toward the text as the background clears, and below 0.85 the text gets a halo of the card colour (`New-UiHaloFrame`; the panel its own from 0.8; `games/legible.js` on the web).
- **Live:** every WPF window calls `Update-Theme` on its timer (it looks at the file's stamp once a second and recolours the brushes in place); web pages call `watchAppearance(group)` (every 2 s) and paint first from `GET /look.css?group=`; the Mac panel reads the file on its tick.
- **Edited in:** the panel's ◐ strip (presets, the three bars, *Custom colours →*), Learn ▸ Settings ▸ Appearance (WPF and web: presets, your own three colours, the bars, *Reset to Ember*), and ⌘[ / ⌘] in a Mac window.
- Game-owned colours stay the game's: 2048's tiles, the chess board and pieces, Typing's Monkeytype themes (its default, `auto`, follows the scheme).

## Releases

`progress/releases.json` is the Releases tab of every panel (WPF, Mac, pane; an *About* block in web Learn's Settings):

```json
{ "v": 1, "releases": [ { "version": "0.3.0", "date": "2026-10-29", "by": "Yousif", "notes": ["…", "…"] } ] }
```

Newest first; the newest is the version in `plugin.json`; 1 to 3 notes of at most 70 characters, written for the person using it; `by` is a first name. `node progress/tools/check-releases.mjs` checks it. Installs have no `.git`, so this file is the only history a panel can show.

## Between windows

- **One list of windows:** `$UI_SIBLINGS` in `Chrome.ps1` (WPF), `hooks/pages.ts` (TypeScript), the page regexes and titles in `server.mjs` (web). ▦ in the panel and in every Learn or game window opens the others (`Open-Sibling` / `New-UiSwitcherRow`).
- **Learn deep links:** `Learn.ps1 -View library|course|review|learned|ask|settings -CourseId <id>`. For a Learn that is already open, the opener writes `%LOCALAPPDATA%\ClaudePhases\learn-open.json` (`{view, courseId, at}`, honoured within 15 s, then deleted) with `Write-LearnRequest`; a second Learn does the same before it brings the first forward. On macOS `web.sh open learn --view <v> --course <id>` loads `/learn/?view=&course=`, and an open window gets the path through `~/.cache/claude-panel/windows/<id>.open`. `/learn [view]` uses all of this.
- **Owned windows from WSL:** the panel's `ready` event carries WezTerm's window handle; `register.tsx` passes it as `-OwnerHwnd` so windows opened by `/learn` and `/games` follow WezTerm. Before the panel is up they open on their own.

## Porting to another setup

macOS, Linux and other terminals are built (0.2.0 and 0.3.0); what's left is **native Windows without WSL** (step 7 of [docs/PORTING.md](docs/PORTING.md)) and a first run on Linux. A new front end reads contracts 1 and 3 and `releases.json`, and talks contract 2. The guide's design notes still hold:

- **Keep the contracts.** Add front ends beside the PowerShell ones, gated so WezTerm-on-WSL keeps its windows.
- **Panel:** a Claude Code pane drawn by `register.tsx` itself (`$.ui.open` plus a `ui.render` hook on `Pane`), in any terminal on any OS. Load Claude Code's built-in `plugin-authoring` skill first.
- **Learn and the games:** a dependency-free local web app. A Node `http` server bridges HTTP + Server-Sent Events to `learn.sh serve` and serves plain HTML/JS.
  - It listens on 127.0.0.1 only, needs a per-launch token on every request, and refuses foreign Origins.
  - A pane can't do this job: the plugin writes a child's stdin only once, and `$.http.fetch` doesn't stream.
- **Test tracking under zsh:** `wrap.ts` reads `${PIPESTATUS[0]}`, which is bash-only.
- **Native Windows:** POSIX paths and `rm` in the hooks; `/`-only paths and `:`-split PATH in `learn/settings.mjs`.

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
- **WPF brushes from `Theme.ps1`** are recoloured in place: assign the role brush objects themselves, never copies, and use `New-ThemeTint` for a colour that isn't a role. Never put a role brush into a `ResourceDictionary` yourself: a style or template that resolves it freezes it, and the next scheme change throws. `Add-ThemeResources` gives styles brushes of their own and replaces them on a change.
- **C# in the widgets** is compiled by the legacy C# 5 compiler: no `$"…"`, no `?.`, no `out var`. No PowerShell may run on a background thread, so C# threads fill fields that a `DispatcherTimer` drains.
- **WPF FlowDocument:** clickable things inside a document must be real `Button`s. The text selection takes the mouse on press, so a `Border` with `MouseLeftButtonUp` never fires.
- **From WSL,** `powershell.exe` sometimes fails with `UtilAcceptVsock accept4 failed 110`. Retry it.

## Shipping a change

- Installs from GitHub are cached per version in `~/.claude/plugins/cache/claude-panel/progress/<version>/`. **Bump `version` in `progress/.claude-plugin/plugin.json` with every change you push**, so `claude plugin update progress@claude-panel` picks it up, **and add its entry at the top of `progress/releases.json`** (who, when, what's new in 1-3 short lines). `node progress/tools/check-releases.mjs` catches a bump without one.
- The author works in `~/.claude/mods` (this repo), which is installed from that folder, so edits show after `/reload-plugins` there.

## Checks before you share a change

- `claude plugin validate ./progress`
- Parse every `.ps1` you touched:

  ```bash
  powershell.exe -NoProfile -Command '[void][System.Management.Automation.Language.Parser]::ParseFile("<\\wsl.localhost path>", [ref]$null, [ref]$e); $e'
  ```
- Draw a window you touched to a PNG and look at it, in more than one scheme and opacity:
  - `progress/tools/snap-views.sh --schemes "ember paper hc" --opacities "def 0.4" <out-dir> panel|learn|sudoku|2048|typing|chess` draws every standard view (Learn from a **copy** of the library); `progress/tools/snap.sh --scheme paper --opacity 0.4 out.png <Script.ps1> [args]` draws one. Both run the window with `LOCALAPPDATA` pointed at a scratch folder, so the person's prefs are never read or written.
  - The panel's own switches: `-StateFile <fixture> -SnapshotTab phases|tests|learn|releases -SnapshotLook open|closed -SnapshotStrip look|games`; Learn's: `-SnapshotView library|course|overlap|review|learned|ask|settings -SnapshotLibrary <a COPY> -SnapshotConfig <an empty folder>`. Never point Learn at a real library.
  - `node progress/tools/shoot.mjs sheet out.png label=a.png …` puts PNGs over a dark terminal-like and a light backdrop, which is how see-through has to be judged.
- `node progress/tools/check-releases.mjs` after a version bump.
- `node --check` every `learn/*.mjs` you touched. For the hooks, `tsc -p progress` type-checks against the engine's types when they are there.
- Tests: `claude plugin test ./progress`, `node --test progress/learn/tests/`, `node --test 'progress/web/tests/*.test.mjs'` (the browser pages, the server, the theme and the releases; the folder form fails on Node 24), and `powershell.exe -File progress\tests\ThemeVectors.ps1` (the PowerShell theme against the vectors).
- Web pages (macOS/Linux): `node --check` every `progress/web/**/*.js` you touched, and screenshot them against a **copy** of a library: start `LEARN_LIBRARY=<copy> LEARN_CONFIG_DIR=<empty folder> CLAUDE_PANEL_SAVES=<empty folder> CLAUDE_PANEL_APPEARANCE=<scratch file> CLAUDE_PANEL_NO_BROWSER=1 node progress/web/server.mjs serve`, read the port and token from `<config>/web.json`, then `node progress/tools/shoot.mjs page out.png "http://127.0.0.1:<port>/learn/#token=<token>" --wait <selector>`. `mac/panel.html` draws with `shoot.mjs file … --eval "setAppearance(…); render(…)"`. Run the tests only as your own working rules allow.
