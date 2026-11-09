import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CACHE_FLUSH_MS,
	dirReusable,
	pruneCacheByPath,
	sameStamp,
	shouldFlushCache,
	type DirEntry,
} from "./scan-cache.ts";
import {
	isPrunableOrphan,
	ORPHAN_GRACE_MS,
	recordTouchedAt,
} from "./prune.ts";
import { fingerprintOf } from "./fingerprint.ts";

// ─────────────────────────── change detection ───────────────────────────

test("sameStamp ignores the path and compares mtime+size", () => {
	const a = { mtimeMs: 10, size: 100 };
	assert.equal(sameStamp(a, { mtimeMs: 10, size: 100 }), true);
	// A touched-but-not-grown file must invalidate: pi rewrites are not always appends.
	assert.equal(sameStamp(a, { mtimeMs: 11, size: 100 }), false);
	assert.equal(sameStamp(a, { mtimeMs: 10, size: 101 }), false);
	assert.equal(sameStamp(undefined, { mtimeMs: 10, size: 100 }), false);
});

test("a directory listing is reused only while the directory mtime holds", () => {
	const cached: DirEntry = { mtimeMs: 5, files: ["a.jsonl"] };
	assert.equal(dirReusable(cached, 5), true);
	// A file added or removed bumps the dir; an append to an existing file does not,
	// which is exactly the distinction the listing cache depends on.
	assert.equal(dirReusable(cached, 6), false);
	assert.equal(dirReusable(undefined, 5), false);
});

test("pruneCacheByPath drops entries whose file is gone and counts them", () => {
	const cache = new Map([
		["/a", 1],
		["/b", 2],
		["/c", 3],
	]);
	const dropped = pruneCacheByPath(cache, new Set(["/a", "/c"]));
	assert.equal(dropped, 1);
	assert.deepEqual([...cache.keys()], ["/a", "/c"]);
});

// ─────────────────────────── orphan pruning ───────────────────────────

const freeOrphan = {
	hasSessionFile: false,
	hasLiveRecord: false,
	hasAgentRecord: false,
	hasWorkerLink: false,
};

test("an unreferenced record with no timestamps is prunable immediately", () => {
	assert.equal(isPrunableOrphan(freeOrphan, 1_000), true);
});

test("any reference at all keeps a record", () => {
	for (const key of [
		"hasSessionFile",
		"hasLiveRecord",
		"hasAgentRecord",
		"hasWorkerLink",
	] as const) {
		assert.equal(
			isPrunableOrphan({ ...freeOrphan, [key]: true }, 1_000),
			false,
			`${key} must pin the record`,
		);
	}
});

test("a recently touched orphan survives the grace period", () => {
	const now = 100 * ORPHAN_GRACE_MS;
	assert.equal(
		isPrunableOrphan({ ...freeOrphan, lastTouched: now - 1_000 }, now),
		false,
		"a session announced before its JSONL lands has a fresh timestamp",
	);
	assert.equal(
		isPrunableOrphan(
			{ ...freeOrphan, lastTouched: now - ORPHAN_GRACE_MS - 1 },
			now,
		),
		true,
	);
});

test("recordTouchedAt takes the newest stamp it can find", () => {
	assert.equal(recordTouchedAt({}), undefined);
	assert.equal(recordTouchedAt({ seenAt: 5, archivedAt: 9 }), 9);
	assert.equal(recordTouchedAt({ scrollBookmark: { savedAt: 42 } }), 42);
	// A malformed stamp must not win just because it is NaN-adjacent.
	assert.equal(recordTouchedAt({ seenAt: Number.NaN, pinnedAt: 3 }), 3);
});

// ─────────────────────────── fingerprint ───────────────────────────

const base = {
	dirs: [{ name: "--x--", mtimeMs: 1, entries: 2 }],
	store: { mtimeMs: 1, size: 10 },
	live: { mtimeMs: 1, entries: 1 },
	links: { mtimeMs: 1, entries: 1 },
	tracked: [{ path: "/a.jsonl", mtimeMs: 1, size: 5 }],
};

test("an identical state fingerprints identically", () => {
	assert.equal(fingerprintOf(base), fingerprintOf({ ...base }));
});

test("each input component moves the fingerprint", () => {
	const original = fingerprintOf(base);
	const variants = [
		{ ...base, dirs: [{ name: "--x--", mtimeMs: 2, entries: 2 }] },
		{ ...base, dirs: [{ name: "--x--", mtimeMs: 1, entries: 3 }] },
		{ ...base, store: { mtimeMs: 2, size: 10 } },
		{ ...base, store: undefined },
		{ ...base, live: { mtimeMs: 2, entries: 1 } },
		{ ...base, live: undefined },
		{ ...base, links: { mtimeMs: 1, entries: 2 } },
		{ ...base, tracked: [{ path: "/a.jsonl", mtimeMs: 2, size: 5 }] },
		{ ...base, tracked: [{ path: "/a.jsonl", mtimeMs: 1, size: 6 }] },
	];
	for (const [i, variant] of variants.entries())
		assert.notEqual(
			fingerprintOf(variant),
			original,
			`variant ${i} must not collide`,
		);
});

test("a session appended to while working invalidates the fingerprint", () => {
	// Directory mtimes do NOT move when a file is appended to -- only the file's
	// own stamp does. This is the case that makes a pure directory fingerprint
	// wrong, so it is pinned explicitly.
	const before = fingerprintOf(base);
	const after = fingerprintOf({
		...base,
		tracked: [{ path: "/a.jsonl", mtimeMs: 99, size: 1234 }],
	});
	assert.notEqual(before, after);
});

test("tracked paths are order-independent", () => {
	const a = { ...base, tracked: [
		{ path: "/a.jsonl", mtimeMs: 1, size: 5 },
		{ path: "/b.jsonl", mtimeMs: 1, size: 5 },
	] };
	const b = { ...base, tracked: [
		{ path: "/b.jsonl", mtimeMs: 1, size: 5 },
		{ path: "/a.jsonl", mtimeMs: 1, size: 5 },
	] };
	assert.equal(fingerprintOf(a), fingerprintOf(b));
});

test("a moved or deleted session file falls out of every cache", () => {
	// The persisted info cache is keyed by path, so a `moveSessionDir` (which
	// renames between slug directories) leaves the old key orphaned. Pruning all
	// three caches against the same live-path set is what stops the on-disk copy
	// growing without bound, so this pins that they agree on what "gone" means.
	const header = new Map([["/old.jsonl", 1], ["/live.jsonl", 2]]);
	const info = new Map([["/old.jsonl", 1], ["/live.jsonl", 2]]);
	const dirs = new Map([["/a", 1], ["/b", 2]]);
	const live = new Set(["/live.jsonl"]);
	const liveDirs = new Set(["/a"]);

	assert.equal(pruneCacheByPath(header, live), 1);
	assert.equal(pruneCacheByPath(info, live), 1);
	assert.equal(pruneCacheByPath(dirs, liveDirs), 1);
	assert.deepEqual([...info.keys()], ["/live.jsonl"]);
});

// ─────────────────────── cache write policy ───────────────────────

test("a clean cache is never written", () => {
	assert.equal(
		shouldFlushCache({ dirty: false, flushedAt: 0, now: 10 * CACHE_FLUSH_MS }),
		false,
	);
});

test("a dirty cache waits out the interval, then writes", () => {
	assert.equal(shouldFlushCache({ dirty: true, flushedAt: 1_000, now: 1_500 }), false);
	assert.equal(
		shouldFlushCache({ dirty: true, flushedAt: 1_000, now: 1_000 + CACHE_FLUSH_MS }),
		true,
	);
	// The first write of a process is not delayed by a zero flushedAt only because
	// time has moved on; pin the boundary explicitly.
	assert.equal(shouldFlushCache({ dirty: true, flushedAt: 0, now: 0 }), false);
});

test("force wins, because shutdown cannot wait for the interval", () => {
	// The case that matters: the process is exiting with a freshly dirty cache and
	// no time left. Skipping the write would silently discard the work.
	assert.equal(
		shouldFlushCache({ dirty: true, flushedAt: 5, now: 6, force: true }),
		true,
	);
	assert.equal(
		shouldFlushCache({ dirty: false, flushedAt: 5, now: 6, force: true }),
		false,
		"nothing to write is still nothing to write",
	);
});

test("the live-record contents are part of the fingerprint, not just their directory", () => {
	// A record is rewritten IN PLACE when a run starts or settles, which does not
	// move the containing directory's mtime (verified). Directory stamps alone would
	// leave a window showing "● working" after the run had already finished.
	const base = {
		dirs: [{ name: "--x--", mtimeMs: 1, entries: 1 }],
		store: { mtimeMs: 1, size: 1 },
		live: { mtimeMs: 1, entries: 1 },
		links: { mtimeMs: 1, entries: 1 },
		tracked: [],
		liveState: "abc:working:100",
	};
	assert.notEqual(
		fingerprintOf(base),
		fingerprintOf({ ...base, liveState: "abc:idle:200" }),
		"a working -> idle flip must invalidate",
	);
	assert.equal(
		fingerprintOf(base),
		fingerprintOf({ ...base, liveState: "abc:working:100" }),
	);
	// Absent (no live records) must be distinct from anything present.
	assert.notEqual(
		fingerprintOf(base),
		fingerprintOf({ ...base, liveState: "" }),
	);
});
