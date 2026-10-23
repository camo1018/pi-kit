import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	beforeRun, branchName, selectedHistory, sourceName,
} from "./session-branch.ts";

function user(sm: SessionManager, text: string) {
	return sm.appendMessage({
		role: "user", content: text, timestamp: Date.now(),
	});
}

test("names distinguish Clone/Fork and use the latest session-wide name", () => {
	const sm = SessionManager.inMemory();
	const root = user(sm, "fallback title");
	sm.appendSessionInfo("Old title");
	sm.appendSessionInfo("Latest title - Clone");
	sm.branch(root);
	assert.equal(branchName(sourceName(sm), "Fork"), "Latest title - Fork");
	assert.equal(branchName("Title - Fork - Clone", "Clone"), "Title - Clone");
	assert.equal(branchName("x".repeat(300), "Clone").length, 200);
});

test("checkpoint excludes active prompt, answered tools and steering", () => {
	const sm = SessionManager.inMemory();
	user(sm, "completed prompt");
	const base = sm.appendCustomEntry("checkpoint", {});
	user(sm, "running prompt");
	sm.appendCustomEntry("completed tool step", {});
	user(sm, "steering prompt");
	assert.equal(beforeRun(sm, { runBaseLeafId: base }), base);
	assert.equal(beforeRun(sm, { runBaseLeafId: "missing" }), undefined);
	assert.equal(beforeRun(sm, { runBaseLeafId: null }), null);
});

test("adopted agent uses first prompt since launch, not latest steering", () => {
	const sm = SessionManager.inMemory();
	user(sm, "completed");
	const base = sm.appendCustomEntry("checkpoint", {});
	const started = Date.parse(sm.getLeafEntry()!.timestamp);
	user(sm, "running");
	user(sm, "steering");
	// The completed user must be strictly before launch in this fixture.
	const first = sm.getEntries()[0];
	first.timestamp = new Date(started - 1000).toISOString();
	assert.equal(beforeRun(sm, { runStartedAt: started }), base);
});

test("disk not yet containing prompt can still clone its full stable tip", () => {
	const sm = SessionManager.inMemory();
	user(sm, "previous prompt");
	const base = sm.appendCustomEntry("finished", {});
	assert.equal(beforeRun(sm, { runStartedAt: Date.now() + 1000 }), base);
});

test("explicit history differs from a stale but locally current snapshot", () => {
	const sm = SessionManager.inMemory();
	const root = user(sm, "old prompt");
	user(sm, "new prompt");
	assert.equal(selectedHistory(sm), false);
	sm.branch(root);
	assert.equal(selectedHistory(sm), true);
	sm.appendCustomEntry("pi-kit.tree-position", {});
	assert.equal(selectedHistory(sm), true);
});
