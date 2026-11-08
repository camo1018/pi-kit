import assert from "node:assert/strict";
import { test } from "node:test";
import { liftManualFiling } from "./index.ts";

// The un-archive feature itself. A wake is a prompt, and a prompt in a filed
// session lifts the filing: that is how a premature archive (you archived while
// the session's children were still running) gets corrected when they settle.
//
// This was previously untested. The session-workers tests only proved "no
// archive-based suppression exists", which is a different claim: they write an
// inbox.json mark that wake.ts no longer reads, so they pass whether or not
// this path works at all.

test("an archived session is returned to the inbox", () => {
	const meta = { archivedAt: 1_700_000_000_000 };
	assert.equal(liftManualFiling(meta), true);
	assert.equal(meta.archivedAt, undefined);
});

test("a manually hidden session is returned to the inbox", () => {
	const meta = { filter: "hide" as const };
	assert.equal(liftManualFiling(meta), true);
	assert.equal(meta.filter, undefined);
});

test("both are lifted in one pass", () => {
	const meta = { archivedAt: 1, filter: "hide" as const };
	assert.equal(liftManualFiling(meta), true);
	assert.equal(meta.archivedAt, undefined);
	assert.equal(meta.filter, undefined);
});

test("an explicit show override survives, and nothing else changes", () => {
	// `filter: "show"` means "keep this in despite a matching rule". It is not a
	// manual filing, so a prompt must not clear it.
	const meta = {
		filter: "show" as const,
		pinnedAt: 5,
		seenAt: 6,
	};
	assert.equal(liftManualFiling(meta), false);
	assert.equal(meta.filter, "show");
	assert.equal(meta.pinnedAt, 5);
	assert.equal(meta.seenAt, 6);
});

test("an unfiled session is left untouched", () => {
	const meta = {};
	assert.equal(liftManualFiling(meta), false);
	assert.deepEqual(meta, {});
});
