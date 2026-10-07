#!/usr/bin/env bash
# Installs pi-kit on this machine: registers the package with pi and seeds
# per-user config files (never overwrites existing ones).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$AGENT/sounds"

echo "→ registering package with pi"
pi install "${PI_KIT_SOURCE:-$HERE}"


seed() { # seed <src> <dest>
  if [[ -e "$2" ]]; then echo "  keep $2 (exists)"; else cp "$1" "$2"; echo "  wrote $2"; fi
}
echo "→ seeding config"
cp -n "$HERE/assets/sounds/bork.m4a" "$AGENT/sounds/" 2>/dev/null || true
seed "$HERE/config/keybindings.json" "$AGENT/keybindings.json"
if [[ ! -e "$AGENT/notify.json" ]]; then
  sed "s#~/#$HOME/#" "$HERE/config/notify.json" > "$AGENT/notify.json"; echo "  wrote $AGENT/notify.json"
fi

if [[ "${1:-}" == "--voice" ]]; then
  echo "→ voice deps"
  command -v brew >/dev/null && brew install sox whisper-cpp
  M="$AGENT/voice/models"; mkdir -p "$M"
  B=https://huggingface.co/ggerganov/whisper.cpp/resolve/main
  [[ -f $M/ggml-large-v3-turbo-q5_0.bin ]] || curl -L -o "$M/ggml-large-v3-turbo-q5_0.bin" "$B/ggml-large-v3-turbo-q5_0.bin"
  [[ -f $M/ggml-silero-v5.1.2.bin ]] || curl -L -o "$M/ggml-silero-v5.1.2.bin" https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
fi
echo "✓ done — run /reload in pi (or restart). Optional: ./install.sh --voice"
