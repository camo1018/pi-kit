/**
 * session-mention — reference other Pi sessions from a prompt with `@[...]`.
 *
 * - Typing `@[` opens a fuzzy picker over ALL saved sessions (all projects),
 *   matched by name, first message, cwd basename, or session id.
 *   Accepting inserts `@[session-id]` in place — plain `@` file completion is
 *   untouched for everything else.
 * - On submit, every `@[id]` token is expanded: the referenced session's
 *   active-branch transcript is rendered as markdown and injected as a
 *   <skill>-shaped block ahead of your message (pi's TUI collapses that shape
 *   in user messages, so the injected transcript doesn't flood the chat view).
 *   The token itself is replaced with a short «name» marker so your sentence
 *   still reads.
 * - Tokens inside `inline code` or fenced blocks are ignored; unknown ids are
 *   left untouched (so `@[...]` in code stays literal).
 *
 * Works for every submit path (plain, steering, follow-up, queued) because it
 * rides the `input` event, which runs before skill/template expansion on all
 * of them.
 *
 * Requires lib/inbox-agents.ts (transcriptMarkdown). No Pi internals beyond
 * public extension APIs — see README.md.
 */

import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import { transcriptMarkdown } from "../../lib/inbox-agents.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

// `@[query` immediately before the cursor, preceded by start/whitespace/opening punctuation.
// Mirrors the token shape pi-tui uses for @ file completion, but requires the '[' after '@'.
const COMPLETION_PATTERN = /(?:^|[\s([{<"'`])@\[([\w.:+\- /]*)$/;
// `@[id]` tokens in submitted text.
const TOKEN_PATTERN = /(^|[\s([{<"''])@\[([A-Za-z0-9][\w.\-]*)\]/g;

interface SessionRef {
	info: SessionInfo;
	/** Length-1 preview of the session's first user message. */
	preview: string;
	/** cwd basename for display. */
	dir: string;
}

function previewOf(info: SessionInfo): string {
	return info.firstMessage.replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Compare by modified time, newest first. */
function byModified(a: SessionRef, b: SessionRef): number {
	return b.info.modified.getTime() - a.info.modified.getTime();
}

/** List sessions once per autocomplete burst, cached for 1s (typing re-queries). */
let cachedAt = 0;
let cachedSessions: SessionRef[] | undefined;
let inflight: Promise<SessionRef[]> | undefined;
async function listSessions(): Promise<SessionRef[]> {
	const now = Date.now();
	if (cachedSessions && now - cachedAt < 1000) return cachedSessions;
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			const infos = await SessionManager.listAll();
			return infos
				.filter((info) => info.messageCount > 0)
				.map((info) => ({
					info,
					preview: previewOf(info),
					dir: info.cwd.split("/").filter(Boolean).pop() ?? info.cwd,
				}))
				.sort(byModified);
		} catch {
			return [];
		} finally {
			inflight = undefined;
		}
	})();
	const result = await inflight;
	cachedSessions = result;
	cachedAt = now;
	return result;
}

/** Return [start, end) ranges covered by fenced or inline code. */
function codeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length]);
	return ranges;
}

function findSessionMentions(
	text: string,
	sessions: Map<string, SessionInfo>,
): Array<{ match: string; info: SessionInfo }> {
	const code = codeRanges(text);
	const inCode = (i: number) => code.some(([s, e]) => i >= s && i < e);
	const found: Array<{ match: string; info: SessionInfo }> = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(TOKEN_PATTERN)) {
		const atIdx = (m.index ?? 0) + m[1].length;
		if (inCode(atIdx)) continue;
		const id = m[2];
		const info = sessions.get(id);
		// Replace only the `@[id]` part (not the preceding boundary char) so the
		// user's sentence spacing is preserved.
		if (info && !seen.has(id)) {
			seen.add(id);
			found.push({ match: `@[${id}]`, info });
		}
	}
	return found;
}

/** Display label for a session: name, else first-message preview. */
function labelOf(ref: SessionRef): string {
	return ref.info.name || ref.preview || "(no messages)";
}

function titleOf(info: SessionInfo): string {
	return info.name || previewOf(info) || info.id;
}

/** Render the mention block for one or more referenced sessions. */
function buildMentionBlock(mentions: Array<{ info: SessionInfo }>): string {
	const parts: string[] = [];
	for (const { info } of mentions) {
		let body: string;
		try {
			body = transcriptMarkdown(info.path);
		} catch (err) {
			body = `_Could not read session: ${err instanceof Error ? err.message : String(err)}_`;
		}
		parts.push(
			`<session id="${info.id}" name="${titleOf(info).replace(/"/g, "'")}" cwd="${info.cwd}">\n${body}\n</session>`,
		);
	}
	return parts.length === 1
		? parts[0]
		: `<sessions>\nThe user referenced multiple sessions inline. Each session follows.\n\n${parts.join("\n\n")}\n</sessions>`;
}

export default function (pi: ExtensionAPI): void {
	registerLoadedExtension("session-mention");

	// ---- Expand @[id] mentions on submit ---------------------------------
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const text = event.text;
		if (!text.includes("@[")) return { action: "continue" };

		// Index known sessions by id for token resolution.
		const byId = new Map<string, SessionInfo>();
		for (const s of await listSessions()) byId.set(s.info.id, s.info);

		const mentions = findSessionMentions(text, byId);
		if (mentions.length === 0) return { action: "continue" };

		try {
			// Replace each token with a short readable marker, then prepend the
			// transcript block (skill-block pattern: TUI collapses it).
			let newText = text;
			for (const { match, info } of mentions) {
				const marker = `«${titleOf(info).replace(/[«»]/g, "")}»`;
				newText = newText.split(match).join(marker);
			}
			const block = buildMentionBlock(mentions);
			const names = mentions.map((m) => titleOf(m.info)).join(", ");
			return {
				action: "transform",
				// Skill-block shape: name + location attrs, body, blank line, rest.
				// pi's TUI collapses this pattern in the user message, so the
				// injected transcript doesn't flood the chat view.
				text: `<skill name="↪ ${names}" location="${mentions[0].info.path}">\n${block}\n</skill>\n\n${newText}`,
			};
		} catch (err) {
			ctx.ui.notify(
				`session-mention: failed to load session: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return { action: "continue" };
		}
	});

	// ---- `@[` autocomplete -------------------------------------------------
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const match = before.match(COMPLETION_PATTERN);
				if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

				const query = match[1] ?? "";
				const sessions = await listSessions();
				const matches = query
					? fuzzyFilter(sessions, query, (s) =>
							`${s.info.name ?? ""} ${s.preview} ${s.dir} ${s.info.id}`,
						)
					: sessions.slice(0, 20);
				if (matches.length === 0) {
					// No session matches: fall back to file completion so `@` stays useful.
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				const rel = (d: Date) => {
					const s = Math.floor((Date.now() - d.getTime()) / 1000);
					if (s < 60) return `${s}s`;
					if (s < 3600) return `${Math.floor(s / 60)}m`;
					if (s < 86400) return `${Math.floor(s / 3600)}h`;
					return `${Math.floor(s / 86400)}d`;
				};

				return {
					prefix: `@[${query}`,
					items: matches.slice(0, 20).map((s) => ({
						value: `@[${s.info.id}]`,
						label: labelOf(s),
						description: `${s.dir} · ${rel(s.info.modified)} · ${s.info.messageCount} msg · ${s.info.id}`,
					})),
				};
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol);
				const match = before.match(COMPLETION_PATTERN);
				if (!match || !item.value.startsWith("@[")) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				}

				// Replace from the '@[' to the cursor with the full token.
				const tokenStart = cursorCol - (match[1].length + 2);
				const after = line.slice(cursorCol);
				const insert = after.startsWith(" ") ? item.value : `${item.value} `;
				const newLines = [...lines];
				newLines[cursorLine] = line.slice(0, tokenStart) + insert + after;
				return { lines: newLines, cursorLine, cursorCol: tokenStart + insert.length };
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}
