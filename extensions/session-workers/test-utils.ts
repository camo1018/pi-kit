import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type {
	AgentSupervisorOptions,
	BgAgent,
} from "../../lib/inbox-agents.ts";
import { WorkerTeam, type WorkerRunner } from "./workers.ts";

export function setup(t: TestContext, reuseTeam?: WorkerTeam) {
	const dir = reuseTeam?.agentDir ??
		fs.mkdtempSync(join(tmpdir(), "pi-worker-test-"));
	// Reusing a team directory must NOT reuse the old runner: a new process has
	// its own empty registry and must adopt workers explicitly.

	const agents = new Map<string, BgAgent>();
	const files = new Map<string, string>();
	const calls: { kind: string; data: unknown }[] = [];
	const supervision: (AgentSupervisorOptions | undefined)[] = [];
	// Process-runner boundary: no actual Pi/model process runs in tests.
	const runner: WorkerRunner = {
		spawn(opts) {
			calls.push({ kind: "spawn", data: opts });
			assert.ok(opts.id);
			const agent: BgAgent = {
				id: opts.id,
				cwd: opts.cwd,
				title: opts.title,
				extensionPaths: opts.extensionPaths,
				state: "working",
				proc: { kill() {} },
				pending: [],
				createdAt: 1,
				updatedAt: 1,
				needsYou: false,
				runs: 1,
				log: [],
				liveText: "",
			};
			agents.set(agent.id, agent);
			return agent;
		},
		send(opts) {
			calls.push({ kind: "send", data: opts });
			// An orphaned parent legitimately has no registry entry here: the
			// whole point of the pending-delivery path is that the owning process
			// is gone. Record the call and stop, rather than demanding a live agent.
			const agent = agents.get(opts.id);
			if (!agent) return { id: opts.id } as BgAgent;
			agent.pending.push(opts.text);
			return agent;
		},
		cancel(id) {
			calls.push({ kind: "cancel", data: id });
			const agent = agents.get(id);
			if (agent) {
				agent.state = "cancelled";
				agent.pending = [];
			}
		},
		get: (id) => agents.get(id),
		find: (id) => files.get(id),
		// Tests drive liveness explicitly; the real one reads inbox-live records.
		writerElsewhere: () => false,
		rename: (id, title) =>
			calls.push({ kind: "rename", data: { id, title } }),
		supervise(options) {
			supervision.push(options);
		},
	};
	const team = new WorkerTeam(dir, runner);
	// Wake is opt-in at spawn, so the harness opts in by default: these tests
	// are about the wake subsystem itself. The opt-out default is pinned by its
	// own tests.
	/**
	 * Production persists a parent's agent record with `owner: process.pid` when
	 * it starts a run, and that record is what makes this process responsible for
	 * waking it. Mirror that, or every wake test would look unowned.
	 */
	const claimParent = (parentId: string) => {
		const file = join(dir, "inbox-agents", `${parentId}.json`);
		mkdirSync(join(dir, "inbox-agents"), { recursive: true });
		writeFileSync(file, JSON.stringify({
			v: 1,
			id: parentId,
			cwd: dir,
			title: parentId,
			state: "working",
			pending: [],
			owner: process.pid,
			ownerBeat: Date.now(),
		}), "utf-8");
	};
	const spawn = (parentId = "parent", wake = true) => {
		claimParent(parentId);
		return team.spawn({
			parentId,
			cwd: dir,
			title: "Research",
			task: "Read only; report back",
			context: "Use immutable ids",
			model: "test/model:high",
			wake,
			extensionPath: "/extensions/session-workers/index.ts",
		});
	};
	/**
	 * A background parent is itself a registry agent (it owns runs and a queue),
	 * so durable wake delivery can queue onto it exactly like a user reply.
	 */
	const addParent = (id = "parent") => {
		const agent: BgAgent = {
			id,
			cwd: dir,
			title: "parent",
			state: "idle",
			proc: undefined,
			pending: [],
			createdAt: 1,
			updatedAt: 1,
			needsYou: false,
			runs: 1,
			log: [],
			liveText: "",
		};
		claimParent(id);
		agents.set(id, agent);
		return agent;
	};
	/**
	 * Model adoption by a new process: the worker is visible in this process's
	 * registry, exactly as `adoptOrphans` would make it.
	 */
	const adopt = (
		worker: { id: string; cwd: string; title: string },
		patch: Partial<BgAgent> = {},
	) => {
		const agent: BgAgent = {
			id: worker.id,
			cwd: worker.cwd,
			title: worker.title,
			state: "idle",
			pending: [],
			createdAt: 1,
			updatedAt: 1,
			needsYou: false,
			runs: 1,
			log: [],
			liveText: "",
			...patch,
		};
		agents.set(agent.id, agent);
		return agent;
	};
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return {
		dir,
		team,
		agents,
		files,
		calls,
		supervision,
		spawn,
		addParent,
		adopt,
	};
}
