#!/bin/bash
#
# launchd entry point for the nightly memory curation pass.
#
# Does only what shell is genuinely better at: resolving an interpreter under launchd's
# minimal environment, refusing to start when the store is not where it should be,
# holding a lock, and keeping a log. Everything with a decision in it lives in
# `agent-memory curate`, where it can be tested.
#
# Not `set -e`: the notification and log-rotation steps must never be able to fail the
# run they are reporting on.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-nightly}"
CURATOR_HOME="${AGENT_MEMORY_CURATOR_HOME:-$ROOT/curator}"
LOG_DIR="$CURATOR_HOME/state/logs"
LOG_FILE="$LOG_DIR/curator.log"
LOCK_DIR="$CURATOR_HOME/state/run.lock"
mkdir -p "$LOG_DIR"

# launchd hands a job /usr/bin:/bin:/usr/sbin:/sbin and nothing else, so node, claude
# and anything else live here would simply not be found.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.claude/local:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

[ -f "$CURATOR_HOME/config.env" ] && . "$CURATOR_HOME/config.env"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

notify() {
  # A notifier that can fail the job it reports on would be worse than no notifier.
  [ -n "${CURATOR_DISCORD_WEBHOOK:-}" ] || return 0
  curl -sS -m 20 -o /dev/null -X POST "$CURATOR_DISCORD_WEBHOOK" \
    -H 'Content-Type: application/json' \
    -H 'User-Agent: AgentMemoryCurator/1.0 (+local)' \
    --data "$(NOTIFY_TEXT="$1" node -e '
      const t = process.env.NOTIFY_TEXT.slice(0, 1900);
      process.stdout.write(JSON.stringify({ content: t, username: "agent-memory curator" }));
    ')" || true
}

{
  log "=== $MODE start ==="

  # ---- Preflight. Order matters: this first check MUST run before any node process
  # touches the store.
  #
  # resolveDataDir() unlinks a broken ~/.agent-memory symlink and silently creates a
  # fresh empty directory in its place. On a machine where the store lives on cloud
  # storage, a provider that is not mounted at 23:00 therefore means an unattended run
  # destroys the only pointer to the real database and then curates an empty one. A
  # shell test is the only way to catch it: `agent-memory stats` would spring the trap
  # itself, because the CLI opens the database to answer.
  DATA_DIR="${AGENT_MEMORY_DIR:-$HOME/.agent-memory}"
  if [ -L "$DATA_DIR" ] && [ ! -e "$DATA_DIR" ]; then
    log "FATAL: $DATA_DIR is a symlink whose target is not mounted."
    log "Refusing to run: starting the server now would delete the symlink and create an empty store."
    notify ":rotating_light: memory curator halted — the agent-memory store is not mounted"
    exit 78   # EX_CONFIG
  fi
  if [ ! -f "$DATA_DIR/memory.db" ]; then
    log "FATAL: no database at $DATA_DIR/memory.db"
    exit 78
  fi

  NODE_BIN="${AGENT_MEMORY_NODE:-$(command -v node || true)}"
  if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e 'process.exit(0)' 2>/dev/null; then
    log "FATAL: no usable node on PATH ($PATH)"
    exit 78
  fi
  CLI="$ROOT/dist/cli.js"
  if [ ! -f "$CLI" ]; then
    log "FATAL: $CLI is missing — run 'npm run build' in $ROOT"
    exit 78
  fi

  # ---- Lock. A directory, not a PID file: mkdir is atomic and a PID file survives
  # SIGKILL as a stale lock nobody clears.
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +90 2>/dev/null)" ]; then
      log "clearing a stale lock (>90 min)"
      rm -rf "$LOCK_DIR" && mkdir "$LOCK_DIR" || { log "FATAL: cannot acquire lock"; exit 1; }
    else
      log "another run is in progress; exiting"
      exit 0
    fi
  fi
  trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

  log "node=$NODE_BIN mode=$MODE home=$CURATOR_HOME"

  # macOS ships bash 3.2, where "${arr[@]}" on an EMPTY array is an unbound-variable
  # error under `set -u`. The ${arr[@]+...} form expands to nothing when the array is
  # empty and is the only portable way to pass an optional argument list here.
  MODEL_ARGS=()
  [ -n "${CURATOR_MODEL:-}" ] && MODEL_ARGS=(--model "$CURATOR_MODEL")
  # CURATOR_EXTRA_ARGS is deliberately unquoted so it can carry several flags.
  "$NODE_BIN" "$CLI" curate --mode "$MODE" --home "$CURATOR_HOME" \
    ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} ${CURATOR_EXTRA_ARGS:-}
  RC=$?

  REPORT="$CURATOR_HOME/reports/$(date '+%Y-%m-%d')-$MODE.md"
  case $RC in
    0) log "ok" ;;
    2) log "halted — needs attention (see the latest report)" ;;
    *) log "FAILED rc=$RC" ;;
  esac

  # Notify only when something happened or something needs attention. A message that
  # arrives nightly saying "nothing notable" stops being read within a fortnight.
  if [ $RC -ne 0 ]; then
    notify ":warning: memory curator ($MODE) exited $RC — \`$REPORT\`"
  elif [ -f "$REPORT" ] && grep -qE '^- \*\*|Red flags' "$REPORT" 2>/dev/null; then
    notify ":broom: memory curator ($MODE): $(head -5 "$REPORT" | grep '^`' | tr -d '`' | head -1)"
  fi

  # No rotation anywhere else in this family of jobs, and those logs are now 400KB+.
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" | tr -d ' ')" -gt 1048576 ] 2>/dev/null; then
    tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi

  log "=== $MODE exit $RC ==="
  exit $RC
} >> "$LOG_FILE" 2>&1
