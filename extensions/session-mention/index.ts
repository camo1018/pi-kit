/**
 * session-mention — reference other Pi sessions from a prompt with `@[...]`.
 *
 * Autocomplete always inserts the immutable session id, while showing the
 * human-readable title. On each model request, mentions are expanded only in
 * Pi's in-flight context clone. The saved prompt remains exactly as typed.
 * Transcript bodies are size-bounded and XML-escaped before being placed in a
 * <skill>-shaped envelope.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import { transcriptMarkdown } from "../../lib/inbox-agents.ts";
import { InboxGroups, type GroupStore } from "../inbox/groups.ts";
import {
	indexSessionIdentities,
	renderQuotedSession,
	wrapQuotedSessions,
} from "./format.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getAgentDir,
	SessionManager,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

// `@[` = any saved session; `@g[` = this session's group, archived hidden;
// `@ga[` = this session's group, archived included.
const COMPLETION_PATTERN = /(?:^|[\s([{<"'`])(@(?:ga|g)?\[)([^\]\n]*)$/;
const TOKEN_PATTERN = /(^|[\s([{<"'])@\[([^\]\n]+)\]/g;
const MAX_SESSION_TRANSCRIPT_CHARS = 24 * 1024;
const MAX_REQUEST_TRANSCRIPT_CHARS = 64 * 1024;
const MAX_REQUEST_SESSION_MENTIONS = 16;
const MIN_TRANSCRIPT_CHARS = 256;

interface SessionRef {
	info: SessionInfo;
	preview: string;
	dir: string;
}

interface SessionIndex {
	byId: Map<string, SessionInfo>;
	byName: Map<string, SessionInfo>;
}

interface MentionOccurrence {
	start: number;
	end: number;
	info: SessionInfo;
}

interface TextSlot {
	text: string;
	set(value: string): void;
}

function previewOf(info: SessionInfo): string {
	return info.firstMessage.replace(/\s+/g, " ").trim().slice(0, 60);
}

function byModified(a: SessionRef, b: SessionRef): number {
	return b.info.modified.getTime() - a.info.modified.getTime();
}

/**
 * Destination group of the session being composed, when the current session has
 * no membership of its own.
 *
 * The inbox only writes membership to inbox-groups.json at spawn time, so while
 * you are typing the first prompt of a new background agent the chosen group
 * lives on the inbox's pending reply target (ctrl+g) or its one-off/default
 * pre-pick. Read those globals with the inbox's own precedence; without this,
 * `@g[` always claimed the composing session was ungrouped.
 */
function composedGroupId(store: GroupStore): string | undefined {
	const global = globalThis as any;
	const target = global[Symbol.for("pi.inbox.reply-target")];
	if (target?.kind === "new" && typeof target.groupId === "string") {
		return target.groupId;
	}
	const preset = global[Symbol.for("pi.inbox.next-agent-group")];
	if (preset === "ungrouped") return undefined;
	if (typeof preset === "string" && preset !== "all") {
		return store.groups.some((group) => group.id === preset)
			? preset
			: store.defaultGroupId;
	}
	// Mirrors the inbox's newAgentGroup(): the current group view, else the
	// default group for the All view. Only when orchestrator mode is on: a plain
	// foreground session must not borrow a view filter's group.
	if (!global[Symbol.for("pi.inbox.mode")]?.on) return undefined;
	const view = global[Symbol.for("pi.inbox.group-view")] ?? "all";
	if (view === "ungrouped") return undefined;
	return store.groups.some((group) => group.id === view)
		? view
		: store.defaultGroupId;
}

let cachedAt = 0;
let cachedSessions: SessionRef[] | undefined;
let inflight: Promise<SessionRef[]> | undefined;
let cachedArchivedAt = 0;
let cachedArchived: Set<string> | undefined;
/** Group-id → its members' refs. A group has a handful of members, not 500. */
const groupCache = new Map<string, { at: number; refs: SessionRef[] }>();
const groupInflight = new Map<string, Promise<SessionRef[]>>();
export function clearSessionCache(): void {
	cachedAt = 0;
	cachedSessions = undefined;
	inflight = undefined;
	cachedArchivedAt = 0;
	cachedArchived = undefined;
	groupCache.clear();
	groupInflight.clear();
}

/**
 * Session ids the Inbox has archived. Archive state lives in inbox.json, not
 * in the session file, and only the Inbox writes it. A short cache keeps
 * autocomplete keystrokes from re-reading it; 1s matches the session cache.
 */
function archivedSessionIds(): Set<string> {
	const now = Date.now();
	if (cachedArchived && now - cachedArchivedAt < 1000) return cachedArchived;
	const ids = new Set<string>();
	try {
		const raw = fs.readFileSync(
			path.join(getAgentDir(), "inbox.json"),
			"utf8",
		);
		const sessions = JSON.parse(raw)?.sessions;
		if (sessions && typeof sessions === "object") {
			for (const [id, meta] of Object.entries(sessions)) {
				if (
					meta && typeof meta === "object" &&
					(meta as { archivedAt?: number }).archivedAt
				) ids.add(id);
			}
		}
	} catch {
		// Missing or unreadable inbox.json means nothing is archived.
	}
	cachedArchived = ids;
	cachedArchivedAt = now;
	return ids;
}

function toRef(info: SessionInfo): SessionRef {
	return {
		info,
		preview: previewOf(info),
		dir: info.cwd.split("/").filter(Boolean).pop() ?? info.cwd,
	};
}

async function listSessions(): Promise<SessionRef[]> {
	const now = Date.now();
	if (cachedSessions && now - cachedAt < 1000) return cachedSessions;
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			const infos = await SessionManager.listAll();
			return infos
				.filter((info) => info.messageCount > 0)
				.map(toRef)
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

/**
 * Session files whose name ends in one of `ids`, one pass over the session tree.
 *
 * Pi names files `<timestamp>_<session-id>.jsonl`, so the folder layout plus the
 * filename suffix identifies a session without opening anything. This is the
 * whole point of the group path: `SessionManager.listAll()` reads every line of
 * every session (496 files / 543 MB here) to answer a question the filenames
 * already answer for a group of a few dozen. Unreadable dirs are skipped, and a
 * missing id just isn't found — the caller falls back to the full listing.
 */
function findSessionFiles(ids: Set<string>): Map<string, string> {
	const found = new Map<string, string>();
	if (ids.size === 0) return found;
	const root = path.join(getAgentDir(), "sessions");
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const dir of dirs) {
		if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
		let names: string[];
		try {
			names = fs.readdirSync(path.join(root, dir.name));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const stem = name.slice(0, -".jsonl".length);
			for (const id of ids) {
				if (stem.endsWith(id) && !found.has(id)) {
					found.set(id, path.join(root, dir.name, name));
					break;
				}
			}
		}
	}
	return found;
}

/**
 * Header + name only, without pi's full parse. A mention needs the title and
 * the transcript path; `messageCount` is taken from the manager's entry count.
 */
function refFromFile(file: string, id: string): SessionRef | undefined {
	try {
		const stat = fs.statSync(file);
		const fd = fs.openSync(file, "r");
		let head = "";
		try {
			const buf = Buffer.alloc(64 * 1024);
			const read = fs.readSync(fd, buf, 0, buf.length, 0);
			head = buf.subarray(0, read).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
		const firstLine = head.split("\n", 1)[0] ?? "";
		const header = JSON.parse(firstLine);
		if (header?.type !== "session") return undefined;
		const name = sessionNameFromFile(file);
		const info = {
			path: file,
			id,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			name,
			created: new Date(header.timestamp),
			modified: stat.mtime,
			messageCount: 1, // a real, readable session; 0 would hide it
			firstMessage: "",
			allMessagesText: "",
		} as unknown as SessionInfo;
		return { info, preview: name ?? "", dir: shortDir(info.cwd) };
	} catch {
		return undefined;
	}
}

function shortDir(cwd: string): string {
	return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/** Last session_info name in the file, read backwards a chunk at a time. */
function sessionNameFromFile(file: string): string | undefined {
	try {
		const size = fs.statSync(file).size;
		let fd: number | undefined;
		try {
			fd = fs.openSync(file, "r");
			let pos = size;
			while (pos > 0) {
				const len = Math.min(64 * 1024, pos);
				pos -= len;
				const buf = Buffer.alloc(len);
				fs.readSync(fd, buf, 0, len, pos);
				const lines = buf.toString("utf8").split("\n");
				for (let i = lines.length - 1; i >= 0; i--) {
					const line = lines[i];
					if (!line || !line.includes("session_info")) continue;
					try {
						const entry = JSON.parse(line);
						if (
							entry?.type === "session_info" &&
							typeof entry.name === "string"
						) return entry.name.trim() || undefined;
					} catch {
						// partial line from a chunk boundary; skip it
					}
				}
			}
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	} catch {
		// unreadable → unnamed
	}
	return undefined;
}

/**
 * The full listing, narrowed to `memberIds`. Used when filename resolution can't
 * account for every member, so the picker still shows exactly the group.
 */
async function listSessionsIn(
	memberIds: Set<string>,
): Promise<SessionRef[]> {
	return (await listSessions()).filter((ref) =>
		memberIds.has(ref.info.id),
	);
}

/**
 * Members of one group, resolved from filenames instead of pi's full scan.
 * Falls back to the full listing when any member id has no file (a renamed or
 * copied session), so the picker is never silently missing a session.
 */
async function listGroupSessions(
	groupId: string,
	memberIds: Set<string>,
): Promise<SessionRef[]> {
	const now = Date.now();
	const cached = groupCache.get(groupId);
	if (cached && now - cached.at < 1000) return cached.refs;
	const pending = groupInflight.get(groupId);
	if (pending) return pending;
	const work = (async () => {
		try {
			const files = findSessionFiles(memberIds);
			if (files.size !== memberIds.size) {
				return await listSessionsIn(memberIds);
			}
			const refs: SessionRef[] = [];
			for (const [id, file] of files) {
				const ref = refFromFile(file, id);
				if (ref) refs.push(ref);
			}
			// A file that exists but doesn't parse is a real session we can't
			// describe; the full listing has its own tolerant parser.
			if (refs.length !== files.size) {
				return await listSessionsIn(memberIds);
			}
			return refs.sort(byModified);
		} catch {
			return await listSessionsIn(memberIds);
		} finally {
			groupInflight.delete(groupId);
		}
	})();
	groupInflight.set(groupId, work);
	const refs = await work;
	groupCache.set(groupId, { at: now, refs });
	return refs;
}

function codeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const pattern = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text))) {
		ranges.push([match.index, match.index + match[0].length]);
	}
	return ranges;
}

function findSessionMentions(
	text: string,
	index: SessionIndex,
): MentionOccurrence[] {
	const code = codeRanges(text);
	const inCode = (position: number) =>
		code.some(([start, end]) => position >= start && position < end);
	const found: MentionOccurrence[] = [];
	for (const match of text.matchAll(TOKEN_PATTERN)) {
		const start = (match.index ?? 0) + match[1].length;
		if (inCode(start)) continue;
		const token = match[2];
		const info = index.byId.get(token) ?? index.byName.get(token);
		if (!info) continue;
		found.push({
			start,
			end: start + token.length + 3,
			info,
		});
	}
	return found;
}

function labelOf(ref: SessionRef): string {
	return ref.info.name || ref.preview || "(no messages)";
}

function titleOf(info: SessionInfo): string {
	return (info.name || previewOf(info) || info.id).slice(0, 200);
}

function markerOf(info: SessionInfo): string {
	const title = titleOf(info)
		.replace(/[<>&«»\r\n]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return `«${title || info.id}»`;
}

function textSlots(message: any): TextSlot[] {
	if (typeof message?.content === "string") {
		return [{
			text: message.content,
			set: (value) => {
				message.content = value;
			},
		}];
	}
	if (!Array.isArray(message?.content)) return [];
	const slots: TextSlot[] = [];
	message.content.forEach((part: any, index: number) => {
		if (part?.type !== "text" || typeof part.text !== "string") return;
		slots.push({
			text: part.text,
			set: (value) => {
				message.content[index] = { ...part, text: value };
			},
		});
	});
	return slots;
}

/** Skip a block another request-time extension already prepended. */
function authoredOffset(text: string): number {
	if (!/^\s*<skill\b/.test(text)) return 0;
	const end = text.indexOf("</skill>");
	return end < 0 ? text.length : end + "</skill>".length;
}

function prependToMessage(message: any, block: string): void {
	if (typeof message.content === "string") {
		message.content = `${block}\n\n${message.content}`;
		return;
	}
	if (!Array.isArray(message.content)) return;
	const index = message.content.findIndex(
		(part: any) => part?.type === "text",
	);
	if (index < 0) {
		message.content.unshift({ type: "text", text: block });
		return;
	}
	const part = message.content[index];
	message.content[index] = {
		...part,
		text: `${block}\n\n${part.text ?? ""}`,
	};
}

function replaceMentions(
	slot: TextSlot,
	mentions: MentionOccurrence[],
	includedIds: Set<string>,
): void {
	let text = slot.text;
	const replacements = mentions
		.filter((mention) => includedIds.has(mention.info.id))
		.sort((a, b) => b.start - a.start);
	for (const mention of replacements) {
		text =
			text.slice(0, mention.start) +
			markerOf(mention.info) +
			text.slice(mention.end);
	}
	slot.set(text);
}

function readTranscript(info: SessionInfo): string {
	try {
		return transcriptMarkdown(info.path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `_Could not read session: ${message}_`;
	}
}

function buildMentionBlock(
	infos: SessionInfo[],
	budget: number,
	maxSessions: number,
): {
	block?: string;
	includedIds: Set<string>;
	bodyChars: number;
} {
	const rendered = [];
	const names: string[] = [];
	const includedIds = new Set<string>();
	let remaining = budget;
	let bodyChars = 0;
	for (const info of infos.slice(0, maxSessions)) {
		const limit = Math.min(MAX_SESSION_TRANSCRIPT_CHARS, remaining);
		if (limit < MIN_TRANSCRIPT_CHARS) break;
		const session = renderQuotedSession(
			{
				id: info.id,
				title: titleOf(info),
				cwd: info.cwd,
				body: readTranscript(info),
			},
			limit,
		);
		rendered.push(session);
		names.push(titleOf(info));
		includedIds.add(info.id);
		bodyChars += session.bodyChars;
		remaining -= session.bodyChars;
	}
	if (rendered.length === 0) {
		return { includedIds, bodyChars };
	}
	return {
		block: wrapQuotedSessions(rendered, names, infos[0].path),
		includedIds,
		bodyChars,
	};
}

export default function (pi: ExtensionAPI): void {
	registerLoadedExtension("session-mention");

	pi.on("context", async (event) => {
		const userMessages = event.messages.filter(
			(message: any) => message?.role === "user",
		) as any[];
		if (!userMessages.some((message) =>
			textSlots(message).some((slot) => slot.text.includes("@[")))) {
			return;
		}

		const index: SessionIndex = indexSessionIdentities(
			(await listSessions()).map((session) => session.info),
		);
		let remaining = MAX_REQUEST_TRANSCRIPT_CHARS;
		let remainingSessions = MAX_REQUEST_SESSION_MENTIONS;
		for (const message of [...userMessages].reverse()) {
			if (
				remaining < MIN_TRANSCRIPT_CHARS ||
				remainingSessions === 0
			) {
				break;
			}
			const slots = textSlots(message);
			const mentionsBySlot = new Map<TextSlot, MentionOccurrence[]>();
			const infos = new Map<string, SessionInfo>();
			for (const slot of slots) {
				const offset = authoredOffset(slot.text);
				const mentions = findSessionMentions(
					slot.text.slice(offset),
					index,
				).map((mention) => ({
					...mention,
					start: mention.start + offset,
					end: mention.end + offset,
				}));
				if (mentions.length === 0) continue;
				mentionsBySlot.set(slot, mentions);
				for (const mention of mentions) {
					infos.set(mention.info.id, mention.info);
				}
			}
			if (infos.size === 0) continue;

			const built = buildMentionBlock(
				[...infos.values()],
				remaining,
				remainingSessions,
			);
			if (!built.block) continue;
			for (const [slot, mentions] of mentionsBySlot) {
				replaceMentions(slot, mentions, built.includedIds);
			}
			prependToMessage(message, built.block);
			remaining -= built.bodyChars;
			remainingSessions -= built.includedIds.size;
		}
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(
				lines,
				cursorLine,
				cursorCol,
				options,
			) {
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const match = before.match(COMPLETION_PATTERN);
				if (!match) {
					return current.getSuggestions(
						lines,
						cursorLine,
						cursorCol,
						options,
					);
				}

				const trigger = match[1]; // "@[", "@g[" or "@ga["
				const query = match[2] ?? "";
				const isGroupOnly = trigger === "@g[" || trigger === "@ga[";
				const includeArchived = trigger === "@ga[";

				let groupName: string | undefined;
				let groupSessionIds: Set<string> | undefined;
				let currentGroupId: string | undefined;

				if (isGroupOnly) {
					const currentSessionId =
						ctx.sessionManager?.getSessionId?.();
					if (currentSessionId) {
						try {
							const groupsStore = new InboxGroups(
								getAgentDir(),
							).load();
							currentGroupId =
								groupsStore.sessions[currentSessionId];
							if (!currentGroupId) {
								// A new agent's group is picked before it exists.
								currentGroupId = composedGroupId(groupsStore);
							}
							if (currentGroupId) {
								const grp = groupsStore.groups.find(
									(g) => g.id === currentGroupId,
								);
								groupName = grp?.name ?? "Current Group";
								groupSessionIds = new Set(
									Object.entries(groupsStore.sessions)
										.filter(
											([sid, gid]) =>
												gid === currentGroupId &&
												sid !== currentSessionId,
										)
										.map(([sid]) => sid),
								);
							}
						} catch {
							// Ignore groups load errors; treat as ungrouped
						}
					}

					if (!currentGroupId) {
						return {
							prefix: `${trigger}${query}`,
							items: [
								{
									value: "",
									label: "(No group for this session)",
									description:
										"Ungrouped: pick a destination with ctrl+g, " +
										"or use @[ to search every session",
								},
							],
						};
					}
				}

				let sessions: SessionRef[];
				if (isGroupOnly && groupSessionIds && currentGroupId) {
					// Filename resolution: only this group's files are touched, so the
					// picker doesn't read the whole session tree on every keystroke.
					sessions = await listGroupSessions(
						currentGroupId,
						groupSessionIds,
					);
					if (!includeArchived) {
						const archived = archivedSessionIds();
						sessions = sessions.filter(
							(s) => !archived.has(s.info.id),
						);
					}
					if (sessions.length === 0) {
						return {
							prefix: `${trigger}${query}`,
							items: [
								{
									value: "",
									label: includeArchived
										? `(No sessions in ${groupName})`
										: `(No other sessions in ${groupName})`,
									description: includeArchived
										? "No saved sessions found in this group"
										: "No unarchived sessions in this group; " +
											"try @ga[ to include archived ones",
								},
							],
						};
					}
				} else {
					sessions = await listSessions();
				}

				const matches = query
					? fuzzyFilter(
							sessions,
							query,
							(session) =>
								`${session.info.name ?? ""} ` +
								`${session.preview} ${session.dir} ` +
								`${session.info.id}`,
						)
					: sessions.slice(0, 20);
				if (matches.length === 0) {
					return current.getSuggestions(
						lines,
						cursorLine,
						cursorCol,
						options,
					);
				}

				const relative = (date: Date) => {
					const seconds = Math.floor(
						(Date.now() - date.getTime()) / 1000,
					);
					if (seconds < 60) return `${seconds}s`;
					if (seconds < 3600) {
						return `${Math.floor(seconds / 60)}m`;
					}
					if (seconds < 86400) {
						return `${Math.floor(seconds / 3600)}h`;
					}
					return `${Math.floor(seconds / 86400)}d`;
				};

				return {
					prefix: `${trigger}${query}`,
					items: matches.slice(0, 20).map((session) => ({
						value: `@[${session.info.id}]`,
						label: labelOf(session),
						description:
							`${session.dir} · ` +
							`${relative(session.info.modified)} · ` +
							`${session.info.messageCount} msg · ` +
							`${session.info.id}`,
					})),
				};
			},

			applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			) {
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol);
				const match = before.match(COMPLETION_PATTERN);
				if (!match) {
					return current.applyCompletion(
						lines,
						cursorLine,
						cursorCol,
						item,
						prefix,
					);
				}

				const trigger = match[1]; // "@[", "@g[" or "@ga["
				const query = match[2] ?? "";
				const tokenStart = cursorCol - (query.length + trigger.length);

				// Placeholder items (e.g. ungrouped warning or empty group) have empty value
				if (!item.value) {
					return {
						lines,
						cursorLine,
						cursorCol,
					};
				}

				if (!item.value.startsWith("@[")) {
					return current.applyCompletion(
						lines,
						cursorLine,
						cursorCol,
						item,
						prefix,
					);
				}

				const after = line.slice(cursorCol);
				const insert = after.startsWith(" ")
					? item.value
					: `${item.value} `;
				const newLines = [...lines];
				newLines[cursorLine] =
					line.slice(0, tokenStart) + insert + after;
				return {
					lines: newLines,
					cursorLine,
					cursorCol: tokenStart + insert.length,
				};
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(
					lines,
					cursorLine,
					cursorCol,
				) ?? true;
			},
		}));
	});
}
