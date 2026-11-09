/**
 * Deciding what can be forgotten.
 *
 * `~/.pi/agent/inbox.json` accumulated 1,373 session records against 753 session
 * files: 628 records described sessions whose JSONL no longer exists. Nothing
 * ever removed them, so every read-modify-write of the store (each `markRead`,
 * every pin, archive, or seen stamp) re-serialized 218KB of mostly dead entries,
 * and the file only grew.
 *
 * Deleting is the one operation here that destroys data, so the rule lives on its
 * own, out of the I/O, and is deliberately paranoid: a record is dropped only
 * when nothing on disk or in the other subsystems' state can still resolve it.
 */

/** Everything the inbox can see about one candidate, gathered by the caller. */
export interface PruneFacts {
	/** A JSONL session file with this id exists under `sessions/*`. */
	hasSessionFile: boolean;
	/** A live record names this session (it is open or working somewhere). */
	hasLiveRecord: boolean;
	/** An `inbox-agents/<id>.json` record exists (a supervised background agent). */
	hasAgentRecord: boolean;
	/** A `session-workers/workers/<id>.json` link exists (a delegated worker). */
	hasWorkerLink: boolean;
	/**
	 * Newest timestamp this record carries — `seenAt`, `archivedAt`, `pinnedAt`, or
	 * the bookmark's `savedAt`. `undefined` when the record has no timestamps.
	 */
	lastTouched?: number;
}

/**
 * Quiet period before an orphaned record may be dropped.
 *
 * Two things need it. A brand-new session is announced (agent record, live
 * record, inbox row) before its JSONL is flushed, and `moveSessionDir` renames a
 * session between slug directories — during either window the file is briefly
 * absent while the record is live. A week is far longer than any of that, and
 * matches the retention the worker records already use for their own pruning.
 */
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True when this store record describes nothing any more.
 *
 * Note the deliberate asymmetry: a record with NO timestamp is dropped as soon
 * as it is unreferenced (it carries no information worth keeping), while a
 * record with a recent timestamp is kept for the grace period even though it is
 * already unreachable. Losing a "seen" mark on a session whose file is gone
 * costs nothing; the grace period exists for the records that might come back.
 */
export function isPrunableOrphan(
	facts: PruneFacts,
	now: number = Date.now(),
): boolean {
	if (
		facts.hasSessionFile ||
		facts.hasLiveRecord ||
		facts.hasAgentRecord ||
		facts.hasWorkerLink
	)
		return false;
	if (facts.lastTouched === undefined) return true;
	return now - facts.lastTouched > ORPHAN_GRACE_MS;
}

/** The newest timestamp a stored record carries, if any. */
export function recordTouchedAt(meta: {
	seenAt?: number;
	archivedAt?: number;
	pinnedAt?: number;
	unreadAt?: number;
	clonedAt?: number;
	scrollBookmark?: { savedAt?: number };
}): number | undefined {
	const stamps = [
		meta.seenAt,
		meta.archivedAt,
		meta.pinnedAt,
		meta.unreadAt,
		meta.clonedAt,
		meta.scrollBookmark?.savedAt,
	].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
	return stamps.length ? Math.max(...stamps) : undefined;
}

/**
 * How many records to drop per sweep.
 *
 * Bounded so one refresh never turns into a long synchronous delete over an
 * arbitrarily large backlog; successive refreshes finish the job.
 */
export const PRUNE_BATCH = 200;
