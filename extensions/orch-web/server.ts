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
 *   GET  /api/models            selectable models (enabledModels + thinking levels)
 *   GET  /api/catalog           $skills, /commands and prompt templates for the composer
 *   GET  /api/mentions          sessions an @[ mention can reference, by group
 *   GET  /api/agent/:id/stream  SSE: transcript + live run events (poll-based)
 *   POST /api/send              { id, text }      queue or start a run
 *   POST /api/new               { prompt, cwd?, model?, groupId?, title? }
 *   POST /api/cancel            { id }
 *   POST /api/queue/remove      { id, index }
 *   POST /api/queue/now         { id, index }
 *   POST /api/model             { id, model }     provider/model[:thinking]
 *   POST /api/rename            { id, name }
 *   POST /api/clone             { id }            cut before a run's active prompt
 *   POST /api/group/move        { id, groupId? }  groupId omitted = Ungrouped
 *   POST /api/group/edit        { action, id?, name? }  create / rename / remove / default
 *   POST /api/meta              { id, patch }     pin / archive / unread / hide
 *   POST /api/seen              { id }
 *
 * Terminals (opt-in, ORCH_WEB_ALLOW_TERM=1 — see terminal.ts):
 *   GET  /terminal              the terminal client page
 *   GET  /api/term/status       { allowed, ready, error?, current? }
 *   POST /api/term/open         { cols, rows, fresh? }   -> TermInfo
 *   GET  /api/term/:id/stream?since=N   SSE: base64 output chunks
 *   POST /api/term/:id/input    { data }
 *   POST /api/term/:id/resize   { cols, rows }
 *   POST /api/term/:id/close    {}
 *
 * Ownership rule (see lib/inbox-agents.ts): a session must only be written by
 * one process at a time. sendToAgent adopts a session and queues the message; the
 * supervisor only spawns a run when the session is idle. A live TUI turn on the
 * same session is visible in inbox-live/ and is reported as `busy` instead of
 * being raced.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	AGENTS_DIR,
	cancelAgent,
	onAgentEvent,
	getAgent,
	listAgents,
	markSeen,
	isWriting,
	queueReason,
	type QueueReason,
	removeQueuedMessage,
	renameAgent,
	sendQueuedMessageNow,
	sessionModel,
	sendToAgent,
	setAgentModel,
	spawnAgent,
	startAgentSupervisor,
	agentsSummary,
	type BgAgent,
} from "../../lib/inbox-agents.ts";
import {
	projectFamilies,
	readWorkerLinks,
	WorkerFolds,
	type WorkerLink,
} from "../inbox/families.ts";
import { InboxGroups } from "../inbox/groups.ts";
import { beforeRun } from "../../lib/session-branch.ts";
import { writeClone } from "../../lib/session-clone.ts";
import { loadPty, ptyStatus, TermError, TerminalHost } from "./terminal.ts";
import {
	CATALOG_MARKER,
	type Catalog,
	type CatalogCommand,
	type CatalogPrompt,
	type CatalogSkill,
} from "./catalog.ts";

const AGENT_DIR = getAgentDir();
const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");
const LIVE_DIR = path.join(AGENT_DIR, "inbox-live");
const STORE_PATH = path.join(AGENT_DIR, "inbox.json");
const TAIL_BYTES = 128 * 1024;
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
	// Keep the file's shape the same as the inbox's: an unset key is absent, not
	// present-and-undefined. The TUI treats the presence of these keys as truth.
	for (const key of [
		"pinnedAt",
		"archivedAt",
		"seenAt",
		"unreadAt",
		"clonedAt",
		"filter",
	] as const) {
		if (!meta[key]) delete meta[key];
	}
	if (Object.keys(meta).length === 0) delete store.sessions[id];
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

// ───────────────────────────── models ─────────────────────────────

/**
 * The model picker the phone shows.
 *
 * The TUI's `N` offers `ctx.scopedModels`, which pi derives from the
 * `enabledModels` list in settings.json. The daemon has no session and so no
 * scoped list, and resolving one needs provider auth and (for a gateway
 * provider) a network round trip. Reading the same settings file is what keeps
 * the two pickers identical, and it works with the laptop on a plane.
 */
export interface ModelChoice {
	/** `provider/model`; the client appends `:thinking` when one is chosen. */
	reference: string;
	provider: string;
	id: string;
	/** The level this model would use with no explicit choice. */
	defaultLevel?: string;
	/** Levels to offer; narrowed by the model's `thinkingLevelMap` when known. */
	levels: string[];
}

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface SettingsFile {
	enabledModels?: unknown;
	defaultThinkingLevel?: unknown;
	modelThinkingLevels?: Record<string, unknown>;
}

function readSettings(): SettingsFile {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(AGENT_DIR, "settings.json"), "utf-8"),
		) as SettingsFile;
	} catch {
		return {};
	}
}

/**
 * Per-model supported levels, from the model catalog when it is reachable.
 * Best effort: a provider that needs the network to enumerate models simply
 * leaves every level on offer, and pi rejects an unsupported one on use.
 */
let levelCache: { at: number; map: Map<string, string[]> } | undefined;

/** Built once at startup; `undefined` until then, and if creation failed. */
let modelRuntime: ModelRuntime | undefined;

export async function loadModelRuntime() {
	try {
		modelRuntime = await ModelRuntime.create({
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
	} catch {
		modelRuntime = undefined;
	}
	return modelRuntime;
}

function supportedLevels(): Map<string, string[]> {
	const now = Date.now();
	if (levelCache && now - levelCache.at < 60_000) return levelCache.map;
	const map = new Map<string, string[]>();
	try {
		for (const m of modelRuntime?.getModels() ?? []) {
			// A `null` entry in thinkingLevelMap means that level is unsupported.
			const allowed = ALL_LEVELS.filter(
				(level) => m.thinkingLevelMap?.[level] !== null,
			);
			if (allowed.length) map.set(`${m.provider}/${m.id}`, allowed);
		}
	} catch {
		// no catalog available; every level stays on offer
	}
	levelCache = { at: now, map };
	return map;
}

export function modelChoices(): {
	models: ModelChoice[];
	defaultLevel?: string;
	source: "settings" | "none";
} {
	const settings = readSettings();
	const enabled = Array.isArray(settings.enabledModels)
		? settings.enabledModels.filter((v): v is string => typeof v === "string")
		: [];
	const perModel = settings.modelThinkingLevels ?? {};
	const levels = supportedLevels();
	const out: ModelChoice[] = [];
	for (const reference of enabled) {
		const slash = reference.indexOf("/");
		if (slash <= 0) continue;
		const provider = reference.slice(0, slash);
		const id = reference.slice(slash + 1);
		const configured = perModel[reference];
		const defaultLevel =
			typeof configured === "string"
				? configured
				: typeof settings.defaultThinkingLevel === "string"
					? settings.defaultThinkingLevel
					: undefined;
		out.push({
			reference,
			provider,
			id,
			defaultLevel,
			levels: levels.get(reference) ?? ALL_LEVELS,
		});
	}
	return {
		models: out,
		defaultLevel:
			typeof settings.defaultThinkingLevel === "string"
				? settings.defaultThinkingLevel
				: undefined,
		source: out.length ? "settings" : "none",
	};
}

// ───────────────────────────── completion catalog ─────────────────────────────

/**
 * What `$`, `/` and `@` can offer in the phone's composer.
 *
 * The TUI answers this from live pi objects. The daemon can't: it is not a pi
 * process, and extension factories (which is where `/command` comes from) must
 * not be run in a long-lived host. So catalog.ts runs pi's own discovery in a
 * one-shot child and prints JSON, and the answer is cached here.
 *
 * Session mentions are deliberately *not* cached: sessions are created, renamed
 * and archived constantly, and the daemon already has their headers on disk.
 */
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 30_000;
let catalogCache: { catalog: Catalog; at: number } | undefined;
let catalogInflight: Promise<Catalog> | undefined;

export function catalogPath(): string {
	return path.join(
		import.meta.dirname ?? __dirname,
		"catalog.ts",
	);
}

/** The node that runs the daemon; the child imports the same pi package. */
function catalogNode(): string {
	const override = process.env.ORCH_WEB_NODE?.trim();
	if (override) return override;
	return process.execPath;
}

/**
 * Run the catalog child. Failures are soft: an empty catalog means the phone
 * offers no completions, which is exactly how the composer behaves today.
 *
 * Node, not `pi`: pi's own CLI parses the arguments, so node flags would be
 * rejected. The daemon's NODE_PATH (set by scripts/orch-web.sh) is what lets
 * this child resolve @earendil-works/pi-coding-agent at all.
 */
function runCatalog(): Promise<Catalog> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			catalogNode(),
			[
				"--experimental-transform-types",
				"--no-warnings",
				catalogPath(),
			],
			{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
		);
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`catalog timed out after ${CATALOG_TIMEOUT_MS}ms`));
		}, CATALOG_TIMEOUT_MS);
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			err += chunk;
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const line = out
				.split("\n")
				.find((l) => l.startsWith(`${CATALOG_MARKER}`));
			if (!line) {
				reject(
					new Error(
						`catalog exited ${code}: ${err.trim().split("\n").at(-1) ?? "no output"}`,
					),
				);
				return;
			}
			try {
				resolve(JSON.parse(line.slice(CATALOG_MARKER.length)) as Catalog);
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	});
}

/** Cached catalog for the composer; a stale or failed build is reported. */
export async function commandCatalog(force = false): Promise<{
	catalog: Catalog | undefined;
	stale: boolean;
	loading?: boolean;
	error?: string;
}> {
	const now = Date.now();
	if (!force && catalogCache && now - catalogCache.at < CATALOG_TTL_MS) {
		return { catalog: catalogCache.catalog, stale: false };
	}
	if (catalogInflight) {
		// Someone else is building it. Answer with what we have and let the next
		// call pick up the fresh catalog, rather than holding two requests open.
		return {
			catalog: catalogCache?.catalog,
			stale: !!catalogCache,
			loading: true,
		};
	}
	catalogInflight = runCatalog().finally(() => {
		catalogInflight = undefined;
	});
	try {
		const catalog = await catalogInflight;
		catalogCache = { catalog, at: Date.now() };
		return { catalog, stale: false };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		say("catalog-failed", { error: message });
		// Keep serving the previous catalog rather than emptying the picker.
		return { catalog: catalogCache?.catalog, stale: true, error: message };
	}
}

// ───────────────────────────── live records ─────────────────────────────

interface LiveRecord {
	pid: number;
	sessionId: string;
	sessionFile?: string;
	state: "idle" | "working";
	updated: number;
	bgParent?: number;
	/** The run's start; the heartbeat only moves `updated`, so this survives. */
	startedAt?: number;
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
			// A live record is a CLAIM about a pid: "this process has this session
			// open, and may be writing it right now". The claim is over when the pid
			// is gone, no matter who spawned it. `ours` used to skip the liveness
			// check entirely for this daemon's own children (`bgParent ===
			// process.pid`), so a child that had already exited kept reporting
			// `working` until the stale cutoff -- which made an unrelated idle
			// session read as busy, disabled its Send button into Queue, and blocked
			// its run behind writerElsewhere. Only a pid this daemon is actually
			// tracking (`listAgents()`) may vouch for a record without being alive.
			const tracked = listAgents().some((a) => a.pid === rec.pid);
			if (!tracked && !pidAlive(rec.pid)) {
				fs.rmSync(full, { force: true });
				continue;
			}
			// Age a stale `working` claim down to how we DISPLAY it. The rule itself
			// lives in `isWriting`, so this can no longer disagree with the gates.
			if (!isWriting(rec) && rec.state === "working") {
				rec.state = "idle";
				rec.stuckMin = Math.round(
					(Date.now() - rec.updated) / 60_000,
				);
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
	/**
	 * Why this row's queued work has not started. Only `slot` is a capacity
	 * problem; `writer` means another live process holds the session, and
	 * `running` means its own run is simply still in flight. Absent when nothing
	 * is waiting.
	 */
	queueReason?: QueueReason;
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
	/** Hidden by a manual override in the inbox's filter store. */
	hidden?: boolean;
	groupId?: string;
	parentId?: string;
	/** True when this session was delegated by another one: drawn under its parent. */
	child?: boolean;
	/** Number of delegated children collapsed under this row. */
	children?: number;
	/** Whether those children are currently shown. */
	expanded?: boolean;
	/** Last child in its family: the client draws the tree tail. */
	lastChild?: boolean;
	/** Human-readable group name, when the daemon knows the group. */
	groupName?: string;
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

/**
 * Which parents are expanded, read from the inbox's own fold file so the phone
 * and the TUI agree. A missing or malformed file means "all collapsed", which is
 * the useful default: the point of the feature is fewer rows.
 */
function readExpanded(): Set<string> {
	try {
		return new WorkerFolds(AGENT_DIR).load();
	} catch {
		return new Set();
	}
}

/** A session is busy when this daemon runs it or another live pi process does. */
function busyState(a: BgAgent | undefined, live?: LiveRecord) {
	if (a && (a.state === "working" || a.state === "queued")) return a.state;
	if (live?.state === "working") return "working";
	return undefined;
}

/**
 * Why a row's queued message has not started.
 *
 * `queueReason` answers this against the in-memory registry, which only knows
 * the agents THIS process runs. The daemon also has to account for a run held
 * by another live pi (`live`), so that case is folded in here: a row whose work
 * is waiting because some other process is mid-run is not waiting for capacity.
 */
function queueReasonFor(
	id: string,
	a: BgAgent | undefined,
	live?: LiveRecord,
): Row["queueReason"] {
	// A live record only means "someone else" when that someone is not us. The
	// daemon does not normally run the session it is displaying, but a record
	// naming this pid would still be this process's own run -- and calling that
	// "another pi is running it" is the mistake the label made before.
	if (live?.state === "working" && !a?.proc && live.pid !== process.pid) {
		return "writer";
	}
	if (!a) return undefined;
	// The daemon's own cap, not the one baked into inbox-agents at import time:
	// PI_INBOX_MAX_AGENTS is read once per module load, and the daemon is a
	// separate process with its own copy.
	if (a.proc || a.hold) return "running";
	const running = listAgents().filter((x) => x.proc).length;
	if (running >= MAX_CONCURRENT) return "slot";
	return queueReason(id);
}

/** The shared inputs one row is built from. Read once per list build. */
interface RowEnv {
	store: { sessions: Record<string, any> };
	live: Map<string, any>;
	groupOf: (id: string) => string | undefined;
	groupName: (id?: string) => string | undefined;
	parentOf: Map<string, string>;
	groups: any;
}

function rowEnv(): RowEnv {
	const store = loadStore();
	const groups = (() => {
		try {
			return new InboxGroups(AGENT_DIR).load();
		} catch {
			return { groups: [], sessions: {} } as any;
		}
	})();
	const parentOf = new Map<string, string>();
	for (const link of readWorkerLinks(AGENT_DIR) as WorkerLink[]) {
		parentOf.set(link.id, link.parentId);
	}
	return {
		store: store as RowEnv["store"],
		live: readLive() as unknown as Map<string, any>,
		groupOf: (id) => groups.sessions?.[id],
		groupName: (id) =>
			id ? groups.groups?.find((g: any) => g.id === id)?.name : undefined,
		parentOf,
		groups,
	};
}

/**
 * One on-disk session as a row.
 *
 * Extracted so a caller that needs exactly one row pays for one row. The
 * transcript stream used to call `buildRows()` — every session on disk, now
 * ~800 and 1 GB — on a 1.2s timer, only to `.find()` the session it already
 * knew the id of. That is the same "fingerprint before the work" mistake the
 * inbox fixed in the list refresh.
 */
function rowFromHeader(h: HeaderInfo, env: RowEnv): Row {
	const meta = env.store.sessions[h.id] ?? {};
	const tail = readTail(h.path);
	const bg = getAgent(h.id);
	const liveRec = env.live.get(h.id);
	const groupId = env.groupOf(h.id);
	return {
		id: h.id,
		title: cleanTitle(
			readName(h.path) || firstUserText(h.path) || "(no messages)",
		),
		cwd: h.cwd,
		status: tail.status,
		state: busyState(bg, liveRec),
		// Only rows with work actually waiting get a reason, so the UI can say
		// "queued behind another process" instead of "waiting for a slot". A row
		// whose own run is in flight still gets "running" -- that is the label
		// for messages queued behind the turn you are watching.
		queueReason:
			(bg?.pending.length ?? 0) > 0
				? queueReasonFor(h.id, bg, liveRec)
				: undefined,
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
		hidden: meta.filter === "hide",
		unread: (meta.unreadAt ?? 0) > (meta.seenAt ?? 0) || !!bg?.needsYou,
		groupId,
		groupName: env.groupName(groupId),
		parentId: env.parentOf.get(h.id),
		firstPrompt: cleanTitle(firstUserText(h.path)),
		lastSaid: tail.lastSaid,
		lastText: tail.lastText,
	};
}

/** A session that exists only in the agent registry (a brand-new first run). */
function rowFromAgent(a: BgAgent, env: RowEnv): Row {
	const meta = env.store.sessions[a.id] ?? {};
	const groupId = env.groupOf(a.id);
	return {
		id: a.id,
		title: cleanTitle(a.title),
		cwd: a.cwd,
		status: "empty",
		state: busyState(a),
		queueReason: a.pending.length > 0 ? queueReasonFor(a.id, a) : undefined,
		live: true,
		livePid: a.pid,
		model: a.model ?? a.nextModel,
		updated: a.updatedAt,
		created: a.createdAt,
		pending: a.pending.length,
		needsYou: !!a.needsYou,
		pinned: !!meta.pinnedAt,
		archived: !!meta.archivedAt,
		hidden: meta.filter === "hide",
		unread: !!a.needsYou,
		groupId,
		groupName: env.groupName(groupId),
		parentId: env.parentOf.get(a.id),
		firstPrompt: cleanTitle(a.title),
		lastSaid: a.lastText
			? { role: "assistant", text: a.lastText }
			: undefined,
		lastText: a.lastText ?? "",
	};
}

/**
 * One row, without building the other ~800.
 *
 * Same projection the list applies (family collapse included), so the caller
 * sees exactly the row it would have found in `buildRows`. Archived and hidden
 * are always included: the caller already named the session, and refusing to
 * describe an archived one would break the phone's archived view.
 */
export function buildRow(
	id: string,
	opts: { currentId?: string } = {},
): Row | undefined {
	const env = rowEnv();
	const header = scanHeaders().find((h) => h.id === id);
	const agent = header ? undefined : getAgent(id);
	if (!header && !agent) return undefined;
	const row = header ? rowFromHeader(header, env) : rowFromAgent(agent!, env);
	// The transcript stream and the send path both include archived + hidden
	// sessions, so the projection only has to keep this one row.
	const links = readWorkerLinks(AGENT_DIR) as WorkerLink[];
	const projected = projectFamilies([row], [row], links, {
		id: (r: Row) => r.id,
		expanded: readExpanded(),
	});
	return projected[0]?.row as Row | undefined;
}

export function buildRows(opts: {
	currentId?: string;
	withArchived?: boolean;
	/** Include sessions hidden by a manual `hide` override (the Filtered view). */
	withHidden?: boolean;
} = {}) {
	const env = rowEnv();
	const store = env.store;

	const rows: Row[] = [];
	const seen = new Set<string>();
	for (const h of scanHeaders()) {
		const meta = store.sessions[h.id] ?? {};
		if (meta.archivedAt && !opts.withArchived) continue;
		// A manual `hide` (the TUI's `x` on a session no rule matched) is a filing
		// decision, not a status: the phone honours it so both lists match.
		if (meta.filter === "hide" && !opts.withHidden) continue;
		seen.add(h.id);
		rows.push(rowFromHeader(h, env));
	}
	// Sessions queued but not on disk yet (a brand-new agent's first run).
	for (const a of listAgents()) {
		if (seen.has(a.id)) continue;
		const meta = store.sessions[a.id] ?? {};
		if (meta.archivedAt && !opts.withArchived) continue;
		if (meta.filter === "hide" && !opts.withHidden) continue;
		rows.push(rowFromAgent(a, env));
	}
	rows.sort((x, y) => y.updated - x.updated);
	// Collapse delegated workers under the session that spawned them: a fan-out
	// is otherwise one row per worker (137 children across 34 parents here) and
	// buries the sessions the person actually started. projectFamilies is the
	// same projection the TUI inbox draws, so the two views agree.
	const links = readWorkerLinks(AGENT_DIR) as WorkerLink[];
	const projected = projectFamilies(rows, rows, links, {
		id: (row: Row) => row.id,
		expanded: readExpanded(),
	});
	const ordered: Row[] = [];
	for (const item of projected) {
		ordered.push({
			...item.row,
			child: item.child,
			children: item.children.length,
			expanded: item.expanded,
		});
		if (item.expanded) {
			for (const [i, kid] of item.children.entries()) {
				ordered.push({
					...kid,
					child: true,
					lastChild: i === item.children.length - 1,
				});
			}
		}
	}
	return {
		rows: ordered,
		groups: env.groups?.groups ?? [],
		// The TUI persists the All-groups layout; the phone draws the same list,
		// so it honours the same choice instead of inventing a second one.
		layout:
			env.groups?.layout === "flat"
				? ("flat" as const)
				: ("groups" as const),
		defaultGroupId: env.groups?.defaultGroupId,
		summary: agentsSummary(),
		capacity: {
			running: rows.filter((r) => r.state === "working").length,
			max: MAX_CONCURRENT,
		},
		now: Date.now(),
	};
}

// ───────────────────────────── session mentions ─────────────────────────────

/**
 * Sessions the composer can reference with `@[`.
 *
 * The TUI's picker reads `SessionManager.listAll()`, which parses every line of
 * every session file (hundreds of files, hundreds of megabytes) to build a
 * message count. The daemon already walks headers for the list, and the phone
 * only ever sends the id, so headers plus a name is all the choice needs.
 *
 * `label` is what the picker shows; `value` is the immutable token inserted into
 * the prompt. Selection is stable across renames, exactly like the TUI's.
 */
export interface MentionChoice {
	id: string;
	label: string;
	cwd: string;
	dir: string;
	group?: string;
	groupName?: string;
	modified: number;
	value: string;
}

export function mentionChoices(opts: {
	/** Session doing the mentioning: excluded, and its group is the default scope. */
	from?: string;
	/**
	 * Restrict to one inbox group. `"all"` means no filter, `"self"` means the
	 * `from` session's own group (the TUI's `@g[`), and `"ungrouped"` means a
	 * session with no membership. Any other value is a group id.
	 */
	groupId?: string;
	withArchived?: boolean;
	includeSelf?: boolean;
} = {}): {
	mentions: MentionChoice[];
	groups: Array<{ id: string; name: string }>;
	defaultGroupId?: string;
	/** The filter that was applied, when one was. */
	group?: string;
	/** The mentioning session's own group; absent means it is ungrouped. */
	fromGroup?: string;
} {
	const store = loadStore();
	const groups = (() => {
		try {
			return new InboxGroups(AGENT_DIR).load();
		} catch {
			return {
				groups: [],
				sessions: {},
			} as unknown as ReturnType<InboxGroups["load"]>;
		}
	})();
	const nameOf = new Map(
		(groups.groups ?? []).map((g) => [g.id, g.name] as const),
	);
	const groupOf = (id: string): string | undefined => groups.sessions?.[id];

	// `group=all` is the TUI's `@[`: every session, whatever its group.
	// `group=self` is its `@g[` / `@ga[`: this session's group. An ungrouped
	// session's `@g[` matches *nothing* — quietly listing every session (or
	// every ungrouped one) looked like the filter had worked when it hadn't.
	// `group=ungrouped` is the explicit "no membership" filter. Any other value
	// is a group id.
	const fromGroup = opts.from ? groupOf(opts.from) : undefined;
	const selfScope = opts.groupId === "self";
	const none = selfScope && !fromGroup;
	const scope = opts.groupId === "all" || none
		? undefined
		: selfScope || opts.groupId === undefined
			? fromGroup
			: opts.groupId;
	const ungrouped = opts.groupId === "ungrouped";

	const mentions: MentionChoice[] = [];
	for (const h of none ? [] : scanHeaders()) {
		const meta = store.sessions[h.id] ?? {};
		if (meta.archivedAt && !opts.withArchived) continue;
		if (meta.filter === "hide") continue;
		if (!opts.includeSelf && opts.from && h.id === opts.from) continue;
		const gid = groupOf(h.id);
		if (ungrouped ? !!gid : scope ? gid !== scope : false) continue;
		mentions.push({
			id: h.id,
			label: cleanTitle(
				readName(h.path) || firstUserText(h.path) || "(no messages)",
			),
			cwd: h.cwd,
			dir: h.cwd.split("/").filter(Boolean).pop() ?? h.cwd,
			group: gid,
			groupName: gid ? nameOf.get(gid) : undefined,
			modified: h.modified.getTime(),
			// The same token the TUI inserts: the id, never the title.
			value: `@[${h.id}]`,
		});
	}
	mentions.sort((a, b) => b.modified - a.modified);
	return {
		mentions,
		groups: (groups.groups ?? []).map((g) => ({ id: g.id, name: g.name })),
		defaultGroupId: groups.defaultGroupId,
		group: opts.groupId === "all"
			? undefined
			: opts.groupId ? (none ? "ungrouped" : scope) : undefined,
		// The client says `@g[` found nothing because *this* session has no
		// group, rather than leaving an empty list to guess at.
		fromGroup,
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
	/**
	 * The run's concluding assistant message.
	 *
	 * Same definition the TUI's final-answer-divider uses: the model finished of
	 * its own accord (`stopReason === "stop"`) and did not ask for another tool.
	 * That is what makes it the answer rather than a step towards one, and it is
	 * read from the transcript rather than tracked separately, so a reload,
	 * another front end, or a historical session all agree.
	 */
	final?: boolean;
	ts?: string;
}

/**
 * Memo for `transcript`, keyed on (mtime, size) like the tail/name caches.
 *
 * `transcript()` parses the WHOLE session file. The event stream calls it every
 * 1.2s for the one open session, so an active 4MB session was re-parsed from the
 * top on every tick purely to redraw a tail that had not changed. Bounded below
 * so a phone browsing many sessions cannot grow it without limit.
 */
const transcriptCache = new Map<
	string,
	{ mtimeMs: number; size: number; limit: number; out: TranscriptMessage[] }
>();
const TRANSCRIPT_CACHE_MAX = 32;

export function transcript(file: string, limit = 200): TranscriptMessage[] {
	let stat: fs.Stats | undefined;
	try {
		stat = fs.statSync(file);
	} catch {
		// An unreadable file falls through to the uncached path, which reports [].
	}
	if (stat) {
		const hit = transcriptCache.get(file);
		if (
			hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size &&
			hit.limit === limit
		) return hit.out;
	}
	const out = readTranscript(file, limit);
	if (stat) {
		if (transcriptCache.size >= TRANSCRIPT_CACHE_MAX) {
			const oldest = transcriptCache.keys().next().value;
			if (oldest !== undefined) transcriptCache.delete(oldest);
		}
		transcriptCache.set(file, {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			limit,
			out,
		});
	}
	return out;
}

function readTranscript(file: string, limit: number): TranscriptMessage[] {
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
			let hasToolCall = false;
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b?.type === "text" && b.text?.trim()) said = true;
				else if (b?.type === "toolCall") {
					hasToolCall = true;
					tools.push({ name: b.name, arg: summarizeArgs(b.arguments) });
				}
			}
			const text = messageText(m.content).trim();
			if (!said && !tools.length) continue;
			out.push({
				role: "assistant",
				text,
				tools: tools.length ? tools : undefined,
				// Final answer, by the same rule the TUI's divider uses. A message
				// that also called a tool is a step, not the conclusion.
				final:
					m.stopReason === "stop" && !hasToolCall && said ? true : undefined,
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

/**
 * Terminals are the one feature that turns the bearer token into a literal
 * login shell, so they are off unless the operator asked for them. The flag is
 * read here, not per request, so one launchd restart is enough to change it.
 */
function termEnabled(): boolean {
	return /^(1|true|yes|on)$/i.test((process.env.ORCH_WEB_ALLOW_TERM ?? "").trim());
}

let terminals: TerminalHost | undefined;
export function terminalHost(): TerminalHost {
	if (!terminals)
		terminals = new TerminalHost({
			enabled: termEnabled(),
			audit: (event, detail) => say(event, detail ?? {}),
		});
	return terminals;
}

/**
 * Stop the daemon for real.
 *
 * `server.close()` waits for every connection to end, and a phone sitting on a
 * terminal page holds an SSE stream open forever — so a restart that only
 * called close() would hang until launchd gave up and SIGKILLed us, leaving the
 * login shells re-parented to init. Order matters: kill the shells and end
 * their streams first, then close the listener (which drops keep-alive
 * connections), then stop accepting new work.
 */
export async function stopOrchWeb(server: http.Server): Promise<void> {
	// The supervisor's own tick is unref'd, so it cannot hold the process open.
	terminalHost().dispose();
	// closeIdleConnections() drops keep-alive sockets that are between requests
	// without waiting for them; without this a poller stalls the shutdown.
	server.closeIdleConnections?.();
	await new Promise<void>((resolve) => {
		const done = () => resolve();
		server.close(done);
		// Belt and braces: a socket that will not drain must not wedge a restart.
		const force = setTimeout(() => {
			server.closeAllConnections?.();
			resolve();
		}, 3000);
		force.unref?.();
	});
}

export function startOrchWeb(cfg: Config) {
	running = cfg;
	// Resolve node-pty once, in the background: a missing native build must not
	// keep the daemon from serving the inbox.
	void loadPty().then((spawn) => {
		const status = ptyStatus();
		say("term-ready", {
			allowed: termEnabled(),
			ready: status.ready,
			error: status.error,
		});
		if (spawn && termEnabled()) terminalHost();
	});
	// Adopts agents whose owner stopped beating and keeps their queues draining.
	startAgentSupervisor({});
	// The model catalog names only what each provider supports per model, so the
	// phone can hide thinking levels that would be rejected. Optional: a failure
	// just leaves every level on offer.
	void loadModelRuntime();
	// Building the composer catalog spawns a one-shot child, so start it now
	// rather than making the first `$` on a phone wait for it.
	void commandCatalog().then((r) => {
		say("catalog-ready", {
			skills: r.catalog?.skills.length ?? 0,
			commands: r.catalog?.commands.length ?? 0,
			error: r.error,
		});
	});

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
	// The log is a terminal artifact: it is read with `tail -f`. Control
	// characters in a value (a crafted RemoteAddr is the realistic one) would
	// otherwise be interpreted by whatever terminal reads the file.
	process.stderr.write(`[orch-web] ${sanitizeForLog(line)}\n`);
}

/** Keep a log line printable: escape C0/C1 controls, DEL and the separators. */
export function sanitizeForLog(s: string): string {
	return s.replace(
		/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
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

/**
 * Vendored browser assets, by exact filename. Listing them beats validating a
 * path: a name that is not here is a 404, so nothing can walk out of the
 * directory however it is encoded.
 */
const VENDOR_FILES = new Set(
	["xterm.js", "xterm.css", "addon-fit.js"].map((n) => n.toLowerCase()),
);

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
	if (url.pathname === "/terminal") {
		return serveStatic(res, path.join(PUBLIC_DIR, "terminal.html"));
	}
	if (url.pathname.startsWith("/vendor/")) {
		// Vendored xterm assets. The name is matched against the directory listing
		// rather than joined blindly, so a `..` can never escape it.
		const name = url.pathname.slice("/vendor/".length);
		if (!VENDOR_FILES.has(name.toLowerCase())) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("Not found\n");
			return;
		}
		return serveStatic(res, path.join(PUBLIC_DIR, "vendor", name));
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
				withHidden: url.searchParams.get("hidden") === "1",
			}),
		);
	}

	if (req.method === "GET" && url.pathname === "/api/models") {
		return sendJson(res, 200, modelChoices());
	}

	if (req.method === "GET" && url.pathname === "/api/catalog") {
		const result = await commandCatalog(url.searchParams.get("refresh") === "1");
		return sendJson(res, 200, {
			skills: result.catalog?.skills ?? [],
			prompts: result.catalog?.prompts ?? [],
			commands: result.catalog?.commands ?? [],
			loadedAt: result.catalog?.loadedAt,
			stale: result.stale,
			loading: result.loading,
			error: result.error,
		});
	}

	if (req.method === "GET" && url.pathname === "/api/mentions") {
		return sendJson(
			res,
			200,
			mentionChoices({
				from: url.searchParams.get("from") ?? undefined,
				groupId: url.searchParams.get("group") ?? undefined,
				withArchived: url.searchParams.get("archived") === "1",
				includeSelf: url.searchParams.get("self") === "1",
			}),
		);
	}

	if (req.method === "GET" && url.pathname.startsWith("/api/stream/")) {
		const id = url.pathname.slice("/api/stream/".length);
		return streamAgent(res, id);
	}

	// ── terminals ──────────────────────────────────────────────────
	if (req.method === "GET" && url.pathname === "/api/term/status") {
		const host = terminalHost();
		const status = ptyStatus();
		return sendJson(res, 200, {
			allowed: host.allowed,
			ready: status.ready,
			error: status.error,
			current: host.current(),
		});
	}
	if (req.method === "GET" && url.pathname.startsWith("/api/term/")) {
		const rest = url.pathname.slice("/api/term/".length);
		const slash = rest.indexOf("/");
		if (slash < 0) return sendJson(res, 404, { error: "no such route" });
		const id = decodeURIComponent(rest.slice(0, slash));
		const verb = rest.slice(slash + 1);
		if (verb !== "stream") return sendJson(res, 404, { error: "no such route" });
		// Clamp here as well as in Ring.since(): the route is the boundary, and a
		// non-finite or negative value must never reach the buffer as anything
		// but "everything you have".
		const rawSince = Number(url.searchParams.get("since") ?? 0);
		const since = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
		if (!terminalHost().attach(res, id, since, req.socket.remoteAddress)) {
			sendJson(res, 404, { error: "no such terminal" });
		}
		return;
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
				// The TUI's `x`: a manual filing that no rule decides. `hide` keeps
				// the session out of the list; clearing it puts it back.
				if ("hidden" in patch)
					m.filter = patch.hidden ? "hide" : undefined;
			});
			return sendJson(res, 200, { ok: true, meta });
		}
		if (route === "/api/rename") {
			const { id, name } = body as { id: string; name: string };
			const next = String(name ?? "").trim();
			if (!next) throw new Error("a name is required");
			return sendJson(res, 200, doRename(id, next));
		}
		if (route === "/api/clone") {
			const id = (body as any).id as string;
			return sendJson(res, 200, doClone(id));
		}
		if (route === "/api/group/move") {
			const { id, groupId } = body as { id: string; groupId?: string };
			// Ungrouped is the absence of a membership, not a group id.
			await new InboxGroups(AGENT_DIR).assign(id, groupId || undefined);
			return sendJson(res, 200, { ok: true, id, groupId: groupId || undefined });
		}
		if (route === "/api/group/edit") {
			return sendJson(res, 200, await doGroupEdit(body as any));
		}
		if (route === "/api/fold") {
			const { id, expanded } = body as { id: string; expanded: boolean };
			try {
				new WorkerFolds(AGENT_DIR).setExpanded(id, !!expanded);
			} catch (e) {
				throw new Error(
					e instanceof Error ? e.message : "could not save fold state",
				);
			}
			return sendJson(res, 200, { ok: true, id, expanded: !!expanded });
		}
		if (route === "/api/seen") {
			const id = (body as any).id as string;
			markSeen(id);
			updateMeta(id, (m) => {
				m.seenAt = Date.now();
			});
			return sendJson(res, 200, { ok: true });
		}
		if (route === "/api/term/open") {
			const { cols, rows, fresh } = body as {
				cols?: number;
				rows?: number;
				fresh?: boolean;
			};
			try {
				const info = await terminalHost().open({
					cols,
					rows,
					fresh,
					remote: req.socket.remoteAddress,
				});
				return sendJson(res, 200, info);
			} catch (e) {
				const status = e instanceof TermError ? e.status : 500;
				return sendJson(res, status, {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		if (route.startsWith("/api/term/")) {
			const rest = route.slice("/api/term/".length);
			const slash = rest.indexOf("/");
			if (slash < 0) return sendJson(res, 404, { error: "no such route" });
			const id = decodeURIComponent(rest.slice(0, slash));
			const verb = rest.slice(slash + 1);
			const host = terminalHost();
			try {
				if (verb === "input") {
					const data = (body as { data?: unknown }).data;
					if (typeof data !== "string") throw new TermError(400, "data is required");
					// A phone keyboard pastes whole lines; a runaway paste is not a
					// reason to let one request stall the daemon.
					if (data.length > 65_536) throw new TermError(413, "input too large");
					host.input(id, data);
					return sendJson(res, 200, { ok: true });
				}
				if (verb === "resize") {
					const { cols, rows } = body as { cols?: number; rows?: number };
					return sendJson(res, 200, host.resize(id, Number(cols), Number(rows)));
				}
				if (verb === "close") {
					host.close(id, "requested");
					return sendJson(res, 200, { ok: true });
				}
			} catch (e) {
				const status = e instanceof TermError ? e.status : 500;
				return sendJson(res, status, {
					error: e instanceof Error ? e.message : String(e),
				});
			}
			return sendJson(res, 404, { error: "no such route" });
		}
	}

	sendJson(res, 404, { error: "no such route" });
}

function doSend(id: string, text: string) {
	const row = buildRow(id);
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

/**
 * Rename a session.
 *
 * The TUI has two paths and so does this: a background agent's child process
 * applies the name itself (writing the file from here would be a second writer
 * mid-run), while a quiet session is renamed in place. A session another pi is
 * holding right now is refused outright — that turn could append at any moment,
 * and the name would race it.
 */
function doRename(id: string, name: string) {
	const agent = getAgent(id);
	if (agent && (isAgentRunning(agent) || !sessionFileOf(id))) {
		renameAgent(id, name);
		return { ok: true, id, name, applied: "next-run" };
	}
	const file = sessionFileOf(id);
	if (!file) throw new Error("that session isn't saved yet — try again in a moment");
	const live = readLive().get(id);
	if (live?.state === "working" && live.pid !== process.pid) {
		throw new Error(
			`it's working in another pi (pid ${live.pid}) — rename it there, or wait`,
		);
	}
	SessionManager.open(file).appendSessionInfo(name);
	if (agent) renameAgent(id, name);
	return { ok: true, id, name, applied: "now" };
}

function isAgentRunning(a: BgAgent) {
	return a.state === "working" || a.state === "queued";
}

/**
 * Clone a session the way the inbox's `c` does: cut before the active prompt of
 * a running agent, so the original keeps its in-flight work and the copy starts
 * from the last completed step. The clone inherits the original's group.
 */
function doClone(id: string) {
	const file = sessionFileOf(id);
	if (!file || !fs.existsSync(file))
		throw new Error("that session isn't saved yet — nothing to clone");
	const agent = getAgent(id);
	const sm = SessionManager.open(file);
	const leaf =
		agent && isAgentRunning(agent) ? beforeRun(sm, agent) : sm.getLeafId();
	if (leaf === undefined)
		throw new Error("can't locate the run's checkpoint, so nothing was cloned");
	const groups = new InboxGroups(AGENT_DIR);
	let groupId: string | undefined;
	try {
		groupId = groups.load().sessions?.[id];
	} catch {
		// an unreadable group store must not block the clone
	}
	const clone = writeClone({
		file,
		sessionDir: path.dirname(file),
		leaf,
		// Mark the clone: its tail ends at a tool result, which the row reader
		// would otherwise call stalled until it has activity of its own.
		onCloned: (cloneId) => {
			updateMeta(cloneId, (m) => {
				m.clonedAt = Date.now();
			});
		},
	});
	if (groupId) {
		void groups.assign(clone.id, groupId).catch(() => {});
	}
	say("clone", { from: id, to: clone.id });
	return { ok: true, id: clone.id, name: clone.name, file: clone.file };
}

/** Create / rename / remove a group, or change the default. */
async function doGroupEdit(body: {
	action: "create" | "rename" | "remove" | "default" | "layout";
	id?: string;
	name?: string;
	layout?: "flat" | "groups";
}) {
	const groups = new InboxGroups(AGENT_DIR);
	switch (body?.action) {
		case "create": {
			const name = String(body.name ?? "").trim();
			if (!name) throw new Error("a group name is required");
			const group = await groups.create(name);
			return { ok: true, group };
		}
		case "rename": {
			const name = String(body.name ?? "").trim();
			if (!body.id) throw new Error("id is required");
			if (!name) throw new Error("a group name is required");
			await groups.rename(body.id, name);
			return { ok: true };
		}
		case "remove": {
			if (!body.id) throw new Error("id is required");
			await groups.remove(body.id);
			return { ok: true };
		}
		case "default": {
			await groups.setDefaultGroup(body.id || undefined);
			return { ok: true, defaultGroupId: body.id || undefined };
		}
		case "layout": {
			// Anything but an explicit "flat" is the grouped list, matching the
			// TUI's own fallback for a store that never recorded a choice.
			const layout = body.layout === "flat" ? "flat" : "groups";
			await groups.setLayout(layout);
			return { ok: true, layout };
		}
		default:
			throw new Error("unknown group action");
	}
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
		// Nothing here is meant to be embedded, and the terminal page is a
		// shell: refusing frames removes a clickjacking surface outright.
		"x-frame-options": "DENY",
		// Both pages are single files with their script and style inline and no
		// remote origin, so 'unsafe-inline' is not a weakening here — it is what
		// the zero-build design requires. Everything else is locked down.
		"content-security-policy": [
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data:",
			"connect-src 'self'",
			"frame-ancestors 'none'",
			"base-uri 'none'",
			"form-action 'self'",
			"object-src 'none'",
		].join("; "),
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
			// One row, not every session on disk. This used to call `buildRows()`
			// -- ~800 sessions, 1 GB -- and `.find()` the id it already had, on a
			// 1.2s timer. Included archived and hidden because the phone can have
			// an archived session open.
			const row = buildRow(id, { currentId: id });
			// A run owned by another process (a TUI, or the parent of this
			// daemon) has no registry handle here, so its in-flight output comes
			// from its event file instead. Without this the view sits on an empty
			// "working" box until the run ends.
			const live = a
				? (a.items?.slice(-40) ?? [])
				: liveItems(id);
			// Change detection has to come BEFORE the transcript is built, which
			// is what the inbox refresh learned the hard way: ~92% of an idle tick
			// was spent producing data that the fingerprint then discarded. The
			// transcript is the expensive part here (a whole-file parse), and
			// nothing it could return changes unless the file or the run moved --
			// so stat the file, and bail on that plus the cheap live signals.
			let stamp = "none";
			if (file) {
				try {
					const st = fs.statSync(file);
					stamp = `${st.mtimeMs}:${st.size}`;
				} catch {
					// Not written yet.
				}
			}
			// "Now doing": the last tool step. Streaming text is already a live
			// item, so it would otherwise be printed twice in the same box.
			const activity =
				a?.activity ??
				[...live].reverse().find((i) => i.kind === "tool")?.text;
			// The transcript is capped, so its length pins at the limit and edits
			// to the newest message are invisible to a length-only hash. Include
			// the file stat AND the event byte count so a long run cannot look
			// idle, while a genuinely quiet session skips the parse entirely.
			const key = JSON.stringify([
				row?.title,
				stamp,
				live.length,
				live.at(-1) ?? null,
				activity,
				a?.pending.length ?? 0,
				row?.status,
				row?.state,
				eventBytes(id),
			]);
			if (key === lastKey) return;
			lastKey = key;
			const payload = {
				row,
				messages: file ? transcript(file, SSE_TRANSCRIPT_LIMIT) : [],
				pending: a?.pending ?? [],
				model:
					a?.model ?? a?.nextModel ?? (file ? sessionModel(file) : undefined),
				live,
				activity,
			};
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


