#!/usr/bin/env bash
# Starts Learn's helper with a Node 22+ that works from anywhere. Windows' wsl.exe starts
# a shell without the user's profile, so nvm's node and ~/.local/bin/claude aren't on
# PATH: look for them. Always run as `bash learn.sh ...` (a wiki copy has no exec bit).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:$PATH"

works() { [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; }

node_bin="$(command -v node 2>/dev/null)"
if ! works "$node_bin"; then
  node_bin=""
  for candidate in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V -r) "$HOME/.volta/bin/node" /usr/local/bin/node /usr/bin/node; do
    if works "$candidate"; then node_bin="$candidate"; break; fi
  done
fi
if [ -z "$node_bin" ]; then
  echo '{"event":"fatal","error":"Learn needs Node 22 or newer inside WSL"}'
  exit 1
fi
# claude installed with npm sits next to that node.
export PATH="$(dirname "$node_bin"):$PATH"
exec "$node_bin" "$here/learn.mjs" "$@"
