import assert from "node:assert/strict";
import { after, test } from "node:test";

const mod = await import("../inbox/index.ts");
const KEY = Symbol.for("pi.inbox.headerProviders");
const G = globalThis as any;

after(() => { G[KEY] = []; });

function withProvider(onQuitKey?: () => boolean) {
	G[KEY] = [];
	return mod.registerInboxHeaderProvider({ id: "q", text: () => "x", onQuitKey });
}

test("q is claimed when an addon wants it and there is no query", () => {
	const off = withProvider(() => true);
	assert.equal(mod.addonClaimsQuit("q", ""), true);
	off();
});

test("q is NOT claimed while a search query is active (query clears first)", () => {
	withProvider(() => true);
	assert.equal(mod.addonClaimsQuit("q", "evidence"), false);
});

test("ctrl+c is never claimed, even with a greedy addon", () => {
	withProvider(() => true);
	assert.equal(mod.addonClaimsQuit("\u0003", ""), false);
});

test("other keys are not claimed", () => {
	withProvider(() => true);
	for (const k of ["a", "j", "k", "1", "/"]) {
		assert.equal(mod.addonClaimsQuit(k, ""), false, `key ${k}`);
	}
});

test("with no addon registered, q falls through to the inbox", () => {
	G[KEY] = [];
	assert.equal(mod.addonClaimsQuit("q", ""), false);
});

test("an addon that declines does not claim q", () => {
	withProvider(() => false);
	assert.equal(mod.addonClaimsQuit("q", ""), false);
});

test("a throwing addon does not claim q and does not crash", () => {
	withProvider(() => { throw new Error("boom"); });
	assert.equal(mod.addonClaimsQuit("q", ""), false);
});
