import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import trial from "./session-workers-trial.ts";

function fixture(t: TestContext) {
	const keys = [
		"PI_CODING_AGENT_DIR",
		"PI_WORKERS_TRIAL_DIR",
		"PI_WORKERS_TRIAL_BIGBRAIN",
	];
	const old = keys.map((key) => process.env[key]);
	const dir = mkdtempSync(join(tmpdir(), "pi-trial-guard-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_WORKERS_TRIAL_DIR = dir;
	const extension = join(dir, "bigbrain-fixture.mjs");
	// Bridge boundary: avoid real memory requests or maintenance processes.
	writeFileSync(
		extension,
		[
			"export default function(pi) {",
			"pi.on('agent_settled', () => {});",
			"pi.on('context', () => {});",
			"for (const name of ['memory_recall', 'memory_get', 'memory_store',",
			"'memory_update', 'memory_delete']) pi.registerTool({ name });",
			"}",
		].join("\n"),
	);
	process.env.PI_WORKERS_TRIAL_BIGBRAIN = extension;
	const handlers = new Map<string, unknown>();
	const tools: string[] = [];
	const pi = {
		on(name: string, handler: unknown) {
			handlers.set(name, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool.name);
		},
	} as unknown as ExtensionAPI;
	t.after(() => {
		keys.forEach((key, index) => {
			if (old[index] === undefined) delete process.env[key];
			else process.env[key] = old[index];
		});
		rmSync(dir, { recursive: true, force: true });
	});
	const call = (name: string, input: Record<string, unknown> = {}) => {
		const handler = handlers.get("tool_call") as (event: {
			toolName: string;
			input: Record<string, unknown>;
		}) => { block: boolean; reason: string } | undefined;
		return handler({ toolName: name, input });
	};
	return { pi, dir, tools, handlers, call };
}

test("trial refuses a mismatched profile before registering tools", async (t) => {
	const s = fixture(t);
	process.env.PI_WORKERS_TRIAL_DIR = join(s.dir, "wrong-directory");
	await assert.rejects(trial(s.pi), /isolated agent directory/);
	assert.equal(s.tools.length, 0);
});

test("trial exposes read-only memory and suppresses maintenance", async (t) => {
	const s = fixture(t);
	await trial(s.pi);
	assert.deepEqual(s.tools, ["memory_recall", "memory_get"]);
	assert.equal(s.handlers.has("agent_settled"), false);
	assert.equal(s.handlers.has("context"), true);
	assert.equal(s.call("memory_recall"), undefined);
	assert.equal(s.call("memory_store")?.block, true);
	assert.equal(s.call("bash")?.block, true);
	assert.equal(s.call("read", { path: "inputs/worker-a.md" }), undefined);
	assert.equal(s.call("read", { path: "../secret" })?.block, true);
});

test("trial caps worker creation without blocking note sharing", async (t) => {
	const s = fixture(t);
	await trial(s.pi);
	assert.equal(s.call("session_workers", { action: "spawn" }), undefined);
	const dir = join(s.dir, "session-workers", "workers");
	mkdirSync(dir, { recursive: true });
	for (const name of ["a.json", "b.json"]) {
		writeFileSync(join(dir, name), "{}");
	}
	assert.equal(s.call("session_workers", { action: "spawn" })?.block, true);
	assert.equal(s.call("session_workers", { action: "share" }), undefined);
	assert.equal(s.call("session_workers", { action: "send" }), undefined);
});

test("launcher cancels leftover queues when a trial is incomplete", async (t) => {
	const s = fixture(t);
	const runtime = join(s.dir, "fake-pi");
	// Runtime boundary: don't launch a real model or detached worker.
	writeFileSync(
		runtime,
		[
			"#!/usr/bin/env python3",
			"import json, os, pathlib",
			"root = pathlib.Path(os.environ['PI_CODING_AGENT_DIR'])",
			"agents = root / 'inbox-agents'",
			"agents.mkdir()",
			"(agents / 'queued-worker.json').write_text(json.dumps({",
			"'id': 'queued-worker', 'state': 'queued', 'pending': ['do not run']",
			"}))",
		].join("\n"),
	);
	chmodSync(runtime, 0o755);
	const provider = join(s.dir, "example-provider.ts");
	writeFileSync(provider, "export default function () {}\n");
	const script = fileURLToPath(
		new URL("./try-session-workers.sh", import.meta.url),
	);
	let state: string | undefined;
	await assert.rejects(
		promisify(execFile)(script, [], {
			env: {
				...process.env,
				PI_WORKERS_TRIAL_RUNTIME: runtime,
				PI_WORKERS_TRIAL_MODEL: "test/model:low",
				PI_WORKERS_TRIAL_PROVIDER_EXTENSION: provider,
			},
		}),
		(error: unknown) => {
			const result = error as { code: number; stdout: string };
			assert.equal(result.code, 1);
			state = result.stdout.match(/Worker trial state: ([^\r\n]+)/)?.[1];
			return true;
		},
	);
	assert.ok(state);
	const profile = state;
	t.after(() => rmSync(profile, { recursive: true, force: true }));
	const settings = JSON.parse(
		readFileSync(join(profile, "settings.json"), "utf8"),
	);
	assert.ok(settings.extensions.includes(provider));
	const dir = join(profile, "inbox-agents");
	const agent = JSON.parse(
		readFileSync(join(dir, "queued-worker.json"), "utf8"),
	);
	assert.deepEqual(agent.pending, []);
	assert.equal(agent.state, "cancelled");
	assert.equal(
		readFileSync(join(dir, "queued-worker.stop"), "utf8"),
		"trial ended",
	);
});

test("launcher requires a model before allocating trial state", async () => {
	const script = fileURLToPath(
		new URL("./try-session-workers.sh", import.meta.url),
	);
	await assert.rejects(
		promisify(execFile)(script, [], {
			env: {
				...process.env,
				PI_WORKERS_TRIAL_RUNTIME: process.execPath,
				PI_WORKERS_TRIAL_MODEL: "",
			},
		}),
		(error: unknown) => {
			const result = error as {
				code: number;
				stdout: string;
				stderr: string;
			};
			assert.equal(result.code, 1);
			assert.match(result.stderr, /Set PI_WORKERS_TRIAL_MODEL/);
			assert.doesNotMatch(result.stdout, /Worker trial state/);
			return true;
		},
	);
});
