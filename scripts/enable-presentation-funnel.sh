#!/usr/bin/env bash
# One-time: point Tailscale Funnel at PersonalOS presentation edge (:8787).
# That edge serves /presentations/* as HTML and proxies everything else to
# the existing Whisper API on :9093 — so you keep one public host, no catbox.
#
# Run once from a normal terminal (needs sudo or Tailscale operator):
#   bash ./scripts/enable-presentation-funnel.sh
set -euo pipefail

PORT="${PRESENTATION_PORT:-8787}"
TARGET="http://127.0.0.1:${PORT}"

echo "Checking local presentation edge on ${TARGET} ..."
if ! curl -sf -o /dev/null --max-time 3 "${TARGET}/presentations"; then
  echo "ERROR: nothing responding at ${TARGET}/presentations"
  echo "Start personalos first: systemctl --user start personalos"
  exit 1
fi

echo "Pointing Tailscale Serve + Funnel at ${TARGET}"
echo "(transcription API stays available at / via reverse proxy)"
echo ""

# Prefer operator-capable tailscale; fall back to sudo
run_ts() {
  if tailscale serve status >/dev/null 2>&1 && tailscale serve --help >/dev/null 2>&1; then
    if tailscale serve --bg --yes "$TARGET" 2>/tmp/ts-serve.err; then
      return 0
    fi
  fi
  if command -v sudo >/dev/null; then
    sudo tailscale serve --bg --yes "$TARGET"
    return 0
  fi
  cat /tmp/ts-serve.err 2>/dev/null || true
  return 1
}

run_funnel() {
  if tailscale funnel --bg --yes "$TARGET" 2>/tmp/ts-funnel.err; then
    return 0
  fi
  if command -v sudo >/dev/null; then
    sudo tailscale funnel --bg --yes "$TARGET"
    return 0
  fi
  cat /tmp/ts-funnel.err 2>/dev/null || true
  return 1
}

if ! run_ts; then
  echo "Could not update serve config. Make yourself a Tailscale operator, then re-run:"
  echo "  sudo tailscale set --operator=\$USER"
  echo "  bash $0"
  echo "Or run with sudo:"
  echo "  sudo tailscale serve --bg --yes ${TARGET}"
  echo "  sudo tailscale funnel --bg --yes ${TARGET}"
  exit 1
fi

run_funnel || true

echo ""
echo "Current serve status:"
tailscale serve status || sudo tailscale serve status

HOST=$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || echo "your-host.tailnet.ts.net")

echo ""
echo "Done. Open a deck with:"
echo "  https://${HOST}/presentations/local-models-on-personalos.html"
echo "  https://${HOST}/presentations/"
echo ""
echo "Whisper API still at: https://${HOST}/health  (proxied to :9093)"
