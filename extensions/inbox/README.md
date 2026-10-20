# 📥 Pi Inbox

A visual "todo box" for every Pi session across all projects: see status at a glance, pin what matters, archive what's done, and filter out sessions you never want to see (automated jobs). It's also a control panel for **background agents**: start agents, watch them work and reply to them, all without leaving the session you're in.

Source: `~/Code/pi-kit/extensions/inbox/index.ts` (background agents: `~/Code/pi-kit/lib/inbox-agents.ts`) · Data: `~/.pi/agent/inbox.json` · Filter rules: `~/.pi/agent/inbox-filters.json`

## Commands

| Command | What it does |
|---|---|
| `/inbox`, `shift+tab`, or `ctrl+q` | Open the inbox overlay |
| `/orchestrator` | Toggle [orchestrator mode](#orchestrator-mode): this window becomes a full-screen agent control panel (`pi --orchestrator` starts in it). Also `on`, `off` |
| `/orchestrator home` | Orchestrator mode: leave this session (it keeps running in the background) and return to the orchestrator |
| `/takeover` | Orchestrator mode: run this session here, like plain pi (waits for a background run to finish first) |
| `/stop` or `ctrl+shift+s` | Orchestrator mode: stop this attached session's background run |
| `/queue` or `alt+up` | Orchestrator mode: manage this attached session's queued messages; send one now or remove it |
| `/inbox help` | Show this doc (also `?` inside the inbox) |
| `/inbox filters` | Show the active filter rules, how many sessions each hides, and any rule errors |
| `/inbox groups` | Select the group view and create/manage groups |
| `/group` | Move the session on screen into a group (including busy sessions) |
| `/pin` | Toggle pin on the current session |
| `/archive` | Toggle archive (done) on the current session |
| `/rename [title]` | Rename the current session (no title: auto-title from its first user message). Also available to the agent as the `rename-chat` tool — same naming, works on background-agent sessions too via its `session` param |
| `/bookmark`, `ctrl+b`, or `ctrl+shift+b` | Fullscreen mode: return to the transcript position saved when you last opened the inbox or switched away |
| `ctrl+r` | Rename the current session. On orchestrator home / while typing a new agent's first prompt (`n`), names that new agent instead (empty = name from its prompt); after sending, renames the just-started agent |

## Keys inside the inbox

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Move |
| `←` `→` | Move up / down 5 rows |
| `PgUp` `PgDn`, `home` `end` | Page / jump to top or bottom |
| `enter` | **Agent view**: live transcript of the session; `r` there to reply (see [Background agents](#background-agents)) |
| `o` | Open (switch to) the selected session in this window. In orchestrator mode: open it attached (same as `enter`) |
| `t` | Orchestrator mode: take the session over (it runs here, like plain pi) |
| `v` | Orchestrator mode: peek at the live transcript (what `enter` does outside the mode) |
| `h` | Orchestrator mode: leave the current session and go home |
| `Q` | Orchestrator mode: leave the mode |
| `n` | New background agent in the current directory, using this window's model. You type its prompt in pi's editor |
| `N` | Same, picking its model first |
| `g` | Select/manage the group view (`ctrl+g` remains an alias) |
| `ctrl+g` | Choose a new agent's destination or move the session on screen |
| `b` | Move the selected session into a group or Ungrouped, without stopping it |
| `s` | All groups: toggle flat list / grouped sections |
| `f` | One-off: pick the group the next new agent goes to (overrides the default once; see [Groups](#groups-and-prompt-templates)) |
| `F` | Choose the persistent new-agent default group; Ungrouped clears it |
| `ctrl+w` | (while typing a new agent's prompt) pick a different directory for it — a live path picker with suggestions as you type (see [Directories](#directories)) |
| `d` | Orchestrator mode: move the selected session to a different directory (see [Directories](#directories)) |
| `c` | Cancel a running background agent |
| `m` | Manage the selected agent's queued messages (when it has any) |
| `p` | Pin / unpin |
| `a` | Archive / unarchive |
| `u` | Mark read / unread (toggles the `•` dot). On the session you're in: marks it unread on purpose — the `»` turns blue until you open it again from the inbox or switch away (a run finishing in front of you doesn't clear it) |
| `x` | Filter out / bring back (overrides the rules for that one session) |
| `tab` / `shift+tab` | Cycle views |
| `1` `2` `3` `4` | Inbox · Archived · All · Filtered |
| `/` | Full-text search (type, `enter` keeps the filter, `esc` clears it) |
| `r` | Rename session inline in the list (`enter` save · `esc` cancel). Works on agents still working or not saved yet: the agent process applies the name itself within ~1s (or the window applies it when the run ends) |
| `R` / `ctrl+r` | Refresh now (auto-refreshes every 2.5s) |
| `?` | This help |
| `esc` / `q` | Close (first `esc` clears an active filter) |

## Background agents

A background agent is a separate pi process working on its own session while you keep using this window. The inbox is the interface to them.

- **You always type in pi's own editor.** Starting or replying to an agent points your *next message* at it, and a banner above the editor says where it will go (e.g. `↪ Your next message goes to <session>`). Send it the way you always do (your Cmd+Enter, `$` skill autocomplete, `@` files, history, multi-line). After that one message, the editor goes back to this session. Press `esc` in the editor to cancel a pending one. Slash commands still run normally and are never sent to an agent.
- **Start one:** `n` in the inbox, then type the prompt in the editor. `n` uses this window's model and thinking level; `N` lets you pick the model first. A row appears in the inbox showing `● working`.
- **Model:** the banner shows which model the message will use: this window's model for a new agent, the agent's own model for a reply. Change it while the reply is pending (`ctrl+p`, `ctrl+l`, `/model`, `shift+tab` for thinking) and the banner follows, marked `(changed)`; the message runs on that model, and the agent keeps it afterwards. This uses pi's normal model selector, so it changes this window's session model too. (A background run writes its thinking level into the session file at startup. Pi itself doesn't record a `--model x:level` override when it resumes a session, so without this, later runs would restore an older level, often `off`.)
- **Watch it:** `enter` on any row opens the agent view, a live, read-only transcript of the session. While the agent works, its current run streams under the transcript as a progress log (prompt, tool calls with `…` while running and `✗` on error, replies in flight).
- **Reply:** `r` (or `enter`) in the agent view, then type in the editor.
  - If the agent is working, the reply is **queued**. Queued messages run one at a time, in order, after the current run finishes.
  - If it's idle, the reply starts a new run in the background right away.
  - In orchestrator mode, use `/queue` or `alt+up` in an attached session (or `m` on its orchestrator row) to choose any queued message. `enter` stops the current background run, puts that message first, and resumes from the completed session history; `d`, `delete`, or `backspace` removes it without affecting the run.
  - This works on **any** idle session, not just ones started with `n`. Replying turns it into a background agent.
- **Keys in the agent view:** `enter`/`r` reply, `o` open the session here, `c` cancel the agent, `↑` `↓` `j` `k` `PgUp` `PgDn` `space` `g` `G` scroll (it follows the bottom while you're there), `esc`/`q` close. Only plain keys: pi reserves most ctrl combos (e.g. `ctrl+o`, `ctrl+x`).
- **Know when they're done:** the footer shows e.g. `agents: 2 working · 1 needs you`. When an agent finishes you get a notification and a sound (from the sound settings in `~/.pi/agent/notify.json`), and its row gets a `•` before the title until you look at it (see Unread below).
- **Take one over:** `o` in the list or the agent view opens the session in this window, like any other. This is refused while the agent is still working; wait, or cancel it with `c`. (In orchestrator mode this works differently; see below.)
- **Cancel:** `c` in the list or the agent view. Completed steps stay saved; reply later to continue.

What to expect:

- **Each run is its own short-lived process.** It starts in about a second inside the same sandbox, loads the session, does one run, saves it and exits. Replies resume the same session, so the agent keeps its full context.
- **Same setup as a normal pi.** Agents load the same settings, skills, extensions and packages as any pi you start. `PI_INBOX_AGENT_ARGS` adds extra CLI flags if you ever want to trim that.
- **Images aren't forwarded** to background agents yet; only the text of the message is sent.
- **Approval-gated MCP calls use a configurable auto-approval mode.** Background agents read `~/.pi/agent/inbox-mcp-allowlist.json` and grant one-call approval according to it. The default mode is `allowlist`; every other gated call fails closed because the child has no interactive UI. Foreground sessions still prompt normally. Tool exclusions and host security checks still apply. OAuth, arbitrary extension dialogs, and questions that need information from you still have no UI; the agent stops, explains what it needs, and waits for your reply.

  In the default mode, `tools` uses `server/tool` names and supports `*` globs. Omitting `mode` also means `allowlist`, for compatibility. The file is re-read when changed, so no reload is needed. Missing, unreadable, or invalid files approve nothing:

  ```json
  {
    "mode": "allowlist",
    "tools": [
      "github/get_*",
      "docs/search"
    ]
  }
  ```

  To restore the old blanket approval behavior, opt in explicitly:

  ```json
  {
    "mode": "allow-all"
  }
  ```

  `allow-all` includes write-capable tools and should be used only when unattended writes are intentional.
- **At most 6 run at once** (set `PI_INBOX_MAX_AGENTS` to change it). Extra ones show `● queued`.
- **They outlive this window.** Agents are detached processes: quitting pi, closing the tab (or a shell watchdog killing pi) does **not** stop them; the run in flight finishes on its own. Their state, including queued messages, is kept in `~/.pi/agent/inbox-agents/`. The window that started an agent owns it (heartbeat every 5s). If the owner goes away, any other open pi window adopts the agent within ~20s, or the next pi you start does. Adopting means it replays what the agent did so far, keeps following it, pings when it finishes, and delivers queued messages. Queued messages only start once some pi window is open. Stop an agent explicitly with `/stop`, `ctrl+shift+s` or `c`. Switching sessions doesn't stop agents either. Other windows see agents they don't own as `● working` but can't reply to them.
- **Parallel agents in one repo can collide** when they edit the same files. Give each its own git worktree, or keep parallel work to separate files or read-only tasks.

## Orchestrator mode

**Takeover is per-session execution state, not a different navigation mode.**
The session on screen owns the inbox cursor/current-row marker, queue controls,
model/thinking choices, interactive naming, pin/archive actions, and the directory
for a new agent.
The foreground runtime only owns execution, abort/handoff, and its agent's tool
calls. In code, UI targets use `viewedSession(ctx)`; runtime lifecycle operations
use `ctx.sessionManager`. Never use a row's `isCurrent` marker as proof that this
process owns that session.

Orchestrator mode turns the window you're in into a full-screen control panel for agents. The inbox takes the whole terminal, as if it were the program, and pi's chat view never shows while you're in it. No new window or tab is opened.

- **Turn it on:** `/orchestrator` in any window, or start with `pi --orchestrator`. If you're in a session, it stays saved and listed, and the window moves to the orchestrator. `/orchestrator` again (or `/orchestrator off`, or `Q` in the orchestrator) turns it off.
- **New agent:** `n` (or `N` to pick the model) uses pi's normal editor (`$skill`, `@file`, same keys). `esc` cancels. Submitting starts the agent in this directory — unless you picked another with `ctrl+w` first; its live progress shows above the editor, and once it has written its session file it opens **attached** (like `enter`). Messages you send while it's starting are queued for it. With no taken-over main, composition uses the blank home session as before. With a sticky main, composition stays on the main, the new process starts in the background, and its session opens as a visit — the main is never switched, aborted, or handed back. `ctrl+q` while waiting goes back to the list instead (no auto-open). The header shows how many agents are working or need you.
- **Everything runs in the background.** Nothing runs inside this window's pi unless you take a session over, so switching sessions never aborts anything.
- **Open (attached):** `enter` (or `o`) opens a session in pi's normal chat view, with no special orchestrator banner. What you type there is sent to a background agent on that session; it doesn't run in this window. While it works, the run **streams into the transcript itself** — appended after what's on screen, rendered with pi's own message components, so a working agent looks exactly like a foreground one: your prompt, the agent's thinking/text as it's written, every tool call with its result, growing downward in the scrollable area (never in the fixed editor dock). Scroll it exactly like any transcript: wheel, `pageUp`/`pageDown` (when the editor is empty), or the terminal's own scrollback. A one-line status above the editor shows only what the transcript can't: the run's state (`⟳ working in the background` / `↻ loading` / `⏸ queued`) and a count of your queued messages — no response content. When the run finishes, the stream is replaced by the real transcript reloaded from disk (same content, no duplicates). Switch away any time; it keeps going.
  - Messages sent while it's working are **queued**, one message per subsequent run. Use `/queue` or `alt+up` to manage them. Choose a message and press `enter` to stop the current run and send that message now, then continue from the session's completed history. Press `d`, `delete`, or `backspace` to remove the selected message. The same manager is available with `m` on an agent's orchestrator row.
  - `ctrl+shift+s` (or `/stop`) stops the background run and clears its queue. esc only interrupts runs in this window.
  - `/compact` and `/tree` are refused while the background run is going, because they would write to the session at the same time. They work normally once it's idle.
  - `/fork` and `/clone` work mid-run, because they only create a new session. `/clone` copies the session from disk up to the agent's last completed step, not the on-screen snapshot. The step in flight (an unanswered tool call or a prompt still being worked on) is left out. The background run carries on in the original session. The clone is listed as `◆ your turn` (not `● working`/`⚠ stalled`) until it has activity of its own: its tail ends at a tool result, but nothing is running on it.
  - A fork or clone lands in the same group as the session it came from (and stays Ungrouped when the original has no group). Switching to an unrelated session with `/resume` never inherits anything.
  - Model changes (`ctrl+p`, `ctrl+l`, `/model`, `shift+tab`) apply to the next background run.
  - While visiting with a taken-over main, the normal model picker (`ctrl+l` / `/model`), model cycling (`ctrl+p` / `ctrl+shift+p`), and thinking controls (`shift+tab` / `/thinking`) target the visited session only. The footer reflects the choice immediately. If the agent is busy, the choice is saved for its next run without interrupting it or writing to its active transcript. The main's model and thinking level stay unchanged; cancelling a picker changes neither session.
- **Take over:** `t` on a session (or `/takeover` from an attached session) makes it run here, like plain pi: streaming, esc to interrupt, steering, every command. Only a taken-over session gets a mode banner: `Orchestrator - taken over`. Attached and visited sessions use their normal UI without an orchestrator banner. If its background run is still going, it takes over automatically when that run finishes.
- **Sticky takeover:** a taken-over session stays the window's *main* session while you look at others. `enter` on any other row *visits* it: its transcript + background run render in the chat area (same components, live streaming), your messages go to its background agent (queued if working), and the taken-over session keeps running behind it — nothing is aborted, nothing restarts. `esc` / `h` / `enter` on the main's row returns to it live, with everything it streamed while hidden. Taking over another session (or `h` from the main) is what actually hands the main back. Visits are view-only: the visited session is never claimed by this window (its background agent keeps running it), so `d`/`ctrl+w` moves and `/takeover` still act on the main while you visit. If the visit view can't mount (a Pi upgrade changed internals), navigation is refused so the taken-over session cannot be interrupted; `/compat` names the failed probe.
- **Leaving a taken-over session** (`h` from it, or taking over another session) hands it back to the background: if it's mid-run, the run is stopped here and continued by a background agent with a "continue where you left off" message — only the in-flight step is redone, and messages queued in the editor are dropped. (Visiting other sessions does *not* hand it back; see sticky takeover above.)
- **Peek:** `v` shows the live transcript without opening the session. From there, `r` replies in a full-screen prompt and `o` takes over.
- **Back to the orchestrator:** `ctrl+q` from any session. The cursor starts on that session, so `t` takes it over. `esc` returns to it.
- **Go home:** `h` in the orchestrator (or `/orchestrator home`) leaves the session; any run keeps going in the background.
- **Behind the orchestrator** is a blank "home" session that pi never saves. `esc` there doesn't drop to the chat view. `ctrl+c` twice quits pi.
- **Ownership:** agents started from this window belong to it, as usual. Quitting or closing this pi does *not* stop them: they keep running and another window (or the next pi you start) adopts them. Other windows see them as `● working`. Opening, taking over and leaving sessions doesn't stop them.

## Directories

A new background agent runs in this window's directory by default — that's where pi resolves `@` files, loads project `AGENTS.md` / `.pi/` resources, and files the session. Two ways to work somewhere else:

- **`ctrl+w` while typing a new agent's prompt** (after `n`, before you send): opens a full-screen directory picker. It's like a shell prompt with autocomplete — as you type, the list below shows what your text means so far (`as typed`), its parent (`..`), home (`~`), child directories of the deepest existing part of your path (filtered by what you've typed past it), and working directories of your other sessions that match (`recent`). `↑` `↓` pick, `tab` fills the suggestion into the input like shell completion, `enter` accepts (the highlighted suggestion, or the typed path as-is), `esc` cancels. The banner above the editor shows the pending directory (`· dir ~/Code/foo`); the agent you then start runs there, files its session there, and loads that project's instructions and skills. The pick is one-shot — it drops when sent (like the `ctrl+r` pre-name) or if you cancel with `esc`.
  - `ctrl+w` is normally the editor's delete-word-backward; it only opens the picker in the orchestrator situations above (pending new agent, orchestrator home, or an attached/taken-over session). While typing a new agent's prompt, use `alt+backspace` to delete a word.
- **`d` on a session in the orchestrator list** moves that session to another directory: rewrites its stored `cwd`, re-files the `.jsonl` under the new directory's session folder, and re-points its background agent (if any) so the next reply runs there. Blocked while the agent is working (`c` to cancel first, or wait) or while the session is open in another window. If this window holds the session, it reopens it at the new path. Useful when a session started in the wrong repo, or a project moved. (Outside orchestrator mode, `d` is still archive.)
- **`ctrl+w` while inside an attached or taken-over session** does the same for the session on screen: pick a directory and it's re-homed (the chat reopens at the new path, any text you were typing stays in the editor). Same guards: its background run must be idle. In a normal (non-orchestrator) window, `ctrl+w` keeps its usual delete-word meaning.

## Views

- **Inbox**: everything not archived. Pinned sessions sit in a `★ PINNED` section at the top, newest pin first. The rest are sorted by last activity. There's no separate agents section: background agents stay in place, and the status column plus the unread `•` tell you which ones need you.
- **Archived**: done sessions, sorted by when you archived them. Nothing is deleted; press `a` again to restore.
- **All**: every session except filtered ones. Archived ones are dimmed and tagged `[archived]`.
- **Filtered**: sessions hidden by a filter rule or by `x`. Each row leads with the reason (`⊘ <rule name>` or `⊘ hidden manually`). They never appear in the other three tabs, including in search results.

## Groups and prompt templates

Each session belongs to **one optional group**. Ungrouped is the default.
Groups are independent of project directories and the Inbox / Archived / All /
Filtered tabs. The group row above the session list shows the current scope;
tab counts and full-text search are scoped to that group too.

A fork or clone of a session joins the original's group; a new agent's group
follows the destination picked for it (see the default group below).

**f** in the inbox list pre-picks a one-off group for the *next* new agent —
like the persistent default (F), but spent once: it applies to the next agent
you actually start (n, N, or typing at orchestrator home) and then clears
itself. Choosing Ungrouped forces the next agent Ungrouped even with a default
set. The pending pick shows as `next: <group>` on the group line, and it
survives a cancelled compose — only a started agent consumes it. Priority is:
explicit Ctrl+G choice while composing, then the f one-off, then the selected
group view / Ungrouped, then the persistent default.

Open the group selector with **g** inside the inbox, or `/inbox groups`.
Ctrl+G remains an inbox alias and the shortcut while composing new prompts;
plain g in editors, search and rename stays ordinary text.
Select **All groups**, **Ungrouped**, or a named group. The view is window-local
and survives session switches and `/reload`; a new window starts on All groups.

### Group-by layout

While viewing **All groups**, press **s** to toggle **flat** / **by group**.
The group row shows the active layout. Grouped mode creates a section for each
nonempty group, ordered alphabetically, with **Ungrouped last**. Section counts
reflect the current tab and search; empty groups are omitted.

In Inbox, pinned sessions appear first **within their group**, followed by the
usual last-activity ordering. Archived keeps newest-archive-first ordering
within each group; All and Filtered keep their existing activity ordering.
Headers are not selectable: navigation, opening, pinning and moving still
operate on sessions, and switching layouts preserves the selected session.

The layout choice survives closing/reopening the inbox, session switches
and `/reload`, and is persisted in `inbox-groups.json` so new windows and
future pi sessions start on your chosen layout. While a window is open,
toggles stay window-local in memory (two windows can diverge until one
reloads). Named-group and
Ungrouped filters omit redundant group headers; returning to All groups
restores your layout choice. In search/rename, typing s remains ordinary text.
This changes presentation only, not membership or the new-agent destination.

### Selector keys

| Key | Action |
|---|---|
| Type | Filter by case-insensitive name prefix |
| `1`–`9` | Immediately select the correspondingly numbered visible result |
| `ctrl+n` | Toggle digits-as-text for prefixes like `2026` or `PR2` |
| `↑` `↓`, `PgUp` `PgDn` | Navigate; numbers always refer to the visible page |
| `enter` | Select the highlighted result |
| `esc` | Cancel without changing the view, destination, or draft |
| `ctrl+a` | Create a group |
| `ctrl+r` | Rename the highlighted group |
| `ctrl+t` | Toggle the highlighted group's template on/off in place |
| `ctrl+e` | Edit its multiline template in the same picker panel |
| `ctrl+s` / submit | While editing: save and return to group search |
| `ctrl+d` | Delete it after confirmation; its sessions become Ungrouped |
| `ctrl+f` | Set the highlighted group as the new-agent default; Ungrouped clears it |

Pasted text, including digits, always filters rather than selecting a row.
Ctrl+N and management actions ignore reported key-repeat and key-release events;
one key press triggers one action. Arrow-key repeat still navigates the list.
Management keys affect the highlighted real group, not the special views.
Names must be unique ignoring case; All groups and Ungrouped are reserved.

Search, results, template status and template preview share one screen.
Highlight a group to inspect its template; Ctrl+T toggles it without leaving the
picker. Ctrl+E focuses the inline template editor while keeping the prefix and
results visible. Ctrl+S or your normal submit key saves. Escape closes any
completion menu first, then cancels the edit and returns focus to search.
Another Escape closes the picker. Search text,
numeric-input mode and selection are preserved. Numbers typed into a template
are ordinary text, never group-selection shortcuts. Failed saves retain your
draft for retry instead of clearing it.

### Membership and creation

Press **b** on an inbox row, or run `/group` while viewing a session, to move it.
The destination selector excludes All groups because it is a view, not a group.
Moving a running session changes only metadata: no signals, transcript edits,
directory changes, queue changes, or process restarts. `/group` targets a visited
session, never the taken-over main behind it.

Starting an agent with **n/N** while viewing a named group automatically puts
it in that group. Ungrouped explicitly creates ungrouped agents. All groups
uses the configured new-agent default, or Ungrouped if none is configured. During
composition, **Ctrl+G** changes the destination, which is shown in the banner.
In an existing session (including a busy visit), **Ctrl+G** opens the same
move-to-group picker as `/group`, replacing Pi's external-editor shortcut.
Moving a session changes only membership, preserving its draft and runtime;
existing replies never receive templates.

### Default group for new agents

The inbox title shows **default: <group>** beside orchestrator. The hint
**f next group · F default group** sits on the existing group/layout line
instead of taking another header row.
Press **F** to select the default, or **Ctrl+F** on a highlighted group in the
regular group picker to set it without leaving that screen. Select Ungrouped to
clear it. The picker marks the current default; All groups cannot be a default
because it is a view, not a destination.

This preference is saved in `inbox-groups.json` and shared across windows and
restarts. Priority is: explicit Ctrl+G composition choice, then the f one-off
pick, then the selected named-group/Ungrouped filter, then the default when
viewing All groups. The default group's enabled template prefills new agents
normally (the F pick's group template prefills too). Changing the
default does not move existing sessions or retarget a prompt already being
composed. Deleting the default group clears it safely.

### Templates

Templates are off by default. **Ctrl+T** in the selector toggles the template;
**Ctrl+E** edits it in the same panel. Disabling retains the text. When enabled,
n/N prefills Pi's normal editor. Nothing is submitted until you submit it.
For a PR reviews group, for example:

```text
Use the gh-pr-review skill to review this PR:

```

You can add the URL and edit anything. Changing groups replaces an empty draft
or the exact untouched previous prefill, but **never overwrites an edited draft**.
Moving existing sessions does not inject the template into their history, and
later replies are not prefixed. These are editor prefills, not system prompts or
Pi's slash-command template files.

The inline template editor uses the normal prompt's completion provider: slash
commands/templates, `/skill:name`, `$skill` (when inline-skills is loaded), and
file references have the same suggestions. Tab or Enter accepts a suggestion;
Escape closes the suggestion menu without cancelling your edit. Saving stores
the text literally: commands and skill bodies are not executed or expanded while
editing. Normal prompt/skill processing applies when the template is used.

Definitions, templates, session memberships and the All-groups layout
preference live together in
`<agent-dir>/inbox-groups.json` (normally `~/.pi/agent/inbox-groups.json`).
Writes are locked across windows and atomically replaced; older inbox extensions
do not touch this separate file. A group deleted in another window becomes
Ungrouped on refresh. A pending agent whose destination was deleted is not
started: the draft stays available for choosing another destination.

## Development and testing

Develop in a feature worktree, not the checkout loaded by your live Pi settings.
Do not run `install.sh`, modify live settings, or load both live and worktree
inbox extensions into one process. A worktree isolates code, not runtime data.

Automated tests use temporary state and mock process handles; they never run
real background agents. From the repository root (Node 22.7+ and local Pi SDK
packages in `node_modules`):

```bash
node --experimental-transform-types --test \
  extensions/inbox/*.test.ts \
  lib/background-mcp-approval.test.ts \
  lib/visit-runtime.test.ts \
  lib/prompt-autocomplete.test.ts \
  scripts/preview-inbox.test.ts
```

For an optional **one-shot UI preview**, no persistent profile or separate
working directory needs to be maintained:

```bash
./scripts/preview-inbox.sh
```

It runs in the feature worktree and invokes `node_modules/.bin/pi` explicitly,
not the `pi` command on PATH (which may be a wrapper using live configuration).
It creates temporary configuration/state and two synthetic sessions, and loads
this worktree's inbox, inline-skills and a preview identity guard. A synthetic
`preview-review` skill is included for trying `/skill:preview-review` and
`$preview-review` completion. The header says
**PREVIEW**; `/preview-info` shows the temporary data directory. The guard aborts
during extension loading if Pi does not honor that directory, before starting
an inbox supervisor. No live sessions, agent registries, MCP setup or credentials
are copied. Tools are disabled and
Cmd/Ctrl+Enter submits; Enter inserts a newline. New agents may report missing
model credentials: this is a grouping/UI preview, not a production PR review.
Temporary state is removed on exit unless preview agents or queued work remain;
in that case the script prints the preserved path. Stop preview agents before
removing that directory. `--help` can be passed to smoke-test extension loading
without opening an interactive window.

Try creating PR reviews, editing and enabling its template, moving a demo
session with b, selecting the group, and pressing n. Then use Ctrl+G to change
the new agent's destination and verify that edited draft text is preserved.

## Filters

Filters are a blocklist for *kinds* of sessions, such as automated jobs, so they never clutter the inbox. Matching sessions move to the **Filtered** tab instead of being deleted.

Rules live in `~/.pi/agent/inbox-filters.json`. The file is re-read whenever it changes, so you don't need `/reload`.

```json
{
  "rules": [
    {
      "name": "nightly report job",
      "description": "optional note",
      "firstMessage": "^\\s*Generate the nightly report"
    },
    { "name": "scratch sessions in /tmp", "cwd": "^/(private/)?tmp(/|$)", "maxMessages": 6 }
  ]
}
```

Conditions in a rule must **all** match. A session is filtered if **any** rule matches.

| Field | Matches against |
|---|---|
| `firstMessage` | regex, the session's first user message |
| `cwd` | regex, the directory the session was started in |
| `sessionName` | regex, the session's name (`/name` or `r`) |
| `text` | regex, the full text of every message (slower; use sparingly) |
| `minMessages` / `maxMessages` | number, the session's message count |
| `flags` | RegExp flags for this rule's regexes, e.g. `"i"` |
| `enabled` | `false` turns the rule off without deleting it |
| `name` / `description` | labels shown in the Filtered tab and `/inbox filters` |

A rule with no conditions, an unknown field, or an invalid regex is skipped and reported in `/inbox filters`. The Filtered tab also flags the error count.

**Overrides with `x`.** On a normal session, `x` hides it (`⊘ hidden manually`). On a rule-matched session, `x` keeps it in the inbox despite the rule (tagged `[kept]`). Press `x` again to undo either. Overrides are stored in `inbox.json`. Sending a prompt in a manually hidden session brings it back, the same as archive. Rule-matched sessions stay filtered.

## Status column

| Status | Meaning |
|---|---|
| `● working` | A Pi process (this window's background agent, or another window) is running the agent on this session right now |
| `● queued` | A background agent is waiting for a free slot |
| `⏸ cancelled` | You cancelled the background agent |
| `● working?` | No live record, but the file changed in the last 90s. Probably running in a Pi that hasn't loaded this extension yet (run `/reload` there) |
| `◆ your turn` | Agent finished and is waiting on you |
| `✗ error` | Last turn ended with a provider error |
| `⏸ aborted` | Last turn was aborted |
| `⚠ stalled` | The run was cut off partway (process quit or crashed while working) |
| `· empty` | No messages yet |

Other markers: `⚑` (before the status) = the session this window runs interactively (taken over; orchestrator mode only), `★` = pinned, `◉` = open in some Pi process or run by a background agent, `•` (before the title) = unread, `»` (same slot) = the session you're in — gold when read, blue when you marked it unread on purpose.

**Unread (`•`):** a session that finished (`◆ your turn`) or failed (`✗ error`) after you last looked at it. Running sessions and the one you're in are never unread. Opening a session, peeking with `v`, watching it finish while attached, or leaving it marks it read (stored as `seenAt` in `~/.pi/agent/inbox.json`). History from before unread tracking started counts as read. Press `u` to toggle it by hand: marking read clears the dot (and a background agent's "needs you"); marking unread keeps a reminder dot on it, even while it runs, until you next open or peek at it (stored as `unreadAt`).

Columns: status · title (session name in **bold** if set, else the first message) · latest (`↳` last line of the latest reply, or `▸` what a running agent is doing right now; hidden on narrow terminals) · group (flat views only) · project dir · last activity · message count.

Flat views show each session's group name, or **Ungrouped**, in a fixed-width
column beside the project directory. Long group names are truncated to fit.
Grouped layout omits the redundant column because section headers identify
membership. This applies to Inbox, Archived, All and Filtered tabs; scoped
single-group views remain flat and show the column too.

The preview pane under the list shows the dir, created/updated/pinned/archived times, which process has it open, and the last assistant reply.

## Behaviors to know

- **Reading-position bookmark (fullscreen).** Opening the inbox or switching away remembers the current session's vertical transcript position. After returning to that session, press `ctrl+b` (or run `/bookmark`) to jump back to the same row. `ctrl+shift+b` remains an alias, but requires a terminal that reports Shift separately. `ctrl+b` replaces the main editor's cursor-left shortcut; use Left Arrow to move left. Each session has its own bookmark. Regular mode uses the terminal's native scrollback, which Pi extensions cannot reposition.
- **Auto-unarchive.** If you send a prompt in an archived session, it moves back to the Inbox.
- **Opening a busy session.** If the session is open or working in another Pi process, you're asked to confirm, since two writers can create diverging branches. Switching away from a session that is still working also asks for confirmation, because it aborts the current run.
- **Session files are never modified** by pin or archive. Rename uses Pi's normal `session_info` entry, the same as `/name`.
- **Empty sessions are hidden**, except the one you're in.

## How it works

- **Pin, archive, filter-override, and scroll-bookmark state**: `~/.pi/agent/inbox.json`, keyed by session id. Every Pi process re-reads it before writing, so they don't overwrite each other.
- **Groups and templates**: `<agent-dir>/inbox-groups.json`, separate from session transcripts and legacy inbox metadata. Group views are window-local; the All-groups layout preference is persisted here and restored by new windows.
- **Filter rules**: `~/.pi/agent/inbox-filters.json`, matched against each session's `SessionInfo` on every refresh and cached by file mtime.
- **Live status**: each Pi process writes `~/.pi/agent/inbox-live/<pid>.json` with its session and `working`/`idle` state. It updates on `session_start`, `agent_start` and `agent_settled`, and deletes the file on shutdown. Files for dead PIDs are pruned when the inbox reads them.
- **Session status**: parsed from the tail of each session `.jsonl`: the last message's role and `stopReason`. Results are cached by file mtime and size.
- **Session list**: a two-phase scan of `~/.pi/agent/sessions/` (replaces `SessionManager.listAll()`, which full-parses every file on every refresh):
  1. **Header scan**: read only the first line of each `.jsonl` (id, cwd, timestamp) — a few ms for hundreds of sessions — and partition on the store's archive marks.
  2. **Targeted parse**: full-parse only the files the current view needs. Archived sessions are parsed on demand, the first time you open a tab that can show them (Archived, All, Filtered) or run `/inbox filters`; from then on they stay cached and refresh like active ones.
  Parsed `SessionInfo`s (message count, name, first message, newest activity) are cached per file keyed on mtime+size, so refreshes only reparse files that changed. The text index used by `/` search and filter rules keeps the oldest 5 and newest 10 messages per session instead of the whole transcript — deep middle-of-history text isn't searchable (that tradeoff is what makes the inbox open in ~150ms instead of ~1s).

## Troubleshooting

- **Everything shows `⚠ stalled` or `● working?`.** Other Pi windows haven't loaded the extension. Run `/reload` in each.
- **Reset all pins, archives and filter overrides**: delete `~/.pi/agent/inbox.json`.
- **A session you expected to be filtered still shows up**: run `/inbox filters` to check for rule errors and per-rule hit counts. Also check it isn't `[kept]` by an `x` override.
- **Turn all filtering off**: rename or delete `~/.pi/agent/inbox-filters.json`. Manual `x` hides still apply.

## Pi internals this depends on

⚠️ Mostly public API, but a few features reach into **private** pi-tui
methods or undocumented file layout. Last verified on **Pi 0.99.1**.
`compat-check` probes each row on startup and `/reload` (`/compat` shows all).

| Probe id | Depends on | Used for | If Pi changes it |
|---|---|---|---|
| `tui-composite-methods` | `compositeOverlays` (protected) and `compositeLineAt` (private) on `TuiMainScreen`/`TuiAltScreen` | `coverImagesUnderOverlays()`: blanks terminal-image rows under the inbox and full-width overlays | Guarded by `typeof`: pasted screenshots / images draw over the inbox again |
| `tui-composite-dispatch` | TUI calls them as `this.compositeOverlays(...)` / `this.compositeLineAt(...)` so per-instance overrides take effect | Same | Same, silently |
| `tui-focused-component` | `tui.getFocusedComponent()` | `editorFocused()`: esc cancels the "next message goes to …" reply target only when the editor has focus | esc-to-cancel stops working (returns false) |
| `tui-alt-screen-scroll` | Public `TuiAltScreen#viewportTop` and `#scrollBy()` | Per-session transcript bookmarks (`ctrl+b` / `ctrl+shift+b`) | Bookmark saving/restoring is disabled; the rest of inbox works |
| `editor-methods` | `Editor#getText`, `#insertTextAtCursor`, `#isShowingAutocomplete` (duck-typed on the focused component) | Same | Same |
| `keybindings-get-keys` | `getKeybindings().getKeys(id)` | Key labels in the orchestrator help | Falls back to hard-coded labels |
| `session-manager-api` | `SessionManager.open()`, `#getBranch`, `#getSessionFile`, `#getSessionId`, `#appendSessionInfo` | Reading other sessions; renaming (also used by `rename-chat`) | Inbox list / agent view / rename throw |
| `session-file-layout` | Sessions live at `~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl` | `findSessionFile()` here and in `rename-chat` | Background agents' sessions not found; rename by id fails |
| `ui-custom` | `ctx.ui.custom()` overlays (public) | The inbox itself | Inbox can't open |
| `json-mode-events` | `pi --mode json` emits `agent_start`, `tool_execution_start/end`, `message_update`, `message_end`, `auto_retry_start/end`, `compaction_start` (documented in `docs/json.md`) | Live status/transcript of background agents | Agent view goes blank or status sticks |
| `visit-model-selectors` | Native `ModelSelectorComponent` / `ThinkingSelectorComponent` exports; model picker uses a read-only registry facade (`getAvailableSnapshot`, `getModel`, `getError`, `refresh`) | Model/thinking controls for visited sessions | Picker errors are reported without mutating the taken-over main |
| `visit-chat-container` | pi-tui `Container` keeps plain-array `children` + `addChild/removeChild/clear` semantics | Sticky-takeover visits (`lib/visit-runtime.ts`): stash the main's live chat tree, mount the visit view, restore on return | Visiting is refused so the taken-over main cannot be interrupted; `/compat` names it |

Other assumptions (not probed):

- **CLI flags** for children: `--mode json --session-id <id> [--model m] -- <msg>`
  (documented in `docs/cli.md`). `PI_INBOX_AGENT_ARGS` adds extra args.
- **Session JSONL tail parsing** for status: `type: "message"` entries with
  `message.role` in `user|assistant|toolResult` and `stopReason` in
  `stop|toolUse|error|aborted` (`docs/session-format.md`). A renamed
  `stopReason` shows sessions as the wrong status (e.g. everything "your turn").
- `compositeTuiLine` returning image lines untouched is *why* the image patch
  exists. If Pi fixes that upstream, `coverImagesUnderOverlays()` can go.
- Extension instances are re-created on every session switch; long-lived state
  lives on `globalThis` under `Symbol.for("pi.inbox.*")` keys.

## Recovering after a Pi upgrade

1. Run `/compat` to see which probe failed.
2. Check the current TUI and session shapes:

   ```bash
   R=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)
   D=$R/node_modules/@earendil-works
   grep -n "composite\|getFocusedComponent" $D/pi-tui/dist/tui.d.ts
   grep -n "getText\|insertTextAtCursor\|isShowingAutocomplete" \
     $D/pi-tui/dist/editor-component.d.ts
   ```

3. For JSON-mode or session-format changes, diff the bundled docs between
   releases (`$D/pi-coding-agent/docs/json.md`, `session-format.md`) and
   update the `switch (ev.type)` in `lib/inbox-agents.ts` / `readTail()` in
   `index.ts`.
4. The image-overlay patch is cosmetic. If it breaks, delete the
   `coverImagesUnderOverlays(tui)` calls and the rest of the inbox keeps working.
