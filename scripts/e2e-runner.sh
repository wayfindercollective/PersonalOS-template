#!/usr/bin/env bash
# Playwright E2E runner (optional; set WORK_PROJECT_DIR).
# tool `run_e2e_tests`. Detached via `setsid -f` so the caller returns
# instantly. Locks with flock to prevent concurrent runs. Posts a Telegram
# summary via notify.sh when done.
#
# Modes:
#   dev   (default) — Next.js dev server on :3001
#   prod            — E2E_PROD=1, production build on :3002
#
# Usage:
#   e2e-runner.sh [--mode dev|prod] [--spec PATTERN] [--workers N] [--project NAME] [--notify-chat ID]

set -u

SPEC=""
WORKERS=2
PROJECT="full"
MODE="dev"
NOTIFY_CHAT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --spec)         SPEC="$2"; shift 2 ;;
    --workers)      WORKERS="$2"; shift 2 ;;
    --project)      PROJECT="$2"; shift 2 ;;
    --mode)         MODE="$2"; shift 2 ;;
    --notify-chat)  NOTIFY_CHAT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$PROJECT" in
  full|light|qa) ;;
  *) echo "Unknown project: $PROJECT (use full|light|qa)" >&2; exit 2 ;;
esac

case "$MODE" in
  dev|prod) ;;
  *) echo "Unknown mode: $MODE (use dev|prod)" >&2; exit 2 ;;
esac

if ! [[ "$WORKERS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Workers must be a positive integer" >&2
  exit 2
fi

# Per-mode config. SERVER_ENV is passed through `env` so KEY=VALUE prefixes
# work; SERVER_CMD is the actual command. SERVER_WAIT is the max seconds we
# poll the URL — prod mode kicks off `next build && next start` under the hood
# (triggered by E2E_PROD=1) which routinely takes 3-4 min on this machine, so we
# allow up to 5 min there. Dev mode comes up in seconds.
if [ "$MODE" = "prod" ]; then
  PORT=3002
  BASE_URL="http://localhost:3002"
  SERVER_ENV="E2E_PROD=1"
  SERVER_CMD="npm run dev -- --port 3002"
  SERVER_WAIT=300
else
  PORT=3001
  BASE_URL="http://localhost:3001"
  SERVER_ENV=""
  SERVER_CMD="npm run dev -- --port 3001"
  SERVER_WAIT=120
fi

WO_DIR="${WORK_PROJECT_DIR:-$HOME/Dev/my-app}"
NODE_BIN_DIR="${NODE_BIN_DIR:-$(dirname "$(command -v node)")}"
LOG_DIR="./store/e2e-logs"
LOCK_DIR="./store"
LOCK_FILE="$LOCK_DIR/e2e-runner.lock"
DEV_SERVER_LOG="./store/e2e-dev-server-${MODE}.log"
NOTIFY="./scripts/notify.sh"
STAMP="$(date +%Y-%m-%d_%H%M%S_%N)"
LOG_FILE="$LOG_DIR/e2e-${MODE}-${STAMP}.log"
ARTIFACT_DIR="./store/e2e-artifacts/${MODE}-${STAMP}"

mkdir -p "$LOG_DIR"
mkdir -p "$ARTIFACT_DIR"

# Detached child. flock guards against concurrent runs.
setsid -f bash -c "
  exec 9>$(printf '%q' "$LOCK_FILE")
  if ! flock -n 9; then
    echo \"=== another e2e run already in progress, exiting (\$(date -Is)) ===\"
    bash $(printf '%q' "$NOTIFY") 'E2E run skipped: another run is already in progress.'
    exit 0
  fi

  export PATH=$(printf '%q' "$NODE_BIN_DIR"):\$PATH
  cd $(printf '%q' "$WO_DIR")

  echo \"=== e2e start \$(date -Is) mode=$MODE project=$PROJECT spec=$(printf '%q' "$SPEC") workers=$WORKERS port=$PORT ===\"
  echo \"=== node: \$(node --version 2>/dev/null || echo 'NOT FOUND') ===\"

  echo \"--- git pull origin dev ---\"
  git pull origin dev 2>&1 || echo '(git pull failed -- proceeding with current checkout)'

  # Helper: kill anything bound to a TCP port. Tries fuser, lsof, then ss.
  kill_port() {
    local port=\$1
    local pids=''
    if command -v fuser >/dev/null 2>&1; then
      fuser -k -TERM \${port}/tcp >/dev/null 2>&1 || true
      sleep 2
      fuser -k -KILL \${port}/tcp >/dev/null 2>&1 || true
      return 0
    fi
    if command -v lsof >/dev/null 2>&1; then
      pids=\$(lsof -ti:\$port 2>/dev/null || true)
    else
      pids=\$(ss -tnlp \"sport = :\$port\" 2>/dev/null | grep -oP 'pid=\\K\\d+' | sort -u | tr '\\n' ' ')
    fi
    if [ -n \"\$pids\" ]; then
      echo \"--- killing pid(s) on :\$port: \$pids ---\"
      echo \$pids | xargs -r kill 2>/dev/null || true
      sleep 2
      echo \$pids | xargs -r kill -9 2>/dev/null || true
    fi
  }

  # Decide: reuse existing server if it responds correctly, else kill+restart.
  if curl -sf -o /dev/null --max-time 3 $BASE_URL/; then
    echo '--- dev server already responding on :$PORT — reusing ---'
  else
    # Kill any zombie or wrong-mode listener on the target port before starting.
    kill_port $PORT
    echo '--- starting server (mode=$MODE detached) ---'
    setsid -f bash -c '
      export PATH=$(printf '%q' "$NODE_BIN_DIR"):\$PATH
      cd $(printf '%q' "$WO_DIR")
      exec env $SERVER_ENV $SERVER_CMD
    ' </dev/null >$(printf '%q' "$DEV_SERVER_LOG") 2>&1
    echo '--- waiting up to '$SERVER_WAIT's for $BASE_URL ---'
    for i in \$(seq 1 $SERVER_WAIT); do
      if curl -sf -o /dev/null --max-time 2 $BASE_URL/; then
        echo \"  server up after \${i}s\"
        break
      fi
      sleep 1
    done
    if ! curl -sf -o /dev/null --max-time 2 $BASE_URL/; then
      echo '!!! server failed to come up within '$SERVER_WAIT's — aborting'
      tail -n 30 $(printf '%q' "$DEV_SERVER_LOG") || true
      bash $(printf '%q' "$NOTIFY") 'E2E FAILED: server (mode=$MODE) on :$PORT did not come up within '$SERVER_WAIT's. Check $DEV_SERVER_LOG.'
      exit 1
    fi
  fi

  # Pass E2E_BASE_URL through to Playwright so tests hit the right port.
  export E2E_BASE_URL=$BASE_URL

  # Redirect Playwright artifacts into personalos/store so they always land
  # on a path the bot has write access to (also keeps them grouped per-run).
  # ReadWritePaths now includes work-project, so the original paths would
  # work too — but routing to personalos/store is the safer default.
  export PLAYWRIGHT_HTML_REPORT=$(printf '%q' "$ARTIFACT_DIR/html")

  # Build playwright argv as an array so quoting is preserved.
  set -- npx playwright test --project=$(printf '%q' "$PROJECT") --workers=$WORKERS --reporter=list --output=$(printf '%q' "$ARTIFACT_DIR/results")
  if [ -n \"$(printf '%q' "$SPEC")\" ]; then
    set -- \"\$@\" --grep $(printf '%q' "$SPEC")
  fi

  echo \"--- running: \$* ---\"
  start=\$SECONDS
  \"\$@\"
  rc=\$?
  elapsed=\$((SECONDS - start))
  echo \"=== e2e end \$(date -Is) rc=\$rc elapsed=\${elapsed}s ===\"

  # Extract summary line (Playwright list reporter prints something like
  # '4 failed, 2 skipped, 138 passed (12m 34s)' near the bottom).
  summary=\$(grep -E '[0-9]+\\s+(passed|failed|skipped|flaky)' ./store/e2e-logs/$(basename '$LOG_FILE') | tail -3 | tr '\\n' ' ')
  # Extract failing test names if any (Playwright list reporter marks them with ✘ or ✗)
  failing=\$(grep -E '^[[:space:]]*(✘|✗|FAIL)' ./store/e2e-logs/$(basename '$LOG_FILE') 2>/dev/null | head -20 | sed 's/^/  /')

  msg=\"E2E run finished — mode=$MODE, rc=\$rc, elapsed=\${elapsed}s, project=$PROJECT\"
  if [ -n \"\$summary\" ]; then msg=\"\$msg\"\$'\\n'\"\$summary\"; fi
  if [ \$rc -ne 0 ] && [ -n \"\$failing\" ]; then msg=\"\$msg\"\$'\\n\\nFailures:\\n'\"\$failing\"; fi

  bash $(printf '%q' "$NOTIFY") \"\$msg\" || echo '(notify.sh failed)'
" </dev/null >"$LOG_FILE" 2>&1

echo "Launched E2E (mode=$MODE, project=$PROJECT, workers=$WORKERS${SPEC:+, spec=$SPEC}) on :$PORT"
echo "Log: $LOG_FILE"
