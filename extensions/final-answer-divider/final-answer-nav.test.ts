/**
 * Tests for the FINAL ANSWER navigation added to the divider extension.
 *
 * The interesting logic is pure: which rows carry a divider, and which one a
 * key press should reveal. Both are exercised against a fake viewport so the
 * "always the newest, and only the newest" behaviour is asserted rather than
 * assumed, and the real re-render path is checked so a stale `currentLayout`
 * cannot quietly become the source of truth.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	lastFinalAnswerRow,
	finalAnswerRows,
	jumpToFinalAnswer,
	transcriptLines,
	type TranscriptViewport,
} from "./index.ts";

const MARK = "▼ FINAL ANSWER";

/** A transcript where the divider is drawn at the given content rows. */
function lines(markers: number[], length = 40): string[] {
	return Array.from({ length }, (_, row) =>
		markers.includes(row) ? ` ${MARK}` : ` row ${row}`,
	);
}

function fakeTui(overrides: Partial<TranscriptViewport> = {}): {
	tui: TranscriptViewport;
	flashes: string[];
	renders: () => number;
	scroll: any;
} {
	const flashes: string[] = [];
	let renders = 0;
	const content = lines([5, 20, 30]);
	const scroll: any = {
		scrollTop: 35,
		getContentWidth: (width: number) => width,
		child: { render: () => content },
		scrollTo(row: number) {
			this.scrollTop = row;
		},
	};
	const tui: any = {
		mode: "fullscreen",
		terminal: { columns: 80 },
		requestRender: () => {
			renders++;
		},
		flash: (message: string) => flashes.push(message),
		getPrimaryScrollView: () => scroll,
		// Deliberately stale/absent: the layout frame is optional.
		currentLayout: undefined,
		...overrides,
	};
	return { tui, flashes, renders: () => renders, scroll };
}

test("divider rows are found through ANSI styling", () => {
	const styled = [
		"plain",
		`\x1b[1m${MARK}\x1b[22m`,
		"plain",
		`\x1b[2m ${MARK}\x1b[22m  trailing`,
	];
	assert.deepEqual(finalAnswerRows(styled), [1, 3]);
});

test("a transcript with no divider yields no rows", () => {
	assert.deepEqual(finalAnswerRows(["a", "b"]), []);
	assert.equal(lastFinalAnswerRow([]), undefined);
});

test("the target is the newest divider, not the oldest", () => {
	assert.equal(lastFinalAnswerRow([5, 20, 30]), 30);
	assert.equal(lastFinalAnswerRow([20]), 20);
});

test("earlier dividers are never a target", () => {
	// A cycle or a history walk would surface 20 or 5 at some point; it must not.
	for (const rows of [[5, 20, 30], [0, 1], [7, 8, 9]]) {
		assert.equal(lastFinalAnswerRow(rows), rows[rows.length - 1]);
	}
});

test("jump scrolls to one row above the divider and requests a render", () => {
	const { tui, flashes, renders, scroll } = fakeTui();
	assert.equal(jumpToFinalAnswer(tui), "ok");
	// Newest divider at content row 30, with one line of context above it.
	assert.equal(scroll.scrollTop, 29);
	assert.equal(renders(), 1);
	assert.deepEqual(flashes, [MARK]);
});

test("pressing again re-reveals the same final answer", () => {
	// The whole point of dropping the cycle: the key is idempotent.
	const { tui, scroll } = fakeTui();
	jumpToFinalAnswer(tui);
	assert.equal(scroll.scrollTop, 29);
	jumpToFinalAnswer(tui);
	assert.equal(scroll.scrollTop, 29);
	jumpToFinalAnswer(tui);
	assert.equal(scroll.scrollTop, 29);
});

test("a repeated press from the oldest answer still lands on the newest", () => {
	// Previously this walked backwards; now every press targets the newest row
	// no matter where the viewport was scrolled to.
	const { tui, scroll } = fakeTui();
	scroll.scrollTop = 3;
	assert.equal(jumpToFinalAnswer(tui), "ok");
	assert.equal(scroll.scrollTop, 29);
});

test("a single divider is revealed the same way", () => {
	const content = lines([20]);
	const scroll: any = {
		scrollTop: 39,
		child: { render: () => content },
		scrollTo(row: number) {
			this.scrollTop = row;
		},
	};
	const { tui, flashes } = fakeTui({ getPrimaryScrollView: () => scroll });
	assert.equal(jumpToFinalAnswer(tui), "ok");
	assert.equal(scroll.scrollTop, 19);
	assert.deepEqual(flashes, [MARK]);
});

test("non-fullscreen mode is refused instead of half-working", () => {
	const { tui, scroll } = fakeTui({ mode: "regular" });
	assert.equal(jumpToFinalAnswer(tui), "no-fullscreen");
	assert.equal(scroll.scrollTop, 35);
});

test("a session with no final answer reports it and does not scroll", () => {
	const scroll: any = {
		scrollTop: 10,
		child: { render: () => lines([]) },
		scrollTo(row: number) {
			this.scrollTop = row;
		},
	};
	const { tui, flashes } = fakeTui({ getPrimaryScrollView: () => scroll });
	assert.equal(jumpToFinalAnswer(tui), "no-marker");
	assert.equal(scroll.scrollTop, 10);
	assert.deepEqual(flashes, []);
});

test("the layout frame wins over a fresh child render", () => {
	// scrollTo() is clamped to the content height from the last layout pass, so
	// rows must come from that same pass. Stale layout text must be used even
	// when the child would render something different.
	const layoutText = lines([7]);
	const scroll: any = {
		scrollTop: 0,
		child: { render: () => lines([33]) },
	};
	const tui: any = {
		mode: "fullscreen",
		currentLayout: {
			root: {
				children: [
					{ children: [{ scrollView: scroll, scrollContentLines: layoutText }] },
				],
			},
		},
	};
	assert.deepEqual(transcriptLines(tui, scroll), layoutText);
});

test("without a layout the child is rendered at the content width", () => {
	const scroll: any = {
		getContentWidth: (width: number) => width - 1,
		child: { render: (width: number) => [`width ${width}`] },
	};
	const tui: any = { mode: "fullscreen", terminal: { columns: 100 }, currentLayout: undefined };
	assert.deepEqual(transcriptLines(tui, scroll), ["width 99"]);
});

// ── against a real pi-tui fullscreen viewport ────────────────────────
//
// The internals in the README table are only worth claiming if they are
// exercised for real: a real TuiAltScreen, a real ScrollView nested in a
// VStack layout, and the real layout pass that populates scrollContentLines.

import {
	KeybindingsManager,
	ScrollView,
	setKeybindings,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";

function fakeTerminal(columns: number, rows: number) {
	const resizes: Array<() => void> = [];
	return {
		terminal: {
			start(_onInput: (data: string) => void, onResize: () => void) {
				resizes.push(onResize);
			},
			stop() {},
			drainInput: async () => {},
			write() {},
			get columns() {
				return columns;
			},
			get rows() {
				return rows;
			},
			get kittyProtocolActive() {
				return false;
			},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
		},
	};
}

test("ctrl+f scrolls a real fullscreen viewport to the newest divider", () => {
	const { terminal } = fakeTerminal(40, 10);
	const tui = new TuiAltScreen(terminal as any, false);
	const doc = new Text(
		Array.from({ length: 40 }, (_, row) => (row === 20 ? ` ${MARK}` : ` line ${row}`)).join("\n"),
		0,
		0,
	);
	const scroll = new ScrollView(doc, { follow: "end", primary: true });
	tui.setLayoutRoot(
		new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]),
	);
	tui.start();
	tui.renderNow(true);

	// A finished run sits at the bottom of the transcript.
	assert.equal(scroll.scrollTop, 30);
	assert.equal(jumpToFinalAnswer(tui as any), "ok");
	// One row of context above the divider at content row 20.
	assert.equal(scroll.scrollTop, 19);
	// A second press must not walk anywhere: same target, against the real
	// clamping behaviour of ScrollView#scrollTo.
	assert.equal(jumpToFinalAnswer(tui as any), "ok");
	assert.equal(scroll.scrollTop, 19);
	assert.equal(scroll.isFollowingEnd, false);

	// scrollTo() is clamped to the content height from the layout pass, which is
	// what makes the row indexes meaningful. Confirm the clamp really allows 19.
	scroll.scrollTo(19);
	assert.equal(scroll.scrollTop, 19);

	tui.stop({ preserveScreen: true });
});

test("a real viewport with no divider reports no-marker and stays put", () => {
	const { terminal } = fakeTerminal(40, 10);
	const tui = new TuiAltScreen(terminal as any, false);
	const scroll = new ScrollView(
		new Text(Array.from({ length: 30 }, (_, row) => `line ${row}`).join("\n"), 0, 0),
		{ follow: "end", primary: true },
	);
	tui.setLayoutRoot(
		new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]),
	);
	tui.start();
	tui.renderNow(true);
	const before = scroll.scrollTop;
	assert.equal(jumpToFinalAnswer(tui as any), "no-marker");
	assert.equal(scroll.scrollTop, before);
	tui.stop({ preserveScreen: true });
});

test("the extension wires ctrl+f end-to-end through ctx.ui.setWidget", async () => {
	// The TUI is only reachable by registering a widget, so the registration,
	// the capture, and the shortcut handler are checked together rather than
	// each in isolation.
	const { terminal } = fakeTerminal(40, 10);
	const tui = new TuiAltScreen(terminal as any, false);
	const doc = new Text(
		Array.from({ length: 40 }, (_, row) => (row === 30 ? ` ${MARK}` : ` line ${row}`)).join("\n"),
		0,
		0,
	);
	const scroll = new ScrollView(doc, { follow: "end", primary: true });
	tui.setLayoutRoot(
		new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]),
	);
	tui.start();
	tui.renderNow(true);

	const { default: install } = await import("./index.ts");
	const shortcuts: Record<string, () => void> = {};
	const commands: Record<string, (args: string, ctx: any) => Promise<void>> = {};
	let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
	const pi: any = {
		on: (event: string, handler: never) => {
			if (event === "session_start") sessionStart = handler;
		},
		registerMarkdownTransformer: () => {},
		registerShortcut: (key: string, options: any) => {
			shortcuts[key] = () => options.handler({ ui: ctx.ui });
		},
		registerCommand: (name: string, options: any) => {
			commands[name] = options.handler;
		},
	};
	const widgets: Array<{ key: string; component: any }> = [];
	const ctx: any = {
		ui: {
			notify: () => {},
			setWidget: (key: string, factory: any) => {
				widgets.push({ key, component: factory(tui, {}, {}) });
			},
		},
		sessionManager: { getBranch: () => [] },
	};
	install(pi);
	assert.ok(sessionStart, "session_start handler was not registered");
	sessionStart({}, ctx);

	// The capture must cost no screen space.
	assert.equal(widgets.length, 1);
	assert.deepEqual(widgets[0]!.component.render(40), []);

	assert.ok(shortcuts["ctrl+f"], "ctrl+f was not registered");
	assert.ok(commands["final"], "/final was not registered");
	shortcuts["ctrl+f"]!();
	assert.equal(scroll.scrollTop, 29);
	await commands["final"]!("", ctx);
	// /final is idempotent: same target as the shortcut.
	assert.equal(scroll.scrollTop, 29);

	tui.stop({ preserveScreen: true });
});

// ── the ctrl+f takeover ──────────────────────────────────────────────
//
// ctrl+f is bound to tui.editor.cursorRight. The extension shortcut claims it
// first because CustomEditor dispatches extension shortcuts before any editor
// handling. That ordering is owned by pi, not by this extension, so pin it:
// if a pi upgrade reorders handleInput, ctrl+f would silently go back to
// moving the cursor right and the feature would look broken-but-quiet.

test("ctrl+f is claimable ahead of the editor's cursorRight binding", async () => {
	const { CustomEditor, getSelectListTheme, initTheme } = await import(
		"@earendil-works/pi-coding-agent"
	);
	initTheme("dark");
	const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS });
	setKeybindings(keybindings);
	const tui: any = {
		requestRender() {},
		terminal: { columns: 80, rows: 24 },
		setFocus() {},
		showOverlay() {
			return { hide() {}, focus() {}, isFocused: () => false };
		},
	};
	const editor: any = new CustomEditor(tui, getSelectListTheme(), keybindings as any, {} as any);
	const reset = () => {
		editor.setText("hello world");
		editor.state.cursorLine = 0;
		editor.state.cursorCol = 0;
	};
	const CTRL_F = "\x06";

	// Baseline: without the shortcut, ctrl+f really does move the cursor right.
	// (If this ever fails, the key stopped being cursorRight and the reason for
	// the README's "this takes over" note is gone.)
	editor.onExtensionShortcut = () => false;
	reset();
	editor.handleInput(CTRL_F);
	assert.equal(editor.state.cursorCol, 1, "ctrl+f is no longer bound to cursorRight");

	// With the shortcut installed the editor must not see the key at all.
	let claimed = 0;
	editor.onExtensionShortcut = (data: string) => {
		if (data !== CTRL_F) return false;
		claimed++;
		return true;
	};
	reset();
	editor.handleInput(CTRL_F);
	assert.equal(claimed, 1, "the extension shortcut was not consulted for ctrl+f");
	assert.equal(editor.state.cursorCol, 0, "ctrl+f reached the editor despite being claimed");
});
