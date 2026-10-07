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
| `inbox/` + `lib/inbox-agents.ts` | Orchestrator mode (`pi --orchestrator`, `ctrl+q`): session inbox, background agents, attach/takeover. See [`extensions/inbox/README.md`](extensions/inbox.README.md) |
| `plan-mode/` | Read-only plan mode (`/plan`, `ctrl+shift+r`, `/todos`) |
| `voice/` | Local voice dictation via sox + whisper.cpp (`/voice`, `/voice check`). macOS |
| `notify/` | Sound + macOS notification when a turn finishes (`/notify`, `~/.pi/agent/notify.json`) |
| `rename-chat/` | `rename-chat` tool so the agent can title sessions |
| `inline-skills/` | `$skill` inline skill references |
| `snippet-copy/` | Copy code snippets from responses |
| `tool-output-hide/` | Collapse noisy tool output |
| `final-answer-divider/` | Visual divider before the final answer |

## Config

- `config/keybindings.json`: `cmd/ctrl+enter` submits, `enter` adds a newline.
- `config/notify.json`: notification defaults, using `assets/sounds/bork.m4a` (a real dog's bark).

## License

MIT
