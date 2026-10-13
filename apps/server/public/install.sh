#!/bin/sh
# Install the tsbb bulletin board client: tsbb (CLI), tsbb-tui (terminal client)
# and tsbb-mcp (MCP server). npm: @profullstack/tsbb, -tui, -mcp.
#
#   curl -fsSL https://tsbb.dev/install.sh | sh
#
# Works against any tsbb board. Needs Node >= 22.6 (the commands run on Node).
# Installs with bun if present, otherwise npm. When the global npm prefix is not writable it installs into
# ~/.local instead of asking for sudo. Re-run it to upgrade.
set -eu

PKGS="@profullstack/tsbb@latest @profullstack/tsbb-tui@latest @profullstack/tsbb-mcp@latest"
BIN="tsbb"

say() { printf '%s\n' "$*"; }
die() { printf 'tsbb install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

node_ok() {
  have node || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' 2>/dev/null
}

say "Installing tsbb, tsbb-tui and tsbb-mcp..."

node_ok || die "Node >= 22.6 required (found $(node -v 2>/dev/null || echo none)). Install it from https://nodejs.org"

if have bun; then
  # Without a global manifest, bun add -g writes into the nearest package.json above it.
  BUN_GLOBAL="${BUN_INSTALL:-$HOME/.bun}/install/global"
  mkdir -p "$BUN_GLOBAL"
  [ -f "$BUN_GLOBAL/package.json" ] || printf '{}\n' > "$BUN_GLOBAL/package.json"
  bun add -g $PKGS
  BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
elif have npm; then
  prefix=$(npm config get prefix)
  modules="$prefix/lib/node_modules"
  [ -d "$modules" ] || modules="$prefix/lib"
  if [ -w "$modules" ] && [ -w "$prefix/bin" ]; then
    npm install -g $PKGS
    BIN_DIR="$prefix/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    say "npm prefix $prefix is not writable; installing into $HOME/.local"
    npm install -g --prefix "$HOME/.local" $PKGS
  fi
else
  die "needs npm (comes with Node: https://nodejs.org) or bun (https://bun.sh)"
fi

say ""
if have "$BIN"; then
  say "tsbb $("$BIN" --version 2>/dev/null || echo '') installed (with tsbb-tui and tsbb-mcp)."
else
  say "$BIN installed to $BIN_DIR, which is not on your PATH. Add it:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
fi
say ""
say "Next:"
say "  tsbb login tsbb.dev     # approve a code in your browser"
say "  tsbb latest             # recently active topics"
say "  tsbb-tui tsbb.dev       # read and post in the terminal"
say "  tsbb --help             # everything else, including tsbb mcp"
