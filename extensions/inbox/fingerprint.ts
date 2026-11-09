/**
 * "Did anything actually change?"
 *
 * The inbox refreshes on a fixed 2.5s timer while it is open, and every refresh
 * rebuilt the whole row list, re-sorted it, re-projected worker families, and
 * re-rendered — whether or not a single byte had moved. Everything a refresh
 * depends on is file state plus `inbox.json`, so a cheap fingerprint of those
 * lets an idle window skip the work entirely.
 *
 * The fingerprint is deliberately coarse. It only has to answer "could this have
 * changed", so it reads directory mtimes rather than file contents, and every
 * false positive (same second, same size, same file) just costs one normal
 * refresh. There is exactly one rule that matters: a change must never be
 * missed.
 */

/** A monotonic-ish token for "the state this refresh was built from". */
export interface Fingerprint {
	/** Per session slug dir: directory mtime and entry count. */
	dirs: string;
	/** `inbox.json`'s own mtime and size. */
	store: string;
	/** Live-record dir mtime and entry count, so a run starting/ending refreshes. */
	live: string;
	/** Worker-link dir mtime and entry count. */
	links: string;
	/**
	 * Stamps for the session files that some live pi currently has open. An append
	 * does not move a directory's mtime, so these are the one input the directory
	 * stamps cannot cover.
	 */
	tracked: string;
	/**
	 * The live records' id/state/file, not just their directory.
	 *
	 * A record is rewritten IN PLACE when a run starts or settles, which does not
	 * move the containing directory's mtime — verified, not assumed. Without this a
	 * window could keep showing "● working" after the run had already finished.
	 */
	liveState: string;
}

/**
 * Build the fingerprint from directory metadata.
 *
 * `statSync` on ~51 directories is microseconds; the point is to avoid the ~750
 * per-file stats and the parse work behind them, not to be free. Directory
 * mtimes move on create/delete/rename but not on append, which is why a file's
 * own `mtimeMs` is folded in for every session a live pi currently holds open.
 */
export function fingerprintOf(parts: {
	dirs: Array<{ name: string; mtimeMs: number; entries: number }>;
	store: { mtimeMs: number; size: number } | undefined;
	live: { mtimeMs: number; entries: number } | undefined;
	links: { mtimeMs: number; entries: number } | undefined;
	tracked: Array<{ path: string; mtimeMs: number; size: number }>;
	liveState?: string;
}): string {
	const dirs = parts.dirs
		.map((d) => `${d.name}:${d.mtimeMs}:${d.entries}`)
		.sort()
		.join("|");
	const tracked = parts.tracked
		.map((w) => `${w.path}:${w.mtimeMs}:${w.size}`)
		.sort()
		.join("|");
	return [
		dirs,
		parts.store ? `${parts.store.mtimeMs}:${parts.store.size}` : "-",
		parts.live ? `${parts.live.mtimeMs}:${parts.live.entries}` : "-",
		parts.links ? `${parts.links.mtimeMs}:${parts.links.entries}` : "-",
		tracked,
		parts.liveState ?? "",
	].join("#");
}
