# CLAUDE.md: claude-panel

For Claude working in, installing, or porting this repo. Humans: start at README.md.

The author's setup is Windows 10/11 + Claude Code in WSL2 (Ubuntu) + WezTerm. Claude Code installed on Windows itself (no WSL; its Bash tool is Git Bash) gets the same WPF windows since 0.9.0, started natively. A macOS port (any terminal, zsh or bash) sits beside them: a native floating panel and windows (`mac/ClaudePanel.swift`) over browser pages served by `web/server.mjs`. Anywhere else the panel is a Claude Code pane drawn by `register.tsx` and the pages open in the browser. Everything platform-specific sits in the front ends. The core is three plain contracts, below, plus `releases.json`, that any front end can use.

## Layout

```
.claude-plugin/marketplace.json   marketplace "claude-panel" → plugin "progress" at ./progress
progress/
  .claude-plugin/plugin.json
  hooks/register.tsx              the plugin: hooks, the phases_write tool, /phases, panel life, Learn status poll
  hooks/*.ts                      pure helpers (phases schema + guide, test-command wrapping, output parsing, panel state, pane.ts for the pane)
  web/server.mjs, web/web.sh      the local web server (every setup): Learn + games in the browser, bridged to learn.sh serve;
                                  one Learn window (`navigate`), the hand-over after an update, the chats line (/api/phases)
  web/detach.mjs                  Windows itself: starts a window on its own, hidden (the twin of `nohup ... &`)
  web/public/                     the browser pages: learn/, games/ (the hub) and games/<sudoku|2048|typing|chess>/
  web/public/shared/              api.js (the server), theme.js + theme.css (the colour scheme, the twin of Theme.ps1), look.js (load/save/follow it)
  web/tests/                      node:test tests for the games, the server, Learn's look, the theme and the releases
  mac/ClaudePanel.swift           the macOS window app (AppKit + WKWebView): server.mjs builds it with swiftc on first use, caches it by source hash, and opens each page in it; the browser is the fallback
                                  also the floating panel (--panel mode, drawing mac/panel.html from phases.json, following the terminal window; iTerm2's exact window via AppleScript)
  widget/Theme.ps1                the colour scheme and see-through every WPF window wears (contract 3): roles, live brushes, appearance.json
  widget/Chrome.ps1               the shared WPF pieces: marks, buttons, chips, stat boxes, grip, swatches, opacity bars, halo, window switcher
  widget/Presets.json             the colour-scheme presets (Ember is today's look and the default)
  widget/PhasesWidget.ps1         the floating panel (Windows PowerShell 5.1 + WPF)
  widget/Learn.ps1                Learn's launcher on Windows: opens the web Learn in an Edge app window (second screen), or brings the open one forward
  widget/WebOpen.ps1              how a Windows window asks the server for a page: wsl.exe + web.sh from WSL, node.exe on Windows itself
  widget/{Sudoku,Game2048,TypeTest,ChessPuzzles}.ps1, ChessCore.cs, *.txt   the games and their data
  learn/*.mjs, learn/learn.sh     Learn's helper (Node 22, no dependencies): library, builds, chats, prompts
                                  diagram.mjs (Mermaid subset -> laid-out diagram blocks), documents.mjs (PDF via pypdf,
                                  .docx via its own zip reader, Markdown, HTML -> sections), chats.mjs (Claude Code chats
                                  listed, found and shrunk to text, secrets masked), verify.mjs (fact-check flags),
                                  video*.mjs (a page to a video), voice.mjs + voice/ (the local voice, fetched on first use)
  releases.json                   what each version brought: the Releases tab in every panel
  hooks/releases.ts, hooks/pages.ts   reading releases.json; the one TypeScript list of pages and windows
  tools/build-*.mjs               rebuild the chess puzzles / pieces from their public sources
  tools/snap.sh, snap-views.sh    draw the panel and the games (WPF) to PNGs in any scheme and opacity, away from the person's prefs
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
                            │  (author's setup: read over \\wsl.localhost by PhasesWidget.ps1;
                            │   Windows itself: <%TEMP% with / slashes>/claude-progress/<session>/phases.json)
                            ▼
      a panel (today: PowerShell + WPF, owned by the WezTerm window)

Learn (web/server.mjs) ─ JSON lines ─ learn/learn.sh serve   ← contract 2
                                 │ builds run detached: learn.mjs build run <job>
                                 ▼
      <library>/ (default ~/.claude/learn)  +  ~/.config/claude-learn/{settings,status}.json
```

`register.tsx` writes `phases.json` on every setup. It starts the WPF panel from WSL only when `TERM_PROGRAM=WezTerm` and `WSL_DISTRO_NAME` are set (`panelDistro`). On Windows itself (`isWindowsHost`: `OS=Windows_NT` and no `WSL_DISTRO_NAME`) it starts the same panel natively with `-Terminal wezterm|mintty|wt` (`windowsTerminal`: `TERM_PROGRAM` WezTerm or mintty, or `WT_SESSION`), and the pane in any other terminal or if the panel fails; there the state and test logs go to `stateRoot(%TEMP%)`, the temp folder written with forward slashes, which Windows Node and Git Bash (where the test wrapper's `tee` runs) read as one folder, files are deleted with `del` (`removeArgv`), and the plugin never runs `bash` (on Windows that's WSL's launcher): `node` runs `web/server.mjs`, `learn/learn.mjs` and `web/detach.mjs`. On macOS it starts the floating panel instead: the window app in panel mode (`macPanelArgv` in `hooks/widget.ts`, binary from `web.sh app-path`), speaking the same ready/closed/alive events as the WPF panel. Anywhere else, or if that panel can't start, it opens a Claude Code pane (`PANE_ID` in `hooks/pane.ts`). Off WSL it also sets a one-line `$.ui.status`, and `/learn` and `/games <name>` open the browser through `web/web.sh open <page>`. On WSL (any terminal) and on Windows itself `/games <name>` starts the game's WPF window and `/learn` starts `widget/Learn.ps1`, which opens Learn in an Edge app window (`windowArgv` in `hooks/widget.ts`). Test tracking runs under bash and zsh: the wrapper reads `${PIPESTATUS[0]:-${pipestatus[1]}}` and defines its shadows as `function name { …; }`.

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

Start it with `bash learn/learn.sh serve`, which finds Node 22 and `claude` even under a bare PATH (on Windows itself, `node learn/learn.mjs serve`: `claudeBinary` finds `claude.exe`, behind npm's `claude.cmd` too). Then talk to it in JSON lines:

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
| pages | `page.get {courseId, n}` → `{page, video, glossary, answers, concepts, chat, progress, total, skipped}` (also marks its concepts Seen), `page.rename {courseId, n, title}`, `page.move {courseId, n, delta}`, `page.remove {courseId, n}`, `page.skip {courseId, n, skip}`, `page.rewrite {courseId, n, note}`, `page.add {courseId, topic, after}`, `progress.set {courseId, n, scroll}` |
| checks | `check.answer {courseId, n, id, choice}` → `{right}`, `check.flag {key}` ("this question is wrong"; `key` is `<courseId>/<n>/<id>`), `review.list` → `{items:[{key, courseId, n, courseTitle, pageTitle, check}], waiting, done, cap, next}`, `review.answer {key, choice}` → `{right}` |
| concepts | `concept.list`, `concept.learn {id, learned, courseId?, n?}`, `concept.add {text, category}`, `concept.update {id, name?, definition?, parent?}`, `concept.move {id, category}`, `concept.merge {keep, drop}`, `concept.remove {id}`, `concept.tidy`, `concept.prune` (concepts no course teaches) |
| overlap | `overlap.get {courseId}`, `overlap.apply {courseId, skip}` |
| chats | `chat.get {courseId, n \| advisor:true, chatId}`, `chat.send {…, text}` (answers `{key}`, then streams events), `chat.stop {key}`, `chat.clear {…}`; Ask's chats: `advisor.list` → `[{id, title, createdAt, updatedAt, count}]`, `advisor.remove {chatId}` |
| builds | `build.start {topic \| link \| file, name \| chat, focus; category, mode: pick\|auto}`, `build.pick {jobId, picks}`, `build.resume {jobId}`, `build.cancel {jobId}`, `build.dismiss {jobId}`, `jobs.list`, `claudeChats.list` → `[{id, title, project, cwd, at, size}]` |
| videos | `video.page {courseId, n}` → its `video` state, `video.course {courseId}` → `{voice, total, ready, waiting, old, wanted, leftMinutes, estimate}`, `video.queue {courseId, n?, again?}` (`n`: that page next; none: every page that needs one; `again`: make a current video anew), `video.swap {courseId, n}` (the earlier version and the current one change places), `video.get {courseId, n}` → the timed script, `video.audio {courseId, n}` → `{path}` (for `/api/video-audio`) |
| tools | `deps.check`, `deps.install` (yt-dlp) |

**Rules a front end must keep:**

- A page's `n` is its permanent id. Its **order** is its position in `course.pages`; show "page X of Y" by position.
- **Learned** is set only by the person's own action, and only once they've passed. `concept.learn {learned:true}` is refused until the concept has `passed` (Claude judged a closing question right: a reply's `[[mark-learned: …]]`, recorded by `chat.mjs`). Unmarking is always allowed, and `concept.add` (*Add as learned*) stays open for what they already know. Never mark anything learned automatically.
- A chat reply's `offers` (concept ids) become a *Mark learned* button, and its `builds` (`{topic, category}`) become *Build* buttons, which build straight away. Two or more also get *Build all as one course* (their topics joined by `; `).
- **Ask's chats:** a window makes a new chat's id itself (`a` + letters and digits), so the streaming key `advisor:<id>` never changes mid-reply. A chat is saved, titled by its first question, when that question is sent. Before there were several, there was one `advisor/chat.json`; it becomes the first chat and is renamed `chat.json.moved`.
- **Blocks:** a page's and a reply's blocks are `h p code ul ol quote hr table`, plus `callout` (`{kind: example|key|warning|analogy|disputed, title, blocks}`, from `> [!example] Title`; `disputed` comes only from the fact-check or the source check), `check` (below) and `diagram`. That is a ```mermaid block (`flowchart`/`graph` TD/LR/BT/RL, or `sequenceDiagram`) that `learn/diagram.mjs` laid out: `{w, h, font, line, small, smallLine, nodes:[{x, y, w, h, shape, lines}], edges:[{pts, dash, thick, head, tail, life, label?}], frames, source}`. It carries positions only; a front end draws it in its own colours, scaled by its text size over `font` and never wider than the column. One it can't read stays `code`, and a front end that doesn't know `diagram` skips it.
- **Quick checks:** a `check` block is `{id, guess?, q, options:[{inlines, why, right?, i?}], concepts}`, placed at the end of its section. The window shows the result without asking Claude, and tells the helper with `check.answer`; `page.get`'s `answers` (`{id: choice}`) brings earlier answers back. A front end must show `why` for every option.
- **Terms:** `page.get` marks words as it's read (`terms.mjs`), so an inline's `term` is a place in its `glossary` (`[{term, def}]`). Words come from the page, its course (`course.terms`) and the catalogue, at first use in each section, leaving out what's Learned. `page.terms` entries with `key` show at the top with `page.outcomes`.
- **A page's making** (`makePage` in `build.mjs`, rules in `teach.mjs`): one call writes it. The **source check** then holds the page against the exact material it was written from, both ways (`wrong`: contradicted, or a specific claim the material lacks and that isn't marked (added); `dropped`: a fact of the material on the page's subtopics that it leaves out). A **patch** (`patchPrompt`, applied by `patchSections` in `markdown.mjs`) mends only the sections that change, and the check runs once more. What is still contradicted becomes a `disputed` box with no link; what is still left out goes to `page.stats.sourceCheck`. **Size** (`learn/shape.mjs`): a page may run to at most about `pageBudget` words of prose, worked out from the words of its material (`300 + k × main + 0.3 × support`, k 2.6 for a chat brief, 1.0 for a document or web page, 0.8 for a transcript, clamped to 600-2,400, × 0.85 for a course "I was in this chat"). It's a ceiling, never a goal, and coverage outranks it: once every fix is in, a page 15% and 150 words over (`isOver`) gets one tightening patch, kept only if the source check and the blind reader then find nothing more wrong, left out, missing or unclear (`keepTighter`), and a page still over ships (`stats.over`). The planner is told about how many pages its material fills (`plannedPages`: 450 words of a brief, 1,000 of a document or web page, 1,400 of a transcript a page). `LEARN_PAGE_BUDGET=off` writes without one, to compare. **Taught once:** the plan gives each page what it `teaches`; `ownerMap` tells every writer what it explains in full, what an earlier page owns (one clause at most) and what a later page owns (name only), since pages are written in parallel. "Already learned" comes only from the course's own category (`learnedFor`). Then a second call reads the page and writes `terms`, quick checks and closing questions (`page.checks`), and a third sees only the page and answers blind. A subtopic the reader can't learn, or a decision it can't follow (`unclear`), is patched in, never by rewriting the page. A question stays only if its quote is on the page, isn't marked (added) (quick and closing alike), and the blind reader agrees. One repair, then what fails is dropped. Every concept ends with a closing question. `page.stats` counts all this. The (added) mark is `ADDED_MARK` in `markdown.mjs` and takes a reason too, `(added; illustrative values)`: never spoken in a video, never quotable.
- **Fact-check** (`verify.mjs`, the last step of `makePage`): one call with `WebSearch` and `WebFetch` only looks up the page's doubtful claims, because a page agreeing with its own sources proves nothing. A flag stays only if its quote is on the page and its evidence isn't one of the page's sources. It never rewrites: a `disputed` callout goes under the passage, and any question quoting that passage, or named by the check, is held back from the page, Review and the video. `page.disputes` keeps them. A failed call stops the build, so a page is never saved unchecked.
- **Videos** (`video.mjs`, `video-script.mjs`, `video-check.mjs`, the player in `web/public/learn/video/`): a video is `courses/<id>/videos/NN.mp3`, `NN.json` (the timed script) and `NN.meta.json`, written last, whose presence says the others are whole. Claude writes each section as scenes, as data; no generated code runs, on `models.video` (`videoEffort`: Opus low, the others high), with all of a page's sections at once. `settleScenes` first fixes what code can, then each section is played through by `simulate`, repaired up to twice, then the blind watcher and a claim check compare it with the page, both ways. The video retells the whole page except its Recap, which only says the page again, and says each fact once: each section is told which glossary words an earlier section explains (`firstTaught`), and a section whose narration runs over 1.3 × `spokenBudget` (its prose once, plus a little per code, table or diagram) gets that as a hint in a repair, or one extra try kept only if it passes and is shorter, never as a failure. The video asks the guess-first question and at most 3 others (`videoQuiz`); the blind watcher must still answer every question on the page (`allQuiz`). A section whose repairs run out keeps the scenes that pass and reads out only what the failing ones taught (`mendSection`); only one with no passing scene is rebuilt whole by `plainScenes` from the page's own blocks, and a block only left out is read out word for word, so a video always covers the page. One `video` job with no `courseId` serves the library from `videos-queue.json`, so it never locks a course. Recording sets its pace, so while a page records, the next page's script is written, one page ahead and no further. The job's `working` says what each page in hand is doing, with `leftMinutes` for each and for the job, and `buildStatus` passes them on. Made `again`, a video's old files stay as `NN.previous.*` until the next remake. A page's `videoStamp` says whether its video is current (`video.state`: `none old queued making ready stale`). Nothing re-records by itself. An older page (no `stats`) shows *Update this course* instead, since a video asks the page's quick questions. Answers go through `check.answer`, so they count towards Review. The player plays its audio from a Blob, because an audio element can't send the token; that's why the CSP has `media-src blob:`. WPF has no web engine, so `Open-InBrowser -AppWindow` opens Edge with `--app`, or the default browser.
- **The voice** (`voice.mjs`): Kokoro in Python, fetched into `~/.cache/claude-learn/voice` on the first video and run with `-I` at low priority. A pinned `uv` (checksum in the code) brings Python 3.12 and installs `voice/requirements.lock` by hash; change a pin in `requirements.in`, then run `tools/voice-lock.mjs`. It needs Linux or WSL, 64-bit Windows, or Apple Silicon on macOS 14+. Windows has its own lock, `voice/requirements.win.lock` (win_amd64 wheels, written by the same tool), so a Linux or Mac voice is never reinstalled for it; there `narrate.py` skips `os.nice` and the helper lowers the recording with `os.setPriority`. Word times need the timed export of the model, with `has_timings` forced on. MP3s are constant bitrate, because the player seeks by time.
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
- A course from a chat makes one run with `Read`, `Grep` and `Glob` only, in a folder holding just the chat's text (`jobs/<id>.chat/chat.txt`, removed afterwards). It also gets `--add-dir` for the chat's working folder, so it can read the code as it is now. The brief is one dense section per topic (up to 30): facts, not teaching. It must keep every decision with its options, what was recommended and what was chosen, every risk, rejected option and planned test, any numbered plan the focus asks about, whole, and what is done against what is only planned; it names the focus's `asks`, so the asks check runs for chat courses too. A second run (`briefCheckPrompt`, `Read` and `Grep`) holds the brief against `chat.txt`, both ways, and its fixes are merged (`mergeSections`); what it found is the source's `briefCheck`. The brief ends with a "Key facts" section (each phase of a plan with what it holds, who chose what, the numbers, and every claim the chat found false, as "FALSE: … True: …"), and every page writer, source check and patch gets it, whichever part of the brief its page teaches: that's what keeps a page from repeating a refuted idea or mixing up a plan's phases. Who it's for is the job's and the course's `audience`: `team` (the New course form's default) or `self` ("I was in this chat", `/course`'s default, since it's typed inside that chat), which leaves out the background the author lived through and makes pages 15% shorter. Nothing ever writes to the chat it reads. `LEARN_CHATS_DIR` points a scratch build at copies of chats (`CLAUDE_CONFIG_DIR` would move Claude's login too).
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
- **Edited in:** the panel's ◐ strip (presets, the three bars, *Custom colours →*), Learn ▸ Settings ▸ Appearance (the web page: presets, your own three colours, the bars, *Reset to Ember*), and ⌘[ / ⌘] in a Mac window.
- Game-owned colours stay the game's: 2048's tiles, the chess board and pieces, Typing's Monkeytype themes (its default, `auto`, follows the scheme).

## Releases

`progress/releases.json` is the Releases tab of every panel (WPF, Mac, pane; an *About* block in web Learn's Settings):

```json
{ "v": 1, "releases": [ { "version": "0.3.0", "date": "2026-10-29", "by": "Yousif", "notes": ["…", "…"] } ] }
```

Newest first; the newest is the version in `plugin.json`; 1 to 3 notes of at most 70 characters, written for the person using it; `by` is a first name. `node progress/tools/check-releases.mjs` checks it. Installs have no `.git`, so this file is the only history a panel can show.

## Between windows

- **One list of windows:** `$UI_SIBLINGS` in `Chrome.ps1` (WPF), `hooks/pages.ts` (TypeScript), the page regexes and titles in `server.mjs` (web). ▦ in the panel and in every Learn or game window opens the others (`Open-Sibling` / `New-UiSwitcherRow`).
- **Learn deep links:** `Learn.ps1 -View library|course|review|learned|ask|settings|overlap -CourseId <id>` on Windows; `web.sh open learn --view <v> --course <id>` elsewhere, which loads `/learn/?view=&course=`. `/learn [view]` uses these.
  - **One Learn window on Windows:** Learn.ps1 runs the server's `open learn …` with `CLAUDE_PANEL_LAUNCH=1` (`WebOpen.ps1`: `web.sh` through wsl.exe from WSL, `node.exe server.mjs` on Windows itself). The server answers a one-time link, `<page>/?launch=<nonce>`, or `shown: 'existing'` when a Learn page is connected: it has sent that page a `navigate` event (`{view, course}`), and the launcher brings the Edge window captioned exactly `Learn` forward, restoring it if minimised. It finds no such window? It asks again with `CLAUDE_PANEL_NEW=1` and opens one. A new window fills the first screen that isn't the main one. Learn pages name themselves on the event stream (`/api/events?page=learn`), and `document.title` stays `Learn`.
  - **The launch address** keeps the page's folder and puts the nonce in the query: Edge keys an app window's saved place on the address without its port or query.
  - **On macOS and in a browser** `open` sends an open Learn page `navigate` too (`launchLink` with `reuse`); the Mac window app is then started bare, only to come forward. A window that has no Learn page open gets the path through `~/.cache/claude-panel/windows/<id>.open`.
- **Hand-over after an update:** `/api/ping` and `web.json` carry the server's version. When the plugin's version differs (a once-a-minute check of its own folder, or `open` asking `POST /api/handover` with `{version, script}`: its own `server.mjs`, since an install from GitHub keeps each version in a folder of its own; `handoverTarget` checks that copy's `plugin.json`), the server stops listening and starts that `server.mjs` with `CLAUDE_PANEL_TAKEOVER=1`, which reuses the port and token from `web.json`. It never does this while a helper request or a chat reply is in flight. The old server ends its event streams once the new one answers, or listens again after 5 s and leaves that version alone (`shouldHandOver`). Pages reconnect within a second (`retry: 1000`), get `{event: 'server', version}` first on every stream, and show *Learn was updated* with Reload when it changes. A page without its server for 30 s says to open Learn again.
- **The chats line:** `GET /api/phases` reads every `<CLAUDE_PANEL_GLANCE_ROOT or /tmp/claude-progress, on Windows itself tmpdir()/claude-progress>/*/phases.json` (contract 1) through `phaseLine` and gives the foot of web Learn `{items, tip}`. A chat shows while its plan has phases left, a test runs, or it changed in the last 15 minutes.
- **Owned windows from WSL:** the panel's `ready` event carries WezTerm's window handle; `register.tsx` passes it as `-OwnerHwnd` so windows opened by `/learn` and `/games` follow WezTerm. Before the panel is up they open on their own.

## Porting to another setup

macOS, Linux and other terminals are built (0.2.0 and 0.3.0), and Windows without WSL (0.9.0, step 7 of [docs/PORTING.md](docs/PORTING.md)). What's left is a first run on Linux, and a run on a Mac of what 0.4.0 to 0.9.0 added (built on Windows; the Swift has not been compiled since 0.4.0). A new front end reads contracts 1 and 3 and `releases.json`, and talks contract 2. The guide's design notes still hold:

- **Keep the contracts.** Add front ends beside the PowerShell ones, gated so WezTerm-on-WSL keeps its windows.
- **Panel:** a Claude Code pane drawn by `register.tsx` itself (`$.ui.open` plus a `ui.render` hook on `Pane`), in any terminal on any OS. Load Claude Code's built-in `plugin-authoring` skill first.
- **Learn and the games:** a dependency-free local web app. A Node `http` server bridges HTTP + Server-Sent Events to `learn.sh serve` and serves plain HTML/JS.
  - It listens on 127.0.0.1 only, needs a per-launch token on every request, and refuses foreign Origins.
  - A pane can't do this job: the plugin writes a child's stdin only once, and `$.http.fetch` doesn't stream.
- **Paths in Learn:** `toLocalPath` and `isAbsoluteLocal` (`learn/settings.mjs`): inside WSL a `C:\...` path becomes `/mnt/c/...` (`toWslPath`); on Windows itself it stays as it is.

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
- **From WSL,** `powershell.exe` sometimes fails with `UtilAcceptVsock accept4 failed 110`. Retry it.
- **On Windows itself:** never start `bash` from the plugin or the server (it's WSL's launcher there, or missing); give every `spawn` `windowsHide: true` (a child of a console-less process opens a console window of its own); stop a process tree with `taskkill /T /F` (no signals); paths compare with `path.sep`. A window that must outlive the chat goes through `web/detach.mjs`: Node's `detached` starts a child with no console (Windows PowerShell then won't start), and a child that isn't detached dies with Node (its job), so a hidden `cmd /c start /b` starts it on a windowless console of its own.

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
  - `progress/tools/snap-views.sh --schemes "ember paper hc" --opacities "def 0.4" <out-dir> panel|sudoku|2048|typing|chess` draws every standard view; `progress/tools/snap.sh --scheme paper --opacity 0.4 out.png <Script.ps1> [args]` draws one. Both run the window with `LOCALAPPDATA` pointed at a scratch folder, so the person's prefs are never read or written.
  - The panel's own switches: `-StateFile <fixture> -SnapshotTab phases|tests|learn|releases -SnapshotLook open|closed -SnapshotStrip look|games`. Learn is a web page: see *Web pages* below.
  - `node progress/tools/shoot.mjs sheet out.png label=a.png …` puts PNGs over a dark terminal-like and a light backdrop, which is how see-through has to be judged.
- `node progress/tools/check-releases.mjs` after a version bump.
- `node --check` every `learn/*.mjs` you touched. For the hooks, `tsc -p progress` type-checks against the engine's types when they are there.
- Tests: `claude plugin test ./progress`, `node --test progress/learn/tests/`, `node --test 'progress/web/tests/*.test.mjs'` (the browser pages, the server, the theme and the releases; the folder form fails on Node 24), and `powershell.exe -File progress\tests\ThemeVectors.ps1` (the PowerShell theme against the vectors).
- Web pages (Learn everywhere, the games off WSL): `node --check` every `progress/web/**/*.js` you touched, and screenshot them against a **copy** of a library: start `LEARN_LIBRARY=<copy> LEARN_CONFIG_DIR=<empty folder> CLAUDE_PANEL_SAVES=<empty folder> CLAUDE_PANEL_APPEARANCE=<scratch file> CLAUDE_PANEL_GLANCE_ROOT=<a folder of fixture phases.json> CLAUDE_PANEL_NO_BROWSER=1 node progress/web/server.mjs serve`, read the port and token from `<config>/web.json`, then `node progress/tools/shoot.mjs page out.png "http://127.0.0.1:<port>/learn/#token=<token>" --wait <selector>`. `mac/panel.html` draws with `shoot.mjs file … --eval "setAppearance(…); render(…)"`. Run the tests only as your own working rules allow.
