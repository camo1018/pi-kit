# thinking-block-hide

Adds a third state to `ctrl+t` (`app.thinking.toggle`):

`visible → collapsed → hidden → visible …`

- **visible** shows the reasoning text.
- **collapsed** shows Pi's native `Thinking...` placeholder.
- **hidden** removes reasoning blocks completely from the transcript.

Hidden mode is display-only. It does not change session history or the model's
context. A `thinking hidden` footer badge shows while it is active.

Use `/thinking-blocks [visible|collapsed|hidden]` to set a state directly. The
selected state persists in
`~/.pi/agent/thinking-block-visibility.json`.

## Pi internals this depends on

⚠️ Patches two **internal** pi-coding-agent classes. Pi has no public hook for
removing thinking blocks or overriding a built-in key action. Last verified on
**Pi 0.99.1**. `compat-check` probes each row on startup and `/reload`.

| Probe id | Depends on | If Pi changes it |
|---|---|---|
| `assistant-message-content` | `AssistantMessageComponent` exports `updateContent()` and `render()`; instances retain their current message and thinking visibility fields | Hidden mode may leave labels, spacing, or reasoning text visible |
| `custom-editor-handle-input` | `CustomEditor.prototype.handleInput(data)` is exported | `ctrl+t` falls back to Pi's native two-state toggle |
| `custom-editor-action-handlers` | `CustomEditor` dispatches app keys through `actionHandlers` and `keybindings.matches()` | The three-state cycle no longer intercepts `ctrl+t` |
| `hidden-thinking-label-ui-api` | `ctx.ui.setHiddenThinkingLabel()` triggers existing assistant blocks to refresh | Switching modes may not redraw until the next transcript update |
| `patch-installed` | The patches installed on `globalThis[Symbol.for("pi.ext.thinking-block-hide")]` | Something above failed silently |

Other assumptions:

- The keybinding id remains `app.thinking.toggle`.
- Assistant messages keep `lastMessage`, `isStreaming`, `hideThinkingBlock`,
  and `thinkingVisibilityOverrides` as runtime properties.
- Filtering `thinking` parts before rendering does not affect the original
  message object. The original remains attached to the component and is used
  again when hidden mode is left.

## Recovering after a Pi upgrade

1. Run `/compat` to see which probe failed.
2. Inspect the current class declarations:

   ```bash
   R=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)
   C=$R/node_modules/@earendil-works/pi-coding-agent/dist
   grep -n "updateContent\|render" \
     $C/modes/interactive/components/assistant-message.d.ts
   grep -n "handleInput" \
     $C/modes/interactive/components/custom-editor.d.ts
   ```

3. Update `installPatches()` in `index.ts` and the matching probes in
   `compat-check`.
4. To disable the extension, remove its path from `package.json` or exclude it
   with `pi config`. Pi's native `ctrl+t` toggle then works normally.
