#!/usr/bin/env bash
# Draws every standard view of the given windows, in each colour scheme and opacity, with snap.sh:
# OUTDIR/<window>-<view>-<scheme>-<opacity>.png ("def" = each group's default opacity).
#
#   progress/tools/snap-views.sh [--as NAME] [--schemes "ember paper hc"] [--opacities "def 0.4"] \
#     OUTDIR panel|sudoku|2048|typing|chess...
#
# Learn is a web page (web/public/learn): draw it with tools/shoot.mjs.
# A view that fails to draw is reported and the rest carry on; the exit code says if any failed.
set -uo pipefail

name=views
schemes="ember paper hc"
opacities="def 0.4"
while [ $# -gt 0 ]; do
  case "$1" in
    --as) name="$2"; shift 2 ;;
    --schemes) schemes="$2"; shift 2 ;;
    --opacities) opacities="$2"; shift 2 ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || { sed -n '2,9p' "$0" >&2; exit 2; }
out="$1"; shift
mkdir -p "$out"
here="$(cd "$(dirname "$0")" && pwd)"
fixtures="$here/fixtures"

fixture() { wslpath -w "$fixtures/$1"; }

# window: view label, then the script and its arguments (one view per line).
views_of() {
  case "$1" in
    panel)
      echo "phases|PhasesWidget.ps1 -StateFile $(fixture panel-full.json) -SnapshotTab phases -SnapshotLook open"
      echo "tests|PhasesWidget.ps1 -StateFile $(fixture panel-tests.json) -SnapshotTab tests -SnapshotLook open"
      echo "learn|PhasesWidget.ps1 -StateFile $(fixture panel-learn.json) -SnapshotTab learn -SnapshotLook open"
      echo "empty|PhasesWidget.ps1 -StateFile $(fixture panel-empty.json) -SnapshotTab phases -SnapshotLook open"
      echo "collapsed|PhasesWidget.ps1 -StateFile $(fixture panel-full.json) -SnapshotTab phases -SnapshotLook closed"
      echo "releases|PhasesWidget.ps1 -StateFile $(fixture panel-full.json) -SnapshotTab releases -SnapshotLook open"
      echo "look|PhasesWidget.ps1 -StateFile $(fixture panel-full.json) -SnapshotTab phases -SnapshotLook open -SnapshotStrip look"
      echo "games|PhasesWidget.ps1 -StateFile $(fixture panel-full.json) -SnapshotTab phases -SnapshotLook open -SnapshotStrip games"
      echo "long|PhasesWidget.ps1 -StateFile $(fixture panel-long.json) -SnapshotTab phases -SnapshotLook open"
      echo "course|PhasesWidget.ps1 -StateFile $(fixture panel-course.json) -SnapshotTab learn -SnapshotLook open"
      ;;
    sudoku)
      echo "demo|Sudoku.ps1 -SnapshotDemo"
      echo "demo4|Sudoku.ps1 -SnapshotDemo -Size 4 -Seed 7"
      echo "demo6|Sudoku.ps1 -SnapshotDemo -Size 6 -Seed 7"
      echo "switcher|Sudoku.ps1 -SnapshotSwitcher -Seed 3"
      ;;
    2048)
      echo "demo|Game2048.ps1 -SnapshotDemo"
      echo "switcher|Game2048.ps1 -SnapshotSwitcher -Seed 3"
      echo "win|Game2048.ps1 -SnapshotLook win"
      echo "over|Game2048.ps1 -SnapshotLook over"
      ;;
    typing)
      for view in typing result themes; do echo "$view|TypeTest.ps1 -SnapshotView $view"; done
      echo "monkeytype|TypeTest.ps1 -SnapshotView typing -SnapshotTheme serika_dark"
      ;;
    chess) for view in board picker review; do echo "$view|ChessPuzzles.ps1 -SnapshotView $view -NoEngine"; done ;;
    *) echo "snap-views: no window called $1" >&2; return 1 ;;
  esac
}

failed=0
for window in "$@"; do
  while IFS='|' read -r view command; do
    [ -n "$view" ] || continue
    for scheme in $schemes; do
      for opacity in $opacities; do
        file="$out/$window-$view-$scheme-$opacity.png"
        set -- $command
        opacity_args=()
        [ "$opacity" = def ] || opacity_args=(--opacity "$opacity")
        if "$here/snap.sh" --as "$name" --scheme "$scheme" "${opacity_args[@]}" "$file" "$@" </dev/null >/dev/null 2>"$file.err"; then
          rm -f "$file.err"
          echo "ok    $file"
        else
          failed=1
          echo "FAIL  $file (see $file.err)"
        fi
      done
    done
  done < <(views_of "$window")
done
exit $failed
