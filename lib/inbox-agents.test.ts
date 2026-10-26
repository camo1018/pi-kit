import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, mock, test } from "node:test";
import type { BgAgent } from "./inbox-agents.ts";

// Isolate runner state before its module-level agent directory is resolved.
const dir = fs.mkdtempSync(join(tmpdir(), "pi-runner-test-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const runner = await import("./inbox-agents.ts");
after(() => {
	if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldDir;
	fs.rmSync(dir, { recursive: true, force: true });
});

test("worker extension paths reach the subprocess and durable registry", async (t) => {
	let argv: readonly string[] = [];
	let input = "";
	const children: ChildProcess[] = [];
	mock.method(
		childProcess,
		"spawn",
		(_command: string, args: readonly string[]) => {
			argv = args;
			const child = new EventEmitter() as ChildProcess;
			const stdin = new PassThrough();
			stdin.on("data", (chunk) => {
				input += chunk.toString();
			});
			Object.assign(child, {
				pid: 123456789,
				stdin,
				unref() {},
				kill() {
					return true;
				},
			});
			children.push(child);
			return child;
		},
	);
	syncBuiltinESMExports();
	t.after(() => {
		mock.restoreAll();
		syncBuiltinESMExports();
		runner.registry().agents.clear();
	});
	const extension = "/feature/extension/index.ts";
	const agent = runner.spawnAgent({
		id: "test-worker",
		title: "Worker",
		cwd: dir,
		prompt: "@starts-with-mention remains prompt text",
		extensionPaths: [extension],
	});
	assert.equal(argv[argv.indexOf("--extension") + 1], extension);
	assert.equal(
		argv.includes("@starts-with-mention remains prompt text"),
		false,
	);
	assert.equal(input, "@starts-with-mention remains prompt text");
	const saved = JSON.parse(
		fs.readFileSync(join(dir, "inbox-agents", "test-worker.json"), "utf8"),
	);
	assert.deepEqual(saved.extensionPaths, [extension]);
	assert.deepEqual(agent.extensionPaths, [extension]);
	children[0].emit("exit", 0);
	// The runner monitor reconciles exit before clearing its resources.
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(agent.proc, undefined);
	assert.equal(agent.state, "idle");
	// A completed run removes runner metadata; the team supplies paths again.
	runner.registry().agents.delete(agent.id);
	const resumed = runner.sendToAgent({
		id: agent.id,
		cwd: dir,
		title: "Worker",
		text: "Follow up",
		extensionPaths: [extension],
	});
	assert.equal(argv[argv.indexOf("--extension") + 1], extension);
	assert.deepEqual(resumed.extensionPaths, [extension]);
	children[1].emit("exit", 0);
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(resumed.proc, undefined);
});

test("background supervisors heartbeat teams without adopting ancestors", async (t) => {
	const childKey = Symbol.for("pi.inbox.agentChild");
	const supervisorKey = Symbol.for("pi.inbox.agentSupervisor");
	const oldChild = Reflect.get(globalThis, childKey);
	Reflect.set(globalThis, childKey, "background-parent");
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
	mock.method(childProcess, "spawn", () => {
		throw new Error("This test must never launch a subprocess");
	});
	syncBuiltinESMExports();
	t.after(() => {
		clearInterval(Reflect.get(globalThis, supervisorKey));
		Reflect.deleteProperty(globalThis, supervisorKey);
		if (oldChild === undefined)
			Reflect.deleteProperty(globalThis, childKey);
		else Reflect.set(globalThis, childKey, oldChild);
		mock.restoreAll();
		syncBuiltinESMExports();
		runner.registry().agents.clear();
	});
	const root = join(dir, "inbox-agents");
	fs.mkdirSync(root, { recursive: true });
	for (const id of ["background-parent", "unrelated", "team-child"]) {
		fs.writeFileSync(
			join(root, `${id}.json`),
			JSON.stringify({
				v: 1,
				id,
				cwd: dir,
				title: id,
				state: id === "team-child" ? "idle" : "queued",
				pending: id === "team-child" ? [] : ["Must not run"],
				createdAt: 1,
				updatedAt: 1,
				runs: 1,
				needsYou: false,
				owner: 123456789,
				ownerBeat: 0,
			}),
		);
	}
	const ancestor = fs.readFileSync(join(root, "background-parent.json"));
	const unrelated = fs.readFileSync(join(root, "unrelated.json"));
	runner.startAgentSupervisor();
	assert.equal(Reflect.get(globalThis, supervisorKey), undefined);
	runner.startAgentSupervisor({ allowBackground: true });
	assert.equal(Reflect.get(globalThis, supervisorKey), undefined);

	const owned: BgAgent = {
		id: "heartbeat-worker",
		cwd: dir,
		title: "Owned worker",
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
	runner.registry().agents.set(owned.id, owned);
	runner.startAgentSupervisor({
		allowBackground: true,
		adoptSessionIds: new Set(["team-child", owned.id]),
	});
	assert.equal(runner.getAgent("team-child")?.state, "idle");
	assert.equal(runner.getAgent("background-parent"), undefined);
	assert.equal(runner.getAgent("unrelated"), undefined);
	const readBeat = () =>
		JSON.parse(fs.readFileSync(join(root, `${owned.id}.json`), "utf8"))
			.ownerBeat as number;
	const firstBeat = readBeat();
	t.mock.timers.tick(5_001);
	assert.ok(readBeat() > firstBeat);
	assert.deepEqual(
		fs.readFileSync(join(root, "background-parent.json")),
		ancestor,
	);
	assert.deepEqual(fs.readFileSync(join(root, "unrelated.json")), unrelated);
});
