import assert from "node:assert/strict";
import { test } from "node:test";
import {
	deriveTextIndex,
	fromEntry,
	keepsTally,
	TALLY_RETAIN_MS,
	toEntry,
	type CachedRecord,
} from "./cache-entry.ts";
import { allMessagesText, canResume, emptyTally, KEEP_HEAD, type SessionTally } from "./incremental-parse.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T12:00:00Z");

function tallyWith(over: Partial<SessionTally> = {}): SessionTally {
	return {
		...emptyTally(),
		offset: 1234,
		size: 1234,
		messageCount: 3,
		lastActivityMs: NOW - DAY,
		firstMessage: "first prompt",
		head: ["a", "b", "c"],
		tail: ["c", "d", "e"],
		name: "a name",
		...over,
	};
}

function record(over: Partial<CachedRecord> = {}, info: any = {}, tally?: SessionTally): CachedRecord {
	const t = tally ?? tallyWith();
	return {
		mtimeMs: 111,
		size: 222,
		tally: t,
		info: {
			path: "/s/x.jsonl",
			id: "x",
			cwd: "/s",
			name: "a name",
			created: new Date(NOW - 2 * DAY),
			modified: new Date(NOW - DAY),
			messageCount: t.messageCount,
			firstMessage: t.firstMessage || "(no messages)",
			allMessagesText: allMessagesText(t),
			...info,
		},
		...over,
	};
}

// ─────────────────────── the derivation must not drift ───────────────────────

test("deriveTextIndex matches allMessagesText for every window shape", () => {
	const shapes: SessionTally[] = [
		tallyWith({ head: [], tail: [] }),
		tallyWith({ head: ["only"], tail: ["only"] }),
		tallyWith({ head: ["a"], tail: ["a", "b"] }),
		tallyWith({ head: ["a", "b", "c", "d", "e"], tail: ["a", "b", "c", "d", "e"] }),
		tallyWith({ head: ["a", "b", "c", "d", "e"], tail: ["f", "g", "h", "i", "j", "k"] }),
		tallyWith({ head: Array.from({ length: KEEP_HEAD }, (_, i) => `h${i}`), tail: ["t0", "t1"] }),
	];
	for (const t of shapes) assert.equal(deriveTextIndex(t), allMessagesText(t));
});

// ─────────────────────── round-trip equivalence (the real oracle) ───────────────────────

test("round-tripping a recent record preserves every observable field", () => {
	const original = record();
	const back = fromEntry(JSON.parse(JSON.stringify(toEntry(original, NOW))));
	assert.ok(back);
	assert.deepEqual(back.info, original.info);
	assert.deepEqual(back.tally, original.tally);
	assert.equal(back.mtimeMs, original.mtimeMs);
	assert.equal(back.size, original.size);
});

test("round-tripping an old record preserves info but drops the resume offset", () => {
	const original = record({}, { modified: new Date(NOW - 30 * DAY) });
	const entry = toEntry(original, NOW);
	assert.equal(entry.tally, undefined, "old entry must not carry a tally");
	const back = fromEntry(JSON.parse(JSON.stringify(entry)));
	assert.ok(back);
	// Everything the inbox *displays* or *matches on* survives.
	assert.deepEqual(back.info, original.info);
	// The resume offset is gone, so the next append full-parses rather than
	// resuming from a stale byte count. That is the intended trade.
	assert.equal(back.tally.offset, 0);
});

test("the text index survives the tally being dropped", () => {
	const original = record();
	const back = fromEntry(JSON.parse(JSON.stringify(toEntry(original, NOW + 90 * DAY))));
	assert.ok(back);
	assert.equal(back.info.allMessagesText, original.info.allMessagesText);
	assert.equal(back.info.firstMessage, original.info.firstMessage);
});

test("dropping the tally shrinks the entry", () => {
	const original = record({}, {}, tallyWith({ head: Array(5).fill("x".repeat(200)), tail: Array(10).fill("y".repeat(200)) }));
	const recentEntry = toEntry(original, NOW);
	const oldEntry = toEntry(original, NOW + 365 * DAY);
	const recent = JSON.stringify(recentEntry);
	const old = JSON.stringify(oldEntry);
	assert.ok(old.length < recent.length, `expected shrink, got ${old.length} vs ${recent.length}`);
	assert.equal(oldEntry.tally, undefined, "old entry must not keep resume state");
	// Structural claim, not a text-count guess: the recent form keeps two arrays
	// of per-message strings; the old form keeps one collapsed joined string.
	assert.deepEqual(recentEntry.tally?.head.slice(0, 1), ["x".repeat(200)]);
	assert.equal(recentEntry.tally?.tail.length, 10);
	assert.ok(!old.includes('"head"'), "old entry still stores a head window array");
	assert.ok(!old.includes('"tail"'), "old entry still stores a tail window array");
});

// The `allMessagesText` field is a pure derivation and must never be written
// alongside a tally: that redundancy was 8.6MB of the 26MB cache.
test("a tally-bearing entry does not store the derived text", () => {
	const entry = toEntry(record(), NOW);
	assert.equal(entry.info.allMessagesText, undefined);
	assert.equal(entry.info.firstMessage, undefined);
});

// ─────────────────────── the retention rule ───────────────────────

test("keepsTally is inclusive at the boundary and heals as a session is touched", () => {
	assert.equal(keepsTally(NOW - TALLY_RETAIN_MS, NOW), true, "exactly at the threshold keeps");
	assert.equal(keepsTally(NOW - TALLY_RETAIN_MS - 1, NOW), false, "one ms past drops");
	assert.equal(keepsTally(NOW, NOW), true, "a session touched now keeps");
	// Self-healing: an entry that had lost its tally regains one when the file moves.
	const stale = toEntry(record({}, { modified: new Date(NOW - 90 * DAY) }), NOW);
	assert.equal(stale.tally, undefined);
	const touched = toEntry(record({}, { modified: new Date(NOW) }), NOW);
	assert.ok(touched.tally, "a freshly modified session keeps its resume state");
});

test("keepsTally rejects unparseable dates instead of keeping garbage", () => {
	assert.equal(keepsTally(Number.NaN, NOW), false);
});

// ─────────────────────── corrupt input ───────────────────────

test("fromEntry rejects entries it cannot trust", () => {
	const bad: any[] = [
		null,
		undefined,
		{},
		{ mtimeMs: 1, size: 2 },
		{ mtimeMs: 1, size: 2, info: {} },
		{ mtimeMs: 1, size: 2, info: { path: "/a", id: "a", created: "nope", modified: "2026-01-01T00:00:00Z" } },
		{ mtimeMs: 1, size: 2, info: { path: "/a", id: "a", created: "2026-01-01T00:00:00Z", modified: "nope" } },
		{ info: { path: "/a", id: "a" }, size: 2, mtimeMs: "1" },
	];
	for (const raw of bad) assert.equal(fromEntry(raw), undefined, `should reject ${JSON.stringify(raw)}`);
});

test("fromEntry tolerates a tally-less entry from disk", () => {
	const back = fromEntry({
		mtimeMs: 1,
		size: 2,
		info: {
			path: "/a",
			id: "a",
			cwd: "/",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-02T00:00:00Z",
			messageCount: 7,
			firstMessage: "hello",
			allMessagesText: "hello world",
		},
	});
	assert.ok(back);
	assert.equal(back.info.messageCount, 7);
	assert.equal(back.info.firstMessage, "hello");
	assert.equal(back.info.allMessagesText, "hello world");
	assert.equal(back.tally.offset, 0);
});

test("fromEntry handles a string content field defensively", () => {
	// `info.cwd` is written by other versions; a missing one must not produce
	// `undefined` where the rest of the inbox expects a string.
	const back = fromEntry({
		mtimeMs: 1,
		size: 2,
		info: { path: "/a", id: "a", created: "2026-01-01T00:00:00Z", modified: "2026-01-02T00:00:00Z" },
	});
	assert.ok(back);
	assert.equal(back.info.cwd, "");
	assert.equal(back.info.firstMessage, "(no messages)");
});

// The contract that makes dropping the tally safe. `parseCached` serves an
// unchanged file straight from `infoCache` WITHOUT consulting the tally, so a
// tally-less entry costs nothing on the 2.5s refresh. It only pays a full parse
// when the file actually moves — and that parse restores the tally.
test("a tally-less entry is never resumable, so it can only ever full-parse", () => {
	const back = fromEntry({
		mtimeMs: 1,
		size: 2,
		info: {
			path: "/a",
			id: "a",
			cwd: "/",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-02T00:00:00Z",
			messageCount: 3,
			firstMessage: "hi",
			allMessagesText: "hi there",
		},
	});
	assert.ok(back);
	assert.equal(back.tally.offset, 0);
	// `canResume` refuses offset 0, so a grown file re-parses from the top rather
	// than folding new bytes onto a window it no longer has.
	assert.equal(canResume(back.tally, { size: 2 }), false);
	assert.equal(canResume(back.tally, { size: 999 }), false);
});

// And the stored record's own stamps still let the unchanged case short-circuit.
test("mtime and size survive so the unchanged path can still short-circuit", () => {
	const original = record();
	const entry = toEntry(original, NOW + 900 * DAY); // old enough to lose its tally
	assert.equal(entry.tally, undefined);
	assert.equal(entry.mtimeMs, original.mtimeMs);
	assert.equal(entry.size, original.size);
});
