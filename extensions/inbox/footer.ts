/**
 * Inbox footer layout.
 *
 * Pi's built-in footer puts `~/path (branch) • session name` on its first line
 * and every extension status on the last. The inbox reorders that first line so
 * the session's group comes first, then the session name, while the directory
 * and git branch move to the right-hand side of the window:
 *
 *   GSI Data Platform • EC Feedback Follow-up PRs      ~/…/tickets (feat/x)
 *
 * How it works (pi has no public hook for the footer's content, so this patches
 * the bundled FooterComponent's prototype — the same instance interactive mode
 * uses, and the one visit-runtime.ts swaps setSession() on):
 *   - FooterComponent.render() keeps computing every line exactly as pi does;
 *     only line 0 is rebuilt here from `this.session` and `this.footerData`.
 *   - Blank/unexpected footer shapes fall through to pi's own lines untouched.
 *   - The patch installs once per process and reads live state from globalThis,
 *     so /reload swaps the group reader instead of wrapping render() twice.
 */

import * as os from "node:os";
import * as path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface FooterParts {
	/** Group name, shown first. */
	group?: string;
	/** Session name/title. */
	name?: string;
	/** Session working directory, already abbreviated to `~`. */
	dir?: string;
	/** Current git branch. */
	branch?: string;
}

export interface FooterStyle {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Replace the home prefix with `~` (pi's own footer does the same). */
export function homeDir(cwd: string): string {
	if (!cwd) return "";
	const home = os.homedir();
	if (!home) return cwd;
	if (cwd === home) return "~";
	return cwd.startsWith(home + path.sep) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Keep the last few path segments: `~/Code/a/b/tickets` → `…/b/tickets`. */
export function shortenDir(dir: string, keep = 2): string {
	const parts = dir.split("/");
	if (parts.length <= keep + 1) return dir;
	return `…/${parts.slice(-keep).join("/")}`;
}

/**
 * Build the footer's first line: `group • session name` on the left, the
 * directory and branch right-aligned. Returns undefined when there is nothing
 * to put on the left, so the caller can keep pi's own line.
 */
export function composeFooterLine(
	parts: FooterParts,
	width: number,
	style: FooterStyle,
): string | undefined {
	const left: string[] = [];
	if (parts.group) left.push(style.bold(style.fg("accent", parts.group)));
	if (parts.name) left.push(style.fg("text", parts.name));
	if (!left.length || width <= 0) return undefined;
	const leftText = left.join(style.fg("muted", " • "));

	const right = (dir: string, branch?: string) =>
		style.fg("dim", dir) +
		(branch ? style.fg("dim", ` (${branch})`) : "");
	const leftWidth = visibleWidth(leftText);
	const room = (r: string) =>
		leftWidth + (r ? 2 : 0) + visibleWidth(r) <= width;

	// Prefer the shortened path + branch; give up detail only when it doesn't fit.
	const candidates: string[] = [];
	if (parts.dir) {
		candidates.push(right(shortenDir(parts.dir), parts.branch));
		candidates.push(right(shortenDir(parts.dir)));
		candidates.push(right(parts.dir.split("/").pop() ?? parts.dir));
	}

	const rightText = candidates.find(room) ?? "";
	if (rightText === "") {
		// No directory fits: keep the group/title, cut it to the width.
		return truncateToWidth(leftText, width, "…");
	}
	const pad = " ".repeat(
		Math.max(1, width - leftWidth - visibleWidth(rightText)),
	);
	return truncateToWidth(leftText + pad + rightText, width);
}

/** The parts a mounted pi FooterComponent can tell us about its session. */
export function footerParts(
	footer: any,
	groupName: (id?: string) => string | undefined,
): FooterParts | undefined {
	const sm = footer?.session?.sessionManager;
	if (!sm || typeof sm.getCwd !== "function") return undefined;
	return {
		group: groupName(sm.getSessionId?.()),
		name: sm.getSessionName?.(),
		dir: homeDir(sm.getCwd() ?? ""),
		branch: footer?.footerData?.getGitBranch?.() ?? undefined,
	};
}

/**
 * Cached group lookup: the footer renders every frame, the store is a file.
 * Ungrouped sessions return undefined, so the footer leads with the title.
 */
export function createGroupNameReader(
	read: () => {
		groups: { id: string; name: string }[];
		sessions: Record<string, string>;
	},
	ttlMs = 1000,
) {
	let cache: { id: string; name: string | undefined; at: number } = {
		id: "",
		name: undefined,
		at: 0,
	};
	const groupName = (id?: string): string | undefined => {
		if (!id) return undefined;
		const now = Date.now();
		if (id !== cache.id || now - cache.at > ttlMs) {
			let name: string | undefined;
			try {
				const store = read();
				const groupId = Object.hasOwn(store.sessions, id)
					? store.sessions[id]
					: undefined;
				name = store.groups.find((group) => group.id === groupId)?.name;
			} catch {
				// A broken group store must not break the footer.
			}
			cache = { id, name, at: now };
		}
		return cache.name;
	};
	groupName.invalidate = () => {
		cache = { ...cache, at: 0 };
	};
	return groupName as ((id?: string) => string | undefined) & {
		invalidate(): void;
	};
}

export interface FooterState {
	groupName: (id?: string) => string | undefined;
	/** ctx.ui.theme: a live proxy, so theme switches apply without re-patching. */
	theme: FooterStyle;
	patched?: boolean;
}

export const FOOTER_STATE_KEY = Symbol.for("pi.ext.inbox.footer");

export function footerState(): FooterState {
	const g = globalThis as unknown as Record<symbol, FooterState | undefined>;
	return (g[FOOTER_STATE_KEY] ??= {
		groupName: () => undefined,
		theme: { fg: (_c, t) => t, bold: (t) => t },
	});
}

/** Replace pi's first footer line with the inbox ordering. */
export function patchFooterRender(Footer: any): void {
	const state = footerState();
	if (state.patched) return; // /reload: swap the reader, keep one wrapper
	const proto = Footer?.prototype;
	if (!proto || typeof proto.render !== "function") return;
	const original = proto.render;
	proto.render = function (this: any, width: number): string[] {
		const lines = original.call(this, width);
		try {
			const live = footerState();
			const line = composeFooterLine(
				footerParts(this, live.groupName) ?? {},
				width,
				live.theme,
			);
			return line === undefined ? lines : [line, ...lines.slice(1)];
		} catch {
			// An unfamiliar footer shape keeps pi's own first line.
			return lines;
		}
	};
	state.patched = true;
}
