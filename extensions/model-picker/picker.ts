/**
 * The model picker component. Kept separate from index.ts so tests can
 * construct it without installing the editor patch or registering commands.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

/** Digits 1..9 map to rows, so a page never exceeds a single-digit count. */
const MAX_PAGE = 9;

/** Used when neither the caller nor the session says which effort to start on. */
const DEFAULT_EFFORT: ThinkingLevel = "medium";

export interface Entry {
	model: Model<any>;
	provider: string;
	id: string;
	name: string;
	/** Effort pinned in `enabledModels` (`provider/model:high`), if any. */
	pinnedEffort?: ThinkingLevel;
}

/**
 * The scoped and all lists, in a STABLE order that never depends on which
 * model is selected: `scoped` keeps `enabledModels` order (it is also the
 * ctrl+p cycle order), `all` is provider then id. The current model is marked
 * with a ✓ and starts highlighted, but it is not moved to the top — a list
 * whose rows shuffle every time you pick one makes digits unpickable.
 */
export function entriesFor(ctx: ExtensionContext): {
	scoped: Entry[];
	all: Entry[];
} {
	const toEntry = (model: Model<any>): Entry => ({
		model,
		provider: model.provider,
		id: model.id,
		name: model.name,
	});
	const scoped = (ctx.scopedModels ?? []).map((s) => ({
		...toEntry(s.model),
		// `enabledModels` may pin an effort per model; keeping it lets the picker
		// start on the level that model normally runs at.
		pinnedEffort: s.thinkingLevel as ThinkingLevel | undefined,
	}));
	const all = ctx.modelRegistry.getAvailable()
		.map(toEntry)
		.sort((a, b) => {
			const byProvider = a.provider.localeCompare(b.provider);
			return byProvider !== 0 ? byProvider : a.id.localeCompare(b.id);
		});
	return { scoped, all };
}

export interface ModelPickerOptions {
	/** Resolve with the current model instead of `undefined` when picked. */
	allowCurrent?: boolean;
	/** `ctrl+s`: save the choice as the startup default, then resolve. */
	onPersist?: (model: Model<any>, effort: ThinkingLevel) => void;
	/** Prefill the filter, e.g. from `/model <search>`. */
	initialQuery?: string;
	/** Effort to start on; clamped per model as the cursor moves. */
	effort?: ThinkingLevel;
}

export interface OpenModelPickerOptions extends ModelPickerOptions {
	/** Highlight and compare against this model instead of `ctx.model`. */
	current?: Model<any>;
	/**
	 * Apply the choice and its effort. Resolving false keeps the picker open.
	 * The effort is always supplied and already clamped to the model, so a
	 * caller that changes model and effort together does not re-derive it.
	 */
	commit: (model: Model<any>, effort: ThinkingLevel) => Promise<boolean>;
}

/** Same provider and id, ignoring any per-model extras. */
function sameModel(a: Model<any> | undefined, b: Model<any> | undefined) {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

/**
 * Open the digit-select picker. Shared by `ctrl+l` / `/models`, the inbox's
 * new-agent flows and the visit view, so every model selector in this kit
 * behaves the same instead of falling back to pi's stock component.
 */
export function openModelPicker(
	ctx: ExtensionContext,
	options: OpenModelPickerOptions,
): Promise<Model<any> | undefined> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("The model picker needs the interactive UI.", "warning");
		return Promise.resolve(undefined);
	}
	const { scoped, all } = entriesFor(ctx);
	const current = options.current ?? ctx.model;
	// Precedence: an explicit level, then one pinned for this model in
	// `enabledModels`, then whatever this session is already running.
	const pinned = scoped.find((entry) => sameModel(entry.model, current))
		?.pinnedEffort;
	return ctx.ui.custom<Model<any> | undefined>(
		(tui, theme, keybindings, done) =>
			new ModelPicker(
				tui,
				theme,
				keybindings,
				done,
				scoped,
				all,
				current,
				options.commit,
				{
					...options,
					effort: options.effort ?? pinned ?? ctx.thinkingLevel,
				},
			),
		{ overlay: true },
	);
}

export class ModelPicker implements Focusable {
	private _focused = false;
	private entries: Entry[] = [];
	private filtered: Entry[] = [];
	private selected = 0;
	private digitsAsText = false;
	private query = "";
	private scope: "scoped" | "all";
	private error?: string;
	private busy = false;
	private disposed = false;
	/**
	 * The effort that will be applied with the chosen model. Clamped per row as
	 * the cursor moves, so a model that cannot reason shows `off` rather than a
	 * level that would silently degrade on commit.
	 */
	private effort: ThinkingLevel = DEFAULT_EFFORT;

	get focused() {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly kb: KeybindingsManager;
	private readonly done: (result: Model<any> | undefined) => void;
	private readonly scopedEntries: Entry[];
	private readonly allEntries: Entry[];
	private readonly current: Model<any> | undefined;
	private readonly commit: (
		model: Model<any>,
		effort: ThinkingLevel,
	) => Promise<boolean>;
	private readonly allowCurrent: boolean;
	private readonly onPersist?: (
		model: Model<any>,
		effort: ThinkingLevel,
	) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		kb: KeybindingsManager,
		done: (result: Model<any> | undefined) => void,
		scopedEntries: Entry[],
		allEntries: Entry[],
		current: Model<any> | undefined,
		commit: (model: Model<any>, effort: ThinkingLevel) => Promise<boolean>,
		options: ModelPickerOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.kb = kb;
		this.done = done;
		this.scopedEntries = scopedEntries;
		this.allEntries = allEntries;
		this.current = current;
		this.commit = commit;
		this.allowCurrent = options.allowCurrent ?? false;
		this.onPersist = options.onPersist;
		this.scope = scopedEntries.length > 0 ? "scoped" : "all";
		this.entries = this.scope === "scoped" ? scopedEntries : allEntries;
		this.filtered = this.entries;
		const index = this.filtered.findIndex((entry) => this.isCurrent(entry));
		this.selected = index >= 0 ? index : 0;
		if (options.initialQuery) {
			// Prefilled search (e.g. `/model 4.1`) means the user intended to type,
			// so digits filter rather than select.
			this.query = options.initialQuery;
			this.digitsAsText = true;
			this.applyFilter();
			this.selected = 0;
		}
		this.effort = options.effort ?? DEFAULT_EFFORT;
	}

	dispose(): void {
		this.disposed = true;
	}

	invalidate(): void {
		// Stateless render; nothing cached.
	}

	private isCurrent(entry: Entry): boolean {
		return this.current?.provider === entry.provider &&
			this.current?.id === entry.id;
	}

	/** Levels the highlighted model supports (just `off` if it cannot reason). */
	private levelsFor(entry: Entry | undefined): ThinkingLevel[] {
		return entry ? getSupportedThinkingLevels(entry.model) : [DEFAULT_EFFORT];
	}

	/**
	 * `level` brought into the range the row supports. This is a *display and
	 * commit* clamp, not a stored one: the desired level is remembered, so
	 * stepping through a weaker model on the way back to a capable one does not
	 * quietly cost you `max`.
	 */
	private effortFor(
		entry: Entry | undefined,
		level: ThinkingLevel = this.effort,
	): ThinkingLevel {
		return entry
			? clampThinkingLevel(entry.model, level as ModelThinkingLevel)
			: level;
	}

	/**
	 * Step one supported level for the highlighted row, wrapping at both ends so
	 * `shift+tab` alone can reach every level. Uses the row's clamped level, so a
	 * model with gaps in its map still advances to the next level it can do.
	 */
	private cycleEffort(): void {
		const row = this.filtered[this.selected];
		const levels = this.levelsFor(row);
		if (levels.length <= 1) return;
		const index = levels.indexOf(this.effortFor(row));
		const from = index >= 0 ? index : 0;
		const next = levels[(from + 1) % levels.length];
		if (next !== undefined) this.effort = next;
	}

	private metrics() {
		const rows = Math.max(1, this.tui.terminal?.rows ?? 30);
		const compact = rows < 18;
		// title + filter + digits hint + effort + page footer + help lines
		const fixed = compact ? 5 : 7;
		const pageSize = Math.max(1, Math.min(MAX_PAGE, rows - fixed));
		return { rows, compact, pageSize };
	}

	private applyFilter(): void {
		const q = this.query.trim().toLowerCase();
		this.filtered = !q
			? this.entries
			: this.entries.filter((entry) =>
				`${entry.provider}/${entry.id} ${entry.name}`
					.toLowerCase()
					.includes(q));
		this.selected = Math.max(0,
			Math.min(this.selected, this.filtered.length - 1));
	}

	private setScope(scope: "scoped" | "all"): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.entries = scope === "scoped" ? this.scopedEntries : this.allEntries;
		this.selected = 0;
		this.applyFilter();
		// Keep the cursor on the active model when the other scope has it.
		const index = this.filtered.findIndex((entry) => this.isCurrent(entry));
		if (index >= 0) this.selected = index;
	}

	private async choose(
		entry: Entry | undefined,
		persist = false,
	): Promise<void> {
		if (!entry || this.busy) return;
		// Choosing the active model is a no-op unless the caller wants it back
		// (a new-agent draft may legitimately run the window's current model).
		if (!this.allowCurrent && !persist && this.isCurrent(entry)) {
			this.done(undefined);
			return;
		}
		this.busy = true;
		this.error = undefined;
		this.tui.requestRender();
		const effort = this.effortFor(entry);
		try {
			const ok = await this.commit(entry.model, effort);
			if (this.disposed) return;
			if (!ok) {
				this.error = `No API key for ${entry.provider}/${entry.id}`;
				return;
			}
			if (persist) this.onPersist?.(entry.model, effort);
			this.done(entry.model);
		} catch (error) {
			if (!this.disposed) {
				this.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			this.busy = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	handleInput(data: string): void {
		// Scoped listeners run before pi filters key releases; ignore them so a
		// held digit key cannot select twice.
		if (this.disposed || isKeyRelease(data)) return;
		if (this.busy) return;

		const { pageSize } = this.metrics();
		const page = Math.floor(this.selected / pageSize);
		const onPage = this.filtered.slice(page * pageSize, (page + 1) * pageSize);

		// Resolve printable input once; digits are shortcuts unless toggled off.
		const ch = data.length === 1 && data.charCodeAt(0) >= 32
			? data
			: undefined;
		const digit = ch && /^[1-9]$/.test(ch) ? ch : undefined;

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "ctrl+n")) {
			this.digitsAsText = !this.digitsAsText;
			this.tui.requestRender();
			return;
		}
		if (this.kb.matches(data, "tui.input.tab")) {
			if (this.scopedEntries.length > 0) {
				this.setScope(this.scope === "all" ? "scoped" : "all");
				this.tui.requestRender();
			}
			return;
		}
		if (this.kb.matches(data, "tui.select.confirm") ||
			this.kb.matches(data, "tui.input.submit")) {
			void this.choose(this.filtered[this.selected]);
			return;
		}
		if (this.onPersist && (this.kb.matches(data, "app.models.save") ||
			matchesKey(data, "ctrl+s"))) {
			void this.choose(this.filtered[this.selected], true);
			return;
		}
		// Effort is part of the same choice, so it is set here rather than in a
		// second dialog. Shift+Tab (`app.thinking.cycle`) is the only effort key
		// and it wraps, so every supported level is reachable without inventing a
		// reverse binding that no pi keybinding id backs.
		if (this.kb.matches(data, "app.thinking.cycle") ||
			matchesKey(data, "shift+tab")) {
			if (isKeyRepeat(data)) return;
			this.cycleEffort();
			this.tui.requestRender();
			return;
		}
		if (this.kb.matches(data, "tui.select.up") ||
			matchesKey(data, "up")) {
			if (isKeyRepeat(data)) return;
			this.selected = this.selected === 0
				? Math.max(0, this.filtered.length - 1)
				: this.selected - 1;
			this.tui.requestRender();
			return;
		}
		if (this.kb.matches(data, "tui.select.down") ||
			matchesKey(data, "down")) {
			if (isKeyRepeat(data)) return;
			this.selected = this.selected >= this.filtered.length - 1
				? 0
				: this.selected + 1;
			this.tui.requestRender();
			return;
		}
		// Left/right page, matching the group selector.
		if (matchesKey(data, "left") ||
			this.kb.matches(data, "tui.select.pageUp")) {
			this.selected = Math.max(0, this.selected - pageSize);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right") ||
			this.kb.matches(data, "tui.select.pageDown")) {
			this.selected = Math.min(this.filtered.length - 1,
				this.selected + pageSize);
			this.tui.requestRender();
			return;
		}
		if (digit && !this.digitsAsText) {
			const entry = onPage[Number(digit) - 1];
			if (entry) void this.choose(entry);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.selected = 0;
			this.applyFilter();
			this.tui.requestRender();
			return;
		}
		if (ch) {
			// Digits reach here only after ctrl+n, so typing "4.1" works.
			this.query += ch;
			this.selected = 0;
			this.applyFilter();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const { pageSize, compact } = this.metrics();
		this.selected = Math.max(0,
			Math.min(this.selected, Math.max(0, this.filtered.length - 1)));
		const page = Math.floor(this.selected / pageSize);
		const shown = this.filtered.slice(page * pageSize, (page + 1) * pageSize);
		const pages = Math.max(1, Math.ceil(this.filtered.length / pageSize));

		const scopeTag = this.scopedEntries.length > 0
			? th.fg("muted", ` [${this.scope === "scoped"
				? `${this.scopedEntries.length} scoped`
				: `${this.allEntries.length} all`}]`)
			: th.fg("muted", ` [${this.allEntries.length} available]`);
		const lines = [th.fg("accent", th.bold(`Select model${scopeTag}`))];

		const filterLine = this.query
			? th.fg("muted", `  filter: ${this.query}`)
			: this.digitsAsText
				? th.fg("dim", "  filter: (type to search)")
				: "";
		lines.push(filterLine);
		lines.push(th.fg("dim", this.digitsAsText
			? "  Digits: text · Ctrl+N for shortcuts"
			: "  Digits: select 1–9 · Ctrl+N for search"));

		// Show the effort the highlighted row would take, so a model with a
		// narrow level map advertises that before it is chosen.
		const highlighted = this.filtered[this.selected];
		const levels = this.levelsFor(highlighted);
		const effort = this.effortFor(highlighted);
		const effortHint = levels.length > 1
			? "  ·  Shift+Tab cycle"
			: "  ·  no reasoning";
		lines.push(th.fg("muted", "  Effort: ") +
			th.fg(levels.length > 1 ? "accent" : "dim", effort) +
			th.fg("dim", effortHint));

		for (let i = 0; i < pageSize; i++) {
			const entry = shown[i];
			if (!entry) {
				lines.push(!this.filtered.length && i === 0
					? th.fg("muted", "  No matching models")
					: "");
				continue;
			}
			const index = page * pageSize + i;
			const isSelected = index === this.selected;
			const marker = this.isCurrent(entry) ? "✓" : " ";
			const row = ` ${isSelected ? "▶" : " "} ${i + 1} ${marker} ` +
				`${entry.id} ${th.fg("muted", `[${entry.provider}]`)}`;
			lines.push(isSelected ? th.fg("accent", row) : row);
		}

		lines.push(th.fg("muted", `  Page ${page + 1}/${pages}` +
			`  ·  ${this.filtered.length} model` +
			`${this.filtered.length === 1 ? "" : "s"}`));

		if (this.error) {
			for (const line of wrapTextWithAnsi(this.error, Math.max(1, width - 2))) {
				lines.push(th.fg("error", `  ${line}`));
			}
		} else if (this.busy) {
			lines.push(th.fg("dim", "  Switching…"));
		} else if (!compact) {
			lines.push(th.fg("dim",
				"  ↑↓ ←→ PgUp PgDn navigate · Enter choose · Esc cancel"));
			lines.push(th.fg("dim",
				`  Tab scope · Shift+Tab effort` +
				(this.onPersist ? " · Ctrl+S set as default" : "") +
				" · Ctrl+N digits select/search"));
		}

		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}
