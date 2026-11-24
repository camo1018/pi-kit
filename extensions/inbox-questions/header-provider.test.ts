import assert from "node:assert/strict";
import { test } from "node:test";

// Re-derive the two internal behaviours by importing the module and poking the
// shared registry the same way the component does.
const mod = await import("../inbox/index.ts");
const KEY = Symbol.for("pi.inbox.headerProviders");
const G = globalThis as any;
G[KEY] = [];

function segments(): string[] {
	return (G[KEY] ?? [])
		.map((p: any) => { try { return p.text(); } catch { return undefined; } })
		.filter((t: unknown): t is string => !!t);
}
function consumesQuit(): boolean {
	for (const p of G[KEY] ?? []) {
		try { if (p.onQuitKey?.()) return true; } catch { /* contained */ }
	}
	return false;
}

test("segments render only when a provider returns text", () => {
	mod.registerInboxHeaderProvider({ id: "a", text: () => "❓ 2 questions · q" });
	assert.deepEqual(segments(), ["❓ 2 questions · q"]);
});

test("a provider returning undefined contributes no segment", () => {
	G[KEY] = [];
	mod.registerInboxHeaderProvider({ id: "a", text: () => undefined });
	assert.deepEqual(segments(), []);
});

test("q is claimed only when a provider claims it", () => {
	G[KEY] = [];
	let opened = 0;
	const off = mod.registerInboxHeaderProvider({
		id: "a", text: () => "x", onQuitKey: () => { opened++; return true; },
	});
	assert.equal(consumesQuit(), true);
	assert.equal(opened, 1);
	off();
	assert.equal(consumesQuit(), false, "after unregister nothing claims q");
});

test("a throwing text() is skipped, later providers still render", () => {
	G[KEY] = [];
	mod.registerInboxHeaderProvider({ id: "boom", text: () => { throw new Error("x"); } });
	mod.registerInboxHeaderProvider({ id: "ok", text: () => "fine" });
	assert.deepEqual(segments(), ["fine"]);
});
