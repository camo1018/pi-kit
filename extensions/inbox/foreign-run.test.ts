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

const { foreignRunMove } = await import("./index.ts");

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
