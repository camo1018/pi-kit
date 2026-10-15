# session-mention

Reference other Pi sessions from a prompt with `@[...]`.

- Typing `@[` opens a fuzzy picker over all saved sessions (all projects),
  matched by name, first message, cwd basename, or id. The picker displays the
  session title but always inserts its immutable id, so duplicate or later
  renamed titles cannot redirect the mention. Plain `@` file completion is
  untouched.
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
