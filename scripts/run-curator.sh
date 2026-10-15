#!/bin/bash
#
# launchd entry point for a memory curation pass — `nightly` (what changed since the
# last successful run) or `sweep` (the whole corpus, oldest-reviewed first).
#
# Does only what shell is genuinely better at: resolving an interpreter under launchd's
# minimal environment, refusing to start when the store is not where it should be,
# holding a lock, keeping a log, and telling Discord what happened. Everything with a
# decision in it lives in `agent-memory curate`, where it can be tested.
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
RUN_OUT="$CURATOR_HOME/state/last-run-$MODE.txt"
mkdir -p "$LOG_DIR"

# launchd hands a job /usr/bin:/bin:/usr/sbin:/sbin and nothing else, so node, claude
# and anything else live here would simply not be found.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.claude/local:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

[ -f "$CURATOR_HOME/config.env" ] && . "$CURATOR_HOME/config.env"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# ---- Notifications. Entirely optional: with no CURATOR_DISCORD_WEBHOOK set, every
# call here is a no-op and nothing warns about it. That is the contract — a machine
# without a webhook configured must behave exactly as it did before.

# Minimal JSON string escaping in pure shell. Deliberately not `node -e`: the one
# message that absolutely must get out is "there is no usable node on PATH", and a
# notifier that needs node to say so cannot say it.
json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/'$'\t''/ /g' -e 's/'$'\r''//g' \
    | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'
}

# notify <errors|changes|quiet> <message>
#
# The first argument is how important the message is; CURATOR_NOTIFY_LEVEL is how much
# the operator wants to hear. 'quiet' is a nothing-happened success — the class of
# message that, arriving every night, trains you to stop reading the channel.
notify() {
  local want="$1" text="$2"
  [ -n "${CURATOR_DISCORD_WEBHOOK:-}" ] || return 0
  case "${CURATOR_NOTIFY_LEVEL:-all}:$want" in
    off:*)                          return 0 ;;
    errors:errors)                  ;;
    errors:*)                       return 0 ;;
    changes:errors|changes:changes) ;;
    changes:*)                      return 0 ;;
    *)                              ;;
  esac

  # Discord's hard limit is 2000 characters. Cut on bytes, then let iconv drop the
  # partial UTF-8 sequence the cut can leave behind — the report is full of → and ⚠,
  # and half a multi-byte character is invalid JSON as well as invalid text.
  text="$(printf '%s' "$text" | head -c 1800)"
  text="$(printf '%s' "$text" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null || printf '%s' "$text")"

  curl -sS -m 20 -o /dev/null -X POST "$CURATOR_DISCORD_WEBHOOK" \
    -H 'Content-Type: application/json' \
    -H 'User-Agent: AgentMemoryCurator/1.0 (+local)' \
    --data "{\"username\":\"agent-memory curator\",\"content\":\"$(json_escape "$text")\"}" \
    || log "notify failed (the run itself is unaffected)"
}

# A preflight that cannot continue. Always announced: a scheduled job that silently
# stops running is the failure mode this whole file exists to prevent.
fatal() {
  log "FATAL: $1"
  notify errors ":rotating_light: **memory curator ($MODE) could not start**
$1"
  exit "${2:-78}"   # EX_CONFIG
}

# Pull one section out of the generated report, by its exact heading.
report_section() {
  [ -f "${1:-}" ] || return 0
  awk -v h="$2" '$0 == h { f = 1; next } /^## / { f = 0 } f' "$1" | sed '/^$/d'
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
    log "Refusing to run: starting the server now would delete the symlink and create an empty store."
    fatal "$DATA_DIR is a symlink whose target is not mounted — the store is unreachable."
  fi
  [ -f "$DATA_DIR/memory.db" ] || fatal "no database at $DATA_DIR/memory.db"

  NODE_BIN="${AGENT_MEMORY_NODE:-$(command -v node || true)}"
  if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e 'process.exit(0)' 2>/dev/null; then
    fatal "no usable node on PATH ($PATH)"
  fi
  CLI="$ROOT/dist/cli.js"
  [ -f "$CLI" ] || fatal "$CLI is missing — run 'npm run build' in $ROOT"

  # ---- Lock. A directory, not a PID file: mkdir is atomic and a PID file survives
  # SIGKILL as a stale lock nobody clears.
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +90 2>/dev/null)" ]; then
      log "clearing a stale lock (>90 min)"
      rm -rf "$LOCK_DIR" && mkdir "$LOCK_DIR" || fatal "cannot acquire lock at $LOCK_DIR" 1
    else
      # Not an error: the previous pass is still working. Saying so every time would
      # be noise, and the run it collided with will report for itself.
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
    ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} ${CURATOR_EXTRA_ARGS:-} 2>&1 | tee "$RUN_OUT"
  RC=${PIPESTATUS[0]}

  # Read back out of what the run printed rather than reconstructing it. The report
  # path in particular: deriving it from today's date is wrong for a pass that starts
  # at 23:59 and writes its report after midnight.
  REPORT="$(grep -m1 '^report: ' "$RUN_OUT" 2>/dev/null | sed 's/^report: //')"
  HEADLINE="$(grep -v -e '^report: ' -e '^\[curate\] ' "$RUN_OUT" 2>/dev/null | sed '/^$/d' | tail -1)"
  [ -n "$HEADLINE" ] || HEADLINE="(no summary — see $LOG_FILE)"

  case $RC in
    0) log "ok" ;;
    2) log "halted — needs attention (see the latest report)" ;;
    *) log "FAILED rc=$RC" ;;
  esac

  # ---- Report to Discord. Success at the end of every run, as asked; failures always,
  # whatever the notify level.
  if [ $RC -ne 0 ]; then
    notify errors ":rotating_light: **memory curator ($MODE) exited $RC**
$HEADLINE
$(tail -n 6 "$RUN_OUT" 2>/dev/null)
${REPORT:+report: $REPORT}"
  else
    CHANGED="$(report_section "$REPORT" '## What changed' | head -n 20)"
    FLAGS="$(report_section "$REPORT" '## ⚠ Red flags' | head -n 8)"
    # "Nothing." is what the report writes when no row was touched. Anything else in
    # that section means the corpus moved tonight, which is worth an interruption.
    case "$CHANGED" in
      Nothing.*|"") LEVEL=quiet; ICON=":white_check_mark:" ;;
      *)            LEVEL=changes; ICON=":broom:" ;;
    esac
    [ -n "$FLAGS" ] && LEVEL=changes && ICON=":warning:"

    notify "$LEVEL" "$ICON **memory curator ($MODE)**
$HEADLINE
${CHANGED:+
**What changed**
$CHANGED}${FLAGS:+

**Red flags**
$FLAGS}
${REPORT:+report: $REPORT}"
  fi

  # No rotation anywhere else in this family of jobs, and those logs are now 400KB+.
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" | tr -d ' ')" -gt 1048576 ] 2>/dev/null; then
    tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi

  log "=== $MODE exit $RC ==="
  exit $RC
} >> "$LOG_FILE" 2>&1
