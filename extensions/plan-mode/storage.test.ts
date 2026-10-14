import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { savePlanFile } from "./storage.ts";

async function tempPlans(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-plan-mode-"));
}

test("saves a readable, project-scoped Markdown plan", async (t) => {
	const rootDir = await tempPlans();
	t.after(() => rm(rootDir, { recursive: true, force: true }));

	const path = await savePlanFile({
		cwd: "/work/My Project",
		planText: "Plan:\n1. Inspect the service\n2. Add the new behavior",
		sessionId: "abcdef1234567890",
		title: "Inspect the service",
		now: new Date("2026-01-02T03:04:05.678Z"),
		rootDir,
	});

	assert.equal(
		path,
		join(
			rootDir,
			"my-project",
			"2026-01-02T03-04-05-678Z-inspect-the-service-abcdef12.md",
		),
	);
	const content = await readFile(path, "utf8");
	assert.match(content, /^# Plan: Inspect the service/m);
	assert.match(content, /- Created: 2026-01-02T03:04:05.678Z/);
	assert.match(content, /- Project: `\/work\/My Project`/);
	assert.match(content, /- Session: `abcdef1234567890`/);
	assert.match(content, /## Steps\n\n1\. Inspect the service/);
	assert.doesNotMatch(content, /## Steps\n\nPlan:/);
});

test("does not overwrite a plan with the same generated name", async (t) => {
	const rootDir = await tempPlans();
	t.after(() => rm(rootDir, { recursive: true, force: true }));
	const options = {
		cwd: "/work/project",
		planText: "Plan:\n1. Keep both generated plans",
		sessionId: "session-123",
		title: "Keep both generated plans",
		now: new Date("2026-01-02T03:04:05.678Z"),
		rootDir,
	};

	const first = await savePlanFile(options);
	const second = await savePlanFile(options);

	assert.notEqual(first, second);
	assert.match(second, /-2\.md$/);
});
