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
