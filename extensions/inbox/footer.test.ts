import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	composeFooterLine,
	createGroupNameReader,
	footerParts,
	footerState,
	homeDir,
	patchFooterRender,
	shortenDir,
} from "./footer.ts";

const plain = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

test("homeDir abbreviates only inside the home directory", () => {
	assert.equal(homeDir(homedir()), "~");
	assert.equal(homeDir(join(homedir(), "Code", "x")), "~/Code/x");
	assert.equal(homeDir("/tmp/x"), "/tmp/x");
	assert.equal(homeDir(`${homedir()}2/x`), `${homedir()}2/x`);
	assert.equal(homeDir(""), "");
});

test("shortenDir keeps the last segments", () => {
	assert.equal(shortenDir("~/tickets"), "~/tickets");
	assert.equal(shortenDir("~/a/b/c/d"), "…/c/d");
});

test("group leads, session name follows, dir and branch go right", () => {
	const line = composeFooterLine(
		{
			group: "GSI Data Platform",
			name: "EC Feedback Follow-up PRs",
			dir: "~/Code/worktrees/tas-tools-ui/notes-hide-machine/tickets",
			branch: "ppark/feat/notes-hide-machine",
		},
		200,
		plain,
	);
	assert.ok(line);
	assert.ok(line.startsWith("GSI Data Platform • EC Feedback Follow-up PRs"));
	assert.ok(line.endsWith("(ppark/feat/notes-hide-machine)"));
	assert.ok(line.includes("…/notes-hide-machine/tickets"));
	assert.equal(visibleWidth(line!), 200);
});

test("narrow widths drop the branch, then the directory, never the group", () => {
	const parts = {
		group: "G",
		name: "Title",
		dir: "~/Code/worktrees/tas-tools-ui/notes-hide-machine/tickets",
		branch: "branch-name",
	};
	let sawBranch = false;
	let sawDirOnly = false;
	for (const width of [120, 80, 60, 40, 30, 20, 10, 4]) {
		const line = composeFooterLine(parts, width, plain);
		assert.ok(line !== undefined, `width ${width}`);
		assert.ok(visibleWidth(line!) <= width, `width ${width}: ${line}`);
		assert.ok(line!.startsWith("G"), `width ${width}: ${line}`);
		if (line!.includes("(branch-name)")) sawBranch = true;
		if (/…\/.+\/tickets$/.test(line!)) sawDirOnly = true;
	}
	// Wide enough keeps the branch; then only the path; then the leaf alone.
	assert.ok(sawBranch, "a wide line keeps the branch");
	assert.ok(sawDirOnly, "a medium line keeps the path without the branch");
	assert.equal(composeFooterLine(parts, 80, plain)!.endsWith("(branch-name)"), true);
	assert.equal(composeFooterLine(parts, 40, plain)!.endsWith("tickets"), true);
	assert.equal(composeFooterLine(parts, 40, plain)!.includes("branch-name"), false);
	assert.equal(composeFooterLine(parts, 20, plain)!.includes("tickets"), true);
	// Too narrow for even the first character: an ellipsis survives.
	assert.equal(visibleWidth(composeFooterLine(parts, 1, plain)!), 1);
});

test("ungrouped sessions lead with the session name", () => {
	const line = composeFooterLine(
		{ name: "Just a session", dir: "~/x", branch: "main" },
		80,
		plain,
	);
	assert.ok(line!.startsWith("Just a session"));
	assert.ok(line!.endsWith("~/x (main)"));
});

test("no group and no name leaves pi's own first line alone", () => {
	assert.equal(
		composeFooterLine({ dir: "~/x", branch: "main" }, 80, plain),
		undefined,
	);
});

test("a group name is cached between renders and refreshed on demand", () => {
	let reads = 0;
	const read = () => {
		reads++;
		return {
			groups: [{ id: "g1", name: "Group One" }],
			sessions: { s1: "g1" },
		};
	};
	const groupName = createGroupNameReader(read);
	assert.equal(groupName("s1"), "Group One");
	assert.equal(groupName("s1"), "Group One");
	assert.equal(reads, 1);
	assert.equal(groupName("s2"), undefined); // ungrouped
	groupName.invalidate();
	assert.equal(groupName("s1"), "Group One");
	assert.equal(groupName("s2"), undefined);
	assert.equal(reads, 4);
});

test("a broken group store must not break the footer", () => {
	const groupName = createGroupNameReader(() => {
		throw new Error("bad json");
	});
	assert.equal(groupName("s1"), undefined);
});

function fakeFooter(cwd: string) {
	return {
		session: {
			sessionManager: {
				getSessionId: () => "s1",
				getSessionName: () => "Session title",
				getCwd: () => cwd,
			},
		},
		footerData: { getGitBranch: () => "main" },
	};
}

test("footerParts reads group, title, dir and branch", () => {
	assert.deepEqual(
		footerParts(fakeFooter(join(homedir(), "Code", "proj")), () => "G"),
		{
			group: "G",
			name: "Session title",
			dir: "~/Code/proj",
			branch: "main",
		},
	);
	assert.equal(footerParts({}, () => "G"), undefined);
});

test("patchFooterRender rebuilds only line 0 and patches once", () => {
	const cwd = join(homedir(), "Code", "proj");
	class Fake extends Object {
		session = fakeFooter(cwd).session;
		footerData = fakeFooter(cwd).footerData;
		lines = ["~/Code/proj (main) • Session title", "↑1 ↓2", "status"];
		render() {
			return this.lines;
		}
	}
	const state = footerState();
	state.groupName = () => "Group One";
	state.theme = plain;
	patchFooterRender(Fake);
	const first = Fake.prototype.render;
	assert.equal(footerState().patched, true);

	const rendered = new Fake().render(60);
	assert.equal(rendered.length, 3);
	assert.ok(rendered[0].startsWith("Group One • Session title"));
	assert.ok(rendered[0].endsWith("~/Code/proj (main)"));
	assert.deepEqual(rendered.slice(1), ["↑1 ↓2", "status"]);

	// /reload swaps the reader without stacking a second wrapper.
	state.groupName = () => "Renamed group";
	patchFooterRender(Fake);
	assert.equal(Fake.prototype.render, first);
	const reread = new Fake().render(60);
	assert.ok(reread[0].startsWith("Renamed group • Session title"));

	state.groupName = () => undefined;
});

test("an unfamiliar footer shape keeps pi's own lines", () => {
	class Broken {
		render() {
			return ["only line"];
		}
	}
	const state = footerState();
	state.groupName = () => "G";
	state.theme = plain;
	patchFooterRender(Broken);
	assert.deepEqual(new Broken().render(40), ["only line"]);
	state.groupName = () => undefined;
});
