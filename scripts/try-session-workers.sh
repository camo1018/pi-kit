#!/usr/bin/env bash
# Real-model smoke test with temporary state and read-only bigbrain access.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUNTIME=${PI_WORKERS_TRIAL_RUNTIME:-$ROOT/node_modules/.bin/pi}
if [ ! -x "$RUNTIME" ]; then
  printf 'Pi runtime is missing: %s\n' "$RUNTIME" >&2
  exit 1
fi
MODEL=${PI_WORKERS_TRIAL_MODEL:-}
if [ -z "$MODEL" ]; then
  printf 'Set PI_WORKERS_TRIAL_MODEL to provider/model[:thinking].\n' >&2
  exit 1
fi
export PI_WORKERS_TRIAL_PROVIDER_EXTENSION
STATE=$(mktemp -d "${TMPDIR:-/tmp}/pi-workers-trial.XXXXXX")
export PI_CODING_AGENT_DIR="$STATE"
export PI_WORKERS_TRIAL_DIR="$STATE"
export PI_WORKERS_TRIAL_BIGBRAIN=${PI_WORKERS_TRIAL_BIGBRAIN:-\
$HOME/.pi/agent/extensions/bigbrain.ts}
export PI_OFFLINE=1
export PI_INBOX_MAX_AGENTS=2
unset PI_CODING_AGENT_SESSION_DIR PI_INBOX_AGENT_ARGS
unset PI_INBOX_BG_AGENT PI_INBOX_BG_PARENT PI_INBOX_AUTO_APPROVE_MCP
unset PI_SESSION_ID PI_SESSION_FILE PI_BIGBRAIN_GROUP_SNAPSHOT
unset BIGBRAIN_MAINT BIGBRAIN_MAINT_PI_EXTENSIONS
export PI_WORKERS_TRIAL_MODEL="$MODEL"
node --input-type=module - "$ROOT" "$STATE" <<'JS'
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
const [root, state] = process.argv.slice(2);
const provider = process.env.PI_WORKERS_TRIAL_PROVIDER_EXTENSION;
const providers = provider ? [resolve(provider)] : [];
const parent = randomUUID();
const group = randomUUID();
const extension = name => join(root, "extensions", name, "index.ts");
writeFileSync(join(state, "parent-id"), parent);
writeFileSync(join(state, "settings.json"), JSON.stringify({
  packages: [], skills: [],
  extensions: [
    "-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode",
    "-builtin:tool-search",
    join(root, "scripts", "session-workers-trial.ts"),
    ...providers,
    extension("group-memory"), extension("session-workers"),
  ],
  defaultTools: ["read", "session_workers", "memory_recall", "memory_get"],
  defaultProjectTrust: "never",
  retry: { maxRetries: 1 },
  defaultThinkingLevel: "low",
}));
writeFileSync(join(state, "inbox-groups.json"), JSON.stringify({
  version: 1,
  groups: [{ id: group, name: "Session workers trial",
    templateEnabled: false, template: "" }],
  sessions: { [parent]: group },
}));
mkdirSync(join(state, "inputs"));
const nonce = "violet-heron-" + randomBytes(6).toString("hex");
writeFileSync(join(state, "inputs", "worker-a.md"), [
  "Synthetic trial fact: the wire timeout unit is milliseconds.",
  `Verification nonce: ${nonce}`,
].join("\n"));
writeFileSync(join(state, "inputs", "worker-b.md"), [
  "Recall existing bigbrain knowledge about pi-kit group-memory.",
  "Determine whether group tags use a stable group ID or display name.",
  "Do not create, update, or delete any memories.",
].join("\n"));
writeFileSync(join(state, "trial-prompt.md"), [
  "Run a small read-only session_workers smoke test.",
  "First recall existing knowledge about pi-kit session workers.",
  "Spawn exactly two workers, keeping both in this working directory.",
  "Worker A: read inputs/worker-a.md, then share a NOTE_A containing " +
    "the timeout unit, fixture path, and verification nonce.",
  "Worker B: read inputs/worker-b.md, use memory_recall to answer it, " +
    "then share a NOTE_B with the answer and memory topic/id evidence.",
  "Tell each worker to look for its sibling's note after publishing " +
    "its own. It can call notes up to eight times if needed. Its final " +
    "reply must quote the sibling's actual finding, not guess.",
  "Wait for both workers and inspect their actual replies and notes.",
  "If a sibling note arrived too late, send that worker one follow-up " +
    "to inspect the board and quote it, then wait again.",
  "Never spawn a third worker. Never modify files or durable memory.",
  "Finish with the two session IDs, the exchanged findings, whether " +
    "bigbrain recall worked, and any blockers. Do not claim success " +
    "without evidence from both workers.",
].join("\n"));
JS
IFS= read -r PARENT < "$STATE/parent-id" || true
printf 'Worker trial state: %s\n' "$STATE"
printf 'Parent session: %s\n' "$PARENT"
printf 'Model: %s\n' "$MODEL"
printf 'No live settings changed. Bigbrain writes/maintenance disabled.\n'
# Preserve transcripts and notes for inspection. Don't delete running agents.
cd "$STATE"
python3 - "$RUNTIME" "$STATE" "$PARENT" "$MODEL" <<'PY'
import json
import pathlib
import subprocess
import sys

runtime, state, parent, model = sys.argv[1:]
root = pathlib.Path(state)
args = [runtime, '--mode', 'json', '--no-approve', '--no-context-files',
        '--session-id', parent, '--model', model,
        '@' + str(root / 'trial-prompt.md')]
try:
    with (root / 'parent.out').open('w') as out:
        with (root / 'parent.err').open('w') as err:
            result = subprocess.run(args, stdout=out, stderr=err,
                                    timeout=300)
            if result.returncode:
                raise SystemExit(result.returncode)
    workers = [json.loads(p.read_text()) for p in
               (root / 'session-workers/workers').glob('*.json')]
    if len(workers) != 2:
        raise SystemExit('Trial incomplete: expected two worker sessions')
    groups = json.loads((root / 'inbox-groups.json').read_text())
    for worker in workers:
        if groups['sessions'].get(worker['id']) != groups['sessions'][parent]:
            raise SystemExit('Trial failed: worker group was not inherited')
        pattern = '*/*_' + worker['id'] + '.jsonl'
        files = list((root / 'sessions').glob(pattern))
        if len(files) != 1:
            raise SystemExit('Trial incomplete: worker transcript missing')
        lines = files[0].read_text().splitlines()
        entries = [json.loads(line) for line in lines]
        messages = [entry['message'] for entry in entries
                    if entry['type'] == 'message']
        final = next(m for m in reversed(messages) if m['role'] == 'assistant')
        if final.get('stopReason') != 'stop':
            raise SystemExit('Trial failed: worker did not finish normally')
    notes = [json.loads(p.read_text()) for p in
             (root / 'session-workers/notes' / parent).glob('*.json')]
    authors = {note['author'] for note in notes}
    if not all(worker['id'] in authors for worker in workers):
        raise SystemExit('Trial incomplete: both workers must publish notes')
    print('Verified two finished workers, group inheritance, '
          'and shared notes.')
finally:
    # Only this isolated trial's agents; no other sessions are touched.
    for file in (root / 'inbox-agents').glob('*.json'):
        agent = json.loads(file.read_text())
        if agent.get('pid') or agent.get('pending'):
            (file.parent / (agent['id'] + '.stop')).write_text('trial ended')
            # The owning parent has exited, so no writer owns this queue.
            agent['pending'] = []
            agent['state'] = 'cancelled'
            agent.pop('restartAfterInterrupt', None)
            temporary = file.with_suffix('.json.trial.tmp')
            temporary.write_text(json.dumps(agent))
            temporary.replace(file)
PY
printf 'Trial finished. Events: %s/parent.out\n' "$STATE"
