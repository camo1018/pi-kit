# 📥 Pi Inbox

A visual "todo box" for every Pi session across all projects: see status at a glance, pin what matters, archive what's done, and filter out sessions you never want to see (automated jobs). It's also a control panel for **background agents**: start agents, watch them work and reply to them, all without leaving the session you're in.

Source: `~/Code/pi-kit/extensions/inbox/index.ts` (background agents: `~/Code/pi-kit/lib/inbox-agents.ts`) · Data: `~/.pi/agent/inbox.json` · Filter rules: `~/.pi/agent/inbox-filters.json`

## Commands

| Command | What it does |
|---|---|
| `/inbox` or `ctrl+q` | Open the inbox overlay |
| `/orchestrator` | Toggle [orchestrator mode](#orchestrator-mode): this window becomes a full-screen agent control panel (`pi --orchestrator` starts in it). Also `on`, `off` |
| `/orchestrator home` | Orchestrator mode: leave this session (it keeps running in the background) and return to the orchestrator |
| `/takeover` | Orchestrator mode: run this session here, like plain pi (waits for a background run to finish first) |
| `/stop` or `ctrl+shift+s` | Orchestrator mode: stop this attached session's background run |
| `/inbox help` | Show this doc (also `?` inside the inbox) |
| `/inbox filters` | Show the active filter rules, how many sessions each hides, and any rule errors |
| `/pin` | Toggle pin on the current session |
| `/archive` | Toggle archive (done) on the current session |
| `/rename [title]` | Rename the current session (no title: auto-title from its first user message). Also available to the agent as the `rename-chat` tool — same naming, works on background-agent sessions too via its `session` param |
| `ctrl+r` | Rename the current session. On orchestrator home / while typing a new agent's first prompt (`n`), names that new agent instead (empty = name from its prompt); after sending, renames the just-started agent |

## Keys inside the inbox

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Move |
| `PgUp` `PgDn`, `g` `G` | Page / jump to top or bottom |
| `enter` | **Agent view**: live transcript of the session; `r` there to reply (see [Background agents](#background-agents)) |
| `o` | Open (switch to) the selected session in this window. In orchestrator mode: open it attached (same as `enter`) |
| `t` | Orchestrator mode: take the session over (it runs here, like plain pi) |
| `v` | Orchestrator mode: peek at the live transcript (what `enter` does outside the mode) |
| `h` | Orchestrator mode: leave the current session and go home |
| `Q` | Orchestrator mode: leave the mode |
| `n` | New background agent in the current directory, using this window's model. You type its prompt in pi's editor |
| `N` | Same, picking its model first |
| `ctrl+w` | (while typing a new agent's prompt) pick a different directory for it — a live path picker with suggestions as you type (see [Directories](#directories)) |
| `d` | Orchestrator mode: move the selected session to a different directory (see [Directories](#directories)) |
| `c` | Cancel a running background agent |
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
  - If the agent is working, the reply is **queued** and delivered as its next turn when the current run finishes.
  - If it's idle, the reply starts a new run in the background right away.
  - This works on **any** idle session, not just ones started with `n`. Replying turns it into a background agent.
- **Keys in the agent view:** `enter`/`r` reply, `o` open the session here, `c` cancel the agent, `↑` `↓` `j` `k` `PgUp` `PgDn` `space` `g` `G` scroll (it follows the bottom while you're there), `esc`/`q` close. Only plain keys: pi reserves most ctrl combos (e.g. `ctrl+o`, `ctrl+x`).
- **Know when they're done:** the footer shows e.g. `agents: 2 working · 1 needs you`. When an agent finishes you get a notification and a sound (from the sound settings in `~/.pi/agent/notify.json`), and its row gets a `•` before the title until you look at it (see Unread below).
- **Take one over:** `o` in the list or the agent view opens the session in this window, like any other. This is refused while the agent is still working; wait, or cancel it with `c`. (In orchestrator mode this works differently; see below.)
- **Cancel:** `c` in the list or the agent view. Completed steps stay saved; reply later to continue.

What to expect:

- **Each run is its own short-lived process.** It starts in about a second inside the same sandbox, loads the session, does one run, saves it and exits. Replies resume the same session, so the agent keeps its full context.
- **Same setup as a normal pi.** Agents load the same settings, skills, extensions and packages as any pi you start. `PI_INBOX_AGENT_ARGS` adds extra CLI flags if you ever want to trim that.
- **Images aren't forwarded** to background agents yet; only the text of the message is sent.
- **No questions mid-run.** Agents have no UI, so an agent that needs input says so in its final reply and waits for yours.
- **At most 6 run at once** (set `PI_INBOX_MAX_AGENTS` to change it). Extra ones show `● queued`.
- **They outlive this window.** Agents are detached processes: quitting pi, closing the tab (or a shell watchdog killing pi) does **not** stop them; the run in flight finishes on its own. Their state, including queued messages, is kept in `~/.pi/agent/inbox-agents/`. The window that started an agent owns it (heartbeat every 5s). If the owner goes away, any other open pi window adopts the agent within ~20s, or the next pi you start does. Adopting means it replays what the agent did so far, keeps following it, pings when it finishes, and delivers queued messages. Queued messages only start once some pi window is open. Stop an agent explicitly with `/stop`, `ctrl+shift+s` or `c`. Switching sessions doesn't stop agents either. Other windows see agents they don't own as `● working` but can't reply to them.
- **Parallel agents in one repo can collide** when they edit the same files. Give each its own git worktree, or keep parallel work to separate files or read-only tasks.

## Orchestrator mode

Orchestrator mode turns the window you're in into a full-screen control panel for agents. The inbox takes the whole terminal, as if it were the program, and pi's chat view never shows while you're in it. No new window or tab is opened.

- **Turn it on:** `/orchestrator` in any window, or start with `pi --orchestrator`. If you're in a session, it stays saved and listed, and the window moves to the orchestrator. `/orchestrator` again (or `/orchestrator off`, or `Q` in the orchestrator) turns it off.
- **New agent:** `n` (or `N` to pick the model) drops you into pi's own chat window at home, so you type the prompt in pi's normal editor (`$skill`, `@file`, same keys). `esc` cancels and returns to the list. Submitting starts the agent in this directory — unless you picked another with `ctrl+w` first; its live progress shows above the editor, and once it has written its session file it opens **attached** (like `enter`). Messages you send while it's starting are queued for it. `ctrl+q` while waiting goes back to the list instead (no auto-open). The header shows how many agents are working or need you.
- **Everything runs in the background.** Nothing runs inside this window's pi unless you take a session over, so switching sessions never aborts anything.
- **Open (attached):** `enter` (or `o`) opens a session in pi's own chat view, banner `📡 attached`. What you type there is sent to a background agent on that session; it doesn't run in this window. While it works, the run **streams into the transcript itself** — appended after what's on screen, rendered with pi's own message components, so a working agent looks exactly like a foreground one: your prompt, the agent's thinking/text as it's written, every tool call with its result, growing downward in the scrollable area (never in the fixed editor dock). Scroll it exactly like any transcript: wheel, `pageUp`/`pageDown` (when the editor is empty), or the terminal's own scrollback. A one-line status above the editor shows only what the transcript can't: the run's state (`⟳ working in the background` / `↻ loading` / `⏸ queued`) and a count of your queued messages — no response content. When the run finishes, the stream is replaced by the real transcript reloaded from disk (same content, no duplicates). Switch away any time; it keeps going.
  - Messages sent while it's working are **queued** for its next run. Mid-run steering is not possible.
  - `ctrl+shift+s` (or `/stop`) stops the background run. esc only interrupts runs in this window.
  - `/compact` and `/tree` are refused while the background run is going, because they would write to the session at the same time. They work normally once it's idle.
  - `/fork` and `/clone` work mid-run, because they only create a new session. `/clone` copies the session from disk up to the agent's last completed step, not the on-screen snapshot. The step in flight (an unanswered tool call or a prompt still being worked on) is left out. The background run carries on in the original session.
  - Model changes (`ctrl+p`, `ctrl+l`, `/model`, `shift+tab`) apply to the next background run.
- **Take over:** `t` on a session (or `/takeover` from an attached session) makes it run here, like plain pi: streaming, esc to interrupt, steering, every command. Banner `🎮 taken over`. If its background run is still going, it takes over automatically when that run finishes (`⏳` in the banner).
- **Leaving a taken-over session** (switching to another one, or `h`) turns it back into an attached one. If it's mid-run, the run is stopped here and continued in the background with a "continue where you left off" message. Only the in-flight step is redone, and messages queued in the editor are dropped.
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

Other markers: `★` = pinned, `◉` = open in some Pi process or run by a background agent, `•` (before the title) = unread, `»` (same slot) = the session you're in — gold when read, blue when you marked it unread on purpose.

**Unread (`•`):** a session that finished (`◆ your turn`) or failed (`✗ error`) after you last looked at it. Running sessions and the one you're in are never unread. Opening a session, peeking with `v`, watching it finish while attached, or leaving it marks it read (stored as `seenAt` in `~/.pi/agent/inbox.json`). History from before unread tracking started counts as read. Press `u` to toggle it by hand: marking read clears the dot (and a background agent's "needs you"); marking unread keeps a reminder dot on it, even while it runs, until you next open or peek at it (stored as `unreadAt`).

Columns: status · title (session name in **bold** if set, else the first message) · latest (`↳` last line of the latest reply, or `▸` what a running agent is doing right now; hidden on narrow terminals) · project dir · last activity · message count.

The preview pane under the list shows the dir, created/updated/pinned/archived times, which process has it open, and the last assistant reply.

## Behaviors to know

- **Auto-unarchive.** If you send a prompt in an archived session, it moves back to the Inbox.
- **Opening a busy session.** If the session is open or working in another Pi process, you're asked to confirm, since two writers can create diverging branches. Switching away from a session that is still working also asks for confirmation, because it aborts the current run.
- **Session files are never modified** by pin or archive. Rename uses Pi's normal `session_info` entry, the same as `/name`.
- **Empty sessions are hidden**, except the one you're in.

## How it works

- **Pin, archive and filter-override state**: `~/.pi/agent/inbox.json`, keyed by session id. Every Pi process re-reads it before writing, so they don't overwrite each other.
- **Filter rules**: `~/.pi/agent/inbox-filters.json`, matched against each session's `SessionInfo` on every refresh and cached by file mtime.
- **Live status**: each Pi process writes `~/.pi/agent/inbox-live/<pid>.json` with its session and `working`/`idle` state. It updates on `session_start`, `agent_start` and `agent_settled`, and deletes the file on shutdown. Files for dead PIDs are pruned when the inbox reads them.
- **Session status**: parsed from the tail of each session `.jsonl`: the last message's role and `stopReason`. Results are cached by file mtime and size.
- **Session list**: `SessionManager.listAll()`, which covers every project folder under `~/.pi/agent/sessions/`.

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
| `editor-methods` | `Editor#getText`, `#insertTextAtCursor`, `#isShowingAutocomplete` (duck-typed on the focused component) | Same | Same |
| `keybindings-get-keys` | `getKeybindings().getKeys(id)` | Key labels in the orchestrator help | Falls back to hard-coded labels |
| `session-manager-api` | `SessionManager.open()`, `#getBranch`, `#getSessionFile`, `#getSessionId`, `#appendSessionInfo` | Reading other sessions; renaming (also used by `rename-chat`) | Inbox list / agent view / rename throw |
| `session-file-layout` | Sessions live at `~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl` | `findSessionFile()` here and in `rename-chat` | Background agents' sessions not found; rename by id fails |
| `ui-custom` | `ctx.ui.custom()` overlays (public) | The inbox itself | Inbox can't open |
| `json-mode-events` | `pi --mode json` emits `agent_start`, `tool_execution_start/end`, `message_update`, `message_end`, `auto_retry_start/end`, `compaction_start` (documented in `docs/json.md`) | Live status/transcript of background agents | Agent view goes blank or status sticks |

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
