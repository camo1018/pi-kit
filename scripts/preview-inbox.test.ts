import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "inbox-preview-launch-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("preview ignores PATH wrappers and preserves caller state", async (t) => {
	const dir = fixture(t);
	const wrapper = join(dir, "pi");
	writeFileSync(wrapper,
		"#!/bin/sh\necho PATH_PI_WRAPPER_CALLED >&2\nexit 99\n");
	chmodSync(wrapper, 0o755);
	const config = join(dir, "settings.json");
	const original = '{"packages":[],"previewTestSentinel":true}';
	writeFileSync(config, original);
	const { stdout, stderr } = await execute(
		join(root, "scripts/preview-inbox.sh"), ["--help"], {
			cwd: root,
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				PI_CODING_AGENT_DIR: dir,
			},
		},
	);
	assert.doesNotMatch(stdout + stderr, /PATH_PI_WRAPPER_CALLED/);
	assert.match(stdout, /node_modules\/\.bin\/pi/);
	assert.match(stdout, /--orchestrator/);
	assert.equal(readFileSync(config, "utf8"), original);
	const state = stdout.match(/temporary state at ([^\r\n]+)/)?.[1];
	assert.ok(state);
	assert.equal(existsSync(state), false, "the preview should clean up");
});

test("preview guard aborts on a directory mismatch", async (t) => {
	const dir = fixture(t);
	await assert.rejects(execute(join(root, "node_modules/.bin/pi"), [
		"--no-extensions", "-e", join(root, "scripts/inbox-preview.ts"),
		"--help",
	], {
		cwd: root,
		env: {
			...process.env, PI_OFFLINE: "1",
			PI_CODING_AGENT_DIR: dir,
			PI_INBOX_PREVIEW_DIR: join(dir, "not-the-actual-directory"),
		},
	}), (error: any) => {
		assert.equal(error.code, 78);
		assert.match(error.stderr, /Preview refused to start/);
		return true;
	});
	assert.equal(existsSync(join(dir, "inbox-live")), false);
	assert.equal(existsSync(join(dir, "inbox-agents")), false);
});
