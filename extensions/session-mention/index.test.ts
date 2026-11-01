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

const info = {
	id: "session-id",
	name: "shared title",
	path: "/missing/session.jsonl",
	cwd: "/tmp/project",
	firstMessage: "first prompt",
	messageCount: 2,
	modified: new Date(),
} as SessionInfo;

const infoInGroup = {
	id: "session-in-group",
	name: "group sibling title",
	path: "/missing/sibling.jsonl",
	cwd: "/tmp/project",
	firstMessage: "sibling prompt",
	messageCount: 3,
	modified: new Date(),
} as SessionInfo;

test("expands only the request clone and autocomplete inserts the id", async () => {
	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => [info];
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
		(SessionManager as any).listAll = originalListAll;
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

	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => [info, infoInGroup];
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
		// Only infoInGroup should be returned, NOT info (which is in grp-2) and NOT current-session
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
		(SessionManager as any).listAll = originalListAll;
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

const infoArchived = {
	id: "session-archived",
	name: "archived sibling title",
	path: "/missing/archived.jsonl",
	cwd: "/tmp/project",
	firstMessage: "archived sibling prompt",
	messageCount: 4,
	modified: new Date(),
} as SessionInfo;

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
}

test("@g[ hides archived siblings; @ga[ includes them", async () => {
	clearSessionCache();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	groupFixture(tmpDir);

	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () =>
		[infoInGroup, infoArchived];
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
		(SessionManager as any).listAll = originalListAll;
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

	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => [infoArchived];
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
		(SessionManager as any).listAll = originalListAll;
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
	const saved = new Map<string | symbol, unknown>();
	// Symbol keys are the inbox's globals; Object.entries would skip them.
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
	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => [infoInGroup];
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
		(SessionManager as any).listAll = originalListAll;
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
	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => [infoInGroup];
	try {
		const suggestions = await suggestionsFor("@g[", "brand-new-composer");
		assert.deepEqual(
			suggestions.items.map((item: any) => item.value),
			["@[session-in-group]"],
		);
	} finally {
		(SessionManager as any).listAll = originalListAll;
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
	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => [infoInGroup];
	try {
		const suggestions = await suggestionsFor("@g[", "brand-new-composer");
		assert.equal(suggestions.items.length, 1);
		assert.equal(suggestions.items[0].value, "");
	} finally {
		(SessionManager as any).listAll = originalListAll;
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
	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () => [infoInGroup];
	try {
		const suggestions = await suggestionsFor("@g[", "plain-session");
		assert.equal(suggestions.items.length, 1);
		assert.equal(suggestions.items[0].value, "");
	} finally {
		(SessionManager as any).listAll = originalListAll;
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

test("@g[ falls back to the full scan when a member has no file", async () => {
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
	// member-missing deliberately has no file on disk: the listing must still
	// show the members it can see, via the full-scan fallback.
	const originalListAll = SessionManager.listAll;
	(SessionManager as any).listAll = async () =>
		[
			{
				...infoInGroup,
				id: "member-missing",
				name: "only the full scan can see this",
			},
		] as SessionInfo[];

	try {
		const suggestions = await suggestionsFor("@g[", "current-session");
		assert.deepEqual(
			suggestions.items.map((item: any) => item.value),
			["@[member-missing]"],
		);
	} finally {
		(SessionManager as any).listAll = originalListAll;
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
