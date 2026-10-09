# snippet-copy

Copy fenced code blocks from assistant messages exactly — one keystroke,
no mouse selection, no wrap or padding artifacts.

```
/cc            copy the most recent code block
/cc 3          copy block #3
/cc text       copy the most recent block tagged ```text
               (e.g. the latest Slack draft)
ctrl+shift+y   copy the most recent code block
```

Click-to-copy used to live here; it now lives in the separate
**click-copy** extension (the two share nothing — a click copies without
touching the numbering here, and `/cc` works without the click hook).

- Every fenced block in an assistant message gets a display-only label under
  it (`⧉ #3 · /cc 3`). Labels appear in the transcript only; the session file
  and model context keep the raw text.
- Copying goes through Pi's `copyToClipboard()`: native `pbcopy` on macOS,
  OSC 52 over SSH (enable *iTerm2 → Settings → General → Selection →
  Applications in terminal may access clipboard* to land in the Mac clipboard
  from a remote session).
- The block registry repopulates from the session branch on
  startup/reload/resume and grows on every assistant `message_end`.

## Why it exists

pi-tui hard-wraps long lines into physical terminal rows, so triple-click
line selection copies wrap-induced fragments — and the copy-safe guideline
(md-fence-render) means even prose like Slack drafts contains real line
breaks at ~80 columns. `/cc` bypasses selection entirely and copies the
exact original text.

## Transformer ordering

Markdown transformers chain in package order. This extension is registered
**before** `md-fence-render` so labels attach to the raw markdown and the
fence rewriting (`┌─ lang` / `└─`) renders around them. Its fence scanner
mirrors md-fence-render's nesting rules (`RENDER_LANGS`), so ```` ```md ````
blocks with nested fences are numbered correctly instead of truncating at
the first inner fence. If you add a language to `RENDER_LANGS` there, mirror
it here.

## Pi internals this depends on

All public APIs:

- `pi.registerCommand("cc", …)` with `getArgumentCompletions`
- `pi.registerShortcut("ctrl+shift+y", …)`
- `pi.on("message_end")` / `pi.on("session_start")` +
  `ctx.sessionManager.getBranch()`
- `pi.registerMarkdownTransformer()` (display-only)
- `copyToClipboard()` from `@earendil-works/pi-coding-agent`
