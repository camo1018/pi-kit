import assert from "node:assert/strict";
import { test } from "node:test";
import {
	getKeybindings, visibleWidth, type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	GroupSelector, type GroupSelection, type TemplateActions,
} from "./group-selector.ts";
import type { InboxGroup } from "./groups.ts";

const groups: InboxGroup[] = ["PR reviews", "PR2", "2026", "Bugs"].map(
	(name) => ({ id: name, name, template: "", templateEnabled: false }),
);

function selector(mode: "view" | "assign" = "view", rows = 30) {
	let result: GroupSelection | "waiting" = "waiting";
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	const templates = new Map(groups.map((group) => [group.id, { ...group }]));
	const actions: TemplateActions = {
		async toggle(id) {
			const group = templates.get(id)!;
			group.templateEnabled = !group.templateEnabled;
			return { ...group };
		},
		async save(id, text) {
			const group = templates.get(id)!;
			group.template = text;
			return { ...group };
		},
	};
	const ui = new GroupSelector(
		{ terminal: { rows }, requestRender() {} } as unknown as TUI,
		theme, getKeybindings(), (value) => { result = value; }, groups, mode,
		actions,
	);
	return { ui, actions, templates, result: () => result };
}

test("prefix matching ignores case and numbers pick filtered rows", () => {
	const f = selector();
	f.ui.handleInput("p");
	f.ui.handleInput("R");
	assert.doesNotMatch(f.ui.render(100).join("\n"), /Bugs|2026/);
	f.ui.handleInput("2");
	assert.deepEqual(f.result(), { action: "select", scope: "PR2" });
});

test("Ctrl+N makes digits searchable instead of selecting rows", () => {
	const f = selector();
	f.ui.handleInput("\x0e");
	for (const ch of "2026") f.ui.handleInput(ch);
	assert.equal(f.result(), "waiting");
	assert.match(f.ui.render(100).join("\n"), /Digits: text/);
	f.ui.handleInput("\r");
	assert.deepEqual(f.result(), { action: "select", scope: "2026" });
});

test("Ctrl+N toggles once per Kitty key press, not repeat or release", () => {
	const f = selector();
	f.ui.handleInput("\x1b[110;5:1u");
	assert.match(f.ui.render(100).join("\n"), /Digits: text/);
	f.ui.handleInput("\x1b[110;5:2u");
	assert.match(f.ui.render(100).join("\n"), /Digits: text/);
	f.ui.handleInput("\x1b[110;5:3u");
	assert.match(f.ui.render(100).join("\n"), /Digits: text/);
	f.ui.handleInput("\x1b[110;5:1u");
	assert.match(f.ui.render(100).join("\n"), /Digits: select/);
});

test("release events cannot edit the prefix or invoke management", () => {
	const f = selector();
	for (const ch of "PR") f.ui.handleInput(ch);
	f.ui.handleInput("\x1b[127;1:3u");
	f.ui.handleInput("\x1b[97;5:3u");
	assert.match(f.ui.render(100).join("\n"), /Prefix: PR/);
	assert.equal(f.result(), "waiting");
});

test("arrow key repeat still navigates the selector", () => {
	const f = selector();
	f.ui.handleInput("\x1b[1;1:2B");
	f.ui.handleInput("\r");
	assert.deepEqual(f.result(), { action: "select", scope: "2026" });
});

test("Ctrl+N can switch back to shortcuts for an alphanumeric prefix", () => {
	const f = selector();
	f.ui.handleInput("\x0e");
	for (const ch of "PR2") f.ui.handleInput(ch);
	f.ui.handleInput("\x0e");
	f.ui.handleInput("1");
	assert.deepEqual(f.result(), { action: "select", scope: "PR2" });
});

test("bracketed pasted digits are always text", () => {
	const f = selector();
	f.ui.handleInput("\x1b[200~2026\x1b[201~");
	assert.equal(f.result(), "waiting");
	f.ui.handleInput("1");
	assert.deepEqual(f.result(), { action: "select", scope: "2026" });
});

test("assignment never offers All groups and Escape cancels", () => {
	const f = selector("assign");
	assert.doesNotMatch(f.ui.render(100).join("\n"), /All groups/);
	f.ui.handleInput("\x1b");
	assert.equal(f.result(), undefined);
});

test("number labels follow the visible page after navigation", () => {
	const f = selector("view", 18);
	f.ui.handleInput("\x1b[6~");
	assert.match(f.ui.render(100).join("\n"), /Page 2\/3/);
	f.ui.handleInput("1");
	assert.deepEqual(f.result(), { action: "select", scope: "2026" });
});

test("management keys target the highlighted group, not special views", () => {
	const f = selector();
	f.ui.handleInput("\x01");
	assert.deepEqual(f.result(), { action: "create" });
	for (const [key, action] of [
		["\x12", "rename"], ["\x04", "delete"],
	]) {
		const f = selector();
		f.ui.handleInput("\x1b[A");
		f.ui.handleInput(key);
		assert.equal(f.result(), "waiting");
		for (const ch of "Bug") f.ui.handleInput(ch);
		f.ui.handleInput(key);
		assert.deepEqual(f.result(), { action, id: "Bugs" });
	}
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Ctrl+T toggles inline and preserves search/selection", async () => {
	const f = selector();
	for (const char of "PR") f.ui.handleInput(char);
	f.ui.handleInput("\x1b[B");
	f.ui.handleInput("\x14");
	await tick();
	assert.equal(f.result(), "waiting");
	assert.match(f.ui.render(100).join("\n"), /Prefix: PR/);
	assert.match(f.ui.render(100).join("\n"), /Template · PR2 · enabled/);
	assert.equal(f.templates.get("PR2")!.templateEnabled, true);
	f.ui.handleInput("\r");
	assert.deepEqual(f.result(), { action: "select", scope: "PR2" });
});

test("inline edit preserves digits mode, prefix and whitespace", async () => {
	const f = selector();
	f.ui.focused = true;
	f.ui.handleInput("\x0e");
	for (const char of "2026") f.ui.handleInput(char);
	f.ui.handleInput("\x05");
	const text = "Use gh-pr-review\n\nPR: ";
	f.ui.handleInput(`\x1b[200~${text}\x1b[201~`);
	f.ui.handleInput("\x13");
	await tick();
	assert.equal(f.templates.get("2026")!.template, text);
	assert.match(f.ui.render(100).join("\n"), /Prefix: 2026/);
	assert.match(f.ui.render(100).join("\n"), /Digits: text/);
	assert.equal(f.result(), "waiting");
	f.ui.handleInput("\r");
	assert.deepEqual(f.result(), { action: "select", scope: "2026" });
});

test("Escape cancels only the edit and restores search focus", () => {
	const f = selector();
	f.ui.focused = true;
	for (const char of "PR") f.ui.handleInput(char);
	f.ui.handleInput("\x05");
	const internal = f.ui as any;
	assert.equal(internal.input.focused, false);
	assert.equal(internal.editor.focused, true);
	f.ui.handleInput("unsaved text");
	f.ui.handleInput("\x1b");
	assert.equal(f.result(), "waiting");
	assert.equal(f.templates.get("PR reviews")!.template, "");
	assert.equal(internal.input.focused, true);
	assert.match(f.ui.render(100).join("\n"), /Prefix: PR/);
	f.ui.handleInput("\x1b");
	assert.equal(f.result(), undefined);
});

test("failed saves retain the edit for retry", async () => {
	const f = selector();
	const save = f.actions.save;
	f.actions.save = async () => { throw new Error("save failed"); };
	for (const char of "Bug") f.ui.handleInput(char);
	f.ui.handleInput("\x05");
	f.ui.handleInput("draft to keep");
	f.ui.handleInput("\x13");
	await tick();
	assert.match(f.ui.render(100).join("\n"), /save failed/);
	assert.equal((f.ui as any).editor.getExpandedText(), "draft to keep");
	f.actions.save = save;
	f.ui.handleInput("\x13");
	await tick();
	assert.equal(f.templates.get("Bugs")!.template, "draft to keep");
	assert.equal((f.ui as any).editor, undefined);
});

test("template shortcuts ignore key-up and repeat events", async () => {
	const f = selector();
	for (const char of "Bug") f.ui.handleInput(char);
	f.ui.handleInput("\x1b[116;5:1u");
	await tick();
	f.ui.handleInput("\x1b[116;5:2u");
	f.ui.handleInput("\x1b[116;5:3u");
	await tick();
	assert.equal(f.templates.get("Bugs")!.templateEnabled, true);
	f.ui.handleInput("\x1b[101;5:3u");
	assert.equal((f.ui as any).editor, undefined);
});

test("save-key repeat cannot accidentally choose the group", async () => {
	const f = selector();
	for (const char of "Bug") f.ui.handleInput(char);
	f.ui.handleInput("\x05");
	f.ui.handleInput("text");
	f.ui.handleInput("\x13");
	await tick();
	f.ui.handleInput("\x1b[13;1:2u");
	assert.equal(f.result(), "waiting");
});

test("dispose releases input once; pending updates are ignored", async () => {
	const f = selector();
	let finish!: (group: InboxGroup) => void;
	f.actions.toggle = () => new Promise((resolve) => { finish = resolve; });
	for (const char of "Bug") f.ui.handleInput(char);
	f.ui.handleInput("\x14");
	let released = 0;
	f.ui.onDispose = () => { released++; };
	f.ui.dispose();
	f.ui.dispose();
	finish({ ...f.templates.get("Bugs")!, templateEnabled: true });
	await tick();
	assert.equal(released, 1);
	assert.equal((f.ui as any).highlightedGroup().templateEnabled, false);
	f.ui.handleInput("\r");
	assert.equal(f.result(), "waiting");
});

test("All groups and Ungrouped cannot have templates", async () => {
	const f = selector();
	f.ui.handleInput("\x1b[A");
	for (const key of ["\x14", "\x05"]) f.ui.handleInput(key);
	await tick();
	assert.equal((f.ui as any).editor, undefined);
	assert.match(f.ui.render(100).join("\n"), /Highlight a named group/);
});

test("preview and editor stay within terminal dimensions", () => {
	for (const rows of [6, 11, 18, 30, 50]) {
		const f = selector("view", rows);
		f.ui.focused = true;
		for (const char of "PR") f.ui.handleInput(char);
		for (const width of [1, 20, 80]) {
			assert.ok(f.ui.render(width).length <= rows);
		}
		f.ui.handleInput("\x05");
		f.ui.handleInput(`\x1b[200~${"line\n".repeat(40)}\x1b[201~`);
		for (const width of [1, 20, 80]) {
			const lines = f.ui.render(width);
			assert.ok(lines.length <= rows);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	}
});

test("selector fits narrow widths and propagates input focus", () => {
	const f = selector();
	f.ui.focused = true;
	assert.equal(f.ui.focused, true);
	for (const width of [1, 20, 40, 80]) {
		assert.ok(f.ui.render(width).every((line) => visibleWidth(line) <= width));
	}
});
