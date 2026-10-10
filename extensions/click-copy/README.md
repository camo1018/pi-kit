# click-copy

Copy a fenced code block from assistant messages exactly — click it, no
mouse selection, no wrap or padding artifacts.

```
click block    copy that block (fullscreen TUI mode only)
```

The click path requires Pi's actual `tuiMode: "fullscreen"` renderer. A
full-width orchestrator overlay in regular mode is not the fullscreen renderer;
regular mode leaves mouse input with the terminal for text selection.

- Successful copies briefly show `Copied` beside the clicked block's opening
  marker. The feedback is display-only and disappears after 1.5 seconds; it is
  not appended to the transcript.
- Copying goes through Pi's `copyToClipboard()`: native `pbcopy` on macOS,
  OSC 52 over SSH (enable *iTerm2 → Settings → General → Selection →
  Applications in terminal may access clipboard* to land in the Mac clipboard
  from a remote session).

## Why it exists

pi-tui hard-wraps long lines into physical terminal rows, so triple-click
line selection copies wrap-induced fragments. Click-to-copy bypasses
selection entirely and copies the exact original text.

## Implementation

`md-fence-render` maps rendered rows to code blocks and claims press/click
in its fullscreen `handleMouse`, routing the exact source and an inline
feedback callback through the click hook this extension exposes on
`globalThis` by symbol (`Symbol.for("pi-kit:click-copy:click")`).

After the clipboard write succeeds, the callback updates that Markdown
instance. The extension asks Pi to repaint by clearing an absent extension
status, which remains display-neutral and also works for visited sessions while
another session is taken over.

- `pi.on("session_start")` for the active UI context
- `ctx.ui.setStatus()` for a display-neutral TUI repaint
- `copyToClipboard()` from `@earendil-works/pi-coding-agent`
