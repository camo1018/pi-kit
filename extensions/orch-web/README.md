# 📱 orch-web

Drive your pi background agents from your phone, over your local network.

A phone-sized front end for the inbox: see every session, watch a run stream
live, reply, queue, cancel, and start new agents. It reads the same files the
desktop inbox reads, so both stay in sync.

Optionally it also gives you a **real shell on the Mac** (see *Terminal*): a run
is not a prompt, so anything that needs a human at a terminal — a provider
re-auth, `sudo`, a TUI you want to nudge — has nowhere else to happen.

```text
Mac:    ./scripts/orch-web.sh --pair        → prints URL + 6-digit code
Phone:  open the URL, type the code         → done, add to home screen
```

## Setup (once)

```sh
cd ~/Code/pi-kit

# 1. Credentials: launchd starts the daemon with no environment, so its child
#    pi processes cannot authenticate and nothing runs. Name the variables a
#    working pi has in your shell; they are saved (mode 600) for the daemon.
#    Use whatever your provider setup actually sets — this is an example:
ORCH_WEB_ENV_VARS='MY_PROVIDER_BASE_URL MY_PROVIDER_TOKEN_PATH NODE_EXTRA_CA_CERTS' \
  ./scripts/orch-web-install.sh --capture-env

# 2. Install + start as a login service (survives reboot, restarts on crash):
./scripts/orch-web-install.sh
```

That's it. It listens on your LAN at port `8787` and logs to
`~/.pi/agent/orch-web.log`.

## Pair a phone

```sh
./scripts/orch-web.sh --pair
```

```text
  http://192.168.1.42:8787/
  http://YOUR-MAC.local:8787/     (survives an IP change)

  code: 482913   · valid 10 min · single use
```

Open the URL on a phone on the same wifi, type the code, then *Share → Add to
Home Screen*. The code is single-use and expires; `--pair` again to re-pair or to
invalidate the old one.

First connection triggers a macOS firewall prompt for `node` — **Allow**.

## Everyday use

| Task | How |
|---|---|
| Open a session | tap a row |
| Back to the list | `‹` top-left, or the phone's back gesture |
| Session actions | `⋯` on a row, or `⋯` in the session header |
| View tabs | Inbox · Archived · All · Hidden |
| Send | type, then tap **Send** (or Cmd/Ctrl+Enter); becomes **Queue** while that session is running |
| Newline | **Enter** in the composer |
| Dismiss the keyboard | tap anywhere in the transcript |
| See what's queued | the queue strip above the composer: **now** / **✕** per item |
| Start an agent | **＋** in the header (prompt, directory, group, model) |
| Groups | **☰** → Groups |
| Terminal | **☰** → Terminal (needs `--term`) |
| Refresh | automatic; **⟳** forces it |

Status dots: `●` working · `◆` your turn · `✗` error · `⚠` stalled (run was cut
off) · `⏸` aborted.

### Session actions

Every row's `⋯` opens the same set the inbox list has on its keys:

| Action | Notes |
|---|---|
| Open | |
| Rename | A running agent applies it on its next turn |
| Change model | `enabledModels` from `settings.json`, then a thinking level |
| Clone | A working agent is cut *before* its active prompt |
| Move to group | includes "New group…" |
| Pin / unpin | |
| Mark read / unread | |
| Archive / unarchive | |
| Hide / unhide | manual filing; shows under **Hidden** |
| Cancel run | |

Desktop-only: **takeover**, **peek**, and **moving a session's directory**.
Takeover hands a live session to a terminal window, which a phone has no
equivalent of; the other two are file-relocation actions that want a
filesystem picker.

## Managing the daemon

```sh
./scripts/orch-web-install.sh --status
./scripts/orch-web-install.sh --remove
launchctl kickstart -k gui/$(id -u)/dev.pi.orch-web    # restart
tail -f ~/.pi/agent/orch-web.log
```

Or skip launchd and run it in the foreground: `./scripts/orch-web.sh`.

Config: `ORCH_WEB_HOST` (default: first LAN IPv4), `ORCH_WEB_PORT` (default
`8787`), `ORCH_WEB_TOKEN`, `ORCH_WEB_HOSTS`.

## Terminal (opt-in)

A real PTY on the Mac, in the browser, from `☰` → **Terminal**. Sized for a
phone: a key bar for `esc`/`tab`/`ctrl`/arrows, attach-don't-duplicate, and a
resume buffer so a reconnect (or a phone that slept) replays what it missed.

```sh
./scripts/orch-web-install.sh --term     # install node-pty + enable, then restart
./scripts/orch-web-install.sh --no-term  # turn it off again
```

`--term` does two things and `--no-term` undoes the second:

1. `npm install node-pty` into `~/.pi/agent/orch-web-deps`. It cannot live in
   this checkout — `node_modules` here is symlinks into the pi install, and a
   plain `npm install` would replace them. The prebuilt binaries also ship
   without the execute bit; `--term` fixes that, because node-pty spawns its
   helper through `posix_spawnp` and fails on every open otherwise.
2. `ORCH_WEB_ALLOW_TERM=1` in `~/.pi/agent/orch-web.env`.

The flag is the whole security story: the bearer token already spawns pi runs,
but a PTY makes "the token is a shell on the Mac" literal, so it is **off unless
you ask for it**. What is enforced either way:

| | |
|---|---|
| One shell | a second open attaches to the live one; `⟳` is the explicit restart |
| Idle reap | killed 10 min after the last viewer detaches; 8 h hard cap |
| Scrollback | 512 KB ring, bounded, replayed by sequence number |
| Audit | every open/attach/close is a `[orch-web]` log line with the remote address |
| Gate | same bearer token and `Host` check as every other route; `/vendor/` is a fixed file list |

`ORCH_WEB_TERM_CMD` pins the shell to one command (default: `$SHELL -l`) — useful
for a terminal that only ever does one thing. `ORCH_WEB_TERM_CWD` sets its
working directory.

Two honest limits: **`sudo` still prompts** (it wants a terminal on the console,
not a pty over the network — use `sudo -S` with a password if you must), and a
phone keyboard has no `Ctrl`-anything without the key bar.

## MCP tools work

An MCP server that authenticates with a bearer token works from a phone-spawned
agent, with nothing extra to do: the adapter reads the token at request time, so
rotation is someone else's problem.

Two caveats:

- **Interactive auth won't work.** A server that needs a browser prompt (an OAuth
  flow, an SSO dialog) cannot show it to a detached child, so that tool fails
  from the phone while it works in your terminal.
- **Check the token is readable after a fresh boot.** If your setup keeps
  credentials in a volatile location, the first send after a reboot may fail
  with an auth error until you refresh them. `~/.pi/agent/orch-web.log` says so.

## Troubleshooting

**"Sent" but nothing happens.** The message was accepted; the child pi died.
The log now says why:

```sh
grep -a 'orch-web\]' ~/.pi/agent/orch-web.log | tail -5
```

- `event: "send"` with `recordState: "working"` and a `pid` → it is running.
- `event: "agent-finished"` with `state: "error"` → the error names the cause.
  Auth errors mean re-run `--capture-env` with the right variables.

**Phone can't reach it.** Check, in order: same wifi (not guest, not VPN), the
macOS firewall prompt was allowed, and `--pair` didn't warn that nothing is
listening. The `.local` hostname usually works when the IP changed.

**Forgot the token / new phone.** `./scripts/orch-web.sh --pair`. To revoke every
paired phone: rewrite or delete `~/.pi/agent/orch-web-token`, restart the daemon.

**Empty "working" box.** Fixed — a run owned by another process is now read from
its event file. If you see it, the daemon is running old code: restart it.

**Terminal says "off" or "node-pty is not installed".** `--term` was never run,
or the daemon has not restarted since. Check with:

```sh
grep -a 'term-ready' ~/.pi/agent/orch-web.log | tail -1
```

`{"allowed":true,"ready":true}` is what you want. `ready:false` names the load
error; the usual cause is a `node-pty` install without the execute bit on
`spawn-helper`, which `--term` fixes.

**Terminal types nothing.** Half-typed keystrokes are batched for ~30 ms, so a
dead stream looks the same as a slow one: check the SSE line in the log
(`term-attach`) and reload the page. A shell reaped for idleness says so on the
client and offers a new one.

## Files

```
extensions/orch-web/
  cli.ts                        entry: token, --pair, bind address
  server.ts                     HTTP + SSE, row/transcript model, actions
  terminal.ts                   PTY host: ring buffer, resume, reap (opt-in)
  public/index.html             the whole client (no build, no framework)
  public/terminal.html          the terminal client (xterm.js, still no build)
  public/vendor/                vendored xterm.js / addon-fit.js / xterm.css
  server.test.ts                tests: tail parsing, live items, hide, models
  terminal.test.ts              tests: ring, resume, replace, reap, off-by-default
lib/session-clone.ts            clone a session file (shared with the inbox)
scripts/orch-web.sh             launcher (resolves pi's node_modules)
scripts/orch-web-install.sh     launchd install / --capture-env / --term
```

Runtime state, all under `~/.pi/agent/`:

| File | What |
|---|---|
| `orch-web-token` | bearer token (0600); the phone's credential |
| `orch-web-pair.json` | current pairing code, single use |
| `orch-web.env` | captured child environment (0600) |
| `orch-web.log` | daemon log |

## Rules it has to respect

1. **One writer per session.** A live TUI turn and a background run must never
   append to one JSONL at once. Prompts go through `sendToAgent`/`spawnAgent`,
   which queue while a run is in flight; `working` is reported from
   `inbox-live/` rather than raced.
2. **Prompts go on stdin**, never argv — a prompt starting with `@` is otherwise
   expanded as a file mention and the child dies before it runs.
3. **Header-only scans.** `SessionManager.listAll()` full-parses every session;
   ~200 files makes that over a second per refresh. Only first lines are read,
   with bounded caches keyed on mtime+size.
4. **The token is a shell on the Mac.** Bind to the LAN address only, reject
   unknown `Host` headers, and require the bearer token on every `/api/` route.
5. **A PTY has to be asked for.** `ORCH_WEB_ALLOW_TERM=1` or no terminal; it is
   never a default, and it never weakens 1–4. One shell at a time, reaped when
   detached, everything audited.
