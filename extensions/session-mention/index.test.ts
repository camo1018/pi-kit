import assert from "node:assert/strict";
import { test } from "node:test";
import {
	SessionManager,
	type ExtensionAPI,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import sessionMention from "./index.ts";

const info = {
	id: "session-id",
	name: "shared title",
	path: "/missing/session.jsonl",
	cwd: "/tmp/project",
	firstMessage: "first prompt",
	messageCount: 2,
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
	} finally {
		(SessionManager as any).listAll = originalListAll;
	}
});
