#!/usr/bin/env bash
# Installs pi-kit on this machine: registers the package with pi, optionally
# loads only chosen extensions, and seeds per-user config (never overwritten).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SOURCE="${PI_KIT_SOURCE:-$HERE}"

# All extensions, in canonical order. Keep the string-form name in sync with
# package.json's pi.extensions paths (extensions/<name>/index.ts).
ALL_EXTENSIONS=(compat-check inbox plan-mode inline-skills md-fence-render tool-output-hide notify rename-chat final-answer-divider voice)

usage() {
	cat <<'EOF'
usage: ./install.sh [--extensions <list|all>] [--voice] [--no-config]

  --extensions <list>  comma-separated extension names (see --list); or 'all'.
                       Without it, installs with every extension enabled.
  --list               print extension names, one per line, and exit.
  --no-config          skip seeding ~/.pi/agent config files.
  --voice              also install voice deps (sox, whisper-cpp, models).

Selection is stored in pi's settings.json as the native object-form package
entry, so `pi config` can still adjust it later. Run again to change your
selection; every previously enabled extension is replaced by the new list.

Examples:
  ./install.sh                                  # everything
  ./install.sh --extensions inbox,plan-mode     # pick and choose
  ./install.sh --extensions all --voice         # everything + voice deps
EOF
}

SELECT=""
SEED_CONFIG=1
VOICE=0
while [[ $# -gt 0 ]]; do
	case "$1" in
	--extensions)
		[[ $# -ge 2 ]] || { echo "install.sh: --extensions needs a value" >&2; exit 2; }
		SELECT="$2"; shift 2 ;;
	--list)
		printf '%s\n' "${ALL_EXTENSIONS[@]}"; exit 0 ;;
	--no-config)
		SEED_CONFIG=0; shift ;;
	--voice)
		VOICE=1; shift ;;
	-h|--help)
		usage; exit 0 ;;
	*)
		echo "install.sh: unknown option: $1 (see --help)" >&2; exit 2 ;;
	esac
done

validate() { # validate <csv>
	local -a want
	IFS=, read -ra want <<<"$1"
	local name
	for name in "${want[@]}"; do
		name="${name%% }"; name="${name## }"
		local ok=""
		local known
		for known in "${ALL_EXTENSIONS[@]}"; do [[ "$name" == "$known" ]] && ok=1 && break; done
		[[ -n "$ok" ]] || { echo "install.sh: unknown extension '$name' (--list shows names)" >&2; exit 2; }
	done
}

if [[ "$SELECT" == "all" || -z "$SELECT" ]]; then
	SELECT=""
else
	validate "$SELECT"
fi

echo "→ registering package with pi"
pi install "$SOURCE"

if [[ -n "$SELECT" ]]; then
	echo "→ loading only: ${SELECT//,/ }"
	node "$HERE/lib/select-extensions.cjs" "$AGENT/settings.json" "$SOURCE" --extensions "$SELECT"
else
	echo "→ all extensions enabled (run again with --extensions <list> to pick)"
	node "$HERE/lib/select-extensions.cjs" "$AGENT/settings.json" "$SOURCE" --extensions all
fi

if [[ -n "$SELECT" ]] && [[ "$SELECT" == *"voice"* ]]; then
	# Voice selection without --voice: models won't exist until deps are set up.
	VOICE=1
fi

mkdir -p "$AGENT/sounds"
if [[ "$SEED_CONFIG" -eq 1 ]]; then
	seed() { # seed <src> <dest>
		if [[ -e "$2" ]]; then echo "  keep $2 (exists)"; else cp "$1" "$2"; echo "  wrote $2"; fi
	}
	echo "→ seeding config"
	cp -n "$HERE/assets/sounds/bork.m4a" "$AGENT/sounds/" 2>/dev/null || true
	seed "$HERE/config/keybindings.json" "$AGENT/keybindings.json"
	if [[ ! -e "$AGENT/notify.json" ]]; then
		sed "s#~/#$HOME/#" "$HERE/config/notify.json" > "$AGENT/notify.json"; echo "  wrote $AGENT/notify.json"
	fi
fi

if [[ "$VOICE" -eq 1 ]]; then
	echo "→ voice deps"
	command -v brew >/dev/null && brew install sox whisper-cpp
	M="$AGENT/voice/models"; mkdir -p "$M"
	B=https://huggingface.co/ggerganov/whisper.cpp/resolve/main
	[[ -f $M/ggml-large-v3-turbo-q5_0.bin ]] || curl -L -o "$M/ggml-large-v3-turbo-q5_0.bin" "$B/ggml-large-v3-turbo-q5_0.bin"
	[[ -f $M/ggml-silero-v5.1.2.bin ]] || curl -L -o "$M/ggml-silero-v5.1.2.bin" https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
fi
echo "✓ done — restart pi (or run /reload). Adjust anytime: ./install.sh --extensions <list> | pi config"
