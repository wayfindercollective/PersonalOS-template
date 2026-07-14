#!/usr/bin/env bash
# Generic detached long-running command wrapper.
# Usage:
#   long-runner.sh --cmd "<shell command>" --label "<label>" \
#                  --notify-chat <chat_id> [--timeout-min N] \
#                  [--silent] [--tail-chars N]
#
# Forks the command with setsid -f so the launcher returns instantly. The
# detached child captures stdout+stderr to a log under
# ~/personalos/store/long-runner-logs/, applies a per-label flock so concurrent
# invocations with the same label dedup, and on completion posts a Telegram
# notification via notify.sh containing the label, exit code, and the last
# N chars of output.

set -u

CMD=""
LABEL=""
NOTIFY_CHAT=""
TIMEOUT_MIN=30
SILENT=0
TAIL_CHARS=1000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cmd) CMD="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --notify-chat) NOTIFY_CHAT="$2"; shift 2 ;;
    --timeout-min) TIMEOUT_MIN="$2"; shift 2 ;;
    --silent) SILENT=1; shift ;;
    --tail-chars) TAIL_CHARS="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$CMD" ] || [ -z "$LABEL" ]; then
  echo "Usage: $0 --cmd \"...\" --label \"...\" [--notify-chat ID] [--timeout-min N] [--silent]" >&2
  exit 2
fi

# Clamp timeout to a sane range.
if [ "$TIMEOUT_MIN" -lt 1 ]; then TIMEOUT_MIN=1; fi
if [ "$TIMEOUT_MIN" -gt 120 ]; then TIMEOUT_MIN=120; fi
TIMEOUT_SEC=$((TIMEOUT_MIN * 60))

# Per-label lock + slug for filenames.
SLUG=$(echo "$LABEL" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g' | sed 's/-\+/-/g' | cut -c1-60)
LOG_DIR="./store/long-runner-logs"
LOCK_DIR="./store"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${SLUG}-$(date +%Y-%m-%d_%H%M%S_%N).log"
LOCK_FILE="$LOCK_DIR/long-runner-${SLUG}.lock"
NOTIFY="./scripts/notify.sh"

# Detached child. flock guards against duplicate concurrent launches with the
# same label. The lock is released when fd 9 closes at process exit.
setsid -f bash -c "
  CMD=$(printf '%q' "$CMD")
  LABEL=$(printf '%q' "$LABEL")
  LOG=$(printf '%q' "$LOG_FILE")
  LOCK=$(printf '%q' "$LOCK_FILE")
  NOTIFY=$(printf '%q' "$NOTIFY")
  CHAT=$(printf '%q' "$NOTIFY_CHAT")
  SILENT=$SILENT
  TAIL_CHARS=$TAIL_CHARS
  TIMEOUT_SEC=$TIMEOUT_SEC
  {
    exec 9>\"\$LOCK\"
    if ! flock -n 9; then
      echo \"=== another '\$LABEL' already running, exiting (\$(date -Is)) ===\"
      exit 0
    fi
    echo \"=== start \$(date -Is) label='\$LABEL' ===\"
    echo \"=== cmd: \$CMD ===\"
    timeout --foreground \$TIMEOUT_SEC bash -c \"\$CMD\"
    rc=\$?
    echo \"=== end \$(date -Is) rc=\$rc ===\"
    if [ \$SILENT -eq 0 ]; then
      TAIL_OUTPUT=\$(tail -c \$TAIL_CHARS \"\$LOG\" 2>/dev/null || echo '(log unavailable)')
      MSG=\"[long-runner] \$LABEL finished (rc=\$rc)\"\$'\\n'\"\$TAIL_OUTPUT\"
      if [ -n \"\$CHAT\" ]; then
        TELEGRAM_CHAT_ID_OVERRIDE=\"\$CHAT\" bash \"\$NOTIFY\" \"\$MSG\" || true
      else
        bash \"\$NOTIFY\" \"\$MSG\" || true
      fi
    elif [ \$rc -ne 0 ]; then
      # Failures break silent mode -- we always want to know about errors.
      TAIL_OUTPUT=\$(tail -c \$TAIL_CHARS \"\$LOG\" 2>/dev/null || echo '(log unavailable)')
      MSG=\"[long-runner] \$LABEL FAILED (rc=\$rc)\"\$'\\n'\"\$TAIL_OUTPUT\"
      bash \"\$NOTIFY\" \"\$MSG\" || true
    fi
  } >\"$LOG_FILE\" 2>&1
" </dev/null >/dev/null 2>&1

echo "Launched: $LABEL"
echo "Log: $LOG_FILE"
