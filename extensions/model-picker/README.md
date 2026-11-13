# model-picker

Replaces the model selector's numeric behavior: **digits select, arrows
navigate, `ctrl+n` toggles digits into search text.**

`ctrl+l` and `/models` open it. `/model` still opens pi's stock selector.

## Keys

| Key | Action |
|---|---|
| `1`–`9` | Select the row with that number |
| `↑` `↓` | Move one row (wraps) |
| `←` `→`, `PgUp` `PgDn` | Previous / next page |
| `enter` | Choose the highlighted model |
| `tab` | Toggle `scoped` ⇄ `all` (same as the built-in selector) |
| `ctrl+n` | Toggle digits between **select** and **search text** |
| `esc`, `ctrl+c` | Cancel |

A page holds at most 9 rows so every row keeps a single-digit shortcut. The
row count in the footer tells you the size of the current scope.

## Why digits-as-select is the default

The intended use is a handful of models from `enabledModels` in
`~/.pi/agent/settings.json`, so `1`–`9` cover the whole list and search is
rarely needed. `ctrl+n` restores typing into the filter for the larger `all`
scope, or to search a version like `4.1` (which contains a dot and would
otherwise be untypeable).

## Why this patches a prototype

`app.model.select` is listed in pi's `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`,
so `pi.registerShortcut("ctrl+l", …)` is dropped with a conflict diagnostic and
never dispatches. There is also no keybinding id for "select row N", so the
built-in selector's digit-as-search behavior cannot be changed from
`keybindings.json` either.

So this extension wraps `CustomEditor.prototype.handleInput` — the same
approach `tool-output-hide` uses — and diverts exactly one key for editors that
interactive mode wired up (identifiable by carrying the built-in
`app.model.select` action handler). Everything else falls through to the
original implementation, and pickers that happen to reuse `ctrl+l` are
untouched. The behavior is pinned by a test against a real `CustomEditor`.

## Caveats

- Switching models goes through `pi.setModel()`, so it is recorded in the
  session transcript like any other model change. A failure (no API key)
  reports inline and leaves the picker open.
- Choosing the model that is already active closes the picker without an
  event.
- `maxTokens`-style per-model settings still come from `models.json`
  `modelOverrides` / `extra-models.json`; this extension only selects, it does
  not configure.

## Tests

```sh
node --experimental-strip-types --test extensions/model-picker/picker.test.ts
```
