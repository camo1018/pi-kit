# pi-kit

Extensions for [pi](https://pi.dev), packaged as a pi package.

## Install

```bash
pi install git:github.com/camo1018/pi-kit
```

Or clone it for live editing (changes apply on `/reload`) and seed the default config:

```bash
git clone https://github.com/camo1018/pi-kit ~/Code/pi-kit && ~/Code/pi-kit/install.sh   # add --voice for sox/whisper + models
```

`install.sh` never overwrites existing config files.

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
| `tool-output-hide/` | Collapse noisy tool output. ⚠️ [internals](extensions/tool-output-hide/README.md) |
| `final-answer-divider/` | Visual divider before the final answer |
| `compat-check/` | Warns on startup / `/reload` when a Pi upgrade breaks an extension that uses Pi internals (`/compat` for the full report) |

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
