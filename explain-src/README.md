# explain

`/explain` has Claude explain the code you're working on as short narrated video clips. They are made on your own computer, with a local voice and your own Claude Code login (no API key).

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
- Claude plans the clips and asks how deep to go: the idea, the mechanism with its code, or everything with its failure modes and edges.
- A notice in the chat says when each clip is ready. The last one gives the file's path.
- `/clips` opens the clips in your browser.

The first `/explain` also downloads the voice: about 350 MB, once, each piece checked by its hash. It goes in `~/.cache/claude-learn/voice`.

## What you get

Each explainer is one HTML file in `~/explainers`. It plays with no server and no internet, so you can send it to someone. It is written again after each clip, so open it again (or reload it) to see the new ones.

The file holds the clips: their narration, pictures, and the code they show. It does not hold your chat, its session id, your folder's path or your settings. Read what it shows before you send it: it can show private code.

## What it explains, and what it can't

Every fact in a clip is checked against the code on disk or word for word against this chat, so it explains code and work, not general topics. Files that look like secrets (`.env`, keys, credentials) are refused, and secret-looking values in code are hidden.

## With the progress plugin

If you also have the `progress` plugin, it handles `/explain` and `/clips` (with its own player and library), and this plugin stands aside. Both keep explainers and the voice in the same place, so nothing is made or downloaded twice.
