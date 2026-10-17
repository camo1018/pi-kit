#!/usr/bin/env bash
# Optional, one-shot UI preview. No installation or live configuration changes.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Never resolve bare `pi`: a user's PATH may point at a wrapper with its own
# configuration. Use the same local runtime as the seed SDK.
RUNTIME="$ROOT/node_modules/.bin/pi"
if [ ! -x "$RUNTIME" ]; then
  printf 'Local Pi runtime is missing: %s\n' "$RUNTIME" >&2
  exit 1
fi
STATE=$(mktemp -d "${TMPDIR:-/tmp}/pi-inbox-preview.XXXXXX")
export PI_CODING_AGENT_DIR="$STATE"
export PI_INBOX_PREVIEW_DIR="$STATE"
export PI_OFFLINE=1
unset PI_CODING_AGENT_SESSION_DIR PI_INBOX_AGENT_ARGS
unset PI_INBOX_BG_AGENT PI_INBOX_BG_PARENT PI_INBOX_AUTO_APPROVE_MCP

cleanup() {
  # Detached preview agents may outlive the window. Preserve their state.
  if node --input-type=module - "$STATE" <<'JS'
import * as fs from "node:fs";
import * as path from "node:path";
const dir = path.join(process.argv[2], "inbox-agents");
let preserve = false;
for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  if (!name.endsWith(".json")) continue;
  try {
    const agent = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    if (agent.pending?.length) preserve = true;
    if (agent.pid) {
      try { process.kill(agent.pid, 0); preserve = true; } catch {}
    }
  } catch { preserve = true; }
}
process.exit(preserve ? 1 : 0);
JS
  then
    rm -rf "$STATE"
  else
    printf '\nPreview agents remain; state preserved at %s\n' "$STATE"
    printf 'Stop them in the preview before removing that directory.\n'
  fi
}
trap cleanup EXIT
cd "$ROOT"
cp "$ROOT/config/keybindings.json" "$STATE/keybindings.json"
node --input-type=module - "$ROOT" <<'JS'
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, SessionManager } from
  "./node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const root = process.argv[2];
const dir = process.env.PI_CODING_AGENT_DIR;
if (path.resolve(getAgentDir()) !== path.resolve(dir)) {
  throw new Error("Preview SDK did not honor the temporary agent directory");
}
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
  packages: [{
    source: root,
    extensions: ["extensions/inbox/index.ts"],
    skills: [],
  }],
  extensions: [path.join(root, "scripts/inbox-preview.ts")],
  defaultTools: [],
  defaultProjectTrust: "never",
  tuiMode: "fullscreen",
  theme: "dark",
}));
fs.writeFileSync(path.join(dir, "notify.json"), '{"enabled":false}');
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
for (const title of ["PR review demo", "Bug triage demo"]) {
  const session = SessionManager.create(root);
  session.appendMessage({
    role: "user", content: title, timestamp: Date.now(),
  });
  session.appendMessage({
    role: "assistant", api: "openai-responses", provider: "preview",
    model: "preview", stopReason: "stop", timestamp: Date.now(), usage,
    content: [{ type: "text", text: "Preview only. No real task has run." }],
  });
  session.appendSessionInfo(title);
}
JS
printf 'INBOX PREVIEW: temporary state at %s\n' "$STATE"
printf 'Runtime: %s\n' "$RUNTIME"
printf 'Uses this worktree as cwd. Live sessions are not loaded.\n'
printf 'Tools are disabled; no credentials are copied.\n'
"$RUNTIME" --no-extensions \
  -e "$ROOT/scripts/inbox-preview.ts" \
  -e "$ROOT/extensions/inbox/index.ts" \
  --no-tools --orchestrator --no-approve "$@"
