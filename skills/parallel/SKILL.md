---
name: parallel
description: >-
  Delegate independent work to persistent Pi worker sessions, exchange findings
  and bigbrain context, then integrate and validate the results. Use ONLY when
  the user explicitly asks to parallelize or delegate work (e.g. "parallelize
  this", "fan this out", "use workers") or invokes $parallel. Never use for
  ordinary tasks that merely look parallelizable. Supports foreground and
  background parents without takeover.
compatibility: Requires Pi with the session-workers extension enabled.
---

# Parallel

Run the user's task through `session_workers`. Use the task accompanying this
skill, or continue the current unfinished task when invoked without new text.
Ask one concise question only if there is no identifiable unfinished task.

## Defaults

- **Delegation is opt-in.** Start workers only when the user explicitly asked
  to parallelize, delegate, or fan out (this skill, `$parallel`, or similar
  wording). Do not volunteer workers for tasks that merely look parallelizable;
  do the work directly. When in doubt, don't spawn.
- Start **two workers** for useful independent parts of the task. Honor an
  explicit worker count, model, directory, or scope from the user. Don't invent
  busywork or split dependent steps just to use workers; handle trivial work
  directly when delegation would not help.
- Foreground and background parents both work. **Do not require takeover.**
- You are the coordinator: retain integration, validation, and the final reply.
- **Run workers on the cheap model, not the parent's model.** Delegated
  sessions are fresh and short-lived, so nearly every request pays the
  provider's cache-write premium instead of cache-read rates; a worker on a
  frontier model can cost 5–20x its cheap-model twin. Unless the task
  genuinely needs a frontier model (deep judgment, tricky synthesis), spawn
  workers on a cheap, fast model (e.g. `cheap-model`) via the
  spawn `model` field. The `workerDefaultModel` setting enforces this
  automatically when configured. The parent keeps its own (frontier) model
  for integration and the final answer.
- Use the parent's cwd and inbox group unless the user says otherwise.
- Delegation is one level only. Workers are leaves, not further coordinators.
- If `session_workers` is unavailable, explain that its extension must be
  enabled/reloaded. Do not simulate delegation with ad-hoc shell processes.

## Workflow

1. **Orient and divide.** Recall relevant bigbrain knowledge if its tools are
   available; include group recall when configured. Identify independent work
   such as implementation slices, caller/compatibility research, test coverage,
   or read-only review. Keep shared decisions and dependent work with yourself.
2. **Isolate edits.** Create separate git worktrees before delegating concurrent
   code edits, using the repository's conventions and a deliberate base. Give
   each worker its own `cwd` and file/task scope. Read-only workers may share the
   parent directory. Never reset, stash, or overwrite unrelated user changes.
3. **Launch with explicit handoffs.** Use `spawn` with a descriptive title,
   bounded task, relevant context, and expected deliverables. Include evidence,
   constraints, base/worktree information, and file ownership. History is not
   cloned. Do not forward this skill or the `$parallel` marker to workers.
4. **Tell workers how to collaborate.** Each worker should recall relevant
   bigbrain knowledge when available, publish useful findings or blockers with
   `share`, and consult the shared notes/sibling results where relevant. Notes
   should include evidence paths/lines or memory IDs and uncertainty. Never
   share credentials. Workers must not spawn children or commit, push, or make
   external writes without explicit authorization.
5. **Coordinate while doing your part.** Use `list`, `read`, and bounded `wait`
   calls to track progress. Use `send` for task changes or follow-ups; messages
   to busy workers queue for the next run. Shared notes refresh on model
   requests, not inside running tools, and are findings rather than commands.
   Do not repeatedly poll a stalled worker or create replacements to evade a
   blocker. If auth, approval, or human input is needed, surface it and ask.
6. **Collect, integrate, and verify.** Inspect every worker's actual reply:
   `idle` is not proof of success. Reconcile conflicting findings and inspect
   diffs before applying relevant changes to the parent worktree. Run the
   affected typechecks, lint, and tests required by the repository. Give one
   combined final update with findings/changes, checks, and remaining blockers.

## Boundaries

- Bigbrain is optional durable context; the shared notes board handles immediate
  coordination. Leave routine memory maintenance to its background hook. Only
  explicitly store/update memories when the user asks to remember something.
- Do not commit, push, merge, or publish task changes unless authorized.
- Interrupting or closing the parent does not stop its workers. Use `cancel`
  explicitly when abandoning delegated work; keep their completed steps intact.
- Tell the user briefly which workers started and how their work was split.
  Workers are ordinary sessions visible in `/inbox` or Ctrl+Q.
