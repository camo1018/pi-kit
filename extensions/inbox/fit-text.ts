/**
 * Width-fitting for the inbox's already-ANSI-styled row cells.
 *
 * `render()` builds every list row as a string with colour escapes baked in, and
 * pads/truncates each *column* of it with `fit()`. Two costs hid in that helper.
 *
 * 1. **`truncateToWidth` cannot use its fast path on styled text.** It starts
 *    with `isPrintableAscii(text)`, which is false the moment a string contains
 *    an escape code, so it falls through to a walk that extracts ANSI codes and
 *    grapheme-segments every visible run. Measured 4.19-8.05us per call versus
 *    0.14us for plain ASCII — 30-57x.
 *
 * 2. **Most calls do not need to truncate at all.** A list column is usually
 *    narrower than the text it shows, and neither truncating nor padding changes
 *    anything when the text already fits. `visibleWidth` is ANSI-aware *and* fast
 *    (0.09us, it has its own styled-text path plus a cache), so asking it first
 *    avoids the expensive call most of the time.
 *
 * With ~13 `fit()` calls per visible row and 52 rows, that is 676 calls and
 * ~5.4ms per render — the entire cost of a render, on every keystroke.
 *
 * The output is unchanged: same truncation, same padding, same escapes. This is
 * purely "ask the cheap question first" plus "let the cached width do the work".
 */

export interface FitDeps {
	/** pi-tui's ANSI-aware width. */
	visibleWidth: (s: string) => number;
	/** pi-tui's truncator; only called when the text genuinely overflows. */
	truncate: (s: string, w: number, ellipsis?: string) => string;
}

/**
 * Fit `s` to exactly `w` visible cells, truncating only if it overflows.
 *
 * Returns the padded/truncated string. Width is measured once via the cached,
 * ANSI-aware `visibleWidth`; `truncateToWidth` is reserved for the case that
 * actually needs it.
 */
export function fitToWidth(
	s: string,
	w: number,
	deps: FitDeps,
	ellipsis = "…",
): string {
	if (w <= 0) return "";
	const width = deps.visibleWidth(s);
	// Fits (or fits exactly): no truncation work, just pad. This is the common
	// case for status, age, message count, and any column wider than its content.
	if (width <= w) return s + " ".repeat(w - width);
	// Overflows: truncate, then re-measure only the much-shorter result.
	const cut = deps.truncate(s, w, ellipsis);
	return cut + " ".repeat(Math.max(0, w - deps.visibleWidth(cut)));
}
