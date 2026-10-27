# Porting claude-panel to your setup

This guide is for the Claude working in **your fork** of this repo. It builds the parts that are missing on your setup, macOS or Linux/bash above all, so you end up with what the author has: the floating panel, Learn, and the games.

Nothing here has been built or run by the author. It's a plan written from the code as it stands. macOS has never been tested at all. Treat every step as "build it, then check it", in order, one at a time.

Read [CLAUDE.md](../CLAUDE.md) first: the layout, the two contracts, and the rules that bite.

## 0. Ground rules

- **Fork first.**
  - Work in your clone of your fork.
  - Install from your fork: `claude plugin marketplace add <you>/claude-panel`, then `claude plugin install progress@claude-panel`.
  - Bump `version` in `progress/.claude-plugin/plugin.json` with every change you push, or `claude plugin update` won't pick it up.
- **Add, don't replace.**
  - The Windows + WSL2 + WezTerm path keeps its PowerShell windows.
  - New front ends sit beside them, chosen by platform: in `register.tsx`, `panelDistro` is non-null only on WezTerm-on-WSL, and that branch stays as it is.
- **Keep the two contracts:** the panel state (`phases.json`) and Learn's `serve` JSON lines. A new front end is a client of them. It never reads the library files itself.
- **Plugin code rules.**
  - `register.tsx` is the only file that calls `$`; every other module stays pure.
  - Claude Code's built-in **`plugin-authoring` skill** documents the engine, with a `pane.tsx` example and the full API types. Load it before touching `register.tsx`.
- **Tests:** write them next to the existing ones (`progress/tests/`, `progress/learn/tests/`). Run them only when the person asks.
- **Sending it back** is optional: open a PR against the original repo if the author wants it.

## The shape of a port

| Part | Build it as | Why |
|---|---|---|
| **Panel** (Phases, Tests, Learn status) | A **Claude Code pane** drawn by the plugin itself (`$.ui.open`, plus a `ui.render` hook on `{ component: 'Pane', requestId }`), plus a one-line `$.ui.status` | It works in any terminal on any OS, and in the desktop app and VS Code. The state is already in the plugin, so nothing has to be bridged. |
| **Learn** | A **local web app**: a small Node `http` server that bridges HTTP and Server-Sent Events to `learn.sh serve`, plus plain HTML/JS pages | A pane can't drive the helper: the plugin writes a child's stdin only once, and `$.http.fetch` doesn't stream, so chat replies couldn't stream either. Long lessons are also cramped in a dock limited to 45% of the width. |
| **Games** | More static pages on the **same server** | In a pane, raw keys reach a region only in fullscreen, after a click, and never include Esc. Piece images show in only a few terminals. |
| **Stockfish** | The WebAssembly build, run in the browser | One file for every OS. No per-CPU binaries, no Gatekeeper, no chmod. |

None of it needs npm dependencies; Node 22 is already required.

---

## 1. Core fixes off WSL

Small changes that make everything after them possible.

1. **Write the state file everywhere.**
   - In `register.tsx`, `doSyncPanel` returns before `$.fs.write(widgetStatePath(...))` whenever `panelDistro` is null. So off WezTerm-on-WSL, `phases.json` is never written, although CLAUDE.md says it is.
   - Move the write ahead of the distro check. Only the WPF launch needs the distro.
2. **`progress/learn/learn.sh`:**
   - Add `/opt/homebrew/bin/node` (Homebrew on Apple silicon) to the fallback list.
   - Change the fatal message "Learn needs Node 22 or newer inside WSL" to drop "inside WSL".
3. **The toasts and replies that say "needs WezTerm on WSL"** (`doSyncPanel`, and the `/phases` command's reply): once step 3 exists, they open the pane instead.

**Check:** on your machine, start a session, have Claude call `phases_write`, and look for `/tmp/claude-progress/<session>/phases.json`.

## 2. Test tracking under zsh

macOS's default shell is zsh. Test tracking only switches on when `$SHELL` ends in `bash`: see the `tool.call` hook on `Bash` in `register.tsx`.

1. Let the gate accept zsh too.
2. `wrapCommand` in `hooks/wrap.ts` builds a prefix that reads the runner's exit code from `${PIPESTATUS[0]}`, which only bash has. zsh has `$pipestatus[1]`, lowercase and counted from 1.
   - Without that, the exit marker (`\x1e@kp-exit <code>`, read in `parse.ts`) is never written correctly.
   - Exit codes are lost, background runs only settle at the 15-minute idle limit, and a failed run can look like it passed.
   - Choose by shell, or use an expansion that works in both.
3. The prefix shadows `pnpm npm npx yarn bun bunx node tsx vitest jest turbo playwright timeout env nice` with `name(){ … }` functions.
   - If the user's shell snapshot has an **alias** with one of those names, zsh fails to parse `name(){`.
   - Define them as `function name { …; }`, which both shells accept and which isn't alias-expanded.
4. Update `tests/wrap.test.ts`, which asserts the `PIPESTATUS` text.

**Check:** run `zsh -c '<the wrapped command>'` on a command that exits 1. The log must end with `@kp-exit 1`, and `$?` must be 1.

## 3. The panel as a Claude Code pane

Gate it on "not WezTerm-on-WSL", so the WPF panel stays where it works. Draw it from the same atoms `register.tsx` already keeps:
- `phases`;
- `testRuns`;
- `learn`, which `pollLearn` reads from `~/.config/claude-learn/status.json` every 3 s.

The behaviour to copy is in `widget/PhasesWidget.ps1` (the functions that draw the tabs and pick the tab in front):

**Phases tab**
- The plan's title in bold.
- One row per item:
  - done: `[✓]` in green, with the name dimmed;
  - in progress: `[▸]`, with the name bold in the accent colour;
  - todo: `[ ]`.
- Footer: "d of t done". With no plan: "No plan yet."

**Tests tab**
- Runs listed newest first, each with a mark:
  - ● while running, red if anything has failed;
  - ✓ in green once passed;
  - ✗ in red once failed.
- Under each run:
  - an 18-cell bar of `█`/`░`, all `░` while `ratio` is null;
  - the `count`;
  - `✓passed`, then `✗failed` when there are failures.
- Footer: "N tests in R run(s) · P passed[ · F failed]".

**Learn tab**
- The build line: topic, message, and a "d/t pages" bar.
  - Its colour comes from the state: failed red, waiting-picks gold, done green, otherwise the accent.
- The course in front: its title, then "Page p of t · next: …".
- A button: "Open Learn" or "Carry on reading" (step 4).

**Tab labels**
- `Phases d/t`.
- Tests: `Tests ● <count>` while a run is live, otherwise `Tests ✓` or `Tests ✗`.
- Learn: `Learn d/t` while a build runs and knows its page count, `Learn ●` while it runs without one, otherwise `Learn`.

**Which tab is in front**
- A new `focus` (newest run) brings Tests to the front.
- No plan but some runs: Tests.
- No runs while Tests is in front: back to Phases.
- Only a Learn build going: Learn.

**Collapsed**
- One line for the tab in front: the current phase and "d/t", or the newest run, or the build.
- Use it when the pane sits inline. The `placement` prop says `'inline'` or `'dock'`.

**Games**
- Buttons for Sudoku, 2048, Typing and Chess. Each opens its page (step 6).

Opening and closing:
- **Opens on its own** when something new starts: a new plan title, a new test run, a Learn build.
  - An open the plugin makes on its own seats only from 144 columns, or 110 for an id the person has opened before; below that it waits.
  - `/phases` opens it at any width.
  - Request a small `rows` for the inline placement.
- **Docks** beside the chat in Claude Code's fullscreen mode from 110 columns. Otherwise it sits inline above the prompt.
- **Closing it** (`ui.close` with origin `person`) means what ✕ means today: hidden until a new plan, a new run, or `/phases`. That's the `isDismissed` flag.
- **Also set `$.ui.status`** to a one-line summary (e.g. `Phases 2/5 · Tests ● 12/40`), so something shows even when the pane can't seat.

**Check:** `claude plugin validate ./progress` and a type-check (the skill explains `tsc` against the engine's types). Then a real session: a plan fills the pane, a test command moves its bar, and ✕ hides it until the next plan.

## 4. The local web server

A new `progress/web/server.mjs`, built on Node's own `http`, `crypto` and `child_process`.

**Security (required).** This server can start `claude -p` runs on the person's subscription, read their work folders and delete their courses. Any web page they have open can send requests to `127.0.0.1`.
- Listen on `127.0.0.1` only, on a port the OS picks.
- Make a random token at each start (`crypto.randomBytes(32)`).
- Require the token on **every** API request, the event stream included, in a custom header (for example `X-Learn-Token`).
  - A custom header forces a CORS preflight, and the server refuses foreign preflights.
  - `EventSource` can't set headers, so for `/api/events` take the token from a cookie the page sets for itself, or from a query parameter checked the same way.
- Reject any request whose `Origin` (or `Host`) isn't the server's own `127.0.0.1:<port>`. That also stops DNS rebinding.
- Put the token only in the URL the plugin opens. The page reads it from `location.hash`, so it never reaches the server's logs or the `Referer` header.

**API.**
- `POST /api/rpc`: the body is one contract-2 request without its `rid`. The server adds a `rid`, writes the line to the helper, and answers with the helper's reply `{ok, result | error}`.
- `GET /api/events`: Server-Sent Events. Every helper line without a `rid` (`ready`, `status`, `chat.delta`, `chat.tool`, `chat.done`, `chat.error`, `fatal`) goes to every connected page.
- Static files: `progress/web/public/`.
- The game data from `progress/widget/` (step 6).
- `/api/save/<game>`, to read and write game saves.

**The helper.**
- Start one `bash learn.sh serve` child, or `node learn.mjs serve` on native Windows.
- If it dies, restart it once, as the WPF window does. After that, report its last stderr in an event the page shows.
- The helper's output is ASCII, with everything else `\u`-escaped. JSON parsing undoes that.

**One instance.**
- Record `{port, token, pid}` in `~/.config/claude-learn/web.json`, chmod 600.
- A second launch finds it, checks it answers, and opens a new tab on it.
- Start the server detached, so a closed Claude session doesn't take an open Learn tab with it. Exit after about 30 minutes with no page connected.
- Builds already outlive everything: they're their own detached processes (`startDaemon` in `learn/build.mjs`).

**Opening the browser** (from `register.tsx` with `$.process.run`, or from the server):
- macOS: `open <url>`.
- Linux: `xdg-open <url>`.
- WSL with another terminal: `wslview <url>`, or `cmd.exe /c start "" "<url>"`.
- Native Windows: `cmd /c start "" "<url>"`.
- A Chromium "app window" (`--app=<url>`) gives a window without browser chrome, if the person wants that.

Add a command, `/learn` (and `/games <name>`), that starts or finds the server and opens the page. The pane's buttons do the same.

**Check:**
- `curl` with no token gets 401 or 403.
- With the token but `Origin: https://example.com` it's refused.
- With the token, `{"cmd":"hello"}` returns settings.
- `curl -N` on `/api/events` prints `status` events while a build runs.

## 5. Learn in the browser

Rebuild the WPF window in `widget/Learn.ps1`, `LearnViews.ps1` and `LearnRender.ps1` as plain HTML, CSS and JS in `progress/web/public/learn/`. No framework is needed. The window never touches files; every action is one helper command.

**Shell**
- A header with the tabs Library, Course (hidden until a course is open), Learned, Ask and Settings.
- A build chip: running, waiting for picks, failed, or done. Clicking it goes to Library.
- A toast line that clears after 5 s, red for errors.
- A red banner when the helper can't run.
- Removes need a second click within 4 s.
- Inline edits: Enter saves, Shift+Enter adds a line, Esc cancels.

**Library**
- New course:
  - a topic box (a topic, or a YouTube, playlist or docs link) and a category box;
  - mode chips, *Let me pick* (`pick`) and *Just build it* (`auto`);
  - Build sends `build.start {topic | link, category: <name>, mode}`;
  - existing categories show as chips that fill the category box.
- Search, which filters by title or topic.
- Builds:
  - one row per job from `library.get`, with a message, a progress bar and "d/t pages";
  - actions by state:
    - running: **Pause**, which sends `build.cancel`; the job then shows as `paused`;
    - waiting-picks: **Pick sources** (the picker) and **Dismiss**;
    - paused or failed: **Carry on** (`build.resume`) and **Dismiss**;
    - done: **Open course** and **Dismiss** (`build.dismiss`).
  - The picker:
    - ticks the `recommended` candidates first;
    - each row shows title, ▶ video or ↗ page, channel, minutes, level, `why`, and an open link;
    - **Build from N sources** sends `build.pick {jobId, picks}`.
- Courses, grouped by category in the catalogue's order. Categories can be renamed (`category.rename`) or removed (`category.remove {id, moveTo}`). Each course row has:
  - title, "read · learned" counts, summary;
  - rename and edit summary (`course.update`);
  - move: category chips (`course.setCategory`), plus a new-category box (`category.add`, then `setCategory`);
  - remove (`course.remove`; the toast gives how many concepts went with it).

**Course** (three columns)
- **Contents:**
  - the title, and a meta line: pages, read, concepts learned of total;
  - *What I already know* (the overlap screen);
  - the pages, each marked ◌ not written, ⊘ skipped, ● read, ○ unread;
  - under the current page: rename (`page.rename`), ↑/↓ (`page.move`), rewrite with an optional note (`page.rewrite`) and remove (`page.remove`);
  - *+ Add a page* sends `page.add {topic, after: <the current page's n>}`; `after` is an `n`, not a position;
  - the column can be hidden.
- **Page:**
  - "PAGE X OF Y" by **position** (a page's `n` is its id, not its place);
  - the title;
  - source links:
    - "▶ Watch m:ss–m:ss: title", with `&t=Ns` added to the URL when `from > 0`;
    - "↗ Read: title" for web pages;
  - concept chips (✓, ◐ or ○). A click sends `concept.learn {id, learned, courseId, n}`;
  - the page body from its `blocks` (below), then *Check yourself*: each question has an *answer →* link that fills the chat box with `Check k: <q>\nMy answer: `;
  - ← Previous / Next →, stepping over skipped pages; *Skip this page* (`page.skip`).
- **Which page opens:** the one asked for; else the current page if it's the same course; else `course.progress.page`; else the first page not skipped.
  - Ignore answers that arrive for a page no longer in front.
- **Reading position:**
  - restore `progress.scroll × scrollable height` once the page has laid out;
  - save it with `progress.set {courseId, n, scroll}` about 1 s after scrolling stops, and when leaving the page.
- **While a build writes this course** (`status.build.courseId`): fetch `course.get` again at most every 3 s, and once more when it stops. Re-open the page on screen if it was waiting and is now written.
- **The overlap screen:**
  - `overlap.get` returns `{covered, partly, mentioned, fresh, skippablePages, …}`;
  - it shows Already learned, Partly covered, Read before and New to you, plus ticks for pages you could skip;
  - *Start the course* sends `overlap.apply {skip}`;
  - it opens on its own when `course.overlap` exists and isn't `seen`;
  - closing it does **not** mark it seen;
  - when nothing is known, send `overlap.apply {skip: []}` quietly instead of showing it.
- **Chat** (right column): see below.

**Page blocks** (shapes documented at the top of `learn/markdown.mjs`)
- Blocks:
  - `h {level}`;
  - `p`;
  - `code {lang, text}`, with a *copy* link;
  - `ul` / `ol {start, items: [{depth 0–3, …}]}`, nested by `depth`;
  - `quote`;
  - `hr`;
  - `table {rows}`, where the first row is the header.
- Inlines `{s, b, i, code, link, time, added, sec}`:
  - `time` gets ▶ in front and links to the video moment;
  - `added` draws small and gold, with a "Claude added this: it is not in the sources" tooltip;
  - links open only for http(s).
- Skip unknown block types.

**Chat**
- One conversation per key: `"<courseId>:<n>"` for a page, `"advisor"` for Ask.
  - A reply keeps streaming while you switch views.
  - Ignore events for keys you don't know.
- **Send:**
  - add the user's message and a live "Claude · thinking" section;
  - send `chat.send {courseId, n | advisor: true, text}`, which answers `{key}`;
  - the button becomes **Stop** (`chat.stop {key}`).
- **Stream events:**
  - `chat.delta` appends plain text;
  - `chat.tool` sets the label beside "Claude" ("Searching: …", "Reading …");
  - `chat.done {message}` replaces the live part with the finished message, drawn from its `blocks`;
  - `chat.error` shows the error, dim if it is "Stopped".
- **Buttons inside a reply:**
  - `offers` (concept ids) becomes **Mark learned: names**, which sends `concept.learn` for each, then shows "✓ Learned";
  - `builds` (`{topic, category}`) becomes **Build this**, which always sends `build.start` in `pick` mode.
- **New thread / New conversation** sends `chat.clear`. It's refused while a reply is still coming.
- **Opening a chat** sends `chat.get`.

**Learned**
- Add something you know: `concept.add {text, category: <id>}`. The category here is an **id**, not a name.
- Filters (All, Learned, Read, New) and search over names and aliases.
- *Tidy concepts* (`concept.tidy`) lists suggested merges. Each has *merge* (`concept.merge {keep, drop}`) and *not the same*, which only hides it.
- Concepts:
  - grouped by category, as a tree by `parent`;
  - clicking a category heading makes it the target for added concepts.
- Each concept row:
  - a state glyph, which sends `concept.learn {id, learned}` with no courseId;
  - rename and edit (`concept.update`);
  - nest (`concept.update {parent}`) and move (`concept.move`);
  - merge into another (`concept.merge`);
  - an always-visible ✕ (`concept.remove`).

**Ask**
- The Advisor chat (`advisor: true`) with four suggestion chips.
- Its *Build this* buttons as above.
- *New conversation* sends `chat.clear {advisor: true}`.

**Settings** (`settings.get`, `settings.set {change}`)
- The library folder. If it changes, drop everything cached and close the Course tab.
- The build model and the chat model: Sonnet, Opus or Haiku.
- The work folders the Advisor may read.
- Text size: it scales the page, its title and the chats.
- The latest usage reading from `status.usage`.
- yt-dlp: `deps.check`, and *update now* (`deps.install`).

**Rules a front end must keep:**
- Nothing becomes Learned except by the person's own click.
- Show "page X of Y" by position.

**Remember in the browser:**
- `localStorage`: the view, the open course, text size and whether the contents column is shown.
- The reading position goes to the helper (`progress.set`), not the browser.

**Keys:**
- Ctrl+= / Ctrl+-: text size.
- Ctrl+1 to Ctrl+5: the tabs.
- ← / →: the previous or next page, when not typing in a box.
- Esc: closes the overlap screen and leaves Learned's modes.

**Check:**
- Point the server at a **copy** of a library (`LEARN_LIBRARY=<copy> LEARN_CONFIG_DIR=<empty folder>`), never a real one. With `LEARN_LIBRARY` set, `hello` doesn't restart old builds.
- Screenshot every view with a headless Chromium (Playwright's, or `chrome --headless --screenshot`).

## 6. The games in the browser

Pages in `progress/web/public/games/`. Port each game's pure logic to its own JS module, and put `node:test` tests beside the Learn tests. The UI is new; the rules and data stay the same.

**Saves**
- `POST /api/save/<game>` / `GET /api/save/<game>` on the server, kept as `~/.config/claude-panel/games/<game>.json`.
- Use the same shapes as the WPF saves (each `.ps1`'s `Save-Prefs`), leaving out the window's `scale`, `dx` and `dy`:
  - `2048.json`: `{best, game?: {board[16], score, won, keepPlaying}}`.
  - `sudoku.json`: `{size, game?: {size, solution[], values[], given[], wrong[], notes[], lives, mode}}`. In `notes`, bit d set means a note for digit d.
  - `typetest.json`: `{pb, theme}`.
  - `chess.json`: `{version: 1, settings: {theme, difficulty, board, mode}, rating: {r, rd, vol, games, history[]}, climb: {level, best, games, history[]}, solved, counter, retry[], puzzle?}`.
- A finished game isn't kept. Check each part on load, and drop a bad part on its own.
- Write through a temp file, then rename it into place.

**2048** (from `widget/Game2048.ps1`, class `G2048`)
- A 4×4 board; arrows, WASD or HJKL.
- Each pair merges once per move, nearest the wall first.
- After a move that changed the board, a new tile: a 4 one time in ten, otherwise a 2.
- At 2048: "You win!" with Keep going / Try again. No moves left: "Game over!".
- Saves the best score and the game in progress. No undo.
- Animations: a 100 ms slide; merged tiles pop, new tiles grow, and "+N" rises from the score.

**Sudoku** (from `widget/Sudoku.ps1`, class `SudokuGen`)
- Sizes: 4×4, 6×6 and 9×9, with boxes of 2×2, 2×3 and 3×3, aiming for 6, 14 and 30 givens.
- The generator:
  - fills a random grid by backtracking;
  - removes givens while the puzzle still solves by **naked and hidden singles alone**, so it has one solution and never needs a guess;
  - has a 1.5 s budget.
- 3 lives: a wrong digit stays red and costs one, and the same wrong digit again is free. Out of lives starts a new puzzle.
- Notes mode: Space or N switches modes, and Shift or Ctrl flips the mode for one digit.
  - A note toggles across every open selected cell.
  - A right answer clears its digit from its peers' notes.
- Selection: click, Ctrl-click, Shift-click, drag, arrows.
- Highlights: peers, the same digits, and notes of the same digit.
- Undo: Ctrl+Z, 200 steps. It never gives a life back.
- No hints.

**Typing** (from `widget/TypeTest.ps1`, class `TypeStats`)
- 10 words from Monkeytype's English 200. The list is written inline in the `.ps1`. A word never repeats either of the two before it.
- Scoring as Monkeytype scores it:
  - wpm: letters of correct words plus their spaces, ÷ 5, per minute;
  - raw: every letter and space typed, ÷ 5, per minute;
  - accuracy;
  - consistency: kogasa of the coefficient of variation of the per-second raw speeds;
  - characters: correct / incorrect / extra / missed.
- Input:
  - comparison is case-sensitive;
  - up to 10 extra letters past a word;
  - Backspace goes into the previous word only if that word is wrong;
  - Ctrl+Backspace clears the word;
  - Tab restarts.
- The result screen: a big wpm and accuracy, and a per-second graph of wpm, raw and error marks.
- Themes: 187, from `widget/TypeThemes.txt`, one per line as `name|bg|main|caret|sub|subAlt|text|error|errorExtra`.
  - One value, slambook's `sub`, is `#AARRGGBB` and has to be reordered for CSS.
  - The theme picker has a search box, a live preview, and Esc to revert.
- Saves only the theme and the personal best.

**Chess puzzles** (from `widget/ChessPuzzles.ps1` and `widget/ChessCore.cs`). This is the big one: port it last.
- **Data:**
  - `widget/ChessPuzzles.txt`, 26,690 puzzles as `id|fen|moves|rating|rd|popularity|plays|themes|game`. The FEN is the position *before* the opponent's setup move; the moves are UCI.
  - `widget/ChessThemes.txt`, as `key|group|title|line`.
  - `widget/ChessPieces.txt`, as `piece|layer|fill|stroke|width|cap|join|fillRule|data`. The colours are `#FFRRGGBB`; `data` is plain SVG path syntax on a 45×45 square.
- **Port from `ChessCore.cs`:**
  - `Board`: FEN, attacks, legal moves, SAN and UCI. Check it with perft.
  - `Narrator`: every explanation sentence. It's built from attack maps, never guessed, and is the largest part.
  - Glicko-2 (τ 0.75).
  - The puzzle store and picker.
- **Flow:**
  - the setup move plays after 450 ms;
  - "Your move", with the board turned so the solver is at the bottom;
  - a move is right if it's the puzzle's move **or any mate**;
  - the reply comes after 400 ms;
  - at the end, a summary and a review strip.
- **Hints:**
  - first the idea (half credit);
  - then the piece (no credit);
  - then the move, as an arrow.
- **Scoring:** 1 for a clean solve, 0.5 with only the idea hint, 0 otherwise. A rated miss comes back once, 20 puzzles later.
- **Modes:**
  - Normal: Glicko-2 rating, with a target of rating + difficulty offset (−600 to +600);
  - Climb: a level from 600, +50 for a clean solve, +25 for half credit, −100 for a miss.
- **Next puzzle:** a search by theme within ±100 of the target, widening to ±1300.
- **Wrong moves, with Stockfish:**
  - search the move played (`go movetime 700 searchmoves <move>`);
  - value the puzzle's move: from its `mateIn` theme if it has one, otherwise a 350 ms search;
  - "That also wins…" with no penalty when both mate, or when the move played is within 30 cp of the puzzle's move and at least +150;
  - otherwise animate Stockfish's reply, say what it does, give both scores and Stockfish's line, and take both moves back after 1.9 s.
  - Without the engine, describe the move played and take it back after 1.4 s.
- **Stockfish:**
  - npm `stockfish@19.0.1`, as `https://unpkg.com/stockfish@19.0.1/?meta` lists it (sha256 in base64):
    - `bin/stockfish-19-lite-single.js`: 28,230 bytes, `zLEw1/8pQIUxxH2Fmkn5HVnU9ILQWlPrGjIxpPYkyRo=`;
    - `bin/stockfish-19-lite-single.wasm`: 1,845,971 bytes, `7k8RW9stMsrflsraEEoFtewlfXrW9XWCGQtJvHHwlt4=`.
    - Check these against that listing before you pin them.
  - The lite build's network is weaker than the full one (about 99 MB). It's plenty for refuting a puzzle move.
  - Run it in a Web Worker and speak UCI to it.
  - Have the server fetch both files once (from `https://unpkg.com/stockfish@19.0.1/bin/...`), check the hashes, cache them under `~/.cache/claude-learn/stockfish/`, and serve them.
  - Never commit them: Stockfish is GPL-3.0.
  - The single-threaded build needs no `SharedArrayBuffer`, so no COOP/COEP headers.
- **Settings:** theme, board colour (brown, blue, green or grey), difficulty and mode. Keys: H (hint), N or Enter (next), T (themes), the arrows (review).

**Check:**
- Unit tests for each logic module, including chess perft counts and the Glicko-2 numbers.
- A screenshot of each game.

## 7. Native Windows (Claude Code in PowerShell, no WSL)

Steps 3 to 6 carry over. Then:

- **`hooks/widget.ts` and `register.tsx`:**
  - `/tmp/claude-progress` and `$.process.run(['rm', '-f', …])` assume a POSIX system.
  - Use a temp folder from `$.env.get('TEMP')`, and delete files with `$.fs` or `cmd /c del`.
- **`learn/settings.mjs`:**
  - `toWslPath` turns `C:\…` into `/mnt/c/…`, and `normalizeSettings` throws away any path not starting with `/`.
  - On `process.platform === 'win32'`, keep Windows paths as they are.
- **`claudeBinary`:**
  - it splits `PATH` on `:`; Windows uses `;`;
  - the npm install is `claude.cmd`;
  - spawning a `.cmd` needs `shell: true` or `cmd /c`.
- **Starting the helper:** the server runs `node learn.mjs serve` directly; `learn.sh` is bash.
- **Test tracking:** Claude Code on Windows runs its Bash tool in Git Bash, so step 2's gate may already pass. Check what `$SHELL` says there.

## 8. What a port can't match

- There's no floating, always-on-top window. The pane docks beside the chat in fullscreen, and otherwise takes a few rows above the prompt.
- Learn and the games live in browser tabs, not in windows pinned to your terminal.
- Over SSH or in a devcontainer there's no local browser. Forward the server's port (`ssh -L`), or use the CLI (`learn.sh build start|list|…`).
- The pane's exact behaviour depends on your Claude Code version. The `plugin-authoring` skill's types are the reference for yours.

## 9. Checks before you push to your fork

- `claude plugin validate ./progress`.
- A type-check of `register.tsx` against the engine's types.
- `node --check` on every `.mjs` you touched.
- The `curl` security checks from step 4.
- Screenshots of the views you touched, against a **copy** of a library.
- Tests: written for every pure module. Run `claude plugin test ./progress` and `node --test progress/learn/tests/` (plus your new test folders) when the person says so.
- Bump `version`, push, then `claude plugin marketplace update claude-panel && claude plugin update progress@claude-panel`.
