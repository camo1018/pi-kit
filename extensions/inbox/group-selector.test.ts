import assert from "node:assert/strict";
import { test } from "node:test";
import {
	getKeybindings, visibleWidth, type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { GroupSelector, type GroupSelection } from "./group-selector.ts";
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
	const ui = new GroupSelector(
		{ terminal: { rows }, requestRender() {} } as unknown as TUI,
		theme, getKeybindings(), (value) => { result = value; }, groups, mode,
	);
	return { ui, result: () => result };
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
	const f = selector("view", 11);
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
		["\x12", "rename"], ["\x14", "template"], ["\x04", "delete"],
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

test("selector fits narrow widths and propagates input focus", () => {
	const f = selector();
	f.ui.focused = true;
	assert.equal(f.ui.focused, true);
	for (const width of [1, 20, 40, 80]) {
		assert.ok(f.ui.render(width).every((line) => visibleWidth(line) <= width));
	}
});
