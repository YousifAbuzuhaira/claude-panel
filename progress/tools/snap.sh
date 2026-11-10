#!/usr/bin/env bash
# Draws one Windows window to a PNG, in a chosen colour scheme and opacity, without touching
# the person's own prefs: the window runs with LOCALAPPDATA pointed at a scratch folder of its own
# (per --as name, so parallel runs don't share one), holding only the appearance file written here.
#
#   progress/tools/snap.sh [--as NAME] [--scheme ember|graphite|moss|serika|paper|hc] [--opacity 0.4] \
#     OUT.png Script.ps1 [script args...]
#
#   progress/tools/snap.sh --scheme paper /tmp/p.png Game2048.ps1 -SnapshotDemo
#   progress/tools/snap.sh --opacity 0.4 /tmp/s.png Sudoku.ps1 -SnapshotDemo
#
# The script runs from this checkout's widget folder (a worktree runs its own code). Every
# argument after the script name goes to it as is. Windows paths are not needed: OUT.png is a
# WSL path. Run from WSL. Retries the vsock hiccup powershell.exe sometimes has from WSL.
set -euo pipefail

name=snap
scheme=ember
opacity=
while [ $# -gt 0 ]; do
  case "$1" in
    --as) name="$2"; shift 2 ;;
    --scheme) scheme="$2"; shift 2 ;;
    --opacity) opacity="$2"; shift 2 ;;
    *) break ;;
  esac
done
if [ $# -lt 2 ]; then
  sed -n '2,13p' "$0" >&2
  exit 2
fi
out="$1"; script="$2"; shift 2

here="$(cd "$(dirname "$0")/.." && pwd)"
widget="$here/widget"
[ -f "$widget/$script" ] || { echo "snap: no $widget/$script" >&2; exit 2; }

case "$scheme" in
  hc) colors='{"bg":"#000000","accent":"#FFD400","text":"#FFFFFF"}' ;;
  *)
    colors="$(node -e '
      const presets = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).presets
      const p = presets.find(x => x.name === process.argv[2])
      if (!p) { console.error("snap: no preset " + process.argv[2]); process.exit(2) }
      console.log(JSON.stringify({ bg: p.bg, accent: p.accent, text: p.text }))
    ' "$widget/Presets.json" "$scheme")"
    ;;
esac
if [ -n "$opacity" ]; then
  opacities="{\"panel\":$opacity,\"learn\":$opacity,\"games\":$opacity}"
else
  opacities='{"panel":0.92,"learn":0.96,"games":0.95}'
fi
preset="$scheme"; [ "$scheme" = hc ] && preset=custom
appearance="{\"v\":1,\"preset\":\"$preset\",\"colors\":$colors,\"opacity\":$opacities}"

mkdir -p "$(dirname "$out")"
out_win="$(wslpath -w "$(cd "$(dirname "$out")" && pwd)")\\$(basename "$out")"
script_win="$(wslpath -w "$widget/$script")"

# Parameter names as they are, every value single-quoted for PowerShell.
ps_args=""
for arg in "$@"; do
  if [[ "$arg" =~ ^-[A-Za-z]+$ ]]; then ps_args="$ps_args $arg"; else ps_args="$ps_args '${arg//\'/\'\'}'"; fi
done

command="\$ErrorActionPreference = 'Stop'
\$env:LOCALAPPDATA = Join-Path \$env:TEMP 'claude-ui\\$name'
\$dir = Join-Path \$env:LOCALAPPDATA 'ClaudePhases'
[void](New-Item -ItemType Directory -Force -Path \$dir)
[System.IO.File]::WriteAllText((Join-Path \$dir 'appearance.json'), '$appearance', (New-Object System.Text.UTF8Encoding(\$false)))
& '$script_win' -SnapshotPath '$out_win'$ps_args"

for attempt in 1 2 3; do
  if output="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$command" 2>&1)"; then
    [ -s "$out" ] || { echo "snap: $script drew nothing" >&2; echo "$output" >&2; exit 1; }
    exit 0
  fi
  case "$output" in
    *UtilAcceptVsock*) sleep 1 ;;
    *) echo "$output" >&2; exit 1 ;;
  esac
done
echo "$output" >&2
exit 1
