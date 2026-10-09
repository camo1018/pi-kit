# session-mention

Reference other Pi sessions from a prompt with `@[...]`.

- Typing `@[` opens a fuzzy picker over all saved sessions (all projects),
  matched by name, first message, cwd basename, or id. Accepting inserts
  `@[<session-id>]` in place. Plain `@` file completion is untouched.
- On submit, each `@[id]` token expands to the referenced session's
  active-branch transcript, injected as a `<skill>`-shaped block (which the
  TUI collapses) ahead of your message. The token itself becomes a `«name»`
  marker.
- `@[...]` inside code spans/fences stays literal; unknown ids are untouched.

## Internal dependencies (brittleness matrix)

| Dependency | Used for | Breaks if |
| --- | --- | --- |
| `lib/inbox-agents.ts` → `transcriptMarkdown()` | rendering another session's branch | the inbox extension's transcript format changes; the extension still loads, mention blocks then render a `_Could not read session_` body |
| `SessionManager.listAll()` / `.open()` / `SessionInfo` (public API) | listing sessions, resolving ids, reading branches | public API surface change in pi core |

No private components or prototypes are patched; everything rides public
extension APIs (`input` event transform + `ctx.ui.addAutocompleteProvider`).

## Recovery

- If `@[` no longer triggers completions: check `compat-check` (`/compat`)
  for `addAutocompleteProvider` availability; the wrapper may need pi-tui's
  current provider-shape.
- If submit does not expand: the `input` event contract changed; verify
  `InputEventResult` still supports `action: "transform"`.
- Safe to disable: the extension only transforms prompts that contain `@[`
  tokens matching known session ids.
