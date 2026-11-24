import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";

// Isolate BEFORE importing the addon.
const home = mkdtempSync(join(tmpdir(), "pi-sync-"));
process.env.JIRA_AUTOPILOT_STATE = home;
process.env.PR_AUTOPILOT_STATE = join(home, "pr");

const iso = await import("./index.ts");
const SYNC = "/Users/ppark/.config/jira-autopilot/inbox_sync.py";

function seed() {
	const qdir = join(home, "questions");
	mkdirSync(qdir, { recursive: true });
	writeFileSync(join(home, "questions.md"), `# questions

## TICKET-7 — a title
Asked: 2026-01-01T00:00:00-08:00
**Status:** OPEN

**Decision needed:** pick one

**Options:**
- A: alpha
- B: beta

**Answer:** <fill in: A, B, or other + why>
`);
	writeFileSync(join(qdir, "TICKET-7.json"), JSON.stringify({
		key: "TICKET-7", title: "a title", asked: "2026-01-01T00:00:00-08:00",
		decision: "pick one", context: "", options: [], state: "open",
	}, null, 1));
}

test("an in-list answer writes the markdown too, so sync keeps it", () => {
	seed();
	const q = iso.readQuestions().find((x) => x.key === "TICKET-7");
	assert.ok(q);
	iso.writeAnswer(q!, "B");
	// markdown mirrored
	const md = readFileSync(join(home, "questions.md"), "utf-8");
	assert.match(md, /\*\*Answer:\*\* B/, "answer should be mirrored into questions.md");
	// and sync must not revert it
	execFileSync("python3", [SYNC, "sync"], {
		env: { ...process.env, JIRA_AUTOPILOT_STATE: home },
	});
	assert.equal(iso.openCount(), 0, "answer must survive sync");
});

test("a lone answered JSON record is NOT trusted over open markdown", () => {
	seed();
	const qdir = join(home, "questions");
	// Simulate a stale/test-written record: answered in JSON, open in markdown.
	writeFileSync(join(qdir, "TICKET-7.json"), JSON.stringify({
		key: "TICKET-7", title: "a title", asked: "2026-01-01T00:00:00-08:00",
		decision: "pick one", context: "", options: [],
		state: "answered", answer: "A", answeredAt: Date.now(),
	}, null, 1));
	execFileSync("python3", [SYNC, "sync"], {
		env: { ...process.env, JIRA_AUTOPILOT_STATE: home },
	});
	assert.equal(iso.openCount(), 1, "markdown being open must win");
});
