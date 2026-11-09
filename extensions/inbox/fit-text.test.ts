import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitToWidth } from "./fit-text.ts";

const deps = { visibleWidth, truncate: truncateToWidth };
const fit = (s: string, w: number) => fitToWidth(s, w, deps);

/** The implementation this replaced, kept as the oracle. */
function oldFit(s: string, w: number): string {
	if (w <= 0) return "";
	const t = truncateToWidth(s, w, "…");
	return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}

const styled = (text: string, ...codes: string[]) =>
	codes.map((c) => `\x1b[${c}m`).join("") + text + "\x1b[0m";

const CASES = [
	"plain ascii text",
	styled("styled title", "32"),
	styled("bold and colour", "1", "38;5;240"),
	"emoji 😀🎉 mixed",
	styled("styled emoji 🎉", "36"),
	"a".repeat(500),
	styled("b".repeat(500), "33"),
	"日本語のテキスト",
	"",
	"\x1b[31m\x1b[0m",
];

test("output is byte-identical to the implementation it replaced", () => {
	// Not a style preference: render() composes rows from many differently-styled
	// columns, so any change to the escapes or padding is a visual regression.
	for (const c of CASES)
		for (const w of [0, 1, 3, 5, 10, 20, 40, 80, 200])
			assert.equal(fit(c, w), oldFit(c, w), `w=${w} for ${JSON.stringify(c)}`);
});

test("text that already fits is padded, never truncated", () => {
	// The whole optimisation: a column narrower than its content must not reach
	// truncateToWidth, which cannot use its ASCII fast path once escapes are present.
	let truncated = 0;
	const counting = {
		visibleWidth,
		truncate: (s: string, w: number, e?: string) => {
			truncated++;
			return truncateToWidth(s, w, e);
		},
	};
	const out = fitToWidth(styled("short", "32"), 20, counting);
	assert.equal(truncated, 0, "no truncation for text that fits");
	assert.equal(visibleWidth(out), 20, "padded to the full width");
	assert.equal(out, oldFit(styled("short", "32"), 20));
});

test("overflowing text still truncates and still fits the width", () => {
	let truncated = 0;
	const counting = {
		visibleWidth,
		truncate: (s: string, w: number, e?: string) => {
			truncated++;
			return truncateToWidth(s, w, e);
		},
	};
	const out = fitToWidth(styled("x".repeat(100), "32"), 20, counting);
	assert.equal(truncated, 1);
	assert.equal(visibleWidth(out), 20);
	assert.ok(stripTerminalSequences(out).includes("…"));
});

test("a zero or negative width yields nothing", () => {
	assert.equal(fit("anything", 0), "");
	assert.equal(fit("anything", -5), "");
});
