import {
	getSelectListTheme, type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	Editor,
	Input,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import type { GroupScope, InboxGroup } from "./groups.ts";

export type GroupSelection =
	| { action: "select"; scope: GroupScope }
	| { action: "create" }
	| { action: "rename" | "delete"; id: string }
	| undefined;

export interface TemplateActions {
	toggle(id: string): Promise<InboxGroup>;
	save(id: string, text: string): Promise<InboxGroup>;
}

interface Choice {
	scope: GroupScope;
	name: string;
	group?: InboxGroup;
}

export function isGroupShortcut(data: string) {
	const keys = [
		"ctrl+a", "ctrl+r", "ctrl+t", "ctrl+d", "ctrl+n", "ctrl+e", "ctrl+s",
	] as const;
	return keys.some((key) => matchesKey(data, key));
}

/** Search, selection and template management share one overlay. */
export class GroupSelector implements Focusable {
	private input: Input;
	private choices: Choice[];
	private selected = 0;
	private digitsAsText = false;
	private editor?: Editor;
	private editingId?: string;
	private busy = false;
	private error?: string;
	private disposed = false;
	private _focused = false;
	onDispose?: () => void;

	get focused() { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}

	constructor(
		private tui: TUI,
		private theme: Theme,
		private kb: KeybindingsManager,
		private done: (result: GroupSelection) => void,
		groups: InboxGroup[],
		private mode: "view" | "assign",
		private templates: TemplateActions,
		initial: GroupScope = "ungrouped",
	) {
		this.input = new Input({ prompt: theme.fg("accent", "Prefix: ") });
		this.choices = [
			...(mode === "view" ? [{ scope: "all", name: "All groups" }] : []),
			{ scope: "ungrouped", name: "Ungrouped" },
			...groups.slice().sort((a, b) => a.name.localeCompare(b.name))
				.map((group) => ({ scope: group.id, name: group.name, group })),
		];
		this.selected = Math.max(0,
			this.choices.findIndex((choice) => choice.scope === initial));
	}

	dispose() {
		this.disposed = true;
		const release = this.onDispose;
		this.onDispose = undefined;
		release?.();
	}

	invalidate() {
		this.input.invalidate();
		this.editor?.invalidate();
	}

	private syncFocus() {
		this.input.focused = this._focused && !this.editor;
		if (this.editor) this.editor.focused = this._focused;
	}

	private matches() {
		const prefix = this.input.getValue().toLowerCase();
		return this.choices.filter((choice) =>
			choice.name.toLowerCase().startsWith(prefix));
	}

	private metrics() {
		const rows = Math.max(1, this.tui.terminal?.rows ?? 30);
		const compact = rows < 18;
		const fixed = compact ? 6 : 9;
		const editorHeight = Math.max(5, Math.floor(rows * 0.3)) + 2;
		const pageSize = Math.max(1, Math.min(9, rows - fixed - editorHeight));
		const bodyHeight = Math.max(1, rows - fixed - pageSize);
		return { rows, compact, pageSize, bodyHeight };
	}

	private highlightedGroup() {
		return this.matches()[this.selected]?.group;
	}

	private editingGroup() {
		return this.choices.find((choice) =>
			choice.scope === this.editingId)?.group;
	}

	private async changeTemplate(update: () => Promise<InboxGroup>) {
		this.busy = true;
		this.error = undefined;
		this.tui.requestRender();
		try {
			const updated = await update();
			if (this.disposed) return false;
			const choice = this.choices.find((item) => item.scope === updated.id);
			if (choice) {
				choice.group = updated;
				choice.name = updated.name;
			}
			return true;
		} catch (error) {
			if (!this.disposed) this.error = String(error);
			return false;
		} finally {
			this.busy = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private startEditing(group: InboxGroup) {
		this.error = undefined;
		this.editingId = group.id;
		this.editor = new Editor(this.tui, {
			borderColor: (text) => this.theme.fg("borderAccent", text),
			selectList: getSelectListTheme(),
		}, { paddingX: 1 });
		// Handle saving ourselves so trailing spaces/newlines and failed-save
		// drafts aren't lost to Editor's normal submit-and-clear behavior.
		this.editor.disableSubmit = true;
		this.editor.setText(group.template);
		this.syncFocus();
	}

	private stopEditing() {
		this.editor = undefined;
		this.editingId = undefined;
		this.error = undefined;
		this.syncFocus();
	}

	private async saveEditor() {
		const id = this.editingId;
		const text = this.editor?.getExpandedText();
		if (!id || text === undefined) return;
		if (await this.changeTemplate(() => this.templates.save(id, text))) {
			this.stopEditing();
			this.tui.requestRender();
		}
	}

	handleInput(data: string) {
		// The scoped listener runs before Pi filters release events.
		if (this.disposed || isKeyRelease(data)) return;
		const submit = this.kb.matches(data, "tui.input.submit") ||
			(!this.editor && (matchesKey(data, "enter") ||
				this.kb.matches(data, "tui.select.confirm")));
		const oneShot = !this.editor || matchesKey(data, "ctrl+t") ||
			matchesKey(data, "ctrl+s") || submit;
		if (oneShot && isKeyRepeat(data) &&
			(isGroupShortcut(data) || submit)) return;
		if (this.busy) return;
		if (this.editor) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.stopEditing();
			} else if (matchesKey(data, "ctrl+s") ||
				this.kb.matches(data, "tui.input.submit")) {
				void this.saveEditor();
			} else if (matchesKey(data, "ctrl+t") && this.editingId) {
				const id = this.editingId;
				void this.changeTemplate(() => this.templates.toggle(id));
			} else this.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}
		const matches = this.matches();
		const ch = decodeKittyPrintable(data) ??
			(data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		const size = this.metrics().pageSize;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			return this.done(undefined);
		}
		if (matchesKey(data, "ctrl+n")) {
			this.digitsAsText = !this.digitsAsText;
		} else if (matchesKey(data, "ctrl+t")) {
			const group = this.highlightedGroup();
			if (group) void this.changeTemplate(() =>
				this.templates.toggle(group.id));
		} else if (matchesKey(data, "ctrl+e")) {
			const group = this.highlightedGroup();
			if (group) this.startEditing(group);
		} else if (matchesKey(data, "ctrl+a")) {
			return this.done({ action: "create" });
		} else if (matchesKey(data, "ctrl+r") || matchesKey(data, "ctrl+d")) {
			const group = this.highlightedGroup();
			if (group) return this.done({
				action: matchesKey(data, "ctrl+r") ? "rename" : "delete",
				id: group.id,
			});
		} else if (matchesKey(data, "enter") ||
			this.kb.matches(data, "tui.select.confirm") ||
			this.kb.matches(data, "tui.input.submit")) {
			const choice = matches[this.selected];
			if (choice) return this.done({ action: "select", scope: choice.scope });
		} else if (this.kb.matches(data, "tui.select.up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (this.kb.matches(data, "tui.select.down")) {
			this.selected = Math.min(matches.length - 1, this.selected + 1);
		} else if (this.kb.matches(data, "tui.select.pageUp")) {
			this.selected = Math.max(0, this.selected - size);
		} else if (this.kb.matches(data, "tui.select.pageDown")) {
			this.selected = Math.min(matches.length - 1, this.selected + size);
		} else if (!this.digitsAsText && ch && /^[1-9]$/.test(ch)) {
			const page = Math.floor(this.selected / size);
			const choice = matches[page * size + Number(ch) - 1];
			if (choice) return this.done({ action: "select", scope: choice.scope });
		} else {
			// Pasted numbers are search text, never shortcuts.
			const previous = this.input.getValue();
			this.input.handleInput(data);
			if (previous !== this.input.getValue()) this.selected = 0;
		}
		this.selected = Math.max(0,
			Math.min(this.selected, this.matches().length - 1));
		this.tui.requestRender();
	}

	private templateLines(width: number, height: number) {
		if (this.editor) {
			const lines = this.editor.render(width);
			// On tiny terminals clip around the public cursor marker, not the
			// end of the text, so the active edit cursor always stays visible.
			const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
			const start = Math.max(0, Math.min(
				Math.max(0, cursor) - Math.floor(height / 2), lines.length - height,
			));
			return lines.slice(start, start + height);
		}
		const group = this.highlightedGroup();
		if (!group) return [this.theme.fg("dim",
			"Highlight a named group to manage its template.")];
		if (!group.template) return [this.theme.fg("dim", "(empty template)")];
		const text = group.template.slice(0, 2000);
		return wrapTextWithAnsi(text, Math.max(1, width)).slice(0, height);
	}

	render(width: number): string[] {
		const th = this.theme;
		const { rows, compact, pageSize: size, bodyHeight } = this.metrics();
		if (rows < 8) {
			return (this.editor ? this.templateLines(width, rows)
				: this.input.render(width)).map((line) =>
				truncateToWidth(line, width));
		}
		const matches = this.matches();
		this.selected = Math.max(0, Math.min(this.selected, matches.length - 1));
		const page = Math.floor(this.selected / size);
		const shown = matches.slice(page * size, (page + 1) * size);
		const lines = [
			th.bold(th.fg("accent", this.mode === "view"
				? "Inbox group view" : "Group for this session / new agent")),
			...this.input.render(Math.max(1, width)),
			th.fg("dim", this.digitsAsText
				? "Digits: text · Ctrl+N switches to shortcuts"
				: "Digits: select 1–9 · Ctrl+N switches to text"),
		];
		for (let i = 0; i < size; i++) {
			const choice = shown[i];
			if (!choice) {
				lines.push(!matches.length && i === 0
					? th.fg("dim", "No matching groups") : "");
				continue;
			}
			const selected = page * size + i === this.selected;
			const hint = choice.group?.templateEnabled ? " · template on" : "";
			const row = `${selected ? "▶" : " "} ${i + 1} ${choice.name}${hint}`;
			lines.push(selected ? th.fg("accent", row) : row);
		}
		lines.push(th.fg("dim",
			`Page ${page + 1}/${Math.max(1, Math.ceil(matches.length / size))}`));
		if (!compact) lines.push("");
		const group = this.editor ? this.editingGroup() : this.highlightedGroup();
		const state = group?.templateEnabled ? "enabled" : "disabled";
		lines.push(th.bold(th.fg("accent", group
			? `Template · ${group.name} · ${state}` : "Template")));
		const body = this.templateLines(width, bodyHeight);
		lines.push(...body);
		for (let i = body.length; i < bodyHeight; i++) lines.push("");
		const status = this.busy ? "Saving…" : this.error;
		const help = this.editor
			? "Ctrl+S / submit save · Esc cancel edit · Ctrl+T toggle"
			: "Ctrl+T toggle template · Ctrl+E edit template";
		lines.push(status ? th.fg(this.error ? "error" : "dim", status)
			: th.fg("dim", help));
		if (!compact) {
			lines.push(th.fg("dim", "↑↓ / PgUp PgDn · Enter choose · Esc cancel"));
			lines.push(th.fg("dim",
				"Ctrl+A create · Ctrl+R rename · Ctrl+D delete"));
		}
		return lines.map((line) => truncateToWidth(line, width));
	}
}
