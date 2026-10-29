/**
 * session-mention — reference other Pi sessions from a prompt with `@[...]`.
 *
 * Autocomplete always inserts the immutable session id, while showing the
 * human-readable title. On each model request, mentions are expanded only in
 * Pi's in-flight context clone. The saved prompt remains exactly as typed.
 * Transcript bodies are size-bounded and XML-escaped before being placed in a
 * <skill>-shaped envelope.
 */

import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import { transcriptMarkdown } from "../../lib/inbox-agents.ts";
import { InboxGroups } from "../inbox/groups.ts";
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

const COMPLETION_PATTERN = /(?:^|[\s([{<"'`])(@g?\[)([^\]\n]*)$/;
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

let cachedAt = 0;
let cachedSessions: SessionRef[] | undefined;
let inflight: Promise<SessionRef[]> | undefined;
export function clearSessionCache(): void {
	cachedAt = 0;
	cachedSessions = undefined;
	inflight = undefined;
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
				.map((info) => ({
					info,
					preview: previewOf(info),
					dir:
						info.cwd.split("/").filter(Boolean).pop() ?? info.cwd,
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

				const trigger = match[1]; // "@[" or "@g["
				const query = match[2] ?? "";
				const isGroupOnly = trigger === "@g[";

				let groupName: string | undefined;
				let groupSessionIds: Set<string> | undefined;

				if (isGroupOnly) {
					const currentSessionId =
						ctx.sessionManager?.getSessionId?.();
					let currentGroupId: string | undefined;
					if (currentSessionId) {
						try {
							const groupsStore = new InboxGroups(
								getAgentDir(),
							).load();
							currentGroupId =
								groupsStore.sessions[currentSessionId];
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
									label: "(Current session is ungrouped)",
									description:
										"Assign this session to an inbox group to reference group sessions",
								},
							],
						};
					}
				}

				let sessions = await listSessions();
				if (isGroupOnly && groupSessionIds) {
					sessions = sessions.filter((s) =>
						groupSessionIds!.has(s.info.id),
					);
					if (sessions.length === 0) {
						return {
							prefix: `${trigger}${query}`,
							items: [
								{
									value: "",
									label: `(No other sessions in ${groupName})`,
									description:
										"No other saved sessions found in this group",
								},
							],
						};
					}
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

				const trigger = match[1]; // "@[" or "@g["
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
