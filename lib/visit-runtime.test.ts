import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test, type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { applyEvent, registry, type BgAgent } from "./inbox-agents.ts";
import {
	closeVisit,
	openVisit,
	visiting,
	visitingId,
	visitState,
	type OpenVisitOpts,
} from "./visit-runtime.ts";

initTheme("dark");

function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-visit-test-"));
	const main = new Text("main session", 0, 0);
	const chat = new Container();
	chat.addChild(main);
	const doc = new Container();
	doc.addChild(chat);
	const mainSession = { sessionManager: SessionManager.inMemory(dir) };
	const footer = {
		session: mainSession,
		setSession(session: typeof mainSession) {
			this.session = session;
		},
		getSessionStats() {},
	};
	const layout = {
		children: [doc, { children: [footer] }],
		requestRender: mock.fn(),
	};
	const tui = layout as unknown as TUI;
	const agents: string[] = [];

	t.after(() => {
		for (const id of agents) registry().agents.delete(id);
		closeVisit(tui);
		const globals = globalThis as any;
		const listenerKey = Symbol.for("pi.inbox.visitListener");
		globals[listenerKey]?.();
		delete globals[listenerKey];
		delete globals[Symbol.for("pi.inbox.visitState")];
		rmSync(dir, { recursive: true, force: true });
	});

	function session(text: string, timestamp = Date.now()): OpenVisitOpts {
		const sm = SessionManager.create(dir, dir);
		sm.appendMessage({ role: "user", content: text, timestamp });
		return {
			mainId: mainSession.sessionManager.getSessionId(),
			id: sm.getSessionId(),
			file: sm.getSessionFile()!,
			cwd: dir,
			title: text,
		};
	}

	function agent(o: OpenVisitOpts, prompt: string): BgAgent {
		const a: BgAgent = {
			id: o.id,
			cwd: dir,
			sessionFile: o.file,
			title: o.title,
			state: "working",
			pending: [],
			createdAt: 0,
			updatedAt: 0,
			needsYou: false,
			runs: 1,
			log: [],
			liveText: "",
			runPrompt: prompt,
			liveRun: {
				msgs: [{ role: "user", text: prompt, rev: 1 }],
				rev: 1,
			},
		};
		registry().agents.set(a.id, a);
		agents.push(a.id);
		return a;
	}

	return { agent, chat, footer, layout, main, mainSession, session, tui };
}

test("switches visits without losing the taken-over session", (t) => {
	const f = setup(t);
	const b = f.session("first visited session");
	const c = f.session("second visited session");
	const originalAdd = f.chat.addChild;
	const originalRemove = f.chat.removeChild;
	const originalClear = f.chat.clear;
	const originalInvalidate = f.chat.invalidate;

	assert.equal(openVisit(f.tui, {}, b), true);
	assert.match(f.chat.render(80).join("\n"), /first visited session/);
	const firstView = visiting()!.view;
	const streamedBeforeSwitch = new Text("main kept streaming", 0, 0);
	f.chat.addChild(streamedBeforeSwitch);

	assert.equal(openVisit(f.tui, {}, c), true);
	assert.equal(visitingId(), c.id);
	assert.equal(visitState().mainId, c.mainId);
	assert.notEqual(visiting()!.view, firstView);
	assert.deepEqual(f.chat.children, [visiting()!.view]);
	assert.equal(f.footer.session.sessionManager.getSessionId(), c.id);
	const rendered = f.chat.render(80).join("\n");
	assert.match(rendered, /second visited session/);
	assert.doesNotMatch(rendered, /first visited session|main kept streaming/);

	const streamedAfterSwitch = new Text("main still streaming", 0, 0);
	f.chat.addChild(streamedAfterSwitch);
	f.chat.removeChild(f.main);
	assert.equal(openVisit(f.tui, {}, b), true);
	assert.equal(visitingId(), b.id);
	assert.match(f.chat.render(80).join("\n"), /first visited session/);

	assert.equal(closeVisit(f.tui), true);
	assert.deepEqual(f.chat.children, [
		streamedBeforeSwitch,
		streamedAfterSwitch,
	]);
	assert.equal(f.footer.session, f.mainSession);
	assert.equal(f.chat.addChild, originalAdd);
	assert.equal(f.chat.removeChild, originalRemove);
	assert.equal(f.chat.clear, originalClear);
	assert.equal(f.chat.invalidate, originalInvalidate);
	assert.equal(visitingId(), undefined);
	assert.equal(closeVisit(f.tui), false);
});

test("reopening the same visit keeps its view and main stash", (t) => {
	const f = setup(t);
	const b = f.session("same visit");
	assert.equal(openVisit(f.tui, {}, b), true);
	const firstVisit = visiting();
	const restoreChat = visitState().restoreChat;
	const streamed = new Text("main output", 0, 0);
	f.chat.addChild(streamed);

	assert.equal(openVisit(f.tui, {}, b), true);
	assert.equal(visiting(), firstVisit);
	assert.equal(visitState().restoreChat, restoreChat);
	closeVisit(f.tui);
	assert.deepEqual(f.chat.children, [f.main, streamed]);
	assert.equal(f.footer.session, f.mainSession);
});

test("main chat clears remain isolated across visit switches", (t) => {
	const f = setup(t);
	const b = f.session("visit before clear");
	const c = f.session("visit after clear");
	assert.equal(openVisit(f.tui, {}, b), true);
	f.chat.clear();
	const rebuiltMain = new Text("rebuilt main", 0, 0);
	f.chat.addChild(rebuiltMain);

	assert.equal(openVisit(f.tui, {}, c), true);
	assert.equal(visitingId(), c.id);
	assert.match(f.chat.render(80).join("\n"), /visit after clear/);
	closeVisit(f.tui);
	assert.deepEqual(f.chat.children, [rebuiltMain]);
	assert.equal(f.footer.session, f.mainSession);
});

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function streamAssistant(a: BgAgent, message: AssistantMessage) {
	applyEvent(a, { type: "message_start", message });
	applyEvent(a, { type: "message_end", message });
}

test("dedupes ID-less wire messages before and after persistence", (t) => {
	const f = setup(t);
	const b = f.session("new session prompt", 1000);
	const a = f.agent(b, "new session prompt");
	const sm = SessionManager.open(b.file);
	const entry = sm.getBranch()[0];
	assert.equal(entry.type, "message");
	if (entry.type !== "message") return;
	applyEvent(a, { type: "message_start", message: entry.message });
	assert.equal(a.liveRun!.msgs[0].message?.timestamp, 1000);

	openVisit(f.tui, {}, b);
	const render = () => f.chat.render(80).join("\n");
	assert.equal(render().split("new session prompt").length - 1, 1);
	const reply = assistant("first streamed reply", 2000);
	streamAssistant(a, reply);
	assert.equal(render().split("first streamed reply").length - 1, 1);
	sm.appendMessage(reply);
	assert.equal(render().split("new session prompt").length - 1, 1);
	assert.equal(render().split("first streamed reply").length - 1, 1);

	// When the live replay goes away, disk history still renders exactly once.
	a.liveRun = undefined;
	assert.equal(render().split("new session prompt").length - 1, 1);
	assert.equal(render().split("first streamed reply").length - 1, 1);
});

test("an identical new prompt never removes the previous run", (t) => {
	const f = setup(t);
	const b = f.session("continue", 1000);
	const sm = SessionManager.open(b.file);
	sm.appendMessage(assistant("previous answer", 2000));
	const a = f.agent(b, "continue");
	const nextPrompt = {
		role: "user" as const,
		content: "continue",
		timestamp: 3000,
	};
	applyEvent(a, { type: "message_start", message: nextPrompt });
	openVisit(f.tui, {}, b);
	const render = () => f.chat.render(80).join("\n");
	assert.equal(render().split("continue").length - 1, 2);
	assert.match(render(), /previous answer/);

	sm.appendMessage(nextPrompt);
	assert.equal(render().split("continue").length - 1, 2);
	assert.match(render(), /previous answer/);
});

test("skill-expanded prompts match without comparing display text", (t) => {
	const f = setup(t);
	const expanded = '<skill name="test">instructions</skill>\nreview';
	const b = f.session(expanded, 1000);
	const a = f.agent(b, "review");
	applyEvent(a, {
		type: "message_start",
		message: {
			role: "user",
			content: expanded,
			timestamp: 1000,
		},
	});
	openVisit(f.tui, {}, b);
	const rendered = f.chat.render(80).join("\n");
	assert.equal(rendered.split("review").length - 1, 1);
	assert.doesNotMatch(rendered, /instructions/);
});

test("trimming the live buffer does not drop earlier saved turns", (t) => {
	const f = setup(t);
	const b = f.session("long run prompt", 1000);
	const sm = SessionManager.open(b.file);
	const oldReply = assistant("older saved reply", 2000);
	const tail = assistant("retained live reply", 3000);
	sm.appendMessage(oldReply);
	sm.appendMessage(tail);
	const a = f.agent(b, "long run prompt");
	streamAssistant(a, tail);
	// Simulate trimLive dropping the seeded prompt and earlier turns.
	a.liveRun!.msgs.shift();
	openVisit(f.tui, {}, b);
	const rendered = f.chat.render(80).join("\n");
	assert.match(rendered, /long run prompt/);
	assert.match(rendered, /older saved reply/);
	assert.equal(rendered.split("retained live reply").length - 1, 1);
});

test("repeated steering prompts are separate messages, not seed echoes", (t) => {
	const f = setup(t);
	const b = f.session("continue", 1000);
	const sm = SessionManager.open(b.file);
	const a = f.agent(b, "continue");
	const user = { role: "user" as const, content: "continue", timestamp: 1000 };
	applyEvent(a, { type: "message_start", message: user });
	const reply = assistant("first answer", 2000);
	streamAssistant(a, reply);
	sm.appendMessage(reply);
	const steer = { ...user, timestamp: 3000 };
	applyEvent(a, { type: "message_start", message: steer });
	sm.appendMessage(steer);
	assert.equal(a.liveRun!.msgs.length, 3);
	openVisit(f.tui, {}, b);
	const rendered = f.chat.render(80).join("\n");
	assert.equal(rendered.split("continue").length - 1, 2);
	assert.equal(rendered.split("first answer").length - 1, 1);
});

test("an unavailable chat mount refuses a switch, keeping the visit", (t) => {
	const f = setup(t);
	const b = f.session("existing visit");
	const c = f.session("refused visit");
	assert.equal(openVisit(f.tui, {}, b), true);
	const firstVisit = visiting();
	const mounts = f.layout.children;
	f.layout.children = [];
	try {
		assert.equal(openVisit(f.tui, {}, c), false);
		assert.equal(visiting(), firstVisit);
		assert.equal(f.footer.session.sessionManager.getSessionId(), b.id);
	} finally {
		f.layout.children = mounts;
	}
	closeVisit(f.tui);
	assert.deepEqual(f.chat.children, [f.main]);
	assert.equal(f.footer.session, f.mainSession);
});
