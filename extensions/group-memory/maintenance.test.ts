import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InboxGroups } from "../inbox/groups.ts";
import groupMemory from "./index.ts";
import { groupTag } from "./memory.ts";

const runner = process.env.BIGBRAIN_MAINT_RUNNER || join(
	homedir(), ".pi", "agent", "bigbrain", "bigbrain-maintenance-direct.mjs",
);

const fakePi = `
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const handlers = new Map();
const loaded = [];
const pi = {
  on(name, handler) { handlers.set(name, handler); },
  registerCommand() {},
  getAllTools() { return []; },
};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== "--extension") continue;
  const path = process.argv[++i];
  loaded.push(path);
  const extension = await import(pathToFileURL(path).href);
  extension.default(pi);
}
const ctx = {
  hasUI: false,
  sessionManager: { getSessionId: () => "unrelated-worker-id" },
};
await handlers.get("session_start")?.({}, ctx);
const event = {
  prompt: "maintenance",
  systemPromptOptions: { promptGuidelines: [] },
};
await handlers.get("before_agent_start")?.(event, ctx);
const input = { topic: "Fixture", content: "No real write occurs." };
await handlers.get("tool_call")?.({
  toolName: "memory_store", input,
}, ctx);
writeFileSync(process.env.PI_GROUP_TEST_OUT, JSON.stringify({
  loaded, tags: input.tags, snapshot: process.env.PI_BIGBRAIN_GROUP_SNAPSHOT,
  inheritedSession: process.env.PI_SESSION_ID,
}));
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text: "STORED fixture" }],
    usage: { input: 0, output: 0 }, stopReason: "stop",
  } }));
});
`;

test("real maintenance runner loads bridge and retains captured group", {
	skip: !existsSync(runner) && "bigbrain Pi runner is not installed",
}, async t => {
	const dir = mkdtempSync(join(tmpdir(), "pi-group-worker-test-"));
	const keys = [
		"PI_CODING_AGENT_DIR", "BIGBRAIN_MAINT",
		"BIGBRAIN_MAINT_PI_EXTENSIONS", "PI_BIGBRAIN_GROUP_SNAPSHOT",
	];
	const env = new Map(keys.map(key => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = dir;
	const groups = new InboxGroups(dir);
	const original = await groups.create("Original group");
	const moved = await groups.create("Moved later");
	await groups.assign("parent-session", original.id);
	const handlers = new Map<string, (...args: any[]) => any>();
	groupMemory({
		on(name: string, handler: (...args: any[]) => any) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		getAllTools() { return []; },
	} as unknown as ExtensionAPI);
	const ctx = {
		hasUI: false,
		sessionManager: { getSessionId: () => "parent-session" },
	};
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		for (const [key, value] of env) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("agent_end")?.({}, ctx);
	// A detached pass must keep the snapshot, not read the parent's new group.
	await groups.assign("parent-session", moved.id);
	const cli = join(dir, "fake-pi.mjs");
	const native = join(dir, "fake-bigbrain.mjs");
	const output = join(dir, "captured.json");
	const payload = join(dir, "payload.json");
	writeFileSync(cli, fakePi);
	writeFileSync(native, "export default function () {}\n");
	writeFileSync(payload, JSON.stringify({
		session_id: "parent-session", turn_text: "fixture turn",
		pi_node: process.execPath, pi_cli: cli, pi_extension: native,
	}));
	await promisify(execFile)(process.execPath, [runner, payload], {
		env: {
			// Inherit the bridge, not unrelated credentials/provider extensions.
			PATH: process.env.PATH, HOME: process.env.HOME,
			TMPDIR: process.env.TMPDIR, PI_CODING_AGENT_DIR: dir,
			BIGBRAIN_MAINT_PI_EXTENSIONS:
				process.env.BIGBRAIN_MAINT_PI_EXTENSIONS,
			PI_BIGBRAIN_GROUP_SNAPSHOT:
				process.env.PI_BIGBRAIN_GROUP_SNAPSHOT,
			NODE_OPTIONS: "--experimental-transform-types",
			NODE_NO_WARNINGS: "1",
			BIGBRAIN_MAINT: "1", BIGBRAIN_MAINT_PROVIDER: "pi",
			BIGBRAIN_MAINT_PI_EXTENSION: native,
			BIGBRAIN_ENV_FILE: join(dir, "absent-env"),
			BIGBRAIN_MAINT_LOG: join(dir, "maintenance.log"),
			BIGBRAIN_MAINT_DRYRUN: "",
			PI_GROUP_TEST_OUT: output, PI_SESSION_ID: "parent-session",
		},
		timeout: 15_000,
	}).catch(error => {
		const log = join(dir, "maintenance.log");
		throw new Error(`${error}\n${existsSync(log)
			? readFileSync(log, "utf8") : "No maintenance log"}`);
	});
	const captured = JSON.parse(readFileSync(output, "utf8"));
	assert.deepEqual(captured.tags, [groupTag(original)]);
	assert.ok(captured.loaded.some((path: string) =>
		path.endsWith("/group-memory/index.ts")));
	assert.equal(captured.inheritedSession, undefined);
	assert.equal(JSON.parse(captured.snapshot).id, original.id);
	assert.match(readFileSync(join(dir, "maintenance.log"), "utf8"),
		/ok .*STORED fixture/);
	assert.equal(existsSync(payload), false);
});
