import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import {
	projectFamilies,
	readWorkerLinks,
	WorkerFolds,
	type WorkerLink,
} from "./families.ts";

const id = (row: string) => row;
const collapsed = { id, expanded: new Set<string>() };
const links: WorkerLink[] = [
	{ id: "late", parentId: "parent", createdAt: 20 },
	{ id: "early-b", parentId: "parent", createdAt: 10 },
	{ id: "early-a", parentId: "parent", createdAt: 10 },
];
const rows = ["late", "other", "parent", "early-b", "early-a"];

function temporaryDir(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-families-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("families default collapsed and keep ordered roots and summaries", () => {
	const result = projectFamilies(rows, rows, links, collapsed);
	assert.deepEqual(
		result.map((item) => item.row),
		["other", "parent"],
	);
	assert.deepEqual(result[1], {
		row: "parent",
		child: false,
		lastChild: false,
		children: ["early-a", "early-b", "late"],
		expanded: false,
		contextOnly: false,
	});
	assert.deepEqual(rows, ["late", "other", "parent", "early-b", "early-a"]);
	assert.equal(links[0].id, "late");
});

test("expanded children use creation time, ID, and last-child marks", () => {
	const result = projectFamilies(rows, rows, links, {
		id,
		expanded: new Set(["parent"]),
	});
	assert.deepEqual(
		result.map((item) => item.row),
		["other", "parent", "early-a", "early-b", "late"],
	);
	assert.deepEqual(
		result.slice(2).map((item) => ({
			parent: item.parentId,
			child: item.child,
			last: item.lastChild,
		})),
		[
			{ parent: "parent", child: true, last: false },
			{ parent: "parent", child: true, last: false },
			{ parent: "parent", child: true, last: true },
		],
	);
	assert.equal(result[1].expanded, true);
});

test("filtered children include parent context and force expansion", () => {
	const saved = new Set<string>();
	const result = projectFamilies(rows, ["late", "other"], links, {
		id,
		expanded: saved,
		forceExpand: true,
	});
	assert.deepEqual(
		result.map((item) => item.row),
		["parent", "late", "other"],
	);
	assert.equal(result[0].contextOnly, true);
	assert.deepEqual(result[0].children, ["late"]);
	assert.equal(result[1].contextOnly, false);
	assert.equal(result[1].lastChild, true);
	assert.equal(saved.size, 0);
	assert.deepEqual(projectFamilies(rows, [], links, collapsed), []);
});

test("matching parent only never exposes ineligible children", () => {
	const result = projectFamilies(rows, ["parent"], links, {
		...collapsed,
		forceExpand: true,
	});
	assert.equal(result.length, 1);
	assert.deepEqual(result[0].children, []);
	assert.equal(result[0].expanded, false);
});

test("missing parent does not hide an orphan or unrelated session", () => {
	const result = projectFamilies(
		["late", "other"],
		["late", "other"],
		links,
		collapsed,
	);
	assert.deepEqual(
		result.map((item) => item.row),
		["late", "other"],
	);
	assert.ok(result.every((item) => !item.child));
});

test("malformed self links, cycles, and deeper links never hide rows", () => {
	const bad: WorkerLink[] = [
		{ id: "a", parentId: "b", createdAt: 1 },
		{ id: "b", parentId: "a", createdAt: 2 },
		{ id: "self", parentId: "self", createdAt: 3 },
		{ id: "child", parentId: "root", createdAt: 4 },
		{ id: "deep", parentId: "child", createdAt: 5 },
		{ id: "invalid", parentId: "root", createdAt: NaN },
	];
	const all = ["a", "b", "self", "root", "child", "deep", "invalid"];
	const result = projectFamilies(all, all, bad, {
		...collapsed,
		forceExpand: true,
	});
	assert.deepEqual(
		result.map((item) => item.row),
		all,
	);
	assert.deepEqual(
		result.filter((item) => item.child).map((item) => item.row),
		["child"],
	);
});

test("duplicate eligible IDs and duplicate links produce each row once", () => {
	const all = [{ id: "p" }, { id: "c" }, { id: "q" }];
	const result = projectFamilies(
		all,
		[all[1], ...all],
		[
			{ id: "c", parentId: "p", createdAt: 1 },
			{ id: "c", parentId: "q", createdAt: 2 },
			{ id: "c", parentId: "p", createdAt: 1 },
		],
		{ id: (row) => row.id, expanded: new Set(["p", "q"]) },
	);
	assert.deepEqual(
		result.map((item) => item.row.id),
		["p", "c", "q"],
	);
	assert.equal(result[0].row, all[0]);
	assert.equal(result[1].row, all[1]);
	assert.equal(result[0].children[0], all[1]);
});

test("worker loading is read-only, validated, sorted, and fail-open", (t) => {
	const agent = temporaryDir(t);
	assert.deepEqual(readWorkerLinks(agent), []);
	const dir = path.join(agent, "session-workers", "workers");
	fs.mkdirSync(dir, { recursive: true });
	const records = {
		late: links[0],
		"early-b": links[1],
		"early-a": { ...links[2], extra: "not returned" },
		wrong: { id: "different", parentId: "parent", createdAt: 1 },
		self: { id: "self", parentId: "self", createdAt: 1 },
		negative: { id: "negative", parentId: "parent", createdAt: -1 },
		string: { id: "string", parentId: "parent", createdAt: "1" },
		path: { id: "path", parentId: "../parent", createdAt: 1 },
		null: null,
	};
	for (const [name, record] of Object.entries(records)) {
		fs.writeFileSync(
			path.join(dir, `${name}.json`),
			JSON.stringify(record),
		);
	}
	fs.writeFileSync(path.join(dir, "partial.json"), "{");
	fs.writeFileSync(path.join(dir, "ignored.txt"), JSON.stringify(links[0]));
	fs.mkdirSync(path.join(dir, "directory.json"));
	const before = fs.readdirSync(dir).sort();
	assert.deepEqual(readWorkerLinks(agent), [links[2], links[1], links[0]]);
	assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test("folds default collapsed and preserve other window preferences", (t) => {
	const agent = temporaryDir(t);
	const first = new WorkerFolds(agent);
	const second = new WorkerFolds(agent);
	assert.equal(first.load().size, 0);
	first.setExpanded("one", true);
	second.setExpanded("two", true);
	assert.deepEqual(first.load(), new Set(["one", "two"]));
	first.setExpanded("one", false);
	assert.deepEqual(second.load(), new Set(["two"]));
	second.setExpanded("two", false);
	assert.equal(first.load().size, 0);
	assert.deepEqual(fs.readdirSync(agent), ["inbox-worker-folds.json"]);
});

test("invalid folds are not overwritten and mutation lock is cleaned", (t) => {
	const agent = temporaryDir(t);
	const folds = new WorkerFolds(agent);
	for (const raw of ["{", '{"version":1,"expanded":[42]}']) {
		fs.writeFileSync(folds.file, raw);
		assert.throws(() => folds.load());
		assert.throws(() => folds.setExpanded("parent", true));
		assert.equal(fs.readFileSync(folds.file, "utf8"), raw);
		assert.deepEqual(fs.readdirSync(agent), ["inbox-worker-folds.json"]);
	}
	assert.throws(() => folds.setExpanded("../parent", true));
});

test("parallel processes serialize fold read/modify/write", async (t) => {
	const agent = temporaryDir(t);
	const module = new URL("./families.ts", import.meta.url).href;
	const run = (name: string) =>
		new Promise<void>((resolve, reject) => {
			const code = [
				`import { WorkerFolds } from ${JSON.stringify(module)};`,
				`new WorkerFolds(${JSON.stringify(agent)})`,
				`.setExpanded(${JSON.stringify(name)}, true);`,
			].join("\n");
			const child = spawn(
				process.execPath,
				[
					"--experimental-transform-types",
					"--input-type=module",
					"-e",
					code,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			let errors = "";
			child.stderr.on("data", (data) => {
				errors += data;
			});
			child.on("error", reject);
			child.on("exit", (status) => {
				if (status === 0) resolve();
				else reject(new Error(errors));
			});
		});
	const ids = Array.from({ length: 8 }, (_, index) => `parent-${index}`);
	await Promise.all(ids.map(run));
	assert.deepEqual(new WorkerFolds(agent).load(), new Set(ids));
	assert.deepEqual(fs.readdirSync(agent), ["inbox-worker-folds.json"]);
});
