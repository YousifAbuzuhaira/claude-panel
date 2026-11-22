---
description: Have Claude explain code from this chat as short video clips in Learn, e.g. /explain how the gateway mints tokens
argument-hint: <what to explain>
disable-model-invocation: true
---

Explain this to me as short narrated video clips, made by Learn: $ARGUMENTS

If nothing is named after the colon, explain what we are working on. Don't explain it here in text: plan the clips and hand them to Learn.

0. First reply with one short line, such as "Planning clips about X: reading the code", before any tool call, so I know it has started.
1. Look at the code first (read the files that matter), then write the plan and call the tool mcp__progress__explain_plan with it. If its schema isn't loaded, load it with ToolSearch (select:mcp__progress__explain_plan).
2. One clip per mechanism, in the order they build on each other, 1 to 12 clips. Clip 1 (level 1) is the mental model; level 2 clips add the mechanism and its code; level 3 the failure modes and edges. The player lets me pick how deep to go.
3. Each clip's facts are plain sentences: what it does, why, what happens next. Mark each fact's basis: code (the clip's anchored lines show it) or session (this chat says it, with a quote of 4 words or more copied word for word from one message). Nothing else: no outside facts, no made-up examples.
4. Anchor the code each clip shows by file and line range (from 1, at most 60 lines) with a few words from those lines in "expect". The file is relative to this session's folder, or a full or ~/ path anywhere under my home folder; files that look like secrets (.env, keys, credentials) are refused. Learn reads the lines from disk: never paste code into a fact.
5. Each clip opens with a guess question: 3 options, one right, each wrong one a believable mistake, each with a one-sentence why, and a quote from the clip's facts or code that states the right answer. Make it about the clip's central mechanism. (Learn uses it only when my Questions setting is on.)
6. If a fact describes something that really went wrong in this work (a bug we fixed, a failing test, an idea that turned out false), list its number in "failure": the clip opens on it.
7. The map: "flow" when something moves from part to part (a request through services), "parts" for parts of one whole, "none" under 3 clips. At most 4 top boxes, labels of 1 to 3 words; each clip in one box.

If Learn refuses the plan, fix what it lists and call the tool again. When it accepts, tell me in one line that the clips are being made and the player is opening. Keep your reply short.
