#!/bin/bash
# Download your YT premiere, transcribe, and notify
# Scheduled for 8:15am CST May 4 2026 (buffer for premiere to fully go live)

VIDEO_URL="https://www.youtube.com/watch?v=ZwPmb09MMfs"
OUTDIR="./workspace/uploads"
SCRIPT_DIR="./scripts"

echo "[$(date)] Starting YT premiere grab..."

# Download audio only (fastest for transcription)
~/.local/bin/yt-dlp \
  -x --audio-format mp3 \
  --audio-quality 0 \
  -o "${OUTDIR}/peter-yt-premiere-%(title)s.%(ext)s" \
  --write-info-json \
  --write-description \
  --write-thumbnail \
  "$VIDEO_URL" 2>&1

if [ $? -ne 0 ]; then
  cat <<'MSG' | "$SCRIPT_DIR/notify.sh"
YT premiere download failed. Video might not be live yet or URL issue. Will retry manually.
MSG
  exit 1
fi

# Find the downloaded file
AUDIO_FILE=$(ls -t "${OUTDIR}"/peter-yt-premiere-*.mp3 2>/dev/null | head -1)
INFO_FILE=$(ls -t "${OUTDIR}"/peter-yt-premiere-*.info.json 2>/dev/null | head -1)

if [ -z "$AUDIO_FILE" ]; then
  cat <<'MSG' | "$SCRIPT_DIR/notify.sh"
YT audio file not found after download. Check ${OUTDIR} manually.
MSG
  exit 1
fi

echo "[$(date)] Audio downloaded: $AUDIO_FILE"
echo "[$(date)] Starting whisper transcription..."

# Transcribe with whisper (medium model for speed/accuracy balance)
whisper "$AUDIO_FILE" \
  --model medium \
  --language en \
  --output_dir "${OUTDIR}" \
  --output_format txt 2>&1

TRANSCRIPT=$(ls -t "${OUTDIR}"/peter-yt-premiere-*.txt 2>/dev/null | head -1)

if [ -z "$TRANSCRIPT" ]; then
  cat <<'MSG' | "$SCRIPT_DIR/notify.sh"
Whisper transcription failed or no output. Audio file exists at ${AUDIO_FILE}. Check manually.
MSG
  exit 1
fi

# Get video title from info json
TITLE="unknown"
if [ -n "$INFO_FILE" ]; then
  TITLE=$(python3 -c "import json; print(json.load(open('${INFO_FILE}'))['title'])" 2>/dev/null || echo "unknown")
fi

echo "[$(date)] Transcription done: $TRANSCRIPT"
echo "[$(date)] Video title: $TITLE"

cat <<MSG | "$SCRIPT_DIR/notify.sh"
YT premiere downloaded and transcribed!

Title: $TITLE
Audio: $AUDIO_FILE
Transcript: $TRANSCRIPT

Ready to draft promo posts. Just say the word.
MSG

echo "[$(date)] Done. Notification sent."
