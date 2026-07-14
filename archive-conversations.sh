#!/usr/bin/env bash
# Archive Claude Code session JSONL files into ./archives/YYYY-MM/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Claude Code stores sessions under ~/.claude/projects/<cwd-with-slashes-as-dashes>/
PROJECT_KEY="$(pwd | sed 's|/|-|g; s|^-||')"
SESSIONS_DIR="${HOME}/.claude/projects/-${PROJECT_KEY}"
if [[ ! -d "$SESSIONS_DIR" ]]; then
  SESSIONS_DIR="${HOME}/.claude/projects/${PROJECT_KEY}"
fi
ARCHIVE_ROOT="${ROOT}/archives"
mkdir -p "$ARCHIVE_ROOT"
if [[ ! -d "$SESSIONS_DIR" ]]; then
  echo "No sessions dir at $SESSIONS_DIR — nothing to archive."
  exit 0
fi
shopt -s nullglob
for f in "$SESSIONS_DIR"/*.jsonl; do
  month=$(date -r "$f" +%Y-%m 2>/dev/null || date -d "$(stat -c %y "$f")" +%Y-%m 2>/dev/null || date +%Y-%m)
  dest="$ARCHIVE_ROOT/$month"
  mkdir -p "$dest"
  base=$(basename "$f")
  if [[ ! -f "$dest/$base" ]]; then
    cp -n "$f" "$dest/$base" 2>/dev/null || cp "$f" "$dest/$base"
    echo "archived $base -> $dest/"
  fi
done
echo "done"
