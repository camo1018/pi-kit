import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	DefaultResourceLoader, SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { InboxGroups } from "../inbox/groups.ts";
import groupMemory from "./index.ts";
import { groupTag, type Memory } from "./memory.ts";

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR", "BIGBRAIN_URL", "BIGBRAIN_MCP_URL",
	"BIGBRAIN_MAINT", "BIGBRAIN_MAINT_PI_EXTENSIONS",
	"PI_BIGBRAIN_GROUP_SNAPSHOT",
];

async function setup(t: TestContext, worker = false) {
	const oldEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
	const dir = mkdtempSync(join(tmpdir(), "pi-group-memory-"));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.BIGBRAIN_MAINT_PI_EXTENSIONS = "/existing/provider.ts";
	const store = new InboxGroups(dir);
	const a = await store.create("Assets");
	const b = await store.create("Detection");
	await store.assign("session-a", a.id);
	await store.assign("session-b", b.id);
	if (worker) {
		process.env.BIGBRAIN_MAINT = "1";
		process.env.PI_BIGBRAIN_GROUP_SNAPSHOT = JSON.stringify(a);
	}
	const memories: Memory[] = [
		{
			id: "8661578875131011192", topic: "Assets decision",
			content: "Pin immutable versions.", tags: [groupTag(a), "assets"],
		},
		{
			id: "2388910343697689447", topic: "Detection decision",
			content: "Audit detection sources.", tags: [groupTag(b)],
		},
	];
	const calls: any[] = [];
	let fail = false;
	const http = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const call = JSON.parse(raw).params;
		calls.push(call);
		if (fail) { res.statusCode = 503; res.end(); return; }
		const selected = call.name === "memory_get"
			? memories.filter(m => m.id === call.arguments.memory_id)
			: memories.filter(m => call.arguments.tags.every(
				(tag: string) => m.tags.includes(tag),
			));
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ jsonrpc: "2.0", id: "test", result: {
			content: selected.map(m => ({
				type: "text", text: JSON.stringify(m),
			})),
		} }));
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const address = http.address();
	assert.ok(address && typeof address !== "string");
	process.env.BIGBRAIN_URL = `http://127.0.0.1:${address.port}/mcp`;
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	let available = true;
	const pi = {
		on(name: string, handler: (...args: any[]) => any) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		getAllTools() {
			return available ? [{ name: "memory_recall" }] : [];
		},
	} as unknown as ExtensionAPI;
	groupMemory(pi);
	let sessionId = worker ? "worker-session" : "session-a";
	const notifications: string[] = [];
	const ctx = {
		cwd: dir, hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message: string) => notifications.push(message) },
	};
	const emit = (name: string, event: any = {}) =>
		handlers.get(name)?.(event, ctx);
	const start = (prompt = "current task", guidelines: string[] = []) => {
		const event = {
			prompt, systemPromptOptions: { promptGuidelines: guidelines },
		};
		return emit("before_agent_start", event).then(() => event);
	};
	t.after(async () => {
		await emit("session_shutdown");
		http.closeAllConnections();
		http.close();
		for (const [key, value] of oldEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		dir, store, a, b, memories, calls, emit, start, commands, ctx,
		notifications,
		switchTo(id: string) { sessionId = id; },
		setFail(value: boolean) { fail = value; },
		setAvailable(value: boolean) { available = value; },
	};
}

test("new grouped sessions recall before the first model request", async t => {
	const s = await setup(t);
	await s.emit("session_start");
	assert.equal(s.calls.length, 0);
	const event = await s.start("how should assets be versioned?");
	assert.match(event.systemPromptOptions.promptGuidelines[0], /Assets/);
	assert.equal(s.calls.length, 2);
	const persisted = [{ role: "user", content: "task", timestamp: 1 }];
	const result = await s.emit("context", {
		messages: structuredClone(persisted),
	});
	assert.equal(persisted.length, 1);
	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[0].role, "custom");
	assert.match(result.messages[0].content, /Pin immutable versions/);
	assert.doesNotMatch(result.messages[0].content, /Audit detection/);
	await s.emit("context", { messages: result.messages });
	assert.equal(s.calls.length, 2);
	// Next user prompt refreshes, including newly written sibling memories.
	s.memories[0].content = "A sibling session changed this decision.";
	await s.start("new task");
	const refreshed = await s.emit("context", { messages: persisted });
	assert.match(refreshed.messages[0].content, /sibling session/);
});

test("stores get additive group tags; recall stays global", async t => {
	const s = await setup(t);
	const input = { topic: "T", content: "C", tags: ["safety"] };
	await s.emit("tool_call", { toolName: "memory_store", input });
	assert.deepEqual(input.tags, ["safety", groupTag(s.a)]);
	const nested = { topic: "T", content: "C" } as any;
	await s.emit("tool_call", {
		toolName: "mcp__bigbrain__memory_store", input: nested,
		parentToolCallId: "script",
	});
	assert.deepEqual(nested.tags, [groupTag(s.a)]);
	const recall = { query: "global task" };
	await s.emit("tool_call", { toolName: "memory_recall", input: recall });
	assert.deepEqual(recall, { query: "global task" });
	const unrelated = { topic: "T", content: "C" };
	await s.emit("tool_call", {
		toolName: "mcp__another__memory_store", input: unrelated,
	});
	assert.deepEqual(unrelated, { topic: "T", content: "C" });
});

test("updates preserve prior groups during tag replacement", async t => {
	const s = await setup(t);
	s.switchTo("session-b");
	const input = { memory_id: s.memories[0].id, tags: ["new-tag"] };
	await s.emit("tool_call", { toolName: "memory_update", input });
	assert.deepEqual(input.tags, ["new-tag", groupTag(s.b), groupTag(s.a)]);
	const contentOnly = { memory_id: s.memories[0].id, content: "new" } as any;
	await s.emit("tool_call", {
		toolName: "memory_update", input: contentOnly,
	});
	assert.deepEqual(contentOnly.tags, [
		groupTag(s.a), "assets", groupTag(s.b),
	]);
	s.setFail(true);
	const blocked = await s.emit("tool_call", {
		toolName: "memory_update", input: { memory_id: s.memories[0].id },
	});
	assert.equal(blocked.block, true);
});

test("group changes and session switches refresh recall", async t => {
	const s = await setup(t);
	const event = await s.start();
	await s.store.rename(s.a.id, "Renamed assets");
	await s.start("task", event.systemPromptOptions.promptGuidelines);
	assert.match(event.systemPromptOptions.promptGuidelines[0], /Renamed/);
	await s.store.assign("session-a", s.b.id);
	const moved = await s.emit("context", { messages: [] });
	assert.match(moved.messages[0].content, /Audit detection/);
	assert.doesNotMatch(moved.messages[0].content, /Pin immutable/);
	await s.emit("agent_end");
	assert.equal(JSON.parse(process.env.PI_BIGBRAIN_GROUP_SNAPSHOT!).id,
		s.b.id);
	s.switchTo("session-b");
	await s.emit("session_start");
	await s.start();
	await s.store.remove(s.b.id);
	assert.equal(await s.emit("context", { messages: [] }), undefined);
	await s.start("ungrouped", event.systemPromptOptions.promptGuidelines);
	assert.deepEqual(event.systemPromptOptions.promptGuidelines, []);
	assert.equal(process.env.PI_BIGBRAIN_GROUP_SNAPSHOT, "");
});

test("assignment after startup is seen before the first prompt", async t => {
	const s = await setup(t);
	s.switchTo("just-created");
	await s.emit("session_start");
	assert.equal(process.env.PI_BIGBRAIN_GROUP_SNAPSHOT, "");
	await s.store.assign("just-created", s.a.id);
	await s.start();
	const result = await s.emit("context", { messages: [] });
	assert.match(result.messages[0].content, /Pin immutable/);
});

test("Ungrouped and missing tools make no network requests", async t => {
	const s = await setup(t);
	s.switchTo("ungrouped");
	await s.emit("session_start");
	await s.start();
	assert.equal(await s.emit("context", { messages: [] }), undefined);
	const input = { topic: "T", content: "C" };
	await s.emit("tool_call", { toolName: "memory_store", input });
	assert.deepEqual(input, { topic: "T", content: "C" });
	assert.equal(s.calls.length, 0);
	s.switchTo("session-a");
	s.setAvailable(false);
	await s.start();
	assert.equal(s.calls.length, 0);
	assert.match(s.notifications[0], /tools unavailable/);
});

test("corrupt group state and failed reads do not block prompts", async t => {
	const s = await setup(t);
	s.setFail(true);
	await s.start();
	await s.start();
	assert.equal(s.notifications.length, 1);
	const context = await s.emit("context", { messages: [] });
	assert.match(context.messages[0].content, /Some group reads failed/);
	const input = { topic: "T", content: "C" } as any;
	await s.emit("tool_call", { toolName: "memory_store", input });
	assert.deepEqual(input.tags, [groupTag(s.a)]);
	writeFileSync(s.store.file, "not json");
	await s.start();
	assert.equal(await s.emit("context", { messages: [] }), undefined);
});

test("worker uses captured group without recall or recursion", async t => {
	const s = await setup(t, true);
	await s.store.assign("session-a", s.b.id);
	await s.emit("session_start");
	await s.start("maintenance pass");
	const input = { topic: "T", content: "C" } as any;
	await s.emit("tool_call", { toolName: "memory_store", input });
	assert.deepEqual(input.tags, [groupTag(s.a)]);
	assert.equal(s.calls.length, 0);
	assert.equal(await s.emit("context", { messages: [] }), undefined);
	assert.equal(process.env.BIGBRAIN_MAINT_PI_EXTENSIONS,
		"/existing/provider.ts");
});

test("bridge is reload-safe and retains other extensions", async t => {
	const s = await setup(t);
	await s.emit("session_start");
	await s.emit("session_start");
	const extra = process.env.BIGBRAIN_MAINT_PI_EXTENSIONS!.split(",");
	assert.equal(extra.length, 2);
	assert.match(extra[1], /group-memory\/index.ts$/);
	await s.emit("session_shutdown");
	assert.equal(process.env.BIGBRAIN_MAINT_PI_EXTENSIONS,
		"/existing/provider.ts");
	assert.equal(process.env.PI_BIGBRAIN_GROUP_SNAPSHOT, undefined);
	await s.emit("session_start");
	assert.equal(process.env.BIGBRAIN_MAINT_PI_EXTENSIONS!.split(",").length,
		2);
});

test("Pi's real resource loader loads the extension cleanly", async t => {
	const s = await setup(t);
	const extension = new URL("./index.ts", import.meta.url).pathname;
	const loader = new DefaultResourceLoader({
		cwd: s.dir, agentDir: s.dir,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true, additionalExtensionPaths: [extension],
		noSkills: true, noPromptTemplates: true,
		noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	assert.ok(result.extensions[0].commands.has("group-memory"));
});
