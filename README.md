# pi-kit

Extensions for [pi](https://pi.dev), packaged as a pi package.

## Install

**Requirements:** [pi](https://pi.dev) 0.99+ and Node 18+ (for the selector helper).
`voice` and `notify` need macOS (afplay/osascript); everything else is cross-platform.

```bash
pi install git:github.com/camo1018/pi-kit
```

That installs everything. To **pick extensions** — pi-kit is modular, you don't
have to load all of it:

```bash
git clone https://github.com/camo1018/pi-kit ~/Code/pi-kit && ~/Code/pi-kit/install.sh --extensions inbox,plan-mode
```

`install.sh` registers the package with pi (from the clone, so edits apply on
`/reload`), records your selection, and seeds default config files — never
overwriting existing ones. Re-run it to change the selection:

```bash
~/Code/pi-kit/install.sh --list                    # names, one per line
~/Code/pi-kit/install.sh --extensions all          # back to everything
~/Code/pi-kit/install.sh --extensions "inbox,plan-mode,voice" --voice
```

- `--voice` installs sox + whisper-cpp and downloads the dictation models
  (~500 MB) into `~/.pi/agent/voice/models/`.
- `--no-config` skips seeding `~/.pi/agent/keybindings.json`,
  `notify.json`, and the notification sound.
- The selection is stored as pi's native object-form package entry in
  `~/.pi/agent/settings.json`, so `pi config` (interactive resource toggles)
  keeps working on top of it.

### What install.sh seeds

| File | Effect |
|---|---|
| `~/.pi/agent/keybindings.json` | `cmd/ctrl+enter` submits, `enter` inserts a newline |
| `~/.pi/agent/notify.json` | notifications on (sound: `assets/sounds/bork.m4a`, a real dog's bark) |
| `~/.pi/agent/sounds/bork.m4a` | the sound file itself |

If you don't want the keybinding change, delete `tui.input.newLine` from your
`keybindings.json` after install (or use `--no-config` and configure manually).

### Verify

```bash
pi list                    # pi-kit appears under "User packages"
pi --help                  # --orchestrator appears when inbox is loaded
```

Then inside pi, run `/reload` (or restart) and try `/orchestrator` (inbox),
`/plan`, `/notify`… `/compat` shows the internals-compatibility report.

### Update / uninstall

```bash
pi update --extension git:github.com/camo1018/pi-kit   # update the checkout
~/Code/pi-kit/install.sh                               # re-seed / refresh selection
pi remove git:github.com/camo1018/pi-kit               # uninstall
```

For a cloned install, `git pull` is equivalent to `pi update --extension`.

## Extensions

| Extension | What it does |
|---|---|
| `inbox/` + `lib/inbox-agents.ts` | Orchestrator mode (`pi --orchestrator`, `ctrl+q`): session inbox, background agents, attach/takeover. ⚠️ [docs + internals](extensions/inbox/README.md) |
| `plan-mode/` | Read-only plan mode (`/plan`, `ctrl+shift+r`, `/todos`) |
| `voice/` | Local voice dictation via sox + whisper.cpp (`/voice`, `/voice check`). macOS |
| `notify/` | Sound + macOS notification when a turn finishes (`/notify`, `~/.pi/agent/notify.json`) |
| `rename-chat/` | `rename-chat` tool so the agent can title sessions |
| `inline-skills/` | `$skill` inline skill references |
| `md-fence-render/` | Render ```` ```md ```` blocks as Markdown; `┌─ lang` / `└─` markers instead of ```` ``` ```` fences on code; copy-safe code block prompt rules. ⚠️ [internals](extensions/md-fence-render/README.md) |
| `snippet-copy/` | `/cc [n|lang]`, `ctrl+shift+y`, or a fullscreen click copies a fenced block exactly (pbcopy / OSC 52). [internals](extensions/snippet-copy/README.md) |
| `tool-output-hide/` | Collapse noisy tool output. ⚠️ [internals](extensions/tool-output-hide/README.md) |
| `final-answer-divider/` | Visual divider before the final answer |
| `compat-check/` | Warns on startup / `/reload` when a Pi upgrade breaks an extension that uses Pi internals (`/compat` for the full report) |

`compat-check` only reports probes for extensions you actually load — excluded
extensions are skipped, and `/compat` marks them `not loaded`.

### Pi upgrades

Extensions marked ⚠️ patch or depend on Pi internals that can change in any
release. Each has a README with a "Pi internals" table (what it depends on,
what breaks, how to recover) whose probe ids match `compat-check`.

After upgrading Pi, start it (or `/reload`): if a probe fails you get a
warning naming the extension and its README. Silence means everything passed;
the first clean run on a new version shows a one-line "all checks pass" note.

When adding code that touches Pi internals (prototype patches, private/protected
methods, undocumented file layout), add a probe to
`extensions/compat-check/index.ts` and a row to that extension's README.

## Config

- `config/keybindings.json`: `cmd/ctrl+enter` submits, `enter` adds a newline.
- `config/notify.json`: notification defaults, using `assets/sounds/bork.m4a` (a real dog's bark).

## License

MIT
