import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { staleAgainstDisk, lastEntryIdOnDisk } from "./session-stale.ts";

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

test("resuming after a mid-turn sibling fork reports stale, and a reload clears it", () => {
	// Models the real failure: our writer appended a toolResult against a leaf
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
