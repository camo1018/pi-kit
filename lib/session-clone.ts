/**
 * Cloning a session file, shared by the TUI inbox (`c` in the list, `/clone`)
 * and orch-web. Both callers cut at a leaf they resolve themselves — a working
 * background agent is cut *before* its active prompt — and both need the same
 * file-writing and naming rules, so the rules live here once.
 */

import * as fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { branchName, sourceName } from "./session-branch.ts";

export interface CloneResult {
	file: string;
	id: string;
	name: string;
}

/**
 * Write a clone of `opts.file` at `opts.leaf` (`null` = empty history).
 *
 * `onCloned` runs after the new file exists and before this returns, so a
 * caller can stamp its own metadata on the clone (the inbox records
 * `clonedAt`, which keeps the fresh copy from reading as "stalled": its tail
 * ends at a tool result). Group membership and switching to the clone stay
 * with the caller, which owns those stores.
 */
export function writeClone(opts: {
	file: string;
	sessionDir: string;
	leaf: string | null;
	onCloned?: (id: string) => void;
}): CloneResult {
	const sm = SessionManager.open(opts.file, opts.sessionDir);
	const name = branchName(sourceName(sm), "Clone");
	// A first-ever prompt has no parent: produce an empty, named clone.
	const cloned =
		opts.leaf === null
			? (() => {
					const empty = SessionManager.create(sm.getCwd(), opts.sessionDir);
					empty.newSession({ parentSession: opts.file });
					empty.appendSessionInfo(name);
					const destination = empty.getSessionFile()!;
					// Pi defers saving setup-only sessions until a user prompt.
					// This explicit empty clone must be reopenable right away.
					fs.writeFileSync(
						destination,
						[
							empty.getHeader(),
							...empty.getEntries(),
						]
							.map((entry) => JSON.stringify(entry))
							.join("\n") + "\n",
						{ flag: "wx" },
					);
					return destination;
				})()
			: sm.createBranchedSession(opts.leaf);
	if (!cloned || !fs.existsSync(cloned))
		throw new Error("couldn't write the new session");
	SessionManager.open(cloned).appendSessionInfo(name);
	const id = SessionManager.open(cloned, opts.sessionDir).getSessionId();
	try {
		opts.onCloned?.(id);
	} catch {
		// best effort — only the caller's metadata is affected
	}
	return { file: cloned, id, name };
}
