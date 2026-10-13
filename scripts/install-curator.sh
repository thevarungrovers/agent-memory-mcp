#!/bin/bash
#
# Install (or remove) the memory curator's launchd jobs on this machine.
#
# Everything is resolved from this checkout's location, so a fresh clone anywhere on
# any machine works without editing a file. The plists in launchd/ are templates
# carrying __PROJECT_ROOT__ and __NODE_BIN__ tokens; never copy them by hand.
#
# Usage:
#   bash scripts/install-curator.sh                 install the nightly job
#   bash scripts/install-curator.sh nightly weekly  install both
#   bash scripts/install-curator.sh --uninstall     remove everything installed here
#   bash scripts/install-curator.sh --status        report what is actually loaded
#
# INSTALLING DOES NOT RUN IT. RunAtLoad is false, so the first pass is the next 23:00.
# To force one now:  bash scripts/run-curator.sh nightly
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
PREFIX="com.agent-memory.curator"
GUI="gui/$(id -u)"

die() { echo "error: $*" >&2; exit 1; }
note() { echo "  $*"; }

[ "$(uname -s)" = "Darwin" ] || die "launchd is macOS only.
On Linux, schedule 'bash $ROOT/scripts/run-curator.sh nightly' with cron or a systemd timer."

status() {
  for name in nightly weekly; do
    if launchctl print "$GUI/$PREFIX.$name" >/dev/null 2>&1; then
      echo "  $PREFIX.$name  LOADED"
    elif [ -f "$AGENTS/$PREFIX.$name.plist" ]; then
      echo "  $PREFIX.$name  installed but NOT LOADED"
    else
      echo "  $PREFIX.$name  not installed"
    fi
  done
}

uninstall() {
  for name in nightly weekly; do
    launchctl bootout "$GUI/$PREFIX.$name" 2>/dev/null
    rm -f "$AGENTS/$PREFIX.$name.plist"
    note "removed $PREFIX.$name"
  done
  echo
  echo "The database, reports and snapshots under curator/state are untouched."
}

case "${1:-}" in
  --uninstall) uninstall; exit 0 ;;
  # `launchctl list | grep` prints nothing for an unloaded job and cannot tell "off"
  # from "does not exist", so status uses launchctl print.
  --status)    echo "launchd:"; status; exit 0 ;;
esac

JOBS=("$@")
[ ${#JOBS[@]} -eq 0 ] && JOBS=(nightly)

echo "Preflight"

NODE_BIN="${AGENT_MEMORY_NODE:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || die "no node on PATH"
# better-sqlite3 is a native addon, so the node that loads it must be the one it was
# built against. Pinning the absolute path in the plist is the only way to be sure
# launchd uses the same one.
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
note "node: $NODE_BIN ($("$NODE_BIN" --version))"

[ -f "$ROOT/dist/cli.js" ] || die "dist/cli.js missing — run 'npm run build' first"
note "cli:  $ROOT/dist/cli.js"

"$NODE_BIN" -e 'require("better-sqlite3")' 2>/dev/null \
  || "$NODE_BIN" --input-type=module -e 'import("better-sqlite3")' >/dev/null 2>&1 \
  || die "this node cannot load better-sqlite3 — run 'npm rebuild better-sqlite3' with it"
note "better-sqlite3 loads"

DATA_DIR="${AGENT_MEMORY_DIR:-$HOME/.agent-memory}"
if [ -L "$DATA_DIR" ] && [ ! -e "$DATA_DIR" ]; then
  die "$DATA_DIR is a symlink whose target is not mounted. Mount it before installing."
fi
[ -f "$DATA_DIR/memory.db" ] || die "no database at $DATA_DIR/memory.db — run the server once first"
note "store: $DATA_DIR/memory.db"

CLAUDE_BIN=""
for c in /opt/homebrew/bin/claude /usr/local/bin/claude "$HOME/.claude/local/claude"; do
  [ -x "$c" ] && { CLAUDE_BIN="$c"; break; }
done
# Never `command -v claude`: under cmux that resolves to a per-session shim beneath
# $TMPDIR which does not exist under launchd.
[ -n "$CLAUDE_BIN" ] || die "no claude CLI at a stable path (/opt/homebrew/bin/claude, /usr/local/bin/claude, ~/.claude/local/claude)"
note "claude: $CLAUDE_BIN"

mkdir -p "$ROOT/curator/state/logs" "$ROOT/curator/state/snapshots" "$ROOT/curator/reports"

if [ ! -f "$ROOT/curator/config.env" ] && [ -f "$ROOT/curator/config.env.example" ]; then
  cp "$ROOT/curator/config.env.example" "$ROOT/curator/config.env"
  chmod 600 "$ROOT/curator/config.env"
  note "created curator/config.env (mode 600) — add a webhook there if you want alerts"
fi

echo
echo "Canary baseline"
"$NODE_BIN" "$ROOT/dist/cli.js" canary --home "$ROOT/curator" 2>&1 | sed 's/^/  /'

echo
echo "Installing"
mkdir -p "$AGENTS"
for name in "${JOBS[@]}"; do
  src="$ROOT/launchd/$PREFIX.$name.plist"
  [ -f "$src" ] || die "no template at $src"
  dest="$AGENTS/$PREFIX.$name.plist"

  sed -e "s|__PROJECT_ROOT__|$ROOT|g" -e "s|__NODE_BIN__|$NODE_BIN|g" "$src" > "$dest"
  plutil -lint "$dest" >/dev/null || die "generated plist is invalid: $dest"

  launchctl bootout "$GUI/$PREFIX.$name" 2>/dev/null
  launchctl bootstrap "$GUI" "$dest" || die "could not bootstrap $PREFIX.$name"
  note "installed $PREFIX.$name"
done

echo
echo "Loaded:"
status
echo
echo "Nothing runs until the next scheduled time. To force a pass now:"
echo "  bash $ROOT/scripts/run-curator.sh nightly"
echo
echo "Start with a few dry runs before trusting it unattended:"
echo "  CURATOR_EXTRA_ARGS=--dry-run bash $ROOT/scripts/run-curator.sh nightly"
