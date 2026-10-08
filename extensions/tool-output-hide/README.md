# tool-output-hide

Adds a third state to `ctrl+o` (`app.tools.expand`):
`collapsed → expanded → hidden → collapsed …`. "hidden" removes tool-call
blocks from the transcript (display-only) and shows a `tools hidden` footer
badge. `/tools [collapsed|expanded|hidden]` sets the state directly.

## Pi internals this depends on

⚠️ Patches two **internal** pi-coding-agent classes. Pi has no public hook for
tool block rendering or for overriding a built-in key action.
Last verified on **Pi 0.99.1**. `compat-check` probes each row on startup and
`/reload` (`/compat` shows all).

| Probe id | Depends on | If Pi changes it |
|---|---|---|
| `tool-execution-render` | `ToolExecutionComponent` exported, with `prototype.render(width)` returning lines | Import fails (extension won't load) or "hidden" stops hiding |
| `custom-editor-handle-input` | `CustomEditor` exported, with `prototype.handleInput(data)` | Import fails, or `ctrl+o` falls back to the built-in 2-state toggle |
| `custom-editor-action-handlers` | `CustomEditor` dispatches app keys through `this.actionHandlers` (a `Map`) and `this.keybindings.matches(data, action)` | The guard never matches; `ctrl+o` falls back to the 2-state toggle |
| `tools-expanded-ui-api` | `ctx.ui.getToolsExpanded()` / `setToolsExpanded()` (public) | Cycling throws |
| `patch-installed` | The patches actually installed (shared state on `globalThis[Symbol.for("pi.ext.tool-output-hide")]`) | Something above failed silently |

Other assumptions (not probed):

- The keybinding id is still `app.tools.expand`.
- Hidden blocks render as `[]`, which Pi's container treats as zero height.
  If Pi starts adding padding/spacers around tool blocks itself, gaps may
  remain where hidden blocks were.
- Patches install once per process and read live state from `globalThis`, so
  `/reload` swaps the handler instead of double-wrapping. If Pi starts
  re-creating these classes per reload, the patch would apply to a stale copy.

## Recovering after a Pi upgrade

1. Run `/compat` to see which probe failed.
2. Look at the current class shapes:

   ```bash
   R=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)
   C=$R/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components
   cat $C/custom-editor.d.ts
   grep -n "render(" $C/tool-execution.d.ts
   ```

3. Update `installPatches()` in `index.ts`, then the matching probes in
   `compat-check`.
4. If it can't be fixed quickly, remove the extension from `package.json`.
   `ctrl+o` goes back to Pi's built-in collapsed/expanded toggle.
