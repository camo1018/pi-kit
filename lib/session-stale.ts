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
