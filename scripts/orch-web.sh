#!/bin/sh
# Start orch-web and keep it in the foreground (launchd/service managers expect
# a non-forking process). Assumes `node` and `pi` are on PATH; override with
# ORCH_WEB_NODE / ORCH_WEB_PI.
#
#   ./scripts/orch-web.sh --pair     print a pairing code for a phone
#   ./scripts/orch-web.sh            serve on the LAN address
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)

node=${ORCH_WEB_NODE:-$(command -v node || true)}
if [ -z "$node" ]; then
  echo "node not found; set ORCH_WEB_NODE" >&2
  exit 127
fi

# Resolve @earendil-works/pi-coding-agent the same way pi does.
if [ -d "$HOME/.pi/agent/install" ]; then
  ORCH_WEB_PI=$("$node" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = path.join(process.env.HOME, ".pi", "agent");
    let v;
    try { v = fs.readFileSync(path.join(root, "install", "current-version"), "utf8").trim(); }
    catch { process.exit(0); }
    const dir = path.join(root, "install", "releases", v, "node_modules");
    if (fs.existsSync(dir)) process.stdout.write(dir);
  ')
fi

if [ -n "$ORCH_WEB_PI" ]; then
  export NODE_PATH="$ORCH_WEB_PI${NODE_PATH:+:$NODE_PATH}"
fi

# Background agents must spawn pi, not this daemon.
export PI_INBOX_AGENT_CMD="${PI_INBOX_AGENT_CMD:-$HOME/.pi/agent/bin/pi}"

# Terminals (opt-in). The native node-pty module lives outside this checkout:
# node_modules here is a set of symlinks into the pi install, and running a
# normal `npm install` would replace them. See extensions/orch-web/README.md.
export ORCH_WEB_DEPS="${ORCH_WEB_DEPS:-$HOME/.pi/agent/orch-web-deps}"

# Provider credentials. launchd gives us almost no environment, so a child pi
# spawned from here cannot authenticate without these: it exits with "No API key
# found for the selected model" and the message silently never runs. The file is
# outside the repo (it holds token paths and an internal base URL), written by
# `orch-web-install.sh --capture-env` from a shell that already has them.
envfile="$HOME/.pi/agent/orch-web.env"
if [ -f "$envfile" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$envfile"
  set +a
fi

exec "$node" --experimental-transform-types --no-warnings \
  "$root/extensions/orch-web/cli.ts" "$@"
