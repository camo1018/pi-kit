import assert from "node:assert/strict";
import { test } from "node:test";
import { freshestLive } from "./inbox-agents.ts";

// The real shape: a window holds the session open (idle) and pulses `updated`
// every minute; the child running it is stamped once at agent_start. Ranking
// by recency picks the idle window and reports the session idle mid-run.
test("a working claim beats a fresher idle one", () => {
	const idleWindow = { state: "idle", updated: 2_000 };
	const liveRun = { state: "working", updated: 1_000 };
	assert.equal(freshestLive(liveRun, idleWindow), true);
	assert.equal(freshestLive(idleWindow, liveRun), false);
});

test("recency breaks ties within a state", () => {
	assert.equal(freshestLive({ state: "idle", updated: 10 }, { state: "idle", updated: 5 }), true);
	assert.equal(freshestLive({ state: "idle", updated: 5 }, { state: "idle", updated: 10 }), false);
	assert.equal(freshestLive({ state: "working", updated: 10 }, { state: "working", updated: 5 }), true);
	assert.equal(freshestLive({ state: "working", updated: 5 }, { state: "working", updated: 10 }), false);
});

test("a missing updated ranks as oldest, never as newest", () => {
	assert.equal(freshestLive({ state: "idle" }, { state: "idle", updated: 1 }), false);
	assert.equal(freshestLive({ state: "idle", updated: 1 }, { state: "idle" }), true);
});
