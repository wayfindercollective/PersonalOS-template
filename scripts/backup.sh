#!/bin/bash
# Optional: commit + push local PersonalOS state to YOUR private backup remote.
# Do not point this at a public template repo.
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="${PATH}"
if ! npm test --silent; then
  echo "[backup] aborted -- tests failed" >&2
  exit 1
fi

git add -A
DATE=$(date +%Y-%m-%d)
if git diff --cached --quiet; then
  echo "No local changes to commit."
else
  git commit -m "auto-backup: ${DATE}"
fi

# Configure a private remote named "personal", then:
#   git push personal main
if git remote get-url personal >/dev/null 2>&1; then
  git push personal main
  echo "Pushed to personal remote."
else
  echo "No 'personal' remote configured — skip push."
fi
