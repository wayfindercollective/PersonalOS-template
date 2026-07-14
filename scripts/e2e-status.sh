#!/usr/bin/env bash
# Report the status of the most recent (or in-progress) E2E run.

set -u

LOG_DIR="./store/e2e-logs"
LOCK_FILE="./store/e2e-runner.lock"
DEV_SERVER_LOG="./store/e2e-dev-server.log"

# Is a run currently in progress? flock will succeed if the lock is free,
# fail if it's held.
in_progress="no"
if [ -f "$LOCK_FILE" ]; then
  if ! flock -n -x "$LOCK_FILE" -c true 2>/dev/null; then
    in_progress="yes"
  fi
fi

echo "E2E status:"
echo "  in_progress: $in_progress"

# Dev server check
if curl -sf -o /dev/null --max-time 3 http://localhost:3001/; then
  echo "  dev_server :3001: UP"
else
  echo "  dev_server :3001: down"
fi

# Latest log
LATEST=$(ls -t "$LOG_DIR"/e2e-*.log 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "  no E2E logs yet"
  exit 0
fi
echo "  latest log: $LATEST"
SIZE=$(stat -c '%s' "$LATEST" 2>/dev/null || echo "?")
MTIME=$(stat -c '%y' "$LATEST" 2>/dev/null | cut -d'.' -f1)
echo "  size: $SIZE bytes  mtime: $MTIME"

# Progress markers
PROGRESS=$(grep -E "^\s+[0-9]+/[0-9]+\b" "$LATEST" 2>/dev/null | tail -1)
if [ -n "$PROGRESS" ]; then echo "  last progress: $PROGRESS"; fi

# Most recent passed/failed/skipped tallies seen in the log
TALLY=$(grep -E "[0-9]+\s+(passed|failed|skipped|flaky)" "$LATEST" 2>/dev/null | tail -3)
if [ -n "$TALLY" ]; then
  echo "  tallies seen:"
  echo "$TALLY" | sed 's/^/    /'
fi

echo "  --- tail (last 15 lines) ---"
tail -n 15 "$LATEST" 2>/dev/null | sed 's/^/    /'
