import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	InboxGroups, defaultGroup, groupLabel, inGroup, newAgentGroupForScope,
	sessionGroup, templateDraft,
} from "./groups.ts";

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "inbox-groups-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return new InboxGroups(dir);
}

test("groups persist and membership is optional and exclusive", async (t) => {
	const groups = fixture(t);
	assert.deepEqual(groups.load().groups, []);
	const reviews = await groups.create(" PR reviews ");
	const bugs = await groups.create("Bugs");
	await groups.assign("session", reviews.id);
	assert.equal(sessionGroup(groups.load(), "session")?.name, "PR reviews");
	await groups.assign("session", bugs.id);
	assert.equal(sessionGroup(groups.load(), "session")?.id, bugs.id);
	assert.equal(inGroup(groups.load(), reviews.id, "session"), false);
	assert.equal(inGroup(groups.load(), "all", "session"), true);
	assert.equal(inGroup(groups.load(), "ungrouped", "other"), true);
	await groups.assign("session");
	assert.equal(sessionGroup(groups.load(), "session"), undefined);
	await groups.rename(reviews.id, "Code reviews");
	const reopened = new InboxGroups(join(groups.file, "..")).load();
	assert.equal(groupLabel(reopened, reviews.id), "Code reviews");
	assert.equal(groupLabel(reopened, "all"), "All groups");
});

test("deleting a group ungroups only its sessions", async (t) => {
	const groups = fixture(t);
	const a = await groups.create("A");
	const b = await groups.create("B");
	await groups.assign("one", a.id);
	await groups.assign("two", b.id);
	await groups.remove(a.id);
	assert.equal(sessionGroup(groups.load(), "one"), undefined);
	assert.equal(sessionGroup(groups.load(), "two")?.id, b.id);
	assert.deepEqual(groups.load().sessions, { two: b.id });
	await assert.rejects(groups.assign("one", a.id), /no longer exists/);
});

test("default persists and explicit views override it", async (t) => {
	const groups = fixture(t);
	const reviews = await groups.create("Reviews");
	const bugs = await groups.create("Bugs");
	await groups.setDefaultGroup(reviews.id);
	const reopened = new InboxGroups(join(groups.file, ".."));
	assert.equal(defaultGroup(reopened.load())?.id, reviews.id);
	assert.equal(newAgentGroupForScope(reopened.load(), "all"), reviews.id);
	assert.equal(newAgentGroupForScope(reopened.load(), bugs.id), bugs.id);
	assert.equal(newAgentGroupForScope(reopened.load(), "ungrouped"), undefined);
	await groups.saveTemplate(bugs.id, "unrelated setting");
	assert.equal(defaultGroup(groups.load())?.id, reviews.id);
	await groups.setDefaultGroup();
	assert.equal(defaultGroup(groups.load()), undefined);
	await assert.rejects(groups.setDefaultGroup("unknown"));
});

test("removing the default group clears its setting atomically", async (t) => {
	const groups = fixture(t);
	const group = await groups.create("Reviews");
	await groups.setDefaultGroup(group.id);
	await groups.remove(group.id);
	assert.equal(groups.load().defaultGroupId, undefined);
	assert.equal(newAgentGroupForScope(groups.load(), "all"), undefined);
});

test("stale default ids safely resolve to Ungrouped", (t) => {
	const groups = fixture(t);
	writeFileSync(groups.file, JSON.stringify({
		version: 1, groups: [], sessions: {}, defaultGroupId: "deleted",
	}));
	assert.equal(newAgentGroupForScope(groups.load(), "all"), undefined);
	writeFileSync(groups.file, JSON.stringify({
		version: 1, groups: [], sessions: {}, defaultGroupId: 1,
	}));
	assert.throws(() => groups.load(), /Invalid default group/);
});

test("templates retain their contents when disabled", async (t) => {
	const groups = fixture(t);
	const a = await groups.create("Reviews");
	const template = "Use gh-pr-review\n\nPR: ";
	await groups.setTemplate(a.id, template, true);
	await groups.setTemplate(a.id, template, false);
	assert.deepEqual(groups.load().groups[0], {
		...a, templateEnabled: false, template,
	});
});

test("inline toggle/save change independent template fields", async (t) => {
	const groups = fixture(t);
	const a = await groups.create("Reviews");
	await Promise.all([
		groups.saveTemplate(a.id, "draft\nURL: "),
		groups.toggleTemplate(a.id),
	]);
	assert.equal(groups.load().groups[0].template, "draft\nURL: ");
	assert.equal(groups.load().groups[0].templateEnabled, true);
	const toggled = await groups.toggleTemplate(a.id);
	assert.equal(toggled.templateEnabled, false);
	assert.equal(toggled.template, "draft\nURL: ");
	const saved = await groups.saveTemplate(a.id, "updated");
	assert.equal(saved.templateEnabled, false);
	assert.equal(saved.template, "updated");
});

test("rejects duplicate, reserved and invalid names", async (t) => {
	const groups = fixture(t);
	const a = await groups.create("PR reviews");
	const b = await groups.create("Bugs");
	for (const name of ["pr REVIEWS", "Ungrouped", "All groups", "", "x\ny"]) {
		await assert.rejects(groups.create(name));
	}
	await assert.rejects(groups.rename(b.id, a.name));
	await groups.rename(a.id, "PR Reviews");
	assert.equal(groups.load().groups[0].id, a.id);
});

test("two stores preserve independent memberships", async (t) => {
	const first = fixture(t);
	const second = new InboxGroups(join(first.file, ".."));
	const a = await first.create("A");
	await Promise.all(Array.from({ length: 20 }, (_, i) =>
		(i % 2 ? first : second).assign(`session-${i}`, a.id)));
	assert.equal(Object.keys(first.load().sessions).length, 20);
});

test("invalid stores fail closed without replacing data", async (t) => {
	const groups = fixture(t);
	const broken = "{bad json";
	writeFileSync(groups.file, broken);
	await assert.rejects(groups.create("A"));
	assert.equal(readFileSync(groups.file, "utf8"), broken);
	writeFileSync(groups.file, JSON.stringify({
		version: 99, groups: [], sessions: {},
	}));
	await assert.rejects(groups.create("A"), /refusing to overwrite/);
});

test("concurrent processes don't lose membership updates", async (t) => {
	const groups = fixture(t);
	const a = await groups.create("A");
	const module = new URL("./groups.ts", import.meta.url).href;
	const parent = join(groups.file, "..");
	await Promise.all([0, 1, 2, 3].map((worker) => {
		const script = [
			`import { InboxGroups } from ${JSON.stringify(module)};`,
			`const groups = new InboxGroups(${JSON.stringify(parent)});`,
			"for (let i = 0; i < 12; i++) {",
			`await groups.assign('${worker}-' + i, '${a.id}');`,
			"}",
		].join("\n");
		return promisify(execFile)(process.execPath, [
			"--experimental-transform-types", "--input-type=module", "-e", script,
		]);
	}));
	assert.equal(Object.keys(groups.load().sessions).length, 48);
});

test("template prefill never clobbers an edited draft", () => {
	assert.equal(templateDraft("", undefined, "first"), "first");
	assert.equal(templateDraft("first", "first", "second"), "second");
	assert.equal(templateDraft("first", "first", ""), "");
	assert.equal(templateDraft("first + URL", "first", "second"), "first + URL");
	assert.equal(templateDraft("existing", undefined, "first"), "existing");
});
