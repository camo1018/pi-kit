import assert from "node:assert/strict";
import { test } from "node:test";

// Import after pointing the agent dir at a scratch tree: the inbox module reads
// it at load time for its own state files.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pi-foreign-"));
const old = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = home;
writeFileSync(join(home, "notify.json"), JSON.stringify({ enabled: false }));

const { foreignRunMove, foreignWorkingFor } = await import("./index.ts");

after(() => {
	if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = old;
	rmSync(home, { recursive: true, force: true });
});

test("steady state is silent", () => {
	// The tick runs every 5s; anything but 'none' here would reload continuously.
	assert.equal(foreignRunMove(false, false), "none");
	assert.equal(foreignRunMove(true, true), "none");
});

test("a foreign run starting is announced", () => {
	assert.equal(foreignRunMove(false, true), "started");
});

test("a foreign run ending triggers the reload", () => {
	assert.equal(foreignRunMove(true, false), "finished");
});

test("a full run produces exactly one start and one finish", () => {
	const ticks = [false, true, true, true, false, false];
	let was = false;
	const seen: string[] = [];
	for (const now of ticks) {
		const move = foreignRunMove(was, now);
		if (move !== "none") seen.push(move);
		was = now;
	}
	assert.deepEqual(seen, ["started", "finished"]);
});

// ── foreignWorkingFor: which record decides the badge ──────────────────────────
//
// The regression this guards: `readLive()` collapses to ONE record per session
// and keeps the freshest `updated`. A window that reloads stamps a fresh local
// `idle`, which outranks a foreign `working` written seconds earlier -- so the
// badge vanished for the rest of a run the phone was still driving.

// A FOREIGN pid must be alive for isWriting(), so borrow the parent process --
// the convention the runner tests already use for simulating another pi.
const SELF = process.pid;
const FOREIGN = process.ppid;

function rec(over: Record<string, unknown>) {
	return {
		pid: FOREIGN,
		sessionId: "s",
		sessionFile: "/tmp/s.jsonl",
		state: "working",
		updated: 5_000,
		startedAt: 5_000,
		...over,
	} as never;
}

test("a foreign working record is active", () => {
	assert.equal(
		foreignWorkingFor([rec({})], { selfPid: SELF, now: 6_000 }),
		true,
	);
});

test("our own record is never foreign", () => {
	assert.equal(
		foreignWorkingFor([rec({ pid: SELF })], { selfPid: SELF, now: 6_000 }),
		false,
	);
});

test("our own background child is never foreign", () => {
	assert.equal(
		foreignWorkingFor([rec({ bgParent: SELF })], { selfPid: SELF, now: 6_000 }),
		false,
	);
});

test("an idle record alone is not a run", () => {
	assert.equal(
		foreignWorkingFor([rec({ state: "idle" })], { selfPid: SELF, now: 6_000 }),
		false,
	);
});

test("a newer local idle does not mask a foreign working run", () => {
	// THE regression. Newest-updated-wins would pick the idle and hide the badge.
	const records = [
		rec({ pid: SELF, state: "idle", updated: 9_000 }),
		rec({ pid: FOREIGN, state: "working", updated: 5_000 }),
	];
	assert.equal(foreignWorkingFor(records, { selfPid: SELF, now: 9_500 }), true);
});

test("a stale working claim past the window is not a run", () => {
	assert.equal(
		foreignWorkingFor([rec({ updated: 1_000 })], { selfPid: SELF, now: 1_000_000 }),
		false,
	);
});
