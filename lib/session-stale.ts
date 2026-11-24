import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

/**
 * id of the last JSONL entry on disk, reading backwards in chunks.
 *
 * Reads only the tail, so this stays cheap on a session with thousands of
 * entries. Returns undefined when the file is missing or unreadable, which
 * callers must treat as "cannot tell" rather than "not stale".
 */
export function lastEntryIdOnDisk(file: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = fstatSync(fd).size;
		let chunk = 64 * 1024;
		while (true) {
			const start = Math.max(0, size - chunk);
			const buf = Buffer.alloc(size - start);
			readSync(fd, buf, 0, buf.length, start);
			const lines = buf.toString("utf8").split("\n");
			const nonEmpty = lines.filter((l) => l.trim());
			// Need a full line: either we read from the file start, or there's
			// a newline before the last non-empty line.
			if (start === 0 || nonEmpty.length >= 2) {
				const last = nonEmpty.at(-1);
				if (!last) return undefined;
				return JSON.parse(last)?.id;
			}
			chunk *= 4;
		}
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export interface StaleCheck {
	/** True only when the disk tip is a KNOWN, different entry. */
	stale: boolean;
	/** Last entry id on disk, when it could be read. */
	diskLastId?: string;
	/** In-memory leaf this process holds. */
	memoryLeafId: string | null;
}

/**
 * Has the session file moved on without this process?
 *
 * A pi process holds its whole transcript and its leaf in memory, and appends
 * with no re-read, so a writer elsewhere leaves it holding a stale leaf. The
 * next append then attaches to a node that is no longer the tip and forks the
 * tree -- and because the fork's tip becomes the last line on disk, every later
 * resume lands on the shallow branch instead of the work.
 *
 * The rule needs both halves:
 *   - A tip this process has NEVER seen is somebody else's entry.
 *   - A KNOWN tip with a different in-memory leaf is a deliberate /tree
 *     navigation, and must not read as staleness.
 */
/**
 * The leaf a message may pin before its run spawns, plus the disk tip it was
 * captured against. Computed at SEND time, where the sender's view is known.
 *
 * A spawn is `pi --session <path>` with no leaf argument, so a child resumes on
 * the file's LAST line. The pin exists for one case: the user navigated with
 * `/tree` to an older branch and typed. Without a marker that position is
 * silently discarded.
 *
 * The trap is that the same mechanism fires on a plain QUEUED message. A reply
 * typed while a run is in flight captures the host's in-memory leaf, which is
 * behind what that run is writing; pinning it later branches the transcript
 * back and strands the finished run's entries on a dead sibling -- the
 * "queueing a message starts a new branch" symptom.
 *
 * `staleAgainstDisk` already draws that line: a disk tip this process has never
 * seen is a writer's, while a KNOWN tip with a different in-memory leaf is
 * deliberate navigation. So a stale sender pins the DISK TIP (continue where the
 * conversation actually is) and a fresh one pins the branch on screen.
 */
export function pinnedLeafFor(
	sm: ReadonlySessionManager,
	file?: string,
): { leaf?: string; tip?: string } {
	const check = staleAgainstDisk(sm, file);
	const tip = check.diskLastId;
	if (check.stale) return { leaf: tip, tip };
	const leaf = sm.getLeafId() ?? undefined;
	return { leaf, tip: tip ?? leaf };
}

/**
 * Should `run()` write a tree-position marker for `leaf`?
 *
 * Only when the file still ends where the sender saw it. If the tip moved, a
 * run wrote past the captured leaf and continuing the tip is correct in every
 * case -- a deliberate `/tree` does not move the tip, so this cannot cancel the
 * navigation it exists to preserve.
 */
export function shouldPinLeaf(
	sm: ReadonlySessionManager,
	opts: { leaf?: string; capturedTip?: string },
): boolean {
	const { leaf, capturedTip } = opts;
	if (!leaf || capturedTip === undefined) return false;
	const tipNow = sm.getLeafId();
	if (!tipNow || tipNow !== capturedTip || tipNow === leaf) return false;
	// Only a leaf this session actually has, or the marker points at nothing.
	return sm.getEntry(leaf) !== undefined;
}

export function staleAgainstDisk(
	sm: ReadonlySessionManager,
	file?: string,
): StaleCheck {
	const memoryLeafId = sm.getLeafId();
	const path = file ?? sm.getSessionFile?.();
	if (!path) return { stale: false, memoryLeafId };
	const diskLastId = lastEntryIdOnDisk(path);
	if (diskLastId === undefined) return { stale: false, memoryLeafId };
	const known = sm.getEntry(diskLastId) !== undefined;
	return { stale: !known && diskLastId !== memoryLeafId, diskLastId, memoryLeafId };
}
