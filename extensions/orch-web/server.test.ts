/**
 * orch-web: the parts worth testing without a running pi.
 *
 * The row model and the transcript/title readers are pure functions of the
 * agent dir, so they are exercised against a throwaway HOME here. Network and
 * spawn behaviour is verified by hand (see README); spawning a real run in a
 * unit test would need a provider.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// getAgentDir() consults the environment, so point HOME at a scratch tree
// before importing anything that reads it at module load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-web-"));
process.env.HOME = home;
const agentDir = path.join(home, ".pi", "agent");
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });

const { buildRows, eventBytes, firstUserText, lanAddress, liveItems,
	modelChoices, readLinesAt, readName, readTail, sanitizeForLog } =
	await import("./server.ts");

function writeSession(opts: {
	id: string;
	cwd?: string;
	messages: any[];
	name?: string;
	/** Prepend a large non-message entry, like a pasted context blob. */
	pad?: number;
}) {
	const dir = path.join(agentDir, "sessions", "--scratch--");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${opts.id}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: opts.id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: opts.cwd ?? "/scratch",
		}),
	];
	if (opts.pad) {
		lines.push(
			JSON.stringify({
				type: "custom",
				id: "pad",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				payload: "x".repeat(opts.pad),
			}),
		);
	}
	if (opts.name) {
		lines.push(
			JSON.stringify({
				type: "session_info",
				id: "n",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				name: opts.name,
			}),
		);
	}
	opts.messages.forEach((message, i) => {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `m${i}`,
				parentId: i ? `m${i - 1}` : null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message,
			}),
		);
	});
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

const user = (text: string) => ({
	role: "user",
	content: [{ type: "text", text }],
});
const assistant = (text: string, extra: any = {}) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	...extra,
});

test("titles come from the first user message, past a large leading entry", () => {
	const file = writeSession({
		id: "a0000001-0000-0000-0000-000000000001",
		pad: 200 * 1024,
		messages: [user("Fix the flaky test"), assistant("Done.")],
	});
	assert.equal(firstUserText(file), "Fix the flaky test");
});

test("titles fall back to an explicit session name", () => {
	writeSession({
		id: "a0000002-0000-0000-0000-000000000002",
		name: "Review PR 123",
		messages: [user("something else"), assistant("ok")],
	});
	const row = buildRows().rows.find((r) => r.title === "Review PR 123");
	assert.ok(row, "row should carry the session name");
});

test("tail status: your turn, error and aborted", () => {
	const done = writeSession({
		id: "a0000003-0000-0000-0000-000000000003",
		messages: [user("hi"), assistant("hello")],
	});
	assert.equal(readTail(done).status, "your-turn");

	const errored = writeSession({
		id: "a0000004-0000-0000-0000-000000000004",
		messages: [user("hi"), assistant("", { stopReason: "error" })],
	});
	assert.equal(readTail(errored).status, "error");

	const aborted = writeSession({
		id: "a0000005-0000-0000-0000-000000000005",
		messages: [user("hi"), assistant("", { stopReason: "aborted" })],
	});
	assert.equal(readTail(aborted).status, "aborted");
});

test("a turn cut off on a tool call reads as stalled, not your turn", () => {
	const file = writeSession({
		id: "a0000006-0000-0000-0000-000000000006",
		messages: [
			user("go"),
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "t", name: "bash", arguments: { command: "ls" } },
				],
				stopReason: "toolUse",
			},
		],
	});
	assert.equal(readTail(file).status, "stalled");
});

test("rows expose the last thing said, per role", () => {
	writeSession({
		id: "a0000007-0000-0000-0000-000000000007",
		messages: [user("first"), assistant("answer"), user("second")],
	});
	const row = buildRows().rows.find(
		(r) => r.id === "a0000007-0000-0000-0000-000000000007",
	);
	assert.equal(row?.lastSaid?.role, "user");
	assert.equal(row?.lastSaid?.text, "second");
});

test("archived sessions are hidden unless asked for", () => {
	const id = "a0000008-0000-0000-0000-000000000008";
	writeSession({ id, messages: [user("park me"), assistant("ok")] });
	fs.writeFileSync(
		path.join(agentDir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: { [id]: { archivedAt: Date.now() } },
		}),
	);
	assert.equal(
		buildRows().rows.some((r) => r.id === id),
		false,
	);
	assert.equal(
		buildRows({ withArchived: true }).rows.some((r) => r.id === id),
		true,
	);
});

test("unread follows seen state, and pins survive a refresh", () => {
	const id = "a0000009-0000-0000-0000-000000000009";
	writeSession({ id, messages: [user("look at me"), assistant("ok")] });
	fs.writeFileSync(
		path.join(agentDir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: { [id]: { unreadAt: 10, seenAt: 5, pinnedAt: 7 } },
		}),
	);
	const row = buildRows().rows.find((r) => r.id === id);
	assert.equal(row?.unread, true);
	assert.equal(row?.pinned, true);
});

test("tail reads never split a UTF-8 character", () => {
	// 日 is three bytes, so an arbitrary window boundary can land inside it; a
	// naive toString() then emits U+FFFD and the first line stops parsing.
	const file = path.join(agentDir, "sessions", "--scratch--", "utf8.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const line = `${JSON.stringify({ type: "x", text: "日本語テキスト" })}\n`;
	fs.writeFileSync(file, line.repeat(400));
	const size = fs.statSync(file).size;
	for (const max of [1, 2, 3, 5, 7, 8, 11, 1024, 4096]) {
		const { lines } = readLinesAt(file, { max });
		for (const l of lines) {
			assert.doesNotMatch(l, /\uFFFD/, `max=${max} corrupted a line`);
			assert.doesNotThrow(() => JSON.parse(l), `max=${max} broke JSON`);
		}
	}
	assert.equal(readLinesAt(file).lines.length, 400);
});

test("a foreign run's in-flight output is readable from its event file", () => {
	// The daemon does not own this run, so getAgent() is empty; the phone used
	// to sit on a blank "working" box until the run finished.
	const id = "foreign-run-1";
	const out = path.join(agentDir, "inbox-agents", `${id}.out`);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	const emit = (o: unknown) => fs.appendFileSync(out, `${JSON.stringify(o)}\n`);
	const delta = (t: string) =>
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: t },
		});

	delta("thinking ");
	delta("out loud");
	emit({
		type: "tool_execution_start",
		toolName: "bash",
		args: { command: "ls -la /tmp" },
	});
	delta("after ");
	delta("tool");

	const items = liveItems(id);
	assert.deepEqual(
		items.map((i) => `${i.kind}:${i.text}`),
		["text:thinking out loud", "tool:bash ls -la /tmp", "text:after tool"],
	);
	assert.ok(eventBytes(id) > 0, "eventBytes must move so SSE change detection fires");

	// A finalized message leaves the live box; its text is in the transcript.
	emit({ type: "message_end", message: { role: "assistant" } });
	assert.deepEqual(
		liveItems(id).map((i) => i.kind),
		["text", "tool"],
	);
});

test("a long run keeps producing distinct change-detection keys", () => {
	// The transcript is capped, so its length pins and the newest message's text
	// stops moving; the event-file size is what keeps the stream alive.
	const id = "foreign-run-2";
	const out = path.join(agentDir, "inbox-agents", `${id}.out`);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	const seen = new Set<number>();
	for (let n = 0; n < 5; n++) {
		fs.appendFileSync(
			out,
			`${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "x" },
			})}\n`,
		);
		seen.add(eventBytes(id));
	}
	assert.equal(seen.size, 5);
});

test("a rename in the middle of a large session is found", () => {
	// A rename appends a session_info entry wherever the session is at the time;
	// on a long session that is nowhere near either end, which made the row fall
	// back to the first prompt.
	const id = "a0000010-0000-0000-0000-000000000010";
	const dir = path.join(agentDir, "sessions", "--scratch--");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);

	const filler = (tag: string) =>
		JSON.stringify({
			type: "message",
			id: tag,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "x".repeat(600) }] },
		});
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/scratch",
		}),
	];
	// ~1.8MB of history, then the rename, then more history so it is not at the end.
	for (let i = 0; i < 1500; i++) lines.push(filler(`a${i}`));
	lines.push(
		JSON.stringify({
			type: "session_info",
			id: "renamed",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			name: "Middle of the file",
		}),
	);
	for (let i = 0; i < 1500; i++) lines.push(filler(`b${i}`));
	fs.writeFileSync(file, `${lines.join("\n")}\n`);

	assert.ok(fs.statSync(file).size > 1_500_000, "fixture should be large");
	assert.equal(readName(file), "Middle of the file");

	// The row must use it, not the first prompt.
	const row = buildRows().rows.find((r) => r.id === id);
	assert.equal(row?.title, "Middle of the file");
});

test("a later rename beats an earlier one", () => {
	const id = "a0000011-0000-0000-0000-000000000011";
	const dir = path.join(agentDir, "sessions", "--scratch--");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	const info = (name: string) =>
		JSON.stringify({
			type: "session_info",
			id: name,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			name,
		});
	const msg = JSON.stringify({
		type: "message",
		id: "m",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	});
	fs.writeFileSync(
		file,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/scratch",
			}),
			info("First name"),
			msg,
			info("Second name"),
			msg,
		].join("\n") + "\n",
	);
	assert.equal(readName(file), "Second name");
});

test("a session with no name still falls back to the first prompt", () => {
	const file = writeSession({
		id: "a0000012-0000-0000-0000-000000000012",
		messages: [user("the first prompt"), assistant("ok")],
	});
	assert.equal(readName(file), undefined);
	const row = buildRows().rows.find(
		(r) => r.id === "a0000012-0000-0000-0000-000000000012",
	);
	assert.equal(row?.title, "the first prompt");
});

test("delegated workers collapse under the session that spawned them", () => {
	// A fan-out is one row per worker; uncollapsed it buries the sessions the
	// person actually started.
	const parent = "a0000020-0000-0000-0000-000000000020";
	const kid = "a0000021-0000-0000-0000-000000000021";
	writeSession({ id: parent, messages: [user("run a fan-out"), assistant("ok")] });
	writeSession({ id: kid, messages: [user("delegated slice"), assistant("done")] });

	const workerDir = path.join(agentDir, "session-workers", "workers");
	fs.mkdirSync(workerDir, { recursive: true });
	fs.writeFileSync(
		path.join(workerDir, `${kid}.json`),
		JSON.stringify({ id: kid, parentId: parent, createdAt: 1 }),
	);

	const collapsed = buildRows().rows;
	const parentRow = collapsed.find((r) => r.id === parent);
	assert.equal(parentRow?.children, 1, "parent should report one child");
	assert.equal(parentRow?.expanded, false, "collapsed by default");
	assert.equal(
		collapsed.some((r) => r.id === kid),
		false,
		"the child is hidden while collapsed",
	);

	// Expanding reveals it directly beneath the parent, marked as a child.
	fs.writeFileSync(
		path.join(agentDir, "inbox-worker-folds.json"),
		JSON.stringify({ version: 1, expanded: [parent] }),
	);
	const open = buildRows().rows;
	const index = open.findIndex((r) => r.id === parent);
	assert.equal(open[index]?.expanded, true);
	assert.equal(open[index + 1]?.id, kid, "child sits under its parent");
	assert.equal(open[index + 1]?.child, true);
});

test("log lines cannot carry terminal escapes into `tail -f`", () => {
	// RemoteAddr is attacker-influenced; the log is read in a terminal.
	const hostile = JSON.stringify({ remote: "1.2.3.4\u001b[2J\u001b]0;pwned\u0007" });
	const safe = sanitizeForLog(hostile);
	assert.equal(safe.includes("\u001b"), false, "no raw escape");
	assert.equal(safe.includes("\u0007"), false, "no raw BEL");
	assert.ok(safe.includes("\\u001b"), "escaped, still readable");
	// Ordinary lines are untouched.
	const plain = '{"event":"term-open","id":"t1"}';
	assert.equal(sanitizeForLog(plain), plain);
});

test("lanAddress returns a usable IPv4 literal", () => {
	const addr = lanAddress();
	assert.match(addr, /^\d+\.\d+\.\d+\.\d+$/);
});

test("a manual hide is honoured, like the TUI's x", () => {
	// `x` on a session no rule matched writes `filter: "hide"`. The phone used
	// to show it anyway, so the two lists disagreed about what you had filed.
	const id = "a0000013-0000-0000-0000-000000000013";
	writeSession({ id, messages: [user("hide me"), assistant("ok")] });
	fs.writeFileSync(
		path.join(agentDir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: { [id]: { filter: "hide" } },
		}),
	);
	assert.equal(buildRows().rows.some((r) => r.id === id), false);
	const withHidden = buildRows({ withHidden: true }).rows.find((r) => r.id === id);
	assert.equal(withHidden?.hidden, true, "the Filtered view needs the flag");
});

test("model choices come from enabledModels, with per-model levels", () => {
	// The phone's picker must match the TUI's N, which pi derives from the same
	// settings list; the daemon has no session, so it reads the file directly.
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			enabledModels: ["prov/a-model", "prov/b-model", "no-slash"],
			defaultThinkingLevel: "high",
			modelThinkingLevels: { "prov/b-model": "low" },
		}),
	);
	const data = modelChoices();
	assert.deepEqual(
		data.models.map((m) => m.reference),
		["prov/a-model", "prov/b-model"],
		"a malformed reference is skipped, not crashed on",
	);
	assert.equal(data.models[0]?.defaultLevel, "high");
	assert.equal(data.models[1]?.defaultLevel, "low", "per-model wins");
	assert.equal(data.defaultLevel, "high");
	assert.ok(data.models[0]?.levels.includes("off"));
});

test("no enabledModels means an empty picker, not a crash", () => {
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ defaultThinkingLevel: "low" }),
	);
	assert.deepEqual(modelChoices().models, []);
	assert.equal(modelChoices().source, "none");
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
