# 📱 orch-web

Drive your pi background agents from your phone, over your local network.

A phone-sized front end for the inbox: see every session, watch a run stream
live, reply, queue, cancel, and start new agents. Not a remote terminal — it
reads the same files the desktop inbox reads, so both stay in sync.

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
| Send | type, press Enter; becomes **Queue** while that session is running |
| See what's queued | the queue strip above the composer: **now** / **✕** per item |
| Start an agent | **＋** in the header |
| Refresh | automatic; **⟳** forces it |

Status dots: `●` working · `◆` your turn · `✗` error · `⚠` stalled (run was cut
off) · `⏸` aborted.

Desktop-only for now: takeover, moving a session's directory, cloning, filter
rules.

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

## Files

```
extensions/orch-web/
  cli.ts                        entry: token, --pair, bind address
  server.ts                     HTTP + SSE, row/transcript model
  public/index.html             the whole client (no build, no framework)
  server.test.ts                tests: tail parsing, live items, change keys
scripts/orch-web.sh             launcher (resolves pi's node_modules)
scripts/orch-web-install.sh     launchd install / --capture-env / --remove
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
