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
import { spawnSync } from "node:child_process";

// getAgentDir() consults the environment, so point HOME at a scratch tree
// before importing anything that reads it at module load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-web-"));
process.env.HOME = home;
const agentDir = path.join(home, ".pi", "agent");
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });

const { buildRow, buildRows, eventBytes, firstUserText, lanAddress, liveItems,
	mentionChoices, modelChoices, readLinesAt, readName, readTail,
	sanitizeForLog, transcript } = await import("./server.ts");

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

test("mentions list sessions with the id as the inserted token", async () => {
	const seen = writeSession({
		id: "aaaa-1111",
		messages: [user("mention target one")],
		name: "Target One",
	});
	assert.ok(seen);
	writeSession({ id: "bbbb-2222", messages: [user("target two")] });
	const data = mentionChoices();
	assert.ok(data.mentions.length >= 2);
	const hit = data.mentions.find((m) => m.id === "aaaa-1111");
	assert.ok(hit, "the named session is offered");
	assert.equal(hit.label, "Target One");
	assert.equal(hit.value, "@[aaaa-1111]");
});

test("a session is not offered as a mention of itself", () => {
	const me = writeSession({ id: "cccc-3333", messages: [user("me")] });
	const other = writeSession({ id: "dddd-4444", messages: [user("them")] });
	assert.ok(me && other);
	const from = mentionChoices({ from: "cccc-3333" }).mentions.map((m) => m.id);
	assert.ok(!from.includes("cccc-3333"));
	assert.ok(from.includes("dddd-4444"));
	// Opting in is explicit, because referencing your own transcript is legal.
	const withSelf = mentionChoices({ from: "cccc-3333", includeSelf: true })
		.mentions.map((m) => m.id);
	assert.ok(withSelf.includes("cccc-3333"));
});

test("archived sessions are left out of mentions unless asked for", () => {
	const store = path.join(agentDir, "inbox.json");
	const id = "eeee-5555";
	writeSession({ id, messages: [user("archived one")] });
	fs.writeFileSync(store, JSON.stringify({
		version: 1,
		sessions: { [id]: { archivedAt: 1 } },
	}));
	const hidden = mentionChoices().mentions.map((m) => m.id);
	assert.ok(!hidden.includes(id));
	const shown = mentionChoices({ withArchived: true }).mentions.map((m) => m.id);
	assert.ok(shown.includes(id));
	fs.rmSync(store, { force: true });
});

test("mentions can be narrowed to one inbox group", () => {
	const gid = "grp-mention";
	const inGroup = "ffff-6666";
	const outGroup = "gggg-7777";
	writeSession({ id: inGroup, messages: [user("inside the group")] });
	writeSession({ id: outGroup, messages: [user("outside the group")] });
	const groupsFile = path.join(agentDir, "inbox-groups.json");
	fs.writeFileSync(groupsFile, JSON.stringify({
		version: 1,
		groups: [{ id: gid, name: "Mentions", templateEnabled: false, template: "" }],
		sessions: { [inGroup]: gid },
	}));
	const scoped = mentionChoices({ groupId: gid }).mentions.map((m) => m.id);
	assert.deepEqual(scoped, [inGroup]);
	assert.equal(mentionChoices({ groupId: gid }).group, gid);
	// `group=all` is the TUI's `@[`: no group filter at all.
	const all = mentionChoices({ groupId: "all" }).mentions.map((m) => m.id);
	assert.ok(all.includes(inGroup) && all.includes(outGroup));
	// Ungrouped means "no membership", which is a real filter too.
	const loose = mentionChoices({ groupId: "ungrouped" }).mentions.map((m) => m.id);
	assert.ok(loose.includes(outGroup) && !loose.includes(inGroup));
	// A session with no group of its own defaults to the unscoped list.
	const fromLoose = mentionChoices({ from: outGroup }).mentions.map((m) => m.id);
	assert.ok(fromLoose.includes(inGroup));
	fs.rmSync(groupsFile, { force: true });
});

test("an ungrouped session's own-group scope is empty, not everything", () => {
	const loose = "hhhh-8888";
	const grouped = "iiii-9999";
	writeSession({ id: loose, messages: [user("no group")] });
	writeSession({ id: grouped, messages: [user("grouped")] });
	const groupsFile = path.join(agentDir, "inbox-groups.json");
	fs.writeFileSync(groupsFile, JSON.stringify({
		version: 1,
		groups: [{ id: "grp-self", name: "Self", templateEnabled: false, template: "" }],
		sessions: { [grouped]: "grp-self" },
	}));
	// `@g[` from an ungrouped session: the TUI shows nothing has a group here.
	const self = mentionChoices({ from: loose, groupId: "self" });
	assert.deepEqual(self.mentions.map((m) => m.id), [grouped].filter(() => false));
	assert.equal(self.group, "ungrouped");
	assert.equal(self.fromGroup, undefined);
	// The same scope from a grouped session returns that group's other members.
	const fromGrouped = mentionChoices({ from: grouped, groupId: "self" });
	assert.equal(fromGrouped.group, "grp-self");
	assert.equal(fromGrouped.fromGroup, "grp-self");
	fs.rmSync(groupsFile, { force: true });
});

test("rows carry the persisted list layout and their group's name", () => {
	const gid = "grp-layout";
	const inGroup = "jjjj-1010";
	const loose = "kkkk-1111";
	writeSession({ id: inGroup, messages: [user("in a group")] });
	writeSession({ id: loose, messages: [user("no group")] });
	const groupsFile = path.join(agentDir, "inbox-groups.json");
	const store = (extra: Record<string, unknown>) =>
		fs.writeFileSync(groupsFile, JSON.stringify({
			version: 1,
			groups: [{ id: gid, name: "Layouts", templateEnabled: false, template: "" }],
			sessions: { [inGroup]: gid },
			...extra,
		}));

	// A store that never recorded a choice draws the grouped list, like the TUI.
	store({});
	assert.equal(buildRows().layout, "groups");
	assert.equal(
		buildRows().rows.find((r) => r.id === inGroup)?.groupName,
		"Layouts",
	);
	assert.equal(buildRows().rows.find((r) => r.id === loose)?.groupName, undefined);

	// The TUI's `s` persists `layout` in the same file: the phone reads it back
	// so the two front ends show one list, not two different ones.
	store({ layout: "flat" });
	assert.equal(buildRows().layout, "flat");
	// Membership is still reported in flat, where the group name rides the row.
	assert.equal(buildRows().rows.find((r) => r.id === inGroup)?.groupId, gid);

	store({ layout: "groups" });
	assert.equal(buildRows().layout, "groups");
	fs.rmSync(groupsFile, { force: true });
});

// ───────────────────────── stale live records ─────────────────────────

/**
 * A pid that is guaranteed dead: spawn and reap a trivial child.
 *
 * The bug this guards was a live record whose process had already exited but
 * whose `bgParent` was the daemon itself, so the liveness check was skipped and
 * the record kept reporting `working` for the full 5-minute STUCK_AFTER_MS.
 */
function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", "0"], { timeout: 10_000 });
	assert.equal(child.status, 0, "helper child must run");
	// Its pid is now reaped; nothing else can hold that number this quickly.
	return child.pid!;
}

function writeLiveRecord(rec: Record<string, unknown>) {
	const dir = path.join(agentDir, "inbox-live");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${rec.pid}.json`),
		JSON.stringify(rec),
	);
}

test("a dead child's live record does not make its session look busy", () => {
	// The regression: the daemon spawned this run (so bgParent === our pid),
	// the process exited, and the record still said "working". Every OTHER
	// session then reported "queued (waiting for a free agent slot)" even
	// though nothing was waiting for capacity.
	const id = "llll-1111";
	writeSession({ id, messages: [user("mirror the change")] });
	const pid = deadPid();
	writeLiveRecord({
		pid,
		sessionId: id,
		sessionFile: path.join(agentDir, "sessions", "--scratch--", `x_${id}.jsonl`),
		state: "working",
		updated: Date.now(),
		bgParent: process.pid,
	});

	const row = buildRows().rows.find((r) => r.id === id);
	assert.ok(row, "the session still lists");
	assert.notEqual(row.state, "working", "a dead pid is not a running session");

	// And the record is reaped, not just ignored, so the next read is cheap.
	assert.equal(
		fs.existsSync(path.join(agentDir, "inbox-live", `${pid}.json`)),
		false,
		"a record naming a dead pid must be removed",
	);
});

test("a live record for another session does not block this one", () => {
	// Same shape, but the record belongs to a DIFFERENT session than the row we
	// ask about. This is what made one phone reply look slot-blocked by an
	// unrelated agent.
	const busyOther = "llll-2222";
	const idleOne = "llll-3333";
	writeSession({ id: busyOther, messages: [user("long run")] });
	writeSession({ id: idleOne, messages: [user("talk to me"), assistant("hi")] });
	const pid = deadPid();
	writeLiveRecord({
		pid,
		sessionId: busyOther,
		sessionFile: path.join(agentDir, "sessions", "--scratch--", `x_${busyOther}.jsonl`),
		state: "working",
		updated: Date.now(),
		bgParent: process.pid,
	});

	const row = buildRows().rows.find((r) => r.id === idleOne);
	assert.ok(row);
	assert.equal(row.state, undefined, "the idle session is not busy");
	assert.equal(row.queueReason, undefined, "and nothing is queued on it");
});

test("a stale record's silence still downgrades to idle, and says how long", () => {
	// Belt and braces: if a pid somehow survives while genuinely silent, the
	// existing STUCK_AFTER_MS path must still apply. Use our own pid so it is
	// alive but untracked.
	const id = "llll-4444";
	writeSession({ id, messages: [user("orphan")] });
	writeLiveRecord({
		pid: process.pid,
		sessionId: id,
		sessionFile: path.join(agentDir, "sessions", "--scratch--", `x_${id}.jsonl`),
		state: "working",
		updated: Date.now() - 30 * 60_000,
	});
	const row = buildRows().rows.find((r) => r.id === id);
	assert.ok(row);
	assert.notEqual(row.state, "working");
});

test("a queued message behind a live foreign run reads as writer, not slot", async () => {
	// The exact phone symptom: another process holds the session, so the reply
	// cannot start. The UI used to call this "waiting for a free agent slot",
	// which sent the reader looking for a capacity problem that did not exist.
	const id = "llll-5555";
	writeSession({ id, messages: [user("mirror the change"), assistant("done")] });
	// A genuinely foreign live pid: the test runner's parent is alive for the
	// duration of the run, and is not this process's own record.
	writeLiveRecord({
		pid: process.ppid,
		sessionId: id,
		sessionFile: path.join(agentDir, "sessions", "--scratch--", `x_${id}.jsonl`),
		state: "working",
		updated: Date.now(),
	});
	// A pending message is what makes the reason meaningful.
	const { registry } = await import("../../lib/inbox-agents.ts");
	registry().agents.set(id, {
		id,
		cwd: "/scratch",
		title: "mirror the change",
		state: "queued",
		pending: ["and again"],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		needsYou: false,
		runs: 1,
		log: [],
		liveText: "",
	} as any);

	const row = buildRows().rows.find((r) => r.id === id);
	assert.ok(row);
	assert.equal(row.queueReason, "writer", "a foreign holder is not a slot problem");
	registry().agents.delete(id);
	fs.rmSync(path.join(agentDir, "inbox-live", `${process.ppid}.json`), { force: true });
});


test("the concluding assistant message is flagged final, tool steps are not", () => {
	const file = writeSession({
		id: "jjjj-0001",
		messages: [
			user("do the thing"),
			// A step: the model wanted another tool, so this is not the answer.
			{ role: "assistant", stopReason: "toolUse", content: [
				{ type: "text", text: "Let me look." },
				{ type: "toolCall", name: "read", arguments: { path: "/x" } },
			] },
			{ role: "toolResult", isError: false, content: [{ type: "text", text: "ok" }] },
			assistant("Done — it worked."),
		],
	});
	const msgs = transcript(file);
	const finals = msgs.filter((m) => m.final);
	assert.equal(finals.length, 1, "exactly one final answer");
	assert.equal(finals[0]?.text, "Done — it worked.");
	// The step is still visible; only the flag is withheld.
	assert.ok(msgs.some((m) => m.role === "assistant" && !m.final && m.tools?.length));
});

test("a run that errored or aborted has no final answer", () => {
	const file = writeSession({
		id: "kkkk-0002",
		messages: [
			user("go"),
			assistant("boom", { stopReason: "error", errorMessage: "rate limited" }),
			assistant("cut off", { stopReason: "aborted" }),
		],
	});
	const msgs = transcript(file);
	assert.equal(msgs.filter((m) => m.final).length, 0);
	assert.equal(msgs.find((m) => m.stopped === "error")?.error, "rate limited");
	assert.ok(msgs.some((m) => m.stopped === "aborted"));
});

test("an empty-text stop is not a final answer", () => {
	const file = writeSession({
		id: "llll-0003",
		messages: [
			user("go"),
			{ role: "assistant", stopReason: "stop", content: [] },
		],
	});
	// A stop with nothing said has nothing to mark: it is skipped entirely.
	assert.equal(transcript(file).filter((m) => m.final).length, 0);
});

test("our own live record is running, not another pi", async () => {
	// The label regression: a session this daemon is itself running has a live
	// record naming OUR pid. `writerElsewhere` counts that as a writer on
	// purpose (don't spawn beside yourself), but the label must not then tell
	// the user "another pi is running it" about the window they are typing in.
	const id = "llll-6666";
	writeSession({ id, messages: [user("this very session"), assistant("hi")] });
	writeLiveRecord({
		pid: process.pid,
		sessionId: id,
		sessionFile: path.join(agentDir, "sessions", "--scratch--", `x_${id}.jsonl`),
		state: "working",
		updated: Date.now(),
	});
	// A pending message is what makes the reason meaningful: without one the row
	// carries no queueReason at all and the assertion below would be vacuous.
	const { registry } = await import("../../lib/inbox-agents.ts");
	registry().agents.set(id, {
		id,
		cwd: "/scratch",
		title: "this very session",
		state: "queued",
		pending: ["and again"],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		needsYou: false,
		runs: 1,
		log: [],
		liveText: "",
	} as any);

	const row = buildRows().rows.find((r) => r.id === id);
	assert.ok(row);
	// A message is waiting behind a live run...

	assert.equal(typeof row.queueReason, "string", "a waiting message has a reason");
	// ...but not because a stranger holds it.
	assert.notEqual(row.queueReason, "writer", "our own run is not 'another pi'");
	assert.equal(row.queueReason, "running", "our own run is just this run");
	registry().agents.delete(id);
	fs.rmSync(path.join(agentDir, "inbox-live", `${process.pid}.json`), { force: true });
});

test("buildRow describes one session exactly as the list would", () => {
	// The transcript stream needs ONE row and knew its id, yet called
	// `buildRows()` -- every session on disk -- on a 1.2s timer, then
	// `.find()`-ed it. Same "fingerprint before the work" mistake the inbox
	// refresh fixed. `buildRow` must agree with the list projection or the phone
	// would show a different row than the list it came from.
	for (let i = 0; i < 6; i++) {
		writeSession({
			id: `b000000${i}-0000-0000-0000-00000000000${i}`,
			cwd: `/scratch/dir${i}`,
			messages: [user(`task ${i}`), assistant(`done ${i}`)],
		});
	}
	const all = buildRows({ withArchived: true, withHidden: true }).rows;
	assert.ok(all.length >= 6);
	for (const row of all) {
		const single = buildRow(row.id);
		assert.ok(single, `buildRow must find ${row.id}`);
		// The identifying fields the phone renders.
		for (const field of [
			"id", "title", "cwd", "status", "state", "model", "created",
			"updated", "pinned", "archived", "hidden", "groupId", "groupName",
			"parentId", "firstPrompt", "lastText",
		] as const) {
			assert.deepEqual(
				single[field],
				row[field],
				`${row.id}: ${field} differs from the list`,
			);
		}
	}
	assert.equal(buildRow("no-such-session"), undefined);
});

test("transcript memoises but never serves a stale tail", () => {
	// A whole-file parse per 1.2s tick, purely to redraw a tail that had not
	// changed. Memoised on (mtime, size); an append must invalidate or the phone
	// would freeze on an old transcript.
	const file = writeSession({
		id: "c0000001-0000-0000-0000-000000000001",
		messages: [user("first"), assistant("one")],
	});
	const initial = transcript(file, 60);
	assert.ok(initial.length >= 2);

	const warmStart = process.hrtime.bigint();
	assert.deepEqual(transcript(file, 60), initial, "a warm read is identical");
	const warmMs = Number(process.hrtime.bigint() - warmStart) / 1e6;
	assert.ok(warmMs < 5, `a warm read must not re-parse; took ${warmMs}ms`);

	fs.appendFileSync(file, `${JSON.stringify({
		type: "message",
		id: "appended",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "appended reply" }],
			stopReason: "stop",
		},
	})}\n`);
	const after = transcript(file, 60);
	assert.equal(
		after.at(-1)?.text,
		"appended reply",
		"an append must invalidate the memo",
	);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
