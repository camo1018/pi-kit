import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type {
	AgentSupervisorOptions,
	BgAgent,
} from "../../lib/inbox-agents.ts";
import { WorkerTeam, type WorkerRunner } from "./workers.ts";

export function setup(t: TestContext) {
	const dir = fs.mkdtempSync(join(tmpdir(), "pi-worker-test-"));
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
			const agent = agents.get(opts.id);
			assert.ok(agent);
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
		rename: (id, title) =>
			calls.push({ kind: "rename", data: { id, title } }),
		supervise(options) {
			supervision.push(options);
		},
	};
	const team = new WorkerTeam(dir, runner);
	const spawn = (parentId = "parent") =>
		team.spawn({
			parentId,
			cwd: dir,
			title: "Research",
			task: "Read only; report back",
			context: "Use immutable ids",
			model: "test/model:high",
			extensionPath: "/extensions/session-workers/index.ts",
		});
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return { dir, team, agents, files, calls, supervision, spawn };
}
