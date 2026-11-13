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
 * Group a pending inbox action is aimed at, if any. `undefined` means the
 * pending action is explicitly ungrouped; `null` means nothing is pending.
 */
function pendingTargetGroup(
	store: GroupStore,
	sessionId?: string,
): string | null | undefined {
	const global = globalThis as any;
	const target = global[Symbol.for("pi.inbox.reply-target")];
	// Composing a new agent: its destination is chosen before it exists, so it
	// is not in inbox-groups.json yet.
	if (target?.kind === "new") {
		return typeof target.groupId === "string" ? target.groupId : undefined;
	}
	// Replying to an existing agent: the work happens in *its* group, not yours.
	if (target?.kind === "agent" && typeof target.id === "string") {
		if (target.id === sessionId) return null;
		return store.sessions[target.id];
	}
	// The one-off pre-pick (F) for the next new agent.
	const preset = global[Symbol.for("pi.inbox.next-agent-group")];
	if (preset === "ungrouped") return undefined;
	if (typeof preset === "string" && preset !== "all") {
		return store.groups.some((group) => group.id === preset)
			? preset
			: store.defaultGroupId;
	}
	return null;
}

/**
 * The group `@g[` means for the session being typed in.
 *
 * Precedence, most specific first: the group the pending inbox action is
 * aimed at (composing a new agent, or replying to one), the next-agent one-off
 * pre-pick, this session's own membership, then (orchestrator mode only) the
 * inbox's current group view. Reading membership first made `@g[` list the
 * sender's group while composing into a different one, which looks exactly
 * like "it is picking up other groups".
 */
function mentionGroupId(
	store: GroupStore,
	sessionId?: string,
): string | undefined {
	const pending = pendingTargetGroup(store, sessionId);
	if (pending !== null) return pending;
	if (sessionId && store.sessions[sessionId]) {
		return store.sessions[sessionId];
	}
	// Mirrors the inbox's newAgentGroup(): the current group view, else the
	// default group for the All view. Only when orchestrator mode is on: a plain
	// foreground session must not borrow a view filter's group.
	const global = globalThis as any;
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
	fileIndexAt = 0;
	fileIndex = undefined;
	headerIds.clear();
	nameIndex.clear();
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
 * Every session file on disk, plus a filename-stem index. A readdir of the
 * session tree is ~3 ms; pi's `SessionManager.listAll()` is ~2.5 s because it
 * parses every line of every file. `@g[` therefore never calls it.
 */
let fileIndexAt = 0;
let fileIndex: { files: string[]; byStem: Map<string, string> } | undefined;
/**
 * Session id from a file's header, memoised per path. A path's header line is
 * written once and never rewritten, so this never goes stale; it only grows.
 * Only read for files whose name doesn't already end in a wanted id, which is
 * how a renamed or copied transcript is still found without a full scan.
 */
const headerIds = new Map<string, string | null>();

function sessionFiles(): { files: string[]; byStem: Map<string, string> } {
	const now = Date.now();
	if (fileIndex && now - fileIndexAt < 1000) return fileIndex;
	const files: string[] = [];
	const byStem = new Map<string, string>();
	const root = path.join(getAgentDir(), "sessions");
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		dirs = [];
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
			const file = path.join(root, dir.name, name);
			files.push(file);
			byStem.set(name.slice(0, -".jsonl".length), file);
		}
	}
	// Drop memo entries for files that no longer exist.
	if (headerIds.size > files.length * 2) {
		const live = new Set(files);
		for (const file of headerIds.keys()) {
			if (!live.has(file)) headerIds.delete(file);
		}
	}
	fileIndex = { files, byStem };
	fileIndexAt = now;
	return fileIndex;
}

function headerIdOf(file: string): string | null {
	if (headerIds.has(file)) return headerIds.get(file) ?? null;
	let id: string | null = null;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(4096);
			const read = fs.readSync(fd, buf, 0, buf.length, 0);
			const first = buf.subarray(0, read).toString("utf8")
				.split("\n", 1)[0] ?? "";
			const header = JSON.parse(first);
			if (header?.type === "session" && typeof header.id === "string") {
				id = header.id;
			}
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// Unparsable header: the file simply isn't a session we can name.
	}
	headerIds.set(file, id);
	return id;
}

/**
 * Session files for `ids`.
 *
 * Pi names files `<timestamp>_<session-id>.jsonl`, so the stem answers the
 * question without opening anything. Ids the stems don't account for are
 * matched against header ids instead — a renamed or copied transcript still
 * resolves. Ids that resolve neither way are gone (a deleted session whose
 * group membership outlived it) and are reported missing rather than forcing a
 * full scan of the tree, which is what made `@g[` take seconds.
 */
function findSessionFiles(ids: Set<string>): Map<string, string> {
	const found = new Map<string, string>();
	if (ids.size === 0) return found;
	const { files, byStem } = sessionFiles();
	const claimed = new Set<string>();
	for (const id of ids) {
		for (const [stem, file] of byStem) {
			if (!stem.endsWith(id)) continue;
			found.set(id, file);
			claimed.add(file);
			break;
		}
	}
	if (found.size === ids.size) return found;
	for (const file of files) {
		if (claimed.has(file)) continue;
		const headerId = headerIdOf(file);
		if (!headerId || !ids.has(headerId) || found.has(headerId)) continue;
		found.set(headerId, file);
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
		let header: any;
		try {
			header = JSON.parse(firstLine);
		} catch {
			// A file that matched by name but has an unreadable header is still a
			// session; show it with what the filename and mtime tell us.
			header = undefined;
		}
		const name = sessionNameFromFile(file);
		const info = {
			path: file,
			id,
			cwd: typeof header?.cwd === "string" ? header.cwd : "",
			name,
			created: header?.timestamp
				? new Date(header.timestamp)
				: stat.mtime,
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

/**
 * Last session_info name in the file, read backwards a chunk at a time.
 *
 * A name can be anywhere in a multi-MB transcript, so a cold read walks the
 * whole file: 139 members cost 153 MB and ~850 ms. The result is memoised
 * against the file's size and mtime; because sessions are append-only, an
 * append only re-reads the bytes past the previous size.
 */
interface NameEntry {
	size: number;
	mtimeMs: number;
	name: string | undefined;
}
const nameIndex = new Map<string, NameEntry>();

function sessionNameFromFile(file: string): string | undefined {
	let size: number;
	let mtimeMs: number;
	try {
		const stat = fs.statSync(file);
		size = stat.size;
		mtimeMs = stat.mtimeMs;
	} catch {
		return undefined;
	}
	const known = nameIndex.get(file);
	if (known && known.size === size && known.mtimeMs === mtimeMs) {
		return known.name;
	}
	let name: string | undefined;
	if (known && known.size <= size) {
		// Append-only: the old name is still the last one unless the newly
		// appended bytes carry a newer one, so only that tail is scanned.
		name = scanNameFrom(file, known.size) ?? known.name;
	} else {
		// New file, or one that shrank or was rewritten: no safe resume point.
		name = scanNameFrom(file, 0);
	}
	nameIndex.set(file, { size, mtimeMs, name });
	return name;
}

/** Last session_info name in the bytes from `from` to EOF, read backwards. */
function scanNameFrom(
	file: string,
	from: number,
): string | undefined {
	try {
		const size = fs.statSync(file).size;
		let fd: number | undefined;
		try {
			fd = fs.openSync(file, "r");
			let pos = size;
			while (pos > from) {
				const len = Math.min(64 * 1024, pos - from);
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
 * Members of one group, resolved from filenames and cached. Never falls back to
 * pi's full scan: a member whose file is gone (deleted session, stale group
 * membership) is skipped, not worth seconds per keystroke. A file that exists
 * but won't parse still gets a row from its header — a real session we can't
 * fully describe is better than a picker that silently drops it.
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
			const refs: SessionRef[] = [];
			for (const [id, file] of files) {
				const ref = refFromFile(file, id);
				if (ref) refs.push(ref);
			}
			return refs.sort(byModified);
		} catch {
			return [];
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
							currentGroupId = mentionGroupId(
								groupsStore,
								currentSessionId,
							);
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
