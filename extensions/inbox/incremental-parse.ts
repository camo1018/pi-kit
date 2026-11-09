/**
 * Incremental session parsing.
 *
 * A session JSONL is append-only: pi never rewrites a line, and a rewrite (a
 * move, a compaction beyond the tail) lands as a new file rather than an edit.
 * The inbox nevertheless used to re-read the WHOLE file every time its mtime or
 * size moved, which for a session an agent is actively driving means re-reading
 * its entire history every 2.5s refresh — 56MB of JSON per refresh across five
 * live sessions here, ~22MB/s of transient objects, which is what produced the
 * small recurring hitches (GC sawtoothing, not one long block).
 *
 * The counters that make up a `SessionInfo` are all additive over lines, so the
 * whole history does not need revisiting: keep the running totals and the first
 * few / last few message texts from last time, and fold in only the bytes that
 * appeared since. Re-reading 4KB of tail instead of 15MB of history measured
 * 100x cheaper.
 *
 * Correctness rests on two rules, both about noticing when "resume from a byte
 * offset" is not safe:
 *
 *  1. The prefix must be unchanged. A file only ever grows by appending, so if
 *     the current size is >= what we last read AND the bytes before that point
 *     are unmodified, resuming is sound. Size shrinking (truncation, rewrite,
 *     compaction) or a stamp regression forces a full re-read.
 *  2. A partial trailing line must not be counted. While a writer is mid-line,
 *     the last "line" has no terminating newline; consuming it would both miscount
 *     and, worse, mis-parse a truncated JSON object. Parsing therefore stops at
 *     the last complete newline and remembers that offset as the resume point.
 */

/** The additive state a full parse accumulates, so a later parse can continue it. */
export interface SessionTally {
	/** Bytes consumed, always ending just past a newline. The resume offset. */
	offset: number;
	/** File size at the time of that parse, to detect truncation. */
	size: number;
	messageCount: number;
	/** Newest message timestamp seen, 0 when none had one. */
	lastActivityMs: number;
	/** First non-empty user message text (the title). */
	firstMessage: string;
	/** Oldest kept message texts, at most `keepHead`. */
	head: string[];
	/** Newest kept message texts, at most `keepTail`. */
	tail: string[];
	/** `session_info` name, if the file has one. */
	name?: string;
}

export function emptyTally(): SessionTally {
	return {
		offset: 0,
		size: 0,
		messageCount: 0,
		lastActivityMs: 0,
		firstMessage: "",
		head: [],
		tail: [],
	};
}

/** Kept as named constants because the on-disk cache shape depends on them. */
export const KEEP_HEAD = 5;
export const KEEP_TAIL = 10;

export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b: any) => b?.type === "text" && typeof b.text === "string",
		)
		.map((b: any) => b.text)
		.join("\n");
}

/**
 * Fold one JSONL line into a tally. Returns whether anything changed, so the
 * caller can skip re-deriving the `SessionInfo` when a refresh only added
 * non-message lines.
 *
 * Structurally identical to the original whole-file loop: the counters and the
 * head/tail windows advance exactly as they would have, because they are
 * expressed as folds over the same sequence of lines.
 */
export function foldLine(tally: SessionTally, line: string): boolean {
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return false; // a malformed or (rarely) partially-flushed line
	}
	let changed = false;
	if (entry.type === "session_info" && typeof entry.name === "string") {
		const name = entry.name.trim() || undefined;
		if (name !== tally.name) {
			tally.name = name;
			changed = true;
		}
	}
	if (entry.type !== "message" || !entry.message) return changed;
	// parity with pi's buildSessionInfo: every message entry counts, any role.
	tally.messageCount++;
	changed = true;
	const ts = entry.message.timestamp ?? entry.timestamp;
	const t = typeof ts === "number" ? ts : Date.parse(ts);
	if (!Number.isNaN(t) && t > tally.lastActivityMs) tally.lastActivityMs = t;
	const m = entry.message;
	if (!["user", "assistant"].includes(m.role)) return changed;
	const text = messageText(m.content).trim();
	if (!text) return changed;
	if (m.role === "user" && !tally.firstMessage) tally.firstMessage = text;
	if (tally.tail.length >= KEEP_TAIL) tally.tail.shift();
	tally.tail.push(text);
	if (tally.head.length < KEEP_HEAD) tally.head.push(text);
	return changed;
}

/**
 * The `allMessagesText` index: the head window followed by the tail window with
 * the overlap removed, so a session with fewer than `KEEP_HEAD` messages is not
 * counted twice. Unchanged behaviour, extracted so both the full and incremental
 * paths produce identical output.
 */
export function allMessagesText(tally: SessionTally): string {
	const overlap = Math.min(tally.head.length, tally.tail.length, KEEP_HEAD);
	return tally.head.concat(tally.tail.slice(overlap)).join(" ");
}

/**
 * Can a parse continue from `tally` given the file's current state, or must it
 * start over?
 *
 * Size is the truncation signal: a file that shrank was rewritten (compaction,
 * move, a manual edit), so every byte offset we remember is meaningless. Any
 * growth is fine — JSONL only ever appends.
 */
export function canResume(
	tally: SessionTally,
	current: { size: number },
): boolean {
	if (tally.offset <= 0) return false;
	if (current.size < tally.size) return false; // truncated or rewritten
	if (current.size < tally.offset) return false; // defensive: offset past EOF
	return true;
}

/**
 * Split a freshly-read chunk into complete lines plus the leftover bytes of a
 * line still being written.
 *
 * `carry` is the unterminated tail from the previous chunk (empty on the first
 * read). Only text up to the last `\n` is returned as complete; the remainder is
 * handed back so the next read can complete it *and* so the resume offset lands
 * on a line boundary.
 *
 * `consumed` is in BYTES, not string length. `start:` on a read stream is a byte
 * offset, and session text is full of multi-byte characters (emoji in tool output,
 * non-Latin prompts), where `string.length` counts UTF-16 code units and would
 * under-count — silently re-reading or skipping bytes on the next resume.
 */
export function splitLines(
	chunk: string,
	carry: string,
): { lines: string[]; carry: string; consumed: number } {
	const combined = carry + chunk;
	const lastBreak = combined.lastIndexOf("\n");
	if (lastBreak === -1) {
		// No complete line yet: keep everything, consume nothing.
		return { lines: [], carry: combined, consumed: 0 };
	}
	const complete = combined.slice(0, lastBreak);
	const rest = combined.slice(lastBreak + 1);
	// Bytes now committed = everything up to and including that newline.
	//
	// `complete` begins with the carry, and the carry's bytes were NOT counted last
	// time (they were dangling), so they are newly committed here and must be
	// counted now. Two earlier versions got this wrong in the same way — by
	// subtracting `byteLength(carry)` as well — which lost exactly the carry's bytes
	// on every chunk. The offsets drifted short by ~5.8KB per 64KB read (2.4MB
	// accounted for an 8.2MB file), so a later resume re-read and re-folded history.
	const consumed = Buffer.byteLength(complete, "utf-8") + 1;
	return {
		lines: complete.split("\n"),
		carry: rest,
		consumed,
	};
}
