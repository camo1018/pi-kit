# Group memory

Connect inbox Groups to the existing bigbrain memory store. A new session in a
named group automatically receives recent group decisions and memories matching
its first prompt, without needing to know the group name or ask for recall.

## Enable

Requires bigbrain's native Pi extension and the Pi maintenance runner installed
by `bigbrain install-hooks --target pi`. The runner must support
`BIGBRAIN_MAINT_PI_EXTENSIONS` (current bigbrain does).

Select `group-memory` alongside your existing pi-kit extensions, or enable it
with `pi config`. For example, for an inbox-only selection:

```bash
./install.sh --extensions inbox,group-memory
```

That command replaces the selected extension set; include other extensions you
want to retain. Reload or restart Pi after enabling it. `/group-memory` shows
the current group, stable memory tag, and last recall's size-budget counts.

No bigbrain schema migration or separate database is required. The extension
reads `<agent-dir>/inbox-groups.json` using inbox's existing store. It does not
change group metadata, transcripts, live settings, or existing memories.

## Behavior

### Writes

- `memory_store` calls automatically receive `pi-group:<group-id>` in addition
  to their supplied tags. Stable UUIDs survive group renames.
- `memory_update` reads the existing record and preserves previous group tags
  before applying the new group's tag. Explicit replacement of ordinary tags
  still works. If that read fails, the update is blocked rather than losing
  provenance. Prefer bigbrain's normal same-topic `memory_store` workflow.
- Native tools and `mcp__bigbrain__memory_*` tools are supported, including
  nested calls that pass through Pi's `tool_call` pipeline.
- Other MCP servers and ordinary global recall calls are left unchanged.
- bigbrain's store/replace operation already unions existing and supplied tags,
  so a shared topic can belong to multiple groups without duplicate memories.

### Recall

Before each grouped user prompt, two read-only requests run in parallel:

1. Up to **5 task-relevant memories**, via tag-filtered semantic recall.
2. Up to **3 recently updated memories** with the same group tag.

Results are deduplicated by string memory ID, with relevant matches first.
Reads have a **2-second timeout** and fail open: unavailable bigbrain never
blocks the main prompt. A partial failure retains the successful read's results
and labels the context as incomplete. Interactive warnings are shown once per
session load.

At most **16,000 characters** of escaped reference context are injected into
the request. Records are included whole, never partially: a long memory can
have corrections near its end. Oversized records get a bounded ID/topic note
so the agent can fetch them with `memory_get` if relevant. The data is explicitly
marked untrusted; it cannot close the enclosing XML-shaped envelope.

Injection happens in the request-only `context` event. It is not saved to the
session, cannot accumulate in the transcript, and is not re-ingested as new
learning by the maintenance pass. Normal global recall is still recommended;
this extension supplements rather than replaces bigbrain's recall rules.

### Detached maintenance

The extension adds itself to the process-local
`BIGBRAIN_MAINT_PI_EXTENSIONS` list without overwriting other provider
extensions. It sets `PI_BIGBRAIN_GROUP_SNAPSHOT` from the active session before
each prompt, then refreshes it at `agent_end`, before bigbrain's `agent_settled`
handler spawns its worker.

The runner inherits those environment values and loads this extension into its
headless Pi. Under `BIGBRAIN_MAINT=1`, this extension uses the **captured parent
group**, not the maintenance worker's unrelated session ID. Only write tagging
runs: there is no automatic recall, new worker, or maintenance recursion.

This uses bigbrain's existing Pi-backend extension hook; no bigbrain source
changes are needed. The opt-in legacy direct Gemini/Anthropic backends do not
load Pi extensions and are **not covered**. Use the default Pi maintenance
backend for grouped writes. Likewise, shell/CLI writes and other applications
bypass Pi's tool pipeline and are not automatically tagged.

### Group changes

- Group assignment is read on demand, not just at startup. Sessions assigned
  after spawning, forks, clones, resumes, and externally moved sessions work.
- Moving a session affects future writes and recall; it does not retroactively
  reassign memories. Prior group tags are preserved.
- A worker already spawned keeps its captured group even if the parent moves.
- Ungrouped sessions retain normal global bigbrain behavior; no automatic group
  requests or tag mutations occur.
- Deleting a group does not delete its memories. Their old tag remains but is
  no longer automatically selected; global recall can still find them.

## Scope and limitations

Groups are **discovery/provenance tags, not privacy or access-control boundaries**.
All memories remain in the shared global store and can be recalled globally.
Deduplication is still bigbrain's topic-based deduplication, not group-specific.

Only writes after enabling the extension get group tags. Existing memories are
not backfilled from old transcripts; a group with no tagged memories begins
empty and the session continues using global recall.

Automatic reads use the same HTTP endpoint as native bigbrain tools:
`BIGBRAIN_URL`, then `BIGBRAIN_MCP_URL`, then `http://127.0.0.1:8765/mcp`.
If using an MCP-configured bigbrain endpoint, set one of those variables to the
same endpoint. This extension does not implement a separate OAuth client.

## Tests

All tests use temporary group stores and fake HTTP servers. No live inbox
metadata or production memories are written.

```bash
node --experimental-transform-types --test \
  extensions/group-memory/*.test.ts
```

The optional maintenance integration test uses the installed runner (or
`BIGBRAIN_MAINT_RUNNER`) with a fake Pi CLI. It verifies the real runner's
extension loading and captured-group propagation, without an LLM or store write.
