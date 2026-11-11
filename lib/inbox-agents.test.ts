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

test("every registered tick hook survives a later supervisor registration", async (t) => {
	// Regression: one interval held one `onTick`, and every registration did
	// `clearInterval(previous)` first. `session-workers` registers on the same
	// `session_start` as the inbox, so `sweepWakeRequests` silently deleted
	// `watchForeignRun` -- the only thing that reloads an on-screen transcript
	// after the phone finishes a run. The visible symptom was a Mac window that
	// stayed stale forever while the phone worked, with no error anywhere.
	const supervisorKey = Symbol.for("pi.inbox.agentSupervisor");
	t.after(() => {
		clearInterval(Reflect.get(globalThis, supervisorKey));
		Reflect.deleteProperty(globalThis, supervisorKey);
		Reflect.deleteProperty(
			globalThis,
			Symbol.for("pi.inbox.agentSupervisorHooks"),
		);
	});
	const fired: string[] = [];
	runner.startAgentSupervisor(
		{ onTick: () => fired.push("inbox:foreign-run") },
		"inbox:foreign-run",
	);
	runner.startAgentSupervisor(
		{ onTick: () => fired.push("session-workers:wake") },
		"session-workers:wake",
	);
	// Registration ticks immediately, and a tick runs EVERY hook: the second
	// registration must not evict the first.
	assert.deepEqual(fired, [
		"inbox:foreign-run",
		"inbox:foreign-run",
		"session-workers:wake",
	]);
	fired.length = 0;
	// Re-registering one subsystem replaces only its own hook, so a session
	// switch does not stack a second identical hook on the interval.
	runner.startAgentSupervisor(
		{ onTick: () => fired.push("session-workers:wake") },
		"session-workers:wake",
	);
	assert.deepEqual(fired, ["inbox:foreign-run", "session-workers:wake"]);
});

test("one failing tick hook does not starve the others", async (t) => {
	const supervisorKey = Symbol.for("pi.inbox.agentSupervisor");
	t.after(() => {
		clearInterval(Reflect.get(globalThis, supervisorKey));
		Reflect.deleteProperty(globalThis, supervisorKey);
		Reflect.deleteProperty(
			globalThis,
			Symbol.for("pi.inbox.agentSupervisorHooks"),
		);
	});
	const fired: string[] = [];
	runner.startAgentSupervisor(
		{
			onTick: () => {
				throw new Error("this subsystem is broken");
			},
		},
		"throws",
	);
	runner.startAgentSupervisor(
		{ onTick: () => fired.push("survivor") },
		"survivor",
	);
	// The throwing hook registered first and still must not prevent the second
	// (or a later tick) from running: adoption rides the same loop.
	assert.deepEqual(fired, ["survivor"]);
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

	write("111.json", {
		sessionId: "busy-session",
		pid: process.ppid,
		state: "working",
		updated: Date.now(),
	});
	assert.equal(
		runner.writerElsewhere("busy-session"),
		true,
		"a live foreign pid that is working is a writer",
	);

	write("222.json", { sessionId: "stale-session", pid: 2_147_483_646 });
	assert.equal(
		runner.writerElsewhere("stale-session"),
		false,
		"a dead pid is not a writer",
	);

	// Our own pid is still a writer for a DIFFERENT session, but only while it
	// says it is working: this process really is running that session under
	// another entry, and a second spawn would race it.
	write("333.json", {
		sessionId: "own-session",
		pid: process.pid,
		state: "working",
		updated: Date.now(),
	});
	assert.equal(
		runner.writerElsewhere("own-session"),
		true,
		"our own working record counts as a writer",
	);

	// An idle record for THIS process is not a writer at all: it is what an
	// orchestrator window leaves on `session_start` for a session it only has
	// open in its chat view. Counting it stopped `run()` from spawning the very
	// background run that view exists to start, so a message sent there sat in
	// `pending` forever behind "queued (after this run)" -- and stayed stuck
	// across restarts, because the pending message is durable and the fresh
	// window writes the same idle record.
	write("444.json", {
		sessionId: "own-idle",
		pid: process.pid,
		state: "idle",
	});
	assert.equal(
		runner.writerElsewhere("own-idle"),
		false,
		"our own idle record is not writing anything",
	);

	// A FOREIGN idle record is not a writer either: having a session open is not
	// writing it. Blocking on presence parked messages behind "queued (after this
	// run)" when any window merely had the session in its chat view.
	write("555.json", {
		sessionId: "foreign-idle",
		pid: process.ppid,
		state: "idle",
	});
	assert.equal(
		runner.writerElsewhere("foreign-idle"),
		false,
		"a foreign idle record is not writing anything",
	);

	// A foreign WORKING record is: that process is mid-run on this session, and a
	// second writer would race it for the file.
	write("666.json", {
		sessionId: "foreign-working",
		pid: process.ppid,
		state: "working",
		updated: Date.now(),
	});
	assert.equal(runner.writerElsewhere("foreign-working"), true);

	assert.equal(runner.writerElsewhere("nobody"), false);
});

test("an attached session's queued message actually starts a run", async () => {
	// The end-to-end shape of the same regression: with the window's own idle
	// live record present, `sendToAgent` on that session must spawn, not leave
	// the message parked in `pending` behind "queued (after this run)".
	let spawned = 0;
	mock.method(
		childProcess,
		"spawn",
		(_command: string, _args: readonly string[]) => {
			spawned++;
			const child = new EventEmitter() as ChildProcess;
			const stdin = new PassThrough();
			stdin.on("data", () => {});
			Object.assign(child, {
				pid: 123450001,
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
	try {
		const live = join(dir, "inbox-live");
		fs.mkdirSync(live, { recursive: true });
		fs.writeFileSync(
			join(live, `${process.pid}.json`),
			JSON.stringify({
				sessionId: "open-in-this-window",
				pid: process.pid,
				state: "idle",
			}),
		);
		const agent = runner.sendToAgent({
			id: "open-in-this-window",
			cwd: dir,
			title: "open in this window",
			text: "hello",
		});
		assert.equal(spawned, 1, "the attached session starts its run");
		assert.deepEqual(agent.pending, [], "the message is not left queued");
		assert.ok(agent.proc, "a run is in flight");
	} finally {
		mock.restoreAll();
		syncBuiltinESMExports();
		runner.registry().agents.clear();
	}
});

test("a session open in several windows still accepts a send", async () => {
	// Holding a session open is not writing it. Two other windows have this
	// session in their chat views (idle records, live pids) and neither is
	// running it, so a send must start a run rather than park the message.
	// Only one writer at a time is still enforced -- that is `writerElsewhere`
	// on a `working` record, and the run lock beneath it.
	let spawned = 0;
	mock.method(
		childProcess,
		"spawn",
		(_command: string, _args: readonly string[]) => {
			spawned++;
			const child = new EventEmitter() as ChildProcess;
			const stdin = new PassThrough();
			stdin.on("data", () => {});
			Object.assign(child, {
				pid: 123450002,
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
	try {
		const live = join(dir, "inbox-live");
		fs.mkdirSync(live, { recursive: true });
		const openIn = (pid: number) =>
			fs.writeFileSync(
				join(live, `${pid}.json`),
				JSON.stringify({
					sessionId: "held-open-everywhere",
					pid,
					state: "idle",
				}),
			);
		// Our own window, plus a genuinely foreign one (the test runner's parent,
		// which is alive and not us).
		openIn(process.pid);
		openIn(process.ppid);

		const agent = runner.sendToAgent({
			id: "held-open-everywhere",
			cwd: dir,
			title: "held open everywhere",
			text: "hello",
		});
		assert.equal(spawned, 1, "an open session is not a blocked session");
		assert.deepEqual(agent.pending, [], "the message is not left queued");
		assert.ok(agent.proc, "a run is in flight");
	} finally {
		mock.restoreAll();
		syncBuiltinESMExports();
		runner.registry().agents.clear();
	}
});

test("a frozen 'working' claim stops counting as a writer", async () => {
	// An orphaned tab frozen mid-turn keeps a live record and a live pid but
	// cannot refresh it. The inbox aged that to `idle` after 5 minutes while
	// `writerElsewhere` read the raw file and never did, so the session was
	// blocked from ever being written again. Both ask `isWriting` now.
	const live = join(dir, "inbox-live");
	fs.mkdirSync(live, { recursive: true });
	const claim = (state: string, ageMs: number) =>
		fs.writeFileSync(
			join(live, `${process.ppid}.json`),
			JSON.stringify({
				sessionId: "frozen",
				pid: process.ppid,
				state,
				updated: Date.now() - ageMs,
			}),
		);

	claim("working", 60_000); // one pulse interval: real work
	assert.equal(runner.writerElsewhere("frozen"), true);

	claim("working", runner.LIVE_STALE_MS + 60_000);
	assert.equal(
		runner.writerElsewhere("frozen"),
		false,
		"a claim that stopped refreshing is not a writer",
	);
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

test("the run lock is exclusive and a dead holder is reclaimed", async () => {
	// `writerElsewhere` is a read: two processes calling run() in the same instant
	// both see no writer and both spawn. The lock is what makes the guarantee
	// mutual exclusion rather than a likely-correct glance.
	const id = "lock-session";
	assert.equal(runner.acquireRunLock(id), true, "first caller takes it");
	assert.equal(runner.acquireRunLock(id), true, "we hold it: a missed release");
	runner.releaseRunLock(id);

	// A lock held by a live foreign process blocks.
	const file = join(dir, "inbox-agents", `${id}.runlock`);
	fs.mkdirSync(join(dir, "inbox-agents"), { recursive: true });
	fs.writeFileSync(file, String(process.ppid), "utf-8");
	assert.equal(runner.acquireRunLock(id), false, "a live holder keeps it");
	assert.equal(fs.readFileSync(file, "utf-8"), String(process.ppid));

	// A lock held by a process that crashed between acquire and release must not
	// wedge the session forever.
	fs.writeFileSync(file, String(2_147_483_646), "utf-8");
	assert.equal(runner.acquireRunLock(id), true, "a dead holder is reclaimed");
	assert.equal(fs.readFileSync(file, "utf-8"), String(process.pid));

	// Release is owner-scoped: a process must not drop someone else's lock.
	fs.writeFileSync(file, String(process.ppid), "utf-8");
	runner.releaseRunLock(id);
	assert.equal(fs.existsSync(file), true, "not ours to release");

	fs.writeFileSync(file, String(process.pid), "utf-8");
	runner.releaseRunLock(id);
	assert.equal(fs.existsSync(file), false);
});

// ── an orphaned background run must not own its session forever ────────────
//
// A background child is detached on purpose so a closed tab does not kill it,
// and a live pi normally adopts it within ~20s. When nobody does, the run keeps
// a live pid and a fresh heartbeat while sitting inside one tool call that never
// returns -- so pidAlive, `updated`, and every cheap check say "busy" forever.
// Observed in the wild: such a run outlived its parent by 3h40m and kept the
// session it shared unwritable the whole time.

/**
 * Write a live record for `pid` whose RUN started `ageMs` ago.
 *
 * Deliberately backdates `startedAt`, not the file's timestamps: the rule reads
 * the record's own clock, so the test exercises the same path production does
 * instead of depending on how a given filesystem reports birthtime.
 */
function liveRecord(
	pid: number,
	fields: Record<string, unknown>,
	ageMs: number,
): string {
	const live = join(dir, "inbox-live");
	fs.mkdirSync(live, { recursive: true });
	const file = join(live, `${pid}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify({
			pid,
			state: "working",
			// A wedged run's heartbeat is FRESH -- that is the whole problem.
			updated: Date.now(),
			startedAt: Date.now() - ageMs,
			...fields,
		}),
	);
	return file;
}

const DEAD_PARENT = 2 ** 30 + 7; // far outside any real pid range

test("a background run whose parent is gone stops being a writer after the grace", async () => {
	const id = "orphaned-run";
	const file = liveRecord(
		process.ppid,
		{ sessionId: id, bgParent: DEAD_PARENT },
		runner.ORPHANED_RUN_GRACE_MS + 60_000,
	);
	try {
		assert.equal(
			runner.writerElsewhere(id),
			false,
			"a run nobody adopted in time is stuck, not working",
		);
	} finally {
		fs.rmSync(file, { force: true });
	}
});

test("an orphan is still a writer while adoption could still rescue it", async () => {
	// The first 20s are exactly when a live pi is expected to adopt. Releasing
	// the slot here would let a second writer start beside a healthy orphan --
	// the two-writer bug that produced the zero-token aborts.
	const id = "fresh-orphan";
	const file = liveRecord(
		process.ppid,
		{ sessionId: id, bgParent: DEAD_PARENT },
		5_000,
	);
	try {
		assert.equal(
			runner.writerElsewhere(id),
			true,
			"a just-orphaned run gets its adoption window",
		);
	} finally {
		fs.rmSync(file, { force: true });
	}
});

test("an old background run with a LIVE parent is still a writer", async () => {
	// Age alone is not abandonment. A long, healthy background run whose parent
	// is alive is doing real work and must keep its slot however long it takes.
	const id = "long-healthy-run";
	const file = liveRecord(
		process.ppid,
		{ sessionId: id, bgParent: process.ppid },
		runner.ORPHANED_RUN_GRACE_MS * 10,
	);
	try {
		assert.equal(
			runner.writerElsewhere(id),
			true,
			"a long run is not a stuck run",
		);
	} finally {
		fs.rmSync(file, { force: true });
	}
});

test("an interactive turn is never treated as an abandoned background run", async () => {
	// No bgParent means a person is sitting in front of that pi. Holding the
	// session open for hours is legitimate, so this must not be aged out.
	const id = "long-interactive-turn";
	const file = liveRecord(
		process.ppid,
		{ sessionId: id },
		runner.ORPHANED_RUN_GRACE_MS * 10,
	);
	try {
		assert.equal(
			runner.writerElsewhere(id),
			true,
			"an interactive writer is a writer for as long as it runs",
		);
	} finally {
		fs.rmSync(file, { force: true });
	}
});

test("an abandoned run releases the run lock it was holding", async () => {
	// `isWriting` rejecting the claim is not enough: the runlock enforced the
	// same stale claim separately, so the session stayed unwritable.
	const id = "abandoned-lock";
	const file = liveRecord(
		process.ppid,
		{ sessionId: id, bgParent: DEAD_PARENT },
		runner.ORPHANED_RUN_GRACE_MS + 60_000,
	);
	const lock = join(dir, "inbox-agents", `${id}.runlock`);
	fs.mkdirSync(join(dir, "inbox-agents"), { recursive: true });
	fs.writeFileSync(lock, String(process.ppid));
	try {
		assert.equal(runner.abandonedWriter(process.ppid), true);
		assert.equal(
			runner.acquireRunLock(id),
			true,
			"a wedged run's lock is reclaimable",
		);
		assert.equal(fs.readFileSync(lock, "utf-8"), String(process.pid));
	} finally {
		fs.rmSync(file, { force: true });
		fs.rmSync(lock, { force: true });
	}
});

test("a live background run keeps its run lock", async () => {
	const id = "healthy-lock";
	const file = liveRecord(
		process.ppid,
		{ sessionId: id, bgParent: process.ppid },
		runner.ORPHANED_RUN_GRACE_MS * 10,
	);
	const lock = join(dir, "inbox-agents", `${id}.runlock`);
	fs.mkdirSync(join(dir, "inbox-agents"), { recursive: true });
	fs.writeFileSync(lock, String(process.ppid));
	try {
		assert.equal(runner.abandonedWriter(process.ppid), false);
		assert.equal(
			runner.acquireRunLock(id),
			false,
			"a live holder is a competitor, not garbage",
		);
	} finally {
		fs.rmSync(file, { force: true });
		fs.rmSync(lock, { force: true });
	}
});

test("sessionModel memoises but never serves a stale model", (t) => {
	// Opening a session parses the WHOLE file, and a session list asks for this
	// once per row. On a real machine that is 1.0 GB across 799 files: 2,171ms
	// for one pass. orch-web's SSE tick did it for every row every 1.2s, which
	// made a 2.2s rebuild on a 1.2s timer and grew the socket backlog without
	// bound. The memo has to be exact, or a session would report the wrong model.
	const file = join(dir, "memo.jsonl");
	const line = (value: unknown) => `${JSON.stringify(value)}\n`;
	fs.writeFileSync(file, line({
		// SessionManager.open needs a real header or it yields no branch at all.
		type: "session", version: 3, id: "memo-session",
		timestamp: new Date().toISOString(), cwd: dir,
	}) + line({
		type: "model_change", id: "a", parentId: null,
		timestamp: new Date().toISOString(),
		provider: "llm-gateway", modelId: "first",
	}));
	const first = runner.sessionModel(file);
	assert.match(first ?? "", /first$/);

	// Warm: same answer. Proven by timing rather than by a spy, because the
	// expensive call lives in another module and mocking it would test the mock.
	const before = process.hrtime.bigint();
	assert.equal(runner.sessionModel(file), first);
	const warmMs = Number(process.hrtime.bigint() - before) / 1e6;
	assert.ok(warmMs < 5, `a warm read must not re-parse; took ${warmMs}ms`);

	// An append moves (mtime, size), which must invalidate.
	fs.appendFileSync(file, line({
		type: "model_change", id: "b", parentId: "a",
		timestamp: new Date().toISOString(),
		provider: "llm-gateway", modelId: "second",
	}));
	assert.match(
		runner.sessionModel(file) ?? "",
		/second$/,
		"an appended model change must be visible",
	);

	// A thinking-level change must fold into the same string.
	fs.appendFileSync(file, line({
		type: "thinking_level_change", id: "c", parentId: "b",
		timestamp: new Date().toISOString(), thinkingLevel: "high",
	}));
	assert.match(runner.sessionModel(file) ?? "", /second:high$/);

	// A deleted file must not return the memoised answer.
	fs.rmSync(file);
	assert.equal(runner.sessionModel(file), undefined);
});

test("a settled run drops its in-flight items so the transcript cannot repeat", async (t) => {
	// The phone renders the session file's transcript AND, below it, the run's
	// live items. `items` is appended on every `message_end` -- the same moment
	// that message enters the file -- and nothing ever removed them, so a
	// finished run kept being reported as "in flight" and the final answer
	// appeared twice. The boundary is the settle.
	t.after(() => runner.registry().agents.clear());
	const a = runner.spawnAgent({
		id: "settle-items",
		title: "settle items",
		cwd: dir,
		prompt: "go",
	});
	a.items = [];
	runner.applyEvent(a, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "done" }] },
	});
	assert.deepEqual(a.items.map((i) => i.kind), ["text"], "the run tracks its own output");

	runner.applyEvent(a, { type: "agent_settled" });
	assert.deepEqual(a.items, [], "a settled run has no in-flight items left");
});
