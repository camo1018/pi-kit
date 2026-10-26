# Session workers

A model-callable delegation layer on the existing inbox background runner.
A foreground or background parent can start independent sessions while
continuing its own work. No takeover is required. These are normal persistent
Pi sessions, visible in `/inbox`, not disposable in-memory subagents.

## Enable

Select `session-workers` along with your usual extensions. `inbox` gives you
live progress, manual replies, cancellation, and takeover. `group-memory` adds
long-lived bigbrain sharing. The worker tool itself also works without the
inbox UI or bigbrain.

```sh
./install.sh --extensions inbox,group-memory,session-workers
```

Develop in a feature worktree. Do not run the installer there against your
live settings; merge/install when ready. Loading the extension explicitly
with `-e` is also supported: worker runs explicitly load the same extension
path, even when it isn't enabled in their settings.

## Tool: `session_workers`

| Action | Inputs | Behavior |
|---|---|---|
| `spawn` | `title`, `task`; optional `context`, `cwd`, `model` | Start a worker and return its session id immediately |
| `list` | Optional `id` | Status and latest reply for this team's workers |
| `read` | `id` | Status, latest reply, and transcript path |
| `wait` | Optional `id`, `seconds` (1–60, default 30) | Wait for one worker, or all workers, to stop running; timeout returns current status |
| `send` | `id`, `text` | Queue a follow-up in the same worker session |
| `cancel` | `id` | Stop the run and clear its queue |
| `share` | `text` (1–4000 characters) | Append an attributed finding to the team notes board |
| `notes` | None | Read the latest 24 notes and the directory for full history |

Example spawn:

```json
{
  "action": "spawn",
  "title": "Investigate API callers",
  "task": "Read-only: find callers and report compatibility risks.",
  "context": "The proposed change adds an optional versionId field.",
  "cwd": "/path/to/repo"
}
```

The agent can spawn several workers, do its own work, then call `wait` and
inspect their replies. Follow-up messages are FIFO next-run prompts, **not**
mid-run steering. Waiting or interrupting a parent tool does not cancel its
workers; cancel them explicitly.

## Knowledge sharing

- **Explicit handoff:** a worker starts with a fresh context window, its task,
  and the provided `context`. The parent's full history is not silently copied.
  Include decisions, file scopes, evidence links, and required deliverables.
- **Immediate team notes:** parent and workers can publish findings with
  `share`. Every model request refreshes a bounded, escaped, request-only notes
  message (latest 24 notes, up to 16K characters). Notes are marked as data,
  not instructions. Nothing is injected into the persisted transcript.
  A long-running tool does not receive live updates until its next model call.
- **Sibling results:** workers can `list` or `read` their siblings to avoid
  duplicating research. Replies are bounded; the full transcript path is
  returned. While busy, the latest reply may be from an earlier step/run.
- **Long-term group memory:** group membership is copied before launch. With
  `group-memory` enabled, parent and workers share the same group-tagged
  bigbrain knowledge. Ungrouped parents produce ungrouped workers; this does
  not create groups or move the parent. Later group moves don't rewrite team
  relationships. Ordinary background memory maintenance remains unchanged.

Notes live in `<agent-dir>/session-workers/notes/<parent-id>/<note-id>.json`.
Each append creates its own immutable file, so simultaneous sibling writes do
not overwrite one another. Team membership is stored in
`<agent-dir>/session-workers/workers/<worker-id>.json`. Both survive restart.
These are coordination records, not an access-control boundary: sessions
already have the same filesystem permissions. Do not put credentials in notes.

## Boundaries and safety

- Normal foreground and background sessions can delegate. In orchestrator
  mode, an attached background parent works without `/takeover`.
- Only the parent may spawn, send, or cancel; workers can read and share.
  Delegation depth is capped at **one**: a worker created by this tool cannot
  spawn another generation. The guard uses persistent team membership, not
  foreground/background process mode, so taking over a worker or consuming
  its startup environment marker does not reset its depth.
- Default cwd and model/thinking level come from the executing parent, not a
  visited inbox row. `cwd` can select a dedicated worktree; it must exist.
- Workers load normal Pi settings, skills, and project instructions. Runtime
  trust, tool exclusions, and MCP approval rules still apply. The extension
  does not turn on blanket approval or bypass human-input requirements.
- The existing inbox concurrency cap applies (six per supervising process by
  default; `PI_INBOX_MAX_AGENTS` overrides it). Extra workers queue. This isn't
  a machine-wide cap across independently running parents.
- **Use separate worktrees for concurrent code edits**, or assign disjoint
  files/read-only tasks. This extension does not create worktrees or merge
  changes. Parent review and integration are still required.
- Worker output isn't proof of success. `idle` means its turn finished; it
  may need auth, approval, or a human decision. Inspect replies and validate
  changes before calling the overall task done.
- A worker controlled by another Pi process, or taken over in a live inbox
  window, cannot be sent another background run from this tool. Use its inbox
  or wait for the runner's orphan adoption. This prevents known second-writer
  cases; Pi sessions without inbox live records can't be detected.
- Workers outlive the parent run/window, matching inbox semantics. A running
  background parent heartbeats its owned workers and can adopt only its own
  team's orphaned runs, never its upstream parent or unrelated sessions.
  Foreground inbox windows retain normal global orphan adoption. A resumed
  background parent also starts its team supervisor; ownership still follows
  the existing heartbeat grace period. Queues wait while no eligible
  supervisor is running.
- Completion doesn't automatically wake an idle parent or launch another
  parent model turn. Use `wait` while coordinating, or check the inbox later.

## Try a real-model smoke test

Requires the installed bigbrain Pi bridge and model authentication available
through environment credentials or a provider extension. Choose your model
explicitly (replace `provider/model:low` with a configured model):

```sh
PI_WORKERS_TRIAL_MODEL=provider/model:low \
  ./scripts/try-session-workers.sh
```

This creates a separate temporary profile and starts a real parent and two
workers. One reads a synthetic API fact; the other recalls existing bigbrain
knowledge. Both publish notes and quote their sibling's finding. It checks
worker completion, group inheritance, and notes from both authors. Inspect
`parent.out` and the worker transcripts for the detailed findings.

No live settings, credentials, or sessions are copied or changed. The profile
permits only fixture reads, worker coordination, and read-only bigbrain tools;
synthetic-demo memory maintenance is disabled. It caps creation at two workers
and stops remaining trial agents if the parent exits or hits the five-minute
limit. Transcripts and notes are preserved at the printed temporary path.

The default runtime is the repo's `node_modules/.bin/pi`. Set
`PI_WORKERS_TRIAL_RUNTIME` to use your window's compiled Pi binary, and
`PI_WORKERS_TRIAL_PROVIDER_EXTENSION` if your model needs a custom provider
extension. `PI_WORKERS_TRIAL_BIGBRAIN` can override the installed bridge path.
Existing `auth.json` credentials are not copied into the isolated profile.
This is a one-shot trial, not installation into your normal sessions.

## Validation

Tests isolate filesystem state and mock the process-runner boundary; they do
not invoke real models or agents. From the repo root:

```sh
node --experimental-transform-types --test \
  extensions/session-workers/*.test.ts \
  lib/inbox-agents.test.ts \
  scripts/session-workers-trial.test.ts
```

The extension uses public tool/context hooks and `SessionManager` reads. It
reuses the inbox runner's documented session layout and JSON-event assumptions;
see [inbox compatibility notes](../inbox/README.md#pi-internals-this-depends-on).
