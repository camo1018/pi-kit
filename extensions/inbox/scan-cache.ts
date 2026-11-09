/**
 * Cache support for session discovery, split out of `index.ts` so the
 * invalidation rules can be tested without a TUI.
 *
 * Two things are expensive in the inbox refresh loop, and both used to run
 * unconditionally every 2.5s:
 *
 *  - `scanHeaders()` stats and header-parses every session file. On a machine
 *    with ~750 session files that is ~750 `statSync` + `open`/`read` +
 *    `JSON.parse` calls, synchronously, on the event loop the TUI renders on.
 *  - `buildInfo()` full-parses a changed file. That is bounded (only changed
 *    files), but a fresh process has no `infoCache`, so the first look at the
 *    Archived/All tabs reparses the whole history — ~880MB here.
 *
 * Both caches are keyed on `(path, mtimeMs, size)`, which is what pi's own
 * session writer touches on every append, so a changed file is never served
 * stale. This module holds the *rules*; `index.ts` holds the I/O.
 */

/** One file's discovery-ish identity: enough to decide "changed?" without reading it. */
export interface FileStamp {
	path: string;
	mtimeMs: number;
	size: number;
}

export function sameStamp(
	a: Pick<FileStamp, "mtimeMs" | "size"> | undefined,
	b: Pick<FileStamp, "mtimeMs" | "size">,
): boolean {
	return !!a && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Directory listing cache: a slug dir's entry survives until the dir itself changes. */
export interface DirEntry {
	/** Directory mtime at the time the listing was taken. */
	mtimeMs: number;
	/** `.jsonl` files only, in readdir order. */
	files: string[];
}

/**
 * Decide whether a cached directory listing can be reused.
 *
 * A session file appended to keeps its own mtime but does NOT bump the
 * containing directory's mtime, so an unchanged directory means "same set of
 * files", not "same contents" — which is exactly what the listing is for.
 * Creating, deleting, or renaming a file does bump it, and that is the only
 * way the *set* of files changes.
 */
export function dirReusable(
	cached: DirEntry | undefined,
	mtimeMs: number,
): cached is DirEntry {
	return !!cached && cached.mtimeMs === mtimeMs;
}

/**
 * Merge a freshly taken header for one file over the previous snapshot, so the
 * caller can hand `scanSessions` a list that is cheap to produce but complete.
 */
export function pruneCacheByPath<T>(
	cache: Map<string, T>,
	livePaths: ReadonlySet<string>,
): number {
	let dropped = 0;
	for (const key of cache.keys()) {
		if (livePaths.has(key)) continue;
		cache.delete(key);
		dropped++;
	}
	return dropped;
}

/**
 * How long a dirty on-disk cache may sit in memory before it is written.
 *
 * The write serializes the whole cache (~10MB here, ~7ms, synchronous). With live
 * agents appending, *some* session changes on essentially every refresh tick, so
 * writing on every refresh meant a recurring multi-millisecond block for a file
 * whose only consumer is a future process. Deferring costs nothing: nothing reads
 * it while this process lives.
 */
export const CACHE_FLUSH_MS = 60_000;

/**
 * Should a dirty cache be written now?
 *
 * `force` is for shutdown, where the synchronous cost is worth paying because
 * nothing is waiting on the event loop and the work would otherwise be lost.
 */
export function shouldFlushCache(
	opts: {
		dirty: boolean;
		flushedAt: number;
		now?: number;
		force?: boolean;
		intervalMs?: number;
	},
): boolean {
	if (!opts.dirty) return false;
	if (opts.force) return true;
	const now = opts.now ?? Date.now();
	const interval = opts.intervalMs ?? CACHE_FLUSH_MS;
	return now - opts.flushedAt >= interval;
}
