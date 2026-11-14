/**
 * Tests for the digit/arrow model picker. The component is constructed
 * directly with the same fakes the inbox group-selector tests use, so nothing
 * needs a live TUI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import { ModelPicker } from "./picker.ts";

/**
 * Theme stub: pi themes style as fg(color, text) / bold(text), so return the
 * last string argument and leave the content assertions readable.
 */
const theme = new Proxy({} as Theme, {
	get: () => (...args: unknown[]) => {
		for (let i = args.length - 1; i >= 0; i--) {
			if (typeof args[i] === "string") return args[i] as string;
		}
		return "";
	},
});

function model(provider: string, id: string): Model<any> {
	return { provider, id, name: `${id} display` } as unknown as Model<any>;
}

const MODELS = [
	model("example-provider", "alpha"),
	model("example-provider", "beta"),
	model("example-provider", "gamma"),
];

function picker(options: {
	rows?: number;
	scoped?: Model<any>[];
	all?: Model<any>[];
	current?: Model<any>;
	commit?: (m: Model<any>) => Promise<boolean>;
	pickerOptions?: {
		allowCurrent?: boolean;
		initialQuery?: string;
		onPersist?: (m: Model<any>) => void;
	};
} = {}) {
	const scoped = (options.scoped ?? MODELS).map((m) => ({
		model: m, provider: m.provider, id: m.id, name: m.name,
	}));
	const all = (options.all ?? MODELS).map((m) => ({
		model: m, provider: m.provider, id: m.id, name: m.name,
	}));
	const committed: Model<any>[] = [];
	let result: Model<any> | undefined | "waiting" = "waiting";
	const ui = new ModelPicker(
		{ terminal: { rows: options.rows ?? 30 }, requestRender() {} } as unknown as TUI,
		theme,
		getKeybindings(),
		(value) => { result = value; },
		scoped,
		all,
		options.current ?? MODELS[0],
		async (m) => {
			committed.push(m);
			return options.commit ? options.commit(m) : true;
		},
		options.pickerOptions,
	);
	return { ui, result: () => result, committed, render: () => ui.render(120).join("\n") };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("digits select the numbered row by default", async () => {
	const f = picker();
	f.ui.handleInput("2");
	await tick();
	assert.equal(f.result(), MODELS[1]);
	assert.deepEqual(f.committed, [MODELS[1]]);
});

test("the row order never depends on which model is selected", async () => {
	// A list that reshuffles the selected model to the top makes digits
	// unpickable: row 2 today is row 1 tomorrow. Order is fixed; only the ✓
	// and the initial highlight follow the current model.
	const first = picker({ current: MODELS[0] }).render();
	const second = picker({ current: MODELS[2] }).render();
	const rows = (text: string) =>
		text.split("\n")
			// Row number, selection arrow and current-model ✓ vary; row order is
			// what this test pins.
			.map((line) => line.match(/^\s*[▶ ]\s\d\s+[✓ ]\s+(.+)$/)?.[1])
			.filter((row): row is string => !!row);
	assert.deepEqual(rows(first), rows(second));
	assert.deepEqual(rows(first), [
		"alpha [example-provider]",
		"beta [example-provider]",
		"gamma [example-provider]",
	]);
});

test("the current model is marked and highlighted but not moved to the top",
	async () => {
		const f = picker({ current: MODELS[1] });
		assert.match(f.render(), /▶ 2 ✓ beta/);
		assert.match(f.render(), / 1   alpha/);
		f.ui.handleInput("2");
		await tick();
		assert.equal(f.result(), undefined);
		assert.deepEqual(f.committed, []);
	});

test("arrow navigation wraps and follows the page", () => {
	const f = picker();
	f.ui.handleInput("\x1b[A"); // up from row 1 wraps to the last
	assert.match(f.render(), /▶ 3/);
	f.ui.handleInput("\x1b[B"); // down from the last wraps to the first
	assert.match(f.render(), /▶ 1/);
});

test("Ctrl+N makes digits search text instead of shortcuts", async () => {
	const f = picker();
	f.ui.handleInput("\x0e"); // ctrl+n
	assert.equal(f.result(), "waiting");
	f.ui.handleInput("b");
	f.ui.handleInput("e");
	assert.match(f.render(), /filter: be/);
	assert.match(f.render(), /1   beta/);
	f.ui.handleInput("\r");
	await tick();
	assert.equal(f.result(), MODELS[1]);
});

test("a dotted version number is typeable after Ctrl+N", async () => {
	const f = picker({
		scoped: [
			model("example-provider", "model-alpha"),
			model("example-provider", "model-4.1-flash"),
		],
		all: [],
	});
	f.ui.handleInput("\x0e");
	for (const ch of "4.1") f.ui.handleInput(ch);
	assert.match(f.render(), /filter: 4\.1/);
	f.ui.handleInput("\r");
	await tick();
	assert.equal((f.result() as Model<any>).id, "model-4.1-flash");
});

test("the current model keeps its row across a switch", async () => {
	// Regression guard for the ordering complaint: switch to gamma, reopen,
	// and gamma is highlighted in row 3 where it always was — alpha is still 1.
	const f = picker({ current: MODELS[2] });
	assert.match(f.render(), /▶ 3 ✓ gamma/);
	assert.match(f.render(), / 1   alpha/);
	f.ui.handleInput("1");
	await tick();
	assert.equal(f.result(), MODELS[0]);
});

test("allowCurrent resolves with the current model", async () => {
	const f = picker({
		current: MODELS[1],
		pickerOptions: { allowCurrent: true },
	});
	f.ui.handleInput("2");
	await tick();
	assert.equal(f.result(), MODELS[1]);
});

test("Ctrl+S saves the choice as the startup default", async () => {
	const persisted: Model<any>[] = [];
	const f = picker({
		current: MODELS[0],
		pickerOptions: { allowCurrent: true, onPersist: (m) => persisted.push(m) },
	});
	assert.match(f.render(), /Ctrl\+S set as default/);
	f.ui.handleInput("\x1b[B"); // down to row 2
	f.ui.handleInput("\x1b[B"); // down to row 3
	f.ui.handleInput("\x13"); // ctrl+s
	await tick();
	assert.deepEqual(persisted, [MODELS[2]]);
	assert.equal(f.result(), MODELS[2]);
});

test("a prefilled search filters before the rows are picked", async () => {
	const f = picker({ pickerOptions: { initialQuery: "gam" } });
	assert.match(f.render(), /filter: gam/);
	assert.match(f.render(), /1   gamma/);
	assert.doesNotMatch(f.render(), /alpha/);
	// A prefilled query means the user came to type, so digits stay text.
	assert.match(f.render(), /Digits: text/);
	f.ui.handleInput("\r");
	await tick();
	assert.equal(f.result(), MODELS[2]);
});

test("Ctrl+N is a toggle, so digits select again", async () => {
	const f = picker();
	f.ui.handleInput("\x0e");
	assert.match(f.render(), /Digits: text/);
	f.ui.handleInput("\x0e");
	assert.match(f.render(), /Digits: select/);
	f.ui.handleInput("3");
	await tick();
	assert.equal(f.result(), MODELS[2]);
});

test("backspace edits the filter without selecting", () => {
	const f = picker();
	f.ui.handleInput("\x0e");
	for (const ch of "gam") f.ui.handleInput(ch);
	f.ui.handleInput("\x7f"); // backspace
	assert.match(f.render(), /filter: ga/);
	assert.equal(f.result(), "waiting");
});

test("key release and repeat cannot double-select a digit", async () => {
	const f = picker();
	f.ui.handleInput("\x1b[50;1:3u"); // release of "2"
	f.ui.handleInput("\x1b[50;1:2u"); // repeat of "2"
	assert.deepEqual(f.committed, []);
	f.ui.handleInput("2");
	await tick();
	assert.deepEqual(f.committed, [MODELS[1]]);
});

test("escape and ctrl+c cancel without committing", () => {
	for (const key of ["\x1b", "\x03"]) {
		const f = picker();
		f.ui.handleInput(key);
		assert.equal(f.result(), undefined);
		assert.deepEqual(f.committed, []);
	}
});

test("Tab toggles scoped and all scopes", () => {
	const f = picker({
		scoped: [MODELS[0]],
		all: MODELS,
	});
	assert.match(f.render(), /1 scoped/);
	f.ui.handleInput("\t");
	assert.match(f.render(), /3 all/);
	f.ui.handleInput("\t");
	assert.match(f.render(), /1 scoped/);
});

test("scope falls back to all when nothing is scoped", () => {
	const f = picker({ scoped: [], all: MODELS });
	assert.match(f.render(), /3 available/);
	f.ui.handleInput("\t"); // no-op: there is nothing to toggle to
	assert.match(f.render(), /3 available/);
});

test("a failed commit reports the error and stays open", async () => {
	const f = picker({ commit: async () => false });
	f.ui.handleInput("2");
	await tick();
	assert.equal(f.result(), "waiting");
	assert.match(f.render(), /No API key for example-provider\/beta/);
});

test("page size caps at 9 so every row has a single-digit shortcut", () => {
	const many = Array.from({ length: 25 }, (_, i) =>
		model("example-provider", `m${String(i).padStart(2, "0")}`));
	const f = picker({ scoped: many, all: many, rows: 40, current: many[0] });
	const text = f.render();
	assert.match(text, /Page 1\/3/);
	// Row 10 must not appear on page 1, because there is no "10" shortcut.
	assert.doesNotMatch(text, /▶ {2}|\s10 m09/);
	f.ui.handleInput("\x1b[C"); // right = next page
	assert.match(f.render(), /Page 2\/3/);
});

test("a missing model reports the error on screen", () => {
	const f = picker({ scoped: [], all: [] });
	assert.match(f.render(), /No matching models/);
	f.ui.handleInput("1");
	assert.equal(f.result(), "waiting");
});

/**
 * The editor patch is the riskiest part (it hooks a prototype), so verify it
 * against a real CustomEditor: ctrl+l must divert, other keys must fall
 * through, and editors that interactive mode did not wire up must be ignored.
 */
test("ctrl+l diverts to the picker and other keys still reach the editor", async () => {
	const { CustomEditor, initTheme } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const tuiLib = await import("@earendil-works/pi-tui");
	initTheme("dark");
	const kb = new tuiLib.KeybindingsManager({
		...tuiLib.TUI_KEYBINDINGS,
		"app.model.select": { defaultKeys: "ctrl+l" },
	} as never);
	tuiLib.setKeybindings(kb);

	let opens = 0;
	const g = globalThis as unknown as Record<symbol, unknown>;
	g[Symbol.for("pi.ext.model-picker")] = {
		patched: false,
		open: () => { opens += 1; },
	};
	const mod = await import("./index.ts");
	mod.default({
		registerLoadedExtension() {},
		on() {},
		registerCommand() {},
	} as never);

	const tui = {
		terminal: { rows: 30, columns: 100 },
		requestRender() {},
	} as unknown as import("@earendil-works/pi-tui").TUI;
	const editor = new (CustomEditor as never as new (
		t: unknown, th: unknown, k: unknown, o?: unknown,
	) => {
		onAction(action: string, handler: () => void): void;
		handleInput(data: string): void;
		getText(): string;
		actionHandlers: Map<string, unknown>;
	})(tui, { fg: (_c: string, t: string) => t }, kb, { paddingX: 0 });

	// Simulate interactive mode wiring the built-in selector.
	editor.onAction("app.model.select", () => {
		throw new Error("built-in selector should be bypassed");
	});
	assert.equal(editor.actionHandlers.has("app.model.select"), true);

	editor.handleInput("\x0c"); // ctrl+l
	assert.equal(opens, 1);
	editor.handleInput("hi");
	assert.equal(editor.getText(), "hi");

	// An editor without the built-in handler (e.g. a picker reusing ctrl+l)
	// must be left alone.
	const plain = new (CustomEditor as never as new (
		t: unknown, th: unknown, k: unknown, o?: unknown,
	) => { handleInput(data: string): void; getText(): string })(
		tui, { fg: (_c: string, t: string) => t }, kb, { paddingX: 0 },
	);
	plain.handleInput("\x0c");
	assert.equal(opens, 1, "unwired editor must not open the picker");
});
