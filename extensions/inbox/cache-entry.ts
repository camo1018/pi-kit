/**
 * The on-disk shape of one cached session, and what it is allowed to forget.
 *
 * The v2 cache stored, for every session, three copies of the same text: the
 * `head`/`tail` windows inside `tally`, the `allMessagesText` index derived from
 * them, and `firstMessage` twice over (once in `tally`, once in `info`). At 788
 * sessions that was 26MB, of which 8.6MB was a byte-identical derivation and 2.1MB
 * a byte-identical duplicate — and every process pays for all of it: `loadInfoCache`
 * parses the whole file, and `saveInfoCache` re-serializes the whole file, both
 * synchronously, on the event loop that also handles typing.
 *
 * v3 therefore stores a *derived* index rather than three copies, and keeps the
 * resume state (`tally`) only where it can still pay for itself.
 *
 * Why the tally is not kept everywhere. A tally exists to resume a parse from a
 * byte offset, which only helps a file that keeps growing. An old session is not
 * being appended to, so its tally buys nothing except a cheaper second visit to
 * a tab — while being 58% of the data for the archived partition. Dropping it is
 * lossless: the entry still carries the text index, so search and filters still
 * match, and the next append just costs one full parse of that file.
 *
 * The rule is deliberately age-based rather than archive-based. Coupling it to
 * `archivedAt` reads well but has a hole: an archived session that wakes up and
 * is appended to stays archived, so it would full-parse on every 2.5s refresh
 * forever. Age is self-healing — touch the session and it becomes eligible again
 * on the next save.
 *
 * Dates are stored as ISO strings because that is what JSON can hold; the
 * `SessionInfo` these turn back into carries `Date`s. Conversions live here so
 * the two shapes cannot drift.
 */

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { allMessagesText, KEEP_HEAD, type SessionTally } from "./incremental-parse.ts";

/** How long a session keeps its resume state. Matches the worker retention. */
export const TALLY_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** The `SessionInfo` fields that are derived from other fields and so not stored. */
export interface EntryInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: string;
	modified: string;
	messageCount: number;
	/** Only present on entries that carry no tally; otherwise derived on load. */
	firstMessage?: string;
	/** Only present on entries that carry no tally; otherwise derived on load. */
	allMessagesText?: string;
}

/** One session as persisted. `tally` absent means "re-parse this file to resume". */
export interface CacheEntry {
	mtimeMs: number;
	size: number;
	info: EntryInfo;
	tally?: SessionTally;
}

/** The in-memory record: a `SessionInfo` plus the stamps and resume state. */
export interface CachedRecord {
	mtimeMs: number;
	size: number;
	info: SessionInfo;
	tally: SessionTally;
}

/**
 * The text index for a tally, exactly as `infoFrom` builds it.
 *
 * Kept here rather than inline so the persisted form and the in-memory form
 * cannot drift: an entry loaded from disk must produce the same
 * `allMessagesText` a fresh parse would.
 */
export function deriveTextIndex(tally: SessionTally): string {
	return allMessagesText(tally);
}

/** Should this entry keep its resume state? */
export function keepsTally(
	modifiedMs: number,
	now: number = Date.now(),
	retainMs: number = TALLY_RETAIN_MS,
): boolean {
	if (!Number.isFinite(modifiedMs)) return false;
	return now - modifiedMs <= retainMs;
}

/**
 * Reduce an in-memory record to what is worth writing.
 *
 * Undefined fields are omitted rather than written as `null`, because the point
 * of the exercise is bytes on disk.
 */
export function toEntry(
	record: CachedRecord,
	now: number = Date.now(),
	retainMs: number = TALLY_RETAIN_MS,
): CacheEntry {
	const { info, tally } = record;
	const base: EntryInfo = {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
	};
	// Omitted rather than written as null: the point is bytes on disk.
	if (info.name !== undefined) base.name = info.name;
	if (info.parentSessionPath !== undefined) base.parentSessionPath = info.parentSessionPath;
	if (keepsTally(info.modified.getTime(), now, retainMs))
		return { mtimeMs: record.mtimeMs, size: record.size, info: base, tally };
	// No tally => carry the derived text instead, so search still works.
	return {
		mtimeMs: record.mtimeMs,
		size: record.size,
		info: {
			...base,
			firstMessage: info.firstMessage,
			allMessagesText: info.allMessagesText,
		},
	};
}

/**
 * Rebuild a record, or `undefined` when the entry cannot be trusted.
 *
 * A tally-less entry is legal: it means the session was old enough to stop
 * carrying resume state. Its text index is stored, so the record is complete —
 * but it can never be resumed from, which `parseCached` enforces by treating a
 * missing tally as offset 0.
 */
export function fromEntry(raw: any): CachedRecord | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const e = raw.info;
	if (!e || typeof e.path !== "string" || typeof e.id !== "string") return undefined;
	if (typeof raw.mtimeMs !== "number" || typeof raw.size !== "number") return undefined;
	const created = new Date(e.created);
	const modified = new Date(e.modified);
	if (Number.isNaN(created.getTime()) || Number.isNaN(modified.getTime())) return undefined;

	const tally =
		raw.tally && typeof raw.tally.offset === "number" ? (raw.tally as SessionTally) : undefined;
	// Built key by key, and optional keys omitted rather than set to undefined, so
	// the result is `deepEqual` to what `infoFrom` produces from a fresh parse.
	const info: SessionInfo = {
		path: e.path,
		id: e.id,
		cwd: typeof e.cwd === "string" ? e.cwd : "",
		created,
		modified,
		messageCount: Number(e.messageCount) || 0,
		firstMessage: tally
			? tally.firstMessage || "(no messages)"
			: typeof e.firstMessage === "string"
				? e.firstMessage
				: "(no messages)",
		allMessagesText: tally
			? deriveTextIndex(tally)
			: typeof e.allMessagesText === "string"
				? e.allMessagesText
				: "",
	};
	if (typeof e.name === "string") info.name = e.name;
	if (typeof e.parentSessionPath === "string") info.parentSessionPath = e.parentSessionPath;
	return {
		mtimeMs: raw.mtimeMs,
		size: raw.size,
		info,
		// A record without a tally still needs a usable empty one so callers can
		// resume "from zero"; `canResume` sees offset 0 and full-parses.
		tally: tally ?? emptyResume(),
	};
}

/** The zero tally, kept local so this module has no runtime dependency on the parser. */
function emptyResume(): SessionTally {
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

/** `KEEP_HEAD` is re-exported so a test can assert the derivation's window size. */
export { KEEP_HEAD };
