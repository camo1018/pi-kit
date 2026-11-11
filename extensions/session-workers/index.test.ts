import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the agent directory before any module resolves it. The harness gives
// WorkerTeam its own temp dir, but `trace.ts` calls `getAgentDir()`, which falls
// back to the real ~/.pi/agent -- so without this the suite appends its fixture
// events to the live wake trace and buries the diagnostics it exists to provide.
if (!process.env.PI_CODING_AGENT_DIR) {
	const isolated = mkdtempSync(join(tmpdir(), "pi-session-workers-test-"));
	process.env.PI_CODING_AGENT_DIR = isolated;
	process.on("exit", () => {
		try {
			rmSync(isolated, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});
}
import { test, type TestContext } from "node:test";
import {
	DefaultResourceLoader,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentEvent } from "../../lib/inbox-agents.ts";
import { registerSessionWorkers } from "./index.ts";
import { pumpWakeRequest, resetWakeListeners } from "./wake.ts";
import {
	claimEpisodeWake,
	releaseEpisodeClaim,
} from "./wake-queue.ts";
import {
	consumeWakeRequest,
	readWakeArm,
	writeWakeArm,
	readWakeRequest,
	writeReported,
	writeWakeRequest,
} from "./wake-queue.ts";
import { setup } from "./test-utils.ts";

function harness(
	t: TestContext,
	options: {
		settings?: Record<string, unknown>;
		debounceMs?: number;
		/** Interactive parents wake themselves; background runs go durable. */
		mode?: "tui" | "json";
		/** Register the parent as a live agent (background parents always are). */
		addParent?: boolean;
		/** Simulate a second process on an existing team directory. */
		reuseTeam?: ReturnType<typeof setup>["team"];
	} = {},
) {
	const s = setup(t, options.reuseTeam);
	const handlers = new Map<string, unknown>();
	const sent: { message: any; options: any }[] = [];
	let failSend = false;
	let tool: ToolDefinition | undefined;
	const pi = {
		on(name: string, handler: unknown) {
			handlers.set(name, handler);
		},
		registerTool(definition: ToolDefinition) {
			tool = definition;
		},
		getSettings: () => options.settings ?? {},
		sendMessage(message: any, sendOptions: any) {
			if (failSend) throw new Error("stale context");
			sent.push({ message, options: sendOptions });
		},
	} as unknown as ExtensionAPI;
	// Tests drive agent events directly; the process-wide registry would leak
	// state between cases.
	let emit: ((event: AgentEvent) => void) | undefined;
	resetWakeListeners();
	t.after(() => resetWakeListeners());
	registerSessionWorkers(pi, s.team, {
		subscribe(fn) {
			emit = fn;
			return () => {
				emit = undefined;
			};
		},
		debounceMs: options.debounceMs ?? 0,
	});
	if (options.addParent) s.addParent();
	let caller = "parent";
	const ctx = {
		cwd: s.dir,
		mode: options.mode ?? "tui",
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
	const shutdown = () => {
		const handler = handlers.get("session_shutdown") as (
			event: unknown,
			ctx: ExtensionToolContext,
		) => void;
		handler({ reason: "quit" }, ctx);
	};
	const fireInput = (text: string, source: string) => {
		const handler = handlers.get("input") as (
			event: { text: string; source: string },
			ctx: ExtensionToolContext,
		) => void;
		handler({ text, source }, ctx);
	};
	const input = (source: "interactive" | "extension" = "interactive") => {
		fireInput("hello", source);
	};
	const inputText = (
		text: string,
		source: "interactive" | "extension" = "interactive",
	) => fireInput(text, source);
	return {
		...s,
		tool,
		execute,
		context,
		ctx,
		start,
		shutdown,
		input,
		inputText,
		sent,
		setFailSend(value: boolean) {
			failSend = value;
		},
		emit(event: AgentEvent) {
			assert.ok(emit, "worker wake listener is not installed");
			emit(event);
		},
		hasListener: () => !!emit,
		/** The durable request a background parent leaves behind. */
		pendingWake: (id = "parent") => readWakeRequest(s.team.stateDir, id),
		addParent: s.addParent,
		pump() {
			return pumpWakeRequest(s.team, caller);
		},
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
	const scoped = harness(t, {
		settings: { workerDefaultModel: "example-provider/cheap-model" },
	});
	(scoped.ctx as Record<string, unknown>).scopedModels = [
		{ model: { provider: "test", id: "model" } },
	];
	await scoped.execute({ action: "spawn", title: "Scoped", task: "Research" });
	assert.equal(
		spawnedModel(scoped),
		"test/model:high",
		"scoped-out default must fall back to the parent model",
	);
});

test("workerDefaultModel survives scoping when in scope", async (t) => {
	// Regression: ctx.scopedModels holds { model: { provider, id } } entries
	// (ScopedModel), so a flat shape check scoped every default out and
	// silently fell back to the parent's model.
	const s = harness(t, {
		settings: {
			workerDefaultModel: "example-provider/cheap-model",
		},
	});
	(s.ctx as Record<string, unknown>).scopedModels = [
		{ model: { provider: "test", id: "model" } },
		{ model: { provider: "example-provider", id: "cheap-model" } },
	];
	await s.execute({ action: "spawn", title: "In scope", task: "Research" });
	assert.equal(spawnedModel(s), "example-provider/cheap-model");
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

	// Same board on next request -> not injected again
	const second = await s.context(first.messages);
	assert.equal(second.messages.length, 1);
	assert.equal(second.messages[0].role, "user");

	await s.execute({ action: "share", text: "New sibling finding" });
	const next = await s.context(second.messages);
	assert.equal(next.messages.length, 2);
	assert.match(JSON.stringify(next), /New sibling finding/);
	const notes = await s.execute({ action: "notes" });
	assert.match(JSON.stringify(notes.content), /First finding/);
});

test("injection cursor tracks sessions independently and retract updates board", async (t) => {
	const s = harness(t);
	const history: AgentMessage[] = [
		{ role: "user", content: "task", timestamp: 1 },
	];
	const shareRes = await s.execute({ action: "share", text: "Temporary note" });
	const noteId = (shareRes.details as { data: { id: string } }).data.id;

	// First session receives note
	const firstTurn = await s.context(history);
	assert.equal(firstTurn.messages.length, 2);
	assert.match(JSON.stringify(firstTurn.messages[1]), /Temporary note/);

	// First session again with unchanged board: not injected
	const secondTurn = await s.context(firstTurn.messages);
	assert.equal(secondTurn.messages.length, 1);

	// Switch to a second session: spawn a worker on the team
	const worker = await s.spawn();
	s.switchTo(worker.id);
	const workerTurn = await s.context(history);
	assert.equal(workerTurn.messages.length, 2);
	assert.match(JSON.stringify(workerTurn.messages[1]), /Temporary note/);

	// Retract the note as worker (team member)
	await s.execute({ action: "retract", noteId });

	// Retract of unknown id errors
	await assert.rejects(
		s.execute({ action: "retract", noteId }),
		/does not exist in this team/,
	);
	await assert.rejects(s.execute({ action: "retract" }), /requires noteId/);

	// Context for worker and parent now has no notes
	const afterRetract = await s.context(history);
	assert.equal(afterRetract.messages.length, 1);
	s.switchTo("parent");
	const parentAfterRetract = await s.context(history);
	assert.equal(parentAfterRetract.messages.length, 1);
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

test("wait surfaces idle handoffs and unknown status without polling",
	async (t) => {
	const s = harness(t);
	const worker = await s.spawn();
	const agent = s.agents.get(worker.id);
	assert.ok(agent);
	agent.state = "idle";
	agent.proc = undefined;
	const idle = await s.execute({ action: "wait", id: worker.id });
	const data = idle.details as { data: {
		outcome: string; timedOut: boolean;
		workers: { parentAction: string }[];
	} };
	assert.equal(data.data.outcome, "settled");
	assert.equal(data.data.timedOut, false);
	assert.equal(data.data.workers[0].parentAction,
		"inspect_result_and_decide_next_step");

	// Dead mid-tool-use transcripts do not imply an active process.
	s.agents.delete(worker.id);
	const unknown = await s.execute({
		action: "wait", id: worker.id, seconds: 60,
	});
	const missing = unknown.details as { data: {
		outcome: string; timedOut: boolean;
		workers: { state: string; busy: boolean; parentAction: string }[];
	} };
	assert.equal(missing.data.outcome, "needs_attention");
	assert.equal(missing.data.timedOut, false);
	assert.equal(missing.data.workers[0].state, "unknown");
	assert.equal(missing.data.workers[0].busy, false);
	assert.equal(missing.data.workers[0].parentAction, "inspect_status");
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

/** The wake evaluation is debounced, so every settle needs a macrotask. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function settle(
	s: ReturnType<typeof harness>,
	id: string,
	patch = {},
) {
	const agent = s.agents.get(id);
	assert.ok(agent);
	Object.assign(agent, {
		state: "idle",
		proc: undefined,
		pending: [],
		...patch,
	});
	s.emit({ type: "finished", agent } as AgentEvent);
	await tick();
}

/** The notes board injected into request context, as plain text. */
async function board(s: ReturnType<typeof harness>): Promise<string> {
	const out = await s.context([]);
	return (out.messages ?? [])
		.filter((m: any) => m.role === "custom")
		.map((m: any) => String(m.content))
		.join("\n");
}

function working(s: ReturnType<typeof harness>, id: string) {
	const agent = s.agents.get(id);
	assert.ok(agent);
	agent.state = "working";
	agent.proc = { kill() {} };
}

/** The hook only wakes after it has seen the team busy at least once. */
async function arm(s: ReturnType<typeof harness>, id: string) {
	working(s, id);
	s.emit({ type: "changed" });
	await tick();
}

test("wake fires exactly once when the last worker settles", async (t) => {
	const s = harness(t);
	s.start();
	const first = await s.spawn();
	const second = await s.spawn();
	await settle(s, first.id);
	assert.equal(s.sent.length, 0);
	await settle(s, second.id);
	assert.equal(s.sent.length, 1);
	const [{ message, options }] = s.sent;
	assert.equal(message.customType, "pi-kit:worker-wake");
	assert.equal(message.display, false);
	assert.equal(options.triggerTurn, true);
	assert.equal(options.deliverAs, "followUp");
	assert.match(message.content, /have settled/);
	assert.equal(message.details.workers.length, 2);
});

test("no wake when the team never ran", (t) => {
	const s = harness(t);
	s.start();
	// No worker is registered in this team, so nothing can arm the hook.
	s.emit({ type: "changed" });
	assert.equal(s.sent.length, 0);
});

test("no wake while a sibling is still working", async (t) => {
	const s = harness(t);
	s.start();
	const first = await s.spawn();
	const second = await s.spawn();
	await settle(s, first.id);
	working(s, second.id);
	s.emit({ type: "changed" });
	assert.equal(s.sent.length, 0);
});

test("run_end with queued messages is not a settle", async (t) => {
	const s = harness(t);
	s.start();
	const worker = await s.spawn();
	const agent = s.agents.get(worker.id);
	assert.ok(agent);
	Object.assign(agent, {
		state: "queued",
		proc: undefined,
		pending: ["continue"],
	});
	s.emit({ type: "run_end", agent } as AgentEvent);
	assert.equal(s.sent.length, 0);
});

test("a worker error still wakes and reports the error", async (t) => {
	const s = harness(t);
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id, { state: "error", error: "boom" });
	assert.equal(s.sent.length, 1);
	assert.match(JSON.stringify(s.sent[0].message), /boom/);
});

test("a cancelled worker wakes through the changed event", async (t) => {
	const s = harness(t);
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id, { state: "cancelled" });
	s.emit({ type: "changed" });
	assert.equal(s.sent.length, 1);
});

test("two settles in one debounce window coalesce to one wake", async (t) => {
	const s = harness(t, { debounceMs: 5 });
	s.start();
	const first = await s.spawn();
	const second = await s.spawn();
	await settle(s, first.id);
	await settle(s, second.id);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(s.sent.length, 1);
});

test("an unchanged terminal state never wakes twice", async (t) => {
	const s = harness(t);
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.equal(s.sent.length, 1);
	s.emit({ type: "changed" });
	await tick();
	await settle(s, worker.id);
	s.emit({ type: "changed" });
	await tick();
	assert.equal(s.sent.length, 1);
});

test("wake cycles are capped until real user input", async (t) => {
	const s = harness(t);
	s.start();
	const worker = await s.spawn();
	// Three fan-outs may wake on their own; a fourth cycle may not.
	for (let cycle = 0; cycle < 5; cycle += 1) {
		await arm(s, worker.id);
		await settle(s, worker.id, { runs: cycle + 2 });
	}
	assert.equal(s.sent.length, 3);
	// Extension-originated input must not reopen the budget.
	s.input("extension");
	await arm(s, worker.id);
	await settle(s, worker.id, { runs: 90 });
	assert.equal(s.sent.length, 3);
	// Real user input does, and the cap applies again from there.
	s.input("interactive");
	for (let cycle = 0; cycle < 5; cycle += 1) {
		await arm(s, worker.id);
		await settle(s, worker.id, { runs: cycle + 100 });
	}
	assert.equal(s.sent.length, 6);
});

test("a background run never spawns a second writer", async (t) => {
	// A background parent IS the session this process is running. Spawning a
	// background run for it would open a second `pi --session-id <parent>` next
	// to the live one: two writers on one session file. The request must stay
	// queued for the next turn instead.
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	assert.equal(s.hasListener(), true);
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.equal(s.sent.length, 0, "must not send into its own session");
	assert.equal(
		s.calls.filter((call) => call.kind === "send").length,
		0,
		"must not spawn a second writer for its own session",
	);
	const pending = s.pendingWake();
	assert.ok(pending, "the wake must stay queued for the next turn");
	assert.match(pending.content, /settled/);
});

test("another holder delivers the queued wake as a run", async (t) => {
	// A different process (an inbox window) holds the parent; it is not running
	// that session, so a queued background run is the right delivery.
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.ok(s.pendingWake());
	// The observer is some other session entirely.
	s.switchTo("some-other-session");
	assert.equal(s.pump(), true);
	const queued = s.calls.filter((call) => call.kind === "send");
	assert.equal(queued.length, 1);
	assert.equal((queued[0].data as { id: string }).id, "parent");
	assert.equal(s.pendingWake(), undefined);
});

test("a background run's own sweep never spawns a second writer", async (t) => {
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	// Idempotent, and never a second `pi --session-id parent`.
	s.pump();
	s.pump();
	assert.equal(
		s.calls.filter((call) => call.kind === "send").length,
		0,
	);
	assert.ok(s.pendingWake(), "the wake stays queued for the next turn");
});

test("a queued wake is not duplicated by later settles", async (t) => {
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	const first = s.pendingWake();
	assert.ok(first);
	await settle(s, worker.id, { runs: 9 });
	assert.equal(
		s.pendingWake()?.nonce,
		first.nonce,
		"a second settle must not replace the queued wake",
	);
});

test("a user reply clears the arming so the next settle can wake", async (t) => {
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.ok(s.pendingWake());
	// The team is finished, so a reply supersedes the queued wake entirely.
	s.input("interactive");
	assert.equal(s.pendingWake(), undefined);
	assert.equal(readWakeArm(s.team.stateDir, "parent"), undefined);
});

test("a reply while the team still runs keeps the wake it is owed", async (t) => {
	// Regression: this branch wrote `{ armed: true, signature: undefined }`.
	// `undefined` is the "leave it alone" sentinel, not the clear, and arming
	// was wrong too: after an idle reply had deleted the arm files, the write
	// recreated them as `{ armed: true, episode: 0 }`. The busy sweep then took
	// `if (arm?.armed)` and never bumped the episode, and the settle skipped on
	// `episode === 0`, so that fan-out could never wake at all, silently.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	assert.ok(readWakeArm(s.team.stateDir, "parent")?.armed);

	// A steering reply arrives while the worker is still running.
	s.inputText("also check the other service");
	s.pump();

	await settle(s, worker.id);
	assert.equal(s.sent.length, 1, "the owed wake must still fire");
	const arm2 = readWakeArm(s.team.stateDir, "parent");
	assert.equal(arm2?.signature, "1", "one wake for one episode");
});

test("a steer reply after an idle reply still wakes the new fan-out", async (t) => {
	// The exact sequence that used to strand a team. An idle reply deletes the
	// arm files; the next fan-out's reply-while-busy branch then wrote
	// `{ armed: true, signature: undefined }`, leaving `episode: 0`. The busy
	// sweep skipped the bump because `armed` was already true, and the settle
	// skipped on `episode === 0` -- no wake, ever, with no trace of why.
	const s = harness(t, { mode: "tui" });
	s.start();

	// First fan-out settles and is read: the reply clears the arm files.
	const first = await s.spawn();
	await arm(s, first.id);
	await settle(s, first.id);
	assert.equal(s.sent.length, 1);
	s.inputText("thanks, now do the other one");
	assert.equal(
		readWakeArm(s.team.stateDir, "parent"),
		undefined,
		"an idle reply drops the arm files",
	);

	// Second fan-out starts, and the user steers it before any sweep has seen
	// it busy. This is the ordering that stranded the team: with no arm file on
	// disk the reply branch used to CREATE one as `{ armed: true, episode: 0 }`,
	// and the sweep then treated that as a live episode and never opened one.
	const second = await s.spawn();
	working(s, second.id);
	s.inputText("also check the retry path");
	assert.equal(readWakeArm(s.team.stateDir, "parent")?.episode, 0);

	// Now the sweep observes the team busy, then it settles.
	s.emit({ type: "changed" });
	await tick();
	assert.equal(readWakeArm(s.team.stateDir, "parent")?.episode, 1);
	await settle(s, second.id);
	assert.equal(s.sent.length, 2, "the second fan-out must still wake");
});

test("an armed episode-0 record left on disk still wakes", async (t) => {
	// The old reply-while-busy write could persist `{ armed: true, episode: 0 }`.
	// The settle branch skips `episode === 0`, so such a record stranded the
	// team forever. The busy branch must open an episode for it.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	writeWakeArm(s.team.stateDir, "parent", { armed: true, episode: 0 });
	await arm(s, worker.id);
	assert.equal(readWakeArm(s.team.stateDir, "parent")?.episode, 1);
	await settle(s, worker.id);
	assert.equal(s.sent.length, 1);
});

test("an unchanged team state is never woken twice", async (t) => {
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	const first = s.pendingWake();
	assert.ok(first);
	// Same terminal state, event repeated: the stored signature suppresses it,
	// so the queued wake is untouched rather than rewritten.
	await settle(s, worker.id);
	s.pump();
	assert.equal(s.pendingWake()?.nonce, first.nonce);
	assert.equal(s.calls.filter((c) => c.kind === "send").length, 0);
});

test("a wake's own input does not reset its budget or re-arm", async (t) => {
	// The wake reaches a background parent as a queued run whose prompt pi
	// reports as ordinary input, so an unmarked wake would look like a user
	// reply: it would clear the arming and reset the budget, guaranteeing
	// another wake, forever. Observed live as two unprompted wakes in a row.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.equal(s.sent.length, 1);

	const wakeText = String(s.sent[0].message.content);
	assert.match(wakeText, /^\[pi-kit wake\]/, "wake must be marked");
	s.inputText(wakeText);
	assert.ok(
		readWakeArm(s.team.stateDir, "parent"),
		"a wake must not wipe its own arming record",
	);

	// A real reply still resets it.
	s.inputText("a genuine user message");
	assert.equal(readWakeArm(s.team.stateDir, "parent"), undefined);
});

test("an already-settled team produces no wake on load", async (t) => {
	// Regression: an arming file left behind with episode 0 (no busy window
	// ever observed) must not wake. Without this the sweep wakes for a team
	// that has not run in this episode.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	writeWakeArm(s.team.stateDir, "parent", { armed: true, episode: 0 });
	await settle(s, worker.id);
	assert.equal(s.sent.length, 0);
});

test("a second fan-out wakes again after the first one settled", async (t) => {
	// Regression: worker state was the wake signature, but production RELEASES a
	// settled worker from the registry. The signature then froze at the released
	// set and every later fan-out for the same parent was deduped forever.
	// The harness must model that release, or the bug is invisible.
	const s = harness(t, { mode: "tui" });
	s.start();
	const first = await s.spawn();
	await arm(s, first.id);
	await settle(s, first.id);
	assert.equal(s.sent.length, 1);
	// Released after settling, exactly as releaseAgent does in production.
	s.agents.delete(first.id);

	// A second, unrelated fan-out by the same parent.
	const second = await s.spawn();
	await arm(s, second.id);
	await settle(s, second.id);
	assert.equal(s.sent.length, 2, "the second fan-out must wake too");
});

test("a process whose own session is NOT the parent still wakes it", async (t) => {
	// This is the topology that made the shipped feature never fire: a
	// background parent's workers get adopted and settled by whichever process
	// is alive, and that process's own session is a different one. Scoping the
	// sweep to the listener's own session meant the settle was observed
	// somewhere that was not allowed to act on it.
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);

	// The observer is a different session entirely (an inbox window, say).
	s.switchTo("some-other-session");
	await settle(s, worker.id);

	assert.equal(
		s.calls.filter((call) => call.kind === "send").length,
		1,
		"the settling process must wake the parent even though it is not the parent",
	);
	const queued = s.calls.find((call) => call.kind === "send");
	assert.equal((queued?.data as { id: string }).id, "parent");
});

test("a wake left on disk by a crashed run is delivered next", async (t) => {
	// If the settling run dies between writing the request and delivering it,
	// the request must survive and the next process must finish the job.
	const first = harness(t, { mode: "json", addParent: true });
	first.start();
	const worker = await first.spawn();
	await arm(first, worker.id);
	await settle(first, worker.id);
	first.shutdown();

	// Simulate the crash: a request present, nothing delivered.
	const second = harness(t, {
		mode: "tui",
		reuseTeam: first.team,
		addParent: true,
	});
	writeWakeRequest(first.team.stateDir, {
		parentId: "parent",
		content: "All 1 delegated worker has settled.",
		workers: [],
	});
	second.start();
	assert.equal(second.team.parent("parent"), "parent");
	assert.equal(second.pump(), true);
	assert.equal(second.pendingWake(), undefined);
	// Delivered in-process: this process holds the parent's runtime.
	assert.equal(second.sent.length, 1);
	assert.equal(second.sent[0].options.deliverAs, "followUp");
	assert.match(String(second.sent[0].message.content), /settled/);
});


test("a worker session never pumps a wake for itself", async (t) => {
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	s.switchTo(worker.id);
	assert.equal(s.pump(), false);
});

test("an interactive parent still wakes itself with one message", async (t) => {
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.equal(s.sent.length, 1);
	assert.equal(s.pendingWake(), undefined);
});

test("one listener follows the active session across a switch", async (t) => {
	const s = harness(t);
	s.start();
	const worker = await s.spawn();
	s.switchTo("elsewhere");
	s.start();
	// The worker's parent is no longer the active session: never inject there.
	await settle(s, worker.id);
	assert.equal(s.sent.length, 0);
	const other = await s.spawn("elsewhere");
	await arm(s, other.id);
	await settle(s, other.id);
	assert.equal(s.sent.length, 1);
	assert.equal(s.sent[0].message.details.parentId, "elsewhere");
});

test("a throwing sendMessage does not break the listener", async (t) => {
	const s = harness(t);
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	s.setFailSend(true);
	await settle(s, worker.id);
	assert.equal(s.sent.length, 0);
	s.setFailSend(false);
	// The failed send must not consume the wake this fan-out was owed.
	await arm(s, worker.id);
	await settle(s, worker.id, { runs: 7 });
	assert.equal(s.sent.length, 1);
});

test("only the newest wake message survives the context filter", async (t) => {
	const s = harness(t);
	const wake = (at: number) => ({
		role: "custom" as const,
		customType: "pi-kit:worker-wake",
		content: `wake ${at}`,
		display: false,
		timestamp: at,
	});
	const history = [
		wake(1),
		{ role: "user" as const, content: "hi", timestamp: 2 },
		wake(3),
	] as unknown as AgentMessage[];
	const result = await s.context(history);
	const kept = result.messages.filter(
		(message) => message.role === "custom",
	);
	assert.equal(kept.length, 1);
	assert.match(JSON.stringify(kept[0]), /wake 3/);
});

test("arming survives the run process exit", async (t) => {
	// Regression: `armed` used to live only in module memory. A background
	// parent gets a fresh process every turn, so it was gone by the turn in
	// which the team settled, and no wake was ever written.
	const first = harness(t, { mode: "json", addParent: true });
	first.start();
	const worker = await first.spawn();
	// Turn 1: see the team running, then the process ends.
	working(first, worker.id);
	first.emit({ type: "changed" });
	await tick();
	first.shutdown();

	// Turn 2: a brand new process, unarmed in memory, finds the team settled.
	const second = harness(t, {
		mode: "json",
		reuseTeam: first.team,
		addParent: true,
	});
	second.start();
	// The new process adopts the worker; that is the only way it can see it.
	second.adopt(worker);
	second.emit({ type: "changed" });
	await tick();
	// This run also *is* the parent session, so it leaves the wake queued
	// rather than spawning a second writer -- but it must have written it.
	assert.ok(
		second.pendingWake(),
		"the new process must record a wake even though it never saw the team busy",
	);
});

test("a fresh process does not wake for an already-settled team", async (t) => {
	// The counterpart guard: durable arming must not make every load of a
	// finished team fire a wake.
	const first = harness(t, { mode: "json", addParent: true });
	first.start();
	const worker = await first.spawn();
	first.shutdown();

	const second = harness(t, {
		mode: "json",
		reuseTeam: first.team,
		addParent: true,
	});
	second.start();
	second.adopt(worker);
	second.emit({ type: "changed" });
	await tick();
	assert.equal(second.pendingWake(), undefined);
});

test("a released worker counts as settled, not as hidden", async (t) => {
	// Regression: a worker deleted from the registry after settling used to make
	// the whole team invisible (teamAgents returned undefined), suppressing the
	// wake forever.
	const s = harness(t);
	s.start();
	const mine = await s.spawn();
	const released = await s.spawn();
	await arm(s, mine.id);
	// The sibling finished and was released; it is no longer in the registry.
	s.agents.delete(released.id);
	await settle(s, mine.id);
	assert.equal(s.sent.length, 1);
});


test("session shutdown disarms a pending wake", async (t) => {
	const s = harness(t, { debounceMs: 20 });
	s.start();
	const worker = await s.spawn();
	await settle(s, worker.id);
	s.shutdown();
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(s.sent.length, 0);
});

/**
 * A live-session record, as extensions/inbox writes while a run is in flight.
 * `foregroundDisposition` reads these to place a worker this process does not
 * hold, so a test that fakes a foreign run must fake one of these too.
 */
function writeLiveRecord(
	agentDir: string,
	sessionId: string,
	pid: number,
	state: "working" | "idle" = "working",
	updated = Date.now(),
) {
	const dir = join(agentDir, "inbox-live");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${pid}.json`),
		JSON.stringify({
			pid,
			sessionId,
			sessionFile: join(agentDir, `${sessionId}.jsonl`),
			state,
			updated,
		}),
		"utf-8",
	);
}

/** Write an archive mark exactly as the Inbox does, for one session. */
function archive(agentDir: string, id: string) {
	writeFileSync(
		join(agentDir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: { [id]: { archivedAt: Date.now() } },
		}),
		"utf-8",
	);
}

test("a released worker is not settled merely because it is absent", async (t) => {
	// Regression, and the one that caused a live incident: teamAgents computed a
	// `disposition` from the live session records precisely so a worker this
	// process does not hold could be placed, but the sweep only read `agent`.
	// quiescence(undefined) is "settled", so EVERY team on disk whose workers had
	// been released looked finished at once. One load swept them all, woke each
	// parent, and the spawned runs woke the rest: the whole archived backlog
	// came back to the inbox.
	const s = harness(t, { mode: "json", addParent: true });
	writeWakeArm(s.team.stateDir, "parent", { armed: true, episode: 1 });
	const worker = await s.spawn();
	// Released after settling, and a live record proves a run is in flight in
	// another process: this worker is NOT settled.
	s.agents.delete(worker.id);
	writeLiveRecord(s.team.agentDir, worker.id, process.pid);
	await tick();
	s.pump();
	// A delivered wake consumes its request, so the request alone cannot tell
	// a refusal from a spawn. The spawn is the damage: it starts a run on a
	// session that is finishing work in another process.
	assert.equal(
		s.calls.filter((c) => c.kind === "send").length,
		0,
		"a foreign running worker must not look settled",
	);
	assert.equal(s.pendingWake(), undefined);
});

test("a real reply reopens the wake budget after it is spent", async (t) => {
	// Regression: `writeWakeArm` floors `wakes` against disk so a stale
	// concurrent writer cannot rewind the consecutive-wake cap. `resetWakeBudget`
	// still wrote a bare `wakes: 0`, which that floor turned into a no-op, so a
	// real user reply could no longer reopen the budget. Once a session had used
	// its three wakes it stayed capped for good: the parent would silently never
	// be woken again, however much new work it delegated.
	const s = harness(t, { mode: "tui" });
	s.start();
	// A worker must still be running: an idle reply deletes the whole arming
	// record, so the count would be unobservable rather than reset.
	const worker = await s.spawn();
	working(s, worker.id);
	writeWakeArm(s.team.stateDir, "parent", { wakes: 3, armed: true, episode: 1 });
	assert.equal(readWakeArm(s.team.stateDir, "parent")?.wakes, 3);

	s.inputText("a genuine user message");
	assert.equal(
		readWakeArm(s.team.stateDir, "parent")?.wakes,
		0,
		"user input must reopen the wake budget",
	);
});

test("a stale writer cannot rewind the wake budget", async (t) => {
	// The other half of the contract: the floor must still hold for an ordinary
	// merge, or two processes sweeping one team can restore a stale count and
	// defeat the cap. Only the explicit `null` reset may lower `wakes`.
	const s = harness(t, { mode: "tui" });
	s.start();
	writeWakeArm(s.team.stateDir, "parent", { wakes: 3 });
	writeWakeArm(s.team.stateDir, "parent", { wakes: 1, armed: true });
	assert.equal(
		readWakeArm(s.team.stateDir, "parent")?.wakes,
		3,
		"a stale write must not rewind the cap",
	);
});

test("a stale idle live record does not mask a live run on the same session", async (t) => {
	// Regression, caught by orchestrate testing the fix itself: a wake claimed
	// "all workers settled" 4s after spawn while both were still running.
	//
	// Several live records can name one session (an orphan left mid-turn by a
	// closed tab, plus the run that reopened it). `readdirSync` orders by
	// filename, which is the pid, NOT time, so first-match returned whichever
	// pid sorted lowest. A stale `idle` record from a replaced pid therefore
	// shadowed the live `working` run and the team looked settled. The Inbox's
	// liveStates() already picks the freshest heartbeat; foreground() must too.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	// The pids must be REAL and alive: foreground() drops a record whose pid is
	// not running, so a fake pid is skipped rather than ranked. A low pid writes
	// the stale idle record, so first-match would pick it.
	const stale = process.ppid;
	const fresh = process.pid;
	assert.ok(fresh > stale, "test assumes the child pid is the highest");
	writeLiveRecord(
		s.team.agentDir, worker.id, stale, "idle", Date.now() - 60_000,
	);
	writeLiveRecord(s.team.agentDir, worker.id, fresh, "working", Date.now());
	assert.equal(
		s.team.foregroundDisposition(worker.id),
		"running",
		"the freshest live record must win, not the lowest pid",
	);
	// A released worker with no live record at all is still settled.
	assert.equal(s.team.foregroundDisposition("no-such-worker"), "settled");
});

test("a just-spawned worker with no live record yet is not settled", async (t) => {
	// `spawn` persists the durable agent record before the child exists, and the
	// child writes its live record only after extensions load. A foreign sweep
	// in that gap saw neither agent nor live record and called the team
	// finished. The durable record must be honoured as "not settled".
	//
	// The state written here must be one real `spawnAgent` actually persists.
	// It is `"queued"` (lib/inbox-agents.ts), NOT `"working"`: the run only
	// flips to `"working"` at `run_start`. This fixture previously hardcoded
	// `"working"`, which is why the queue-window wake below shipped green.
	const s = harness(t, { mode: "json", addParent: true });
	s.start();
	const worker = await s.spawn();
	s.agents.delete(worker.id);
	writeSavedRecord(s.team.agentDir, worker.id, { state: "queued" });
	assert.equal(
		s.team.foregroundDisposition(worker.id),
		"unknown",
		"a queued worker that has not started yet must not read as settled",
	);
});

test("a queued worker must not read as settled", async (t) => {
	// `spawnAgent` persists `state: "queued"` and only `run_start` moves it to
	// "working". `foregroundDisposition` used to special-case only "working",
	// so a freshly spawned worker fell through to "settled" for the whole
	// window between spawn and the child's first `inbox-live` write -- about two
	// seconds on a real machine. Every `wake: true` fan-out whose sweep tick
	// landed in that window woke its parent while the work had not begun.
	const s = harness(t, { mode: "json", addParent: true });
	s.start();
	const worker = await s.spawn();
	// No registry entry and no live record: exactly the spawn window.
	s.agents.delete(worker.id);
	writeSavedRecord(s.team.agentDir, worker.id, { state: "queued" });
	assert.equal(
		s.team.foregroundDisposition(worker.id),
		"unknown",
		"queued means spawned-but-not-started, which is not settled",
	);
});

test("a sweep inside the spawn window does not wake the parent", async (t) => {
	// End-to-end form of the same defect, with the arm shaped the way a
	// long-lived parent really leaves it: a previous fan-out already opened and
	// answered an episode, so `armed` is false but `episode`/`wakeOptIn` remain.
	//
	// A parent that has delegated before is the common case, and it is the one
	// that bit in production -- a brand-new parent has nothing armed, so the
	// settle branch returns early and the bug is invisible there. Without that
	// leftover state this test would pass with the defect present, which is the
	// vacuous shape it used to have.
	const s = harness(t, { mode: "json", addParent: true });
	s.start();
	writeWakeArm(s.team.stateDir, "parent", {
		armed: true,
		episode: 3,
		wakes: 2,
		wakeOptIn: true,
		signature: "2",
	});
	const first = await s.spawn();
	const second = await s.spawn();
	for (const worker of [first, second]) {
		s.agents.delete(worker.id);
		writeSavedRecord(s.team.agentDir, worker.id, { state: "queued" });
	}
	s.pump();
	assert.equal(s.pendingWake(), undefined, "no wake inside the spawn window");
	assert.equal(sendCount(s), 0, "and nothing delivered to the parent");
	// The arm must not record this episode as settled either: a signature (or a
	// spent wake) written here is what burns the consecutive-wake budget before
	// the work even begins.
	const arm = JSON.parse(armRaw(s) ?? "{}");
	assert.equal(arm.signature, "2", "the episode is open, not settled");
	assert.equal(arm.wakes, 2, "no wake budget spent inside the window");
	assert.deepEqual(
		[...(arm.pendingWorkers ?? [])].sort(),
		[first.id, second.id].sort(),
		"both workers stay owed a wake once they really finish",
	);
});

test("a settle writer cannot disarm an episode a concurrent arm just opened", async (t) => {
	// The floor on `wakes` does not prevent a lost update on `armed`: with no
	// lock, two writers can read the same pre-update state and the later rename
	// wins outright. A settle-branch write carrying `armed: false` from a stale
	// read would stomp the `armed: true` a busy-branch write just set for a new
	// episode, emitting a spurious wake and spending budget mid-fan-out.
	const s = harness(t, { mode: "tui" });
	s.start();
	// Writer A opens episode 5 and arms it.
	writeWakeArm(s.team.stateDir, "parent", {
		armed: true,
		episode: 5,
		signature: null,
	});
	// Writer B, holding a stale read from before A, concludes the previous
	// episode settled and disarms without advancing the episode.
	const after = writeWakeArm(s.team.stateDir, "parent", {
		armed: false,
		episode: 4,
		signature: "4",
		wakes: 1,
	});
	assert.equal(after.armed, true, "the newer episode's arming must survive");
	assert.equal(after.episode, 5, "episode still only moves forward");
});


test("a wake is NOT suppressed for an archived parent", async (t) => {
	// Name corrected: this does not exercise un-archiving. `wake.ts` no longer
	// reads `inbox.json` at all, so the mark written below is inert — neutering
	// `archive()` entirely leaves this passing. What it actually pins is that no
	// archive-based suppression is re-added, which is worth pinning on its own.
	// The un-archive feature has its own test further down.
	//
	// Context: archiving a session while its children still run is a premature
	// archive, and the wake correcting it is intended.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	archive(s.team.agentDir, "parent");
	await settle(s, worker.id);
	assert.equal(
		s.sent.length,
		1,
		"a wake must still be delivered for an archived parent",
	);
	assert.equal(s.pendingWake(), undefined, "and it consumes its request");
});

test("a wake is NOT suppressed for a hidden parent", async (t) => {
	// `filter: "hide"` is the same class of manual filing as archive, and
	// `agent_start` clears it for the same reason. No suppression either way.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	writeFileSync(
		join(s.team.agentDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: { parent: { filter: "hide" } } }),
		"utf-8",
	);
	await settle(s, worker.id);
	assert.equal(s.sent.length, 1);
});

test("an already-settled team does NOT wake just because it is archived or not", async (t) => {
	// The incident guard that remains. A team whose workers settled long ago must
	// not wake, archived or not: only a busy observation opens an episode. This is
	// what stops a load from sweeping every historical team at once.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	// No `arm` call: no busy window was ever observed for this team.
	await settle(s, worker.id);
	s.pump();
	assert.equal(s.sent.length, 0, "a never-armed team must not wake");
});


// ── unknown must not open a wake episode ──────────────────────────────────
//
// `foregroundDisposition` returns "unknown" for two things that prove nothing
// about a fan-out: a live record this process cannot parse, and a durable
// `working` record left behind by a run that is long gone. Reading "unknown" as
// busy made a sweep arm historical teams that had not run for days, and the
// stem of the next sweep then woke them. The invariants below split that apart:
// only an AFFIRMATIVELY running worker opens an episode; "unknown" alone may
// block a settle, and must leave an existing arming byte-identical.

/** The raw arming file, so "no write" can be asserted non-vacuously. */
function armRaw(s: ReturnType<typeof harness>, id = "parent"): string | undefined {
	const file = join(s.team.stateDir, `${id}.wake-state`);
	return existsSync(file) ? readFileSync(file, "utf-8") : undefined;
}

function sendCount(s: ReturnType<typeof harness>): number {
	return s.calls.filter((call) => call.kind === "send").length;
}

/** A live record a reader can only treat as unplaceable, not as settled. */
function writePartialLive(agentDir: string, pid: number) {
	const dir = join(agentDir, "inbox-live");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${pid}.json`), "{", "utf-8");
}

/** A worker record as an old fan-out left it: no registry entry anywhere. */
function writeWorkerRecord(
	agentDir: string,
	parentId: string,
	id: string,
	createdAt = 1,
	wake = true,
) {
	const dir = join(agentDir, "session-workers", "workers");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${id}.json`),
		JSON.stringify({
			id,
			parentId,
			title: id,
			cwd: agentDir,
			extensionPath: "/extensions/session-workers/index.ts",
			createdAt,
			wake,
		}),
		"utf-8",
	);
}

/** A durable agent record as a finished run left it. */
function writeSavedRecord(
	agentDir: string,
	id: string,
	patch: Record<string, unknown>,
) {
	const dir = join(agentDir, "inbox-agents");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${id}.json`);
	writeFileSync(file, JSON.stringify({ id, pending: [], ...patch }), "utf-8");
	return file;
}

const OLD_PARENT = "old-parent-01a19ebe";

test("an unparseable unrelated live record must not arm a historical team", async (t) => {
	// Repro A. Nine worker records from a fan-out that finished days ago, no
	// arming. One *unrelated* `inbox-live` file is mid-write and unparseable;
	// `foreground()` throws on it before it can tell the session is unrelated,
	// so every worker reads "unknown". That must not start an episode: there is
	// no evidence any worker is running, only evidence we cannot read a file.
	const s = harness(t, { mode: "json", addParent: true });
	s.start();
	const ids = Array.from({ length: 9 }, (_, i) => `old-child-${i}`);
	for (const id of ids) writeWorkerRecord(s.team.agentDir, OLD_PARENT, id);
	// The ancient parent still has a session file: a wake would really spawn.
	s.addParent(OLD_PARENT);
	s.files.set(OLD_PARENT, join(s.team.agentDir, `${OLD_PARENT}.jsonl`));

	s.pump();
	assert.equal(armRaw(s, OLD_PARENT), undefined, "an unarmed team stays unarmed");

	writePartialLive(s.team.agentDir, 999_999);
	s.pump();
	assert.equal(
		armRaw(s, OLD_PARENT),
		undefined,
		"an unreadable unrelated record must not open an episode",
	);
	assert.equal(s.pendingWake(OLD_PARENT), undefined);
	assert.equal(sendCount(s), 0);

	// The writer finishes; the record now parses and names another session.
	writeLiveRecord(s.team.agentDir, "some-other-session", 999_999, "idle");
	s.pump();
	assert.equal(
		armRaw(s, OLD_PARENT),
		undefined,
		"a repaired unrelated record must not arm a historical team",
	);
	assert.equal(s.pendingWake(OLD_PARENT), undefined);
	assert.equal(sendCount(s), 0, "and must not deliver a wake to it");
});

test("a stale durable working record must not arm a historical team", async (t) => {
	// Repro B. No live record at all; the only trace is an `inbox-agents`
	// record left at state "working" by a run that ended days ago, pointing at a
	// dead pid. "spawned but not yet started" and "crashed three days ago" are
	// indistinguishable from that record alone, so it may block a settle but it
	// must not open an episode. Deleting the stale file must not then cash in a
	// wake the file was never evidence for.
	const s = harness(t, { mode: "json", addParent: true });
	s.start();
	const child = "old-child-stale";
	writeWorkerRecord(s.team.agentDir, OLD_PARENT, child);
	s.addParent(OLD_PARENT);
	s.files.set(OLD_PARENT, join(s.team.agentDir, `${OLD_PARENT}.jsonl`));
	const saved = writeSavedRecord(s.team.agentDir, child, {
		state: "working",
		pid: 999_998,
		updatedAt: Date.parse("2026-11-03T17:49:00Z"),
	});

	s.pump();
	assert.equal(
		armRaw(s, OLD_PARENT),
		undefined,
		"a stale durable working record must not open an episode",
	);
	assert.equal(s.pendingWake(OLD_PARENT), undefined);
	assert.equal(sendCount(s), 0);

	rmSync(saved);
	s.pump();
	assert.equal(armRaw(s, OLD_PARENT), undefined);
	assert.equal(s.pendingWake(OLD_PARENT), undefined);
	assert.equal(sendCount(s), 0, "cleanup alone must not cash in a wake");
});

test("unknown blocks a settle but preserves the open episode", async (t) => {
	// Requirement (c): known-active -> unknown -> settled still wakes exactly
	// once. Unknown is a reason to wait, never a reason to forget the episode.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	working(s, worker.id);
	s.pump();
	const armed = readWakeArm(s.team.stateDir, "parent");
	assert.equal(armed?.armed, true);
	assert.equal(armed?.episode, 1);

	// The registry loses the worker and only a durable `working` record is left.
	// (An unreadable live file no longer produces `unknown` -- those are now
	// skipped, because one broken file from an unrelated session must not make
	// every worker unplaceable. `unknown` now means what it says: a worker this
	// process cannot place but evidence says may still be running.)
	s.agents.delete(worker.id);
	writeSavedRecord(s.team.agentDir, worker.id, {
		state: "working",
		updatedAt: Date.now(),
	});
	const during = armRaw(s);
	s.pump();
	assert.equal(armRaw(s), during, "unknown must not rewrite the arming file");
	assert.equal(readWakeArm(s.team.stateDir, "parent")?.episode, 1);
	assert.equal(s.sent.length, 0, "unknown is not a settle");

	rmSync(
		join(s.team.agentDir, "inbox-agents", `${worker.id}.json`),
		{ force: true },
	);
	s.pump();
	assert.equal(s.sent.length, 1, "the preserved episode still wakes once");
	assert.equal(s.pendingWake(), undefined);
});

test("unknown alone cannot open or increment an episode", async (t) => {
	// Requirement (d). An armed-but-never-run record (episode 0) plus an
	// unplaceable worker must stay at episode 0: bumping it would invent a
	// fan-out. A worker then observed running is what recovers it.
	const s = harness(t, { mode: "tui" });
	s.start();
	const child = "episode-zero-child";
	writeWorkerRecord(s.team.agentDir, OLD_PARENT, child);
	s.addParent(OLD_PARENT);
	s.files.set(OLD_PARENT, join(s.team.agentDir, `${OLD_PARENT}.jsonl`));
	writeWakeArm(s.team.stateDir, OLD_PARENT, {
		armed: true,
		episode: 0,
		signature: null,
	});
	writePartialLive(s.team.agentDir, 999_996);

	s.pump();
	assert.equal(
		readWakeArm(s.team.stateDir, OLD_PARENT)?.episode,
		0,
		"unknown must not bump a stranded episode",
	);
	assert.equal(s.pendingWake(OLD_PARENT), undefined);
	assert.equal(sendCount(s), 0);

	// One worker is now affirmatively running: that opens the episode, and the
	// team still does not wake while it runs.
	s.adopt(
		{ id: child, cwd: s.team.agentDir, title: child },
		{ state: "working", proc: { kill() {} } },
	);
	s.pump();
	const recovered = readWakeArm(s.team.stateDir, OLD_PARENT);
	assert.equal(recovered?.armed, true);
	assert.equal(recovered?.episode, 1, "affirmative running recovers the episode");
	assert.equal(sendCount(s), 0, "a running worker is not a settle");
});

test("a running worker arms while an unknown sibling blocks the settle", async (t) => {
	// Requirement (e): the affirmative worker wins the arming decision, then the
	// team waits for the unplaceable sibling instead of waking early.
	const s = harness(t, { mode: "tui" });
	s.start();
	const running = "mixed-running";
	const unknown = "mixed-unknown";
	writeWorkerRecord(s.team.agentDir, OLD_PARENT, running);
	writeWorkerRecord(s.team.agentDir, OLD_PARENT, unknown, 2);
	s.addParent(OLD_PARENT);
	s.files.set(OLD_PARENT, join(s.team.agentDir, `${OLD_PARENT}.jsonl`));
	// An alive pid proves `running` is mid-run in another process.
	writeLiveRecord(s.team.agentDir, running, process.pid, "working");
	assert.equal(
		s.team.foregroundDisposition(running),
		"running",
		"the establishing half must be a real foreign live working record",
	);
	// The sibling is unplaceable through the OTHER route: a durable `working`
	// record with no live record. (A corrupt live file would make every worker
	// unknown, because `foreground()` reads every record before it compares
	// session ids -- a separate defect, deliberately not touched here.)
	writeSavedRecord(s.team.agentDir, unknown, {
		state: "working",
		pid: 999_995,
		updatedAt: Date.now(),
	});

	s.pump();
	const armed = readWakeArm(s.team.stateDir, OLD_PARENT);
	assert.equal(armed?.armed, true, "an affirmative worker still opens the episode");
	assert.equal(armed?.episode, 1);
	assert.equal(s.pendingWake(OLD_PARENT), undefined);
	assert.equal(sendCount(s), 0);

	// The running worker settles; the sibling is still unplaceable, so the
	// wake is owed but not due.
	rmSync(join(s.team.agentDir, "inbox-live", `${process.pid}.json`));
	const waiting = armRaw(s, OLD_PARENT);
	s.pump();
	assert.equal(armRaw(s, OLD_PARENT), waiting, "waiting writes nothing");
	assert.equal(sendCount(s), 0, "an unknown sibling blocks the settle");

	// The sibling resolves: its stale durable record is cleaned up, so the team
	// is genuinely settled.
	rmSync(join(s.team.agentDir, "inbox-agents", `${unknown}.json`));
	s.pump();
	assert.equal(sendCount(s), 1, "exactly one wake once every worker resolves");
});

test("unknown after a delivered wake does not repeat it", async (t) => {
	// Requirement (f). The episode was already woken for and disarmed. A later
	// unplaceable worker must not re-arm episode 2 and cash in a second wake.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	working(s, worker.id);
	s.pump();
	working(s, worker.id);
	s.agents.get(worker.id)!.state = "idle";
	s.agents.get(worker.id)!.proc = undefined;
	s.pump();
	assert.equal(s.sent.length, 1, "the episode woke once");
	const spent = readWakeArm(s.team.stateDir, "parent");
	assert.equal(spent?.armed, false);
	assert.equal(spent?.signature, "1");

	s.agents.delete(worker.id);
	writePartialLive(s.team.agentDir, 999_994);
	const afterWake = armRaw(s);
	s.pump();
	assert.equal(armRaw(s), afterWake, "unknown after a wake must not re-arm");
	assert.equal(
		readWakeArm(s.team.stateDir, "parent")?.episode,
		1,
		"no new episode is invented",
	);
	assert.equal(s.sent.length, 1);

	rmSync(join(s.team.agentDir, "inbox-live", "999994.json"));
	s.pump();
	assert.equal(s.sent.length, 1, "a spent episode never wakes twice");
});

test("a team that did not opt in is never armed or woken", async (t) => {
	// The wake is opt-in per spawn. Delegation normally happens while the parent
	// is the one driving the workers, so it already knows when they stop. Making
	// that the default means no team can wake a parent that never asked.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn("parent", false);
	assert.equal(s.team.wakeOptIn("parent"), false);

	await arm(s, worker.id);
	await settle(s, worker.id);

	assert.equal(s.sent.length, 0, "no wake without an explicit opt-in");
	assert.equal(s.pendingWake(), undefined);
	// The arm may exist -- it records that this episode did NOT opt in -- but it
	// must never carry an opt-in, because that is what the settle branch reads.
	assert.notEqual(
		readWakeArm(s.team.stateDir, "parent")?.wakeOptIn,
		true,
		"an opted-out episode must not record an opt-in",
	);
});

test("the opt-in is scoped to the episode, not to never-pruned worker records", async (t) => {
	// Worker records are never pruned, so asking `wakeOptIn` at settle time let a
	// single opted-in fan-out opt the parent in forever: every later
	// default-`false` spawn inherited it. The opt-in is now captured when the
	// episode arms and consumed with that episode.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn("parent", true);
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.equal(s.sent.length, 1, "the opted-in fan-out wakes");
	assert.equal(s.team.wakeOptIn("parent"), true, "its record still says so");

	// A later, independent fan-out that did NOT opt in must stay silent, even
	// though the old opted-in record is still on disk for this parent.
	const fresh = await s.spawn("parent", false);
	s.agents.delete(worker.id);
	await arm(s, fresh.id);
	await settle(s, fresh.id);
	assert.equal(
		s.sent.length,
		1,
		"a stale wake:true record must not opt a later fan-out in",
	);
});

test("a parent-driven follow-up run does not wake the parent that drove it", async (t) => {
	// The loop that was observed live: the parent calls `send`, the worker runs,
	// the run reads as a fresh fan-out, and the parent is woken about work it
	// started itself -- once per follow-up. Opting in is what distinguishes
	// "tell me when this finishes" from "I am the one driving it".
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn("parent", false);

	for (let round = 0; round < 4; round++) {
		// The parent sends a follow-up; the worker runs and stops.
		await arm(s, worker.id);
		await settle(s, worker.id);
	}

	assert.equal(
		s.sent.length,
		0,
		"driving a worker repeatedly must not wake the driver",
	);
});

test("an opted-in team still wakes exactly once after a follow-up run", async (t) => {
	// The opt-in must not break the deliberate case: a parent that asked to be
	// woken is still told when the team genuinely settles.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn("parent", true);
	assert.equal(s.team.wakeOptIn("parent"), true);

	await arm(s, worker.id);
	await settle(s, worker.id);

	assert.equal(s.sent.length, 1);
});

test("a queued wake for an opted-out team is not delivered", async (t) => {
	// The pendingParents loop bypasses the team sweep, so it needs the same gate:
	// a request left on disk by a team that never opted in must not be delivered.
	const s = harness(t, { mode: "tui" });
	s.start();
	await s.spawn("parent", false);
	writeWakeRequest(s.team.stateDir, {
		parentId: "parent",
		content: "[pi-kit wake] stale",
		workers: [],
	});
	assert.equal(s.pendingWake()?.parentId, "parent");

	s.pump();
	assert.equal(s.sent.length, 0, "opted-out delivery must be refused");
});

test("a spent wake budget still disarms instead of freezing the episode", async (t) => {
	// Hitting MAX_CONSECUTIVE_WAKES used to `continue` before the disarm write,
	// so the arm stayed `armed: true` forever: every later sweep re-entered the
	// settle branch and the episode number froze. Nothing woke (safe), but the
	// record was permanently inconsistent and a later budget reset acted on a
	// stale episode.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	for (let cycle = 0; cycle < 6; cycle += 1) {
		await arm(s, worker.id);
		await settle(s, worker.id, { runs: cycle + 2 });
	}
	assert.equal(s.sent.length, 3, "capped at three wakes");
	const capped = readWakeArm(s.team.stateDir, "parent");
	assert.equal(capped?.armed, false, "a spent budget must disarm");
	assert.equal(
		capped?.signature,
		String(capped?.episode),
		"the answered episode is recorded so it cannot re-fire",
	);
});

test("the wake counts this run's workers, not every record ever created", async (t) => {
	// Observed live: a parent that had run five orchestrations was told "All 10
	// delegated workers have settled" when the run being reported had two.
	// Worker records are never pruned, so counting team.workers() reports every
	// worker the parent ever spawned.
	const s = harness(t, { mode: "tui" });
	s.start();

	// An earlier fan-out that already completed and was reported.
	const old = await s.spawn();
	await arm(s, old.id);
	await settle(s, old.id);
	assert.equal(s.sent.length, 1);
	assert.match(
		String(s.sent[0].message.content),
		/All 1 delegated worker has settled/,
	);
	// Let the clock advance so the next fan-out's workers are strictly newer.
	await new Promise((resolve) => setTimeout(resolve, 5));

	// A second fan-out of two workers in this run.
	s.agents.delete(old.id);
	const a = await s.spawn();
	const b = await s.spawn();
	await arm(s, a.id);
	await settle(s, a.id);
	await settle(s, b.id);

	assert.equal(s.sent.length, 2);
	const text = String(s.sent[1].message.content);
	assert.match(
		text,
		/All 2 delegated workers have settled/,
		"must report this fan-out, not the 3 records on disk",
	);
	assert.doesNotMatch(text, /All 3/);
	assert.equal(
		s.sent[1].message.details.workers.length,
		2,
		"details must also describe only this fan-out",
	);
});


test("an episode can be claimed by exactly one process", async (t) => {
	// The settle branch is read-test-write on the arm with no lock: several
	// processes sweeping one settled episode all saw the same unclaimed state.
	// Measured live: 8 concurrent sweeps produced 3-8 runs for a single wake
	// while the arm still recorded `wakes: 1`. Only the claim creator may emit.
	const h = harness(t);
	const dir = join(h.team.agentDir, "inbox-agents");
	const first = claimEpisodeWake(dir, "parent", 7);
	const second = claimEpisodeWake(dir, "parent", 7);
	assert.equal(first, true, "the first claimant wins");
	assert.equal(second, false, "every later claimant is refused");
	assert.equal(
		claimEpisodeWake(dir, "parent", 8),
		true,
		"a different episode is a different claim",
	);
	releaseEpisodeClaim(dir, "parent", 7);
	assert.equal(
		claimEpisodeWake(dir, "parent", 7),
		true,
		"releasing allows the next episode-cycle to claim again",
	);
});

test("a wake request can be consumed by exactly one process", async (t) => {
	// The background path sent first and consumed second, so a second process
	// reading the still-present request queued another run for the same wake.
	// Consumption is now an atomic rename, so only one caller can claim it.
	const h = harness(t);
	const dir = join(h.team.agentDir, "inbox-agents");
	writeWakeRequest(dir, {
		parentId: "parent",
		content: "[pi-kit wake] once",
		workers: [],
	});
	const nonce = readWakeRequest(dir, "parent")!.nonce;
	assert.equal(consumeWakeRequest(dir, "parent", nonce), true);
	assert.equal(
		consumeWakeRequest(dir, "parent", nonce),
		false,
		"a second consumer must not win the same request",
	);
	assert.equal(readWakeRequest(dir, "parent"), undefined);
});

test("a process only wakes teams it owns, never another session's", async (t) => {
	// The sweep iterated every team on disk, so an unrelated session's process
	// could arm and wake a parent it has no relationship with. Two observers per
	// team produced duplicate wakes and could force a run that aborted an
	// in-flight turn. Responsibility is process ownership: the durable record's
	// `owner` is the pid that started the run.
	const s = harness(t, { mode: "tui" });
	s.start();
	const mine = await s.spawn("parent", true);

	// A second team, owned by a DIFFERENT process.
	const theirs = "other-parent";
	writeWorkerRecord(s.team.agentDir, theirs, "their-worker");
	const agentsDir = join(s.team.agentDir, "inbox-agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, `${theirs}.json`),
		JSON.stringify({
			id: theirs,
			state: "working",
			pending: [],
			owner: 1,
			ownerBeat: Date.now(),
		}),
		"utf-8",
	);
	writeLiveRecord(s.team.agentDir, "their-worker", process.pid, "working");

	// Our process observes both teams running, so both would be armed if the
	// sweep did not check ownership.
	await tick();
	s.pump();
	assert.equal(
		s.pendingWake(theirs),
		undefined,
		"we must not arm another session's team",
	);
	assert.equal(
		readWakeArm(s.team.stateDir, theirs),
		undefined,
		"another session's team must not be armed at all",
	);

	// Both then settle. Ours wakes; theirs must never be delivered.
	clearLiveRecord(s.team.agentDir, "their-worker");
	await arm(s, mine.id);
	await settle(s, mine.id);
	s.pump();
	assert.equal(s.sent.length, 1, "our own team still wakes normally");
	assert.equal(s.pendingWake(theirs), undefined);

	assert.equal(
		s.team.ownsWake(theirs),
		false,
		"a team owned by another pid is not ours",
	);
	assert.equal(
		s.pendingWake(theirs),
		undefined,
		"we must not even arm another session's team",
	);
	assert.equal(
		s.sent.filter((m) => m.message.details?.parentId === theirs).length,
		0,
		"we must never wake another session's parent",
	);
});

/** Remove a live record, as a finishing run does. */
function clearLiveRecord(agentDir: string, sessionId: string) {
	const dir = join(agentDir, "inbox-live");
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		try {
			const rec = JSON.parse(readFileSync(join(dir, name), "utf-8"));
			if (rec?.sessionId === sessionId) rmSync(join(dir, name));
		} catch {
			// ignore
		}
	}
}

test("a new fan-out starts with a clean notes board", async (t) => {
	// Notes are keyed by parent and never deleted, so an unscoped board was a
	// roll-up of every orchestration the parent had ever run: a fresh run began
	// by re-reading 20 hours of finished work, including notes that superseded
	// each other. The board is now scoped to the current episode.
	const s = harness(t, { mode: "tui" });
	s.start();

	// Fan-out 1: a worker shares a finding, the team settles and is woken.
	const first = await s.spawn();
	assert.ok(s.team.share(first.id, "OLD-FINDING-from-run-one"));
	assert.match(await board(s), /OLD-FINDING/);
	await arm(s, first.id);
	await settle(s, first.id);
	assert.equal(s.sent.length, 1);
	s.agents.delete(first.id);

	// Fan-out 2 opens a new episode and must not inherit run one's board.
	const second = await s.spawn();
	await arm(s, second.id);
	assert.doesNotMatch(
		await board(s),
		/OLD-FINDING/,
		"a previous run's note must not leak into this run",
	);

	// This run's own note is visible.
	assert.ok(s.team.share(second.id, "NEW-FINDING-from-run-two"));
	assert.match(await board(s), /NEW-FINDING/);
});

test("a parent can carry a finding forward by re-sharing it", async (t) => {
	// Continuity is a decision, not an accident of files never being deleted.
	const s = harness(t, { mode: "tui" });
	s.start();
	const first = await s.spawn();
	assert.ok(s.team.share(first.id, "WORTH-KEEPING"));
	await arm(s, first.id);
	await settle(s, first.id);

	const second = await s.spawn();
	await arm(s, second.id);
	assert.doesNotMatch(await board(s), /WORTH-KEEPING/);
	// The parent re-shares it into the new episode.
	s.team.share("parent", "WORTH-KEEPING");
	assert.match(await board(s), /WORTH-KEEPING/);
});

test("notes keep the board refreshing within one episode", async (t) => {
	// The fingerprint must use the same scope as the board, or unrelated history
	// would change it and re-send an identical set.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	const empty = s.team.notesFingerprint("parent");
	assert.equal(empty, undefined, "no notes in this episode yet");

	s.team.share(worker.id, "FIRST");
	const one = s.team.notesFingerprint("parent");
	assert.match(String(one), /^1:/, "fingerprint is episode-scoped");
	assert.notEqual(one, empty);
});

test("arming state for a finished team is pruned", async (t) => {
	// Worker records are never pruned, so every parent a session ever delegated
	// for left an arm behind: 7 of 8 arms on this machine had zero workers. The
	// arm is what `parents()` discovers, so that residue made the sweep iterate
	// teams that cannot wake.
	const s = harness(t, { mode: "tui" });
	s.start();
	writeWakeArm(s.team.stateDir, "ghost-parent", {
		armed: false,
		episode: 1,
		signature: "1",
		wakes: 1,
	});
	// No worker records at all for that parent.
	assert.ok(readWakeArm(s.team.stateDir, "ghost-parent"));
	s.pump();
	assert.equal(
		readWakeArm(s.team.stateDir, "ghost-parent"),
		undefined,
		"a team with no workers must not keep arming state",
	);
});

test("pruning the arm clears the episode claims named after it", async (t) => {
	// A claim is named `<parent>.wake-claim-<episode>`, and the arm is what
	// carries the episode number. Once the arm is pruned the numbering restarts
	// at 1, so a claim left behind for a reused number would silently suppress a
	// real wake. A crash between claim and release can strand one with no arm
	// left to ever clear it, because release is only reached from the emit path.
	const s = harness(t, { mode: "tui" });
	s.start();
	const parent = "ghost-parent";
	writeWakeArm(s.team.stateDir, parent, {
		armed: false, episode: 3, signature: "3", wakes: 1,
	});
	assert.equal(claimEpisodeWake(s.team.stateDir, parent, 1), true);
	assert.equal(claimEpisodeWake(s.team.stateDir, parent, 3), true);
	// Belongs to another parent: must survive.
	assert.equal(claimEpisodeWake(s.team.stateDir, "other-parent", 2), true);

	s.pump();

	assert.equal(readWakeArm(s.team.stateDir, parent), undefined, "arm pruned");
	const claims = readdirSync(s.team.stateDir).filter((n) =>
		n.startsWith(`${parent}.wake-claim-`),
	);
	assert.deepEqual(claims, [], "no claim outlives the arm naming its episode");
	assert.ok(
		readdirSync(s.team.stateDir).includes("other-parent.wake-claim-2"),
		"another team's claim is untouched",
	);
});

test("pruning never removes a team that could still wake", async (t) => {
	const s = harness(t, { mode: "tui" });
	s.start();

	// 1. An armed episode with no workers yet must survive mid-fan-out.
	writeWakeArm(s.team.stateDir, "armed-parent", {
		armed: true, episode: 1, signature: null,
	});
	// 2. A recorded fan-out with no workers left must survive.
	writeWakeArm(s.team.stateDir, "pending-parent", {
		armed: false, episode: 1, signature: "1", pendingWorkers: ["w1"],
	});
	// 3. An undelivered request on disk must survive.
	writeWakeArm(s.team.stateDir, "owing-parent", {
		armed: false, episode: 2, signature: "2",
	});
	writeWakeRequest(s.team.stateDir, {
		parentId: "owing-parent",
		content: "[pi-kit wake] owed", workers: [],
	});
	// 4. A team with live worker records must survive.
	const live = await s.spawn();

	s.pump();
	assert.ok(readWakeArm(s.team.stateDir, "armed-parent"), "armed kept");
	assert.ok(readWakeArm(s.team.stateDir, "pending-parent"), "fan-out kept");
	assert.ok(readWakeArm(s.team.stateDir, "owing-parent"), "owed kept");
	assert.ok(readWakeArm(s.team.stateDir, "parent"), "live team kept");
	assert.ok(live.id);
});


test("wakeContent never invents a worker count it does not have", async () => {
	// An episode can name no workers -- a legacy arm written before
	// `episodeWorkers` existed, or a fan-out this process never observed. The
	// old code fell back to the whole team, so worker records that are never
	// pruned turned "this run had two" into "all 12". Reporting zero would be
	// just as wrong: the count is unknown, not empty.
	const { wakeContent } = await import("./wake.ts");
	const empty = wakeContent("parent", []);
	assert.doesNotMatch(empty, /All \d+ delegated/, "must not assert a count");
	assert.doesNotMatch(empty, /All 0/, "zero is also a lie: the count is unknown");
	assert.match(empty, /settled/, "still says the team settled");
	assert.match(empty, /session_workers/, "still tells the model what to do");

	// The ordinary cases keep their exact wording.
	assert.match(
		wakeContent("parent", [{ id: "a" }]),
		/All 1 delegated worker has settled/,
	);
	assert.match(
		wakeContent("parent", [{ id: "a" }, { id: "b" }]),
		/All 2 delegated workers have settled/,
	);
});

test("a team spawned by another process is not owned even if its arm is armed", async (t) => {
	// The complement: `ownerPid` must not make teams universally owned.
	const s = harness(t, { mode: "tui" });
	s.start();
	// A team genuinely created elsewhere: the worker record itself names another
	// pid. (Faking only the arm is not enough any more -- a real spawn stamps the
	// worker record too, and that is now a second source of truth.)
	writeWorkerRecord(s.team.agentDir, "parent", "foreign-worker");
	const file = join(
		s.team.agentDir,
		"session-workers",
		"workers",
		"foreign-worker.json",
	);
	const rec = JSON.parse(readFileSync(file, "utf-8"));
	// A genuinely LIVE foreign pid (init), so the "owner is gone" takeover does
	// not apply -- this is about a team another live process owns.
	writeFileSync(file, JSON.stringify({ ...rec, ownerPid: 1 }));
	writeWakeArm(s.team.stateDir, "parent", { ownerPid: 1 });
	rmSync(join(s.team.agentDir, "inbox-agents", "parent.json"), {
		force: true,
	});
	s.agents.delete("parent");
	assert.equal(
		s.team.ownsWake("parent"),
		false,
		"another process's spawn is not ours to wake",
	);
});

test("ownsWake survives losing the inbox record, via the arm's ownerPid", async (t) => {
	// The stall this fixes. `persist` DELETES a parent's inbox record as soon as
	// it is idle with nothing pending (needsPersist false) -- exactly the state a
	// parent sits in while its workers finish. `ownsWake` fell back to that
	// record, so once deleted no process owned the team and the wake never fired.
	// The arm outlives idle, so the spawner is recorded there instead.
	const s = harness(t, { mode: "tui" });
	s.start();
	await s.spawn("parent", true);
	// `spawn` recorded the owner on the arm.
	assert.equal(
		readWakeArm(s.team.stateDir, "parent")?.ownerPid,
		process.pid,
		"spawn records the owning pid on the arm",
	);

	// Simulate the parent's turn ending: no registry entry, no inbox record.
	rmSync(join(s.team.agentDir, "inbox-agents", "parent.json"), {
		force: true,
	});
	s.agents.delete("parent");

	assert.equal(
		s.team.ownsWake("parent"),
		true,
		"the arm still answers who owns this team",
	);
});

test("a team spawned by a different process is not ours to wake", async (t) => {
	// The complement: `ownerPid` must not make every team universally owned.
	const s = harness(t, { mode: "tui" });
	s.start();
	// A worker record genuinely created by another pid, in both places that
	// record ownership: the worker record and the arm.
	writeWorkerRecord(s.team.agentDir, "parent", "foreign-w");
	const wfile = join(
		s.team.agentDir,
		"session-workers",
		"workers",
		"foreign-w.json",
	);
	const wrec = JSON.parse(readFileSync(wfile, "utf-8"));
	writeFileSync(wfile, JSON.stringify({ ...wrec, ownerPid: 1 }));
	writeWakeArm(s.team.stateDir, "parent", { ownerPid: 1 });
	rmSync(join(s.team.agentDir, "inbox-agents", "parent.json"), {
		force: true,
	});
	s.agents.delete("parent");
	assert.equal(
		s.team.ownsWake("parent"),
		false,
		"another process's spawn is not ours",
	);
});

test("a non-owner does not deliver another live session's pending wake", async (t) => {
	// The pending loop was gated only on wakeOptIn, so any process could queue a
	// run for a parent it had no relationship with. `runningElsewhere` cannot
	// catch it: live records are keyed by pid and hold only the session that
	// process is currently showing, so a window with this parent in a background
	// tab has no live record for it. The result was a second
	// `pi --session-id <parent>` beside the live window -- two writers on one
	// session file.
	const s = harness(t, { mode: "json" });
	s.start();
	writeWakeArm(s.team.stateDir, "parent", {
		armed: false,
		episode: 1,
		wakeOptIn: true,
		// A live pid this process is not: init.
		ownerPid: 1,
	});
	writeWakeRequest(s.team.stateDir, {
		parentId: "parent",
		content: "[pi-kit wake] pending",
		workers: [],
	});
	assert.equal(s.team.ownsWake("parent"), false);
	// Without a session file deliverWake drops the request for an unrelated
	// reason, which would make this pass vacuously.
	s.files.set("parent", join(s.team.agentDir, "parent.jsonl"));
	s.switchTo("other-session");

	s.pump();
	assert.equal(
		s.calls.filter((c) => c.kind === "send").length,
		0,
		"a live foreign owner's request must not be delivered by us",
	);
	assert.ok(
		readWakeRequest(s.team.stateDir, "parent"),
		"the request must stay queued for its real owner",
	);
});

test("a dead owner's pending wake is still delivered", async (t) => {
	// The complement: refusing dead owners would strand every team whose window
	// closed before the workers finished. Nothing else will pick the work up.
	const s = harness(t, { mode: "json" });
	s.start();
	writeWakeArm(s.team.stateDir, "parent", {
		armed: false,
		episode: 1,
		wakeOptIn: true,
		ownerPid: 2_147_483_646,
	});
	// deliverWake needs a session file to reopen; without it nobody could ever
	// receive the wake and it is dropped, which is a different path.
	s.files.set("parent", join(s.team.agentDir, "parent.jsonl"));
	writeWakeRequest(s.team.stateDir, {
		parentId: "parent",
		content: "[pi-kit wake] pending",
		workers: [],
	});

	// Sweep as an unrelated session, the way another window would; the pending
	// loop includes callerId, and a parent delivering "to itself" is case 2.
	s.switchTo("other-session");
	s.pump();
	assert.equal(
		s.calls.filter((c) => c.kind === "send").length,
		1,
		"an orphaned request must still be delivered",
	);
});

test("a legacy arm with no ownerPid still delivers its pending wake", async (t) => {
	// Arms written before `ownerPid` existed must not become undeliverable.
	const s = harness(t, { mode: "json" });
	s.start();
	writeWakeArm(s.team.stateDir, "parent", {
		armed: false,
		episode: 1,
		wakeOptIn: true,
	});
	s.files.set("parent", join(s.team.agentDir, "parent.jsonl"));
	writeWakeRequest(s.team.stateDir, {
		parentId: "parent",
		content: "[pi-kit wake] pending",
		workers: [],
	});

	s.switchTo("other-session");
	s.pump();
	assert.equal(s.calls.filter((c) => c.kind === "send").length, 1);
});

test("a claim left by a dead process is reclaimed, not a permanent block", async (t) => {
	// A crash or throw between claim and release leaves the claim file behind,
	// and nothing sweeps it. If that episode number is ever reused the wake is
	// suppressed forever. Reclaim only when the holder is provably gone.
	const s = harness(t);
	const dir = join(s.team.agentDir, "inbox-agents");
	mkdirSync(dir, { recursive: true });
	const deadPid = 2_147_483_646;
	writeFileSync(join(dir, "parent.wake-claim-3"), String(deadPid));
	assert.equal(
		claimEpisodeWake(dir, "parent", 3),
		true,
		"a dead holder's claim must be reclaimed",
	);
});

test("a claim held by a live process is not stolen", async (t) => {
	const s = harness(t);
	const dir = join(s.team.agentDir, "inbox-agents");
	mkdirSync(dir, { recursive: true });
	// pid 1 is alive and is not us.
	writeFileSync(join(dir, "parent.wake-claim-4"), "1");
	assert.equal(
		claimEpisodeWake(dir, "parent", 4),
		false,
		"a live holder keeps its claim",
	);
});

test("our own claim is not re-entrant", async (t) => {
	const s = harness(t);
	const dir = join(s.team.agentDir, "inbox-agents");
	assert.equal(claimEpisodeWake(dir, "parent", 5), true);
	assert.equal(
		claimEpisodeWake(dir, "parent", 5),
		false,
		"a second attempt in the same process must be refused",
	);
});

test("ownership survives an idle reply that clears the whole arm", async (t) => {
	// `dropPendingWake` clears the arm when no worker is running, taking its
	// `ownerPid` with it. Ownership then rested on the inbox record -- the one
	// `persist` deletes when idle. The worker record carries it too and is never
	// pruned, so the team stays owned.
	const s = harness(t, { mode: "json" });
	s.start();
	const worker = await s.spawn("parent", true);
	// The team must be genuinely idle, or the reply takes the "still working"
	// branch and deliberately keeps the arm.
	await settle(s, worker.id);
	// No registry entry and no inbox record: both would satisfy `ownsWake`
	// before it ever consults the worker record, which is the path under test.
	s.agents.delete("parent");
	rmSync(join(s.team.agentDir, "inbox-agents", "parent.json"), {
		force: true,
	});
	assert.equal(s.team.ownsWake("parent"), true);

	s.input("interactive");
	assert.equal(
		readWakeArm(s.team.stateDir, "parent"),
		undefined,
		"the reply still clears the arm",
	);
	assert.equal(
		s.team.ownsWake("parent"),
		true,
		"but the team must still be owned",
	);
	assert.ok(worker.id);
});

test("a team whose only owner died is taken over, not stranded", async (t) => {
	// `ownsWake` only ever matched a live `process.pid`, so a team whose
	// spawning window exited mid-fan-out was owned by nobody: it could not even
	// be armed, and only an already-written `.wake` recovered. Adoption does not
	// help -- it scans agent records, which `persist` deletes when a parent goes
	// idle. Any dead owner must let the work be taken over.
	const s = harness(t, { mode: "tui" });
	s.start();
	const dead = 2_147_483_646;
	writeWorkerRecord(s.team.agentDir, "parent", "orphan-w");
	const wfile = join(
		s.team.agentDir, "session-workers", "workers", "orphan-w.json",
	);
	const wrec = JSON.parse(readFileSync(wfile, "utf-8"));
	writeFileSync(wfile, JSON.stringify({ ...wrec, ownerPid: dead }));
	writeWakeArm(s.team.stateDir, "parent", { ownerPid: dead });
	rmSync(join(s.team.agentDir, "inbox-agents", "parent.json"), {
		force: true,
	});
	s.agents.delete("parent");

	assert.equal(
		s.team.ownsWake("parent"),
		true,
		"a dead owner's team must be reclaimable",
	);
});

test("a dead-arm-but-live-worker-owner is not taken over", async (t) => {
	// Conservative in the other direction: one live owner is enough to keep it.
	const s = harness(t, { mode: "tui" });
	s.start();
	const dead = 2_147_483_646;
	writeWorkerRecord(s.team.agentDir, "parent", "live-w");
	const wfile = join(
		s.team.agentDir, "session-workers", "workers", "live-w.json",
	);
	const wrec = JSON.parse(readFileSync(wfile, "utf-8"));
	// pid 1 is alive, so somebody still owns this team.
	writeFileSync(wfile, JSON.stringify({ ...wrec, ownerPid: 1 }));
	writeWakeArm(s.team.stateDir, "parent", { ownerPid: dead });
	rmSync(join(s.team.agentDir, "inbox-agents", "parent.json"), {
		force: true,
	});
	s.agents.delete("parent");
	assert.equal(s.team.ownsWake("parent"), false);
});

test("a malformed worker record does not throw out of the sweep", async (t) => {
	// The team loop is guarded; the pending-request loop was not. `ownsWake` reads
	// worker records via `ownerGone`, and a malformed record makes `workers()`
	// throw -- which surfaced as an unhandled throw from a supervisor tick.
	const s = harness(t, { mode: "tui" });
	s.start();
	const dir = join(s.team.agentDir, "session-workers", "workers");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "bad.json"), '{"oops":1}', "utf-8");
	writeWakeArm(s.team.stateDir, "parent", {
		armed: false,
		episode: 1,
		wakeOptIn: true,
		ownerPid: 2_147_483_646,
	});
	writeWakeRequest(s.team.stateDir, {
		parentId: "parent",
		content: "[pi-kit wake] pending",
		workers: [],
	});

	assert.doesNotThrow(
		() => s.pump(),
		"one unreadable team must not take down the sweep",
	);
});

test("pruning a dead arm also removes its reported-workers sidecar", async (t) => {
	// Nothing else prunes `.wake-reported`: `removeAgentFiles` deliberately
	// ignores this directory's wake sidecars, so it accumulated forever.
	const s = harness(t, { mode: "tui" });
	s.start();
	writeWakeArm(s.team.stateDir, "ghost-parent", {
		armed: false,
		episode: 1,
		wakeOptIn: true,
	});
	writeReported(s.team.stateDir, "ghost-parent", {
		lastWakeAt: Date.now(),
		reportedWorkers: ["w1"],
	});
	assert.ok(existsSync(join(s.team.stateDir, "ghost-parent.wake-reported")));

	s.pump();
	assert.equal(
		existsSync(join(s.team.stateDir, "ghost-parent.wake-state")),
		false,
		"the dead arm is pruned",
	);
	assert.equal(
		existsSync(join(s.team.stateDir, "ghost-parent.wake-reported")),
		false,
		"and its reported sidecar with it",
	);
});

test("a recycled pid without our token is not treated as the owner", async (t) => {
	// Pids are recycled, and macOS wraps in the low tens of thousands. A record
	// naming our pid but carrying a different token is a previous process that
	// happened to have the same pid -- claiming it would let us wake an
	// unrelated parent.
	const s = harness(t, { mode: "tui" });
	s.start();
	writeWorkerRecord(s.team.agentDir, "parent", "recycled-w");
	const wfile = join(
		s.team.agentDir, "session-workers", "workers", "recycled-w.json",
	);
	const rec = JSON.parse(readFileSync(wfile, "utf-8"));
	writeFileSync(
		wfile,
		JSON.stringify({ ...rec, ownerPid: process.pid, ownerToken: "999-old" }),
	);
	writeWakeArm(s.team.stateDir, "parent", {
		ownerPid: process.pid,
		ownerToken: "999-old",
	});
	rmSync(join(s.team.agentDir, "inbox-agents", "parent.json"), {
		force: true,
	});
	s.agents.delete("parent");
	assert.equal(
		s.team.ownsWake("parent"),
		false,
		"a matching pid with a stale token is not us",
	);
});

test("a record with no token still matches on pid alone", async (t) => {
	// Records written before the token existed must keep working.
	const s = harness(t, { mode: "tui" });
	s.start();
	writeWakeArm(s.team.stateDir, "parent", { ownerPid: process.pid });
	rmSync(join(s.team.agentDir, "inbox-agents", "parent.json"), {
		force: true,
	});
	s.agents.delete("parent");
	assert.equal(s.team.ownsWake("parent"), true);
});

test("an unrelated malformed live record does not make workers unplaceable", async (t) => {
	// `foreground()` parsed every live file before comparing session ids, and
	// `readJson` throws on malformed JSON -- so one truncated file from an
	// unrelated session turned EVERY worker into `unknown`. That is the path that
	// produced a false wake. A file we cannot parse says nothing about this
	// session, so it is skipped.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	writePartialLive(s.team.agentDir, 999_993);
	assert.equal(
		s.team.foregroundDisposition(worker.id),
		"settled",
		"a foreign broken file must not poison this worker",
	);
});

test("a wake is not delivered while the parent is already running", async (t) => {
	// The module always said "wake an idle parent" but never checked. Pushing a
	// triggerTurn into a live turn interleaves a second turn with the one in
	// flight; the request must stay queued for the next sweep.
	const s = harness(t, { mode: "tui" });
	s.addParent();
	s.start();
	s.team.runner.get("parent")!.state = "working";
	writeWakeArm(s.team.stateDir, "parent", {
		armed: false,
		episode: 1,
		wakeOptIn: true,
	});
	writeWakeRequest(s.team.stateDir, {
		parentId: "parent",
		content: "[pi-kit wake] pending",
		workers: [],
	});
	s.pump();
	assert.equal(s.sent.length, 0, "no in-process wake while the parent runs");
	assert.ok(
		s.pendingWake(),
		"the request stays queued for when the parent is idle",
	);
});

test("only the owner prunes another team's arming state", async (t) => {
	// `pruneDeadArms` ran for every sweeping process, so any window could delete
	// a `.wake-state` carrying the wake budget for a team it did not own.
	const s = harness(t, { mode: "tui" });
	s.start();
	writeWakeArm(s.team.stateDir, "foreign-parent", {
		armed: false,
		episode: 3,
		wakeOptIn: true,
		// A live pid that is not us.
		ownerPid: 1,
	});
	s.pump();
	assert.ok(
		existsSync(join(s.team.stateDir, "foreign-parent.wake-state")),
		"a live foreign owner's arm must survive our sweep",
	);
});

test("an arm naming no owner is still pruned", async (t) => {
	// The exception that keeps dead state collectable: nobody owns it.
	const s = harness(t, { mode: "tui" });
	s.start();
	writeWakeArm(s.team.stateDir, "unowned", { armed: false, episode: 1 });
	s.pump();
	assert.equal(
		existsSync(join(s.team.stateDir, "unowned.wake-state")),
		false,
	);
});

test("reported worker records are pruned only once they are old enough", async (t) => {
	// Records accumulated forever. A worker record is also what `send` resolves
	// to resume a session, so a recent one must survive even after being
	// reported -- the parent may still follow up.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	const file = join(
		s.team.agentDir, "session-workers", "workers", `${worker.id}.json`,
	);
	assert.ok(existsSync(file));

	// Fresh record: reported, but too new to prune.
	s.team.pruneReportedWorkers("parent", new Set([worker.id]));
	assert.ok(existsSync(file), "a fresh record must survive");

	// Same record, now old.
	const rec = JSON.parse(readFileSync(file, "utf-8"));
	writeFileSync(
		file,
		JSON.stringify({ ...rec, createdAt: Date.now() - 30 * 86_400_000 }),
	);
	s.team.pruneReportedWorkers("parent", new Set([worker.id]));
	assert.equal(existsSync(file), false, "an old reported record is removed");
});

test("a truncated live record for a LIVE pid is unknown, not settled", async (t) => {
	// Skipping every unparseable record was the unsafe direction: a worker whose
	// OWN record was caught mid-write read as settled and could wake its parent
	// early. Only a file we can positively attribute elsewhere may be skipped --
	// i.e. one whose filename pid is not running.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	mkdirSync(join(s.team.agentDir, "inbox-live"), { recursive: true });
	// Filename is a live pid (ours), contents truncated mid-write.
	writeFileSync(
		join(s.team.agentDir, "inbox-live", `${process.pid}.json`),
		`{"sessionId":"${worker.id}","pid":${process.pid},"state":"work`,
		"utf-8",
	);
	assert.equal(
		s.team.foregroundDisposition(worker.id),
		"unknown",
		"an unattributable live record must block, not settle",
	);
});

test("a truncated record for a DEAD pid is skipped, not unknown", async (t) => {
	// The original fix must survive: one stale broken file from an unrelated
	// dead process must not make every worker unplaceable.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	mkdirSync(join(s.team.agentDir, "inbox-live"), { recursive: true });
	writeFileSync(
		join(s.team.agentDir, "inbox-live", "2147483646.json"),
		'{"garbage":',
		"utf-8",
	);
	assert.equal(
		s.team.foregroundDisposition(worker.id),
		"settled",
		"a dead pid's leftover must not poison this worker",
	);
});

test("pruning reported workers keeps the team's last ownership evidence", async (t) => {
	// Worker records are a source of ownership. If they are the only evidence and
	// pruning removes them all, `ownsWake` reports unowned and the same sweep
	// discards the arm -- resetting the episode and refilling the wake budget.
	const s = harness(t, { mode: "tui" });
	s.start();
	const worker = await s.spawn();
	const file = join(
		s.team.agentDir, "session-workers", "workers", `${worker.id}.json`,
	);
	// Old enough to prune, and reported -- but the arm is gone, so the record is
	// the only ownership evidence left.
	const rec = JSON.parse(readFileSync(file, "utf-8"));
	writeFileSync(
		file,
		JSON.stringify({ ...rec, createdAt: Date.now() - 30 * 86_400_000 }),
	);
	rmSync(join(s.team.stateDir, "parent.wake-state"), { force: true });
	rmSync(join(s.team.agentDir, "inbox-agents", "parent.json"), {
		force: true,
	});

	s.team.pruneReportedWorkers("parent", new Set([worker.id]));
	assert.ok(
		existsSync(file),
		"the last owner-stamped record must survive",
	);
	assert.equal(s.team.ownsWake("parent"), true);
});

test("a wake is not delivered in-process while the runner still holds a child", async (t) => {
	// The traced abort: a settled child keeps its `proc` until it actually exits,
	// and its state is already "idle". `isRunning` therefore said "not busy" and
	// the in-process path pushed a triggerTurn while the runner still held the
	// session -- two writers on one session file.
	const s = harness(t, { mode: "tui" });
	const parent = s.addParent();
	s.start();
	// Settled but still alive: exactly the window after agent_settled and before
	// the child process exits.
	parent.state = "idle";
	parent.proc = { kill() {} };
	writeWakeArm(s.team.stateDir, "parent", {
		armed: false,
		episode: 1,
		wakeOptIn: true,
	});
	writeWakeRequest(s.team.stateDir, {
		parentId: "parent",
		content: "[pi-kit wake] pending",
		workers: [],
	});

	s.pump();
	assert.equal(
		s.sent.length,
		0,
		"a live child is a writer even when its state is idle",
	);
	assert.ok(s.pendingWake(), "the request stays queued");
});

test("a wake IS delivered in-process once the child is truly gone", async (t) => {
	// The complement: the gate must not become permanently closed.
	const s = harness(t, { mode: "tui" });
	const parent = s.addParent();
	s.start();
	parent.state = "idle";
	parent.proc = undefined;
	writeWakeArm(s.team.stateDir, "parent", {
		armed: false,
		episode: 1,
		wakeOptIn: true,
	});
	writeWakeRequest(s.team.stateDir, {
		parentId: "parent",
		content: "[pi-kit wake] pending",
		workers: [],
	});

	s.pump();
	assert.equal(s.sent.length, 1, "an idle parent is woken in-process");
});



test("a follow-up fan-out reusing reported workers still names them", async (t) => {
	// Observed live: the arm held `episodeWorkers: []` while `.wake-reported`
	// listed both workers, and the wake said only "The delegated team has
	// settled" with no count.
	//
	// Mechanism: `pending` is built from the episode's workers plus whatever
	// `spawn` registered, and then every id already in `reported` is subtracted.
	// On a SECOND fan-out that reuses an already-reported worker (a follow-up
	// `send`, or a re-armed team), the subtraction can empty the set, so the
	// episode records nobody. The wake is still owed -- the workers did run --
	// so the bookkeeping must not lose them.
	const s = harness(t, { mode: "tui" });
	s.start();

	// First fan-out runs to completion and is reported.
	const first = await s.spawn();
	await arm(s, first.id);
	await settle(s, first.id);
	assert.equal(s.sent.length, 1, "the first fan-out wakes once");

	// Second fan-out: the same worker runs again (a follow-up), so it is in
	// `reported` before this episode opens.
	await arm(s, first.id);
	const armAfter = JSON.parse(armRaw(s) ?? "{}");
	assert.ok(
		(armAfter.episode ?? 0) >= 2,
		"a second run opens a new episode",
	);
	assert.deepEqual(
		armAfter.episodeWorkers ?? [],
		[first.id],
		"the episode must name the worker that is running, even though it was already reported",
	);
});
