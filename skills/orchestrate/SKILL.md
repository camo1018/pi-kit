---
name: orchestrate
description: >-
  Strict planner/orchestrator split: the parent plans, writes handoffs,
  coordinates, and makes the decision, while cheap worker sessions do all
  retrieval, source-grounded synthesis, and any implementation or validation.
  Use ONLY when the user explicitly asks to orchestrate, keeping the
  expensive parent to planning and decisions (e.g. "orchestrate this",
  "you plan and delegate", "subagents fetch and synthesize, you decide")
  or invokes $orchestrate. Never use for ordinary tasks that merely look
  parallelizable. Supports foreground and background parents without
  takeover.
compatibility: Requires Pi with the session-workers extension enabled.
---

# Orchestrate

Run the user's task as an orchestrated fan-out through `session_workers`. Use
the task accompanying this skill, or continue the current unfinished task when
it is invoked without new text. Ask one concise question only if there is no
identifiable unfinished task.

## Role split (stricter than `parallel`)

The parent is the expensive model and must stay in the planning layer:

- **Parent owns:** understanding the request, planning, dividing the work,
  writing handoffs, coordinating, judging evidence quality, resolving
  conflicts, making the decision, and a brief final answer.
- **Parent does not own:** research, retrieval, browsing, log/metric/SQL
  queries, code reading for discovery, bulk synthesis, implementation, or test
  running. Delegate those.
- **Parent may** read compact worker outputs and the evidence they cite to
  judge quality. It must not re-run the research those outputs already cover.
  If a worker's evidence is thin or contradictory, ask that worker a targeted
  follow-up instead of doing the work yourself.
- Delegate both retrieval **and** source-grounded synthesis, plus
  implementation and validation when the task includes them. A synthesis
  worker must cite sources; it is not a second-opinion chat.

## Defaults

- **Delegation is opt-in.** Start workers only when the user explicitly asked
  for orchestration or invoked this skill. That explicit request is the
  authorization to delegate; without it, do not volunteer this workflow for
  tasks that merely look parallelizable.
- Start **two workers by default**, each on a genuinely independent slice of
  the task. This is a starting point, not a quota or a cap: honor an explicit
  worker count, model, directory, or scope from the user, and let the task's
  natural shape decide. One worker with real work beats two with padding -
  never invent a slice, never split a dependent step to fill a slot, and never
  give two workers the same question. A dependent synthesis step runs *after*
  the retrieval workers report, not alongside them.
- Keep the fan-out modest: each worker is a full Pi process with its own tools
  and MCP servers, so a handful is the practical ceiling.
- Foreground and background parents both work. **Do not require takeover.**
- Use the parent's cwd and inbox group unless the user says otherwise.
- Delegation is one level only. Workers are leaves and must not spawn their
  own children.

## Model choice

Workers do the volume work, so they run on a cheap model by default:

1. Check whether `workerDefaultModel` is configured in Pi settings. When it is
   set to a genuinely cheap, capable model, rely on it and omit `model`.
   Confirm the worker model is actually in scope (for example, listed in the
   enabled/scoped model set): an out-of-scope `workerDefaultModel` is silently
   discarded, and workers then run on the parent's expensive model.
2. Otherwise pass an explicit cheap `model` on `spawn`, using a model you have
   verified is supported and inexpensive in this environment.
3. **Never silently fall back to the parent's expensive model.** If no cheap
   model can be determined or verified, stop and ask the user before spawning
   anything expensive.

Keep this skill provider-neutral: do not hardcode a specific model ID. Prefer
naming the setting or describing the requirement, so the skill travels across
providers. The parent keeps its own model for planning and the final decision.

## Propagating other skills

Any *other* skill invoked in the same prompt (`$query-logs`, `$sql-query`,
`$code-search`, `$pr-review`, …) is the user's instruction for the whole job
and applies to every worker, not just the parent. Reproduce each token
verbatim in the worker's task text so `inline-skills` expands it, and also
name its file (`skills/<name>/SKILL.md`) so the worker can read it if expansion
does not fire. State plainly that the skill governs the worker's slice.

**Never forward `orchestrate` or `parallel` to a worker.** Both are delegation
controls; forwarding either invites a second coordinator or a depth violation.
Refer to them by bare name only. Do not put their literal dollar-prefixed
tokens anywhere in a worker task string, not even inside a prohibition or a
quotation: `inline-skills` expands any such token in user-message text, so a
forbidding mention would load the very skill it means to withhold. Backtick or
plain-name wording is the only safe form. Require each worker to read the
relevant skill file before starting, and tell the user which skills were
propagated.

## Workflow

1. **Plan.** Recall relevant bigbrain knowledge if its tools are available.
   State the question, the decision the parent must make, and the evidence that
   would settle it. Divide the work into bounded, independent slices. Keep only
   planning, conflict resolution, and the decision in the parent.
2. **Arrange isolation, do not perform it.** The parent stays in the planning
   layer, so worktree creation is delegated rather than done by hand. Before
   any concurrent code edits, spawn or `send` a bounded setup task to a worker:
   create the worktrees from the correct base, check each one out cleanly, and
   report the absolute paths and branch names. Then hand each editing worker
   its own `cwd` and file scope from that report. Read-only workers may share
   the parent directory. Instruct workers never to reset, stash, or overwrite
   unrelated user changes, and never give two workers the same file in the same
   directory.
3. **Launch with explicit handoffs.** Use `spawn` with a descriptive title, a
   bounded task, relevant context, and expected deliverables. **Pass
   `wake: true` on every spawn.** The wake is opt-in and defaults to off: it is
   right for orchestration, where the parent spawns, ends its turn, and must be
   told the team settled, and wrong everywhere else, where the parent is driving
   the workers and already knows when they stop. Without the opt-in a parent
   that delegates also has to poll `wait`.

   History is not cloned, so the handoff must stand alone. Each handoff should
   specify:
   - the precise question and its boundaries (what is in and out of scope);
   - which sources, repos, paths, tables, or services to use, and which the
     user already ruled out;
   - the deliverable shape (compact findings, not raw dumps);
   - a requirement to cite source paths/lines, URLs, query IDs, or memory IDs;
   - a requirement to list uncertainties and anything unverified;
   - authorization limits (no commits, pushes, or external writes unless the
     user authorized them);
   - a requirement that the slice be completable in the worker's own session
     (never hand a worker a "fan out" or "coordinate more workers" subtask);
   - the propagated skills, verbatim.
4. **Coordinate.** Maintain an explicit per-worker ledger: current milestone,
   assigned workspaces/files, last observed progress, disposition, dependency,
   and the parent's next action. Do not treat launching workers as delegation
   complete, and give each worker one bounded milestone rather than a sprawling
   sequence whose first checkpoint can be mistaken for its final deliverable.

   Each worker should publish useful findings or blockers with `share` and read
   the shared notes board. Once every worker is started, **end your turn**
   instead of polling: a settled team wakes you once per fan-out (up to three
   consecutive automatic wakes before real user input refills the budget),
   which costs less than any number of `wait` returns. Use bounded `wait` only
   when you need an in-turn check, and `send` for scope changes or follow-ups.
   Ending the turn is safe either way: the wake is recorded durably first, so
   it is delivered whether you are an interactive window, a background agent
   that exits with the turn, or a window closed mid-run.

   The wake fires when the **whole team** stops. A worker that finishes while a
   sibling is still running does not wake you, so keep dependent follow-ups
   behind a team-settle or an explicit `wait`, and run a dependent synthesis
   step only after the retrieval workers have reported.

   After **every** wake, `wait`, or `read` result:
   - **Idle/settled:** inspect the actual reply now; either send the next task,
     decide its dependency, report the human blocker, or mark the slice done.
     Never wait again on an all-idle team, and never say a re-review or
     validation is running until its `send`/`spawn` actually succeeded.
   - **Working:** compare concrete progress (a new finding, diff, test result,
     or completed phase), not fresh tool calls. Two consecutive checks with the
     same inspection loop and no deliverable require intervention: ask for one
     exact failure and next experiment, or cancel and checkpoint the run before
     narrowing it. Do not keep issuing identical waits indefinitely.
   - **Unknown/error/cancelled or externally controlled:** surface the state
     and the ownership limitation. Do not assume success or start a second
     writer; an unverifiable status is an attention condition, not progress.

   `send` is **FIFO next-run delivery**, not steering. Do not pile corrective
   messages onto a busy worker expecting its current run to change; a queued
   message and a shared note do not establish that instructions were delivered.
   To redirect an unsafe or stalled run, cancel it, preserve its current work,
   and send one consolidated bounded handoff once control is available. If
   control is refused, ask the user to act in the owning inbox. Never bypass
   ownership to "unstick" a worker.

   Require compact checkpoint/final replies to state their disposition
   explicitly: `done for this slice`, `blocked on human input`, or `waiting for
   a named dependency`, with the next action and its owner. The parent owns
   every dependent handoff, including validation and re-review.

   Shared notes refresh on model requests, not inside a running tool, so an
   idle worker may be blocked without having told you. Do not spawn a
   replacement to dodge a blocker.
5. **Decide and answer.** Inspect every worker's actual reply; `idle` is not
   proof of success. Reconcile conflicting findings on the evidence, not on
   volume. When a task changes code, delegate the required typecheck, lint, and
   test runs to a worker and require the command output in its reply before
   declaring completion. Give one combined, brief final answer: decision,
   supporting evidence with citations, changes made, checks run, and remaining
   blockers or open questions.

## Boundaries

- Do not commit, push, merge, publish, or change global config unless the user
  authorized it.
- If `session_workers` is unavailable, say that its extension must be enabled
  and reloaded. Do not simulate delegation with shell processes or pretend
  workers exist.
- Before any worker writes or commits, require its actual git top-level and
  branch to match the assigned workspace. Readers may inspect sibling paths;
  writers may not edit, reset, stash, restore, or commit there. Setup ownership
  ends when an editing worker starts: do not rebase/reset its active worktree
  to deliver another integration checkpoint. Use unique `mktemp` paths or
  direct commit messages, never shared names such as `/tmp/msg.txt`.
- Do not accept `complete` from helper-only or mocked tests as proof that a
  deployed constructor and public entry point reach the code. Validation must
  exercise the promised consumer/runtime path and label real versus fake
  dependencies. Re-review the combined candidate, not only isolated slices.
- If auth, approval, or human input blocks a worker or the parent, stop, state
  what is needed and why, and wait. Do not guess around a blocker.
- Interrupting the parent does not stop its workers; `cancel` explicitly when
  abandoning delegated work, keeping completed steps intact.
- Bigbrain is optional durable context; the shared notes board handles
  immediate coordination. Leave routine memory maintenance to its background
  hook and only store/update memories when the user asks.
- Tell the user briefly which workers started, how the work was split, and
  which skills were propagated. Workers appear in `/inbox` or Ctrl+Q.
