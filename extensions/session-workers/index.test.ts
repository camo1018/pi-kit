import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	DefaultResourceLoader,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { registerSessionWorkers } from "./index.ts";
import { setup } from "./test-utils.ts";

function harness(
	t: TestContext,
	options: { settings?: Record<string, unknown> } = {},
) {
	const s = setup(t);
	const handlers = new Map<string, unknown>();
	let tool: ToolDefinition | undefined;
	const pi = {
		on(name: string, handler: unknown) {
			handlers.set(name, handler);
		},
		registerTool(definition: ToolDefinition) {
			tool = definition;
		},
		getSettings: () => options.settings ?? {},
	} as unknown as ExtensionAPI;
	registerSessionWorkers(pi, s.team);
	let caller = "parent";
	const ctx = {
		cwd: s.dir,
		mode: "json",
		hasUI: false,
		thinkingLevel: "high",
		model: { provider: "test", id: "model" },
		scopedModels: [],
		sessionManager: { getSessionId: () => caller },
	} as unknown as ExtensionToolContext;
	const execute = async (
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => {
		assert.ok(tool);
		return tool.execute("call", params, signal, undefined, ctx);
	};
	const context = async (messages: AgentMessage[]) => {
		const handler = handlers.get("context") as (
			event: { messages: AgentMessage[] },
			ctx: ExtensionToolContext,
		) => { messages: AgentMessage[] };
		return handler({ messages }, ctx);
	};
	const start = () => {
		const handler = handlers.get("session_start") as (
			event: unknown,
			ctx: ExtensionToolContext,
		) => void;
		handler({}, ctx);
	};
	return {
		...s,
		tool,
		execute,
		context,
		ctx,
		start,
		switchTo(id: string) {
			caller = id;
		},
	};
}

test("delegation guidelines are opt-in", (t: TestContext) => {
	const s = harness(t);
	assert.ok(s.tool);
	const guidelines = s.tool.promptGuidelines?.join(" ") ?? "";
	assert.match(
		guidelines,
		/only use session_workers when the user\s+explicitly asks/i,
	);
	assert.match(
		guidelines,
		/Never spawn workers on your own\s+initiative/i,
	);
	// The description the model sees alongside the tool must say the same.
	assert.match(s.tool.description, /only on\s+explicit user request/i);
});

test("agent tool spawns with parent defaults and follows up", async (t) => {
	const s = harness(t);
	assert.equal(s.tool?.name, "session_workers");
	assert.equal(s.tool?.executionMode, "sequential");
	await s.execute({ action: "spawn", title: "Calls", task: "Find callers" });
	const worker = s.team.workers("parent")[0];
	const call = s.calls.find((call) => call.kind === "spawn");
	assert.ok(call);
	const opts = call.data as {
		model: string;
		cwd: string;
		extensionPaths: string[];
	};
	assert.equal(opts.model, "test/model:high");
	assert.equal(opts.cwd, s.dir);
	assert.match(opts.extensionPaths[0], /session-workers\/index.ts$/);
	const list = await s.execute({ action: "list" });
	assert.match(JSON.stringify(list.content), /working/);
	await s.execute({ action: "send", id: worker.id, text: "Check retries" });
	assert.deepEqual(s.agents.get(worker.id)?.pending, ["Check retries"]);
	await s.execute({ action: "cancel", id: worker.id });
	assert.equal(s.agents.get(worker.id)?.state, "cancelled");
	await assert.rejects(
		s.execute({ action: "spawn", task: "Missing title" }),
		/requires task and title/,
	);
	await assert.rejects(s.execute({ action: "read" }), /requires id/);
	await assert.rejects(
		s.execute({
			action: "spawn",
			title: "Bad dir",
			task: "Read",
			cwd: join(s.dir, "missing"),
		}),
		/ENOENT/,
	);
});

const spawnedModel = (s: ReturnType<typeof harness>) => {
	const call = s.calls.find((call) => call.kind === "spawn");
	assert.ok(call);
	return (call.data as { model?: string }).model;
};

test("workerDefaultModel setting overrides the parent's model", async (t) => {
	const s = harness(t, {
		settings: { workerDefaultModel: "example-provider/cheap-model" },
	});
	await s.execute({ action: "spawn", title: "Cheap", task: "Research" });
	assert.equal(spawnedModel(s), "example-provider/cheap-model");
});

test("workerDefaultModel supports :thinking and is ignored when malformed", async (t) => {
	const withThinking = harness(t, {
		settings: { workerDefaultModel: "example-provider/cheap-model:low" },
	});
	await withThinking.execute({
		action: "spawn",
		title: "Cheap",
		task: "Research",
	});
	assert.equal(spawnedModel(withThinking), "example-provider/cheap-model:low");

	for (const bad of ["no-slash", "", "   ", 42, null]) {
		const s = harness(t, { settings: { workerDefaultModel: bad } });
		await s.execute({ action: "spawn", title: "Bad", task: "Research" });
		assert.equal(
			spawnedModel(s),
			"test/model:high",
			`malformed ${JSON.stringify(bad)} should fall back to the parent model`,
		);
	}
});

test("explicit spawn model beats workerDefaultModel; scoping wins over the setting", async (t) => {
	const explicit = harness(t, {
		settings: { workerDefaultModel: "example-provider/cheap-model" },
	});
	await explicit.execute({
		action: "spawn",
		title: "Explicit",
		task: "Research",
		model: "example-provider/frontier-model:medium",
	});
	assert.equal(spawnedModel(explicit), "example-provider/frontier-model:medium");

	// A model outside the session's scoped list is never forced on workers.
	const scopedCtx = { ...explicit.ctx } as Record<string, unknown>;
	scopedCtx.scopedModels = [{ provider: "test", id: "model" }];
	const scoped = harness(t, {
		settings: { workerDefaultModel: "example-provider/cheap-model" },
	});
	(scoped.ctx as Record<string, unknown>).scopedModels = [
		{ provider: "test", id: "model" },
	];
	await scoped.execute({ action: "spawn", title: "Scoped", task: "Research" });
	assert.equal(
		spawnedModel(scoped),
		"test/model:high",
		"scoped-out default must fall back to the parent model",
	);
});

test("shared notes refresh in request context without transcript mutation", async (t) => {
	const s = harness(t);
	const history: AgentMessage[] = [
		{ role: "user", content: "task", timestamp: 1 },
	];
	await s.execute({ action: "share", text: "First finding" });
	const first = await s.context(history);
	assert.equal(history.length, 1);
	assert.equal(first.messages.length, 2);
	assert.equal(first.messages[1].role, "custom");
	await s.execute({ action: "share", text: "New sibling finding" });
	const next = await s.context(first.messages);
	assert.equal(next.messages.length, 2);
	assert.match(JSON.stringify(next), /New sibling finding/);
	const notes = await s.execute({ action: "notes" });
	assert.match(JSON.stringify(notes.content), /First finding/);
});

test("wait finishes after worker exit; abort leaves detached work intact", async (t) => {
	const s = harness(t);
	const worker = await s.spawn();
	const waiting = s.execute({ action: "wait", id: worker.id });
	const agent = s.agents.get(worker.id);
	assert.ok(agent);
	agent.state = "idle";
	agent.proc = undefined;
	const result = await waiting;
	assert.match(JSON.stringify(result.content), /timedOut\\": false/);
	agent.state = "working";
	agent.proc = {
		kill() {
			throw new Error("must not kill");
		},
	};
	const controller = new AbortController();
	const interrupted = s.execute({ action: "wait" }, controller.signal);
	controller.abort();
	await assert.rejects(interrupted, { name: "AbortError" });
	assert.equal(agent.state, "working");
	assert.equal(
		s.calls.some((call) => call.kind === "cancel"),
		false,
	);
	const timed = await s.execute({ action: "wait", seconds: 1 });
	assert.match(JSON.stringify(timed.content), /timedOut\\": true/);
});

test("real Pi loader registers workers cleanly without starting processes", async (t) => {
	const s = setup(t);
	const loader = new DefaultResourceLoader({
		cwd: s.dir,
		agentDir: s.dir,
		settingsManager: SettingsManager.inMemory({
			packages: [
				{
					source: new URL("../../", import.meta.url).pathname,
					extensions: ["extensions/session-workers/index.ts"],
					skills: [],
				},
			],
		}),
		additionalExtensionPaths: [
			new URL("./index.ts", import.meta.url).pathname,
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.ok(loaded.extensions[0].tools.has("session_workers"));
});

test("background parents delegate; workers cannot create a second level", async (t) => {
	const s = harness(t);
	const key = Symbol.for("pi.inbox.agentChild");
	const previous = Reflect.get(globalThis, key);
	t.after(() => {
		if (previous === undefined) Reflect.deleteProperty(globalThis, key);
		else Reflect.set(globalThis, key, previous);
	});
	// The inbox consumes the env marker; process identity still survives.
	Reflect.set(globalThis, key, "parent");
	s.start();
	assert.equal(s.supervision[0]?.allowBackground, true);
	assert.equal(s.supervision[0]?.adoptSessionIds?.size, 0);
	await s.execute({ action: "spawn", title: "Child", task: "Read only" });
	const worker = s.team.workers("parent")[0];
	const ids = s.supervision.at(-1)?.adoptSessionIds;
	assert.ok(ids);
	assert.ok(ids.has(worker.id));
	assert.equal(ids.has("parent"), false);
	assert.equal(ids.size, 1);

	s.switchTo(worker.id);
	const count = s.supervision.length;
	s.start();
	assert.equal(s.supervision.length, count);
	const nested = () =>
		s.execute({
			action: "spawn",
			title: "Grandchild",
			task: "Must not run",
		});
	await assert.rejects(nested(), /maximum delegation depth: 1/);
	// Taking over a delegated worker doesn't remove its durable depth guard.
	Reflect.deleteProperty(globalThis, key);
	await assert.rejects(nested(), /maximum delegation depth: 1/);
	assert.equal(s.team.workers("parent").length, 1);

	Reflect.set(globalThis, key, "parent");
	s.switchTo("parent");
	await s.execute({ action: "send", id: worker.id, text: "Follow up" });
	assert.deepEqual(s.agents.get(worker.id)?.pending, ["Follow up"]);
	await s.execute({ action: "cancel", id: worker.id });
	assert.equal(s.agents.get(worker.id)?.state, "cancelled");
});

test("memory maintenance cannot delegate", async (t) => {
	const s = harness(t);
	const old = process.env.BIGBRAIN_MAINT;
	t.after(() => {
		if (old === undefined) delete process.env.BIGBRAIN_MAINT;
		else process.env.BIGBRAIN_MAINT = old;
	});
	process.env.BIGBRAIN_MAINT = "1";
	s.start();
	await assert.rejects(
		s.execute({
			action: "spawn",
			title: "Maintenance",
			task: "Must not run",
		}),
		/cannot spawn/,
	);
	assert.equal(await s.context([]), undefined);
	assert.equal(s.calls.length, 0);
	assert.equal(s.supervision.length, 0);
});
