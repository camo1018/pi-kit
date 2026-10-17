import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Input,
	matchesKey,
	truncateToWidth,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import type { GroupScope, InboxGroup } from "./groups.ts";

export type GroupSelection =
	| { action: "select"; scope: GroupScope }
	| { action: "create" }
	| { action: "rename" | "template" | "delete"; id: string }
	| undefined;

interface Choice {
	scope: GroupScope;
	name: string;
	group?: InboxGroup;
}

export function isGroupShortcut(data: string) {
	const keys = ["ctrl+a", "ctrl+r", "ctrl+t", "ctrl+d", "ctrl+n"] as const;
	return keys.some((key) => matchesKey(data, key));
}

/** Numeric shortcuts are scoped to this picker, never the main editor. */
export class GroupSelector implements Focusable {
	private input: Input;
	private choices: Choice[];
	private selected = 0;
	private digitsAsText = false;
	private _focused = false;

	get focused() { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private tui: TUI,
		private theme: Theme,
		private kb: KeybindingsManager,
		private done: (result: GroupSelection) => void,
		groups: InboxGroup[],
		private mode: "view" | "assign",
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

	invalidate() { this.input.invalidate(); }

	private matches() {
		const prefix = this.input.getValue().toLowerCase();
		return this.choices.filter((choice) =>
			choice.name.toLowerCase().startsWith(prefix));
	}

	private pageSize() {
		return Math.max(1, Math.min(9, (this.tui.terminal?.rows ?? 30) - 9));
	}

	handleInput(data: string) {
		const matches = this.matches();
		const ch = decodeKittyPrintable(data) ??
			(data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			return this.done(undefined);
		}
		if (matchesKey(data, "ctrl+n")) {
			this.digitsAsText = !this.digitsAsText;
		} else if (matchesKey(data, "ctrl+a")) {
			return this.done({ action: "create" });
		} else if (
			matchesKey(data, "ctrl+r") || matchesKey(data, "ctrl+t") ||
			matchesKey(data, "ctrl+d")
		) {
			const group = matches[this.selected]?.group;
			if (group) return this.done({
				action: matchesKey(data, "ctrl+r") ? "rename"
					: matchesKey(data, "ctrl+t") ? "template" : "delete",
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
			this.selected = Math.max(0, this.selected - this.pageSize());
		} else if (this.kb.matches(data, "tui.select.pageDown")) {
			this.selected = Math.min(matches.length - 1,
				this.selected + this.pageSize());
		} else if (!this.digitsAsText && ch && /^[1-9]$/.test(ch)) {
			const page = Math.floor(this.selected / this.pageSize());
			const choice = matches[page * this.pageSize() + Number(ch) - 1];
			if (choice) return this.done({ action: "select", scope: choice.scope });
		} else {
			// Input owns bracketed paste, cursor editing, Unicode and backspace.
			// A pasted number is search text, never a row shortcut.
			const previous = this.input.getValue();
			this.input.handleInput(data);
			if (previous !== this.input.getValue()) this.selected = 0;
		}
		this.selected = Math.max(0,
			Math.min(this.selected, this.matches().length - 1));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const matches = this.matches();
		this.selected = Math.max(0, Math.min(this.selected, matches.length - 1));
		const size = this.pageSize();
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
		for (const [i, choice] of shown.entries()) {
			const selected = page * size + i === this.selected;
			const hint = choice.group?.templateEnabled ? " · template on" : "";
			const row = `${selected ? "▶" : " "} ${i + 1} ${choice.name}${hint}`;
			lines.push(selected ? th.fg("accent", row) : row);
		}
		if (!shown.length) lines.push(th.fg("dim", "No matching groups"));
		lines.push(th.fg("dim",
			`Page ${page + 1}/${Math.max(1, Math.ceil(matches.length / size))}`));
		lines.push(th.fg("dim", "↑↓ / PgUp PgDn · Enter choose · Esc cancel"));
		lines.push(th.fg("dim", "Ctrl+A create · Ctrl+R rename"));
		lines.push(th.fg("dim", "Ctrl+T template · Ctrl+D delete"));
		return lines.map((line) => truncateToWidth(line, width));
	}
}
