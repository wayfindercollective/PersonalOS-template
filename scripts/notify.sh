#!/usr/bin/env bash
# Send a notification message to Telegram from shell scripts.
# Usage: ./scripts/notify.sh "Your message here"
#    or: echo "message" | ./scripts/notify.sh
#
# Supports stdin to avoid shell expansion issues with $ signs in messages.

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

# Accept message from argument or stdin
if [ -n "$1" ]; then
  MESSAGE="$1"
elif [ ! -t 0 ]; then
  MESSAGE="$(cat)"
else
  MESSAGE="No message provided"
fi

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${MESSAGE}" \
  --data-urlencode "parse_mode=HTML" > /dev/null 2>&1

if [ $? -eq 0 ]; then
  echo "Sent."
else
  echo "Failed to send message." >&2
  exit 1
fi
