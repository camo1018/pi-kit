# session-mention

Reference other Pi sessions from a prompt with `@[...]` (or sessions in your current inbox group with `@g[...]` / `@ga[...]`).

- Typing `@[` opens a fuzzy picker over all saved sessions (all projects),
  matched by name, first message, cwd basename, or id. The picker displays the
  session title but always inserts its immutable id, so duplicate or later
  renamed titles cannot redirect the mention. Plain `@` file completion is
  untouched.
- Typing `@g[` restricts the autocomplete suggestions specifically to other
  saved sessions that belong to the relevant inbox group, **excluding sessions
  the Inbox has archived**. Typing `@ga[` uses the same group filter but
  **includes archived sessions too**.
- The group path resolves members from filenames (`<timestamp>_<session-id>.jsonl`)
  and reads only each member's header line and its last `session_info` entry, so
  it never runs pi's full scan. Cold is ~250 ms for a 139-member group and ~0 ms
  per follow-up keystroke (1 s cache), versus ~2.5 s per keystroke for
  `SessionManager.listAll()` on an 834-file / 1 GB tree. `@[` still uses
  `SessionManager.listAll()`, since it spans every project.
- A member whose file is gone (a deleted session whose group membership
  outlived it) is skipped. It is *not* worth seconds per keystroke to chase, and
  the alternative — a full scan on every keystroke — is what made `@g[` feel
  broken. A member whose file was renamed or copied is still found: the filename
  stem answers the common case, and unmatched ids are matched against header ids
  (one 4 KB read per candidate, memoised per path).
- Archive state comes from `~/.pi/agent/inbox.json` (`sessions[id].archivedAt`),
  re-read at most once per second. Only the Inbox writes that file; if it is
  missing or unreadable, nothing counts as archived.
- If the current
  session is ungrouped (or if no other sessions exist in that group), an
  informative placeholder item is shown instead of inserting arbitrary sessions.
  When every sibling in the group is archived, the `@g[` placeholder points at
  `@ga[`.
  Selecting a suggestion inserts the standard `@[id]` token.
- The group `@g[` means is resolved from the action you are taking, most
  specific first: the pending inbox target (composing a new agent's chosen
  group, or the group of the agent you are replying to), then the `F` one-off
  pre-pick, then the current session's own membership, then — only in
  orchestrator mode — the current group view and the default group. Reading the
  session's own membership first meant that composing or replying across groups
  listed the *sender's* siblings, which reads as "it is picking up other
  groups".
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
| Pi's session-file naming (`<timestamp>_<id>.jsonl`) and folder layout | resolving a whole group without pi's full scan | the format changes; the filename stem no longer matches, but header-id matching still finds every member (correct, just slower on a cold cache) |
| Inbox globals `pi.inbox.reply-target`, `pi.inbox.next-agent-group`, `pi.inbox.group-view`, `pi.inbox.mode` | resolving which group `@g[` means | the Inbox renames those keys; `@g[` then falls back to the session's own membership and stops following the agent you are replying to |

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
