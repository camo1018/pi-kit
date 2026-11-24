import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { staleAgainstDisk, lastEntryIdOnDisk, pinnedLeafFor, shouldPinLeaf } from "./session-stale.ts";

const dir = mkdtempSync(join(tmpdir(), "stale-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function build(name: string) {
	const f = join(dir, name);
	writeFileSync(f, "");
	const w = (o: any) => appendFileSync(f, JSON.stringify(o) + "\n");
	w({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });
	w({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "root" }] } });
	w({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } });
	return { f, w };
}

test("a session nobody else touched is not stale", () => {
	const { f } = build("clean.jsonl");
	const sm = SessionManager.open(f);
	assert.equal(staleAgainstDisk(sm, f).stale, false);
});

test("a tip this process never saw is stale", () => {
	const { f, w } = build("moved.jsonl");
	const sm = SessionManager.open(f); // holds a1
	w({ type: "message", id: "x1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "phone" }] } });
	const c = staleAgainstDisk(sm, f);
	assert.equal(c.stale, true);
	assert.equal(c.diskLastId, "x1");
	assert.equal(c.memoryLeafId, "a1");
});

test("our own navigation away from the tip is not staleness", () => {
	// The whole point: a KNOWN tip with a different in-memory leaf is a
	// deliberate /tree position, never another writer's entry.
	const { f } = build("nav.jsonl");
	const sm = SessionManager.open(f);
	sm.branch("u1");
	const c = staleAgainstDisk(sm, f);
	assert.equal(c.stale, false, "a known last line is never a foreign tip");
	assert.equal(c.memoryLeafId, "u1");
	assert.equal(c.diskLastId, "a1");
});

test("an unreadable tail is unknown, not stale", () => {
	const { f } = build("gone.jsonl");
	const sm = SessionManager.open(f);
	assert.equal(staleAgainstDisk(sm, f + ".missing").stale, false);
	assert.equal(lastEntryIdOnDisk(f + ".missing"), undefined);
});

test("resuming after a mid-turn sibling fork reports stale, and a reload clears it", () => {	// Models the real failure: our writer appended a toolResult against a leaf
	// that another writer had already moved past, so the file now ends on a
	// shallow sibling. A fresh open is NOT stale (it knows the whole file), but
	// the process that was holding the old leaf is.
	const { f, w } = build("fork.jsonl");
	const held = SessionManager.open(f); // leaf a1
	// another writer advances the tip
	w({ type: "message", id: "p1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "phone" }] } });
	// our stale writer appends to a1 anyway -> sibling
	w({ type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "toolResult", content: [{ type: "text", text: "late" }] } });
	assert.equal(staleAgainstDisk(held, f).stale, true, "held leaf is behind the file");
	// resync == reopen the file; the new process knows every entry
	assert.equal(staleAgainstDisk(SessionManager.open(f), f).stale, false);
});

test("a fresh sender pins the branch on screen", () => {
	// The case the pin exists for: `/tree` to an older branch, then type.
	const { f } = build("pin-nav.jsonl");
	const sm = SessionManager.open(f);
	sm.branch("u1"); // deliberate navigation away from the tip
	const picked = pinnedLeafFor(sm, f);
	assert.equal(picked.leaf, "u1", "the viewed branch is the pin");
	assert.equal(picked.tip, "a1", "captured against the tip that is still there");
	// spawn time: `run()` opens the file FRESH, so its leaf is the disk tip --
	// not the navigated leaf the sender held in memory. Nothing has moved, so the
	// marker is written and the child resumes on the branch on screen.
	const atSpawn = SessionManager.open(f);
	assert.equal(atSpawn.getLeafId(), "a1");
	assert.equal(
		shouldPinLeaf(atSpawn, { leaf: picked.leaf, capturedTip: picked.tip }),
		true,
	);
});

test("a queued reply from a stale window pins the disk tip, not its stale leaf", () => {
	// The regression: a reply typed while a run is writing captures the host's
	// in-memory leaf, which that run has already written past. Pinning it later
	// branches the transcript back and strands the run's entries on a dead
	// sibling -- the "queueing starts a new branch" symptom.
	const { f, w } = build("pin-stale.jsonl");
	const host = SessionManager.open(f); // leaf a1
	w({ type: "message", id: "p1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "run" }] } });
	const picked = pinnedLeafFor(host, f);
	assert.equal(picked.leaf, "p1", "continue where the file actually is");
	assert.equal(picked.tip, "p1");
	// The spawn opens the file again; the tip still ends where it was captured,
	// so no marker is needed -- an ordinary send.
	const fresh = SessionManager.open(f);
	assert.equal(fresh.getLeafId(), picked.tip);
	assert.equal(
		shouldPinLeaf(fresh, { leaf: picked.leaf, capturedTip: picked.tip }),
		false,
		"the pin equals the tip, so no marker",
	);
});

test("a pin whose tip moved while the message sat in the queue is dropped", () => {
	// A message can wait in `pending` behind a whole run. By spawn time the file
	// has grown past the tip captured at send time, so the captured leaf is an
	// ancestor and pinning it would fork. Continuing the tip is always right here,
	// because a deliberate `/tree` never moves the tip.
	const { f, w } = build("pin-moved.jsonl");
	const sm = SessionManager.open(f);
	sm.branch("u1"); // navigated to u1; tip is still a1
	const picked = pinnedLeafFor(sm, f);
	assert.equal(picked.leaf, "u1");
	assert.equal(picked.tip, "a1");
	// the in-flight run keeps writing
	w({ type: "message", id: "p2", parentId: "a1", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "user", content: [{ type: "text", text: "next" }] } });
	const atSpawn = SessionManager.open(f);
	assert.equal(
		shouldPinLeaf(atSpawn, { leaf: picked.leaf, capturedTip: picked.tip }),
		false,
		"the tip moved, so the captured leaf is stale",
	);
});

test("no captured tip means no pin", () => {
	// Cannot tell where the sender stood, and a wrong pin forks the tree, so the
	// child's normal resume point wins.
	const { f } = build("pin-unknown.jsonl");
	const sm = SessionManager.open(f);
	sm.branch("u1");
	assert.equal(shouldPinLeaf(sm, { leaf: "u1" }), false);
	assert.equal(shouldPinLeaf(sm, { leaf: "u1", capturedTip: undefined }), false);
});

test("a pin for an entry the session does not have is dropped", () => {
	const { f } = build("pin-ghost.jsonl");
	const sm = SessionManager.open(f);
	assert.equal(
		shouldPinLeaf(sm, { leaf: "nope", capturedTip: sm.getLeafId() ?? undefined }),
		false,
	);
});
