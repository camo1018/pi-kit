# final-answer-divider

Marks where the agent's concluding answer begins, and scrolls the transcript
to it.

`/final` or `ctrl+f` puts the **last** FINAL ANSWER at the top of the
transcript viewport. It always goes to that same one — it does not cycle
through earlier answers, so pressing again changes nothing.

## The divider

`message_end` fires for every finalized assistant message, before the TUI
renders it, and that message already carries the deterministic signal: it
stopped on `stopReason === "stop"` (finished, not `toolUse`/`length`/`error`/
`aborted`) and contains no tool calls. By definition that is the run's final
answer, so `registerMarkdownTransformer` prepends

```text
---
▼ FINAL ANSWER
```

to its first text block when rendered. Display only: the session file, the
model context, and JSON/RPC output are untouched, and no prompt tokens are
spent asking the model to format anything. The first text block of each
detected final answer is remembered so the divider survives re-renders
(resize, theme change, `/tree` navigation); on `session_start` the current
branch is rescanned because `message_end` does not re-fire for history.

## Navigation

Rows are found by scanning the scroll view's **already rendered** lines for
the heading, so the divider is the anchor rather than a fuzzy text match.
Rows come from the last layout pass (`scrollContentLines`) rather than a fresh
render, because `ScrollView#scrollTo()` clamps to the content height that pass
computed — measuring from a new render can disagree with it mid-stream or
after a resize that has not painted yet.

The target is always the newest divider in the rendered transcript. This is
deliberately **not** a cycle or a history walk: the key is idempotent, so its
meaning does not depend on where the viewport happens to be. Smashing `ctrl+f`
after a run always lands on the answer you just got.

If you ever want to reach an older final answer, the transcript is the
ordinary scroll surface — this key only ever jumps to the latest one.

## Keys

| Key / command | Action |
|---|---|
| `ctrl+f` | Scroll to the last FINAL ANSWER |
| `/final` | Same, when a key is easier to type than to press |

`ctrl+f` is a single control byte (`0x06`), so it arrives identically under the
legacy, xterm `modifyOtherKeys`, and kitty keyboard protocols — no modifier
support is needed from the terminal at all. A chord with a modifier (a
`ctrl+shift+…` combination) instead depends on the terminal reporting shift
distinctly, which is exactly the kind of thing that silently stops working.

### This takes over `ctrl+f`

`ctrl+f` is bound to `tui.editor.cursorRight` ("move cursor right"). That
takeover is deliberate and silent:

- Extension shortcuts are dispatched **before** any editor handling
  (`CustomEditor.handleInput`), so the shortcut always wins.
- `tui.editor.cursorRight` is **not** in
  `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`, so pi does not print a
  startup conflict warning — unlike `ctrl+l`, `ctrl+c`, `ctrl+d`, etc.

`→` still moves the cursor one character right; only the `ctrl+f` **alias** is
repurposed. Verified against a real `CustomEditor`: with the shortcut
registered the cursor stays put, and without it the same byte moves the cursor.

If you want `ctrl+f` back for the editor, delete the shortcut registration and
use `/final` (or bind a different key in `~/.pi/agent/keybindings.json`).

Requires fullscreen TUI mode (`/settings` or `--tui-mode`); in regular mode
the terminal owns scrollback and the key reports that instead of half-working.
A transcript with no final answer yet (a fresh session, or a run that errored
or was aborted) says so and does not move the viewport.

## Pi internals this depends on

⚠️ The divider itself is pure public API. Navigation reads **private** pi-tui
state. Last verified on **Pi 0.99.1**; `compat-check` probes the row on
startup and `/reload` (`/compat` shows all).

| Probe id | Depends on | If Pi changes it |
|---|---|---|
| `transcript-scroll-targets` | `TuiAltScreen#getPrimaryScrollView()`, `ScrollView#scrollTo()`, and the layout box's `scrollContentLines` | Falls back to rendering the scroll view's child when no layout exists, and to `scrollBy()` when `scrollTo()` is missing; with all of it gone the key reports it cannot read the viewport |
| `scroll-view-child` | `ScrollView#child` is the document component, usable as `child.render(contentWidth)` | Same fallback stops working |
| `set-widget-tui` | `ctx.ui.setWidget(key, factory)` calls the factory with pi's live TUI | The TUI is never captured and navigation reports it cannot read the viewport |

The TUI is captured by registering an **empty** widget (`render: () => []`):
pi hands the TUI to widget factories, and this is the only public path to it.
The widget renders no lines and pi already draws a spacer for an empty widget
region, so it costs no screen rows.

Other assumptions:

- The rendered heading stays `▼ FINAL ANSWER`. `FINAL_ANSWER_MARKER` in
  `index.ts` is the single source of truth; it is exported so the tests can
  assert against it instead of a copy.
