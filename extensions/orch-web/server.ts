/**
 * orch-web — a phone-shaped front end for the inbox/orchestrator state.
 *
 * Started by `orch-web`, normally from the launchd agent in scripts/. It is NOT a
 * pi extension: it never attaches to a running TUI and never opens a session
 * itself. It reads the same files inbox mode reads and calls the same exported
 * functions inbox mode calls, so the two front ends stay in sync:
 *
 *   GET  /                      the single-page client (public/index.html)
 *   GET  /api/rows              inbox rows: sessions, live state, groups, unread
 *   GET  /api/agent/:id/stream  SSE: transcript + live run events (poll-based)
 *   POST /api/send              { id, text }      queue or start a run
 *   POST /api/new               { prompt, cwd?, model?, groupId? }
 *   POST /api/cancel            { id }
 *   POST /api/queue/remove      { id, index }
 *   POST /api/queue/now         { id, index }
 *   POST /api/model             { id, model }
 *   POST /api/meta              { id, patch }     pin / archive / seen / unread
 *   POST /api/seen              { id }
 *
 * Ownership rule (see lib/inbox-agents.ts): a session must only be written by
 * one process at a time. sendToAgent adopts a session and queues the message; the
 * supervisor only spawns a run when the session is idle. A live TUI turn on the
 * same session is visible in inbox-live/ and is reported as `busy` instead of
 * being raced.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	AGENTS_DIR,
	cancelAgent,
	onAgentEvent,
	getAgent,
	listAgents,
	markSeen,
	removeQueuedMessage,
	sendQueuedMessageNow,
	sessionModel,
	sendToAgent,
	setAgentModel,
	spawnAgent,
	startAgentSupervisor,
	agentsSummary,
	type BgAgent,
} from "../../lib/inbox-agents.ts";
import { readWorkerLinks, type WorkerLink } from "../inbox/families.ts";
import { InboxGroups } from "../inbox/groups.ts";

const AGENT_DIR = getAgentDir();
const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");
const LIVE_DIR = path.join(AGENT_DIR, "inbox-live");
const STORE_PATH = path.join(AGENT_DIR, "inbox.json");
const TAIL_BYTES = 128 * 1024;
const STUCK_AFTER_MS = 5 * 60_000;
/** Live SSE seed: only the last N transcript messages, so a phone on 4G stays cheap. */
const SSE_TRANSCRIPT_LIMIT = 60;

// ───────────────────────────── config ─────────────────────────────

export interface Config {
	host: string;
	port: number;
	token: string;
	/** Extra hostnames accepted in the Host header (DNS-rebinding guard). */
	hosts: string[];
}

/** First non-loopback IPv4 address; the phone needs a routable one. */
export function lanAddress(): string {
	for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
		if (/^(bridge|utun|awdl|llw|anpi)/.test(name)) continue;
		for (const a of addrs ?? []) {
			if (a.family === "IPv4" && !a.internal) return a.address;
		}
	}
	return "127.0.0.1";
}

// ───────────────────────────── inbox store ─────────────────────────────

interface SessionMeta {
	pinnedAt?: number;
	archivedAt?: number;
	seenAt?: number;
	unreadAt?: number;
	clonedAt?: number;
	filter?: "hide" | "show";
}

interface Store {
	version: 1;
	sessions: Record<string, SessionMeta>;
	unreadSince?: number;
}

function loadStore(): Store {
	try {
		const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
		if (!data?.sessions || typeof data.sessions !== "object") throw new Error();
		return { version: 1, sessions: {}, unreadSince: data.unreadSince, ...data };
	} catch {
		return { version: 1, sessions: {} };
	}
}

/** Merge one session's metadata; the inbox owns every other key in the file. */
function updateMeta(id: string, patch: (m: SessionMeta) => void): SessionMeta {
	const store = loadStore();
	const meta = (store.sessions[id] ??= {});
	patch(meta);
	writeAtomic(STORE_PATH, JSON.stringify(store, null, 2));
	return meta;
}

function writeAtomic(file: string, data: string) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data, "utf-8");
	fs.renameSync(tmp, file);
}

/**
 * Read a window of a JSONL file as whole lines.
 *
 * Three things make a naive `read` + `split("\n")` wrong:
 *   - a window can begin inside a UTF-8 sequence, so `toString` emits U+FFFD and
 *     the first line's JSON breaks;
 *   - a window can begin or end mid-line, yielding fragments;
 *   - a window can end inside a multi-byte char, corrupting the last line.
 * All three are handled here so every reader (transcript, name, titles, live
 * items) shares one correct implementation.
 */
export function readLinesAt(
	file: string,
	options: { offset?: number; max?: number } = {},
): { lines: string[]; size: number; atStart: boolean; atEnd: boolean } {
	const st = fs.statSync(file);
	const offset = Math.max(0, Math.min(options.offset ?? 0, st.size));
	const max = options.max ?? st.size - offset;
	const len = Math.max(0, Math.min(max, st.size - offset));
	const buf = Buffer.alloc(len);
	if (len > 0) {
		const fd = fs.openSync(file, "r");
		try {
			fs.readSync(fd, buf, 0, len, offset);
		} finally {
			fs.closeSync(fd);
		}
	}
	const atStart = offset === 0;
	const atEnd = offset + len >= st.size;
	// Skip a leading partial character and (unless at the file start) a leading
	// partial line.
	let from = 0;
	let to = buf.length;
	if (!atStart) {
		while (from < to && (buf[from]! & 0xc0) === 0x80) from++;
	} else {
		// A file starting mid-character is already corrupt; nothing to skip.
	}
	if (!atEnd) {
		// Drop a trailing partial character.
		let back = 0;
		while (to - back > 0 && back < 4 && (buf[to - back - 1]! & 0xc0) === 0x80) back++;
		if (to - back > 0) {
			const lead = buf[to - back - 1]!;
			const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
			if (need > back + 1) to -= back + 1;
		}
	}
	const lines = buf.subarray(from, to).toString("utf-8").split("\n");
	if (!atStart) lines.shift();
	// A file ending in a newline leaves a final empty element; it is not a line.
	if (atEnd && lines.at(-1) === "") lines.pop();
	if (!atEnd) lines.pop();
	return { lines, size: st.size, atStart, atEnd };
}

// ───────────────────────────── session discovery ─────────────────────────────

interface HeaderInfo {
	path: string;
	id: string;
	cwd: string;
	created: Date;
	modified: Date;
	mtimeMs: number;
	size: number;
}

function readHeaderLine(file: string): HeaderInfo | undefined {
	try {
		const st = fs.statSync(file);
		if (st.size === 0) return;
		const fd = fs.openSync(file, "r");
		try {
			const len = Math.min(st.size, 4096);
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, 0);
			const nl = buf.indexOf(10);
			const line = (nl === -1 ? buf : buf.subarray(0, nl))
				.toString("utf-8")
				.trim();
			const h = JSON.parse(line);
			if (h?.type !== "session" || typeof h.id !== "string") return;
			return {
				path: file,
				id: h.id,
				cwd: typeof h.cwd === "string" ? h.cwd : "",
				created: new Date(h.timestamp ?? st.birthtime),
				modified: st.mtime,
				mtimeMs: st.mtimeMs,
				size: st.size,
			};
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/** Header-only walk, like inbox mode: full-parsing ~200 files per refresh is too slow. */
function scanHeaders(): HeaderInfo[] {
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: HeaderInfo[] = [];
	for (const d of dirs) {
		if (!d.isDirectory() && !d.isSymbolicLink()) continue;
		const dir = path.join(SESSIONS_DIR, d.name);
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const h = readHeaderLine(path.join(dir, f));
			if (h) out.push(h);
		}
	}
	return out;
}

type TailStatus = "your-turn" | "error" | "aborted" | "stalled" | "empty";

interface TailInfo {
	status: TailStatus;
	lastText: string;
	lastSaid?: { role: string; text: string };
}

const tailCache = new Map<
	string,
	{ mtimeMs: number; size: number; info: TailInfo }
>();

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

/** Last messages and terminal status, read backwards from the end of the file. */
export function readTail(file: string): TailInfo {
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return { status: "empty", lastText: "" };
	}
	const cached = tailCache.get(file);
	if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size)
		return cached.info;

	let info: TailInfo = { status: "empty", lastText: "" };
	try {
		let chunk = TAIL_BYTES;
		for (;;) {
			const { lines, atStart } = readLinesAt(file, { offset: Math.max(0, st.size - chunk) });

			let lastMsg: any;
			let lastAssistantText: string | undefined;
			let lastSaid: TailInfo["lastSaid"];
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i]!.trim();
				if (!line) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry.type !== "message") continue;
				const m = entry.message;
				if (!m || !["user", "assistant", "toolResult"].includes(m.role))
					continue;
				if (!lastMsg) lastMsg = m;
				if (m.role === "assistant") {
					const t = messageText(m.content).trim();
					if (t) {
						lastAssistantText ??= t;
						if (!lastSaid && m.stopReason !== "toolUse")
							lastSaid = { role: "assistant", text: t };
					}
				} else if (m.role === "user" && !lastSaid) {
					const t = messageText(m.content).trim();
					if (t) lastSaid = { role: "user", text: t };
				}
				if (lastAssistantText !== undefined && lastSaid) break;
			}

			if (
				lastMsg &&
				((lastAssistantText !== undefined && lastSaid) || atStart)
			) {
				let status: TailStatus;
				if (lastMsg.role === "assistant") {
					const r = lastMsg.stopReason;
					status =
						r === "error"
							? "error"
							: r === "aborted"
								? "aborted"
								: r === "toolUse"
									? "stalled"
									: "your-turn";
				} else {
					status = "stalled";
				}
				info = {
					status,
					lastText: lastAssistantText ?? "",
					lastSaid,
				};
				break;
			}
			if (atStart) break;
			chunk *= 4;
		}
	} catch {
		// unreadable → empty
	}
	tailCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
	return info;
}

/**
 * Titles come from the first user message. A run can open with a large entry
 * (pasted context, an image, a skill expansion), so read forward in chunks and
 * stop at the first user text rather than assuming it is in the first 64KB.
 */
export function firstUserText(file: string): string {
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return "";
	}
	const cached = titleCache.get(file);
	if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size)
		return cached.text;
	let text = "";
	try {
		let offset = 0;
		const LIMIT = 4 * 1024 * 1024;
		while (offset < Math.min(st.size, LIMIT) && !text) {
			const len = Math.min(64 * 1024, Math.min(st.size, LIMIT) - offset);
			if (len <= 0) break;
			const { lines } = readLinesAt(file, { offset, max: len });
			offset += len;
			for (const line of lines) {
				if (!line.trim()) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry.type === "message" && entry.message?.role === "user") {
					const first = messageText(entry.message.content).trim();
					if (first) {
						text = first;
						break;
					}
				}
			}
		}
	} catch {
		// unreadable → no title
	}
	titleCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text });
	return text;
}

const titleCache = new Map<
	string,
	{ mtimeMs: number; size: number; text: string }
>();

/**
 * The session's display name. A rename appends a `session_info` entry, so the
 * newest one wins; renames are rare, so the head of the file covers the common
 * case and the tail covers a rename of an older session. Bounded on both ends:
 * a few hundred MB of history must not be walked on every refresh.
 */
/**
 * The session's display name.
 *
 * A rename appends a `session_info` entry wherever the session happens to be at
 * the time, which on a long session is nowhere near either end — this session's
 * name sits in the middle of 854 lines. So scan the whole file, but only when
 * the cheap pass (head + tail) misses and the file is big enough to need it.
 *
 * Bounded by cost, not by a byte cap: the scan stops at the first name it finds
 * going backwards, and is skipped entirely when the last entry already says the
 * name is absent. Results are cached on mtime+size because this runs for every
 * row on every refresh.
 */
export function readName(file: string): string | undefined {
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return undefined;
	}
	const cached = nameCache.get(file);
	if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size)
		return cached.name;

	const name = scanForName(file, st.size);
	nameCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, name });
	return name;
}

function nameOfLines(lines: string[]): string | undefined {
	let name: string | undefined;
	for (const line of lines) {
		if (!line.includes('"session_info"')) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			entry.type === "session_info" &&
			typeof entry.name === "string" &&
			entry.name.trim()
		)
			name = entry.name.trim();
	}
	return name;
}

const NAME_CHUNK = 256 * 1024;
/** Past this size, only a full scan when the ends disagree. */
const NAME_FULL_SCAN_LIMIT = 32 * 1024 * 1024;

function scanForName(file: string, size: number): string | undefined {
	// Cheap first: the name is usually set early and renames land near the end.
	const head = nameOfLines(readLinesAt(file, { offset: 0, max: 64 * 1024 }).lines);
	const tail = nameOfLines(readLinesAt(file, { max: NAME_CHUNK }).lines);
	if (tail) return tail;
	if (head || size > NAME_FULL_SCAN_LIMIT) return head;

	// Neither end has it. Walk the middle backwards so a rename beats the
	// original name, stopping as soon as one is found.
	for (let end = size - NAME_CHUNK; end > 0; end -= NAME_CHUNK) {
		const from = Math.max(0, end - NAME_CHUNK);
		const { lines } = readLinesAt(file, { offset: from, max: end - from });
		const found = nameOfLines(lines);
		if (found) return found;
	}
	return head;
}

const nameCache = new Map<
	string,
	{ mtimeMs: number; size: number; name: string | undefined }
>();

// ───────────────────────────── live records ─────────────────────────────

interface LiveRecord {
	pid: number;
	sessionId: string;
	sessionFile?: string;
	state: "idle" | "working";
	updated: number;
	bgParent?: number;
	stuckMin?: number;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readLive(): Map<string, LiveRecord> {
	const out = new Map<string, LiveRecord>();
	let files: string[] = [];
	try {
		files = fs.readdirSync(LIVE_DIR);
	} catch {
		return out;
	}
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		const full = path.join(LIVE_DIR, f);
		try {
			const rec = JSON.parse(fs.readFileSync(full, "utf-8")) as LiveRecord;
			const ours =
				rec.pid === process.pid ||
				rec.bgParent === process.pid ||
				listAgents().some((a) => a.pid === rec.pid);
			if (!ours && !pidAlive(rec.pid)) {
				fs.rmSync(full, { force: true });
				continue;
			}
			if (rec.state === "working") {
				const silent = Date.now() - rec.updated;
				if (silent > STUCK_AFTER_MS) {
					rec.state = "idle";
					rec.stuckMin = Math.round(silent / 60_000);
				}
			}
			const prev = out.get(rec.sessionId);
			if (!prev || rec.updated > prev.updated) out.set(rec.sessionId, rec);
		} catch {
			// ignore
		}
	}
	return out;
}

// ───────────────────────────── rows ─────────────────────────────

interface Row {
	id: string;
	title: string;
	cwd: string;
	status: string;
	state?: BgAgent["state"];
	live?: boolean;
	livePid?: number;
	stuckMin?: number;
	model?: string;
	updated: number;
	created: number;
	pending: number;
	needsYou: boolean;
	pinned: boolean;
	archived: boolean;
	unread: boolean;
	groupId?: string;
	parentId?: string;
	firstPrompt: string;
	lastSaid?: { role: string; text: string };
	lastText: string;
}

const MAX_CONCURRENT = Math.max(
	1,
	Number(process.env.PI_INBOX_MAX_AGENTS) || 20,
);

function cleanTitle(s: string): string {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

/** A session is busy when this daemon runs it or another live pi process does. */
function busyState(a: BgAgent | undefined, live?: LiveRecord) {
	if (a && (a.state === "working" || a.state === "queued")) return a.state;
	if (live?.state === "working") return "working";
	return undefined;
}

export function buildRows(opts: { currentId?: string; withArchived?: boolean } = {}) {
	const store = loadStore();
	const live = readLive();
	const links = readWorkerLinks(AGENT_DIR);
	const groups = (() => {
		try {
			return new InboxGroups(AGENT_DIR).load();
		} catch {
			return { groups: [], sessions: {} } as any;
		}
	})();
	const groupOf = (id: string): string | undefined => groups.sessions?.[id];
	const parentOf = new Map<string, string>();
	for (const link of links as WorkerLink[]) parentOf.set(link.id, link.parentId);

	const rows: Row[] = [];
	const seen = new Set<string>();
	for (const h of scanHeaders()) {
		const meta = store.sessions[h.id] ?? {};
		if (meta.archivedAt && !opts.withArchived) continue;
		const tail = readTail(h.path);
		const bg = getAgent(h.id);
		const liveRec = live.get(h.id);
		const state = busyState(bg, liveRec);
		seen.add(h.id);
		rows.push({
			id: h.id,
			title: cleanTitle(readName(h.path) || firstUserText(h.path) || "(no messages)"),
			cwd: h.cwd,
			status: tail.status,
			state,
			live: !!liveRec,
			livePid: liveRec?.pid,
			stuckMin: liveRec?.stuckMin,
			// The agent record is authoritative mid-run; otherwise ask the session
			// file, which is what pi would restore on the next turn.
			model: bg?.model ?? bg?.nextModel ?? sessionModel(h.path),
			updated: bg?.updatedAt ?? h.modified.getTime(),
			created: h.created.getTime(),
			pending: bg?.pending.length ?? 0,
			needsYou: !!bg?.needsYou,
			pinned: !!meta.pinnedAt,
			archived: !!meta.archivedAt,
			unread:
				(meta.unreadAt ?? 0) > (meta.seenAt ?? 0) || !!bg?.needsYou,
			groupId: groupOf(h.id),
			parentId: parentOf.get(h.id),
			firstPrompt: cleanTitle(firstUserText(h.path)),
			lastSaid: tail.lastSaid,
			lastText: tail.lastText,
		});
	}
	// Sessions queued but not on disk yet (a brand-new agent's first run).
	for (const a of listAgents()) {
		if (seen.has(a.id)) continue;
		const meta = store.sessions[a.id] ?? {};
		if (meta.archivedAt && !opts.withArchived) continue;
		rows.push({
			id: a.id,
			title: cleanTitle(a.title),
			cwd: a.cwd,
			status: "empty",
			state: busyState(a),
			live: true,
			livePid: a.pid,
			model: a.model ?? a.nextModel,
			updated: a.updatedAt,
			created: a.createdAt,
			pending: a.pending.length,
			needsYou: !!a.needsYou,
			pinned: !!meta.pinnedAt,
			archived: !!meta.archivedAt,
			unread: !!a.needsYou,
			groupId: groupOf(a.id),
			parentId: parentOf.get(a.id),
			firstPrompt: cleanTitle(a.title),
			lastSaid: a.lastText
				? { role: "assistant", text: a.lastText }
				: undefined,
			lastText: a.lastText ?? "",
		});
	}
	rows.sort((x, y) => y.updated - x.updated);
	return {
		rows,
		groups: groups.groups ?? [],
		defaultGroupId: groups.defaultGroupId,
		summary: agentsSummary(),
		capacity: { running: rows.filter((r) => r.state === "working").length, max: MAX_CONCURRENT },
		now: Date.now(),
	};
}

// ───────────────────────────── foreign runs ─────────────────────────────

/**
 * A run started by another pi (a TUI, or the parent that spawned this daemon)
 * is not in this process's agent registry, so `getAgent()` returns nothing. Its
 * events are still on disk: children write JSONL to `<id>.out` and the inbox
 * keeps the same shape in memory. Read the tail of that file so a phone sees
 * the run in progress rather than an empty "working" box.
 *
 * Bounded on purpose: these files reach tens of megabytes on a long run (one is
 * 13MB here), and the view only shows a handful of recent items.
 */
const LIVE_TAIL_BYTES = 256 * 1024;
const liveCache = new Map<string, { size: number; items: LiveItem[] }>();

interface LiveItem {
	kind: "prompt" | "tool" | "text" | "error";
	text: string;
}

/** Size of an agent's event file — a monotonic counter for change detection. */
export function eventBytes(id: string): number {
	try {
		return fs.statSync(path.join(AGENTS_DIR, `${id}.out`)).size;
	} catch {
		return 0;
	}
}

/**
 * Recent in-flight items for a run this process does not own.
 *
 * Only the tail of the event file is read, so the assembled `text` item is a
 * window, not the whole thing — the finalized text is in the transcript anyway.
 * Rebuilt on every size change, which is cheap: 256KB of JSONL per refresh.
 */
export function liveItems(id: string): LiveItem[] {
	const file = path.join(AGENTS_DIR, `${id}.out`);
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return [];
	}
	const cached = liveCache.get(id);
	if (cached && cached.size === st.size) return cached.items;

	const items: LiveItem[] = [];
	try {
		const { lines } = readLinesAt(file, { max: LIVE_TAIL_BYTES });
		const push = (kind: LiveItem["kind"], text: string) => {
			if (!text.trim()) return;
			items.push({ kind, text });
			if (items.length > 40) items.shift();
		};
		// Deltas since the last tool call: appended to one item so the phone shows
		// text as it arrives instead of a snapshot one refresh behind.
		let text = "";
		let textItem: LiveItem | undefined;
		const flushText = (drop = false) => {
			if (textItem && text.trim()) textItem.text = text.trim();
			// On message_end the text is entering the transcript, so stop showing
			// it in the live box; before a tool call it is narration and stays.
			if (drop && textItem) {
				const at = items.indexOf(textItem);
				if (at >= 0) items.splice(at, 1);
			}
			text = "";
			textItem = undefined;
		};
		for (const line of lines) {
			if (!line.trim()) continue;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				continue;
			}
			if (ev.type === "tool_execution_start") {
				flushText();
				const arg = summarizeArgs(ev.args);
				push("tool", `${ev.toolName ?? "tool"}${arg ? ` ${arg}` : ""}`);
			} else if (ev.type === "tool_execution_end" && ev.isError) {
				flushText();
				push("error", `${ev.toolName ?? "tool"} failed`);
			} else if (
				ev.type === "message_update" &&
				ev.assistantMessageEvent?.type === "text_delta"
			) {
				text += ev.assistantMessageEvent.delta ?? "";
				if (!textItem && text) {
					textItem = { kind: "text", text: "" };
					items.push(textItem);
					if (items.length > 40) items.shift();
				}
			} else if (ev.type === "message_end") {
				// The message is finalized into the transcript; start clean so the
				// live box does not repeat what the transcript now shows.
				flushText(true);
			}
		}
		flushText();
	} catch {
		// unreadable → no live items
	}
	liveCache.set(id, { size: st.size, items });
	return items;
}

// ───────────────────────────── transcript ─────────────────────────────

interface TranscriptMessage {
	role: string;
	text: string;
	tools?: { name: string; arg?: string; error?: boolean }[];
	stopped?: "error" | "aborted";
	error?: string;
	ts?: string;
}

function transcript(file: string, limit = 200): TranscriptMessage[] {
	let branch: any[] = [];
	try {
		branch = SessionManager.open(file).getBranch() as any[];
	} catch {
		try {
			branch = parseSessionFile(file);
		} catch {
			return [];
		}
	}
	const out: TranscriptMessage[] = [];
	for (const e of branch) {
		if (e?.type !== "message") continue;
		const m = e.message;
		if (m?.role === "user") {
			const text = messageText(m.content).trim();
			if (text) out.push({ role: "user", text, ts: e.timestamp });
		} else if (m?.role === "assistant") {
			const tools: TranscriptMessage["tools"] = [];
			let said = false;
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b?.type === "text" && b.text?.trim()) said = true;
				else if (b?.type === "toolCall")
					tools.push({ name: b.name, arg: summarizeArgs(b.arguments) });
			}
			const text = messageText(m.content).trim();
			if (!said && !tools.length) continue;
			out.push({
				role: "assistant",
				text,
				tools: tools.length ? tools : undefined,
				stopped:
					m.stopReason === "error"
						? "error"
						: m.stopReason === "aborted"
							? "aborted"
							: undefined,
				error: m.errorMessage,
				ts: e.timestamp,
			});
		} else if (m?.role === "toolResult" && m.isError) {
			const first =
				messageText(m.content).split("\n").find((l: string) => l.trim()) ?? "";
			out.push({ role: "toolError", text: first.slice(0, 240), ts: e.timestamp });
		}
	}
	return out.slice(-limit);
}

/** Fallback reader: skip the tool-call graph, just replay message entries in order. */
function parseSessionFile(file: string): any[] {
	const out: any[] = [];
	const raw = fs.readFileSync(file, "utf-8");
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e?.type === "message") out.push(e);
		} catch {
			// skip a partial trailing line
		}
	}
	return out;
}

function summarizeArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const o = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "command", "pattern", "query", "url"]) {
		const v = o[key];
		if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 79)}…` : v;
	}
	return undefined;
}

// ───────────────────────────── daemon ─────────────────────────────


let running: Config | undefined;
function config(): Config {
	if (!running) throw new Error("orch-web is not started");
	return running;
}

export function startOrchWeb(cfg: Config) {
	running = cfg;
	// Adopts agents whose owner stopped beating and keeps their queues draining.
	startAgentSupervisor({});

	// A spawned child that dies unnoticed is the failure mode that hid the last
	// bug: say so on the log the moment the agent reports an error.
	onAgentEvent((e) => {
		if (e.type === "finished" || e.type === "run_end") {
			say(`agent-${e.type}`, {
				id: e.agent.id,
				state: e.agent.state,
				error: e.agent.error,
				pending: e.agent.pending.length,
			});
		}
	});

	const server = http.createServer((req, res) => {
		handle(req, res, cfg).catch((e) => {
			sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
		});
	});
	server.keepAliveTimeout = 65_000;
	server.listen(cfg.port, cfg.host, () => {
		const where = `http://${cfg.host}:${cfg.port}/?token=${cfg.token}`;
		console.log(`orch-web listening: ${where}`);
		console.log(`  local:  http://${os.hostname()}.local:${cfg.port}/?token=…`);
	});
	return server;
}

// ───────────────────────────── logging ─────────────────────────────

/**
 * Everything the daemon decides about a send has to be visible somewhere: it
 * runs detached under launchd, so a browser toast is the only thing the person
 * actually sees. One JSON line per decision, plus stderr for launchd's log.
 */
function say(event: string, detail: Record<string, unknown> = {}) {
	const line = JSON.stringify({
		at: new Date().toISOString(),
		event,
		pid: process.pid,
		...detail,
	});
	process.stderr.write(`[orch-web] ${line}\n`);
}

// ───────────────────────────── pairing ─────────────────────────────

/**
 * The token is a shell on this machine, so it is never typed by hand and never
 * shown on the phone side. The terminal prints a short code (with a QR); the
 * phone trades that code for the token once.
 *
 * The code lives in a file rather than in memory so `--pair` works from any
 * process — including a terminal while launchd owns the daemon. Codes are
 * single-use, expire in 10 minutes, and replacing the file invalidates the old
 * one, so a leaked screenshot stops working as soon as you pair again.
 */
const PAIR_TTL_MS = 10 * 60_000;
const PAIR_ATTEMPTS = new Map<string, { count: number; reset: number }>();
const PAIR_MAX_ATTEMPTS = 6;

function pairPath() {
	return path.join(AGENT_DIR, "orch-web-pair.json");
}

/** Mint the current code; called by `orch-web --pair`. */
export function mintPairCode(agentDir = AGENT_DIR): {
	code: string;
	expires: number;
} {
	const code = String(Math.floor(100_000 + Math.random() * 900_000));
	const expires = Date.now() + PAIR_TTL_MS;
	writeAtomic(
		path.join(agentDir, "orch-web-pair.json"),
		JSON.stringify({ code, expires }),
	);
	return { code, expires };
}

function currentPairCode(): { code: string; expires: number } | undefined {
	try {
		const held = JSON.parse(fs.readFileSync(pairPath(), "utf-8"));
		if (typeof held?.code !== "string" || typeof held?.expires !== "number")
			return undefined;
		if (held.expires <= Date.now()) return undefined;
		return held;
	} catch {
		return undefined;
	}
}

function pairAttemptAllowed(
	res: http.ServerResponse,
	remote: string,
): boolean {
	const now = Date.now();
	const row = PAIR_ATTEMPTS.get(remote);
	if (!row || row.reset < now) {
		PAIR_ATTEMPTS.set(remote, { count: 1, reset: now + 60_000 });
		return true;
	}
	row.count++;
	if (row.count > PAIR_MAX_ATTEMPTS) {
		sendJson(res, 429, { error: "too many attempts; wait a minute" });
		return false;
	}
	return true;
}

function handlePair(res: http.ServerResponse, remote: string, code: string) {
	if (!pairAttemptAllowed(res, remote)) return;
	const held = currentPairCode();
	if (!held || held.code !== code.trim()) {
		sendJson(res, 401, { error: "that code is wrong or expired" });
		return;
	}
	// Single use: burn it before answering so a replay cannot race this.
	fs.rmSync(pairPath(), { force: true });
	PAIR_ATTEMPTS.delete(remote);
	sendJson(res, 200, { token: config().token });
}

// ───────────────────────────── http plumbing ─────────────────────────────

const PUBLIC_DIR = path.join(import.meta.dirname ?? __dirname, "public");

async function handle(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	cfg: Config,
) {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? cfg.host}`);
	// DNS-rebinding guard: a hostile page can point its own name at our IP, but it
	// cannot forge the Host header a browser sends.
	const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
	if (!cfg.hosts.includes(host)) {
		res.writeHead(421, { "content-type": "text/plain" });
		res.end("Misdirected request\n");
		return;
	}

	if (url.pathname === "/" || url.pathname === "/index.html") {
		return serveStatic(res, path.join(PUBLIC_DIR, "index.html"));
	}
	if (url.pathname === "/manifest.webmanifest") {
		return serveStatic(res, path.join(PUBLIC_DIR, "manifest.webmanifest"));
	}
	if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true });

	// Pairing is the one unauthenticated POST: it hands out the token in
	// exchange for a single-use code printed in the terminal.
	if (req.method === "POST" && url.pathname === "/api/pair") {
		const body = await readJson(req);
		return handlePair(
			res,
			req.socket.remoteAddress ?? "?",
			String((body as { code?: unknown })?.code ?? ""),
		);
	}

	if (!url.pathname.startsWith("/api/")) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("Not found\n");
		return;
	}
	// Bearer header for fetches; ?token= only for the initial EventSource link,
	// which cannot set headers.
	const auth = req.headers.authorization;
	const supplied =
		auth?.startsWith("Bearer ") ? auth.slice(7) : (url.searchParams.get("token") ?? "");
	if (!timingSafeEqual(supplied, cfg.token)) {
		say("unauthorized", { path: url.pathname, remote: req.socket.remoteAddress });
		sendJson(res, 401, { error: "unauthorized" });
		return;
	}
	if (req.method === "POST") {
		say("request", { path: url.pathname, remote: req.socket.remoteAddress });
	}

	if (req.method === "GET" && url.pathname === "/api/rows") {
		return sendJson(
			res,
			200,
			buildRows({
				withArchived: url.searchParams.get("archived") === "1",
			}),
		);
	}

	if (req.method === "GET" && url.pathname.startsWith("/api/stream/")) {
		const id = url.pathname.slice("/api/stream/".length);
		return streamAgent(res, id);
	}

	if (req.method === "POST") {
		const body = await readJson(req);
		const route = url.pathname;
		if (route === "/api/send") {
			const { id, text } = body as { id: string; text: string };
			if (!id || !text?.trim()) throw new Error("id and text are required");
			return sendJson(res, 200, doSend(id, text));
		}
		if (route === "/api/new") {
			return sendJson(res, 200, doNew(body as any));
		}
		if (route === "/api/cancel") {
			const id = (body as any).id as string;
			cancelAgent(id);
			return sendJson(res, 200, { ok: true });
		}
		if (route === "/api/queue/remove") {
			const { id, index } = body as { id: string; index: number };
			const removed = removeQueuedMessage(id, index);
			return sendJson(res, 200, { ok: true, removed });
		}
		if (route === "/api/queue/now") {
			const { id, index } = body as { id: string; index: number };
			sendQueuedMessageNow(id, index);
			return sendJson(res, 200, { ok: true });
		}
		if (route === "/api/model") {
			const { id, model } = body as { id: string; model: string };
			const file = sessionFileOf(id);
			if (!file) throw new Error("session file not found");
			setAgentModel(id, file, model);
			return sendJson(res, 200, { ok: true, model });
		}
		if (route === "/api/meta") {
			const { id, patch } = body as { id: string; patch: Record<string, unknown> };
			const meta = updateMeta(id, (m) => {
				if ("pinned" in patch) m.pinnedAt = patch.pinned ? Date.now() : undefined;
				if ("archived" in patch)
					m.archivedAt = patch.archived ? Date.now() : undefined;
				if ("unread" in patch) {
					if (patch.unread) m.unreadAt = Date.now();
					else m.seenAt = Date.now();
				}
			});
			return sendJson(res, 200, { ok: true, meta });
		}
		if (route === "/api/seen") {
			const id = (body as any).id as string;
			markSeen(id);
			updateMeta(id, (m) => {
				m.seenAt = Date.now();
			});
			return sendJson(res, 200, { ok: true });
		}
	}

	sendJson(res, 404, { error: "no such route" });
}

function doSend(id: string, text: string) {
	const rows = buildRows({ withArchived: true }).rows;
	const row = rows.find((r) => r.id === id);
	if (!row) throw new Error("session not found");
	const file = sessionFileOf(id);
	// A run in another process is a separate writer; queue through the agent
	// record rather than racing the transcript.
	let agent: BgAgent;
	try {
		agent = sendToAgent({
			id,
			cwd: row.cwd || process.cwd(),
			sessionFile: file,
			title: row.title,
			text,
		});
	} catch (e) {
		say("send-threw", {
			id,
			cwd: row.cwd,
			error: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}

	// "Accepted" is not "running". The agent record on disk is the only proof a
	// child process exists, so wait a beat and report what actually happened.
	const observed = waitForProgress(id);
	say("send", {
		id,
		rowState: row.state,
		recordState: observed.state,
		pid: observed.pid,
		error: observed.error,
		pending: observed.pending,
		queuedHere: agent.pending.length,
	});
	if (observed.error) {
		return {
			ok: false,
			disposition: "error",
			detail: observed.error,
			hint: "the child pi process failed to start; see ~/.pi/agent/inbox-agents/<id>.err",
		};
	}
	return {
		ok: true,
		disposition:
			observed.state === "working"
				? "started"
				: observed.state === "queued"
					? "queued"
					: row.state === "working"
						? "queued"
						: "accepted",
		state: observed.state,
	};
}

/**
 * Read back the agent record the supervisor just wrote. Short and bounded: this
 * is a confirmation, not a wait for the run to finish.
 */
function waitForProgress(id: string): {
	state?: string;
	pid?: number;
	error?: string;
	pending: number;
} {
	const file = path.join(AGENTS_DIR, `${id}.json`);
	const deadline = Date.now() + 700;
	let last: any;
	for (;;) {
		try {
			last = JSON.parse(fs.readFileSync(file, "utf-8"));
		} catch {
			// not written yet
		}
		if (last?.state === "error" || last?.state === "working") break;
		if (Date.now() >= deadline) break;
		const until = Math.min(deadline, Date.now() + 60);
		while (Date.now() < until) {
			// tiny synchronous settle: the supervisor pumps on its own tick
		}
	}
	return {
		state: last?.state,
		pid: last?.pid,
		error: last?.error,
		pending: Array.isArray(last?.pending) ? last.pending.length : 0,
	};
}

function doNew(body: {
	prompt: string;
	cwd?: string;
	model?: string;
	groupId?: string;
	title?: string;
}) {
	if (!body?.prompt?.trim()) throw new Error("prompt is required");
	const cwd = body.cwd?.trim() || process.cwd();
	if (!fs.existsSync(cwd)) throw new Error(`no such directory: ${cwd}`);
	const agent = spawnAgent({
		prompt: body.prompt.trim(),
		cwd,
		model: body.model || undefined,
		title: cleanTitle(body.title || body.prompt.trim()),
	});
	if (body.groupId) {
		try {
			void new InboxGroups(AGENT_DIR).assign(agent.id, body.groupId);
		} catch {
			// a bad group id must not lose the agent that already started
		}
	}
	return { ok: true, id: agent.id };
}

function sessionFileOf(id: string): string | undefined {
	for (const h of scanHeaders()) if (h.id === id) return h.path;
	const a = getAgent(id);
	return a?.sessionFile;
}

function serveStatic(res: http.ServerResponse, file: string) {
	let data: Buffer;
	try {
		data = fs.readFileSync(file);
	} catch {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("Not found\n");
		return;
	}
	const ext = path.extname(file);
	const type =
		ext === ".html"
			? "text/html; charset=utf-8"
			: ext === ".js"
				? "text/javascript; charset=utf-8"
				: ext === ".css"
					? "text/css; charset=utf-8"
					: ext === ".webmanifest"
						? "application/manifest+json"
						: "application/octet-stream";
	res.writeHead(200, {
		"content-type": type,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(data);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(data);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > 2_000_000) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8");
			if (!raw.trim()) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

function timingSafeEqual(a: string, b: string): boolean {
	if (!a || !b || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// ───────────────────────────── SSE ─────────────────────────────

/**
 * One SSE channel per session, one poll loop per open channel. The client sends
 * back only what it needs, so the payload stays small: the transcript tail, the
 * run's live items, and the row's state.
 */
function streamAgent(res: http.ServerResponse, id: string) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	res.write("retry: 2000\n\n");

	let closed = false;
	const file = sessionFileOf(id);
	let lastKey = "";

	const push = () => {
		if (closed) return;
		try {
			const a = getAgent(id);
			const rows = buildRows({ withArchived: true, currentId: id });
			const row = rows.rows.find((r) => r.id === id);
			// A run owned by another process (a TUI, or the parent of this
			// daemon) has no registry handle here, so its in-flight output comes
			// from its event file instead. Without this the view sits on an empty
			// "working" box until the run ends.
			const live = a
				? (a.items?.slice(-40) ?? [])
				: liveItems(id);
			const payload = {
				row,
				messages: file ? transcript(file, SSE_TRANSCRIPT_LIMIT) : [],
				pending: a?.pending ?? [],
				model: a?.model ?? a?.nextModel ?? (file ? sessionModel(file) : undefined),
				live,
				// "Now doing": the last tool step. Streaming text is already a live
				// item, so it would otherwise be printed twice in the same box.
				activity:
					a?.activity ??
					[...live].reverse().find((i) => i.kind === "tool")?.text,
			};
			// Change detection. The transcript is capped, so its length pins at the
			// limit and edits to the newest message are invisible to it: hash the
			// last message, and count events so a long run cannot look idle.
			const last = payload.messages.at(-1);
			const key = JSON.stringify([
				payload.row?.title,
				payload.messages.length,
				last?.role,
				last?.text?.length,
				last?.text?.slice(-40),
				last?.tools?.length,
				payload.live.length,
				payload.live.at(-1) ?? null,
				payload.activity,
				payload.pending.length,
				payload.row?.status,
				payload.row?.state,
				eventBytes(id),
			]);
			if (key === lastKey) return;
			lastKey = key;
			res.write(`data: ${JSON.stringify(payload)}\n\n`);
		} catch (e) {
			res.write(
				`event: error\ndata: ${JSON.stringify({
					message: e instanceof Error ? e.message : String(e),
				})}\n\n`,
			);
		}
	};

	push();
	const timer = setInterval(push, 1200);
	const beat = setInterval(() => {
		if (!closed) res.write(": keep-alive\n\n");
	}, 20_000);

	const cleanup = () => {
		closed = true;
		clearInterval(timer);
		clearInterval(beat);
	};
	res.on("close", cleanup);
	res.on("error", cleanup);
	res.on("finish", cleanup);
}


