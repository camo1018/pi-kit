import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, mock, test } from "node:test";

// Isolate runner state before its module-level agent directory is resolved.
const dir = fs.mkdtempSync(join(tmpdir(), "pi-runner-test-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const runner = await import("./inbox-agents.ts");
after(() => {
	if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldDir;
	fs.rmSync(dir, { recursive: true, force: true });
});

test("worker extension paths reach the subprocess and durable registry", async (t) => {
	let argv: readonly string[] = [];
	let input = "";
	const children: ChildProcess[] = [];
	mock.method(
		childProcess,
		"spawn",
		(_command: string, args: readonly string[]) => {
			argv = args;
			const child = new EventEmitter() as ChildProcess;
			const stdin = new PassThrough();
			stdin.on("data", (chunk) => {
				input += chunk.toString();
			});
			Object.assign(child, {
				pid: 123456789,
				stdin,
				unref() {},
				kill() {
					return true;
				},
			});
			children.push(child);
			return child;
		},
	);
	syncBuiltinESMExports();
	t.after(() => {
		mock.restoreAll();
		syncBuiltinESMExports();
		runner.registry().agents.clear();
	});
	const extension = "/feature/extension/index.ts";
	const agent = runner.spawnAgent({
		id: "test-worker",
		title: "Worker",
		cwd: dir,
		prompt: "@starts-with-mention remains prompt text",
		extensionPaths: [extension],
	});
	assert.equal(argv[argv.indexOf("--extension") + 1], extension);
	assert.equal(
		argv.includes("@starts-with-mention remains prompt text"),
		false,
	);
	assert.equal(input, "@starts-with-mention remains prompt text");
	const saved = JSON.parse(
		fs.readFileSync(join(dir, "inbox-agents", "test-worker.json"), "utf8"),
	);
	assert.deepEqual(saved.extensionPaths, [extension]);
	assert.deepEqual(agent.extensionPaths, [extension]);
	children[0].emit("exit", 0);
	// The runner monitor reconciles exit before clearing its resources.
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(agent.proc, undefined);
	assert.equal(agent.state, "idle");
	// A completed run removes runner metadata; the team supplies paths again.
	runner.registry().agents.delete(agent.id);
	const resumed = runner.sendToAgent({
		id: agent.id,
		cwd: dir,
		title: "Worker",
		text: "Follow up",
		extensionPaths: [extension],
	});
	assert.equal(argv[argv.indexOf("--extension") + 1], extension);
	assert.deepEqual(resumed.extensionPaths, [extension]);
	children[1].emit("exit", 0);
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(resumed.proc, undefined);
});
