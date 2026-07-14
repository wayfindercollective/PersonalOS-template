#!/usr/bin/env bash
# Send a file (PDF, image, etc.) to Telegram.
# Usage: ./scripts/send-file.sh /path/to/file.pdf "Optional caption"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE" >&2
  exit 1
fi

get_env() {
  grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | sed 's/^["'\''"]//;s/["'\''"]$//'
}

TOKEN=$(get_env TELEGRAM_BOT_TOKEN)
CHAT_ID=$(get_env ALLOWED_CHAT_ID)

if [ -z "$TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not set in .env" >&2
  exit 1
fi

if [ -z "$CHAT_ID" ]; then
  echo "Error: ALLOWED_CHAT_ID not set in .env" >&2
  exit 1
fi

FILE_PATH="$1"
CAPTION="${2:-}"

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  echo "Error: File not found: $FILE_PATH" >&2
  exit 1
fi

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendDocument" \
  -F "chat_id=${CHAT_ID}" \
  -F "document=@${FILE_PATH}" \
  -F "caption=${CAPTION}"
