import assert from "node:assert/strict";
import { test } from "node:test";
import {
	allMessagesText,
	canResume,
	emptyTally,
	foldLine,
	KEEP_HEAD,
	KEEP_TAIL,
	splitLines,
	type SessionTally,
} from "./incremental-parse.ts";

const msg = (role: string, text: string, ts = 1) =>
	JSON.stringify({ type: "message", message: { role, content: text, timestamp: ts } });

// ─────────────────────── folding equals a whole-file read ───────────────────────

/** The original whole-file loop, kept here as the oracle the folds must match. */
function parseAll(text: string) {
	const tally = emptyTally();
	for (const line of text.split("\n")) if (line) foldLine(tally, line);
	return tally;
}

test("folding incrementally matches folding the whole file at once", () => {
	const lines = [
		JSON.stringify({ type: "session", id: "s1" }),
		JSON.stringify({ type: "session_info", name: "a name" }),
		msg("user", "first prompt"),
		msg("assistant", "reply one"),
		msg("toolResult", "tool output"), // counts toward messageCount, not text
		msg("user", "second prompt"),
	];
	const whole = parseAll(lines.join("\n") + "\n");

	// Same lines, fed one at a time as a live writer would.
	const stepwise = emptyTally();
	for (const line of lines) foldLine(stepwise, line);

	assert.deepEqual(stepwise, whole);
	assert.equal(whole.name, "a name");
	assert.equal(whole.messageCount, 4, "every message entry counts, any role");
	assert.equal(whole.firstMessage, "first prompt");
	assert.deepEqual(
		whole.tail,
		["first prompt", "reply one", "second prompt"],
		"toolResult counts toward messageCount but contributes no text",
	);
});

test("the head and tail windows stay bounded", () => {
	const tally = emptyTally();
	for (let i = 0; i < 40; i++) foldLine(tally, msg("assistant", `m${i}`));
	assert.equal(tally.head.length, KEEP_HEAD);
	assert.equal(tally.tail.length, KEEP_TAIL);
	assert.deepEqual(tally.head, ["m0", "m1", "m2", "m3", "m4"]);
	assert.deepEqual(tally.tail, Array.from({ length: KEEP_TAIL }, (_, i) => `m${30 + i}`));
});

test("a short session is not double-counted in the text index", () => {
	const tally = emptyTally();
	foldLine(tally, msg("user", "only one"));
	assert.equal(allMessagesText(tally), "only one");
});

test("a malformed line is skipped without disturbing the tally", () => {
	const tally = emptyTally();
	foldLine(tally, msg("user", "good"));
	const before = { ...tally, head: [...tally.head], tail: [...tally.tail] };
	foldLine(tally, '{"type":"message","mess'); // truncated JSON
	assert.deepEqual(tally, before);
});

test("lastActivityMs tracks the newest timestamp, not the last one read", () => {
	const tally = emptyTally();
	foldLine(tally, msg("assistant", "a", 500));
	foldLine(tally, msg("assistant", "b", 100));
	assert.equal(tally.lastActivityMs, 500);
});

// ─────────────────────── the resume decision ───────────────────────

test("a grown file can resume; a shrunk one cannot", () => {
	const tally: SessionTally = { ...emptyTally(), offset: 100, size: 100 };
	assert.equal(canResume(tally, { size: 150 }), true, "append");
	assert.equal(canResume(tally, { size: 100 }), true, "unchanged");
	assert.equal(
		canResume(tally, { size: 90 }),
		false,
		"truncation/compaction invalidates every remembered offset",
	);
	assert.equal(canResume(emptyTally(), { size: 10 }), false, "nothing to resume from");
	assert.equal(
		canResume(tally, { size: 50 }),
		false,
		"offset past EOF is never resumable",
	);
});

// ─────────────────────── line splitting ───────────────────────

test("a complete chunk splits into lines with an empty carry", () => {
	const r = splitLines('{"a":1}\n{"b":2}\n', "");
	assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
	assert.equal(r.carry, "");
	assert.equal(r.consumed, 16);
});

test("an unterminated trailing line is carried, never consumed", () => {
	// This is the live-writer case: read arrives mid-line.
	const r = splitLines('{"a":1}\n{"b":2}', "");
	assert.deepEqual(r.lines, ['{"a":1}'], "the partial line must not be folded");
	assert.equal(r.carry, '{"b":2}');
	assert.equal(r.consumed, 8, "only the complete line's bytes are consumed");
});

test("a line split across two chunks is completed by the carry", () => {
	const first = splitLines('{"a":1}\n{"b":', "");
	assert.deepEqual(first.lines, ['{"a":1}']);
	assert.equal(first.carry, '{"b":');
	// `consumed` counts only bytes from THIS chunk, not the carry.
	assert.equal(first.consumed, 8);

	const second = splitLines('2}\n', first.carry);
	assert.deepEqual(second.lines, ['{"b":2}']);
	assert.equal(second.carry, "");
	// The completed line is the carry ('{"b":', 5 bytes) plus the new chunk's 3 bytes
	// ('2}' and the newline); ALL 8 bytes are newly committed now, because the carry
	// was never counted while it dangled.
	assert.equal(second.consumed, 8);
});

test("chunks with no newline at all consume nothing", () => {
	const r = splitLines('{"a":', "");
	assert.deepEqual(r.lines, []);
	assert.equal(r.consumed, 0);
	assert.equal(r.carry, '{"a":');
});

test("offsets are BYTES, so multi-byte text advances the stream correctly", () => {
	// Session text is full of emoji; a UTF-16 length would under-count and corrupt
	// the resume offset.
	const line = JSON.stringify({ type: "message", message: { role: "user", content: "😀🎉" } });
	assert.ok(
		Buffer.byteLength(line, "utf-8") > line.length,
		"the fixture must actually be multi-byte",
	);
	const r = splitLines(line + "\n", "");
	assert.equal(r.consumed, Buffer.byteLength(line, "utf-8") + 1);
	assert.notEqual(r.consumed, line.length + 1);
});

test("consumed bytes sum to the file size across arbitrary chunk boundaries", () => {
	// This is the invariant an earlier version broke: it subtracted the carry twice,
	// so offsets silently drifted short and a later resume re-read (and re-folded)
	// history. A single-stream total is the cheapest way to pin it.
	const text =
		JSON.stringify({ type: "session", id: "s1" }) + "\n" +
		[
			msg("user", "héllo 😀"),
			msg("assistant", "wörld 🎉"),
			msg("user", "third"),
		].join("\n") + "\n";
	const total = Buffer.byteLength(text, "utf-8");
	for (const cut of [1, 2, 3, 5, 7, 11, 13, 17, 64, 100]) {
		let carry = "";
		let consumed = 0;
		for (let i = 0; i < text.length; i += cut) {
			const r = splitLines(text.slice(i, i + cut), carry);
			consumed += r.consumed;
			carry = r.carry;
		}
		assert.equal(consumed, total, `chunk size ${cut} must account for every byte`);
		assert.equal(carry, "", `chunk size ${cut} must end on a line boundary`);
	}
});
