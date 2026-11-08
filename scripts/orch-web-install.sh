#!/bin/sh
# Install orch-web as a launchd login agent: starts at login, restarts on crash.
#
#   ./scripts/orch-web-install.sh                  install and start
#   ./scripts/orch-web-install.sh --restart        restart (after code changes)
#   ./scripts/orch-web-install.sh --stop           stop until next login/start
#   ./scripts/orch-web-install.sh --status         is it loaded?
#   ./scripts/orch-web-install.sh --pair           print a phone pairing code
#   ./scripts/orch-web-install.sh --capture-env    save the child environment
#   ./scripts/orch-web-install.sh --remove         stop and remove
#
# Run --capture-env once from a terminal where pi works, with
# ORCH_WEB_ENV_VARS set. launchd starts the daemon with almost no environment,
# so without this its child pi processes cannot authenticate and a message from
# the phone silently fails to run.
#
# Logs: ~/.pi/agent/orch-web.log
set -eu

label="dev.pi.orch-web"
plist="$HOME/Library/LaunchAgents/$label.plist"
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
log="$HOME/.pi/agent/orch-web.log"
uid=$(id -u)

envfile="$HOME/.pi/agent/orch-web.env"

capture_env() {
  # A child pi started by the daemon inherits this file's contents. It records
  # the environment a working pi has and this one does not, because launchd
  # supplies almost nothing. Values are quoted: several contain spaces, and an
  # unquoted assignment silently truncates at the first space.
  #
  # Set ORCH_WEB_ENV_VARS to choose what is captured (space separated).
  # ORCH_WEB_ENV_REQUIRED names the ones whose absence should abort.
  keep="${ORCH_WEB_ENV_VARS:-}"
  required="${ORCH_WEB_ENV_REQUIRED:-}"
  if [ -z "$keep" ]; then
    echo "error: ORCH_WEB_ENV_VARS is not set." >&2
    echo "List the variables a spawned pi needs, e.g.:" >&2
    echo "  ORCH_WEB_ENV_VARS='MY_TOKEN_PATH MY_API_URL' \\" >&2
    echo "    $root/scripts/orch-web-install.sh --capture-env" >&2
    exit 1
  fi

  out="# Captured by orch-web-install.sh --capture-env on $(date).
# Environment for pi children spawned by the daemon."
  missing=""
  count=0
  for name in $keep; do
    value=$(printenv "$name" 2>/dev/null || true)
    if [ -z "$value" ]; then
      case " $required " in
        *" $name "*) missing="$missing $name" ;;
      esac
      continue
    fi
    quoted=$(printf '%s' "$value" | sed "s/'/'\\\\''/g")
    out="$out
$name='$quoted'"
    count=$((count + 1))
  done
  if [ -n "$missing" ]; then
    echo "error: required variables not set in this shell:$missing" >&2
    echo "A partial capture cannot authenticate; refusing to write it." >&2
    echo "Run this where pi works." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$envfile")"
  printf '%s\n' "$out" > "$envfile"
  chmod 600 "$envfile"
  echo "wrote $envfile ($count variables, mode 600)"
  echo "restart the daemon to pick it up: launchctl kickstart -k gui/$uid/dev.pi.orch-web"
}

case "${1:-}" in
--capture-env)
  capture_env
  exit 0
  ;;
--remove)
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "removed $label"
  exit 0
  ;;
--status)
  # Distinguish "not installed" from "launchctl refused to answer" — the latter
  # happens in sandboxed shells and would otherwise look like the service is down.
  out=$(launchctl print "gui/$uid/$label" 2>&1) || true
  case "$out" in
    *"Operation not permitted"*)
      echo "launchctl unavailable here; run this from a normal Terminal" ;;
    *"Could not find service"*|"")
      echo "not loaded" ;;
    *)
      echo "loaded: $label"
      printf '%s\n' "$out" | grep -E "state|pid" | head -4 ;;
  esac
  if [ -f "$HOME/.pi/agent/orch-web-token" ]; then
    port="${ORCH_WEB_PORT:-8787}"
    echo
    echo "phone: http://$(hostname -s).local:$port/   (or this Mac's LAN IP)"
    echo "pair:  $root/scripts/orch-web-install.sh --pair"
  fi
  exit 0
  ;;
--restart)
  if ! launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
    echo "not installed; run $0 with no arguments first" >&2
    exit 1
  fi
  launchctl kickstart -k "gui/$uid/$label"
  sleep 3
  if grep -aq "orch-web listening" "$log" 2>/dev/null; then
    tail -2 "$log" | grep -a "listening\|local:" || true
    echo "restarted"
  else
    echo "restarted, but no listen line yet; see $log" >&2
  fi
  exit 0
  ;;
--stop)
  launchctl kill SIGTERM "gui/$uid/$label" 2>/dev/null ||
    { echo "not loaded" >&2; exit 0; }
  echo "stopped (KeepAlive restarts it at next login; use --remove to stop for good)"
  exit 0
  ;;
--pair)
  exec "$root/scripts/orch-web.sh" --pair
  ;;
--help|-h)
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
  ;;
"")
  ;;
*)
  # An unknown flag used to fall through to a full install, which is a bad
  # surprise for something like --pair (that belongs to orch-web.sh).
  echo "orch-web-install.sh: unknown option: $1" >&2
  echo "try: --capture-env | --status | --remove | --help" >&2
  exit 2
  ;;
esac

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.pi/agent"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$root/scripts/orch-web.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$root</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$uid/$label" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$plist"
launchctl enable "gui/$uid/$label" 2>/dev/null || true

sleep 2
if grep -q "orch-web listening" "$log" 2>/dev/null; then
  tail -2 "$log"
else
  echo "installed, but it has not logged a listen line yet; see $log" >&2
fi
echo
echo "pair a phone with: $root/scripts/orch-web.sh --pair"
