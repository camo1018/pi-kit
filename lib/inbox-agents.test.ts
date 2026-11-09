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

test("a finished run keeps sidecar state owned by other subsystems", async (t) => {
	// Regression: metadata cleanup deleted every `AGENTS_DIR/<id>.*`, which is a
	// namespace shared with session-workers. `<id>.wake` and `<id>.wake-state`
	// live there too, so a parent run finishing destroyed its own undelivered
	// wake and its arming record -- a permanent, traceless missed wake.
	const root = join(dir, "inbox-agents");
	fs.mkdirSync(root, { recursive: true });
	const id = "sidecar-owner";
	const sidecars = ["wake", "wake-state", "wake.1234.tmp"];
	const owned = ["out", "err", "exit", "stop", "beat"];
	fs.writeFileSync(join(root, `${id}.json`), JSON.stringify({
		v: 1,
		id,
		cwd: dir,
		title: id,
		state: "idle",
		pending: [],
		createdAt: 1,
		updatedAt: 1,
		runs: 1,
		needsYou: false,
		owner: process.pid,
		ownerBeat: Date.now(),
	}));
	for (const ext of [...sidecars, ...owned]) {
		fs.writeFileSync(join(root, `${id}.${ext}`), "{}");
	}
	// An adoption claim directory is ours to clean up too.
	fs.mkdirSync(join(root, `${id}.adopt-1-2`));

	// A settled agent with nothing pending is not persisted, so the next
	// persist() call takes the cleanup path.
	runner.sendToAgent({ id, cwd: dir, title: id, text: "go" });
	const agent = runner.getAgent(id);
	assert.ok(agent);
	agent.proc?.kill();
	agent.proc = undefined;
	agent.state = "idle";
	agent.pending = [];
	await new Promise((resolve) => setTimeout(resolve, 400));

	for (const ext of sidecars) {
		assert.ok(
			fs.existsSync(join(root, `${id}.${ext}`)),
			`${id}.${ext} belongs to session-workers and must survive`,
		);
	}
	assert.equal(fs.existsSync(join(root, `${id}.adopt-1-2`)), false);
});

test("a run reopens the session file instead of resolving it by cwd slug", async (t) => {
	// Regression: `--session-id` is resolved against the *spawning* process's
	// cwd only. A wake delivered from a different directory (the parent was
	// created in a worktree, the sweep ran from the repo root) did not find the
	// existing session, so pi created a brand-new blank one under the same id
	// and orphaned the real transcript. The log line was:
	//   "Warning: No project session found with id ...; creating a new session"
	const root = join(dir, "inbox-agents");
	const sessions = join(dir, "sessions");
	const sessionCwd = join(dir, "worktree");
	fs.mkdirSync(root, { recursive: true });
	fs.mkdirSync(sessionCwd, { recursive: true });
	const otherCwd = join(dir, "elsewhere");
	fs.mkdirSync(otherCwd, { recursive: true });
	const id = "reopen-me";
	const slug = `--${sessionCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	fs.mkdirSync(join(sessions, slug), { recursive: true });
	const file = join(sessions, slug, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	fs.writeFileSync(
		file,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: sessionCwd,
		})}\n`,
	);

	let argv: readonly string[] = [];
	let spawnCwd: string | undefined;
	mock.method(
		childProcess,
		"spawn",
		(_command: string, args: readonly string[], options: { cwd?: string }) => {
			argv = args;
			spawnCwd = options.cwd;
			const child = new EventEmitter() as ChildProcess;
			const stdin = new PassThrough();
			Object.assign(child, {
				pid: 987654321,
				stdin,
				unref() {},
				kill() {
					return true;
				},
			});
			return child;
		},
	);
	syncBuiltinESMExports();
	t.after(() => {
		mock.restoreAll();
		syncBuiltinESMExports();
		runner.registry().agents.clear();
	});

	// The agent record says the wrong cwd on purpose: that is what a wake
	// delivered from another directory looks like.
	runner.sendToAgent({ id, cwd: otherCwd, title: id, text: "wake up", sessionFile: file });
	assert.equal(
		argv[argv.indexOf("--session") + 1],
		file,
		"the existing session file must be passed by path",
	);
	assert.equal(argv.includes("--session-id"), false, "never resolve by id");
	assert.equal(spawnCwd, sessionCwd, "spawn in the session's own cwd");
});


test("readExit refuses an exit marker while the recorded pid is alive", async (t) => {
	// The stop path writes `<id>.exit` BEFORE signalling itself, so the marker
	// exists while the child is still running. Trusting it let the supervisor
	// finish the run and `pump()` the next one while the old child was alive --
	// two runs on one session file, which is the traced abort.
	fs.mkdirSync(join(dir, "inbox-agents"), { recursive: true });
	const write = (id: string, body: unknown) =>
		fs.writeFileSync(
			join(dir, "inbox-agents", `${id}.exit`),
			JSON.stringify(body),
			"utf-8",
		);
	const agent = (id: string, pid: number) =>
		({ id, pid }) as unknown as BgAgent;

	// Alive pid: the marker must be ignored.
	write("alive-holder", { pid: process.pid, code: 143 });
	assert.equal(
		runner.readExit(agent("alive-holder", process.pid)),
		undefined,
		"a marker for a live pid is not proof of exit",
	);

	// Dead pid: the marker is trusted, so the normal path still finishes.
	write("dead-holder", { pid: 2_147_483_646, code: 0 });
	assert.equal(runner.readExit(agent("dead-holder", 2_147_483_646)), 0);
});

test("writerElsewhere sees a live writer, and ignores a stale record", async () => {
	// The chokepoint every spawn path shares. A live record for this session means
	// someone is running it; a record whose pid is gone is stale, not a writer --
	// crash recovery depends on being able to take over.
	const live = join(dir, "inbox-live");
	fs.mkdirSync(live, { recursive: true });
	const write = (name: string, body: unknown) =>
		fs.writeFileSync(join(live, name), JSON.stringify(body), "utf-8");

	write("111.json", { sessionId: "busy-session", pid: process.ppid });
	assert.equal(
		runner.writerElsewhere("busy-session"),
		true,
		"a live foreign pid is a writer",
	);

	write("222.json", { sessionId: "stale-session", pid: 2_147_483_646 });
	assert.equal(
		runner.writerElsewhere("stale-session"),
		false,
		"a dead pid is not a writer",
	);

	// Our own pid is still a writer for a DIFFERENT session: this is the case
	// `runningElsewhere` skipped and that produced a duplicate.
	write("333.json", { sessionId: "own-session", pid: process.pid });
	assert.equal(
		runner.writerElsewhere("own-session"),
		true,
		"our own pid counts for another session",
	);

	assert.equal(runner.writerElsewhere("nobody"), false);
});

test("silence means gone only when the recorded pid is also gone", async () => {
	// A suspended process (GC, OS) stops beating while still running its child.
	// Treating silence as an exit finished the run and pumped the next one while
	// the original was alive -- two writers on one session file.
	const old = Date.now() - (runner.CHILD_GRACE_MS + 60_000);
	const noBeat = "silent-with-no-beat-file";

	// Silent, old, and the pid is ALIVE: not gone, so no finish.
	assert.equal(
		runner.silenceMeansGone({
			id: noBeat,
			runStartedAt: old,
			pid: process.pid,
		}),
		false,
		"a live pid is not gone, however quiet",
	);

	// Silent, old, and the pid is DEAD: genuinely gone.
	assert.equal(
		runner.silenceMeansGone({
			id: noBeat,
			runStartedAt: old,
			pid: 2_147_483_646,
		}),
		true,
		"a dead pid with stale silence is gone",
	);

	// Too recent: never concludes.
	assert.equal(
		runner.silenceMeansGone({
			id: noBeat,
			runStartedAt: Date.now(),
			pid: 2_147_483_646,
		}),
		false,
		"a fresh run is never written off",
	);
});

test("a stale heartbeat does not authorise adoption while the owner lives", async () => {
	// The rule that keeps a suspended process from being adopted out from under
	// its own running child. A stale beat alone is not proof of death.
	const staleLongAgo = Date.now() - (runner.CHILD_GRACE_MS + 60_000);

	// Stale beat, but the owner is alive: not ours to take.
	assert.equal(
		runner.mayAdopt({ owner: process.ppid, ownerBeat: staleLongAgo }),
		false,
		"a live owner keeps its record",
	);

	// Stale beat, owner gone: adoptable.
	assert.equal(
		runner.mayAdopt({ owner: 2_147_483_646, ownerBeat: staleLongAgo }),
		true,
		"a dead owner's record is adoptable",
	);

	// A live recorded CHILD also blocks, even with a dead owner.
	assert.equal(
		runner.mayAdopt({
			owner: 2_147_483_646,
			ownerBeat: staleLongAgo,
			pid: process.pid,
		}),
		false,
		"a live child still owns the session",
	);

	// Fresh beat: never adopt, whoever owns it.
	assert.equal(
		runner.mayAdopt({ owner: process.ppid, ownerBeat: Date.now() }),
		false,
	);
});
