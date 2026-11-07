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
import type { AgentEvent } from "../../lib/inbox-agents.ts";
import { registerSessionWorkers } from "./index.ts";
import { pumpWakeRequest, resetWakeListeners } from "./wake.ts";
import { readWakeRequest } from "./wake-queue.ts";
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
	const input = (source: "interactive" | "extension" = "interactive") => {
		const handler = handlers.get("input") as (
			event: { source: string },
			ctx: ExtensionToolContext,
		) => void;
		handler({ source }, ctx);
	};
	return {
		...s,
		tool,
		execute,
		context,
		ctx,
		start,
		shutdown,
		input,
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
		pendingWake: () => readWakeRequest(s.dir, caller),
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

test("a background parent leaves a durable wake, not a message", async (t) => {
	// A background parent is a one-shot --mode json run: its process exits with
	// the turn, so an in-memory sendMessage could never reach it.
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	assert.equal(s.hasListener(), true);
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.equal(s.sent.length, 0);
	const pending = s.pendingWake();
	assert.ok(pending, "no durable wake request was written");
	assert.match(pending.content, /settled/);
	assert.equal(pending.parentId, "parent");
});

test("a background wake becomes a run on the parent queue", async (t) => {
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.ok(s.pendingWake());
	assert.equal(s.pump(), true);
	assert.equal(s.pendingWake(), undefined, "request was not consumed");
	const queued = s.calls.filter((call) => call.kind === "send");
	assert.equal(queued.length, 1);
	assert.equal((queued[0].data as { id: string }).id, "parent");
});

test("a delivered background wake is not re-requested", async (t) => {
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	s.pump();
	// The consumer delivered it; a later settle of the same state must not
	// stack a second run on the parent queue.
	await settle(s, worker.id);
	assert.equal(s.pendingWake(), undefined);
});

test("a user reply supersedes an undelivered background wake", async (t) => {
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.ok(s.pendingWake());
	s.input("interactive");
	assert.equal(s.pendingWake(), undefined);
});

test("an undelivered wake is not stacked by later settles", async (t) => {
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	const first = s.pendingWake();
	assert.ok(first);
	// A second settle before any consumer ran must not replace or duplicate the
	// request: the parent would otherwise get two runs for one fan-out.
	await settle(s, worker.id, { runs: 9 });
	const second = s.pendingWake();
	assert.equal(second?.nonce, first.nonce);
});

test("stale parent agent in another process is still delivered", async (t) => {
	// The run process exits with its turn, so the next consumer may be a window
	// that only adopted the parent's record. Delivery must not require local
	// ownership of the parent agent.
	const s = harness(t, { mode: "json" });
	s.addParent();
	s.start();
	const worker = await s.spawn();
	await arm(s, worker.id);
	await settle(s, worker.id);
	assert.ok(s.pendingWake());
	s.agents.get("parent")!.pending = [];
	assert.equal(s.pump(), true);
	assert.equal(s.pendingWake(), undefined);
});

test("a wake left by a dead process is delivered next", async (t) => {
	const first = harness(t, { mode: "json", addParent: true });
	first.start();
	const worker = await first.spawn();
	await arm(first, worker.id);
	await settle(first, worker.id);
	const request = first.pendingWake();
	assert.ok(request, "the exiting run must leave the wake on disk");
	first.shutdown();

	// A different process, holding the same team, picks it up.
	const second = harness(t, {
		mode: "tui",
		reuse: first.dir,
		reuseTeam: first.team,
		addParent: true,
	});
	second.start();
	assert.equal(second.team.parent("parent"), "parent");
	assert.equal(second.pump(), true);
	assert.equal(second.pendingWake(), undefined);
	// Delivered by the new process, in-process, because it holds the runtime.
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

test("a team member owned by another process blocks the wake", async (t) => {
	const s = harness(t);
	s.start();
	const mine = await s.spawn();
	const foreign = await s.spawn();
	// Another Pi process owns this run, so it emits nothing here.
	s.agents.delete(foreign.id);
	await arm(s, mine.id);
	await settle(s, mine.id);
	assert.equal(s.sent.length, 0);
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
