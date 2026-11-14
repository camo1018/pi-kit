# model-picker

Replaces the model selector's numeric behavior: **digits select, arrows
navigate, `ctrl+n` toggles digits into search text.**

`ctrl+l` and `/models` open it. The inbox opens the same component for a pending
reply's model, for `N` (a new agent's model) and while visiting a session, so
every model selector in this kit behaves the same. `/model` still opens pi's
stock selector as an escape hatch.

## Keys

| Key | Action |
|---|---|
| `1`–`9` | Select the row with that number |
| `↑` `↓` | Move one row (wraps) |
| `←` `→`, `PgUp` `PgDn` | Previous / next page |
| `enter` | Choose the highlighted model |
| `tab` | Toggle `scoped` ⇄ `all` (same as the built-in selector) |
| `ctrl+n` | Toggle digits between **select** and **search text** |
| `ctrl+s` | Choose and save as the startup default (model *and* effort, when the caller allows it) |
| `shift+tab` | Cycle the reasoning effort (`app.thinking.cycle`); wraps around |
| `esc`, `ctrl+c` | Cancel |

## Effort travels with the model

The picker sets the thinking level in the same dialog, because choosing a model
in pi otherwise silently re-derives the level from settings. The `Effort:` line
follows the highlighted row: it is clamped to that model's
`getSupportedThinkingLevels()`, so

- a model that cannot reason shows `off · no reasoning` and commits `off`,
  rather than claiming a level it will quietly downgrade;
- a model whose `thinkingLevelMap` does not name `xhigh`/`max` tops out lower
  and the line says so;
- `shift+tab` steps one *supported* level at a time and **wraps** at both ends,
  so this one key reaches every level. There is deliberately no reverse binding:
  pi has no keybinding id for "cycle backwards", so an invented chord would
  collide with terminal shortcuts. Stepping past the top lands on `off`.

The level starts from, in order: an explicit `effort` option, the level pinned
for that model in `enabledModels` (`provider/model:high`), then the level this
session is already running. Whatever is showing when you confirm is what gets
applied — `pi.setModel()` first, then `pi.setThinkingLevel()`, since `setModel`
rewrites the level itself. `ctrl+s` persists both with
`setDefaultModelAndProvider()` and `setDefaultThinkingLevel()`.

## Row order is stable

Rows never move. `scoped` keeps `enabledModels` order (which is also the
`ctrl+p` cycle order) and `all` is provider then id. The current model is
marked `✓` and highlighted when the picker opens, but it is **not** moved to
the top: a list that reshuffles on every pick makes `1`–`9` pick a different
model each time.

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

## Internal dependencies (brittleness matrix)

`compat-check` probes these ids; a failure names the probe and points here.

| Dependency | Probe id | Used for | Breaks if |
| --- | --- | --- | --- |
| `CustomEditor.prototype.handleInput` | `custom-editor-handle-input` | diverting `ctrl+l` to this picker | the method is renamed or removed; `ctrl+l` silently reverts to the stock selector (harmless, just loses digits) |
| `CustomEditor` dispatching app keys via its `actionHandlers` map | `custom-editor-action-handlers` | telling an interactive editor apart from a picker that also handles `ctrl+l` | the shape changes; the divert either never fires or fires on the wrong editor |
| `CustomEditor.prototype.onAction` | `editor-on-action` | interactive mode registering `app.model.select`, which is what the guard looks for | registration moves elsewhere; every editor then looks unwired and the divert never fires |
| `ctx.ui.custom()` / overlay | `custom-ui-overlay` | opening the picker | the API is removed; the picker cannot open |
| `ctx.scopedModels` | `scoped-models-context` | the `scoped` scope, and the effort pinned per model | it stops being an array; the picker cannot tell scoped from all |
| `ctx.modelRegistry.getAvailable()` | `model-registry-available` | the `all` scope | it is removed; only scoped models would be listable |
| `pi.setModel()` | `set-model-api` | applying a choice | it is removed; choosing becomes a no-op |
| `pi.setThinkingLevel()` | `set-thinking-level-api` | applying the effort with the model | it is removed; the effort choice is dropped, the model still switches |
| `getSupportedThinkingLevels()` / `clampThinkingLevel()` | `thinking-levels-api` | the `Effort:` line and its clamping | either is removed; the picker cannot tell which levels a model supports |
| `SettingsManager.prototype.setDefaultModelAndProvider` | `settings-manager-default` | `ctrl+s` saving the startup default | it is renamed or removed; `ctrl+s` stops saving (the pick itself still applies) |
| The extension's own patch | `patch-installed` | confirming hooks actually installed | the extension loads but its patch silently did not run |

The `actionHandlers` shape is also probed for `tool-output-hide` and
`thinking-block-hide`, which wrap the same method, so a change there fails all
three at once rather than one.
