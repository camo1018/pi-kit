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

test("@g[ shows placeholder when session is ungrouped", async () => {
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
		assert.equal(suggestions.items[0].label, "(Current session is ungrouped)");

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
