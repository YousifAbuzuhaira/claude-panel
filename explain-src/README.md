# explain

`/explain` has Claude explain what you're working on as short narrated video clips: pictures and a voice, with no code on screen. They are made on your own computer, with a local voice and your own Claude Code login (no API key).

## What you need

- Claude Code, logged in.
- Node 22 or newer.
- One of: Linux or WSL (x64 or arm64), Windows x64, or a Mac with Apple Silicon and macOS 14 or newer. Intel Macs can't run the voice.

## Install

In a terminal:

```bash
claude plugin marketplace add keops-ai/claude-explain
claude plugin install explain@claude-explain
```

The repository is private: ask for access first, and if git asks for a password, run `gh auth login`. To get a newer version later: `claude plugin marketplace update claude-explain`, then `claude plugin update explain@claude-explain`.

Then start Claude Code again, or run `/reload-plugins` in a session.

## Use

- `/explain how the gateway mints tokens` explains that, from the code and this chat.
- `/explain` alone explains what you are working on.
- Claude plans the clips and asks how deep to go: the idea, the mechanism step by step, or everything with its failure modes and edges.
- With a Keops wiki key set, it also asks whether the finished clips go on the wiki (see below).
- A notice in the chat says when each clip is ready. The last one gives the file's path.
- `/clips` opens the clips in your browser.
- `/clips stop` stops making them; the ones ready are kept. `/clips resume` makes the rest.
- `/clips model` says which Claude model writes the clips (Opus, unless you change it). `/clips model sonnet` changes it, for an account without Opus or to use less of your limit.

The first `/explain` also downloads the voice: about 350 MB, once, each piece checked by its hash. It goes in `~/.cache/claude-learn/voice`.

## What you get

Each explainer is one HTML file in `~/explainers`. It plays with no server and no internet, so you can send it to someone. It is written again after each clip, so open it again (or reload it) to see the new ones.

The file holds the clips: their narration and pictures. It does not hold your code, your chat, its session id, your folder's path or your settings. Read what it says before you send it: it tells how your code works.

## On the Keops wiki

Only when `WIKI_API_KEY` is set where you start Claude Code. It is your own key, made in the wiki under Settings → API keys.

- Each `/explain` then asks: "No, this machine only", "My personal workspace" (only you can open it) or "Shared workspace" (everyone in Keops can). The answer holds for that explainer alone.
- They go up once, when every clip is ready, each clip its own doc in a folder named after the explainer: `Explainers/<title>/01-….html`. The last notice gives the folder and the first clip's link. No share link is made.
- Name a folder to put it in: `/explain how tokens move, in the folder Auth` goes to `Explainers/Auth/<title>/`.
- From a clip's doc, the others play one after another, read from their own docs. Move or rename those docs and the player says which one to open instead.
- If the upload fails, the notice says why, and `/clips wiki` tries again. The clips and their file are made either way.
- `/clips wiki off` stops the question; `/clips wiki on` brings it back.

## What it explains, and what it can't

Every fact in a clip is checked against the code on disk or word for word against this chat, so it explains code and work, not general topics. Files that look like secrets (`.env`, keys, credentials) are refused, and secret-looking values are hidden from the check. No clip shows code.

## With the progress plugin

If you also have the `progress` plugin, it handles `/explain` and `/clips` (with its own player and library), and this plugin stands aside. Both keep explainers and the voice in the same place, so nothing is made or downloaded twice.
