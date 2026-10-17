import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutocompleteProviderFactory } from
	"@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { promptAutocomplete } from "./prompt-autocomplete.ts";

function fixture() {
	const base: AutocompleteProvider = {
		async getSuggestions() { return null; },
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	};
	const wrappers: AutocompleteProviderFactory[] = [];
	let normal = base;
	const ui = {
		addAutocompleteProvider(factory: AutocompleteProviderFactory) {
			wrappers.push(factory);
			normal = base;
			for (const wrap of wrappers) normal = wrap(normal);
		},
	};
	return { ui, normal: () => normal };
}

test("capture uses the full native provider", () => {
	const f = fixture();
	f.ui.addAutocompleteProvider((current) => ({
		...current, triggerCharacters: ["$"],
	}));
	const captured = promptAutocomplete(f.ui);
	assert.equal(captured, f.normal());
	assert.deepEqual(captured?.triggerCharacters, ["$"]);
});

test("reopening captures later extension wrappers", () => {
	const f = fixture();
	const before = promptAutocomplete(f.ui);
	f.ui.addAutocompleteProvider((current) => ({
		...current, triggerCharacters: ["$", "@"],
	}));
	const after = promptAutocomplete(f.ui);
	assert.equal(after, f.normal());
	assert.notEqual(after, before);
	assert.deepEqual(after?.triggerCharacters, ["$", "@"]);
});
