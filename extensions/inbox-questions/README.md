# inbox-questions

A separate, ephemeral question list for pi, plus an `❓ N awaiting answer` footer
count. Built for the jira-autopilot job, which needs to ask design questions
without putting them into the inbox tabs.

## Why not a tab

The inbox extension's tabs are a closed union
(`View = "inbox" | "archived" | "all" | "filtered"`) wired through its counts,
cycling, key bindings, and render. There is no plugin hook to add a fifth one, so
this extension does not add a tab. It uses public APIs (`ctx.ui.setStatus`,
`ctx.ui.custom`, `ctx.ui.input`, `ctx.ui.select`) plus one small exported hook the
inbox now provides for addons (`registerInboxHeaderProvider`, see below).

## Use

| Action | Key |
|---|---|
| Open the list | `/questions` or `ctrl+shift+q` |
| Open the list from the inbox | `q` (when questions are open) |
| Move | `↑` `↓` / `j` `k` |
| Answer with free text | `a` |
| Pick an option (menu) | `o` |
| Answer with option N | `1`–`9` |
| Close | `esc` or `q` |

Two places surface it:

- **Inbox header**, next to `agents: …` — `❓ 1 question · q`. Press `q` there to
  jump straight to the list.
- **Footer status** — `❓ 1 awaiting answer · /questions`.

### The `q` key's precedence

In the inbox, `q` previously closed the window (or cleared an active search).
With questions open it now opens the list instead. The order is:

1. `ctrl+c` is never taken (it stays the quit gesture)
2. an active search query still clears first, so `q` behaves as before while searching
3. otherwise, if questions are open, `q` opens the list
4. with no open questions, `q` closes the inbox exactly as before

This is implemented as `addonClaimsQuit()` in the inbox, which asks the
registered header providers. If this addon is not installed, nothing registers
and `q` is untouched.

### Inbox integration

The inbox exposes `registerInboxHeaderProvider({ id, text, onQuitKey })`. A
provider contributes a header segment and can claim `q`. Providers are keyed by
id (re-registering replaces) and every call is wrapped so a broken addon cannot
break the inbox. The inbox has no import of this extension.

## Records

Questions live as JSON under a producer's state directory, and this extension
reads **every** configured source. Records are tagged with the `source` they came
from so an answer is written back to the directory it belongs to — a PR answer
must never land in the Jira directory, where a different runner would read
"approve with nits" as a design decision.

| Source id | Directory | Env override |
|---|---|---|
| `jira` | `~/.local/state/jira-autopilot/questions/` | `JIRA_AUTOPILOT_STATE` |
| `pr` | `~/.local/state/pr-review-autopilot/questions/` | `PR_AUTOPILOT_STATE` |
| any | colon-separated extra dirs | `PI_QUESTIONS_DIRS` |

A source whose directory does not exist simply contributes nothing, so a producer
that is not installed costs nothing.

```json
{
  "key": "TICKET-123",
  "title": "…",
  "asked": "2026-11-23T09:05:59-08:00",
  "decision": "one-sentence question",
  "why": "why it matters",
  "context": "enough to decide",
  "options": [{ "id": "A", "text": "…", "tradeoff": "…" }],
  "recommendation": "B, because …",
  "state": "open",
  "source": "jira"
}
```

Answering sets `state: "answered"`, the `answer` text and `answeredAt`. The runner
picks that up on its next tick.

## Ephemeral

Answered questions leave the open count immediately and stay visible for a
retention window so you can see what you just decided, then the record is deleted:

- `JIRA_AUTOPILOT_QUESTION_RETENTION_MS`, default `3600000` (1 hour)
- expiry is enforced on read, so it works even if nothing else is running

## Tests

```bash
node --experimental-transform-types --test extensions/inbox-questions/questions.test.ts
```

```bash
node --experimental-transform-types --test extensions/inbox-questions/*.test.ts
```

21 tests across three files:

- `questions.test.ts` — storage: empty/missing dir, sort order, retention expiry,
  corrupt-record tolerance, wrapping, and the two answer-write invariants.
- `header-provider.test.ts` — registration, replace-by-id, no-segment when null,
  throw containment.
- `quit-claim.test.ts` — the `q` precedence rules (ctrl+c, search, no-addon,
  declining and throwing providers).

The load-bearing ones are ablation-verified: writing an answer without flipping
`state` reddens the two answer tests, and dropping the search-query guard reddens
the `q` precedence test.
