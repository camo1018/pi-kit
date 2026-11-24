import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pi-questions-"));
const oldState = process.env.JIRA_AUTOPILOT_STATE;
process.env.JIRA_AUTOPILOT_STATE = home;

const { readQuestions, openCount, wrap, writeAnswer } = await import("./index.ts");

after(() => {
	if (oldState === undefined) delete process.env.JIRA_AUTOPILOT_STATE;
	else process.env.JIRA_AUTOPILOT_STATE = oldState;
	rmSync(home, { recursive: true, force: true });
});

function writeQ(name: string, q: Record<string, unknown>) {
	writeFileSync(join(home, "questions", name), JSON.stringify(q));
}

test("no directory is an empty list, not an error", () => {
	assert.deepEqual(readQuestions(), []);
	assert.equal(openCount(), 0);
});

test("open questions sort before answered ones", () => {
	const dir = join(home, "questions");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeQ("CONS-2.json", { key: "CONS-2", title: "b", asked: "2", decision: "d", context: "c", options: [], state: "open" });
	writeQ("CONS-1.json", { key: "CONS-1", title: "a", asked: "1", decision: "d", context: "c", options: [], state: "answered", answeredAt: Date.now() });
	const got = readQuestions();
	assert.deepEqual(got.map((q) => q.key), ["CONS-2", "CONS-1"]);
	assert.equal(openCount(), 1);
});

test("an answered question past retention is deleted on read", () => {
	const dir = join(home, "questions");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeQ("OLD-1.json", {
		key: "OLD-1", title: "old", asked: "1", decision: "d", context: "c", options: [],
		state: "answered", answeredAt: Date.now() - 1000 * 60 * 60 * 24,
	});
	assert.deepEqual(readQuestions(), []);
	assert.equal(readdirSync(dir).includes("OLD-1.json"), false);
});

test("a corrupt record is skipped, not fatal", () => {
	const dir = join(home, "questions");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "BAD.json"), "{not json");
	writeQ("OK-1.json", { key: "OK-1", title: "ok", asked: "1", decision: "d", context: "c", options: [], state: "open" });
	const got = readQuestions();
	assert.deepEqual(got.map((q) => q.key), ["OK-1"]);
});

test("wrap keeps lines within the width", () => {
	const lines = wrap("a ".repeat(120).trim(), 20);
	assert.ok(lines.length > 1);
	for (const l of lines) assert.ok(l.length <= 20, `too long: ${l.length}`);
});

// ── answering ────────────────────────────────────────────────────────────────
// The list writes an answer record; the runner reads it. Getting this wrong
// silently loses a decision, so pin the file format.


test("writeAnswer flips a record to answered with the text and a timestamp", () => {
	const dir = join(home, "questions");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const q = {
		key: "CONS-9", title: "t", asked: "1", decision: "d", context: "c",
		options: [], state: "open" as const,
	};
	writeQ("CONS-9.json", q);
	writeAnswer(q, "B");
	const got = JSON.parse(readFileSync(join(dir, "CONS-9.json"), "utf-8"));
	assert.equal(got.state, "answered");
	assert.equal(got.answer, "B");
	assert.equal(typeof got.answeredAt, "number");
	// Preserved fields: the runner needs the rest of the record intact.
	assert.equal(got.decision, "d");
	assert.equal(got.key, "CONS-9");
});

test("an answered question drops out of the open count", () => {
	const dir = join(home, "questions");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const q = {
		key: "CONS-8", title: "t", asked: "1", decision: "d", context: "c",
		options: [], state: "open" as const,
	};
	writeQ("CONS-8.json", q);
	assert.equal(openCount(), 1);
	writeAnswer(q, "A");
	assert.equal(openCount(), 0);
	assert.equal(readQuestions().length, 1, "answered stays visible for the retention window");
});

// ---- multi-source (jira + pr-review-autopilot) -----------------------------
// The dangerous failure here is a PR answer landing in the Jira dir, where the
// Jira runner would read someone's "approve with nits" as a design decision.

const prHome = mkdtempSync(join(tmpdir(), "pi-questions-pr-"));
const oldPrState = process.env.PR_AUTOPILOT_STATE;
process.env.PR_AUTOPILOT_STATE = prHome;

after(() => {
	if (oldPrState === undefined) delete process.env.PR_AUTOPILOT_STATE;
	else process.env.PR_AUTOPILOT_STATE = oldPrState;
	rmSync(prHome, { recursive: true, force: true });
});

function writeAt(base: string, dirName: string, name: string, q: Record<string, unknown>) {
	mkdirSync(join(base, dirName), { recursive: true });
	writeFileSync(join(base, dirName, name), JSON.stringify(q));
}

test("questions from both producers are read, and each carries its source", () => {
	const jiraDir = join(home, "questions");
	const prDir = join(prHome, "questions");
	rmSync(jiraDir, { recursive: true, force: true });
	rmSync(prDir, { recursive: true, force: true });

	writeAt(home, "questions", "CONS-9.json", {
		key: "CONS-9", title: "j", asked: "1", decision: "jd", context: "c",
		options: [], state: "open",
	});
	writeAt(prHome, "questions", "example-repo#278.json", {
		key: "example-repo#278", title: "p", asked: "2", decision: "pd",
		context: "c", options: [], state: "open",
	});

	const got = readQuestions();
	assert.equal(got.length, 2);
	const byKey = Object.fromEntries(got.map((q) => [q.key, q]));
	assert.equal(byKey["CONS-9"].source, "jira");
	assert.equal(byKey["example-repo#278"].source, "pr");
	assert.equal(openCount(), 2);
});

test("writeAnswer writes back to the record's OWN directory, not the jira dir", () => {
	const jiraDir = join(home, "questions");
	const prDir = join(prHome, "questions");
	rmSync(jiraDir, { recursive: true, force: true });
	rmSync(prDir, { recursive: true, force: true });

	writeAt(prHome, "questions", "example-repo#278.json", {
		key: "example-repo#278", title: "p", asked: "1", decision: "pd",
		context: "c", options: [{ id: "A", text: "t" }], state: "open",
	});
	const q = readQuestions().find((x) => x.key === "example-repo#278");
	assert.ok(q, "question should be readable");
	writeAnswer(q, "A");

	// The answer landed in the PR dir...
	const prRec = JSON.parse(readFileSync(join(prDir, "example-repo#278.json"), "utf-8"));
	assert.equal(prRec.state, "answered");
	assert.equal(prRec.answer, "A");
	// ...and NOT in the jira dir, where the wrong runner would consume it.
	let jiraFiles: string[] = [];
	try {
		jiraFiles = readdirSync(jiraDir).filter((n) => n.endsWith(".json"));
	} catch {
		jiraFiles = [];
	}
	assert.deepEqual(jiraFiles, [], "no PR answer may be filed under the jira producer");
});

test("a resolved record is neither listed nor counted", () => {
	const prDir = join(prHome, "questions");
	rmSync(prDir, { recursive: true, force: true });
	writeAt(prHome, "questions", "X#1.json", {
		key: "X#1", title: "t", asked: "1", decision: "d", context: "c",
		options: [], state: "resolved",
	});
	assert.equal(readQuestions().filter((q) => q.key === "X#1").length, 0);
	assert.equal(openCount(), 0);
});
