/**
 * Tree Position Extension for Pi
 *
 * Makes a `/tree` navigation stick across session switches, reloads and
 * restarts. Without this, Pi keeps the navigated leaf in memory only: when a
 * session file is reopened, `SessionManager._buildIndex()` makes the LAST
 * entry in the file the leaf, so you land on the newest branch instead of the
 * point you navigated to.
 *
 * How it works:
 *   - On `session_shutdown` (switch / new / fork / reload / quit), if the
 *     in-memory leaf is not the last entry in the file, append a tiny custom
 *     entry (`pi-kit.tree-position`) as a child of the current leaf. Custom
 *     entries are excluded from model context, and because it is now the
 *     last entry, Pi's own loader resumes on it — i.e. on your tree position.
 *   - Any draft in the editor (e.g. the user message `/tree` put back for
 *     editing) is stored in the marker and restored on `session_start` when
 *     the session reopens on that marker.
 *   - At most one marker per position: if the last entry already is a
 *     marker for the current position (return, step off and back onto it,
 *     leave again), nothing is written.
 *   - Nothing is written when you navigate and then prompt (the prompt
 *     appends normally), or when you never left the latest leaf.
 *   - Safety: if the file on disk has entries this process doesn't know
 *     about (e.g. a background agent is writing the same file), skip; the
 *     in-memory leaf would be stale.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";

const MARKER = "pi-kit.tree-position";

interface MarkerData {
	editorText?: string;
}

/** id of the last JSONL entry on disk, reading backwards in chunks. */
function lastEntryIdOnDisk(file: string): string | undefined {
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

export default function (pi: ExtensionAPI) {
	registerLoadedExtension("tree-position");

	pi.on("session_shutdown", (_event, ctx: any) => {
		const sm = ctx?.sessionManager;
		if (!sm) return;
		const entries = sm.getEntries();
		const last = entries.at(-1);
		if (!last) return;
		const leafId: string | null = sm.getLeafId();
		if (leafId === last.id) return;
		// Already marked at this position: don't stack a second marker on
		// return → step off → back on → leave again.
		if (
			last.type === "custom" &&
			last.customType === MARKER &&
			last.parentId === leafId
		)
			return;

		const file: string | undefined = sm.getSessionFile?.();
		if (file && lastEntryIdOnDisk(file) !== last.id) return;

		const data: MarkerData = {};
		const draft = ctx.hasUI ? ctx.ui.getEditorText?.() : "";
		if (draft?.trim()) data.editorText = draft;
		pi.appendEntry(MARKER, data);
	});

	pi.on("session_start", (_event, ctx: any) => {
		if (!ctx?.hasUI) return;
		const leaf = ctx.sessionManager?.getLeafEntry?.();
		if (leaf?.type !== "custom" || leaf.customType !== MARKER) return;
		const text = (leaf.data as MarkerData | undefined)?.editorText;
		if (!text) return;
		// Defer so we run after Pi finishes rebinding the editor.
		setTimeout(() => {
			if (!ctx.ui.getEditorText?.()?.trim()) ctx.ui.setEditorText(text);
		}, 0);
	});
}
