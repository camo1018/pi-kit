import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	SessionManager,
	type ExtensionAPI,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import sessionMention, { clearSessionCache } from "./index.ts";

test("expands only the request clone and autocomplete inserts the id", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	// Real files, not a listAll stub: expansion and the picker both read the
	// session tree themselves now, so a stub would leave the real path untested
	// (and silently back on the archived-scan cost).
	writeSession(tmpDir, "--tmp-project--", "session-id", {
		name: "shared title",
	});
	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: {} }),
	);
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	try {
		sessionMention(pi);
		assert.equal(handlers.has("input"), false);
		const stored = {
			role: "user",
			content: "review @[session-id]",
		};
		const requestCopy = structuredClone(stored);
		await handlers.get("context")?.({ messages: [requestCopy] });

		assert.equal(stored.content, "review @[session-id]");
		assert.match(requestCopy.content, /^<skill\b/);
		assert.match(requestCopy.content, /«shared title»/);
		assert.doesNotMatch(requestCopy.content, /@\[session-id\]/);

		let providerFactory: ((current: any) => any) | undefined;
		handlers.get("session_start")?.({}, {
			sessionManager: {
				getSessionId: () => "current-session-id",
			},
			ui: {
				addAutocompleteProvider(factory: (current: any) => any) {
					providerFactory = factory;
				},
			},
		});
		const current = {
			getSuggestions() {
				return null;
			},
			applyCompletion() {
				throw new Error("not used");
			},
		};
		const provider = providerFactory?.(current);
		const suggestions = await provider.getSuggestions(
			["@["],
			0,
			2,
			{},
		);
		assert.equal(suggestions.items[0].value, "@[session-id]");
		assert.equal(suggestions.items[0].label, "shared title");

		const applied = provider.applyCompletion(
			["hello @["],
			0,
			8,
			suggestions.items[0],
			"@[",
		);
		assert.deepEqual(applied.lines, ["hello @[session-id] "]);
	} finally {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@g[ shows placeholder when session has no group", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;

	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	try {
		sessionMention(pi);
		let providerFactory: ((current: any) => any) | undefined;
		handlers.get("session_start")?.({}, {
			sessionManager: {
				getSessionId: () => "my-ungrouped-session",
			},
			ui: {
				addAutocompleteProvider(factory: (current: any) => any) {
					providerFactory = factory;
				},
			},
		});
		const current = {
			getSuggestions() {
				return null;
			},
			applyCompletion() {
				throw new Error("not used");
			},
		};
		const provider = providerFactory?.(current);
		const suggestions = await provider.getSuggestions(
			["@g["],
			0,
			3,
			{},
		);
		assert.equal(suggestions.items.length, 1);
		assert.equal(suggestions.items[0].value, "");
		assert.equal(suggestions.items[0].label, "(No group for this session)");

		// Applying placeholder completion is a no-op
		const applied = provider.applyCompletion(
			["see @g["],
			0,
			7,
			suggestions.items[0],
			"@g[",
		);
		assert.deepEqual(applied.lines, ["see @g["]);
	} finally {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@g[ filters specifically for other sessions in the same group", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;

	fs.writeFileSync(
		path.join(tmpDir, "inbox-groups.json"),
		JSON.stringify({
			version: 1,
			groups: [{ id: "grp-1", name: "Feature Team", templateEnabled: false, template: "" }],
			sessions: {
				"current-session": "grp-1",
				"session-in-group": "grp-1",
				"session-id": "grp-2",
			},
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: {} }),
	);
	writeSession(tmpDir, "--tmp-project--", "session-in-group", {
		name: "group sibling title",
		mtime: new Date(2026, 0, 2),
	});
	writeSession(tmpDir, "--tmp-project--", "session-id", {
		name: "a different group",
		mtime: new Date(2026, 0, 3),
	});

	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	try {
		sessionMention(pi);
		let providerFactory: ((current: any) => any) | undefined;
		handlers.get("session_start")?.({}, {
			sessionManager: {
				getSessionId: () => "current-session",
			},
			ui: {
				addAutocompleteProvider(factory: (current: any) => any) {
					providerFactory = factory;
				},
			},
		});
		const current = {
			getSuggestions() {
				return null;
			},
			applyCompletion() {
				throw new Error("not used");
			},
		};
		const provider = providerFactory?.(current);
		const suggestions = await provider.getSuggestions(
			["@g["],
			0,
			3,
			{},
		);
		// Only the grp-1 sibling is returned, NOT the grp-2 one and NOT
		// current-session.
		assert.equal(suggestions.items.length, 1);
		assert.equal(suggestions.items[0].value, "@[session-in-group]");
		assert.equal(suggestions.items[0].label, "group sibling title");

		const applied = provider.applyCompletion(
			["look at @g["],
			0,
			11,
			suggestions.items[0],
			"@g[",
		);
		assert.deepEqual(applied.lines, ["look at @[session-in-group] "]);
	} finally {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

function groupFixture(tmpDir: string) {
	fs.writeFileSync(
		path.join(tmpDir, "inbox-groups.json"),
		JSON.stringify({
			version: 1,
			groups: [{
				id: "grp-1",
				name: "Feature Team",
				templateEnabled: false,
				template: "",
			}],
			sessions: {
				"current-session": "grp-1",
				"session-in-group": "grp-1",
				"session-archived": "grp-1",
			},
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: { "session-archived": { archivedAt: 1 } },
		}),
	);
	writeSession(tmpDir, "--tmp-project--", "session-in-group", {
		name: "group sibling title",
		mtime: new Date(2026, 0, 2),
	});
	writeSession(tmpDir, "--tmp-project--", "session-archived", {
		name: "archived sibling title",
		mtime: new Date(2026, 0, 3),
	});
}

test("@g[ hides archived siblings; @ga[ includes them", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	groupFixture(tmpDir);

	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	try {
		sessionMention(pi);
		let providerFactory: ((current: any) => any) | undefined;
		handlers.get("session_start")?.({}, {
			sessionManager: {
				getSessionId: () => "current-session",
			},
			ui: {
				addAutocompleteProvider(factory: (current: any) => any) {
					providerFactory = factory;
				},
			},
		});
		const provider = providerFactory?.({
			getSuggestions() {
				return null;
			},
			applyCompletion() {
				throw new Error("not used");
			},
		});

		const active = await provider.getSuggestions(["@g["], 0, 3, {});
		assert.deepEqual(
			active.items.map((item: any) => item.value),
			["@[session-in-group]"],
		);

		const all = await provider.getSuggestions(["@ga["], 0, 4, {});
		assert.deepEqual(
			all.items.map((item: any) => item.value).sort(),
			["@[session-archived]", "@[session-in-group]"],
		);
		assert.equal(all.prefix, "@ga[");

		const applied = provider.applyCompletion(
			["read @ga["],
			0,
			9,
			all.items.find(
				(item: any) => item.value === "@[session-archived]",
			),
			"@ga[",
		);
		assert.deepEqual(applied.lines, ["read @[session-archived] "]);
	} finally {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@g[ placeholder points at @ga[ when only archived siblings exist", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	groupFixture(tmpDir);
	// Only the archived member is left in the group.
	fs.writeFileSync(
		path.join(tmpDir, "inbox-groups.json"),
		JSON.stringify({
			version: 1,
			groups: [{
				id: "grp-1",
				name: "Feature Team",
				templateEnabled: false,
				template: "",
			}],
			sessions: {
				"current-session": "grp-1",
				"session-archived": "grp-1",
			},
		}),
	);
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	try {
		sessionMention(pi);
		let providerFactory: ((current: any) => any) | undefined;
		handlers.get("session_start")?.({}, {
			sessionManager: {
				getSessionId: () => "current-session",
			},
			ui: {
				addAutocompleteProvider(factory: (current: any) => any) {
					providerFactory = factory;
				},
			},
		});
		const provider = providerFactory?.({
			getSuggestions() {
				return null;
			},
			applyCompletion() {
				throw new Error("not used");
			},
		});

		const active = await provider.getSuggestions(["@g["], 0, 3, {});
		assert.equal(active.items.length, 1);
		assert.equal(active.items[0].value, "");
		assert.match(active.items[0].description, /@ga\[/);
	} finally {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

/**
 * A composing session has no membership on disk yet: the inbox keeps the
 * destination on its pending reply target / pre-pick globals and only writes
 * inbox-groups.json when the agent spawns. @g[ must read those, not claim the
 * composer is ungrouped.
 */
async function composeFixture(
	tmpDir: string,
	globals: Record<string | symbol, unknown>,
) {
	fs.writeFileSync(
		path.join(tmpDir, "inbox-groups.json"),
		JSON.stringify({
			version: 1,
			groups: [{
				id: "grp-1",
				name: "Feature Team",
				templateEnabled: false,
				template: "",
			}],
			sessions: { "session-in-group": "grp-1" },
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: {} }),
	);
	writeSession(tmpDir, "--tmp-project--", "session-in-group", {
		name: "group sibling title",
		mtime: new Date(2026, 0, 2),
	});
	return setInboxGlobals(globals);
}

/**
 * Install the inbox's pending-action globals for the duration of a test.
 * Symbol keys are the inbox's own; Object.entries would skip them.
 */
function setInboxGlobals(
	globals: Record<string | symbol, unknown>,
): () => void {
	const saved = new Map<string | symbol, unknown>();
	for (const key of Reflect.ownKeys(globals)) {
		saved.set(key, (globalThis as any)[key]);
		(globalThis as any)[key] = globals[key as keyof typeof globals];
	}
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete (globalThis as any)[key];
			else (globalThis as any)[key] = value;
		}
	};
}

async function suggestionsFor(
	trigger: string,
	sessionId: string,
): Promise<any> {
	const handlers = new Map<string, (...args: any[]) => any>();
	sessionMention({
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);
	let providerFactory: ((current: any) => any) | undefined;
	handlers.get("session_start")?.({}, {
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			addAutocompleteProvider(factory: (current: any) => any) {
				providerFactory = factory;
			},
		},
	});
	const provider = providerFactory?.({
		getSuggestions() {
			return null;
		},
		applyCompletion() {
			throw new Error("not used");
		},
	});
	return provider.getSuggestions([trigger], 0, trigger.length, {});
}

test("@g[ uses the pending new-agent group while composing", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	let restore = await composeFixture(tmpDir, {
		[Symbol.for("pi.inbox.reply-target")]: {
			kind: "new",
			cwd: "/tmp/project",
			groupId: "grp-1",
		},
	});
	try {
		const suggestions = await suggestionsFor(
			"@g[",
			"brand-new-composer",
		);
		assert.deepEqual(
			suggestions.items.map((item: any) => item.value),
			["@[session-in-group]"],
		);
	} finally {
		restore();
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@g[ falls back to the one-off pre-pick (F) while composing", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	const restore = await composeFixture(tmpDir, {
		[Symbol.for("pi.inbox.next-agent-group")]: "grp-1",
	});
	try {
		const suggestions = await suggestionsFor("@g[", "brand-new-composer");
		assert.deepEqual(
			suggestions.items.map((item: any) => item.value),
			["@[session-in-group]"],
		);
	} finally {
		restore();
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@g[ follows the agent you are replying to, not your own group", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	fs.writeFileSync(
		path.join(tmpDir, "inbox-groups.json"),
		JSON.stringify({
			version: 1,
			groups: [
				{ id: "grp-1", name: "Feature Team", templateEnabled: false, template: "" },
				{ id: "grp-2", name: "Other Team", templateEnabled: false, template: "" },
			],
			sessions: {
				"current-session": "grp-1",
				"sibling-here": "grp-1",
				"sibling-there": "grp-2",
				"target-agent": "grp-2",
			},
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: {} }),
	);
	writeSession(tmpDir, "--tmp-project--", "sibling-here", {
		name: "sibling in my group",
	});
	writeSession(tmpDir, "--tmp-project--", "sibling-there", {
		name: "sibling in the target's group",
	});
	// Replying to an agent in grp-2: the work lands in grp-2, so @g[ must list
	// grp-2's siblings rather than the sender's own grp-1.
	const restore = setInboxGlobals({
		[Symbol.for("pi.inbox.reply-target")]: {
			kind: "agent",
			id: "target-agent",
			title: "target",
			cwd: "/tmp/project",
		},
	});
	try {
		const suggestions = await suggestionsFor("@g[", "current-session");
		assert.deepEqual(
			suggestions.items.map((item: any) => item.value),
			["@[sibling-there]"],
		);
	} finally {
		restore();
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@g[ follows a composed new-agent group over the sender's own", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	fs.writeFileSync(
		path.join(tmpDir, "inbox-groups.json"),
		JSON.stringify({
			version: 1,
			groups: [
				{ id: "grp-1", name: "Feature Team", templateEnabled: false, template: "" },
				{ id: "grp-2", name: "Other Team", templateEnabled: false, template: "" },
			],
			sessions: {
				"current-session": "grp-1",
				"sibling-here": "grp-1",
				"sibling-there": "grp-2",
			},
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: {} }),
	);
	writeSession(tmpDir, "--tmp-project--", "sibling-here", {
		name: "sibling in my group",
	});
	writeSession(tmpDir, "--tmp-project--", "sibling-there", {
		name: "sibling in the composed group",
	});
	const restore = setInboxGlobals({
		[Symbol.for("pi.inbox.reply-target")]: {
			kind: "new",
			cwd: "/tmp/project",
			groupId: "grp-2",
		},
	});
	try {
		const suggestions = await suggestionsFor("@g[", "current-session");
		assert.deepEqual(
			suggestions.items.map((item: any) => item.value),
			["@[sibling-there]"],
		);
	} finally {
		restore();
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("a composed 'ungrouped' pre-pick still beats the current view", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	const restore = await composeFixture(tmpDir, {
		[Symbol.for("pi.inbox.next-agent-group")]: "ungrouped",
		[Symbol.for("pi.inbox.group-view")]: "grp-1",
	});
	try {
		const suggestions = await suggestionsFor("@g[", "brand-new-composer");
		assert.equal(suggestions.items.length, 1);
		assert.equal(suggestions.items[0].value, "");
	} finally {
		restore();
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@g[ does not borrow a view filter's group outside the orchestrator", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	// A group view left over from another window, but no orchestration: a plain
	// foreground session stays ungrouped rather than inheriting the filter.
	const restore = await composeFixture(tmpDir, {
		[Symbol.for("pi.inbox.group-view")]: "grp-1",
	});
	try {
		const suggestions = await suggestionsFor("@g[", "plain-session");
		assert.equal(suggestions.items.length, 1);
		assert.equal(suggestions.items[0].value, "");
	} finally {
		restore();
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

/**
 * The group path resolves members from filenames so it never full-parses the
 * session tree. These tests write real session files and assert both the
 * result and that non-member files are never opened.
 */
function writeSession(
	dir: string,
	cwdSlug: string,
	id: string,
	options: { name?: string; messages?: number; mtime?: Date } = {},
): string {
	const dirPath = path.join(dir, "sessions", cwdSlug);
	fs.mkdirSync(dirPath, { recursive: true });
	const file = path.join(
		dirPath,
		`2026-01-01T00-00-00-000Z_${id}.jsonl`,
	);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: `/tmp/${cwdSlug}`,
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			message: {
				role: "user",
				content: `first prompt for ${id}`,
				timestamp: 1,
			},
		}),
	];
	if (options.name) {
		lines.push(JSON.stringify({
			type: "session_info",
			id: "n1",
			parentId: "m1",
			name: options.name,
		}));
	}
	for (let i = 1; i < (options.messages ?? 1); i++) {
		lines.push(JSON.stringify({
			type: "message",
			id: `m${i + 1}`,
			parentId: `m${i}`,
			message: {
				role: "assistant",
				content: `reply ${i}`,
				timestamp: 2,
			},
		}));
	}
	fs.writeFileSync(file, lines.join("\n") + "\n");
	if (options.mtime) fs.utimesSync(file, options.mtime, options.mtime);
	return file;
}

test("@g[ resolves members from filenames, without listAll()", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;

	fs.writeFileSync(
		path.join(tmpDir, "inbox-groups.json"),
		JSON.stringify({
			version: 1,
			groups: [{
				id: "grp-1",
				name: "Feature Team",
				templateEnabled: false,
				template: "",
			}],
			sessions: {
				"current-session": "grp-1",
				"member-named": "grp-1",
				"member-plain": "grp-1",
				"outsider": "grp-2",
			},
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: {} }),
	);
	writeSession(tmpDir, "--tmp-project--", "member-named", {
		name: "a named sibling",
		messages: 3,
	});
	writeSession(tmpDir, "--tmp-project--", "member-plain");
	const outsider = writeSession(tmpDir, "--tmp-other--", "outsider", {
		name: "must not be read",
		mtime: new Date(),
	});

	// Any call to pi's full scan means the fast path was skipped.
	let listed = 0;
	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => {
		listed++;
		return originalListAll();
	};
	// Provenance: a corrupt non-member file would break the listing if the
	// group path ever read it, so make one and assert the listing still works.
	fs.writeFileSync(outsider, "{not json\n");

	try {
		const suggestions = await suggestionsFor("@g[", "current-session");
		const values = suggestions.items.map((item: any) => item.value).sort();
		assert.deepEqual(
			values,
			["@[member-named]", "@[member-plain]"],
		);
		assert.equal(listed, 0, "group lookup must not full-scan");
		// The real name is shown, read from the tail of the member's file.
		const named = suggestions.items.find(
			(item: any) => item.value === "@[member-named]",
		);
		assert.equal(named.label, "a named sibling");
	} finally {
		(SessionManager as any).listAll = originalListAll;
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@g[ skips a member whose file is gone instead of full-scanning", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;

	fs.writeFileSync(
		path.join(tmpDir, "inbox-groups.json"),
		JSON.stringify({
			version: 1,
			groups: [{
				id: "grp-1",
				name: "Feature Team",
				templateEnabled: false,
				template: "",
			}],
			sessions: {
				"current-session": "grp-1",
				"member-named": "grp-1",
				"member-missing": "grp-1",
			},
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: {} }),
	);
	writeSession(tmpDir, "--tmp-project--", "member-named", {
		name: "a named sibling",
	});
	// member-missing has no file on disk: a deleted session whose group
	// membership outlived it. It must be skipped, not paid for with a full
	// scan of every session (which is seconds per keystroke on a real tree).
	let listed = 0;
	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => {
		listed++;
		return [] as SessionInfo[];
	};

	try {
		const suggestions = await suggestionsFor("@g[", "current-session");
		assert.deepEqual(
			suggestions.items.map((item: any) => item.value),
			["@[member-named]"],
		);
		assert.equal(listed, 0, "a missing member must not trigger a full scan");
	} finally {
		(SessionManager as any).listAll = originalListAll;
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@g[ finds a member whose transcript file was renamed", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;

	fs.writeFileSync(
		path.join(tmpDir, "inbox-groups.json"),
		JSON.stringify({
			version: 1,
			groups: [{
				id: "grp-1",
				name: "Feature Team",
				templateEnabled: false,
				template: "",
			}],
			sessions: {
				"current-session": "grp-1",
				"member-renamed": "grp-1",
			},
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: {} }),
	);
	// The file name no longer ends in the id, but its header still carries it.
	const file = writeSession(tmpDir, "--tmp-project--", "member-renamed", {
		name: "a renamed sibling",
	});
	const renamed = file.replace("2026-01-01T00-00-00-000Z_", "");
	assert.notEqual(renamed, file);
	fs.renameSync(file, renamed);

	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => {
		throw new Error("a renamed member must not force a full scan");
	};

	try {
		const suggestions = await suggestionsFor("@g[", "current-session");
		assert.deepEqual(
			suggestions.items.map((item: any) => item.value),
			["@[member-renamed]"],
		);
		assert.equal(suggestions.items[0].label, "a renamed sibling");
	} finally {
		(SessionManager as any).listAll = originalListAll;
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@[ lists only unarchived sessions, skipping archived files entirely", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;

	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: { "old-archived": { archivedAt: 1 } },
		}),
	);
	writeSession(tmpDir, "--tmp-project--", "live-one", {
		name: "a live session",
	});
	// Valid and non-empty, so it appears in the list unless the archive filter
	// actually ran.
	writeSession(tmpDir, "--tmp-other--", "old-archived", {
		name: "an archived session",
		messages: 4,
	});

	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => {
		throw new Error("@[ must not full-scan for an active-only list");
	};

	try {
		const suggestions = await suggestionsFor("@[", "current-session");
		assert.deepEqual(
			suggestions.items.map((item: any) => item.value),
			["@[live-one]"],
		);
	} finally {
		(SessionManager as any).listAll = originalListAll;
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@a[ lists archived sessions only, without a full scan", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;

	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: {
				"old-archived": { archivedAt: 1 },
				"older-archived": { archivedAt: 2 },
			},
		}),
	);
	writeSession(tmpDir, "--tmp-project--", "live-one", {
		name: "a live session",
	});
	writeSession(tmpDir, "--tmp-project--", "old-archived", {
		name: "an archived session",
	});
	writeSession(tmpDir, "--tmp-other--", "older-archived", {
		name: "an older archived session",
	});

	// `@a[` is the one picker that must read archived transcripts' neighbours,
	// but pi's full scan parses every line of every archived file. Stub it to
	// throw so a regression to listAll() is loud rather than slow.
	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => {
		throw new Error("@a[ must not full-scan the session tree");
	};

	try {
		const suggestions = await suggestionsFor("@a[", "current-session");
		const values = suggestions.items.map((item: any) => item.value).sort();
		assert.deepEqual(values, ["@[old-archived]", "@[older-archived]"]);
		assert.equal(suggestions.prefix, "@a[");
		const archived = suggestions.items.find(
			(item: any) => item.value === "@[old-archived]",
		);
		assert.equal(archived.label, "an archived session");
	} finally {
		(SessionManager as any).listAll = originalListAll;
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("@a[ shows a placeholder when nothing is archived", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;

	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({ version: 1, sessions: {} }),
	);
	writeSession(tmpDir, "--tmp-project--", "live-one", {
		name: "a live session",
	});

	try {
		const suggestions = await suggestionsFor("@a[", "current-session");
		assert.equal(suggestions.items.length, 1);
		assert.equal(suggestions.items[0].value, "");
		assert.equal(suggestions.items[0].label, "(No archived sessions)");
	} finally {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("an archived session still expands, so @a[ references resolve", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;

	fs.writeFileSync(
		path.join(tmpDir, "inbox.json"),
		JSON.stringify({
			version: 1,
			sessions: { "old-archived": { archivedAt: 1 } },
		}),
	);
	writeSession(tmpDir, "--tmp-project--", "old-archived", {
		name: "an archived session",
	});

	const handlers = new Map<string, (...args: any[]) => any>();
	sessionMention({
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);

	try {
		const message = { role: "user", content: "recall @[old-archived]" };
		await handlers.get("context")?.({ messages: [message] });
		// Archiving hides a session from the pickers, not from expansion: an id
		// inserted by `@a[` would be dead otherwise.
		assert.match(message.content, /«an archived session»/);
	} finally {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
