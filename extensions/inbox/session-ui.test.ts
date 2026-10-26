import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test, type TestContext } from "node:test";
import {
	CustomEditor,
	getSelectListTheme,
	initTheme,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Container,
	getKeybindings,
	KeybindingsManager,
	matchesKey,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
	type AutocompleteProvider,
	type TUI,
} from "@earendil-works/pi-tui";
import type { BgAgent } from "../../lib/inbox-agents.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { InboxGroups } from "./groups.ts";
import { WorkerFolds } from "./families.ts";
import inlineSkills from "../inline-skills/index.ts";

// Import only after isolating every inbox write from the operator's data.
const dir = mkdtempSync(join(tmpdir(), "pi-queue-test-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
writeFileSync(join(dir, "notify.json"), JSON.stringify({ enabled: false }));
const { default: inbox } = await import("./index.ts");
const {
	applyEvent,
	MAX_CONCURRENT,
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
		scrollBy(
			this: { viewportTop: number; requestRender(): void },
			lines: number,
		) {
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
		getCommands: () => [...commands.keys()].map((name) => ({
			name, description: name, source: "extension",
			sourceInfo: { path: "test" },
		})),
		getThinkingLevel: () => foregroundSession.state.thinkingLevel,
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
	const autocompleteWrappers: Array<
		(current: AutocompleteProvider) => AutocompleteProvider
	> = [];
	let autocomplete: AutocompleteProvider;
	const ui = {
		tui,
		addAutocompleteProvider(
			factory: (typeof autocompleteWrappers)[number],
		) {
			autocompleteWrappers.push(factory);
			autocomplete = new CombinedAutocompleteProvider(
				[{ name: "help", description: "Help" }, ...pi.getCommands()],
				dir,
			);
			for (const wrap of autocompleteWrappers) {
				autocomplete = wrap(autocomplete);
			}
		},
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
			return () => {
				terminalInputs.delete(fn);
			};
		},
		custom(factory: Function) {
			return new Promise((resolve) => {
				overlay = factory(
					tui,
					theme,
					getKeybindings(),
					(result: any) => {
						overlay?.dispose?.();
						focus = editor;
						resolve(result);
					},
				);
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
		// Orchestrator clone (cloneLatest) lands here; tests can capture the target.
		switchSession: mock.fn(async () => ({ cancelled: false })),
	} as unknown as ExtensionCommandContext;

	async function emit(
		name: string,
		event: any = {},
		context: ExtensionCommandContext = ctx,
	) {
		const results = [];
		for (const handler of handlers.get(name) ?? []) {
			results.push(await handler(event, context));
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
		delete globals[Symbol.for("pi.inbox.next-agent-group")];
		delete globals[Symbol.for("pi.inbox.group-view")];
		delete globals[Symbol.for("pi.inbox.group-layout")];
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
		autocomplete: () => autocomplete,
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
	await f.emit("input", {
		source: "interactive",
		text: "first queued reply",
	});
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
			list.rows
				.filter((r: any) => r.isCurrent)
				.map((r: any) => r.info.id),
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

	const editor = new CustomEditor(
		f.tui,
		{
			borderColor: (text) => text,
			selectList: getSelectListTheme(),
		},
		getKeybindings() as ConstructorParameters<typeof CustomEditor>[2],
	);
	editor.onExtensionShortcut = (data) => {
		for (const [key, shortcut] of f.shortcuts) {
			if (!matchesKey(data, key as Parameters<typeof matchesKey>[1]))
				continue;
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

test("new-agent composition uses the viewed directory and main model",
	async (t) => {
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
		// Keep the viewed directory, but use the main's model, not the visit's.
		assert.equal(
			globals[Symbol.for("pi.inbox.reply-target")].model,
			"test/alpha:low",
		);
		assert.ok(globals[Symbol.for("pi.inbox.mode")].takenOver.has(
			f.main.getSessionId(),
		));
	});

function mockHomeSwitch(f: Awaited<ReturnType<typeof setup>>) {
	f.ctx.model = models[1];
	const home = SessionManager.create(dir);
	home.appendModelChange("test", "alpha");
	home.appendThinkingLevelChange("low");
	const fresh = { ...f.ctx, sessionManager: home, model: models[0] };
	f.ctx.newSession = mock.fn(async (options) => {
		await f.emit("session_start", { reason: "new" }, fresh);
		await options?.withSession?.(fresh as any);
		return { cancelled: false };
	});
	return fresh;
}

test("new-agent default follows the fresh home model, not the attached model",
	async (t) => {
		const f = await setup(t, false);
		const fresh = mockHomeSwitch(f);
		const { list, done } = await f.openInbox();
		list.handleInput("n");
		await done;
		const target = (globalThis as any)[
			Symbol.for("pi.inbox.reply-target")
		];
		assert.equal(target.model, "test/alpha:low");
		assert.equal(fresh.model.id, "alpha");
		assert.match(f.widgets.get("inbox-reply").render(120).join("\n"),
			/test\/alpha:low/);
		// Keep launch slots occupied so routing can be tested without a child
		// process or a provider request. The queued agent must use this model.
		t.mock.timers.enable({ apis: ["setInterval"] });
		for (let i = 0; i < MAX_CONCURRENT; i++) {
			const id = `busy-${i}`;
			registry().agents.set(id, {
				id, cwd: dir, title: id, state: "working",
				proc: { kill: mock.fn() }, pending: [],
				createdAt: 0, updatedAt: 0, needsYou: false,
				runs: 1, log: [], liveText: "",
			} as BgAgent);
		}
		await f.emit("input", {
			source: "interactive", text: "run on the home model",
		}, fresh);
		const queued = [...registry().agents.values()].find(
			(a) => a.state === "queued",
		);
		assert.equal(queued?.model, "test/alpha:low");
		assert.deepEqual(queued?.pending, ["run on the home model"]);
	});

test("cancelling the home switch cancels the new-agent draft", async (t) => {
	const f = await setup(t, false);
	f.ctx.newSession = mock.fn(async () => ({ cancelled: true }));
	const { list, done } = await f.openInbox();
	list.handleInput("n");
	await nextTick();
	assert.equal((globalThis as any)[
		Symbol.for("pi.inbox.reply-target")
	], undefined);
	f.overlay().handleInput("\x1b");
	await done;
});

test("an explicit new-agent model survives the switch to blank home",
	async (t) => {
		const f = await setup(t, false);
		mockHomeSwitch(f);
		f.ui.select = mock.fn(async () => "test/vendor/gamma:free:high");
		const { list, done } = await f.openInbox();
		list.handleInput("N");
		await done;
		assert.equal((globalThis as any)[
			Symbol.for("pi.inbox.reply-target")
		].model, "test/vendor/gamma:free:high");
	});

async function composeOnAnotherModel(
	f: Awaited<ReturnType<typeof setup>>,
) {
	f.ui.select = mock.fn(async () => "test/beta:low");
	const { list, done } = await f.openInbox();
	list.handleInput("N");
	await done;
	return (globalThis as any)[Symbol.for("pi.inbox.reply-target")];
}

test("confirming the current model repairs a different pending agent model",
	async (t) => {
		const f = await setup(t);
		const target = await composeOnAnotherModel(f);
		// Pi emits no model_select when alpha is selected again.
		(f.pi.setModel as any).mock.mockImplementation(async () => true);
		assert.equal(target.model, "test/beta:low");
		assert.deepEqual(f.key("\x0c"), { consume: true });
		assert.equal(f.overlay().constructor.name, "ModelSelectorComponent");
		f.overlay().handleInput("alpha");
		f.overlay().handleInput("\r");
		await nextTick();
		assert.equal(target.model, "test/alpha:low");
		assert.equal((f.pi.setModel as any).mock.calls[0].arguments[0],
			models[0]);
	});

test("/model can reselect the current model for a pending agent", async (t) => {
	const f = await setup(t);
	const target = await composeOnAnotherModel(f);
	(f.pi.setModel as any).mock.mockImplementation(async () => true);
	f.ui.setEditorText("/model test/alpha");
	assert.deepEqual(f.key("\r"), { consume: true });
	await nextTick();
	assert.equal(target.model, "test/alpha:low");
	assert.equal(f.ui.getEditorText(), "");
});

test("cancelling a pending-agent model picker preserves its choice",
	async (t) => {
		const f = await setup(t);
		const target = await composeOnAnotherModel(f);
		assert.deepEqual(f.key("\x0c"), { consume: true });
		f.overlay().handleInput("\x1b");
		await nextTick();
		assert.equal(target.model, "test/beta:low");
		assert.equal((f.pi.setModel as any).mock.calls.length, 0);
	});

test("a pending-agent model picker cannot apply to a replaced draft",
	async (t) => {
		const f = await setup(t);
		const target = await composeOnAnotherModel(f);
		assert.deepEqual(f.key("\x0c"), { consume: true });
		delete (globalThis as any)[Symbol.for("pi.inbox.reply-target")];
		f.overlay().handleInput("alpha");
		f.overlay().handleInput("\r");
		await nextTick();
		assert.equal(target.model, "test/beta:low");
		assert.equal((f.pi.setModel as any).mock.calls.length, 0);
	});

test("an unavailable model cannot replace the pending agent's choice",
	async (t) => {
		const f = await setup(t);
		const target = await composeOnAnotherModel(f);
		(f.pi.setModel as any).mock.mockImplementation(async () => false);
		f.ui.setEditorText("/model test/alpha");
		assert.deepEqual(f.key("\r"), { consume: true });
		await nextTick();
		assert.equal(target.model, "test/beta:low");
		assert.equal(f.ui.notify.mock.calls.at(-1)?.arguments[1], "warning");
	});

test("opening a visit invalidates a pending-agent model picker", async (t) => {
	const f = await setup(t);
	const target = await composeOnAnotherModel(f);
	assert.deepEqual(f.key("\x0c"), { consume: true });
	const picker = f.overlay();
	const a = await f.visit("another session");
	picker.handleInput("alpha");
	picker.handleInput("\r");
	await nextTick();
	assert.equal(target.model, "test/beta:low");
	assert.equal(a.nextModel, undefined);
	assert.equal((f.pi.setModel as any).mock.calls.length, 0);
});

test("reloading extensions invalidates a pending-agent model picker",
	async (t) => {
		const f = await setup(t);
		const target = await composeOnAnotherModel(f);
		assert.deepEqual(f.key("\x0c"), { consume: true });
		(globalThis as any).__piInboxPi = {};
		f.overlay().handleInput("alpha");
		f.overlay().handleInput("\r");
		await nextTick();
		assert.equal(target.model, "test/beta:low");
		assert.equal((f.pi.setModel as any).mock.calls.length, 0);
	});

async function waitForList(list: any) {
	for (let i = 0; i < 200 && list.loading; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(list.loading, false);
}

function searchList(list: any, query: string) {
	list.handleInput("/");
	for (const char of query) list.handleInput(char);
	list.handleInput("\r");
}

function closeList(list: any) {
	if (list.state.query) list.handleInput("\x1b");
	list.handleInput("\x1b");
}

async function layoutFixture(t: TestContext, archived = false) {
	const f = await setup(t);
	const tag = `layout-${f.main.getSessionId()}`;
	f.main.appendSessionInfo(`${tag} ungrouped`);
	const a = await f.visit(`${tag} review normal`);
	const b = await f.visit(`${tag} review pinned`);
	const c = await f.visit(`${tag} bug`);
	const filtered = archived ? await f.visit(`${tag} hidden`) : undefined;
	const groups = new InboxGroups(dir);
	const reviews = await groups.create("Z Reviews");
	const bugs = await groups.create("A Bugs");
	await groups.create("Empty group");
	await groups.assign(a.id, reviews.id);
	await groups.assign(b.id, reviews.id);
	await groups.assign(c.id, bugs.id);
	if (filtered) await groups.assign(filtered.id, bugs.id);
	const file = join(dir, "inbox.json");
	const meta = JSON.parse(readFileSync(file, "utf8"));
	meta.sessions[b.id] = { ...meta.sessions[b.id], pinnedAt: 1 };
	if (archived) {
		meta.sessions[a.id] = { ...meta.sessions[a.id], archivedAt: 200 };
		meta.sessions[b.id].archivedAt = 100;
		meta.sessions[filtered!.id] = { filter: "hide", archivedAt: 300 };
	}
	writeFileSync(file, JSON.stringify(meta));
	const { list, done } = await f.openInbox();
	await waitForList(list);
	searchList(list, tag);
	return { ...f, list, done, tag, groups, reviews, bugs, a, b, c, filtered };
}

function sectionLabels(list: any): string[] {
	return list.display.filter((item: any) => item.kind === "header")
		.map((item: any) => item.label);
}

function rowIds(list: any): string[] {
	return list.visible.map((row: any) => row.info.id);
}

function renderedRows(list: any, width: number): Map<string, string> {
	const lines = list.render(width);
	const rows = new Map<string, string>();
	for (let i = 0; i < list.listHeight(); i++) {
		const item = list.display[list.scroll + i];
		if (item?.kind === "item") rows.set(item.row.info.id, lines[4 + i]);
	}
	return rows;
}

test("flat rows show aligned group names and Ungrouped", async (t) => {
	const f = await layoutFixture(t);
	const selected = f.list.state.selectedId;
	const rows = renderedRows(f.list, 180);
	assert.match(rows.get(f.a.id)!, /Z Reviews/);
	assert.match(rows.get(f.b.id)!, /Z Reviews/);
	assert.match(rows.get(f.c.id)!, /A Bugs/);
	assert.match(rows.get(f.main.getSessionId())!, /Ungrouped/);
	const groupColumn = (line: string, name: string) =>
		visibleWidth(line.slice(0, line.indexOf(name)));
	const column = groupColumn(rows.get(f.a.id)!, "Z Reviews");
	assert.equal(groupColumn(rows.get(f.c.id)!, "A Bugs"), column);
	assert.equal(groupColumn(rows.get(f.main.getSessionId())!, "Ungrouped"),
		column);
	assert.equal(f.list.state.selectedId, selected);
	f.list.handleInput("s");
	const grouped = renderedRows(f.list, 180);
	assert.doesNotMatch(grouped.get(f.a.id)!, /Z Reviews/);
	assert.doesNotMatch(grouped.get(f.c.id)!, /A Bugs/);
	assert.doesNotMatch(grouped.get(f.main.getSessionId())!, /Ungrouped/);
	assert.equal(f.list.state.selectedId, selected);
	closeList(f.list);
	await f.done;
});

test("scoped flat views show groups despite grouped preference", async (t) => {
	const f = await layoutFixture(t);
	f.list.handleInput("s");
	f.list.handleInput("g");
	await nextTick();
	f.overlay().handleInput("Z");
	f.overlay().handleInput("1");
	await nextTick();
	const list = f.overlay();
	await waitForList(list);
	for (const row of renderedRows(list, 180).values()) {
		assert.match(row, /Z Reviews/);
	}
	closeList(list);
	await f.done;
});

test("flat group columns work in Archived, All and Filtered", async (t) => {
	const f = await layoutFixture(t, true);
	f.list.handleInput("2");
	await waitForList(f.list);
	for (const row of renderedRows(f.list, 180).values()) {
		assert.match(row, /Z Reviews/);
	}
	f.list.handleInput("3");
	const all = renderedRows(f.list, 180);
	assert.match(all.get(f.c.id)!, /A Bugs/);
	assert.match(all.get(f.a.id)!, /Z Reviews/);
	f.list.handleInput("4");
	assert.match(renderedRows(f.list, 180).get(f.filtered!.id)!, /A Bugs/);
	closeList(f.list);
	await f.done;
});

test("long and wide group names fit narrow terminals", async (t) => {
	const f = await layoutFixture(t);
	await f.groups.rename(f.reviews.id, "安全🔎 Reviews with a very long name");
	f.list.handleInput("R");
	await waitForList(f.list);
	const wide = renderedRows(f.list, 180).get(f.a.id)!;
	assert.match(wide, /安全🔎/);
	assert.doesNotMatch(wide, /安全🔎 Reviews with a very long name/);
	for (const width of [40, 60, 80, 120, 180]) {
		assert.ok(f.list.render(width).every((line: string) =>
			visibleWidth(line) <= width));
	}
	closeList(f.list);
	await f.done;
});

test("pins-first group layout preserves selection", async (t) => {
	const f = await layoutFixture(t);
	const selected = f.list.state.selectedId;
	const files = [
		f.main.getSessionFile()!,
		f.a.sessionFile!,
		f.b.sessionFile!,
		f.c.sessionFile!,
	];
	const before = files.map((file) => readFileSync(file, "utf8"));
	const groupsBefore = readFileSync(f.groups.file, "utf8");
	assert.match(f.list.render(120).join("\n"), /Layout: flat/);
	assert.deepEqual(sectionLabels(f.list), ["★ PINNED (1)", "INBOX (3)"]);
	f.list.handleInput("s");
	assert.match(f.list.render(120).join("\n"), /Layout: by group/);
	assert.deepEqual(sectionLabels(f.list), [
		"A Bugs (1)",
		"Z Reviews (2)",
		"Ungrouped (1)",
	]);
	assert.deepEqual(rowIds(f.list), [
		f.c.id,
		f.b.id,
		f.a.id,
		f.main.getSessionId(),
	]);
	assert.equal(f.list.state.selectedId, selected);
	f.list.handleInput("\x1b[115;1:2u");
	f.list.handleInput("\x1b[115;1:3u");
	assert.match(f.list.render(120).join("\n"), /Layout: by group/);
	f.list.handleInput("s");
	assert.equal(f.list.state.selectedId, selected);
	assert.deepEqual(sectionLabels(f.list), ["★ PINNED (1)", "INBOX (3)"]);
	assert.deepEqual(
		files.map((file) => readFileSync(file, "utf8")),
		before,
	);
	// Layout toggles legitimately persist to inbox-groups.json; membership must not move.
	assert.deepEqual(
		JSON.parse(readFileSync(f.groups.file, "utf8")).sessions,
		JSON.parse(groupsBefore).sessions,
	);
	closeList(f.list);
	await f.done;
});

test("group sections respect tabs and archive sorting", async (t) => {
	const f = await layoutFixture(t, true);
	f.list.handleInput("s");
	assert.deepEqual(sectionLabels(f.list), ["A Bugs (1)", "Ungrouped (1)"]);
	f.list.handleInput("2");
	await waitForList(f.list);
	assert.deepEqual(sectionLabels(f.list), ["Z Reviews (2)"]);
	assert.deepEqual(rowIds(f.list), [f.a.id, f.b.id]);
	f.list.handleInput("3");
	assert.deepEqual(sectionLabels(f.list), [
		"A Bugs (1)",
		"Z Reviews (2)",
		"Ungrouped (1)",
	]);
	assert.equal(rowIds(f.list).includes(f.filtered!.id), false);
	f.list.handleInput("4");
	assert.deepEqual(sectionLabels(f.list), ["A Bugs (1)"]);
	assert.deepEqual(rowIds(f.list), [f.filtered!.id]);
	closeList(f.list);
	await f.done;
});

test("search updates counts; typed s stays search text", async (t) => {
	const f = await layoutFixture(t);
	f.list.handleInput("s");
	f.list.handleInput("/");
	for (const char of " review") f.list.handleInput(char);
	f.list.handleInput("\r");
	assert.deepEqual(sectionLabels(f.list), ["Z Reviews (2)"]);
	f.list.handleInput("/");
	f.list.handleInput("s");
	assert.equal(f.list.state.query, `${f.tag} reviews`);
	assert.equal((globalThis as any)[Symbol.for("pi.inbox.group-layout")],
		"groups");
	f.list.handleInput("\x1b");
	closeList(f.list);
	await f.done;
});

test("single-group filters retain the layout preference", async (t) => {
	const f = await layoutFixture(t);
	f.list.handleInput("s");
	f.list.handleInput("\x07");
	await nextTick();
	f.overlay().handleInput("Z");
	f.overlay().handleInput("1");
	await nextTick();
	const single = f.overlay();
	await waitForList(single);
	assert.deepEqual(sectionLabels(single), ["★ PINNED (1)", "INBOX (1)"]);
	single.handleInput("s");
	assert.equal((globalThis as any)[Symbol.for("pi.inbox.group-layout")],
		"groups");
	single.handleInput("\x07");
	await nextTick();
	f.overlay().handleInput("All");
	f.overlay().handleInput("1");
	await nextTick();
	const all = f.overlay();
	assert.match(all.render(120).join("\n"), /Layout: by group/);
	assert.equal(sectionLabels(all).length, 3);
	closeList(all);
	await f.done;
	const reopened = await f.openInbox();
	assert.match(reopened.list.render(120).join("\n"), /Layout: by group/);
	closeList(reopened.list);
	await reopened.done;
});

test("g opens groups; Home jumps top; search g stays text", async (t) => {
	const f = await setup(t);
	await f.visit("navigation target");
	const { list, done } = await f.openInbox();
	list.handleInput("\x1b[F");
	assert.equal(list.selected, list.visible.length - 1);
	list.handleInput("\x1b[H");
	assert.equal(list.selected, 0);
	// (G used to be tested here as a no-op jump-to-bottom; it now starts a new
	// agent in the selected row's group — covered by its own tests below.)
	list.handleInput("/");
	list.handleInput("g");
	assert.equal(list.state.query, "g");
	assert.equal(f.overlay(), list);
	list.handleInput("\x1b");
	list.handleInput("g");
	await nextTick();
	assert.equal(f.overlay().constructor.name, "GroupSelector");
	f.overlay().handleInput("\x1b");
	await nextTick();
	f.overlay().handleInput("\x1b");
	await done;
});

test("default picker updates the header and new-agent template", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const reviews = await groups.create("Reviews");
	await groups.setTemplate(reviews.id, "review template", true);
	const { list, done } = await f.openInbox();
	const initial = list.render(120);
	assert.match(initial[0], /orchestrator.*default: Ungrouped/);
	assert.match(initial[2], /Group: All groups.*f next group · F default group/);
	assert.match(initial[3], /^├/);
	assert.equal(initial.some((line: string) =>
		line.includes("New-agent default:")), false);
	list.handleInput("F");
	await nextTick();
	assert.match(f.overlay().render(100).join("\n"), /Default group for/);
	f.overlay().handleInput("Rev");
	f.overlay().handleInput("1");
	await nextTick();
	assert.equal(groups.load().defaultGroupId, reviews.id);
	assert.match(f.overlay().render(120)[0], /default: Reviews/);
	f.overlay().handleInput("n");
	await done;
	assert.equal((globalThis as any)[Symbol.for("pi.inbox.reply-target")]
		.groupId, reviews.id);
	assert.equal(f.ui.getEditorText(), "review template");
});

test("view and one-shot Ungrouped choices override the default", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const reviews = await groups.create("Reviews");
	const bugs = await groups.create("Bugs");
	await groups.setDefaultGroup(reviews.id);
	(globalThis as any)[Symbol.for("pi.inbox.group-view")] = bugs.id;
	const { list, done } = await f.openInbox();
	list.handleInput("n");
	await done;
	const target = () =>
		(globalThis as any)[Symbol.for("pi.inbox.reply-target")];
	assert.equal(target().groupId, bugs.id);
	assert.deepEqual(f.key("\x07"), { consume: true });
	f.overlay().handleInput("U");
	f.overlay().handleInput("1");
	await nextTick();
	assert.equal(target().groupId, undefined);
	assert.deepEqual(f.key("\x07"), { consume: true });
	const picker = f.overlay();
	assert.equal(picker.matches()[picker.selected].scope, "ungrouped");
	picker.handleInput("\x1b");
	await nextTick();
	f.key("\x1b");
	(globalThis as any)[Symbol.for("pi.inbox.group-view")] = "ungrouped";
	const next = await f.openInbox();
	next.list.handleInput("n");
	await next.done;
	assert.equal(target().groupId, undefined);
});

test("f pre-picks a one-off group for the next new agent", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const reviews = await groups.create("Reviews");
	const bugs = await groups.create("Bugs");
	// A persistent default exists: the one-off must beat it.
	await groups.setDefaultGroup(bugs.id);
	const { done } = await f.openInbox();
	const list = f.overlay();
	list.handleInput("f");
	await nextTick();
	const picker = f.overlay();
	assert.match(picker.render(100).join("\n"), /Group for the next new agent/);
	picker.handleInput("Rev");
	picker.handleInput("1");
	await nextTick();
	// The loop reopened the list; the pending pick shows on the group line.
	const reopened = f.overlay();
	assert.match(reopened.render(120)[2], /next: Reviews/);
	reopened.handleInput("n");
	await done;
	const target = (globalThis as any)[Symbol.for("pi.inbox.reply-target")];
	assert.equal(target.groupId, reviews.id);
});

test("G starts a new agent in the selected session's group", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const reviews = await groups.create("Reviews");
	const bugs = await groups.create("Bugs");
	// Both the one-off pre-pick and a persistent default exist: the row's own group must win.
	await groups.setDefaultGroup(bugs.id);
	(globalThis as any)[Symbol.for("pi.inbox.next-agent-group")] = bugs.id;
	const a = await f.visit("grouped session");
	await groups.assign(a.id, reviews.id);
	const { list, done } = await f.openInbox();
	list.handleInput("G");
	await done;
	const target = (globalThis as any)[Symbol.for("pi.inbox.reply-target")];
	assert.equal(target.kind, "new");
	assert.equal(target.groupId, reviews.id);
});

test("G on an ungrouped row forces the next agent Ungrouped", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const bugs = await groups.create("Bugs");
	await groups.setDefaultGroup(bugs.id);
	const a = await f.visit("ungrouped session");
	const { list, done } = await f.openInbox();
	list.handleInput("G");
	await done;
	const target = (globalThis as any)[Symbol.for("pi.inbox.reply-target")];
	assert.equal(target.kind, "new");
	assert.equal(target.groupId, undefined, "the row's Ungrouped beats the default");
});

test("f Ungrouped forces the next agent out of any default", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const bugs = await groups.create("Bugs");
	await groups.setDefaultGroup(bugs.id);
	const { done } = await f.openInbox();
	const list = f.overlay();
	list.handleInput("f");
	await nextTick();
	const picker = f.overlay();
	picker.handleInput("U");
	picker.handleInput("1");
	await nextTick();
	f.overlay().handleInput("n");
	await done;
	const target = (globalThis as any)[Symbol.for("pi.inbox.reply-target")];
	assert.equal(target.groupId, undefined);
});

test("template editor shares slash and inline-skill completion", async (t) => {
	const f = await setup(t);
	const original = f.pi.getCommands;
	f.pi.getCommands = () => [
		...original(),
		{
			name: "skill:reviewer",
			description: "Sample review skill",
			source: "skill",
			sourceInfo: {
				path: join(dir, "reviewer", "SKILL.md"),
				baseDir: dir,
				source: "test",
				scope: "temporary",
				origin: "top-level",
			},
		},
	];
	// Install the real $skill wrapper BEFORE opening the template editor.
	inlineSkills(f.pi);
	await f.emit("session_start");
	const groups = new InboxGroups(dir);
	const reviews = await groups.create("Reviews");
	const { list, done } = await f.openInbox();
	list.handleInput("\x07");
	await nextTick();
	const picker = f.overlay();
	picker.handleInput("Rev");
	f.key("\x05");
	assert.equal(picker.editor.autocompleteProvider, f.autocomplete());
	picker.handleInput("/he");
	await nextTick();
	assert.equal(picker.editor.isShowingAutocomplete(), true);
	picker.handleInput("\t");
	assert.match(picker.editor.getExpandedText(), /^\/help\s?$/);
	// Start a new inline editor with empty text for an in-place $skill token.
	picker.handleInput("\x1b");
	f.key("\x05");
	picker.handleInput("Use $rev");
	// Inline triggers use the normal editor's attachment debounce.
	for (let i = 0; i < 100 && !picker.editor.isShowingAutocomplete(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(picker.editor.isShowingAutocomplete(), true);
	picker.handleInput("\t");
	assert.equal(picker.editor.getExpandedText(), "Use $reviewer ");
	f.key("\x13");
	await nextTick();
	assert.equal(groups.load().groups[0].template, "Use $reviewer ");
	assert.equal(groups.load().groups[0].id, reviews.id);
	assert.equal(picker.editor, undefined);
	assert.equal(f.ui.getEditorText(), "");
	picker.handleInput("\x1b");
	await nextTick();
	f.overlay().handleInput("\x1b");
	await done;
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
	assert.deepEqual(f.key("\x1b[110;5:1u"), { consume: true });
	assert.match(f.overlay().render(100).join("\n"), /Digits: text/);
	assert.deepEqual(f.key("\x1b[110;5:2u"), { consume: true });
	assert.match(f.overlay().render(100).join("\n"), /Digits: text/);
	assert.deepEqual(f.key("\x1b[110;5:3u"), { consume: true });
	assert.match(f.overlay().render(100).join("\n"), /Digits: text/);
	assert.deepEqual(f.key("\x1b[110;5:1u"), { consume: true });
	assert.match(f.overlay().render(100).join("\n"), /Digits: select/);
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
	f.ui.setEditorText("existing session draft");
	assert.deepEqual(f.key("\x07"), { consume: true });
	f.overlay().handleInput("B");
	f.overlay().handleInput("1");
	await nextTick();
	assert.equal(groups.load().sessions[f.main.getSessionId()], b.id);
	assert.equal(f.ui.getEditorText(), "existing session draft");
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
	assert.deepEqual(f.key("\x07"), { consume: true });
	f.overlay().handleInput("Ungrouped");
	f.overlay().handleInput("1");
	await nextTick();
	assert.equal(groups.load().sessions[a.id], undefined);
	assert.equal(f.ui.getEditorText(), "");
	assert.equal(a.proc, proc);
	assert.equal(a.state, "working");
	assert.equal(readFileSync(a.sessionFile!, "utf8"), before);
	assert.equal(readFileSync(f.main.getSessionFile()!, "utf8"), mainBefore);
	assert.equal((proc!.kill as any).mock.calls.length, 0);
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
		source: "interactive",
		text: "review URL",
	});
	assert.deepEqual(result, [{ action: "handled" }]);
	const agent = [...registry().agents.values()].find(
		(agent) => agent.title === "review URL",
	)!;
	assert.ok(agent);
	assert.equal(agent.proc, undefined);
	assert.equal(groups.load().sessions[agent.id], group.id);
	assert.deepEqual(agent.pending, ["review URL"]);
	assert.equal(
		(globalThis as any)[Symbol.for("pi.inbox.reply-target")],
		undefined,
	);
});

test("a native fork lands in the original session's group", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const group = await groups.create("Reviews");
	const sourceId = f.main.getSessionId();
	await groups.assign(sourceId, group.id);
	// pi's fork(): createBranchedSession re-points the LIVE SessionManager at the new
	// file (the on-screen session becomes the fork), then session_start fires with
	// reason "fork" and previousSessionFile = the source file.
	const sourceFile = f.main.getSessionFile()!;
	f.main.createBranchedSession(f.main.getLeafId()!);
	assert.notEqual(f.main.getSessionFile(), sourceFile);
	assert.notEqual(f.main.getSessionId(), sourceId);
	await f.emit("session_start", {
		reason: "fork",
		previousSessionFile: sourceFile,
	});
	assert.equal(groups.load().sessions[f.main.getSessionId()], group.id);
	// The source keeps its membership; the fork is a separate member.
	assert.equal(groups.load().sessions[sourceId], group.id);
});

test("a fork from an ungrouped session stays Ungrouped", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const reviews = await groups.create("Reviews");
	await f.emit("session_start", {
		reason: "fork",
		previousSessionFile: f.main.getSessionFile(),
	});
	assert.equal(groups.load().sessions[f.main.getSessionId()], undefined);
	// And a plain resume never inherits: an unrelated session keeps its group.
	const other = SessionManager.create(dir);
	other.appendMessage({ role: "user", content: "other", timestamp: 3 });
	await groups.assign(other.getSessionId(), reviews.id);
	await f.emit("session_start", {
		reason: "resume",
		previousSessionFile: other.getSessionFile(),
	});
	assert.equal(groups.load().sessions[f.main.getSessionId()], undefined);
	assert.equal(groups.load().sessions[other.getSessionId()], reviews.id);
});

test("a busy mid-run clone lands in the original session's group", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	const group = await groups.create("Reviews");
	// The attached session (here: the fixture's main) needs a completed step:
	// assistant tool call answered by a tool result, so the clone has a leaf.
	const main = f.main;
	main.appendMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
		],
		api: "openai-responses",
		provider: "test",
		model: "alpha",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "toolUse",
		timestamp: 4,
	});
	main.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 5,
	});
	await groups.assign(main.getSessionId(), group.id);
	const before = readFileSync(main.getSessionFile()!, "utf8");
	await f.commands.get("orchestrator").handler("clone", f.ctx);
	const clone = (f.ctx.switchSession as any).mock.calls.at(-1)
		?.arguments?.[0] as string;
	assert.match(clone, /\.jsonl$/);
	assert.ok(existsSync(clone), "the clone session file should exist");
	assert.notEqual(clone, main.getSessionFile());
	const cloneId = SessionManager.open(clone).getSessionId();
	assert.notEqual(cloneId, main.getSessionId());
	assert.equal(groups.load().sessions[cloneId], group.id);
	// Cloning must not disturb the original session file.
	assert.equal(readFileSync(main.getSessionFile()!, "utf8"), before);
});

test("a clone from an ungrouped session stays Ungrouped", async (t) => {
	const f = await setup(t);
	const groups = new InboxGroups(dir);
	await groups.create("Reviews");
	const main = f.main;
	main.appendMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
		],
		api: "openai-responses",
		provider: "test",
		model: "alpha",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "toolUse",
		timestamp: 4,
	});
	main.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 5,
	});
	await f.commands.get("orchestrator").handler("clone", f.ctx);
	const clone = (f.ctx.switchSession as any).mock.calls.at(-1)
		?.arguments?.[0] as string;
	assert.ok(existsSync(clone), "the clone session file should exist");
	const cloneId = SessionManager.open(clone).getSessionId();
	assert.equal(groups.load().sessions[cloneId], undefined);
});

test("busy clone excludes the entire active prompt from fresh disk", async (t) => {
	const f = await setup(t, false);
	const main = f.main;
	main.appendSessionInfo("Old name");
	const base = main.getLeafId()!;
	const disk = SessionManager.open(main.getSessionFile()!);
	disk.appendMessage({ role: "user", content: "active", timestamp: 10 });
	disk.appendCustomEntry("answered-step", {});
	disk.appendMessage({ role: "user", content: "steering", timestamp: 11 });
	disk.appendSessionInfo("Latest name");
	const a: BgAgent = {
		id: main.getSessionId(), cwd: dir, title: "Latest name",
		sessionFile: main.getSessionFile(), state: "working",
		proc: { kill: mock.fn() }, pending: [], createdAt: 0,
		updatedAt: 0, needsYou: false, runs: 1, log: [], liveText: "",
		runBaseLeafId: base,
	};
	registry().agents.set(a.id, a);
	const original = readFileSync(main.getSessionFile()!, "utf8");
	const intercepted = await f.emit("session_before_fork", {
		entryId: main.getLeafId(), position: "at",
	});
	assert.ok(intercepted.some((r) => r?.cancel));
	// The run finishes between the click and the internal command dispatch.
	a.state = "idle";
	a.runBaseLeafId = undefined;
	await f.commands.get("orchestrator").handler("clone", f.ctx);
	const file = (f.ctx.switchSession as any).mock.calls.at(-1).arguments[0];
	const clone = SessionManager.open(file);
	assert.equal(clone.getSessionName(), "Latest name - Clone");
	const ids = clone.getBranch().map((e) => e.id);
	assert.ok(ids.includes(base));
	assert.ok(!ids.includes(disk.getLeafId()!));
	assert.equal(clone.getBranch().filter((e) =>
		e.type === "message" && e.message.role === "user").length, 1);
	assert.equal(readFileSync(main.getSessionFile()!, "utf8"), original);
	assert.equal(a.state, "idle");
	assert.equal((a.proc!.kill as any).mock.calls.length, 0);
	a.state = "working";
	// Historical selection is preserved even with a background writer.
	main.branch(main.getEntries()[0].id);
	const results = await f.emit("session_before_fork", {
		entryId: main.getLeafId(), position: "at",
	});
	assert.ok(results.every((r) => !r?.cancel));
	assert.equal((f.pi.sendUserMessage as any).mock.calls.length, 0);
});

test("native branch titles distinguish Clone and Fork", async (t) => {
	for (const position of ["at", "before"] as const) {
		const f = await setup(t);
		f.main.appendSessionInfo("Latest title");
		const sourceFile = f.main.getSessionFile()!;
		await f.emit("session_before_fork", {
			entryId: f.main.getLeafId(), position,
		});
		f.main.createBranchedSession(f.main.getLeafId()!);
		await f.emit("session_start", {
			reason: "fork", previousSessionFile: sourceFile,
		});
		const kind = position === "at" ? "Clone" : "Fork";
		assert.equal(f.main.getSessionName(), `Latest title - ${kind}`);
	}
});

test("first active prompt clones to empty history", async (t) => {
	const f = await setup(t, false);
	const a: BgAgent = {
		id: f.main.getSessionId(), cwd: dir, title: "First run",
		sessionFile: f.main.getSessionFile(), state: "working",
		proc: { kill: mock.fn() }, pending: [], createdAt: 0,
		updatedAt: 0, needsYou: false, runs: 1, log: [], liveText: "",
		runBaseLeafId: null,
	};
	registry().agents.set(a.id, a);
	await f.commands.get("orchestrator").handler("clone", f.ctx);
	const file = (f.ctx.switchSession as any).mock.calls.at(-1)?.arguments[0];
	assert.ok(file, "empty clone must be persisted");
	assert.equal(SessionManager.open(file).getBranch()
		.filter((e) => e.type === "message").length, 0);
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
	const picker = f.overlay();
	picker.handleInput("PR");
	assert.deepEqual(f.key("\x05"), { consume: true });
	picker.handleInput("\x1b[200~Use gh-pr-review\n\nPR: \x1b[201~");
	assert.deepEqual(f.key("\x13"), { consume: true });
	await nextTick();
	assert.equal(f.overlay(), picker, "editing stays in the group picker");
	assert.match(picker.render(100).join("\n"), /Prefix: PR/);
	assert.equal(groups.load().groups[0].template, "Use gh-pr-review\n\nPR: ");
	assert.equal(groups.load().groups[0].templateEnabled, false);
	assert.deepEqual(f.key("\x14"), { consume: true });
	await nextTick();
	assert.equal(f.overlay(), picker, "toggling stays in the group picker");
	assert.equal(groups.load().groups[0].templateEnabled, true);
	assert.equal(f.ui.select.mock.calls.length, 0);
	assert.equal(f.ui.editor.mock.calls.length, 0);
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

async function familyFixture(t: TestContext) {
	const f = await setup(t);
	const parent = f.main.getSessionId();
	f.main.appendSessionInfo("Family parent");
	const workers = join(dir, "session-workers", "workers");
	rmSync(workers, { recursive: true, force: true });
	rmSync(join(dir, "inbox-worker-folds.json"), { force: true });
	mkdirSync(workers, { recursive: true });
	const children = ["Child first", "Child second"].map((label, index) => {
		const title = `${label} ${parent.slice(-8)}`;
		const session = SessionManager.create(dir);
		session.appendMessage({ role: "user", content: title, timestamp: 2 });
		session.appendSessionInfo(title);
		const id = session.getSessionId();
		writeFileSync(
			join(workers, `${id}.json`),
			JSON.stringify({
				id,
				parentId: parent,
				createdAt: index + 1,
				title,
				cwd: dir,
				extensionPath: "test",
			}),
		);
		return { id, session, title };
	});
	t.after(() => {
		rmSync(workers, { recursive: true, force: true });
		rmSync(join(dir, "inbox-worker-folds.json"), { force: true });
	});
	return {
		...f,
		parent,
		children,
		ids: [parent, ...children.map((child) => child.id)],
	};
}

test("worker families collapse, expand, retain focus and persist folds", async (t) => {
	const f = await familyFixture(t);
	const { list, done } = await f.openInbox();
	const ids = () =>
		list.visible
			.filter((row: any) => f.ids.includes(row.info.id))
			.map((row: any) => row.info.id);
	assert.deepEqual(ids(), [f.parent]);
	list.state.selectedId = f.parent;
	list.rebuild();
	list.handleInput(" ");
	assert.deepEqual(ids(), f.ids);
	list.state.selectedId = f.children[1].id;
	list.rebuild();
	list.handleInput(" ");
	assert.deepEqual(ids(), [f.parent]);
	assert.equal(list.state.selectedId, f.parent);
	list.handleInput(" ");
	await list.refresh();
	assert.deepEqual(ids(), f.ids);
	assert.ok(new WorkerFolds(dir).load().has(f.parent));
	for (const width of [60, 80, 120, 200]) {
		assert.ok(
			list
				.render(width)
				.every((line: string) => visibleWidth(line) <= width),
		);
	}
	list.handleInput("\x1b");
	await done;
	const reopened = await f.openInbox();
	assert.deepEqual(
		reopened.list.visible
			.filter((row: any) => f.ids.includes(row.info.id))
			.map((row: any) => row.info.id),
		f.ids,
	);
	reopened.list.handleInput("\x1b");
	await reopened.done;
});

test("search exposes matching children without changing saved folds", async (t) => {
	const f = await familyFixture(t);
	const { list, done } = await f.openInbox();
	list.state.query = f.children[1].title;
	list.rebuild();
	assert.deepEqual(
		list.visible.map((row: any) => row.info.id),
		[f.parent, f.children[1].id],
	);
	assert.equal(list.families.get(f.parent).contextOnly, true);
	assert.equal(new WorkerFolds(dir).load().size, 0);
	list.state.selectedId = f.children[1].id;
	list.rebuild();
	list.handleInput("\x1b");
	assert.equal(list.state.query, "");
	assert.equal(list.state.selectedId, f.parent);
	assert.equal(
		list.visible.some((row: any) => row.info.id === f.children[1].id),
		false,
	);
	list.handleInput("\x1b");
	await done;
});

test("list archiving cascades hidden children; child archiving stays local", async (t) => {
	const f = await familyFixture(t);
	const { list, done } = await f.openInbox();
	list.state.selectedId = f.parent;
	list.rebuild();
	list.handleInput("a");
	const storeFile = join(dir, "inbox.json");
	let store = JSON.parse(readFileSync(storeFile, "utf8"));
	assert.ok(f.ids.every((id) => store.sessions[id].archivedAt));
	assert.equal(
		list.visible.some((row: any) => f.ids.includes(row.info.id)),
		false,
	);
	list.handleInput("2");
	await list.refresh(true);
	list.state.selectedId = f.parent;
	list.rebuild();
	list.handleInput("a");
	store = JSON.parse(readFileSync(storeFile, "utf8"));
	assert.ok(f.ids.every((id) => !store.sessions[id]?.archivedAt));
	list.handleInput("1");
	list.state.selectedId = f.parent;
	list.rebuild();
	list.handleInput(" ");
	list.state.selectedId = f.children[0].id;
	list.rebuild();
	list.handleInput("a");
	store = JSON.parse(readFileSync(storeFile, "utf8"));
	assert.ok(store.sessions[f.children[0].id].archivedAt);
	assert.equal(store.sessions[f.parent]?.archivedAt, undefined);
	assert.equal(store.sessions[f.children[1].id]?.archivedAt, undefined);
	list.handleInput("\x1b");
	await done;
});

test("archive command includes absent-file and filtered workers without stopping them", async (t) => {
	const f = await familyFixture(t);
	const extra = "family-unsaved-child";
	writeFileSync(
		join(dir, "session-workers/workers", `${extra}.json`),
		JSON.stringify({ id: extra, parentId: f.parent, createdAt: 3 }),
	);
	const kill = mock.fn();
	registry().agents.set(extra, {
		id: extra,
		title: "Not saved",
		cwd: dir,
		state: "working",
		proc: { kill },
		pending: ["Keep queued"],
		runs: 1,
		createdAt: 1,
		updatedAt: 1,
		needsYou: false,
		log: [],
		liveText: "",
	});
	writeFileSync(
		join(dir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: { [f.children[0].id]: { filter: "hide", pinnedAt: 12 } },
		}),
	);
	await f.commands.get("archive").handler("", f.ctx);
	const store = JSON.parse(readFileSync(join(dir, "inbox.json"), "utf8"));
	assert.ok([...f.ids, extra].every((id) => store.sessions[id].archivedAt));
	assert.equal(store.sessions[f.children[0].id].filter, "hide");
	assert.equal(store.sessions[f.children[0].id].pinnedAt, 12);
	assert.equal(kill.mock.calls.length, 0);
	assert.deepEqual(registry().agents.get(extra)?.pending, ["Keep queued"]);
});

test("cross-group children remain nested with contextual parents", async (t) => {
	const f = await familyFixture(t);
	const groups = new InboxGroups(dir);
	const a = await groups.create("Parent group");
	const b = await groups.create("Worker group");
	await groups.assign(f.parent, a.id);
	await groups.assign(f.children[0].id, b.id);
	Reflect.set(globalThis, Symbol.for("pi.inbox.group-view"), b.id);
	const { list, done } = await f.openInbox();
	assert.deepEqual(
		list.visible.map((row: any) => row.info.id),
		[f.parent],
	);
	assert.equal(list.families.get(f.parent).contextOnly, true);
	list.handleInput(" ");
	assert.deepEqual(
		list.visible.map((row: any) => row.info.id),
		[f.parent, f.children[0].id],
	);
	list.handleInput("\x1b");
	await done;
});

test("archived parents remain accessible when a worker wakes in the inbox", async (t) => {
	const f = await familyFixture(t);
	writeFileSync(
		join(dir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: {
				[f.parent]: { archivedAt: 10 },
				[f.children[1].id]: { archivedAt: 10 },
			},
		}),
	);
	const { list, done } = await f.openInbox();
	assert.ok(list.visible.some((row: any) => row.info.id === f.parent));
	assert.equal(list.families.get(f.parent).contextOnly, true);
	list.state.selectedId = f.parent;
	list.rebuild();
	list.handleInput(" ");
	assert.ok(
		list.visible.some((row: any) => row.info.id === f.children[0].id),
	);
	list.handleInput("\x1b");
	await done;
});

test("foreign startup workers appear once without creating control handles", async (t) => {
	const f = await familyFixture(t);
	const id = "family-foreign-startup";
	writeFileSync(
		join(dir, "session-workers/workers", `${id}.json`),
		JSON.stringify({
			id,
			parentId: f.parent,
			createdAt: 3,
			title: "Foreign startup",
			cwd: dir,
		}),
	);
	const agents = join(dir, "inbox-agents");
	mkdirSync(agents, { recursive: true });
	const saved = join(agents, `${id}.json`);
	const raw = JSON.stringify({
		id,
		state: "working",
		owner: 123456789,
		ownerBeat: Date.now(),
		updatedAt: Date.now(),
	});
	writeFileSync(saved, raw);
	t.after(() => rmSync(saved, { force: true }));
	const { list, done } = await f.openInbox();
	const family = list.families.get(f.parent);
	assert.equal(family.children.length, 3);
	const row = family.children.find((row: any) => row.info.id === id);
	assert.equal(row.remoteState, "working");
	assert.equal(row.bg, undefined);
	assert.equal(registry().agents.has(id), false);
	assert.match(list.workerSummary(family), /1 running/);
	assert.equal(readFileSync(saved, "utf8"), raw);
	list.handleInput("\x1b");
	await done;
});

test("family summary preserves parent status and Enter still opens sessions", async (t) => {
	const f = await familyFixture(t);
	const { list, done } = await f.openInbox();
	list.state.selectedId = f.parent;
	list.rebuild();
	const family = list.families.get(f.parent);
	const before = list.statusCell(family.row);
	family.children[0].remoteState = "working";
	family.children[0].tail.status = "error";
	family.children[1].remoteState = "error";
	family.children[1].unread = true;
	assert.match(list.workerSummary(family), /1 error/);
	assert.match(list.workerSummary(family), /1 running/);
	assert.match(list.workerSummary(family), /1 unread/);
	assert.equal(list.statusCell(family.row), before);
	assert.equal(family.row.unread, false);
	const complete = list.done;
	let action: { action: string; row: { info: { id: string } } } | undefined;
	list.done = (value: typeof action) => {
		action = value;
	};
	list.handleInput("\r");
	assert.equal(action?.action, "open");
	assert.equal(action?.row.info.id, f.parent);
	assert.equal(new WorkerFolds(dir).load().size, 0);
	list.done = complete;
	list.handleInput("\x1b");
	await done;
});

test("parent rows keep latest messages beside compact worker badges", async (t) => {
	const f = await familyFixture(t);
	const { list, done } = await f.openInbox();
	list.state.selectedId = f.parent;
	list.rebuild();
	const family = list.families.get(f.parent);
	const title = `Message family ${f.parent.slice(-8)}`;
	family.row.title = title;
	family.row.info.name = title;
	family.row.tail.lastSaid = {
		role: "assistant",
		text: "Parent latest sentinel",
	};
	family.row.meta.pinnedAt = 1;
	family.row.takenOver = false;
	family.children[0].remoteState = "working";
	family.children[1].unread = true;
	const parentLine = () =>
		list.render(220).find((line: string) => line.includes(title));
	let line = parentLine();
	assert.ok(line);
	assert.match(line, /Parent latest sentinel/);
	assert.match(line, /\[2w ↻1 •1\]/);
	assert.equal(line.indexOf("★") - line.indexOf("▸"), 2);
	list.handleInput(" ");
	line = parentLine();
	assert.ok(line);
	assert.match(line, /Parent latest sentinel/);
	assert.match(line, /\[2w ↻1 •1\]/);
	assert.equal(line.indexOf("★") - line.indexOf("▾"), 2);
	for (const width of [40, 60, 80, 120, 160, 220]) {
		assert.ok(
			list
				.render(width)
				.every((text: string) => visibleWidth(text) <= width),
		);
	}
	list.handleInput("\x1b");
	await done;
});

test("row marker slots shrink when takeover is absent and keep child alignment", async (t) => {
	const f = await familyFixture(t);
	const { list, done } = await f.openInbox();
	list.state.selectedId = f.parent;
	list.rebuild();
	for (const row of list.rows) row.takenOver = false;
	const family = list.families.get(f.parent);
	const title = `Marker family ${f.parent.slice(-8)}`;
	family.row.title = title;
	family.row.info.name = title;
	family.row.meta.pinnedAt = 1;
	family.row.live = { state: "idle", pid: 12345 };
	let line = list.render(220).find((text: string) => text.includes(title));
	assert.ok(line);
	assert.equal(line.indexOf("◉") - line.indexOf("★"), 2);
	family.row.takenOver = true;
	line = list.render(220).find((text: string) => text.includes(title));
	assert.ok(line);
	assert.equal(line.indexOf("⚑") - line.indexOf("★"), 2);
	assert.equal(line.indexOf("◉") - line.indexOf("⚑"), 2);
	family.row.takenOver = false;
	list.handleInput(" ");
	const lines: string[] = list.render(220);
	const parentLine = lines.find((text) => text.includes(title));
	const childLine = lines.find((text) => text.includes(f.children[0].title));
	assert.ok(parentLine && childLine);
	assert.equal(childLine.indexOf("├─") - parentLine.indexOf("▾"), 2);
	assert.equal(
		childLine.indexOf("Ungrouped"),
		parentLine.indexOf("Ungrouped"),
	);
	list.handleInput("\x1b");
	await done;
});
