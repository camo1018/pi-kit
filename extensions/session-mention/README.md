# session-mention

Reference other Pi sessions from a prompt with `@[...]` (or sessions in your current inbox group with `@g[...]` / `@ga[...]`).

- Typing `@[` opens a fuzzy picker over all saved sessions (all projects),
  matched by name, first message, cwd basename, or id. The picker displays the
  session title but always inserts its immutable id, so duplicate or later
  renamed titles cannot redirect the mention. Plain `@` file completion is
  untouched.
- Typing `@g[` restricts the autocomplete suggestions specifically to other
  saved sessions that belong to the current session's inbox group, **excluding
  sessions the Inbox has archived**. Typing `@ga[` uses the same group filter
  but **includes archived sessions too**.
- The group path resolves members from filenames (`<timestamp>_<session-id>.jsonl`)
  and reads only each member's header line and its last `session_info` entry, so
  it never runs pi's full scan. On a 496-file / 543 MB session tree that is
  ~5–70 ms per group instead of ~1.3 s for every cold keystroke. `@[` still uses
  `SessionManager.listAll()`, since it spans every project. If a member has no
  file — or a file that won't parse — the lookup falls back to the full scan and
  filters, so the picker never silently drops a session.
- Archive state comes from `~/.pi/agent/inbox.json` (`sessions[id].archivedAt`),
  re-read at most once per second. Only the Inbox writes that file; if it is
  missing or unreadable, nothing counts as archived.
- If the current
  session is ungrouped (or if no other sessions exist in that group), an
  informative placeholder item is shown instead of inserting arbitrary sessions.
  When every sibling in the group is archived, the `@g[` placeholder points at
  `@ga[`.
  Selecting a suggestion inserts the standard `@[id]` token.
- A session that is still being composed (no membership on disk yet) resolves
  its group the same way the Inbox starts the agent: the pending new-agent reply
  target (`ctrl+g`), then the `F` one-off pre-pick, then — only in orchestrator
  mode — the current group view and the default group. Without this, `@g[` in a
  brand-new session always claimed there was no group.
- On each model request, every recognized `@[id]` token expands in Pi's
  in-flight context clone. The referenced active-branch transcript is placed
  in a `<skill>`-shaped block and the token becomes a readable `«title»`
  marker for that request.
- The saved user message remains exactly as typed. Referenced transcripts do
  not enter the session file, transcript view, tree, or editor history.
- Transcript bodies are XML-escaped before being wrapped, so text such as
  `</session>` or `</skill>` cannot close the envelope. Each transcript is
  capped at 24 KiB of escaped text, with a 64 KiB and 16-session total per
  model request. Truncation keeps both the beginning and end.
- Manually typed `@[name]` tokens remain supported only when the name is unique.
  Ambiguous names stay literal instead of silently selecting the newest
  session.
- `@[...]` inside code spans or fences stays literal. Unknown ids and names are
  untouched.

## Internal dependencies (brittleness matrix)

| Dependency | Used for | Breaks if |
| --- | --- | --- |
| `lib/inbox-agents.ts` → `transcriptMarkdown()` | rendering another session's branch | the inbox extension's transcript format changes; the extension still loads, mention blocks then render a `_Could not read session_` body |
| `SessionManager.listAll()` / `.open()` / `SessionInfo` (public API) | listing sessions, resolving ids, reading branches | public API surface change in pi core |
| `~/.pi/agent/inbox.json` (`sessions[id].archivedAt`) | deciding which group siblings `@g[` hides | the Inbox moves archive state to another file; `@g[` then shows archived sessions again (`@ga[` is unaffected) |
| Pi's session-file naming (`<timestamp>_<id>.jsonl`) and folder layout | resolving a whole group without pi's full scan | the format changes; the group lookup finds no files and silently falls back to the slower full scan (still correct) |
| Inbox globals `pi.inbox.reply-target`, `pi.inbox.next-agent-group`, `pi.inbox.group-view`, `pi.inbox.mode` | resolving the group of a session that is still being composed | the Inbox renames those keys or stops tracking a pending new-agent group; `@g[` in a brand-new session then reports no group until the agent spawns |

No private components or prototypes are patched. Request-time expansion uses
Pi's documented `context` event, and autocomplete uses
`ctx.ui.addAutocompleteProvider`.

## Recovery

- If `@[` no longer triggers completions: check `compat-check` (`/compat`) for
  `addAutocompleteProvider` availability; the wrapper may need pi-tui's current
  provider shape.
- If a mention does not expand: verify the id still exists. A duplicate manual
  name intentionally does not resolve; select the session again to insert its
  id.
- If request-time expansion breaks after a Pi upgrade: verify the `context`
  event still supplies a mutable clone of user messages.
- Safe to disable: the extension only changes in-flight user-message clones
  containing recognized `@[...]` tokens.
