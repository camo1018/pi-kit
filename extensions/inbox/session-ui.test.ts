import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test, type TestContext } from "node:test";
import {
	CustomEditor,
	getSelectListTheme,
	initTheme,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	KeybindingsManager,
	matchesKey,
	setKeybindings,
	TUI_KEYBINDINGS,
	type TUI,
} from "@earendil-works/pi-tui";
import type { BgAgent } from "../../lib/inbox-agents.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { InboxGroups } from "./groups.ts";

// Import only after isolating every inbox write from the operator's data.
const dir = mkdtempSync(join(tmpdir(), "pi-queue-test-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
writeFileSync(join(dir, "notify.json"), JSON.stringify({ enabled: false }));
const { default: inbox } = await import("./index.ts");
const {
	applyEvent,
	registry,
	removeQueuedMessage,
	releaseAgent,
	sessionModel,
} = await import("../../lib/inbox-agents.ts");
const { closeVisit, visitingId } = await import("../../lib/visit-runtime.ts");
const { default: renameChat } = await import("../rename-chat/index.ts");
initTheme("dark");
setKeybindings(
	new KeybindingsManager({
		...TUI_KEYBINDINGS,
		"app.message.dequeue": { defaultKeys: "alt+up" },
		"app.model.select": { defaultKeys: "ctrl+l" },
		"app.model.cycleForward": { defaultKeys: "ctrl+p" },
		"app.model.cycleBackward": { defaultKeys: "ctrl+shift+p" },
		"app.thinking.cycle": { defaultKeys: "shift+tab" },
		"app.message.followUp": { defaultKeys: "alt+enter" },
	}),
);
after(() => {
	if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldDir;
	rmSync(dir, { recursive: true, force: true });
});

const models: Model<Api>[] = ["alpha", "beta", "vendor/gamma:free"].map(
	(id) => ({
		id,
		name: id,
		provider: "test",
		api: "openai-responses",
		baseUrl: "https://models.invalid",
		reasoning: true,
		input: ["text"],
		contextWindow: 100000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}),
);

async function setup(t: TestContext, takenOver = true) {
	rmSync(join(dir, "inbox-groups.json"), { force: true });
	const globals = globalThis as any;
	const modeKey = Symbol.for("pi.inbox.mode");
	// Skip the real supervisor: these fixtures never launch agent processes.
	globals[Symbol.for("pi.inbox.agentChild")] = "queue-test";
	const main = SessionManager.create(dir);
	main.appendMessage({ role: "user", content: "main", timestamp: 1 });
	main.appendModelChange("test", "alpha");
	main.appendThinkingLevelChange("low");
	globals[modeKey] = {
		on: true,
		flagApplied: true,
		inLoop: false,
		takenOver: new Set(takenOver ? [main.getSessionId()] : []),
	};
	const chat = new Container();
	const doc = new Container();
	doc.addChild(chat);
	let editorText = "";
	const editor = {
		getText: () => editorText,
		insertTextAtCursor() {},
		isShowingAutocomplete: () => false,
	};
	let focus: any = editor;
	const foregroundSession = {
		model: models[0],
		state: { thinkingLevel: "low" },
	};
	const footer = {
		session: foregroundSession,
		setSession(session: typeof foregroundSession) {
			this.session = session;
		},
		getSessionStats() {},
	};
	const tui = {
		mode: "fullscreen",
		children: [doc, { children: [footer] }],
		getFocusedComponent: () => focus,
		requestRender: mock.fn(),
		viewportTop: 0,
		scrollBy(lines: number) {
			this.viewportTop = Math.max(0, this.viewportTop + lines);
			this.requestRender();
		},
		flash: mock.fn(),
		terminal: { rows: 30, columns: 120 },
	} as unknown as TUI;
	globals.__piInboxTui = tui;
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const tools = new Map<string, any>();
	const pi = {
		on(name: string, fn: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerShortcut(key: string, shortcut: any) {
			shortcuts.set(key, shortcut);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		setSessionName: mock.fn((name: string) => main.appendSessionInfo(name)),
		setModel: mock.fn(),
		setThinkingLevel: mock.fn(),
		registerFlag() {},
		getFlag: () => false,
		getSessionName: () => "taken-over main",
		getThinkingLevel: () => "off",
		sendUserMessage: mock.fn(),
	} as unknown as ExtensionAPI;
	const widgets = new Map<string, any>();
	const terminalInputs = new Set<(data: string) => any>();
	let overlay: any;
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const ui = {
		tui,
		theme,
		notify: mock.fn(),
		setStatus() {},
		setWidget(key: string, value: any) {
			widgets.set(key, typeof value === "function" ? value(tui) : value);
		},
		getEditorText: () => editorText,
		setEditorText: mock.fn((text: string) => {
			editorText = text;
		}),
		input: mock.fn(async () => "renamed via shortcut"),
		select: mock.fn(async () => "Edit template"),
		editor: mock.fn(async () => "Use gh-pr-review\n\nPR: "),
		onTerminalInput(fn: (data: string) => any) {
			terminalInputs.add(fn);
			return () => { terminalInputs.delete(fn); };
		},
		custom(factory: Function) {
			return new Promise((resolve) => {
				overlay = factory(tui, theme, getKeybindings(), (result: any) => {
					overlay?.dispose?.();
					focus = editor;
					resolve(result);
				});
				focus = overlay;
			});
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: dir,
		sessionManager: main,
		ui,
		model: models[0],
		thinkingLevel: "low",
		scopedModels: models.map((model) => ({ model })),
		modelRegistry: {
			getAvailable: () => models,
			find: (provider: string, id: string) =>
				models.find((m) => m.provider === provider && m.id === id),
			getError: () => undefined,
			refresh: async () => ({ errors: new Map(), aborted: false }),
		},
		isProjectTrusted: () => false,
		isIdle: () => false,
	} as unknown as ExtensionContext;

	async function emit(name: string, event: any = {}) {
		const results = [];
		for (const handler of handlers.get(name) ?? []) {
			results.push(await handler(event, ctx));
		}
		return results;
	}

	inbox(pi);
	renameChat(pi);
	await emit("session_start");
	t.after(() => {
		overlay?.dispose?.();
		closeVisit(tui);
		globals.__piInboxAgentsListener?.();
		delete globals.__piInboxAgentsListener;
		delete globals.__piInboxAgentsListenerVersion;
		const visitListener = Symbol.for("pi.inbox.visitListener");
		globals[visitListener]?.();
		delete globals[visitListener];
		delete globals[Symbol.for("pi.inbox.visitState")];
		delete globals[Symbol.for("pi.inbox.agentChild")];
		delete globals[modeKey];
		delete globals[Symbol.for("pi.inbox.reply-target")];
		delete globals[Symbol.for("pi.inbox.group-view")];
		registry().agents.clear();
	});

	async function visit(title: string, registered = true, cwd = dir) {
		const sm = SessionManager.create(cwd);
		sm.appendMessage({ role: "user", content: title, timestamp: 2 });
		sm.appendModelChange("test", "beta");
		sm.appendThinkingLevelChange("low");
		const a: BgAgent = {
			id: sm.getSessionId(),
			cwd,
			sessionFile: sm.getSessionFile(),
			title,
			state: "working",
			proc: { kill: mock.fn() },
			pending: [],
			createdAt: 0,
			updatedAt: 0,
			needsYou: false,
			runs: 1,
			log: [],
			liveText: "",
		};
		if (registered) registry().agents.set(a.id, a);
		await emit("session_before_switch", {
			targetSessionFile: sm.getSessionFile(),
		});
		assert.equal(visitingId(), a.id);
		return a;
	}

	async function openInbox() {
		const previous = overlay;
		const done = commands.get("inbox").handler("", ctx);
		for (let i = 0; i < 200 && overlay === previous; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.notEqual(overlay, previous, "the inbox should open");
		return { list: overlay, done };
	}

	return {
		commands,
		shortcuts,
		tools,
		openInbox,
		ctx,
		emit,
		main,
		pi,
		ui,
		footer,
		foregroundSession,
		tui,
		editor,
		visit,
		widgets,
		key: (data: string) => {
			for (const handler of terminalInputs) {
				const result = handler(data);
				if (result?.consume) return result;
			}
			return undefined;
		},
		overlay: () => overlay,
	};
}

test(
	"a timed-out agent stops showing as working when it settles",
	async (t) => {
		const f = await setup(t);
		const a = await f.visit("timed-out agent");
		applyEvent(a, {
			type: "auto_retry_end",
			success: false,
			finalError: "Request timed out while offline",
		});
		applyEvent(a, { type: "agent_settled" });

		assert.equal(a.state, "error");
		assert.equal(a.error, "Request timed out while offline");
		assert.equal(a.needsYou, true);
		// The process remains reserved until it exits, preventing another writer.
		assert.ok(a.proc);

		const { list, done } = await f.openInbox();
		const rendered = list.render(120).join("\n");
		const row = rendered
			.split("\n")
			.find((line: string) => line.includes("timed-out agent"));
		assert.ok(row);
		assert.match(row, /✗ error/);
		assert.doesNotMatch(row, /working/);
		list.handleInput("\x1b");
		await done;
	},
);

test("queue status follows the visited agent, not the foreground", async (t) => {
	const f = await setup(t);
	const a = await f.visit("visited agent");
	const result = await f.emit("input", {
		source: "interactive",
		text: "follow up on the visit",
	});
	assert.deepEqual(result, [{ action: "handled" }]);
	assert.deepEqual(a.pending, ["follow up on the visit"]);
	assert.equal(registry().agents.has(f.main.getSessionId()), false);
	assert.match(f.widgets.get("inbox-live").join("\n"), /1 message/);

	removeQueuedMessage(a.id, 0);
	assert.doesNotMatch(f.widgets.get("inbox-live").join("\n"), /queued ·/);
	// The visited agent finishes without a native foreground-session reload.
	a.state = "idle";
	a.proc = undefined;
	for (const listener of registry().listeners) listener({ type: "changed" });
	assert.equal(f.widgets.get("inbox-live"), undefined);
	assert.equal((f.pi.sendUserMessage as any).mock.calls.length, 0);
});

test("Alt+Up opens the visit's queue and never falls through", async (t) => {
	const f = await setup(t);
	const a = await f.visit("queue belongs to this visit");
	a.pending.push("queued for the visited agent");
	const key = "\x1b[1;3A";
	assert.equal(getKeybindings().matches(key, "app.message.dequeue"), true);
	assert.deepEqual(f.key(key), { consume: true });
	const rendered = f.overlay().render(100).join("\n");
	assert.match(rendered, /queue belongs to this visit/);
	assert.match(rendered, /queued for the visited agent/);
	f.overlay().handleInput("\x1b");
	await Promise.resolve();
	assert.deepEqual(a.pending, ["queued for the visited agent"]);
	assert.equal((f.ui.setEditorText as any).mock.calls.length, 0);
});

test("Alt+Up on an unregistered visit cannot dequeue the main", async (t) => {
	const f = await setup(t);
	await f.visit("no background run yet", false);
	assert.deepEqual(f.key("\x1b[1;3A"), { consume: true });
	assert.equal(f.overlay(), undefined);
	assert.equal((f.ui.setEditorText as any).mock.calls.length, 0);
});

test("switching visits keeps /queue and its status on the new target", async (t) => {
	const f = await setup(t);
	const first = await f.visit("first visit");
	await f.emit("input", { source: "interactive", text: "first queued reply" });
	const second = await f.visit("second visit");
	assert.doesNotMatch(f.widgets.get("inbox-live").join("\n"), /message/);
	await f.emit("input", {
		source: "interactive",
		text: "second queued reply",
	});
	assert.deepEqual(first.pending, ["first queued reply"]);
	assert.deepEqual(second.pending, ["second queued reply"]);

	const done = f.commands.get("queue").handler("", f.ctx);
	const rendered = f.overlay().render(100).join("\n");
	assert.match(rendered, /second visit/);
	assert.match(rendered, /second queued reply/);
	assert.doesNotMatch(rendered, /first queued reply/);
	f.overlay().handleInput("\x1b");
	await done;
	removeQueuedMessage(first.id, 0);
	assert.match(f.widgets.get("inbox-live").join("\n"), /1 message/);
});

test("returning to the main clears the visit's queue status", async (t) => {
	const f = await setup(t);
	const a = await f.visit("visited agent");
	await f.emit("input", { source: "interactive", text: "queued reply" });
	assert.deepEqual(f.key("\x1b"), { consume: true });
	assert.equal(visitingId(), undefined);
	assert.equal(f.widgets.get("inbox-live"), undefined);
	assert.deepEqual(a.pending, ["queued reply"]);
	// Back on the main, its native dequeue shortcut is left alone.
	assert.equal(f.key("\x1b[1;3A"), undefined);
});

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("model picker changes only the busy visit and survives queued replies", async (t) => {
	const f = await setup(t);
	const a = await f.visit("model target");
	const mainBefore = readFileSync(f.main.getSessionFile()!, "utf8");
	const visitBefore = readFileSync(a.sessionFile!, "utf8");
	assert.equal(f.footer.session.model?.id, "beta");
	assert.deepEqual(f.key("\x0c"), { consume: true });
	assert.equal(f.overlay().constructor.name, "ModelSelectorComponent");
	f.overlay().handleInput("gamma");
	f.overlay().handleInput("\r");
	await nextTick();
	assert.equal(a.nextModel, "test/vendor/gamma:free:low");
	assert.equal(f.footer.session.model?.id, "vendor/gamma:free");
	assert.equal(f.footer.session.state.thinkingLevel, "low");
	assert.equal(readFileSync(a.sessionFile!, "utf8"), visitBefore);
	const saved = JSON.parse(
		readFileSync(join(dir, "inbox-agents", `${a.id}.json`), "utf8"),
	);
	assert.equal(saved.nextModel, a.nextModel);
	await f.emit("input", { source: "interactive", text: "use the new model" });
	assert.equal(a.nextModel, "test/vendor/gamma:free:low");
	assert.deepEqual(a.pending, ["use the new model"]);
	assert.equal(readFileSync(f.main.getSessionFile()!, "utf8"), mainBefore);
	assert.equal((f.pi.setModel as any).mock.calls.length, 0);
	assert.equal((f.pi.setThinkingLevel as any).mock.calls.length, 0);
	assert.deepEqual(f.key("\x1b"), { consume: true });
	assert.equal(f.footer.session, f.foregroundSession);
	assert.equal(f.key("\x10"), undefined);

	await f.emit("session_before_switch", { targetSessionFile: a.sessionFile });
	assert.equal(f.footer.session.model?.id, "vendor/gamma:free");
});

test("cancelling the visit model picker changes neither session", async (t) => {
	const f = await setup(t);
	const a = await f.visit("cancel model");
	const before = readFileSync(a.sessionFile!, "utf8");
	assert.deepEqual(f.key("\x0c"), { consume: true });
	// Picker input owns focus; session shortcuts must not steal it.
	assert.equal(f.key("\x10"), undefined);
	f.overlay().handleInput("\x1b");
	await nextTick();
	assert.equal(a.nextModel, undefined);
	assert.equal(readFileSync(a.sessionFile!, "utf8"), before);
	assert.equal(f.footer.session.model?.id, "beta");
});

test("/model on an idle visit persists there even with autocomplete open", async (t) => {
	const f = await setup(t);
	const a = await f.visit("idle model target", false);
	f.editor.isShowingAutocomplete = () => true;
	f.ui.setEditorText("/model test/vendor/gamma:free");
	assert.deepEqual(f.key("\r"), { consume: true });
	await nextTick();
	assert.equal(sessionModel(a.sessionFile), "test/vendor/gamma:free:low");
	assert.equal(f.footer.session.model?.id, "vendor/gamma:free");
	assert.equal(sessionModel(f.main.getSessionFile()), "test/alpha:low");
	assert.equal(f.ui.getEditorText(), "");
	assert.equal(registry().agents.has(a.id), false);
});

test("model cycling and thinking controls use the visit's settings", async (t) => {
	const f = await setup(t);
	const a = await f.visit("cycle target");
	(f.ctx.scopedModels[2] as any).thinkingLevel = "high";
	assert.deepEqual(f.key("\x10"), { consume: true });
	await nextTick();
	assert.equal(a.nextModel, "test/vendor/gamma:free:high");
	const backwards = "\x1b[112;6u";
	assert.equal(
		getKeybindings().matches(backwards, "app.model.cycleBackward"),
		true,
	);
	assert.deepEqual(f.key(backwards), { consume: true });
	await nextTick();
	assert.equal(f.footer.session.model?.id, "beta");

	f.ui.setEditorText("/thinking low");
	assert.deepEqual(f.key("\r"), { consume: true });
	assert.deepEqual(f.key("\x1b[Z"), { consume: true });
	await nextTick();
	assert.equal(a.nextModel, "test/beta:medium");
	f.ui.setEditorText("/thinking");
	assert.deepEqual(f.key("\r"), { consume: true });
	assert.equal(f.overlay().constructor.name, "ThinkingSelectorComponent");
	f.overlay().handleInput("high");
	f.overlay().handleInput("\r");
	await nextTick();
	assert.equal(a.nextModel, "test/beta:high");
	assert.equal(sessionModel(f.main.getSessionFile()), "test/alpha:low");
});

test("a model picker cannot apply after navigating to another visit", async (t) => {
	const f = await setup(t);
	const first = await f.visit("first model target");
	assert.deepEqual(f.key("\x0c"), { consume: true });
	const picker = f.overlay();
	const second = await f.visit("second model target");
	picker.handleInput("gamma");
	picker.handleInput("\r");
	await nextTick();
	assert.equal(first.nextModel, undefined);
	assert.equal(second.nextModel, undefined);
	assert.equal(f.footer.session.model?.id, "beta");
});

test("a deferred model is saved before takeover, without needing a reply", async (t) => {
	const f = await setup(t);
	const a = await f.visit("pending model on handoff");
	f.ui.setEditorText("/model test/vendor/gamma:free");
	assert.deepEqual(f.key("\r"), { consume: true });
	await nextTick();
	assert.equal(sessionModel(a.sessionFile), "test/beta:low");
	assert.deepEqual(a.pending, []);
	// Simulate the background run ending before its foreground takeover.
	a.proc = undefined;
	a.state = "idle";
	releaseAgent(a.id);
	assert.equal(sessionModel(a.sessionFile), "test/vendor/gamma:free:low");
	assert.equal(registry().agents.has(a.id), false);
});

test("takeover rows show ⚑ regardless of which row is current", async (t) => {
	const f = await setup(t);
	const visited = await f.visit("viewed-row");
	const { list, done } = await f.openInbox();
	const viewedIndex = list.selected;
	const mainIndex = list.visible.findIndex(
		(row: any) => row.info.id === f.main.getSessionId(),
	);
	assert.notEqual(mainIndex, -1);
	while (list.selected !== mainIndex) {
		list.handleInput(list.selected < mainIndex ? "j" : "k");
	}
	for (const width of [80, 160]) {
		const lines: string[] = list.render(width);
		const flagged = lines.filter((line) => line.includes("⚑"));
		assert.equal(flagged.length, 1);
		assert.doesNotMatch(flagged[0], /»/);
		assert.equal(list.visible[mainIndex].isCurrent, false);
	}
	while (list.selected !== viewedIndex) {
		list.handleInput(list.selected < viewedIndex ? "j" : "k");
	}
	const mode = (globalThis as any)[Symbol.for("pi.inbox.mode")];
	mode.takenOver.clear();
	// The constructor's first async refresh may still be in flight; wait for a
	// completed reload to observe the cleared takeover state.
	for (let i = 0; i < 200; i++) {
		await list.refresh();
		if (!list.render(160).join("\n").includes("⚑")) break;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.doesNotMatch(list.render(160).join("\n"), /⚑/);
	assert.equal(list.visible[list.selected].info.id, visited.id);
	list.handleInput("\x1b");
	await done;
});

test("the viewed main shows both » and its takeover ⚑", async (t) => {
	const f = await setup(t);
	const { list, done } = await f.openInbox();
	const row = list.render(120).find((line: string) => line.includes("⚑"));
	assert.ok(row);
	assert.match(row, /»/);
	list.handleInput("\x1b");
	await done;
});

for (const takenOver of [false, true]) {
	test(`inbox selects the viewed row (takeover: ${takenOver})`, async (t) => {
		const f = await setup(t, takenOver);
		const id = takenOver
			? (await f.visit("the session on screen")).id
			: f.main.getSessionId();
		const { list, done } = await f.openInbox();
		assert.equal(list.visible[list.selected].info.id, id);
		assert.deepEqual(
			list.rows.filter((r: any) => r.isCurrent).map((r: any) => r.info.id),
			[id],
		);
		list.handleInput("\r");
		await done;
		assert.equal(visitingId(), takenOver ? id : undefined);
	});
}

test(
	"inbox remembers the reading position and the hotkey returns",
	async (t) => {
		const f = await setup(t);
		const viewport = f.tui as TUI & {
			viewportTop: number;
			flash: ReturnType<typeof mock.fn>;
		};
		viewport.viewportTop = 37;
		const { list, done } = await f.openInbox();
		list.handleInput("\x1b");
		await done;

		const store = JSON.parse(
			readFileSync(join(dir, "inbox.json"), "utf8"),
		);
		assert.equal(
			store.sessions[f.main.getSessionId()].scrollBookmark.top,
			37,
		);

		viewport.viewportTop = 91;
		await f.shortcuts.get("ctrl+b").handler(f.ctx);
		assert.equal(viewport.viewportTop, 37);

		await f.visit("another reading position");
		viewport.viewportTop = 52;
		const visitedInbox = await f.openInbox();
		visitedInbox.list.handleInput("\x1b");
		await visitedInbox.done;
		viewport.viewportTop = 91;
		await f.shortcuts.get("ctrl+shift+b").handler(f.ctx);
		assert.equal(viewport.viewportTop, 52);

		assert.deepEqual(f.key("\x1b"), { consume: true });
		viewport.viewportTop = 91;
		await f.shortcuts.get("ctrl+b").handler(f.ctx);
		assert.equal(viewport.viewportTop, 37);
		assert.equal(viewport.flash.mock.calls.length, 3);
	},
);

test("Ctrl+B restores a bookmark before editor cursor movement", async (t) => {
	const f = await setup(t);
	const viewport = f.tui as TUI & { viewportTop: number };
	viewport.viewportTop = 37;
	const { list, done } = await f.openInbox();
	list.handleInput("\x1b");
	await done;

	const editor = new CustomEditor(f.tui, {
		borderColor: (text) => text,
		selectList: getSelectListTheme(),
	}, getKeybindings());
	editor.onExtensionShortcut = (data) => {
		for (const [key, shortcut] of f.shortcuts) {
			if (!matchesKey(data, key)) continue;
			void shortcut.handler(f.ctx);
			return true;
		}
		return false;
	};
	for (const data of ["\x02", "\x1b[98;5u", "\x1b[27;5;98~"]) {
		editor.setText("draft");
		viewport.viewportTop = 91;
		editor.handleInput(data);
		assert.equal(viewport.viewportTop, 37);
		editor.insertTextAtCursor("!");
		assert.equal(editor.getText(), "draft!");
	}

	// The replacement does not take away normal arrow-key editing.
	editor.setText("draft");
	editor.handleInput("\x1b[D");
	editor.insertTextAtCursor("!");
	assert.equal(editor.getText(), "draf!t");
});

test("cached inbox rows follow each visit and can still reveal the main", async (t) => {
	const f = await setup(t);
	const first = await f.visit("first viewed session");
	let opened = await f.openInbox();
	assert.equal(opened.list.visible[opened.list.selected].info.id, first.id);
	opened.list.handleInput("\x1b");
	await opened.done;

	const second = await f.visit("second viewed session");
	opened = await f.openInbox();
	assert.equal(opened.list.visible[opened.list.selected].info.id, second.id);
	assert.deepEqual(
		opened.list.rows
			.filter((r: any) => r.isCurrent)
			.map((r: any) => r.info.id),
		[second.id],
	);
	const mainIndex = opened.list.visible.findIndex(
		(r: any) => r.info.id === f.main.getSessionId(),
	);
	assert.notEqual(mainIndex, -1);
	while (opened.list.selected !== mainIndex) {
		opened.list.handleInput(opened.list.selected < mainIndex ? "j" : "k");
	}
	opened.list.handleInput("\r");
	await opened.done;
	assert.equal(visitingId(), undefined);
});

test("interactive rename follows the view but agent tools stay on their runtime", async (t) => {
	const f = await setup(t);
	const visited = await f.visit("original visited title", false);
	const { list, done } = await f.openInbox();
	list.onRename(list.visible[list.selected], "renamed in the list");
	list.handleInput("\x1b");
	await done;
	const savedName = () =>
		SessionManager.open(visited.sessionFile!).getSessionName();
	assert.equal(savedName(), "renamed in the list");
	await f.commands.get("rename").handler("renamed via command", f.ctx);
	assert.equal(savedName(), "renamed via command");
	await f.shortcuts.get("ctrl+r").handler(f.ctx);
	assert.equal(savedName(), "renamed via shortcut");
	assert.equal((f.pi.setSessionName as any).mock.calls.length, 0);

	// A tool call from the running main must not rename whatever we are viewing.
	await f.tools
		.get("rename-chat")
		.execute(
			"test-call",
			{ title: "main renamed by its agent" },
			undefined,
			undefined,
			f.ctx,
		);
	assert.equal(f.main.getSessionName(), "main renamed by its agent");
	assert.equal(savedName(), "renamed via shortcut");
});

test("pin and archive target the viewed session", async (t) => {
	const f = await setup(t);
	const visited = await f.visit("metadata target");
	await f.commands.get("pin").handler("", f.ctx);
	await f.commands.get("archive").handler("", f.ctx);
	const store = JSON.parse(readFileSync(join(dir, "inbox.json"), "utf8"));
	assert.ok(store.sessions[visited.id].pinnedAt);
	assert.ok(store.sessions[visited.id].archivedAt);
	assert.equal(store.sessions[f.main.getSessionId()].pinnedAt, undefined);
	assert.equal(store.sessions[f.main.getSessionId()].archivedAt, undefined);
});

test("new-agent composition inherits the viewed directory", async (t) => {
	const f = await setup(t);
	const cwd = join(dir, "another-project");
	await f.visit("other project", true, cwd);
	assert.deepEqual(f.key("\x10"), { consume: true });
	await nextTick();
	const { list, done } = await f.openInbox();
	list.handleInput("n");
	await done;
	const globals = globalThis as any;
	assert.equal(globals[Symbol.for("pi.inbox.reply-target")].cwd, cwd);
	assert.equal(
		globals[Symbol.for("pi.inbox.reply-target")].model,
		"test/vendor/gamma:free:low",
	);
	assert.ok(
		globals[Symbol.for("pi.inbox.mode")].takenOver.has(f.main.getSessionId()),
	);
});

test("group view filters sessions and prefills new agents", async (t) => {
	const f = await setup(t);
	const a = await f.visit("in review group");
	const groups = new InboxGroups(dir);
	const reviews = await groups.create("PR reviews");
	await groups.assign(a.id, reviews.id);
	await groups.setTemplate(reviews.id, "Use gh-pr-review\nPR: ", true);
	const { list, done } = await f.openInbox();
	list.handleInput("\x07");
	await nextTick();
	assert.equal(f.overlay().constructor.name, "GroupSelector");
	f.overlay().handleInput("PR");
	f.overlay().handleInput("1");
	await nextTick();
	const scoped = f.overlay();
	const rendered = scoped.render(120).join("\n");
	assert.match(rendered, /Group: PR reviews/);
	assert.match(rendered, /in review group/);
	assert.doesNotMatch(rendered, /taken-over main/);
	scoped.handleInput("n");
	await done;
	const target = (globalThis as any)[Symbol.for("pi.inbox.reply-target")];
	assert.equal(target.groupId, reviews.id);
	assert.equal(f.ui.getEditorText(), "Use gh-pr-review\nPR: ");
	assert.match(f.widgets.get("inbox-reply").render(200).join("\n"),
		/group PR reviews/);
});

test("Ctrl+G changes groups without clobbering edited drafts", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const a = await groups.create("A");
	const b = await groups.create("B");
	await groups.setTemplate(a.id, "first", true);
	await groups.setTemplate(b.id, "second", true);
	(globalThis as any)[Symbol.for("pi.inbox.group-view")] = a.id;
	const { list, done } = await f.openInbox();
	list.handleInput("n");
	await done;
	assert.equal(f.ui.getEditorText(), "first");
	assert.deepEqual(f.key("\x07"), { consume: true });
	f.overlay().handleInput("B");
	f.overlay().handleInput("1");
	await nextTick();
	assert.equal(f.ui.getEditorText(), "second");
	f.ui.setEditorText("second + URL");
	assert.deepEqual(f.key("\x07"), { consume: true });
	f.overlay().handleInput("A");
	f.overlay().handleInput("1");
	await nextTick();
	assert.equal(f.ui.getEditorText(), "second + URL");
	assert.equal((globalThis as any)[Symbol.for("pi.inbox.reply-target")]
		.groupId, a.id);
	assert.deepEqual(f.key("\x07"), { consume: true });
	f.overlay().handleInput("\x1b");
	await nextTick();
	assert.equal(f.ui.getEditorText(), "second + URL");
	assert.deepEqual(f.key("\x1b"), { consume: true });
	assert.equal(f.key("\x07"), undefined);
});

test("/group moves a busy visit without touching its runtime", async (t) => {
	const f = await setup(t);
	const a = await f.visit("running review");
	const groups = new InboxGroups(dir);
	const group = await groups.create("Reviews");
	const before = readFileSync(a.sessionFile!, "utf8");
	const mainBefore = readFileSync(f.main.getSessionFile()!, "utf8");
	const proc = a.proc;
	const done = f.commands.get("group").handler("", f.ctx);
	f.overlay().handleInput("Rev");
	f.overlay().handleInput("1");
	await done;
	assert.equal(groups.load().sessions[a.id], group.id);
	assert.equal(groups.load().sessions[f.main.getSessionId()], undefined);
	assert.equal(a.proc, proc);
	assert.equal(a.state, "working");
	assert.equal(readFileSync(a.sessionFile!, "utf8"), before);
	assert.equal(readFileSync(f.main.getSessionFile()!, "utf8"), mainBefore);
	assert.equal((proc!.kill as any).mock.calls.length, 0);
	assert.equal(f.key("\x07"), undefined);
});

test("membership is saved before starting a new agent", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const group = await groups.create("Reviews");
	(globalThis as any)[Symbol.for("pi.inbox.group-view")] = group.id;
	const { list, done } = await f.openInbox();
	list.handleInput("n");
	await done;
	// Occupy all slots using fake process handles: NEVER launch real children.
	const busy = await f.visit("slot blocker");
	for (let i = 0; i < 6; i++) {
		registry().agents.set(`blocker-${i}`, { ...busy, id: `blocker-${i}` });
	}
	// Avoid the interactive auto-open watcher; test only the routing boundary.
	(globalThis as any)[Symbol.for("pi.inbox.mode")].on = false;
	const result = await f.emit("input", {
		source: "interactive", text: "review URL",
	});
	assert.deepEqual(result, [{ action: "handled" }]);
	const agent = [...registry().agents.values()].find(
		(agent) => agent.title === "review URL",
	)!;
	assert.ok(agent);
	assert.equal(agent.proc, undefined);
	assert.equal(groups.load().sessions[agent.id], group.id);
	assert.deepEqual(agent.pending, ["review URL"]);
	assert.equal((globalThis as any)[Symbol.for("pi.inbox.reply-target")],
		undefined);
});

test("deleted destinations preserve the draft and start no agent", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const group = await groups.create("Reviews");
	(globalThis as any)[Symbol.for("pi.inbox.group-view")] = group.id;
	const { list, done } = await f.openInbox();
	list.handleInput("n");
	await done;
	await groups.remove(group.id);
	const result = await f.emit("input", {
		source: "interactive", text: "review URL",
	});
	assert.deepEqual(result, [{ action: "handled" }]);
	assert.equal(registry().agents.size, 0);
	assert.equal(f.ui.getEditorText(), "review URL");
	assert.match(f.ui.notify.mock.calls.at(-1)!.arguments[0],
		/Agent not started/);
});

test("selector can create, rename, edit and enable a template", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const { list, done } = await f.openInbox();
	list.handleInput("\x07");
	await nextTick();
	f.ui.input.mock.mockImplementation(async () => "Reviews");
	f.overlay().handleInput("\x01");
	await nextTick();
	assert.equal(groups.load().groups[0].name, "Reviews");
	f.ui.input.mock.mockImplementation(async () => "PR reviews");
	assert.deepEqual(f.key("\x12"), { consume: true });
	await nextTick();
	assert.equal(groups.load().groups[0].name, "PR reviews");
	assert.deepEqual(f.key("\x14"), { consume: true });
	await nextTick();
	assert.equal(groups.load().groups[0].template, "Use gh-pr-review\n\nPR: ");
	assert.equal(groups.load().groups[0].templateEnabled, false);
	f.ui.select.mock.mockImplementation(async () => "Enable template");
	assert.deepEqual(f.key("\x14"), { consume: true });
	await nextTick();
	assert.equal(groups.load().groups[0].templateEnabled, true);
	f.overlay().handleInput("\r");
	await nextTick();
	f.overlay().handleInput("n");
	await done;
	assert.equal(f.ui.getEditorText(), "Use gh-pr-review\n\nPR: ");
	assert.equal(f.key("\x14"), undefined, "picker shortcuts are released");
});

test("deletion requires confirmation and never deletes a session", async (t) => {
	const f = await setup(t);
	const a = await f.visit("session to keep");
	const before = readFileSync(a.sessionFile!, "utf8");
	const groups = new InboxGroups(dir);
	const group = await groups.create("Reviews");
	await groups.assign(a.id, group.id);
	const { list, done } = await f.openInbox();
	list.handleInput("\x07");
	await nextTick();
	f.overlay().handleInput("Rev");
	f.overlay().handleInput("\x04");
	await nextTick();
	assert.equal(f.overlay().constructor.name, "ConfirmComponent");
	f.overlay().handleInput("n");
	await nextTick();
	assert.equal(groups.load().groups.length, 1);
	f.overlay().handleInput("\x04");
	await nextTick();
	f.overlay().handleInput("y");
	await nextTick();
	assert.equal(groups.load().groups.length, 0);
	assert.equal(groups.load().sessions[a.id], undefined);
	assert.equal(readFileSync(a.sessionFile!, "utf8"), before);
	f.overlay().handleInput("\x1b");
	await nextTick();
	f.overlay().handleInput("\x1b");
	await done;
});

test("completion is read only for the session actually on screen", async (t) => {
	const f = await setup(t);
	const visited = await f.visit("watched agent");
	const file = join(dir, "inbox.json");
	const store = JSON.parse(readFileSync(file, "utf8"));
	store.sessions[f.main.getSessionId()].seenAt = 1;
	writeFileSync(file, JSON.stringify(store));
	await f.emit("agent_settled");
	assert.equal(
		JSON.parse(readFileSync(file, "utf8")).sessions[f.main.getSessionId()]
			.seenAt,
		1,
	);

	visited.state = "idle";
	visited.proc = undefined;
	visited.needsYou = true;
	for (const listener of registry().listeners) {
		listener({ type: "finished", agent: visited });
	}
	assert.equal(visited.needsYou, false);
	assert.equal(f.ui.notify.mock.calls.length, 0);
});
