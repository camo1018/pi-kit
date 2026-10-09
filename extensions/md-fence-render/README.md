# md-fence-render

Display-only changes to how fenced blocks render in the transcript:

- ```` ```md ```` / ```` ```markdown ```` blocks in assistant messages are
  unwrapped and rendered as formatted Markdown between `┌─ rendered markdown`
  and `└─` markers. Code blocks nested inside them still render as code.
- Every other code block keeps Pi's highlight.js syntax highlighting, but the
  literal ```` ```lang ```` / ```` ``` ```` fence lines are replaced by
  `┌─ lang` / `└─` markers (`┌─ code` when untagged).
- In Pi's actual fullscreen TUI renderer, clicking any row of a code block
  copies that exact block through `click-copy`. Regular mode
  keeps mouse input for terminal selection, even when the orchestrator overlay
  is full-width.
- Adds copy-safe code block rules to the system prompt: code lines under 80
  columns, comments on their own line, no leading indent. Prose blocks
  (```text drafts like Slack messages) are exempt — one sentence/bullet per
  line, no hard wrapping; they're copied by clicking (click-to-copy) instead
  of mouse selection.

The session file and model context keep the raw fences; `/copy` copies them.

## Pi internals this depends on

⚠️ The code-block label patches a **private** pi-tui method. Pi has no public
hook for drawing code blocks. Last verified on **Pi 0.99.1**.
`compat-check` probes each row on startup and `/reload` (`/compat` shows all).

| Probe id | Depends on | If Pi changes it |
|---|---|---|
| `markdown-transformer-api` | `pi.registerMarkdownTransformer()` (public) | ```` ```md ```` blocks show as code again |
| `markdown-render-token` | `Markdown.prototype.renderToken` (private, pi-tui) | Patch wraps nothing; plain ```` ``` ```` fences return |
| `markdown-fence-shape` | `renderToken` emits `theme.codeBlockBorder("```lang")` as the first line and `codeBlockBorder("```")` as the closing line | Exact-match check fails; stock fences return |
| `code-block-label-renders` | End to end: a rendered `bash` block contains `┌─ bash` and `└─`, and no ```` ``` ```` | Catches anything above, plus a patch that didn't install |
| `code-block-click-routes` | `Markdown.render()` row mapping plus fullscreen `handleMouse()` press/click dispatch | Code blocks still render, but clicking does not copy |

Other assumptions (not probed):

- `renderToken(token, ...)`: token is the first argument and has
  `type`/`lang`/`text`.
- `Markdown.render(width)` returns the same rows and local Y coordinates used
  by fullscreen mouse dispatch. Claiming a code-block press intentionally
  favors click-to-copy over drag selection inside that block; other rows keep
  fullscreen selection behavior.
- `Markdown` is imported from `@earendil-works/pi-tui`, which Pi's extension
  loader aliases to the same bundled copy interactive mode uses. If the alias
  stops being shared, the patch silently applies to an unused copy (the
  end-to-end probe would still pass, so check visually).
- `markdown.codeBlockIndent: ""` in `settings.json` keeps code lines flush for
  copying; the label line is separate.

Failure modes are fail-open: every mismatch returns Pi's original output.
One exception: if `Markdown` stops being exported, `Markdown.prototype` throws
on load and the whole extension (including md rendering and the prompt rules)
fails to load.

## Recovering after a Pi upgrade

1. Run `/compat` to see which probe failed.
2. Find the new code-block renderer:

   ```bash
   R=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)
   D=$R/node_modules/@earendil-works
   grep -n "renderToken\|codeBlockBorder" \
     $D/pi-tui/dist/components/markdown.d.ts
   grep -rl 'codeBlockBorder(`' $D/pi-coding-agent/dist/bundle/chunks
   ```

3. Update `patchCodeBlocks()` in `index.ts` to the new method name/shape, then
   update the fingerprint in `compat-check` (`markdown-fence-shape`).
4. If it can't be fixed quickly, delete `patchCodeBlocks();` from the factory.
   Markdown-block rendering keeps working through the public transformer API.
