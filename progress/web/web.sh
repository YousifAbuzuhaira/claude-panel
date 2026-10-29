#!/usr/bin/env bash
# Starts (or finds) the Learn + games web server and opens a page in the browser, with a
# Node 22+ found the way learn/learn.sh finds one. Always run as `bash web.sh ...`.
#   bash web.sh open [learn | games/<sudoku|2048|typing|chess>]
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:$PATH"

works() { [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; }

node_bin="$(command -v node 2>/dev/null)"
if ! works "$node_bin"; then
  node_bin=""
  for candidate in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V -r) "$HOME/.volta/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if works "$candidate"; then node_bin="$candidate"; break; fi
  done
fi
if [ -z "$node_bin" ]; then
  echo '{"ok":false,"error":"Learn needs Node 22 or newer"}'
  exit 1
fi
export PATH="$(dirname "$node_bin"):$PATH"
exec "$node_bin" "$here/server.mjs" "$@"
