import assert from "node:assert/strict";
import { test } from "node:test";
import { sectionByGroup } from "./group-layout.ts";
import type { GroupStore } from "./groups.ts";

const store: GroupStore = {
	version: 1,
	groups: ["Z Reviews", "A Bugs", "Empty"].map((name) => ({
		id: name, name, template: "", templateEnabled: false,
	})),
	sessions: {
		pin: "Z Reviews", recent: "Z Reviews", old: "Z Reviews",
		bug: "A Bugs", orphan: "deleted",
	},
};

test("sections are alphabetical, nonempty, with Ungrouped last", () => {
	const ids = ["recent", "none", "bug"];
	const sections = sectionByGroup(ids, store, (id) => id);
	assert.deepEqual(sections.map((section) => section.name), [
		"A Bugs", "Z Reviews", "Ungrouped",
	]);
	assert.deepEqual(sections.map((section) => section.rows), [
		["bug"], ["recent"], ["none"],
	]);
	assert.deepEqual(ids, ["recent", "none", "bug"]);
	assert.deepEqual(store.groups.map((group) => group.name), [
		"Z Reviews", "A Bugs", "Empty",
	]);
});

test("grouping preserves pre-sorted row order and object identity", () => {
	const rows = ["pin", "bug", "recent", "old"].map((id) => ({ id }));
	const sections = sectionByGroup(rows, store, (row) => row.id);
	assert.deepEqual(sections[1].rows.map((row) => row.id), [
		"pin", "recent", "old",
	]);
	assert.equal(sections[1].rows[0], rows[0]);
});

test("missing/deleted memberships go to Ungrouped", () => {
	assert.deepEqual(sectionByGroup(["orphan", "none"], store, (id) => id), [
		{ name: "Ungrouped", rows: ["orphan", "none"] },
	]);
});

test("an empty filtered list has no sections or headers", () => {
	assert.deepEqual(sectionByGroup([], store, (id: string) => id), []);
});
