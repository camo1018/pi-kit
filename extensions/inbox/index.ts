/**
 * Inbox — a visual "todo box" for all Pi sessions.
 *
 *   /inbox            open the inbox (also: ctrl+q)
 *   /orchestrator     toggle inbox orchestrator mode: this window becomes a full-screen
 *                     agent control panel (pi --orchestrator); on | off | home
 *                     (home = hand back the taken-over session)
 *   /pin              toggle pin on the current session
 *   /archive          toggle archive on the current session
 *
 * Inside the inbox:
 *   ↑/↓ PgUp/PgDn  move          enter       agent view: live transcript (r there = reply)
 *   o              open (switch to) session in this window
 *   n / N          new background agent (N: pick its model); you type its prompt in pi's editor
 *   ctrl+w   pick a working directory: for a new agent (while typing its prompt / at home), and
 *            inside an attached/taken-over session: move that session to another directory
 *   d              move the selected session to another directory (orchestrator mode)
 *   c              cancel a running background agent
 *   p              pin / unpin   a           archive / unarchive (done)
 *   tab / 1 2 3 4  Inbox · Archived · All · Filtered    /  search (full-text)
 *   x              filter out / back in (overrides the rules in ~/.pi/agent/inbox-filters.json)
 *   r              rename        R / ctrl+r  refresh       esc / q  close
 *
 * Status is derived from each session file's tail plus a live registry that
 * every running Pi process (with this extension) keeps updated:
 *   ● working    another (or this) Pi process is running the agent
 *   ◆ your turn  agent finished, waiting on you
 *   ✗ error      last turn ended with a provider error
 *   ⏸ aborted    last turn was aborted
 *   ⚠ stalled    run was cut off mid-turn (process died / quit while working)
 *   ◉            session is open in some Pi process right now
 *
 * Pin/archive metadata lives in ~/.pi/agent/inbox.json (session files are not modified).
 * Filter rules (a blocklist for kinds of sessions, e.g. automated jobs) live in
 * ~/.pi/agent/inbox-filters.json; matching sessions move to the Filtered tab.
 * /inbox filters shows the active rules and what they hide.
 * Sending a new prompt in an archived session moves it back to the inbox automatically.
 *
 * Background agents are child pi processes run by ~/.pi/agent/lib/inbox-agents.ts.
 * They keep working while you do other things; replies to a working agent are queued.
 *
 * Orchestrator mode: the inbox fills the whole screen and the window never shows a chat at
 * home. enter takes a session over (a working agent is stopped first), v peeks, n starts an
 * agent from a full-screen prompt, ctrl+q comes back, h hands back, Q leaves the mode.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
	installBackgroundMcpAutoApproval,
} from "../../lib/background-mcp-approval.ts";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import { handleVisitModelInput } from "./visit-models.ts";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	getAgentDir,
	getMarkdownTheme,
	getSelectListTheme,
	parseSkillBlock,
	SessionManager,
	SettingsManager,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Editor,
	type Focusable,
	getKeybindings,
	Input,
	Markdown,
	Text,
	wrapTextWithAnsi,
	type KeybindingsManager,
	type OverlayOptions,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	Container,
	Spacer,
} from "@earendil-works/pi-tui";
import {
	AgentViewComponent,
	type AgentViewResult,
	agentsSummary,
	type BgAgent,
	cancelAgent,
	findSessionFile,
	getAgent,
	isRunning,
	listAgents,
	onAgentEvent,
	holdAgent,
	installAgentChildHooks,
	isAgentChild,
	markSeen,
	nextSessionModel,
	recordActualThinkingLevel,
	setAgentDir,
	startAgentSupervisor,
	releaseAgent,
	releaseHold,
	removeQueuedMessage,
	renameAgent,
	sendQueuedMessageNow,
	sendToAgent,
	sessionModel,
	spawnAgent,
} from "../../lib/inbox-agents.ts";
import {
	closeVisit,
	isVisiting,
	openVisit,
	visitAgent,
	visitRunning,
	visitState,
	viewedSession,
} from "../../lib/visit-runtime.ts";

// ───────────────────────────── storage ─────────────────────────────

const AGENT_DIR = getAgentDir();
const STORE_PATH = path.join(AGENT_DIR, "inbox.json");
const FILTERS_PATH = path.join(AGENT_DIR, "inbox-filters.json");
const README_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "README.md");

function readReadme(): string {
	try {
		return fs.readFileSync(README_PATH, "utf-8");
	} catch {
		return `# Pi Inbox\n\nREADME not found at \`${README_PATH}\`.\n\nKeys: enter open · p pin · a archive · tab view · / search · r rename · esc close`;
	}
}

/** Scrollable markdown viewer for the README. */
class HelpComponent {
	private scroll = 0;
	private md: Markdown;
	private cache?: { width: number; lines: string[] };
	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
		markdown: string = readReadme(),
		private heading = "help",
	) {
		this.md = new Markdown(markdown, 1, 0, getMarkdownTheme());
	}
	invalidate() {
		this.cache = undefined;
		this.md.invalidate();
	}
	private viewH() {
		const rows = this.tui.terminal?.rows ?? 30;
		return Math.max(6, (orchestrating() ? rows : Math.floor(rows * 0.9)) - 3);
	}
	handleInput(data: string) {
		const ch = printable(data);
		const total = this.cache?.lines.length ?? 0;
		const max = Math.max(0, total - this.viewH());
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || ch === "q" || ch === "?") return this.done();
		if (matchesKey(data, "up") || ch === "k") this.scroll--;
		else if (matchesKey(data, "down") || ch === "j") this.scroll++;
		else if (matchesKey(data, "pageUp")) this.scroll -= this.viewH();
		else if (matchesKey(data, "pageDown") || ch === " ") this.scroll += this.viewH();
		else if (matchesKey(data, "home") || ch === "g") this.scroll = 0;
		else if (matchesKey(data, "end") || ch === "G") this.scroll = max;
		this.scroll = Math.max(0, Math.min(this.scroll, max));
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		if (!this.cache || this.cache.width !== innerW) this.cache = { width: innerW, lines: this.md.render(innerW) };
		const lines = this.cache.lines;
		const H = this.viewH();
		const b = (s: string) => th.fg("borderMuted", s);
		const title = ` ${th.bold(th.fg("accent", `📥 Pi Inbox — ${this.heading}`))} `;
		const out = [b("╭─") + title + b("─".repeat(Math.max(0, innerW - 1 - visibleWidth(title)))) + b("╮")];
		for (let i = 0; i < H; i++) out.push(b("│") + fit(lines[this.scroll + i] ?? "", innerW) + b("│"));
		const pos = lines.length > H ? `${Math.round(((this.scroll + H) / lines.length) * 100)}%` : "";
		const foot = ` ${th.fg("dim", "↑↓/jk scroll · space/PgDn page · esc/q/? close")}${pos ? th.fg("dim", `  ${pos}`) : ""}`;
		out.push(b("│") + fit(foot, innerW) + b("│"));
		out.push(b(`╰${"─".repeat(innerW)}╯`));
		return out.map((l) => truncateToWidth(l, width));
	}
}
const LIVE_DIR = path.join(AGENT_DIR, "inbox-live");

interface SessionMeta {
	pinnedAt?: number;
	archivedAt?: number;
	/** Manual override of the filter rules: "hide" filters the session out, "show" keeps a rule-matched one in. */
	filter?: "hide" | "show";
	/** Last time you looked at the session (opened it, watched it finish, or peeked). Drives the unread dot. */
	seenAt?: number;
	/** You marked it unread by hand (`u`). Shows the dot until you next look at it or mark it read. */
	unreadAt?: number;
}
interface Store {
	version: 1;
	sessions: Record<string, SessionMeta>;
	/** When unread tracking started: sessions last written before this count as read. */
	unreadSince?: number;
}

function loadStore(): Store {
	try {
		const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
		if (data && typeof data === "object" && data.sessions) return data as Store;
	} catch {
		// missing or corrupt → empty
	}
	return { version: 1, sessions: {} };
}

/** Read-modify-write against the latest on-disk copy (several Pi processes may share it). */
function updateMeta(sessionId: string, fn: (m: SessionMeta) => void): SessionMeta {
	const store = loadStore();
	const meta = { ...(store.sessions[sessionId] ?? {}) };
	fn(meta);
	if (!meta.pinnedAt) delete meta.pinnedAt;
	if (!meta.archivedAt) delete meta.archivedAt;
	if (!meta.filter) delete meta.filter;
	if (!meta.seenAt) delete meta.seenAt;
	if (!meta.unreadAt) delete meta.unreadAt;
	if (Object.keys(meta).length === 0) delete store.sessions[sessionId];
	else store.sessions[sessionId] = meta;
	saveStore(store);
	return meta;
}

function saveStore(store: Store) {
	const tmp = `${STORE_PATH}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
	fs.renameSync(tmp, STORE_PATH);
}

/** Start unread tracking (once). Everything written before now counts as read. */
function unreadBaseline(store: Store): number {
	if (store.unreadSince) return store.unreadSince;
	const latest = loadStore();
	latest.unreadSince ??= Date.now();
	saveStore(latest);
	store.unreadSince = latest.unreadSince;
	return latest.unreadSince;
}

/** You've looked at this session: clear its unread dot (and a background agent's "needs you"). */
function markRead(sessionId: string) {
	markSeen(sessionId);
	try {
		updateMeta(sessionId, (m) => {
			m.seenAt = Date.now();
			m.unreadAt = undefined;
		});
	} catch {
		// best effort: an unwritable store just leaves the dot on
	}
}

/** Unread because you marked it so (`u`), not because something finished — those marks are intentional. */
function manuallyUnread(sessionId: string): boolean {
	const m = loadStore().sessions[sessionId];
	return !!m?.unreadAt && m.unreadAt > (m.seenAt ?? 0);
}

// ───────────────────────────── filters (session blocklist) ─────────────────────────────

/**
 * A rule matches a session when every condition it sets matches (AND). A session is
 * filtered out when any enabled rule matches it (OR), unless the user overrode it with `x`.
 * Regex conditions are tested against the session's SessionInfo fields.
 */
interface FilterRule {
	name: string;
	description?: string;
	enabled?: boolean;
	/** RegExp flags for every regex in the rule, e.g. "i". `g`/`y` are ignored (they make test() stateful). */
	flags?: string;
	firstMessage?: string;
	cwd?: string;
	sessionName?: string;
	text?: string;
	minMessages?: number;
	maxMessages?: number;
}

const REGEX_KEYS = ["firstMessage", "cwd", "sessionName", "text"] as const;
const RULE_KEYS = new Set<string>(["name", "description", "enabled", "flags", "minMessages", "maxMessages", ...REGEX_KEYS]);

interface CompiledRule {
	rule: FilterRule;
	re: Partial<Record<(typeof REGEX_KEYS)[number], RegExp>>;
}
interface FilterSet {
	rules: CompiledRule[];
	errors: string[];
}

let filterCache: { key: string; set: FilterSet } | undefined;

/** Parse ~/.pi/agent/inbox-filters.json, re-reading only when it changes. Bad rules are reported, not fatal. */
function loadFilters(): FilterSet {
	let st: fs.Stats | undefined;
	try {
		st = fs.statSync(FILTERS_PATH);
	} catch {
		// no file → no rules
	}
	const key = st ? `${st.mtimeMs}:${st.size}` : "none";
	if (filterCache?.key === key) return filterCache.set;

	const set: FilterSet = { rules: [], errors: [] };
	if (st) {
		try {
			const data = JSON.parse(fs.readFileSync(FILTERS_PATH, "utf-8"));
			const list = Array.isArray(data) ? data : data?.rules;
			if (!Array.isArray(list)) throw new Error('expected {"rules": [...]}');
			list.forEach((raw: any, i: number) => {
				const name = typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : `rule #${i + 1}`;
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void set.errors.push(`${name}: not an object`);
				const unknown = Object.keys(raw).filter((k) => !RULE_KEYS.has(k));
				if (unknown.length) return void set.errors.push(`${name}: unknown field(s) ${unknown.join(", ")}`);
				if (raw.enabled === false) return;
				for (const k of ["minMessages", "maxMessages"] as const) {
					if (raw[k] !== undefined && typeof raw[k] !== "number") return void set.errors.push(`${name}: ${k} must be a number`);
				}
				const flags = String(raw.flags ?? "").replace(/[gy]/g, "");
				const compiled: CompiledRule = { rule: { ...raw, name }, re: {} };
				for (const k of REGEX_KEYS) {
					if (raw[k] === undefined) continue;
					try {
						compiled.re[k] = new RegExp(String(raw[k]), flags);
					} catch (e) {
						return void set.errors.push(`${name}: bad ${k} regex: ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				if (Object.keys(compiled.re).length === 0 && raw.minMessages === undefined && raw.maxMessages === undefined)
					return void set.errors.push(`${name}: has no conditions, so it would hide every session`);
				set.rules.push(compiled);
			});
		} catch (e) {
			set.errors.push(`${FILTERS_PATH}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	filterCache = { key, set };
	return set;
}

/** Name of the first rule that matches the session, if any. */
function matchRule(info: SessionInfo, set: FilterSet): string | undefined {
	for (const { rule, re } of set.rules) {
		if (re.firstMessage && !re.firstMessage.test(info.firstMessage ?? "")) continue;
		if (re.cwd && !re.cwd.test(info.cwd ?? "")) continue;
		if (re.sessionName && !re.sessionName.test(info.name ?? "")) continue;
		if (re.text && !re.text.test(info.allMessagesText ?? "")) continue;
		if (rule.minMessages !== undefined && info.messageCount < rule.minMessages) continue;
		if (rule.maxMessages !== undefined && info.messageCount > rule.maxMessages) continue;
		return rule.name;
	}
	return undefined;
}

function isFiltered(meta: SessionMeta, rule: string | undefined): boolean {
	return meta.filter === "hide" || (!!rule && meta.filter !== "show");
}

// ───────────────────────────── live registry ─────────────────────────────

interface LiveRecord {
	pid: number;
	sessionId: string;
	sessionFile: string;
	state: "working" | "idle";
	updated: number;
	/** Set when this process is a background agent: pid of the pi that runs it. */
	bgParent?: number;
	/** Computed on read: claimed "working" but the session file has been silent too long. */
	stuckMin?: number;
}

// While working, each pi re-touches its own heartbeat every minute (even mid long tool call).
// A process frozen mid-turn (orphaned by a closed tab) can't, so its heartbeat goes stale.
// (The session file's mtime is no good here: a reopened window writes the same file.)
const PULSE_MS = 60_000;
const STUCK_AFTER_MS = 5 * PULSE_MS;
const PULSE_KEY = Symbol.for("pi.inbox.livePulse");

function setPulse(on: boolean) {
	const G = globalThis as any;
	if (G[PULSE_KEY]) clearInterval(G[PULSE_KEY]);
	G[PULSE_KEY] = undefined;
	if (!on) return;
	G[PULSE_KEY] = setInterval(() => {
		try {
			const rec = JSON.parse(fs.readFileSync(liveFile(), "utf-8")) as LiveRecord;
			if (rec.state !== "working") return;
			rec.updated = Date.now();
			fs.writeFileSync(liveFile(), JSON.stringify(rec), "utf-8");
		} catch {
			// best effort
		}
	}, PULSE_MS);
	G[PULSE_KEY].unref?.();
}

function liveFile(pid = process.pid) {
	return path.join(LIVE_DIR, `${pid}.json`);
}

function writeLive(ctx: ExtensionContext, state: LiveRecord["state"]) {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return;
	try {
		fs.mkdirSync(LIVE_DIR, { recursive: true });
		const rec: LiveRecord = {
			pid: process.pid,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile,
			state,
			updated: Date.now(),
		};
		const bgParent = Number(process.env.PI_INBOX_BG_PARENT);
		if (bgParent) rec.bgParent = bgParent;
		fs.writeFileSync(liveFile(), JSON.stringify(rec), "utf-8");
		setPulse(state === "working");
	} catch {
		// best effort
	}
}

function removeLive() {
	setPulse(false);
	try {
		fs.unlinkSync(liveFile());
	} catch {
		// ignore
	}
}

// ───────────────────────────── hangup guard ─────────────────────────────
// Backstop: if pi ever sees its tty close (stdin `end` / SIGHUP), exit synchronously instead of
// risking a hung async shutdown on a dead terminal. Session JSONL entries are already on disk.
// NOTE: when pi runs under a sandboxing wrapper the hangup may never reach pi at all (the wrapper
// is orphaned under launchd instead). In that case use a shell-level watchdog that kills the
// process tree once the tab's `login` process exits.
const HANGUP_LOG = path.join(AGENT_DIR, "inbox-hangup.log");

function installHangupGuard() {
	const G = globalThis as any;
	const key = Symbol.for("pi.inbox.hangupGuard");
	if (G[key] || !process.stdin.isTTY) return; // once per process; only interactive tty sessions
	G[key] = true;
	let dying = false;
	const die = (why: string) => {
		if (dying) return;
		dying = true;
		try {
			fs.appendFileSync(HANGUP_LOG, `${new Date().toISOString()} pid=${process.pid} ${why} -> exiting\n`);
		} catch {}
		try {
			removeLive();
		} catch {}
		// Background agents are deliberately left running (detached); another pi adopts them.
		// process.exit() can itself block restoring a dead tty; SIGKILL can't.
		process.kill(process.pid, "SIGKILL");
	};
	process.on("SIGHUP", () => die("SIGHUP"));
	process.stdin.on("end", () => die("stdin end (tty closed)"));
}

/**
 * Pids pgrep can see. Zombies are excluded — e.g. a pi that was killed while its wrapper parent
 * hangs around (orphaned) and never reaps it: kill(pid, 0) still succeeds on a zombie forever
 * (even across sandboxes, where a live process would give EPERM).
 * pgrep can't see our own sandbox (this pi + its background agents), so callers vouch for those.
 */
function visiblePids(): Set<number> | undefined {
	try {
		const r = spawnSync("pgrep", ["."], { encoding: "utf-8", timeout: 2000 });
		if (r.status !== 0 || !r.stdout) return undefined;
		return new Set(r.stdout.split("\n").filter(Boolean).map(Number));
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number, visible?: () => Set<number> | undefined): boolean {
	try {
		process.kill(pid, 0);
	} catch (e: any) {
		if (e?.code !== "EPERM") return false;
	}
	// The pid exists — but it may be a zombie. pgrep has the final say when available.
	const seen = visible?.();
	return seen ? seen.has(pid) : true;
}

function readLive(): Map<string, LiveRecord> {
	const out = new Map<string, LiveRecord>();
	let files: string[] = [];
	try {
		files = fs.readdirSync(LIVE_DIR);
	} catch {
		return out;
	}
	let seen: Set<number> | undefined | null = null; // lazily, once per read
	const visible = () => (seen === null ? (seen = visiblePids()) : seen);
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		const full = path.join(LIVE_DIR, f);
		try {
			const rec = JSON.parse(fs.readFileSync(full, "utf-8")) as LiveRecord;
			const ours =
				rec.pid === process.pid || rec.bgParent === process.pid || listAgents().some((a) => a.pid === rec.pid); // invisible to pgrep
			if (!ours && !pidAlive(rec.pid, visible)) {
				fs.unlinkSync(full);
				continue;
			}
			if (rec.state === "working") {
				// e.g. an orphan frozen mid-turn after its tab closed: don't keep calling it working.
				const silent = Date.now() - rec.updated;
				if (silent > STUCK_AFTER_MS) {
					rec.state = "idle";
					rec.stuckMin = Math.round(silent / 60_000);
				}
			}
			const prev = out.get(rec.sessionId);
			// Several live processes on one session (e.g. an orphan left mid-turn by a closed tab, plus
			// the window that reopened it): trust the freshest heartbeat, not a stale "working".
			if (!prev || rec.updated > prev.updated) out.set(rec.sessionId, rec);
		} catch {
			// ignore
		}
	}
	return out;
}

// ───────────────────────────── session tail parsing ─────────────────────────────

type TailStatus = "your-turn" | "error" | "aborted" | "stalled" | "empty";

interface TailInfo {
	status: TailStatus;
	lastText: string;
	lastRole?: string;
	/** Latest conversational message: the user's prompt or the agent's final (non-tool-call) reply, whichever is newer. */
	lastSaid?: { role: "user" | "assistant"; text: string };
}

const tailCache = new Map<string, { mtimeMs: number; size: number; info: TailInfo }>();

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

function readTail(file: string): TailInfo {
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return { status: "empty", lastText: "" };
	}
	const cached = tailCache.get(file);
	if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info;

	let info: TailInfo = { status: "empty", lastText: "" };
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		let chunk = 128 * 1024;
		for (;;) {
			const len = Math.min(st.size, chunk);
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, st.size - len);
			const lines = buf.toString("utf-8").split("\n");
			if (len < st.size) lines.shift(); // first line is probably partial

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
				if (!m || !["user", "assistant", "toolResult"].includes(m.role)) continue;
				if (!lastMsg) lastMsg = m;
				if (m.role === "assistant") {
					const t = messageText(m.content).trim();
					if (t) {
						lastAssistantText ??= t;
						// interim text alongside tool calls doesn't count as "what the agent said"
						if (!lastSaid && m.stopReason !== "toolUse") lastSaid = { role: "assistant", text: t };
					}
				} else if (m.role === "user" && !lastSaid) {
					const t = messageText(m.content).trim();
					if (t) lastSaid = { role: "user", text: t };
				}
				if (lastAssistantText !== undefined && lastSaid) break;
			}

			if (lastMsg && ((lastAssistantText !== undefined && lastSaid) || len >= st.size)) {
				let status: TailStatus;
				if (lastMsg.role === "assistant") {
					const r = lastMsg.stopReason;
					status = r === "error" ? "error" : r === "aborted" ? "aborted" : r === "toolUse" ? "stalled" : "your-turn";
				} else {
					status = "stalled";
				}
				info = { status, lastText: lastAssistantText ?? "", lastRole: lastMsg.role, lastSaid };
				break;
			}
			if (len >= st.size) break;
			chunk *= 4;
		}
	} catch {
		// unreadable → empty
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	tailCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
	return info;
}

// ───────────────────────────── row model ─────────────────────────────

interface Row {
	info: SessionInfo;
	meta: SessionMeta;
	tail: TailInfo;
	/** Live indicator: open in some Pi process or run by a background agent. */
	live?: LiveRecord;
	isCurrent: boolean;
	/** True when this window runs the session interactively (sticky takeover). */
	takenOver: boolean;
	title: string;
	searchText: string;
	/** First filter rule matching this session (it may still be shown if overridden with `x`). */
	rule?: string;
	/** True when the session belongs in the Filtered tab. */
	filtered: boolean;
	/** Background agent run by this pi, if any. */
	bg?: BgAgent;
	/** Needs your attention and you haven't looked since (see isUnread). */
	unread?: boolean;
}

async function loadRows(currentId: string | undefined): Promise<Row[]> {
	const [infos, store, live, filters] = [await SessionManager.listAll(), loadStore(), readLive(), loadFilters()];
	const rows: Row[] = [];
	for (const info of infos) {
		const isCurrent = info.id === currentId;
		if (info.messageCount === 0 && !isCurrent) continue;
		const title = info.name || cleanTitle(info.firstMessage) || "(no messages)";
		const meta = store.sessions[info.id] ?? {};
		const rule = matchRule(info, filters);
		rows.push({
			info,
			meta,
			rule,
			filtered: isFiltered(meta, rule),
			tail: readTail(info.path),
			live: live.get(info.id),
			isCurrent,
			takenOver: modeState().takenOver.has(info.id),
			title,
			searchText: `${info.name ?? ""}\n${info.cwd}\n${info.allMessagesText}`.toLowerCase(),
			bg: getAgent(info.id),
		});
	}
	// Background agents whose session file isn't written (or listed) yet.
	const seen = new Set(rows.map((r) => r.info.id));
	for (const a of listAgents()) {
		if (seen.has(a.id)) continue;
		const now = new Date(a.updatedAt);
		const info = {
			path: a.sessionFile ?? "",
			id: a.id,
			cwd: a.cwd,
			created: new Date(a.createdAt),
			modified: now,
			messageCount: 0,
			firstMessage: a.title,
			allMessagesText: a.title,
		} as unknown as SessionInfo;
		rows.push({
			info,
			meta: store.sessions[a.id] ?? {},
			filtered: false,
			tail: { status: "empty", lastText: a.lastText ?? "", lastSaid: { role: "user", text: a.title } },
			live: live.get(a.id),
			isCurrent: a.id === currentId,
			takenOver: modeState().takenOver.has(a.id),
			title: a.title,
			searchText: `${a.title}\n${a.cwd}`.toLowerCase(),
			bg: a,
		});
	}
	const since = unreadBaseline(store);
	for (const r of rows) r.unread = isUnread(r, since);
	return rows;
}

/**
 * Needs your attention and you haven't looked since: it finished (your turn) or failed after you last
 * saw it. Running sessions and the one you're in are never unread — except a manual mark (`u`).
 */
function isUnread(r: Row, since: number): boolean {
	// The session you're in: unread only when you marked it so by hand (`u`) — it shows as a blue `»`.
	if (r.isCurrent) return !!(r.meta.unreadAt && r.meta.unreadAt > (r.meta.seenAt ?? 0));
	// marked unread by hand (`u`) and not looked at since: show it even while running
	if (r.meta.unreadAt && r.meta.unreadAt > (r.meta.seenAt ?? 0)) return true;
	if (isRunning(r.bg) || r.live?.state === "working") return false;
	if (r.bg?.needsYou) return true;
	const needsYou = r.bg?.state === "error" || r.tail.status === "your-turn" || r.tail.status === "error";
	return needsYou && r.info.modified.getTime() > Math.max(r.meta.seenAt ?? 0, since);
}

// ───────────────────────────── formatting helpers ─────────────────────────────

/**
 * One-line display text for a prompt (titles + the "latest" column):
 * - drops skills invoked at the start of the line: expanded `<skill name="x">…</skill>` blocks
 *   (from `/skill:x` and from inline-skills' prepended block) and raw `/skill:x` / `/x` prefixes
 * - keeps inline `$skill` mentions in place, highlighted as `⚡skill`
 * - collapses whitespace. A prompt that was only a skill invocation falls back to `⚡x`.
 */
function cleanTitle(s: string): string {
	let t = s ?? "";
	const names: string[] = [];
	for (;;) {
		const m = t.match(/^\s*<skill\s+name="([^"]+)"/);
		if (!m) break;
		names.push(...m[1]!.split(/,\s*/));
		const close = t.indexOf("</skill>");
		t = close >= 0 ? t.slice(close + 8) : "";
	}
	// raw (unexpanded) `/skill:x` prefix, e.g. a spawned agent's title taken from what was typed
	const slash = t.match(/^\s*\/skill:([\w.-]+)/i);
	if (slash) {
		names.push(slash[1]!);
		t = t.slice(slash[0].length);
	}
	t = t.replace(/(^|[\s(\[{"'`,;:])\$([a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*)/g, "$1⚡$2");
	t = t.replace(/\s+/g, " ").trim();
	return t || (names.length ? names.map((n) => `⚡${n}`).join(" ") : "");
}

/** The last meaningful line of an agent reply, stripped of markdown noise, for the list's "latest" column. */
function latestLine(s: string): string {
	const lines = (s ?? "").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!
			.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "")
			.replace(/[*_`]+/g, "")
			.replace(/^\|?[\s|:-]*\|?$/, "") // table separator rows / fences
			.replace(/\s+/g, " ")
			.trim();
		if (l && !/^```/.test(lines[i]!.trim())) return l;
	}
	return "";
}

/** Why a filtered row is filtered, for display. */
function filterReason(r: Row): string {
	return r.meta.filter === "hide" ? "hidden manually" : (r.rule ?? "?");
}

/** Markdown report for `/inbox filters`: rule file, active rules with hit counts, overrides, errors. */
function filtersReport(rows: Row[]): string {
	const set = loadFilters();
	const hits = new Map<string, number>();
	let manual = 0;
	let kept = 0;
	for (const r of rows) {
		if (r.rule && r.meta.filter === "show") kept++;
		if (!r.filtered) continue;
		if (r.meta.filter === "hide") manual++;
		else if (r.rule) hits.set(r.rule, (hits.get(r.rule) ?? 0) + 1);
	}
	const cell = (s: string) => s.replace(/\|/g, "\\|");
	const out = ["# Inbox filters", "", `Rules file: \`${FILTERS_PATH}\`${fs.existsSync(FILTERS_PATH) ? "" : " (not created yet)"}`, ""];
	if (set.rules.length === 0) out.push("No active rules.", "");
	else {
		out.push("| Rule | Conditions (all must match) | Hidden now |", "|---|---|---|");
		for (const { rule } of set.rules) {
			const conds: string[] = [];
			for (const k of REGEX_KEYS) if (rule[k] !== undefined) conds.push(`${k} ~ \`${cell(String(rule[k]))}\``);
			if (rule.minMessages !== undefined) conds.push(`messages ≥ ${rule.minMessages}`);
			if (rule.maxMessages !== undefined) conds.push(`messages ≤ ${rule.maxMessages}`);
			const flags = rule.flags ? ` (flags \`${rule.flags}\`)` : "";
			out.push(`| ${cell(rule.name)} | ${conds.join(" and ")}${flags} | ${hits.get(rule.name) ?? 0} |`);
		}
		out.push("");
	}
	out.push(`Hidden manually with \`x\`: ${manual} · Kept despite a rule (\`x\`): ${kept}`, "");
	if (set.errors.length) out.push("## ⚠ Rule errors", "", ...set.errors.map((e) => `- ${e}`), "");
	out.push("Rule format: `/inbox help` → Filters.");
	return out.join("\n");
}

function ago(d: Date | number): string {
	const r = relTime(d);
	return r === "now" ? "just now" : `${r} ago`;
}

/** No live record but the file was written very recently → probably running in a Pi without this extension loaded. */
const RECENT_WRITE_MS = 90_000;

function relTime(d: Date | number): string {
	const ms = Date.now() - (typeof d === "number" ? d : d.getTime());
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return "now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	const dd = Math.round(h / 24);
	if (dd < 30) return `${dd}d`;
	return `${Math.round(dd / 30)}mo`;
}

function shortCwd(cwd: string): string {
	if (!cwd) return "?";
	const home = os.homedir();
	let p = cwd === home ? "~" : cwd.startsWith(home + path.sep) ? `~/${cwd.slice(home.length + 1)}` : cwd;
	const parts = p.split("/");
	if (parts.length > 3) p = `…/${parts.slice(-2).join("/")}`;
	return p;
}

function fit(s: string, w: number): string {
	if (w <= 0) return "";
	const t = truncateToWidth(s, w, "…");
	return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}

function printable(data: string): string | undefined {
	const k = decodeKittyPrintable(data);
	if (k) return k;
	if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127) return data;
	return undefined;
}

// ───────────────────────────── UI component ─────────────────────────────

type View = "inbox" | "archived" | "all" | "filtered";
const VIEWS: View[] = ["inbox", "archived", "all", "filtered"];

interface UIState {
	view: View;
	query: string;
	selectedId?: string;
}

type InboxResult =
	| { action: "close" }
	| { action: "open"; row: Row; takeover?: boolean }
	| { action: "view"; row: Row }
	| { action: "new"; pickModel: boolean }
	| { action: "cancel"; row: Row }
	| { action: "queue"; row: Row }
	| { action: "movedir"; row: Row }
	| { action: "home" }
	| { action: "exitMode" }
	| { action: "quit" }
	| { action: "help" };

class InboxComponent {
	private rows: Row[];
	private visible: Row[] = [];
	private display: Array<{ kind: "header"; label: string } | { kind: "item"; row: Row; idx: number }> = [];
	private selected = 0;
	private scroll = 0;
	private searching = false;
	/** Inline rename of the selected row (edited in place, no trip to pi's chat view). */
	/** `replace`: the original name is shown but the first typed char wipes it; cleared once you move the cursor. */
	private renaming?: { id: string; input: Input; replace: boolean };
	private loading = false;
	private timer?: ReturnType<typeof setInterval>;
	private flash?: { text: string; until: number };
	private quitArmed = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private kb: KeybindingsManager,
		private done: (r: InboxResult) => void,
		private state: UIState,
		private currentId: string | undefined,
		initialRows: Row[],
		private onRows: (rows: Row[]) => void,
		/** Orchestrator: true when this window sits on home (nothing taken over). */
		private atHome = false,
		/** Persists a new session name; throws on failure. */
		private onRename?: (row: Row, name: string) => void,
	) {
		this.rows = initialRows;
		this.rebuild();
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 2500);
	}

	dispose() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate() {}

	private async refresh() {
		if (this.loading) return;
		this.loading = true;
		try {
			this.rows = await loadRows(this.currentId);
			this.onRows(this.rows);
			this.rebuild();
			this.tui.requestRender();
		} catch (e) {
			this.say(`refresh failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.loading = false;
		}
	}

	private say(text: string) {
		this.flash = { text, until: Date.now() + 2500 };
		this.tui.requestRender();
	}

	private counts() {
		let inbox = 0;
		let archived = 0;
		let filtered = 0;
		for (const r of this.rows) {
			if (r.filtered) filtered++;
			else if (r.meta.archivedAt) archived++;
			else inbox++;
		}
		return { inbox, archived, all: inbox + archived, filtered };
	}

	private rebuild() {
		const terms = this.state.query.toLowerCase().split(/\s+/).filter(Boolean);
		const match = (r: Row) => terms.every((t) => r.searchText.includes(t) || r.title.toLowerCase().includes(t));
		const byModified = (a: Row, b: Row) => b.info.modified.getTime() - a.info.modified.getTime();

		this.display = [];
		const push = (label: string | undefined, list: Row[]) => {
			if (list.length === 0) return;
			if (label) this.display.push({ kind: "header", label });
			for (const row of list) this.display.push({ kind: "item", row, idx: 0 });
		};

		const matched = this.rows.filter(match);
		// Filtered-out sessions appear only in their own tab, never in Inbox / Archived / All.
		const shown = matched.filter((r) => !r.filtered);
		if (this.state.view === "inbox") {
			// Just PINNED and INBOX: background agents sit in place; status + unread dot flag them.
			const live = shown.filter((r) => !r.meta.archivedAt);
			const pinned = live.filter((r) => r.meta.pinnedAt).sort((a, b) => (b.meta.pinnedAt ?? 0) - (a.meta.pinnedAt ?? 0));
			const rest = live.filter((r) => !r.meta.pinnedAt).sort(byModified);
			const sectioned = pinned.length > 0;
			push(pinned.length ? `★ PINNED (${pinned.length})` : undefined, pinned);
			push(sectioned ? `INBOX (${rest.length})` : undefined, rest);
		} else if (this.state.view === "archived") {
			push(undefined, shown.filter((r) => r.meta.archivedAt).sort((a, b) => (b.meta.archivedAt ?? 0) - (a.meta.archivedAt ?? 0)));
		} else if (this.state.view === "filtered") {
			const errors = loadFilters().errors.length;
			const list = matched.filter((r) => r.filtered).sort(byModified);
			if (errors && list.length) this.display.push({ kind: "header", label: `⚠ ${errors} filter rule error(s), see /inbox filters` });
			push(undefined, list);
		} else {
			push(undefined, shown.sort(byModified));
		}

		this.visible = [];
		for (const d of this.display) {
			if (d.kind === "item") {
				d.idx = this.visible.length;
				this.visible.push(d.row);
			}
		}

		// keep selection pinned to the same session id when possible
		const keepIdx = this.state.selectedId ? this.visible.findIndex((r) => r.info.id === this.state.selectedId) : -1;
		if (keepIdx >= 0) this.selected = keepIdx;
		this.selected = Math.max(0, Math.min(this.selected, this.visible.length - 1));
		this.state.selectedId = this.visible[this.selected]?.info.id;
	}

	private move(delta: number) {
		if (this.visible.length === 0) return;
		this.selected = Math.max(0, Math.min(this.visible.length - 1, this.selected + delta));
		this.state.selectedId = this.visible[this.selected]?.info.id;
	}

	private setView(v: View) {
		this.state.view = v;
		this.state.selectedId = undefined;
		this.selected = 0;
		this.scroll = 0;
		this.rebuild();
	}

	private togglePin(row: Row) {
		const meta = updateMeta(row.info.id, (m) => {
			m.pinnedAt = m.pinnedAt ? undefined : Date.now();
		});
		row.meta = meta;
		this.say(meta.pinnedAt ? "★ pinned" : "unpinned");
		this.rebuild();
	}

	/** Mark read (clear the dot, like opening it) or unread (a reminder dot until you next look). */
	private toggleUnread(row: Row) {
		const wasUnread = !!row.unread;
		try {
			if (wasUnread) markRead(row.info.id);
			else
				updateMeta(row.info.id, (m) => {
					m.unreadAt = Date.now();
				});
		} catch {
			return this.say("couldn't write ~/.pi/agent/inbox.json");
		}
		const store = loadStore();
		row.meta = store.sessions[row.info.id] ?? {};
		row.unread = isUnread(row, unreadBaseline(store));
		this.say(row.unread ? (row.isCurrent ? "» marked unread — clears when you open it again or switch away" : "• marked unread") : "marked read");
		this.rebuild();
	}

	private toggleArchive(row: Row) {
		// move selection to the neighbour so the list doesn't jump
		const next = this.visible[this.selected + 1] ?? this.visible[this.selected - 1];
		const meta = updateMeta(row.info.id, (m) => {
			m.archivedAt = m.archivedAt ? undefined : Date.now();
		});
		row.meta = meta;
		if (this.state.view !== "all") this.state.selectedId = next?.info.id;
		this.say(meta.archivedAt ? "✓ archived" : "↩ moved back to inbox");
		this.rebuild();
	}

	/** Flip a session in or out of the Filtered tab, overriding the rules when one matches. */
	private toggleFilter(row: Row) {
		// the row always changes tab, so move selection to the neighbour
		const next = this.visible[this.selected + 1] ?? this.visible[this.selected - 1];
		const meta = updateMeta(row.info.id, (m) => {
			if (row.filtered) m.filter = row.rule ? "show" : undefined;
			else m.filter = row.rule ? undefined : "hide";
		});
		row.meta = meta;
		row.filtered = isFiltered(meta, row.rule);
		this.state.selectedId = next?.info.id;
		this.say(row.filtered ? "⊘ filtered out (see the Filtered tab)" : row.rule ? `✓ kept despite rule "${row.rule}"` : "↩ back in the inbox");
		this.rebuild();
	}

	/**
	 * Cursor at the start, original name still shown; the first typed char replaces the whole name.
	 * Moving the cursor first (arrows, home/end, …) keeps the name and edits it in place.
	 */
	private startRename(row: Row) {
		const input = new Input({ prompt: this.theme.fg("accent", "✎ ") });
		input.setValue(row.info.name || cleanTitle(row.title).slice(0, 60)); // a fresh Input's cursor sits at 0
		const id = row.info.id;
		input.onEscape = () => {
			this.renaming = undefined;
			this.say("rename cancelled");
		};
		input.onSubmit = (value) => {
			this.renaming = undefined;
			const next = value.trim();
			const target = this.rows.find((r) => r.info.id === id) ?? row;
			if (!next || next === target.info.name) return this.say("name unchanged");
			try {
				this.onRename?.(target, next);
			} catch (e) {
				return this.say(`rename failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			target.info.name = next;
			target.title = next;
			this.say("✎ renamed");
			this.rebuild();
			void this.refresh();
		};
		this.renaming = { id, input, replace: true };
	}

	private renameInput(data: string) {
		const r = this.renaming!;
		// Plain enter always saves here: Input only submits on tui.input.submit, which users may
		// rebind away from enter (e.g. enter = newline in the main editor).
		if (matchesKey(data, "enter") || data === "\n" || this.kb.matches(data, "tui.input.submit")) {
			r.input.onSubmit?.(r.input.getValue());
			return;
		}
		if (r.replace && !matchesKey(data, "escape")) {
			r.replace = false;
			const typing = printable(data) !== undefined || data.includes("\x1b[200~");
			const deleting = matchesKey(data, "backspace") || matchesKey(data, "delete");
			if (typing || deleting) r.input.setValue("");
			if (deleting) return;
			// any other key (arrows, home/end, …) just keeps the name and edits it in place
		}
		r.input.handleInput(data);
	}

	handleInput(data: string): void {
		const kb = this.kb;

		if (this.renaming) {
			this.renameInput(data);
			this.tui.requestRender();
			return;
		}

		if (this.searching) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.searching = false;
				this.state.query = "";
				this.rebuild();
			} else if (kb.matches(data, "tui.select.confirm")) {
				this.searching = false;
			} else if (matchesKey(data, "backspace")) {
				this.state.query = this.state.query.slice(0, -1);
				this.rebuild();
			} else if (kb.matches(data, "tui.select.up")) this.move(-1);
			else if (kb.matches(data, "tui.select.down")) this.move(1);
			else {
				const ch = printable(data);
				if (ch) {
					this.state.query += ch;
					this.selected = 0;
					this.state.selectedId = undefined;
					this.rebuild();
				}
			}
			this.tui.requestRender();
			return;
		}

		const row = this.visible[this.selected];
		const ch = printable(data);

		if (kb.matches(data, "tui.select.up") || ch === "k") this.move(-1);
		else if (kb.matches(data, "tui.select.down") || ch === "j") this.move(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.move(-this.listHeight());
		else if (kb.matches(data, "tui.select.pageDown")) this.move(this.listHeight());
		else if (matchesKey(data, "home") || ch === "g") this.move(-1e9);
		else if (matchesKey(data, "end") || ch === "G") this.move(1e9);
		else if (kb.matches(data, "tui.select.confirm")) {
			// Orchestrator: enter takes the session over full-screen (no preview).
			if (row) this.done(orchestrating() ? { action: "open", row } : { action: "view", row });
		} else if (ch === "v" && orchestrating()) {
			if (row) this.done({ action: "view", row });
		} else if (ch === "t" && orchestrating()) {
			if (row) this.done({ action: "open", row, takeover: true });
		} else if (ch === "o") {
			if (row) this.done({ action: "open", row });
		} else if (ch === "Q" && orchestrating()) {
			this.done({ action: "exitMode" });
		} else if (ch === "h") {
			if (!orchestrating()) this.say("h = hand back, in orchestrator mode only (/orchestrator)");
			else if (this.atHome) this.say("already home · enter on a session takes it over");
			else this.done({ action: "home" });
		} else if (ch === "n" || ch === "N") {
			this.done({ action: "new", pickModel: ch === "N" });
		} else if (ch === "c") {
			if (row && isRunning(row.bg)) this.done({ action: "cancel", row });
			else this.say("not a running background agent");
		} else if (ch === "m") {
			if (row?.bg?.pending.length) {
				this.done({ action: "queue", row });
			} else {
				this.say("that agent has no queued messages");
			}
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || ch === "q") {
			if (this.state.query) {
				this.state.query = "";
				this.rebuild();
			} else if (orchestrating() && this.atHome) {
				if (matchesKey(data, "ctrl+c")) {
					if (this.quitArmed && Date.now() - this.quitArmed < 2000) return this.done({ action: "quit" });
					this.quitArmed = Date.now();
					this.say("press ctrl+c again to quit pi (stops all background agents)");
				} else this.say("this window is the orchestrator · Q leaves orchestrator mode · ctrl+c twice quits");
			} else this.done({ action: "close" });
		} else if (matchesKey(data, "tab")) this.setView(VIEWS[(VIEWS.indexOf(this.state.view) + 1) % VIEWS.length]!);
		else if (matchesKey(data, "shift+tab"))
			this.setView(VIEWS[(VIEWS.indexOf(this.state.view) + VIEWS.length - 1) % VIEWS.length]!);
		else if (ch === "1") this.setView("inbox");
		else if (ch === "2") this.setView("archived");
		else if (ch === "3") this.setView("all");
		else if (ch === "4") this.setView("filtered");
		else if (ch === "/") {
			this.searching = true;
		} else if (ch === "p" || ch === "*") {
			if (row) this.togglePin(row);
		} else if (ch === "a") {
			if (row) this.toggleArchive(row);
		} else if (ch === "x") {
			if (row) this.toggleFilter(row);
		} else if (ch === "u") {
			if (row) this.toggleUnread(row);
		} else if (ch === "r") {
			if (row) this.startRename(row);
		} else if (ch === "d") {
			// "d" = move to another directory (was a third archive spelling; D is gone).
			if (row && !isRunning(row.bg) && orchestrating()) this.done({ action: "movedir", row });
			else if (row && !isRunning(row.bg)) this.say("moving a session's directory is an orchestrator-mode action");
			else if (row) this.say("wait for the agent to finish (or cancel it with c) before moving it");
		} else if (ch === "?") {
			this.done({ action: "help" });
		} else if (ch === "R" || matchesKey(data, "ctrl+r")) {
			this.say("refreshing…");
			void this.refresh();
		}
		this.tui.requestRender();
	}

	private height(): number {
		const rows = this.tui.terminal?.rows ?? 30;
		// Orchestrator: the inbox is the whole screen, so pi's chat view never shows underneath.
		return orchestrating() ? Math.max(14, rows) : Math.max(14, Math.floor(rows * 0.9));
	}

	private listHeight(): number {
		// border(1) tabs(1) sep(1) | list | sep(1) preview(3) sep(1) help(1) border(1)
		return Math.max(3, this.height() - 10);
	}

	/** Latest-line column: the user's latest prompt or the agent's final reply, whichever is newer (no tool calls / thinking). */
	private latestCell(r: Row): string {
		const th = this.theme;
		const said = r.tail.lastSaid;
		if (!said) return "";
		if (said.role === "user") {
			const l = cleanTitle(said.text);
			return l ? th.fg("accent", "you › ") + th.fg("text", l) : "";
		}
		const l = latestLine(said.text);
		return l ? th.fg("accent", "↳ ") + th.fg("text", l) : "";
	}

	private statusCell(r: Row): string {
		const th = this.theme;
		if (r.bg?.state === "working") return th.fg("warning", "● working");
		if (r.bg?.state === "queued") return th.fg("warning", "● queued");
		if (r.bg?.state === "error") return th.fg("error", "✗ error");
		if (r.bg?.state === "cancelled") return th.fg("muted", "⏸ cancelled");
		if (r.live?.state === "working") return th.fg("warning", "● working");
		if (r.tail.status === "stalled" && !r.live && Date.now() - r.info.modified.getTime() < RECENT_WRITE_MS)
			return th.fg("warning", "● working?");
		switch (r.tail.status) {
			case "your-turn":
				return th.fg("accent", "◆ your turn");
			case "error":
				return th.fg("error", "✗ error");
			case "aborted":
				return th.fg("muted", "⏸ aborted");
			case "stalled":
				return th.fg("warning", "⚠ stalled");
			default:
				return th.fg("dim", "· empty");
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const b = (s: string) => th.fg("borderMuted", s);
		const line = (content: string) => b("│") + fit(content, innerW) + b("│");
		const sep = () => b(`├${"─".repeat(innerW)}┤`);
		const out: string[] = [];

		// top border with title
		const summary = orchestrating() ? agentsSummary() : undefined;
		const title = ` ${th.bold(th.fg("accent", orchestrating() ? "📥 Pi Inbox · orchestrator" : "📥 Pi Inbox"))}${summary ? th.fg("dim", `  ${summary}`) : ""} `;
		const spin = this.loading ? th.fg("dim", " ⟳ ") : "";
		out.push(b("╭─") + title + spin + b("─".repeat(Math.max(0, innerW - 1 - visibleWidth(title) - visibleWidth(spin)))) + b("╮"));

		// tabs + search
		const c = this.counts();
		const tab = (v: View, label: string, n: number) => {
			const t = ` ${label} ${n} `;
			return this.state.view === v ? th.bg("selectedBg", th.bold(th.fg("accent", t))) : th.fg("muted", t);
		};
		let tabs = ` ${tab("inbox", "Inbox", c.inbox)} ${tab("archived", "Archived", c.archived)} ${tab("all", "All", c.all)} ${tab("filtered", "Filtered", c.filtered)}`;
		const q = this.searching
			? `${th.fg("accent", "/")}${this.state.query}${th.fg("accent", "▏")}`
			: this.state.query
				? `${th.fg("muted", "filter:")} ${th.fg("text", this.state.query)}`
				: th.fg("dim", "/ to search");
		const gap = innerW - visibleWidth(tabs) - visibleWidth(q) - 1;
		tabs = gap > 1 ? tabs + " ".repeat(gap) + q : `${tabs}  ${q}`;
		out.push(line(tabs));
		out.push(sep());

		// list
		const LH = this.listHeight();
		const selDisplayIdx = this.display.findIndex((d) => d.kind === "item" && d.idx === this.selected);
		if (selDisplayIdx >= 0) {
			// show the section header above the first item when scrolled to top
			const target = selDisplayIdx > 0 && this.display[selDisplayIdx - 1]?.kind === "header" ? selDisplayIdx - 1 : selDisplayIdx;
			if (target < this.scroll) this.scroll = target;
			if (selDisplayIdx >= this.scroll + LH) this.scroll = selDisplayIdx - LH + 1;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.display.length - LH)));

		// columns
		const wStatus = 12;
		// The ⚑ slot only exists while takeover is possible (orchestrator mode).
		const wTake = orchestrating() ? 2 : 0;
		const wProj = Math.min(22, Math.max(10, Math.floor(innerW * 0.18)));
		const wAge = 5;
		const wMsgs = 5;
		const wFixed =
			2 +
			2 +
			2 +
			wTake +
			wStatus +
			1 +
			wProj +
			1 +
			wAge +
			1 +
			wMsgs +
			1;
		const wText = Math.max(10, innerW - wFixed);
		// split the text area into first message (title) + latest reply line, when there's room
		const wLast = wText >= 60 ? Math.floor(wText * 0.5) : 0;
		const wTitle = wLast ? wText - wLast - 1 : wText;

		if (this.visible.length === 0) {
			const ruleErrors = loadFilters().errors.length;
			const empty = this.state.query
				? "No sessions match the search."
				: this.state.view === "archived"
					? "Nothing archived yet. Press  a  on a session in the Inbox to archive it."
					: this.state.view === "filtered"
						? `Nothing filtered out. Add rules to ~/.pi/agent/inbox-filters.json, or press  x  on a session.${ruleErrors ? `  ⚠ ${ruleErrors} rule error(s): /inbox filters` : ""}`
						: "Inbox zero 🎉";
			out.push(line(""));
			out.push(line(`   ${th.fg("dim", empty)}`));
			for (let i = 2; i < LH; i++) out.push(line(""));
		} else {
			for (let i = 0; i < LH; i++) {
				const d = this.display[this.scroll + i];
				if (!d) {
					out.push(line(""));
					continue;
				}
				if (d.kind === "header") {
					out.push(line(` ${th.fg("muted", th.bold(d.label))}`));
					continue;
				}
				const r = d.row;
				const sel = d.idx === this.selected;
				const cursor = sel ? th.fg("accent", "▶ ") : "  ";
				const pin = r.meta.pinnedAt ? th.fg("warning", "★ ") : "  ";
				// ⚑ marks the session this window runs interactively (sticky takeover) —
				// independent of which row is the current one (`»`). Orchestrator-only:
				// the slot disappears with the mode so non-orchestrator layout is unchanged.
				const takeoverDot =
					orchestrating() && r.takenOver ? th.fg("warning", "⚑ ") : "  ";
				const liveDot = r.isCurrent || r.live || r.bg ? th.fg("success", "◉ ") : "  ";
				// fixed 2-col slot before the title so titles stay aligned whether or not a row is unread,
				// shared with the current-session marker: gold `»` (warning) is the session you're in and
				// it's read; blue `»` (mdLink) is the session you're in but you marked it unread by hand.
				const unread =
					r.unread && r.isCurrent
						? th.fg("mdLink", "» ")
						: r.unread
							? th.fg("accent", "• ")
							: r.isCurrent
								? th.fg("warning", "» ")
								: "  ";
				const titleColor = r.meta.archivedAt && this.state.view === "all" ? "dim" : "text";
				let t = r.info.name ? th.bold(th.fg(titleColor, r.title)) : th.fg(titleColor, r.title);
				// lead with the reason so a long title can't truncate it away
				if (this.state.view === "filtered") t = th.fg("warning", `⊘ ${filterReason(r)}`) + th.fg("dim", " · ") + t;
				t = unread + t;
				if (r.meta.archivedAt && this.state.view === "all") t += th.fg("dim", " [archived]");
				if (r.rule && r.meta.filter === "show" && this.state.view !== "filtered") t += th.fg("dim", " [kept]");
				const age = this.state.view === "archived" && r.meta.archivedAt ? relTime(r.meta.archivedAt) : relTime(r.info.modified);
				const editing = this.renaming && this.renaming.id === r.info.id ? this.renaming.input : undefined;
				const textCells = editing
					? fit(editing.render(wText)[0] ?? "", wText)
					: fit(t, wTitle) + (wLast ? " " + fit(this.latestCell(r), wLast) : "");
				let content =
					cursor +
					pin +
					takeoverDot +
					liveDot +
					fit(this.statusCell(r), wStatus) +
					" " +
					textCells +
					" " +
					fit(th.fg("muted", shortCwd(r.info.cwd)), wProj) +
					" " +
					th.fg("dim", fit(age.padStart(wAge), wAge)) +
					" " +
					th.fg("dim", fit(String(r.info.messageCount).padStart(wMsgs), wMsgs));
				content = fit(content, innerW);
				out.push(line(sel ? th.bg("selectedBg", content) : content));
			}
		}

		// preview of selected session
		out.push(sep());
		const r = this.visible[this.selected];
		if (r) {
			const meta: string[] = [];
			meta.push(shortCwd(r.info.cwd));
			meta.push(`created ${ago(r.info.created)}`);
			meta.push(`updated ${ago(r.info.modified)}`);
			if (r.meta.pinnedAt) meta.push(`pinned ${ago(r.meta.pinnedAt)}`);
			if (r.meta.archivedAt) meta.push(`archived ${ago(r.meta.archivedAt)}`);
			if (r.filtered) meta.push(`filtered: ${filterReason(r)}`);
			else if (r.rule && r.meta.filter === "show") meta.push(`kept despite rule: ${r.rule}`);
			if (r.bg) {
				if (r.bg.activity && isRunning(r.bg)) meta.push(`▸ ${r.bg.activity}`);
				if (r.bg.pending.length) meta.push(`${r.bg.pending.length} queued`);
				if (r.bg.model && r.bg.runs <= 1) meta.push(r.bg.model);
				if (r.bg.state === "error" && r.bg.error) meta.push(`✗ ${r.bg.error}`);
			} else if (r.live?.bgParent) meta.push(`background agent of pid ${r.live.bgParent}`);
			else if (r.live && !r.isCurrent)
				meta.push(
					r.live.stuckMin
						? `pid ${r.live.pid} looks stuck (silent ${r.live.stuckMin}m; kill -9 ${r.live.pid})`
						: `open in pid ${r.live.pid}`,
				);
			const first = r.info.name ? `${th.fg("muted", "first:")} ${cleanTitle(r.info.firstMessage)}` : "";
			out.push(line(` ${th.fg("dim", meta.join(" · "))}`));
			out.push(line(` ${first ? th.fg("dim", first) : ""}`));
			const last = r.tail.lastText.replace(/\s+/g, " ").trim();
			out.push(line(` ${th.fg("muted", "last:")} ${th.fg("text", last || "—")}`));
		} else {
			out.push(line(""), line(""), line(""));
		}
		out.push(sep());

		// help / flash
		const flash = this.flash && this.flash.until > Date.now() ? this.flash.text : undefined;
		const k = (key: string, label: string) => `${th.fg("accent", key)} ${th.fg("dim", label)}`;
		const archLabel = this.state.view === "archived" ? "unarchive" : r?.meta.archivedAt ? "unarchive" : "archive";
		const help = this.renaming
			? [
					k("type", this.renaming.replace ? "to replace" : "to edit"),
					...(this.renaming.replace ? [k("←→", "edit instead")] : []),
					k("enter", "save"),
					k("esc", "cancel"),
				].join(th.fg("dim", " · "))
			: this.searching
			? [k("type", "to filter"), k("enter", "keep"), k("esc", "clear")].join(th.fg("dim", " · "))
			: orchestrating()
			? [
					k("↑↓", "move"),
					k("enter", "open"),
					k("t", "take over"),
					k("n", "new agent"),
					k("N", "new (pick model)"),
					k("v", "peek"),
					...(isRunning(r?.bg) ? [k("c", "cancel")] : []),
					...(r?.bg?.pending.length ? [k("m", "manage queue")] : []),
					...(r && !isRunning(r?.bg) ? [k("d", "move dir")] : []),
					...(this.atHome ? [] : [k("h", "hand back"), k("esc", "back to session")]),
					k("p", r?.meta.pinnedAt ? "unpin" : "pin"),
					k("a", archLabel),
					k("u", r?.unread ? "mark read" : "mark unread"),
					k("x", r?.filtered ? "unfilter" : "filter"),
					k("tab", "view"),
					k("/", "search"),
					k("r", "rename"),
					k("?", "help"),
					k("Q", "leave orchestrator"),
				].join(th.fg("dim", " · "))
				: [
						k("↑↓", "move"),
						k("enter", "view/reply"),
						k("o", "open here"),
						k("n", "new agent"),
						...(isRunning(r?.bg) ? [k("c", "cancel")] : []),
						...(r?.bg?.pending.length
							? [k("m", "manage queue")]
							: []),
						k("p", r?.meta.pinnedAt ? "unpin" : "pin"),
						k("a", archLabel),
						k("u", r?.unread ? "mark read" : "mark unread"),
						k("x", r?.filtered ? "unfilter" : "filter"),
						k("tab", "view"),
						k("/", "search"),
						k("r", "rename"),
						k("?", "help"),
						k("esc", "close"),
					].join(th.fg("dim", " · "));
		out.push(line(` ${flash ? th.fg("success", flash) : help}`));
		out.push(b(`╰${"─".repeat(innerW)}╯`));

		return out.map((l) => truncateToWidth(l, width));
	}
}

// ───────────────────────────── orchestrator: new-agent prompt ─────────────────────────────

/**
 * Full-screen prompt for a new background agent (or a reply to one), used in orchestrator mode so the
 * orchestrator never drops back to pi's chat view. Uses pi-tui's Editor, so the submit /
 * newline keys follow ~/.pi/agent/keybindings.json like the main editor.
 */
class NewAgentPromptComponent implements Focusable {
	private editor: Editor;
	private _focused = false;
	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.editor.focused = v;
	}

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (text: string | undefined) => void,
		private info: { heading: string; detail: string; action: string },
	) {
		this.editor = new Editor(tui, { borderColor: (t: string) => theme.fg("borderAccent", t), selectList: getSelectListTheme() }, { paddingX: 1 });
		this.editor.onSubmit = (text) => {
			if (text.trim()) this.done(text);
		};
	}

	invalidate() {
		this.editor.invalidate?.();
	}

	handleInput(data: string) {
		if (matchesKey(data, "escape")) return this.done(undefined);
		this.editor.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const b = (s: string) => th.fg("borderMuted", s);
		const line = (s: string) => b("│") + fit(s, innerW) + b("│");
		const rows = Math.max(14, this.tui.terminal?.rows ?? 30);
		const title = ` ${th.bold(th.fg("accent", `📥 Pi Inbox · orchestrator · ${this.info.heading}`))} `;
		const out = [b("╭─") + title + b("─".repeat(Math.max(0, innerW - 1 - visibleWidth(title)))) + b("╮")];
		out.push(line(` ${th.fg("dim", this.info.detail)}`));
		out.push(line(""));
		const kb = getKeybindings();
		const keys = (id: string, fallback: string) => {
			try {
				return (kb as any).getKeys(id)?.join("/") || fallback;
			} catch {
				return fallback;
			}
		};
		const help = [
			`${th.fg("accent", keys("tui.input.submit", "enter"))} ${th.fg("dim", this.info.action)}`,
			`${th.fg("accent", keys("tui.input.newLine", "shift+enter"))} ${th.fg("dim", "newline")}`,
			`${th.fg("accent", "esc")} ${th.fg("dim", "cancel")}`,
		].join(th.fg("dim", " · "));
		const ed = this.editor.render(Math.max(10, innerW - 2)).map((l) => line(` ${l}`));
		const bodyMax = Math.max(3, rows - 6);
		out.push(...ed.slice(-bodyMax));
		while (out.length < rows - 2) out.push(line(""));
		out.push(line(` ${help}`));
		out.push(b(`╰${"─".repeat(innerW)}╯`));
		return out.slice(0, rows).map((l) => truncateToWidth(l, width));
	}
}

// ───────────────────────────── directory picker overlay ─────────────────────────────

/**
 * Full-screen directory picker used in orchestrator mode (new agent's dir, or moving a session):
 * a single-line Input whose suggestions rebuild on every keystroke — what the typed text means so
 * far, its parent, home, child directories of the prefix (shell-like filtering on the
 * un-resolved remainder), and working dirs of other sessions matching the text.
 * ↑/↓ pick a suggestion, tab/enter accept it (enter on the input itself = accept as typed),
 * esc cancels. Focusable so the hardware cursor follows the Input.
 */
class DirPickerComponent implements Focusable {
	private input: Input;
	private _focused = false;
	private suggestions: DirSuggestion[] = [];
	private selected = 0;
	private scroll = 0;
	private error?: string;

	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.input.focused = v;
	}

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (dir: string | undefined) => void,
		private opts: { title: string; base: string; initial?: string; hint?: string },
	) {
		this.input = new Input({ prompt: theme.fg("accent", "📁 ") });
		this.input.setValue(prettyDir(opts.initial ?? opts.base));
		this.rebuild();
	}

	private rebuild() {
		this.suggestions = dirSuggestions(this.input.getValue(), this.opts.base);
		this.selected = 0;
		this.scroll = 0;
		this.error = undefined;
	}

	private accept(s: DirSuggestion) {
		this.done(s.value);
	}

	private acceptTyped() {
		const v = expandDir(this.input.getValue(), this.opts.base);
		if (!v) {
			this.error = "not a directory (try ↑↓ to pick a suggestion)";
			this.tui.requestRender();
			return;
		}
		this.done(v);
	}

	invalidate() {}

	handleInput(data: string) {
		if (matchesKey(data, "escape")) return this.done(undefined);
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			if (!this.suggestions.length) return;
			const d = matchesKey(data, "up") ? -1 : 1;
			this.selected = (this.selected + d + this.suggestions.length) % this.suggestions.length;
			this.moved = true;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			// An explicitly highlighted suggestion accepts that; enter on untouched input accepts as typed.
			if (this.moved && this.suggestions.length) this.accept(this.suggestions[this.selected]!);
			else this.acceptTyped();
			return;
		}
		if (matchesKey(data, "tab")) {
			const s = this.suggestions[this.selected] ?? this.suggestions[0];
			if (s) {
				// tab fills the suggestion into the input (like shell completion) instead of committing
				this.input.setValue(prettyDir(s.value));
				this.rebuild();
				this.tui.requestRender();
			}
			return;
		}
		this.moved = true;
		this.input.handleInput(data);
		this.rebuild();
		this.tui.requestRender();
	}
	private moved = false;

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(30, width - 2);
		const b = (s: string) => th.fg("borderMuted", s);
		const line = (s: string) => b("│") + fit(s, innerW) + b("│");
		const rows = Math.max(14, this.tui.terminal?.rows ?? 30);
		const title = ` ${th.bold(th.fg("accent", `📥 Pi Inbox · orchestrator · ${this.opts.title}`))} `;
		const out = [b("╭─") + title + b("─".repeat(Math.max(0, innerW - 1 - visibleWidth(title)))) + b("╮")];
		if (this.opts.hint) out.push(line(` ${th.fg("dim", this.opts.hint)}`));
		out.push(line(""));
		this.input.focused = this._focused;
		out.push(line(` ${this.input.render(Math.max(10, innerW - 2))[0] ?? ""}`));
		out.push(line(""));

		const LIST_H = Math.max(4, rows - 9);
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + LIST_H) this.scroll = this.selected - LIST_H + 1;
		if (!this.suggestions.length) out.push(line(` ${th.fg("dim", "(no suggestions — type a path)")}`));
		for (let i = 0; i < LIST_H; i++) {
			const s = this.suggestions[this.scroll + i];
			if (!s) {
				out.push(line(""));
				continue;
			}
			const sel = this.scroll + i === this.selected;
			const marker = sel ? th.fg("accent", "▶ ") : "  ";
			const hint = s.hint ? th.fg("dim", `  · ${s.hint}`) : "";
			let row = ` ${marker}${s.label}${hint}`;
			// file-browser feel: for child entries show the parent path dimly on the right
			if (s.kind === "child") {
				const parent = prettyDir(path.dirname(s.value));
				const used = visibleWidth(row);
				if (parent && used + visibleWidth(parent) + 2 < innerW)
					row += th.fg("dim", `  ${"·".repeat(Math.max(1, innerW - used - visibleWidth(parent) - 3))} ${parent}`);
			}
			out.push(line(sel ? th.bg("selectedBg", row) : row));
		}
		while (out.length < rows - 2) out.push(line(""));
		const k = (key: string, label: string) => `${th.fg("accent", key)} ${th.fg("dim", label)}`;
		const foot = this.error
			? th.fg("error", ` ✗ ${this.error}`)
			: [k("↑↓", "pick"), k("tab", "fill"), k("enter", "accept"), k("esc", "cancel"), k("typing", "filters the list")].join(th.fg("dim", " · "));
		out.push(line(` ${foot}`));
		out.push(b(`╰${"─".repeat(innerW)}╯`));
		return out.slice(0, rows).map((l) => truncateToWidth(l, width));
	}
}

/** Full-screen yes/no for orchestrator mode (ctx.ui.confirm would reveal pi's chat view). */
class ConfirmComponent {
	private yes = true;
	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (ok: boolean) => void,
		private title: string,
		private body: string,
	) {}
	invalidate() {}
	handleInput(data: string) {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "n") return this.done(false);
		if (data === "y") return this.done(true);
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || getKeybindings().matches(data, "tui.select.confirm"))
			return this.done(this.yes);
		if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab"))
			this.yes = !this.yes;
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const b = (s: string) => th.fg("borderMuted", s);
		const line = (s: string) => b("│") + fit(s, innerW) + b("│");
		const rows = Math.max(10, this.tui.terminal?.rows ?? 30);
		const title = ` ${th.bold(th.fg("accent", "📥 Pi Inbox · orchestrator"))} `;
		const out = [b("╭─") + title + b("─".repeat(Math.max(0, innerW - 1 - visibleWidth(title)))) + b("╮")];
		const body = [
			"",
			` ${th.bold(th.fg("warning", this.title))}`,
			"",
			...wrapTextWithAnsi(this.body, innerW - 2).map((l) => ` ${l}`),
			"",
			` ${this.yes ? th.fg("accent", "→ Yes") : "  Yes"}`,
			` ${this.yes ? "  No" : th.fg("accent", "→ No")}`,
		];
		const top = Math.max(0, Math.floor((rows - 3 - body.length) / 3));
		for (let i = 0; i < top; i++) out.push(line(""));
		out.push(...body.map(line));
		while (out.length < rows - 2) out.push(line(""));
		out.push(line(` ${th.fg("accent", "↑↓")} ${th.fg("dim", "choose")} · ${th.fg("accent", "enter")} ${th.fg("dim", "select")} · ${th.fg("accent", "y/n")} · ${th.fg("accent", "esc")} ${th.fg("dim", "no")}`));
		out.push(b(`╰${"─".repeat(innerW)}╯`));
		return out.slice(0, rows).map((l) => truncateToWidth(l, width));
	}
}

// ───────────────────────────── queued messages ─────────────────────────────

type QueueManagerResult =
	| { action: "close" }
	| {
			action: "send";
			message: string;
			interrupted: boolean;
		};

/** Pick, remove, or immediately deliver one background-agent message. */
class QueueManagerComponent {
	private selected = 0;
	private scroll = 0;
	private flash?: string;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (result: QueueManagerResult) => void,
		private id: string,
		private title: string,
	) {}

	invalidate() {}

	private messages(): string[] {
		return getAgent(this.id)?.pending ?? [];
	}

	private clamp() {
		this.selected = Math.max(
			0,
			Math.min(this.selected, this.messages().length - 1),
		);
	}

	handleInput(data: string) {
		const messages = this.messages();
		this.clamp();
		const ch = printable(data);
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			ch === "q"
		) {
			return this.done({ action: "close" });
		}
		if (matchesKey(data, "up") || ch === "k") {
			this.selected--;
			this.clamp();
		} else if (matchesKey(data, "down") || ch === "j") {
			this.selected++;
			this.clamp();
		} else if (
			matchesKey(data, "delete") ||
			matchesKey(data, "backspace") ||
			ch === "d"
		) {
			const message = messages[this.selected];
			if (!message) {
				this.flash = "nothing is queued";
			} else if (
				removeQueuedMessage(this.id, this.selected, message) === undefined
			) {
				this.flash = "the queue changed; try again";
			} else {
				this.flash = "removed from queue";
				this.clamp();
			}
		} else if (
			matchesKey(data, "enter") ||
			matchesKey(data, "return")
		) {
			const message = messages[this.selected];
			const result = message
				? sendQueuedMessageNow(this.id, this.selected, message)
				: undefined;
			if (!result) {
				this.flash = message
					? "the queue changed; try again"
					: "nothing is queued";
			} else {
				return this.done({
					action: "send",
					message: result.message,
					interrupted: result.interrupted,
				});
			}
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(30, width - 2);
		const b = (s: string) => th.fg("borderMuted", s);
		const line = (s: string) => b("│") + fit(s, innerW) + b("│");
		const sep = () => b(`├${"─".repeat(innerW)}┤`);
		const rows = Math.max(14, this.tui.terminal?.rows ?? 30);
		const messages = this.messages();
		this.clamp();
		const agent = getAgent(this.id);
		const heading = `📥 Pi Inbox · queued messages · ${this.title}`;
		const title = ` ${th.bold(th.fg("accent", heading))} `;
		const out = [
			b("╭─") +
				title +
				b("─".repeat(Math.max(0, innerW - 1 - visibleWidth(title)))) +
				b("╮"),
		];
		const state = !messages.length
			? "the queue is empty"
			: agent?.restartAfterInterrupt
				? "stopping the current run; the selected message runs next"
				: agent?.proc
					? "the current run keeps going unless you choose send now"
					: "waiting to start the next queued message";
		out.push(line(` ${th.fg("dim", state)}`));
		out.push(sep());

		const listH = Math.max(3, rows - 9);
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + listH) {
			this.scroll = this.selected - listH + 1;
		}
		this.scroll = Math.max(
			0,
			Math.min(this.scroll, Math.max(0, messages.length - listH)),
		);
		for (let i = 0; i < listH; i++) {
			const index = this.scroll + i;
			const message = messages[index];
			if (message === undefined) {
				const empty = i === 0 && messages.length === 0;
				out.push(
					line(empty ? ` ${th.fg("dim", "(queue is empty)")}` : ""),
				);
				continue;
			}
			const selected = index === this.selected;
			const marker = selected ? th.fg("accent", "▶") : " ";
			const text = message.replace(/\s+/g, " ").trim();
			const row = ` ${marker} ${th.fg("dim", `${index + 1}.`)} ${text}`;
			out.push(line(selected ? th.bg("selectedBg", row) : row));
		}
		out.push(sep());
		const selected = messages[this.selected];
		const preview = selected
			? wrapTextWithAnsi(selected, Math.max(10, innerW - 2)).slice(0, 2)
			: [];
		for (let i = 0; i < 2; i++) {
			out.push(line(preview[i] ? ` ${preview[i]}` : ""));
		}
		const k = (key: string, label: string) =>
			`${th.fg("accent", key)} ${th.fg("dim", label)}`;
		const help = this.flash
			? th.fg("success", this.flash)
			: [
					k("↑↓", "choose"),
					k("enter", "interrupt + send now"),
					k("d/delete", "remove"),
					k("esc", "close"),
				].join(th.fg("dim", " · "));
		out.push(line(` ${help}`));
		out.push(b(`╰${"─".repeat(innerW)}╯`));
		return out.slice(0, rows).map((l) => truncateToWidth(l, width));
	}
}

// ───────────────────────────── directory picker ─────────────────────────────

/** Directory for the next new background agent, set with ctrl+w before sending its first prompt. */
const NEXT_DIR_KEY = Symbol.for("pi.inbox.next-agent-dir");
function getNextAgentDir(): string | undefined {
	return (globalThis as any)[NEXT_DIR_KEY];
}
function setNextAgentDir(dir: string | undefined) {
	(globalThis as any)[NEXT_DIR_KEY] = dir || undefined;
}

/** Expand a typed path (~, relative) into an absolute directory. undefined = not resolvable. */
function expandDir(input: string, base: string): string | undefined {
	let s = (input ?? "").trim();
	if (!s) return undefined;
	if (s === "~" || s.startsWith("~/")) {
		const home = os.homedir();
		s = s === "~" ? home : path.join(home, s.slice(2));
	}
	try {
		const abs = path.resolve(base, s);
		const st = fs.statSync(abs);
		if (!st.isDirectory()) return undefined;
		return abs;
	} catch {
		return undefined;
	}
}

/** Display form of a directory, with ~ for home. */
function prettyDir(p: string): string {
	const home = os.homedir();
	return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/**
 * Deepest existing directory along a typed path, plus the un-resolved remainder:
 * "~/Code/gam" -> { dir: ~/Code, rest: "gam" }, "" -> base itself.
 */
function resolvePrefix(input: string, base: string): { dir: string; rest: string } {
	let s = (input ?? "").trim();
	if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
	if (!s) return { dir: base, rest: "" };
	let p = path.resolve(base, s);
	const rest: string[] = [];
	for (;;) {
		try {
			if (fs.statSync(p).isDirectory()) return { dir: p, rest: rest.join("/") };
		} catch {
			// doesn't exist (or isn't a dir): walk up
		}
		const parent = path.dirname(p);
		if (parent === p) return { dir: base, rest: s };
		rest.unshift(path.basename(p));
		p = parent;
	}
}

interface DirSuggestion {
	/** Absolute path this suggestion selects. */
	value: string;
	/** Display text; children show just their name (like a file browser). */
	label: string;
	hint?: string;
	kind: "as-typed" | "up" | "home" | "child" | "recent";
}

/**
 * Suggestions while typing in the directory picker. Cheap and synchronous:
 *  - what the input means so far (the resolved prefix), then its parent and home
 *  - child directories of that prefix, filtered by the un-resolved remainder (shell-like)
 *  - working directories of other sessions that match the typed text ("recent")
 */
function dirSuggestions(input: string, base: string): DirSuggestion[] {
	const out: DirSuggestion[] = [];
	const seen = new Set<string>();
	const push = (s: DirSuggestion) => {
		if (seen.has(s.value)) return;
		seen.add(s.value);
		out.push(s);
	};
	const typed = !!input.trim();
	const { dir, rest } = resolvePrefix(input, base);
	push({ value: dir, label: prettyDir(dir), hint: typed ? (rest ? undefined : "as typed") : "current", kind: "as-typed" });
	const parent = path.dirname(dir);
	if (parent && parent !== dir) push({ value: parent, label: "..", hint: "parent", kind: "up" });
	const home = os.homedir();
	if (home !== dir) push({ value: home, label: "~", hint: "home", kind: "home" });

	let names: string[] = [];
	try {
		names = fs
			.readdirSync(dir)
			.filter((n) => {
				try {
					return fs.statSync(path.join(dir, n)).isDirectory() && !n.startsWith(".");
				} catch {
					return false;
				}
			})
			.sort((a, b) => a.localeCompare(b));
	} catch {
		// unreadable -> no children
	}
	const last = (rest || "").toLowerCase();
	for (const n of names) {
		if (last && !n.toLowerCase().startsWith(last)) continue;
		push({ value: path.join(dir, n), label: `${n}/`, kind: "child" });
	}

	if (typed) {
		const q = input.trim().toLowerCase();
		for (const c of recentSessionDirs()) {
			if (c === dir || !prettyDir(c).toLowerCase().includes(q)) continue;
			push({ value: c, label: prettyDir(c), hint: "recent", kind: "recent" });
		}
	}
	return out.slice(0, 14);
}

/** Working directories of known sessions (for the picker's "recent" suggestions). Set by loadRows. */
const ROWS_KEY = Symbol.for("pi.inbox.rowCache");
function recentSessionDirs(): string[] {
	const rows = (globalThis as any)[ROWS_KEY] as Row[] | undefined;
	const dirs: string[] = [];
	for (const r of rows ?? []) if (r.info.cwd && !dirs.includes(r.info.cwd)) dirs.push(r.info.cwd);
	return dirs;
}

/**
 * Move a saved session to another working directory:
 *  - rewrite the session header's `cwd` (first line) so pi restores it under the new dir,
 *  - move the file into the new dir's session-dir slug (`--<slug>--`), matching pi's layout.
 * The caller re-points any registered background agent (setAgentDir).
 * Returns the new absolute path. Throws on failure (no partial state on the common paths).
 */
function moveSessionDir(file: string, newCwd: string): string {
	const raw = fs.readFileSync(file, "utf-8");
	const nl = raw.includes("\r\n") ? "\r\n" : "\n";
	const firstNl = raw.indexOf(nl);
	const first = firstNl >= 0 ? raw.slice(0, firstNl) : raw;
	if (!firstNl) throw new Error("session file has no header line");
	const header = JSON.parse(first);
	if (header?.type !== "session") throw new Error("not a pi session file");
	header.cwd = newCwd;
	const rewritten = `${JSON.stringify(header)}${nl}${firstNl >= 0 ? raw.slice(firstNl + nl.length) : ""}`;
	const tmp = `${file}.move-${process.pid}.tmp`;
	fs.writeFileSync(tmp, rewritten, "utf-8");
	const slug = `--${newCwd.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-")}--`;
	const dir = path.join(AGENT_DIR, "sessions", slug);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, path.basename(file));
	const same = path.resolve(target) === path.resolve(file);
	if (!same && fs.existsSync(target)) {
		fs.rmSync(tmp, { force: true });
		throw new Error(`a session file already exists at ${target}`);
	}
	fs.renameSync(tmp, target);
	try {
		if (!same) fs.rmSync(file);
	} catch {
		// best effort; the rename above already produced the new copy
	}
	return target;
}

// ───────────────────────────── background-agent helpers ─────────────────────────────

/** Where the next message typed in the main editor goes, when it isn't the foreground session. */
type ReplyTarget =
	/** model: set once you change the model while this reply is pending; agentModel: what the agent uses otherwise. */
	| { kind: "agent"; id: string; title: string; cwd: string; sessionFile?: string; model?: string; agentModel?: string }
	| { kind: "new"; cwd: string; model?: string };

const REPLY_KEY = Symbol.for("pi.inbox.reply-target");
function getReplyTarget(): ReplyTarget | undefined {
	return (globalThis as any)[REPLY_KEY];
}
function setReplyTarget(t: ReplyTarget | undefined, ctx?: ExtensionContext) {
	(globalThis as any)[REPLY_KEY] = t;
	// A pre-name / pre-dir only ever belong to the new agent being typed; dropping the target drops them.
	if (!t) {
		setNextAgentName(undefined);
		setNextAgentDir(undefined);
	}
	if (ctx) showReplyWidget(ctx);
}

/** Name for the next new background agent, set with ctrl+r before sending its first prompt. */
const NEXT_NAME_KEY = Symbol.for("pi.inbox.next-agent-name");
function getNextAgentName(): string | undefined {
	return (globalThis as any)[NEXT_NAME_KEY];
}
function setNextAgentName(name: string | undefined) {
	(globalThis as any)[NEXT_NAME_KEY] = name || undefined;
}
// Session names in status lines get a stable per-session color, so different targets are easy to
// tell apart (pi renders notify() text dim gray otherwise).
const NAME_COLORS = ["syntaxType", "syntaxFunction", "syntaxKeyword", "syntaxString", "mdHeading", "syntaxVariable", "success", "syntaxNumber"] as const;
function nameColor(key: string): (typeof NAME_COLORS)[number] {
	let h = 0;
	for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
	return NAME_COLORS[h % NAME_COLORS.length];
}
/** Colored, bold session name for use inside a dim notify() line; re-enters dim after the name. */
function coloredName(th: any, key: string, name: string): string {
	let dimOn = "";
	try {
		dimOn = th.fg("dim", "\u0000").split("\u0000")[0];
	} catch {}
	return th.bold(th.fg(nameColor(key), name)) + dimOn;
}
function showReplyWidget(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	const t = getReplyTarget();
	const th = ctx.ui.theme;
	const nextName = getNextAgentName();
	if (!t && nextName) {
		// Orchestrator home without an explicit target: still show the pending name.
		return ctx.ui.setWidget("inbox-reply", [
			`${th.fg("accent", "🏷  Next new agent: ")}${th.bold(nextName.slice(0, 60))}${th.fg("dim", " · ctrl+r to change")}`,
		]);
	}
	if (!t) return ctx.ui.setWidget("inbox-reply", undefined);
	const cancel = th.fg("dim", " · esc to cancel");
	const nextDir = getNextAgentDir();
	const named =
		t.kind === "new"
			? nextName
				? `${th.fg("dim", " · named ")}${th.bold(nextName.slice(0, 50))}`
				: th.fg("dim", " · ctrl+r to name it")
			: "";
	const dir =
		t.kind === "new"
			? nextDir
				? `${th.fg("dim", " · dir ")}${th.bold(prettyDir(nextDir).slice(0, 50))}`
				: th.fg("dim", " · ctrl+w to change dir")
			: "";
	const text =
		t.kind === "new"
			? `${th.fg("accent", "＋ Your next message starts a new background agent")}${th.fg("dim", ` · ${shortCwd(nextDir ?? t.cwd)} · ${t.model ?? "default model"}`)}${named}${dir}`
			: `${th.fg("accent", "↪ Your next message goes to ")}${th.bold(th.fg(nameColor(t.id), t.title.slice(0, 50)))}${th.fg(
					"dim",
					` · ${t.model ? `${t.model} (changed)` : (t.agentModel ?? "its current model")}${isRunning(getAgent(t.id)) ? " · queued: it's working" : ""}`,
				)}`;
	// Factory form so we capture the TUI: the esc handler needs to know whether pi's editor has focus.
	ctx.ui.setWidget("inbox-reply", (tui) => {
		(globalThis as any).__piInboxTui = tui;
		return new Text(text + cancel, 1, 0);
	});
}
/** The active TUI, including when no reply widget has captured it. */
function activeInboxTui(ctx?: ExtensionContext): TUI | undefined {
	const global = globalThis as any;
	return (
		global.__piInboxTui ??
		global[Symbol.for("pi.inbox.tui")] ??
		(ctx?.ui as any)?.tui
	) as TUI | undefined;
}

/** The focused component if it's pi's main editor (no dialog or overlay). */
function focusedEditor(allowAutocomplete = false): any {
	const f = (activeInboxTui() as any)?.getFocusedComponent?.();
	if (
		!f ||
		typeof f.getText !== "function" ||
		typeof f.insertTextAtCursor !== "function"
	) {
		return undefined;
	}
	if (
		!allowAutocomplete &&
		typeof f.isShowingAutocomplete === "function" &&
		f.isShowingAutocomplete()
	) return undefined;
	return f;
}

/** True when pi's main editor has focus (no dialog, selector, or overlay open). */
function editorFocused(): boolean {
	return !!focusedEditor();
}

// ───────────────────────────── orchestrator mode ─────────────────────────────
// Orchestrator mode turns this window into the agent control panel. The inbox is the whole
// screen (never a pane over pi's chat view). The window sits on "home", a blank session that
// never gets a conversation, so pi never writes it to disk. Everything runs in the background:
// enter opens a session "attached" (pi's own chat view; what you type runs as a background agent,
// and the view reloads from disk when the run ends), so switching never aborts anything. `t` /
// /takeover makes a session run here like plain pi; leaving it mid-run hands the run back to a
// background agent. ctrl+q comes back to the orchestrator, `h` returns home. State lives on
// globalThis because the extension is re-instantiated on every session switch.

interface ModeState {
	on: boolean;
	flagApplied: boolean;
	inLoop: boolean;
	/** Sessions taken over: they run in this window like plain pi. Every other session is "attached". */
	takenOver: Set<string>;
	/** Take over as soon as the background run finishes (`t` on a working agent). */
	takeoverWhenDone: Set<string>;
	/** Attached sessions whose on-screen transcript is behind the file (a run ended while the orchestrator was up). */
	stale: Set<string>;
	/** Attached sessions we saw running, so we know when to reload the transcript. */
	wasRunning: Set<string>;
	/** Attached sessions to reload between two queued runs (their next run is held until then). */
	betweenRuns: Set<string>;
	/** A new agent started from home: shown in pi's chat view, and opened attached once its session file exists. */
	openWhenReady?: string;
	/** The next blank session is home for typing a new agent's prompt: don't cover it with the orchestrator. */
	skipReopen?: boolean;
}
const MODE_KEY = Symbol.for("pi.inbox.mode");
/** Agent id whose queue manager currently owns an overlay. */
const QUEUE_MANAGER_KEY = Symbol.for("pi.inbox.queueManagerOpen");
/** The TUI the inbox overlay last drew on (lets the inbox trigger a redraw when it closes). */
const INBOX_TUI_KEY = Symbol.for("pi.inbox.tui");
const modeState = (): ModeState => {
	const g = globalThis as any;
	g[MODE_KEY] ??= { on: false, flagApplied: false, inLoop: false };
	const s = g[MODE_KEY];
	s.takenOver ??= new Set();
	s.takeoverWhenDone ??= new Set();
	s.stale ??= new Set();
	s.wasRunning ??= new Set();
	s.betweenRuns ??= new Set();
	return s;
};

/** Message that resumes a run that was interrupted when a taken-over session moved to the background. */
const CONTINUE_MSG =
	"Continue where you left off. (Your previous run was interrupted when this session moved to the background; pick up from the last completed step.)";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function orchestrating(): boolean {
	return modeState().on;
}

/**
 * Terminal images (pasted screenshots, tool previews) draw over overlays: pi-tui's
 * compositeTuiLine returns a base line untouched when it holds an image escape, so the image row
 * wins over the overlay. Patched once per TUI:
 *  - while the inbox is open (full-screen or centered pane), every image line renders blank, so no
 *    image can poke through or bleed into the pane;
 *  - any other overlay spanning the full width composites onto a blank line instead (nothing of the
 *    base line would be visible anyway).
 * Closing the overlay changes those rows back, so the differential renderer re-emits the images
 * (the inbox also requests a render on close).
 */
const IMAGE_PATCH_KEY = Symbol.for("pi.inbox.imageOverlayPatch");
const isImageLine = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
function coverImagesUnderOverlays(tui: TUI): void {
	const t = tui as any;
	if (t[IMAGE_PATCH_KEY]) return;
	t[IMAGE_PATCH_KEY] = true;
	if (typeof t.compositeOverlays === "function") {
		const origOverlays = t.compositeOverlays.bind(t);
		t.compositeOverlays = (lines: string[], w: number, h: number) =>
			origOverlays(modeState().inLoop ? lines.map((l) => (isImageLine(l) ? "" : l)) : lines, w, h);
	}
	if (typeof t.compositeLineAt === "function") {
		const origLine = t.compositeLineAt.bind(t);
		t.compositeLineAt = (base: string, overlay: string, startCol: number, overlayWidth: number, totalWidth: number) =>
			origLine(startCol <= 0 && overlayWidth >= totalWidth && isImageLine(base) ? "" : base, overlay, startCol, overlayWidth, totalWidth);
	}
}

/** Overlay geometry: full screen in orchestrator mode, a centered pane otherwise. */
function overlayOpts(paneWidth: `${number}%` = "94%"): OverlayOptions {
	return orchestrating()
		? { width: "100%", maxHeight: "100%", anchor: "top-left" as const, margin: 0 }
		: { width: paneWidth, maxHeight: "92%", anchor: "center" as const };
}

/** Reopen the inbox once the current command/handler has returned (commands need a fresh command context). */
function reopenInbox(send: (t: string, o: { expandPromptTemplates: boolean }) => Promise<void> | void) {
	setTimeout(() => void Promise.resolve(send("/inbox", { expandPromptTemplates: true })).catch(() => {}), 50);
}

/** Home = a session with no conversation yet (the blank session the orchestrator sits on). */
function isHome(ctx: ExtensionContext): boolean {
	return !ctx.sessionManager
		.getBranch()
		.some((e: any) => e?.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"));
}

/**
 * Orchestrator: an "attached" session is shown in pi's own chat view, but everything you send
 * runs as a background agent, so you can switch away at any time without aborting it.
 * A "taken over" session runs right here, like plain pi.
 */
function isAttached(ctx: ExtensionContext): boolean {
	return orchestrating() && !isHome(ctx) && !modeState().takenOver.has(ctx.sessionManager.getSessionId());
}

/** The window's real foreground session is the sticky taken-over main. */
function isStickyMain(ctx: ExtensionContext): boolean {
	return orchestrating() && modeState().takenOver.has(ctx.sessionManager.getSessionId());
}

/** Shared queue target for /queue and the native dequeue-key interceptor. */
function queueTargetId(ctx: ExtensionContext): string | undefined {
	if (isVisiting()) return visitState().visit!.id;
	if (isAttached(ctx)) return ctx.sessionManager.getSessionId();
	if (orchestrating() && (isHome(ctx) || isStickyMain(ctx))) {
		return modeState().openWhenReady;
	}
	return undefined;
}

/** Attached and its background run is still going (the on-screen transcript is a snapshot). */
function attachedBusy(ctx: ExtensionContext): boolean {
	return isAttached(ctx) && isRunning(getAgent(ctx.sessionManager.getSessionId()));
}

/** The only special mode banner: identify the main session as taken over. */
function showModeWidget(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	const id = ctx.sessionManager.getSessionId();
	if (
		!orchestrating() ||
		isHome(ctx) ||
		isVisiting() ||
		!modeState().takenOver.has(id)
	) {
		return ctx.ui.setWidget("inbox-mode", undefined);
	}
	ctx.ui.setWidget("inbox-mode", [
		ctx.ui.theme.bold(
			ctx.ui.theme.fg("warning", "Orchestrator - taken over"),
		),
	]);
}

// ───────────────────── live streaming (attached runs) ─────────────────────
//
// While a background run is going on the attached session, its transcript streams INTO the
// chat container itself — appended after the snapshot pi loaded from disk, inside the scrollable
// document (fullscreen ScrollView / terminal scrollback in regular mode), NOT in the widget dock
// (which sits fixed at the bottom of the screen and would eat the transcript as it grew).
// The stream renders with pi's own message components (UserMessageComponent,
// AssistantMessageComponent, ToolExecutionComponent), so a running agent looks exactly like a
// foreground one: content grows downward, and scrolling is pi's own. When the run ends,
// refreshCurrent() reloads the real transcript from the session file and the stream is removed —
// same content, no duplicates.

const LIVE_STREAM_COMPONENT_KEY = Symbol.for(
	"pi.inbox.liveStreamComponent",
);

/** A cached message rendering: rebuilt only when its message's rev changes (a rev is bumped on
 * every delta), so each streamed token rebuilds exactly one assistant component — the rest render
 * from their own caches. Tool rows live inside the same cached entry: a ToolExecutionComponent
 * per call, updated in place for partial results. */
class LiveMsgCache {
	entry?: {
		source: any;
		rev: number;
		hideThinkingBlock: boolean;
		parts: any[];
		tools: Array<{
			id: string;
			args: any;
			result: any;
		}>;
	};

	get(
		m: any,
		md: any,
		th: Theme,
		tui: TUI,
		hideThinkingBlock: boolean,
	): any[] {
		if (
			this.entry &&
			this.entry.source === m &&
			this.entry.hideThinkingBlock === hideThinkingBlock
		) {
			const tools = m.tools ?? [];
			const sameTools =
				this.entry.tools.length === tools.length &&
				this.entry.tools.every((t, i) => t.id === tools[i]?.id);
			if (sameTools) {
				if (this.entry.rev !== m.rev && m.role === "assistant") {
					const first = this.entry.parts[0];
					first?.updateContent?.(m.message, true);
					for (let i = 0; i < tools.length; i++) {
						const tool = tools[i];
						const previous = this.entry.tools[i];
						const component = this.entry.parts[i + 1];
						if (tool.args !== previous.args) {
							component?.updateArgs?.(tool.args);
						}
						if (tool.result !== previous.result && tool.result) {
							component?.updateResult?.(tool.result);
						}
					}
					this.entry.rev = m.rev;
					this.entry.tools = tools.map((t: any) => ({
						id: t.id,
						args: t.args,
						result: t.result,
					}));
				}
				return this.entry.parts;
			}
		}
		const parts: any[] = [];
		if (m.role === "user") {
			const sb = parseSkillBlock(m.text ?? "");
			parts.push(
				sb
					? new SkillLine(th, sb.name ?? "skill", sb.userMessage)
					: new UserMessageComponent(m.text ?? "", md, 0),
			);
		} else {
			parts.push(
				new AssistantMessageComponent(
					m.message,
					hideThinkingBlock,
					md,
					"Thinking…",
					0,
				),
			);
			for (const t of m.tools ?? []) {
				const tc = new ToolExecutionComponent(
					t.name,
					t.id,
					t.args,
					{ showImages: false },
					{},
					tui,
					"",
				);
				if (t.result) tc.updateResult(t.result);
				parts.push(tc);
			}
		}
		this.entry = {
			source: m,
			rev: m.rev,
			hideThinkingBlock,
			parts,
			tools: (m.tools ?? []).map((t: any) => ({
				id: t.id,
				args: t.args,
				result: t.result,
			})),
		};
		return parts;
	}
}

/** The live stream (exported for tests). One container per message, appended to the chat
 * container after the loaded snapshot. Self-syncing — render() diffs the agent's liveRun by
 * message rev and only rebuilds the message that moved (its tools update in place). No scroll
 * logic here: the stream lives in the scrollable document, so pi's own ScrollView (fullscreen)
 * or the terminal scrollback (regular mode) does all of it, exactly like the transcript. */
export class LiveStreamComponent extends Container {
	readonly [LIVE_STREAM_COMPONENT_KEY] = true;
	readonly cacheVersion = 6;
	private cache: LiveMsgCache[] = [];
	private syncedRun?: object;
	private syncedKey = "";

	constructor(
		private tui: TUI,
		private theme: Theme,
		private target: () => string,
		private hideThinkingBlock: boolean,
		private promptInSnapshot: boolean,
	) {
		super();
	}

	setViewOptions(
		hideThinkingBlock: boolean,
		promptInSnapshot: boolean,
	): void {
		if (
			hideThinkingBlock === this.hideThinkingBlock &&
			promptInSnapshot === this.promptInSnapshot
		) {
			return;
		}
		this.hideThinkingBlock = hideThinkingBlock;
		this.promptInSnapshot = promptInSnapshot;
		this.syncedKey = "";
	}

	agentId(): string {
		return this.target();
	}

	/** Rebuild the child list when anything changed. Unchanged messages reuse their components. */
	private sync(): boolean {
		const a = getAgent(this.target());
		const run = a?.liveRun;
		const msgs = run?.msgs ?? [];
		if (run !== this.syncedRun) {
			// Revisions restart at one for every queued run. Reusing the prior
			// run's cache would render its prompt until the transcript reloads.
			this.syncedRun = run;
			this.syncedKey = "";
			this.cache = [];
		}
		const lastRev = msgs.length
			? `${msgs.length}:${msgs[msgs.length - 1].rev}`
			: "0";
		const key = lastRev;
		if (key === this.syncedKey) return false;
		this.syncedKey = key;

		while (this.cache.length < msgs.length) this.cache.push(new LiveMsgCache());
		this.cache.length = msgs.length;
		const md = getMarkdownTheme();
		const th = this.theme;
		const next: any[] = [];
		const start =
			this.promptInSnapshot && msgs[0]?.role === "user" ? 1 : 0;
		for (let i = start; i < msgs.length; i++) {
			if (i > start && msgs[i].role === "user") {
				next.push(new Spacer(1));
			}
			next.push(
				...this.cache[i].get(
					msgs[i],
					md,
					th,
					this.tui,
					this.hideThinkingBlock,
				),
			);
		}
		this.children = next;
		return true;
	}

	render(width: number): string[] {
		this.sync();
		return super.render(width);
	}

	invalidate(): void {
		this.syncedKey = "";
		super.invalidate();
	}
	dispose(): void {}
}

/** One-line skill invocation hint (collapsible rendering isn't needed mid-run). */
class SkillLine {
	constructor(
		private theme: Theme,
		private skill: string,
		private rest?: string,
	) {}
	invalidate(): void {}
	render(_width: number): string[] {
		const th = this.theme;
		const rest = (this.rest ?? "").replace(/\s+/g, " ").slice(0, 100);
		return [th.fg("accent", `⚡ ${this.skill}${rest ? ` · ${rest}` : ""}`)];
	}
}

/**
 * The chat container the stream appends to: the transcript document pi scrolls. Children of the
 * TUI are the mount roots; in both modes the document container is first and its chat container
 * is its last child (interactive-mode mounts documentContainer with header + resources + chat).
 */
function chatContainer(tui: TUI): any | undefined {
	const doc = tui?.children?.[0] as any;
	const chat = doc?.children?.[doc.children.length - 1];
	return Array.isArray(chat?.children) ? chat : undefined;
}

let thinkingVisibilityCache:
	| { key: string; checkedAt: number; hidden: boolean }
	| undefined;

/** Read Pi's effective global/project setting, with a short streaming cache. */
function thinkingBlocksHidden(ctx: ExtensionContext): boolean {
	const trusted = ctx.isProjectTrusted();
	const key = `${ctx.cwd}\0${trusted}`;
	const now = Date.now();
	if (
		thinkingVisibilityCache?.key === key &&
		now - thinkingVisibilityCache.checkedAt < 500
	) {
		return thinkingVisibilityCache.hidden;
	}
	let hidden = false;
	try {
		hidden = SettingsManager.create(ctx.cwd, AGENT_DIR, {
			projectTrusted: trusted,
		}).getHideThinkingBlock();
	} catch {
		// Match Pi's default if settings cannot be read.
	}
	thinkingVisibilityCache = { key, checkedAt: now, hidden };
	return hidden;
}

/**
 * Remove the persisted prefix of the in-flight run from Pi's snapshot. The
 * live component owns the whole current run so leaving and returning does not
 * mix native snapshot components with reconstructed streaming components.
 */
function removeCurrentRunSnapshot(chat: any, a: BgAgent): void {
	if (!a.runPrompt) return;
	const named = (child: any, ctor: any, name: string) =>
		child instanceof ctor || child?.constructor?.name === name;
	const isUser = (child: any) =>
		named(child, UserMessageComponent, "UserMessageComponent");
	const isSkill = (child: any) =>
		named(
			child,
			SkillInvocationMessageComponent,
			"SkillInvocationMessageComponent",
		);
	const expected = cleanTitle(a.runPrompt);
	let start = -1;
	for (let i = chat.children.length - 1; i >= 0; i--) {
		const child = chat.children[i] as any;
		if (isUser(child) && cleanTitle(child.text ?? "") === expected) {
			start = i;
			break;
		}
		if (isSkill(child)) {
			const block = child.skillBlock;
			const text = block?.userMessage || `⚡${block?.name ?? "skill"}`;
			if (cleanTitle(text) === expected) {
				start = i;
				break;
			}
		}
	}
	if (start < 0) return;
	for (let i = start - 1; i >= 0; i--) {
		const child = chat.children[i] as any;
		if (named(child, Spacer, "Spacer")) {
			start = i;
			continue;
		}
		if (isSkill(child)) start = i;
		break;
	}
	for (let i = chat.children.length - 1; i >= start; i--) {
		const child = chat.children[i] as any;
		if (
			named(child, Spacer, "Spacer") ||
			isUser(child) ||
			isSkill(child) ||
			named(
				child,
				AssistantMessageComponent,
				"AssistantMessageComponent",
			) ||
			named(
				child,
				ToolExecutionComponent,
				"ToolExecutionComponent",
			)
		) {
			chat.children.splice(i, 1);
			child.dispose?.();
		}
	}
}

/** Remove live-stream mounts left behind by this or an older extension load. */
function removeStaleLiveStreams(
	chat: any,
	keep?: LiveStreamComponent,
): void {
	for (let i = chat.children.length - 1; i >= 0; i--) {
		const child = chat.children[i] as any;
		if (child === keep) continue;
		const marked = child?.[LIVE_STREAM_COMPONENT_KEY] === true;
		const legacy =
			child?.constructor?.name === "LiveStreamComponent" &&
			typeof child.agentId === "function";
		if (!marked && !legacy) continue;
		chat.children.splice(i, 1);
		child.dispose?.();
	}
}

/** Show immediate send feedback while a new session is being created. */
function showStartingPrompt(
	ctx: ExtensionContext,
	a: BgAgent | undefined,
): void {
	if (!ctx.hasUI || !a?.runPrompt) return;
	const prompt = a.runPrompt;
	ctx.ui.setWidget("inbox-live", () =>
		new UserMessageComponent(prompt, getMarkdownTheme(), 0),
	);
}

/** Live stream for an attached session while its background run is going. */
function showLiveStream(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	// While a visit is mounted, the chat container's methods are interposed and its
	// children are the VisitView — the visit renders the visited session's live run
	// itself. Mounting a stream here would target the hidden main's stash.
	if (isVisiting()) {
		const G = globalThis as any;
		unmountLiveStream(ctx, G);
		const a = visitAgent();
		if (!a || !isRunning(a)) return;
		// Same compact status the normal attached view uses — no visit-specific UI.
		const th = ctx.ui.theme;
		const status: string[] = [
			th.fg(
				"accent",
				a.proc
					? "⟳ working in the background"
					: a.hold
						? "↻ loading the last turn…"
						: "⏸ queued (waiting for a free agent slot)",
			),
		];
		if (a.pending.length) {
			const queueKey =
				getKeybindings().getKeys("app.message.dequeue").join("/") ||
				"alt+up";
			status.push(
				th.fg(
					"warning",
					`⏳ ${a.pending.length} message(s) queued · ${queueKey} or /queue to manage`,
				),
			);
		}
		return ctx.ui.setWidget("inbox-live", status);
	}
	const a = isAttached(ctx)
		? getAgent(ctx.sessionManager.getSessionId())
		: undefined;
	const G = globalThis as any;
	const tui = activeInboxTui(ctx);
	if (tui) G.__piInboxTui = tui;
	const chat = tui ? chatContainer(tui) : undefined;
	if (!a || !isRunning(a) || !tui || !chat) {
		return unmountLiveStream(ctx, G);
	}
	const hideThinkingBlock = thinkingBlocksHidden(ctx);
	removeCurrentRunSnapshot(chat, a);
	const promptInSnapshot = false;
	// The stream is one child of the chat container, appended after the snapshot. One stable
	// instance per agent: its per-message cache survives re-mounts, which happen whenever pi
	// rebuilds the chat (session switch, compaction) — detect a lost mount and re-append.
	let stream = G[LIVE_STREAM_KEY] as LiveStreamComponent | undefined;
	if (
		!stream ||
		stream.agentId() !== a.id ||
		typeof stream.setViewOptions !== "function" ||
		stream.cacheVersion !== 6
	) {
		stream = new LiveStreamComponent(
			tui,
			ctx.ui.theme,
			() => a.id,
			hideThinkingBlock,
			promptInSnapshot,
		);
		G[LIVE_STREAM_KEY] = stream;
	} else {
		stream.setViewOptions(hideThinkingBlock, promptInSnapshot);
	}
	removeStaleLiveStreams(chat, stream);
	if (stream !== chat.children[chat.children.length - 1]) {
		// Drop a previous run's stream (a different agent's) before appending this one.
		const i = chat.children.indexOf(stream);
		if (i !== -1) chat.children.splice(i, 1);
		chat.addChild(stream);
	}
	// The dock carries only what the transcript stream can't: the run's state and your queued
	// input. No activity echo (the stream shows the work itself), no duplicated content. pi caps
	// string widgets at 10 lines; this is 1–2.
	const th = ctx.ui.theme;
	const status: string[] = [
		th.fg("accent", a.proc ? "⟳ working in the background" : a.hold ? "↻ loading the last turn…" : "⏸ queued (waiting for a free agent slot)"),
	];
	if (a.pending.length) {
		const count = `${a.pending.length} message(s) queued`;
		const queueKey =
			getKeybindings().getKeys("app.message.dequeue").join("/") ||
			"alt+up";
		status.push(
			th.fg(
				"warning",
				`⏳ ${count} · ${queueKey} or /queue to manage`,
			),
		);
	}
	ctx.ui.setWidget("inbox-live", status);
	// Re-render on agent updates; render()'s sync() detects what changed via its key and rebuilds
	// only the message whose rev moved (the per-message cache makes deltas cheap).
	if (!G[LIVE_STREAM_LISTENER]) {
		G[LIVE_STREAM_LISTENER] = onAgentEvent(() => {
			activeInboxTui()?.requestRender?.();
		});
	}
}

function unmountLiveStream(ctx: ExtensionContext, G: any) {
	const tui = activeInboxTui(ctx);
	const chat = tui ? chatContainer(tui) : undefined;
	if (chat) removeStaleLiveStreams(chat);
	G[LIVE_STREAM_KEY] = undefined;
	G[LIVE_STREAM_LISTENER]?.();
	G[LIVE_STREAM_LISTENER] = undefined;
	ctx.ui.setWidget("inbox-live", undefined);
}
const LIVE_STREAM_KEY = Symbol.for("pi.inbox.liveStream");
const LIVE_STREAM_LISTENER = Symbol.for("pi.inbox.liveStreamListener");

/** Why a reply can't be sent to this session in the background (undefined = OK). */
function sendBlockedReason(id: string, file: string | undefined, ctx: ExtensionContext): string | undefined {
	const currentFile = ctx.sessionManager.getSessionFile();
	if (id === ctx.sessionManager.getSessionId() || (file && file === currentFile))
		return "That's your current session — just type in the editor.";
	const live = readLive().get(id);
	const mine = getAgent(id);
	if (live && live.pid !== process.pid && live.pid !== mine?.pid)
		return live.bgParent
			? `It's a background agent of another pi (pid ${live.bgParent}) — reply from there.`
			: `It's open in another pi window (pid ${live.pid}) — reply there, or close it first.`;
	return undefined;
}

/** Ping when a background agent finishes, honoring ~/.pi/agent/notify.json (sound settings). */
function playSound(failed: boolean) {
	let cfg: any = {};
	try {
		cfg = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "notify.json"), "utf-8"));
	} catch {
		// defaults
	}
	if (cfg.enabled === false || cfg.soundEnabled === false) return;
	const name = (failed ? cfg.errorSound : cfg.sound) || (failed ? "Basso" : "Glass");
	const file = name.includes("/") ? name : `/System/Library/Sounds/${name}.aiff`;
	try {
		const p = spawn("afplay", [file], { stdio: "ignore" });
		p.on("error", () => {});
		p.unref();
	} catch {
		// no sound, no problem
	}
}

// ───────────────────────────── extension ─────────────────────────────

export default function (pi: ExtensionAPI) {
	registerLoadedExtension("inbox");
	// Register before installAgentChildHooks removes the child marker.
	installBackgroundMcpAutoApproval(pi);
	// no-op unless this pi IS a background agent; applies renames requested from a pi window
	installAgentChildHooks((name) => pi.setSessionName(name));

	// ctrl+r (registered by the rename-chat extension) asks here first: on orchestrator home, or
	// while a new-agent prompt is pending, it names that new agent instead of this session.
	(globalThis as any)[Symbol.for("pi.inbox.rename-target")] = (ctx: ExtensionContext) => {
		const t = getReplyTarget();
		if (t?.kind === "agent") return undefined;
		const visit = visitState().visit;
		if (t?.kind !== "new" && visit) {
			return {
				label: "Rename session (empty = auto-title)",
				current: getAgent(visit.id)?.title ?? visit.title,
				apply: (name: string) => {
					const sm = SessionManager.open(visit.file);
					const first = sm.getBranch().find(
						(e: any) => e.type === "message" && e.message?.role === "user",
					) as any;
					const title = name || cleanTitle(
						messageText(first?.message?.content) || "",
					).slice(0, 200);
					if (!title) return "No user message yet — pass a title.";
					if (getAgent(visit.id)) renameAgent(visit.id, title);
					else sm.appendSessionInfo(title);
					visit.title = title;
					return `Session renamed: ${title}`;
				},
			};
		}
		const home = orchestrating() && isHome(ctx);
		const pendingId = home ? modeState().openWhenReady : undefined;
		const pending = pendingId ? getAgent(pendingId) : undefined;
		if (t?.kind !== "new" && pending) {
			return {
				label: "Rename the new agent",
				current: pending.title,
				apply: (name: string) => {
					if (!name) return undefined;
					renameAgent(pending.id, name);
					showLiveStream(ctx);
					return `New agent renamed: ${name}`;
				},
			};
		}
		if (t?.kind !== "new" && !home) return undefined;
		return {
			label: "Name the new agent (empty = from its prompt)",
			current: getNextAgentName(),
			apply: (name: string) => {
				setNextAgentName(name);
				// the reply banner shows the name; no notify (it'd be a permanent chat line)
				showReplyWidget(ctx);
				return undefined;
			},
		};
	};
	installHangupGuard();
	const uiState: UIState = { view: "inbox", query: "" };
	let rowCache: Row[] = [];

	const refreshFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const id = viewedSession(ctx).id;
		const meta = loadStore().sessions[id] ?? {};
		const parts: string[] = [];
		if (meta.pinnedAt) parts.push(ctx.ui.theme.fg("warning", "★ pinned"));
		if (meta.archivedAt) parts.push("archived");
		if (meta.filter === "hide") parts.push("filtered");
		ctx.ui.setStatus("inbox", parts.length ? parts.join(" · ") : undefined);
	};

	pi.registerFlag("orchestrator", {
		description: "Start in inbox orchestrator mode: this window becomes a full-screen agent control panel (/orchestrator)",
		type: "boolean",
		default: false,
	});

	/** The session this interactive window is showing (unset in background-agent subprocesses). */
	let viewing: string | undefined;

	pi.on("session_start", async (_e, ctx) => {
		writeLive(ctx, "idle");
		// Background agent: persist a `--model x:level` override pi applied but didn't record, so the
		// next run / any window opening this session doesn't restore a stale level (e.g. `off`).
		if (isAgentChild()) {
			try {
				recordActualThinkingLevel(ctx.sessionManager, ctx.thinkingLevel ?? pi.getThinkingLevel());
			} catch {
				// best effort
			}
		}
		// Interactive windows heartbeat their agents and adopt orphans left by closed/quit windows.
		if (ctx.mode === "tui" && !isAgentChild()) startAgentSupervisor();
		if (ctx.mode === "tui") {
			viewing = ctx.sessionManager.getSessionId();
			markRead(viewing); // opening a session counts as looking at it
		}
		refreshFooter(ctx);
		const ms = modeState();
		if (!ms.flagApplied) {
			ms.flagApplied = true;
			if (pi.getFlag("orchestrator") === true && ctx.mode === "tui") ms.on = true;
		}
		// A real session switch while a visit was mounted (e.g. /resume used directly): the new
		// session's render writes through the chat container, so the visit's interposition must
		// go now. The visited session keeps running as a background agent, unaffected.
		if (isVisiting()) {
			const tui = activeInboxTui(ctx);
			if (tui) closeVisit(tui);
		}
		showModeWidget(ctx);
		// Orchestrator: whenever the window lands on a blank session (startup, hand-back, /new,
		// reload) the full-screen orchestrator comes back up, so pi's chat view never shows at home.
		const skip = ms.skipReopen;
		ms.skipReopen = false;
		if (orchestrating() && ctx.mode === "tui" && isHome(ctx) && !skip) reopenInbox((t, o) => pi.sendUserMessage(t, o));
	});
	pi.on("agent_start", async (_e, ctx) => {
		writeLive(ctx, "working");
		// Sending a new prompt in an archived session brings it back to the inbox.
		const id = ctx.sessionManager.getSessionId();
		if (loadStore().sessions[id]?.archivedAt) {
			updateMeta(id, (m) => {
				m.archivedAt = undefined;
			});
			if (ctx.hasUI) ctx.ui.notify("📥 Session moved back to inbox (was archived)", "info");
			refreshFooter(ctx);
		}
		// Same for a session hidden manually with `x` (rule-matched sessions stay filtered).
		if (loadStore().sessions[id]?.filter === "hide") {
			updateMeta(id, (m) => {
				m.filter = undefined;
			});
			if (ctx.hasUI) ctx.ui.notify("📥 Session moved back to inbox (was filtered out)", "info");
			refreshFooter(ctx);
		}
	});
	pi.on("agent_settled", async (_e, ctx) => {
		writeLive(ctx, "idle");
		// it finished in front of you — but a manual unread (blue ») stays until you open it from the
		// inbox or leave it; it wouldn't be intentional to clear it just because it ran.
		const id = ctx.sessionManager.getSessionId();
		if (
			ctx.mode === "tui" &&
			viewedSession(ctx).id === id &&
			!manuallyUnread(id)
		) markRead(id);
	});
	pi.on("session_shutdown", async (e: any) => {
		// Leaving a session you were looking at: it's read — except a manual unread (`u`), which is
		// a reminder to come back: it stays unread until you actually open the session again (from
		// the inbox or by switching back). (Only interactive windows; background agent subprocesses
		// load this extension too and must not mark their own sessions read.)
		if (viewing) {
			if (!manuallyUnread(viewing)) markRead(viewing);
			else markSeen(viewing);
		}
		viewing = undefined;
		removeLive();
		// Background agents are NOT stopped on quit: they're detached and keep running; the next
		// interactive pi (or any other open window) adopts them. Stop one explicitly with /stop or `c`.
	});

	// ── background agents: footer + "finished" ping. One global listener (the extension is
	// re-instantiated on every session switch); it always talks to the latest UI context.
	const G = globalThis as any;
	pi.on("session_start", async (_e, ctx) => {
		G.__piInboxAgentsCtx = ctx;
		G.__piInboxPi = pi; // the global listener sends commands through the live extension instance
		// A session switch disposes custom overlays without necessarily resolving
		// their promises. Never let an abandoned queue manager block the new UI.
		G[QUEUE_MANAGER_KEY] = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("inbox-agents", agentsSummary());
		showReplyWidget(ctx);
		const id = ctx.sessionManager.getSessionId();
		const ms = modeState();
		if (attachedBusy(ctx)) ms.wasRunning.add(id);
		else ms.wasRunning.delete(id);
		ms.stale.delete(id); // just loaded from disk
		showLiveStream(ctx);
	});
	/** Orchestrator: reload the attached session's transcript (or finish a pending takeover). */
	function scheduleRefresh(id: string) {
		const ms = modeState();
		if (ms.inLoop || G[QUEUE_MANAGER_KEY] === id) {
			// The orchestrator or queue manager owns the UI. Reloading now would
			// dispose its overlay; refresh after it closes instead.
			ms.stale.add(id);
			return;
		}
		setTimeout(() => {
			const current = modeState();
			if (current.inLoop || G[QUEUE_MANAGER_KEY] === id) {
				current.stale.add(id);
				return;
			}
			const p = (G.__piInboxPi ?? pi) as ExtensionAPI;
			void Promise.resolve(
				p.sendUserMessage("/orchestrator refresh", {
					expandPromptTemplates: true,
				}),
			).catch(() => {});
		}, 50);
	}
	// Replace (not keep) a listener left by a previous load, so /reload picks up new listener code.
	// Keyed by a version so per-session re-instantiation doesn't churn it.
	const LISTENER_VERSION = 14;
	if (G.__piInboxAgentsListenerVersion !== LISTENER_VERSION) {
		if (typeof G.__piInboxAgentsListener === "function") G.__piInboxAgentsListener();
		G.__piInboxAgentsListenerVersion = LISTENER_VERSION;
		G.__piInboxAgentsListener = onAgentEvent((ev) => {
			const ctx = G.__piInboxAgentsCtx as ExtensionContext | undefined;
			if (!ctx?.hasUI) return;
			try {
				const ms = modeState();
				const cur = ctx.sessionManager.getSessionId();
				const shown = viewedSession(ctx).id;
				if (getAgent(cur)?.proc) ms.betweenRuns.delete(cur); // the next run started (reload done or hold timed out)
				// A run on the session you're looking at ended, but you queued more: hold the next run and
				// reload the chat first, so the turn you just watched is in the transcript before the next one.
				if (
					ev.type === "run_end" &&
					ev.agent.id === cur &&
					isAttached(ctx) &&
					!ms.inLoop &&
					!ms.takeoverWhenDone.has(cur) &&
					!ms.betweenRuns.has(cur)
				) {
					holdAgent(cur);
					ms.betweenRuns.add(cur);
					scheduleRefresh(cur);
				} else if (ev.type === "run_end" && ev.agent.id === cur && ms.inLoop) {
					ms.stale.add(cur);
				}
				ctx.ui.setStatus("inbox-agents", agentsSummary());
				showReplyWidget(ctx); // "queued" vs "runs in the background" hint follows the agent's state
				// Visits share the main's context, so isAttached(ctx) is false.
				// Refresh their queue/status without reloading the hidden main.
				if (isVisiting()) {
					if (
						ev.type === "finished" &&
						ev.agent.id === shown &&
						!ms.inLoop &&
						!manuallyUnread(shown)
					) markRead(shown);
					showLiveStream(ctx);
					showModeWidget(ctx);
				} else if (isAttached(ctx)) {
					const running = isRunning(getAgent(cur));
					if (running) ms.wasRunning.add(cur);
					else if (ms.wasRunning.delete(cur)) {
						// you watched it finish — but a manual unread (blue ») is intentional and stays
						if (!manuallyUnread(cur)) markRead(cur);
						scheduleRefresh(cur);
					}
					showLiveStream(ctx);
					showModeWidget(ctx);
				} else if (ms.openWhenReady && isHome(ctx)) {
					// Show only the submitted prompt until the session is ready.
					// Assistant output starts after the automatic session switch.
					showStartingPrompt(ctx, getAgent(ms.openWhenReady));
				}
				if (
					ev.type === "finished" &&
					ev.agent.id === shown &&
					(isAttached(ctx) || isVisiting())
				) {
					playSound(ev.agent.state === "error"); // the reload is the notification; still ping
					return;
				}
				if (ev.type === "finished") {
					const failed = ev.agent.state === "error";
					ctx.ui.notify(
						failed ? `✗ Agent failed: ${ev.agent.title.slice(0, 60)}` : `◆ Agent finished: ${ev.agent.title.slice(0, 60)} — ctrl+q to view`,
						failed ? "error" : "info",
					);
					playSound(failed);
				}
			} catch {
				// stale context during a session switch; the next session_start refreshes it
			}
		});
	}

	/** "provider/model:thinking" of the foreground session, used as the default for new agents. */
	function currentModel(ctx: ExtensionContext): string | undefined {
		if (!ctx.model) return undefined;
		let level: string | undefined = ctx.thinkingLevel;
		try {
			level ??= pi.getThinkingLevel();
		} catch {
			// not available
		}
		return `${ctx.model.provider}/${ctx.model.id}${level ? `:${level}` : ""}`;
	}

	async function pickModel(ctx: ExtensionContext, current: string | undefined): Promise<string | undefined> {
		const fmt = (provider: string, id: string, level?: string) => `${provider}/${id}${level ? `:${level}` : ""}`;
		let options = (ctx.scopedModels ?? []).map((s: any) => fmt(s.model.provider, s.model.id, s.thinkingLevel));
		if (options.length === 0) {
			try {
				options = ctx.modelRegistry.getAvailable().map((m: any) => fmt(m.provider, m.id));
			} catch {
				options = [];
			}
		}
		if (current) options = [current, ...options.filter((o) => o !== current)];
		if (options.length === 0) return current;
		return ctx.ui.select("Model for the new background agent", options);
	}

	/**
	 * Directory picker overlay (orchestrator: stays full-screen). undefined = cancelled.
	 * `ctx` is any ExtensionContext: the pending-dir is stored on globalThis, so the picker can be
	 * opened from a shortcut handler (which gets the base context, no command context).
	 */
	async function pickDir(ctx: ExtensionContext, opts: { title: string; base: string; initial?: string; hint?: string }): Promise<string | undefined> {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			// Non-interactive fallback: plain input dialog.
			const v = await ctx.ui.input(opts.title, opts.initial ?? "");
			return v ? expandDir(v, opts.base) : undefined;
		}
		return ctx.ui.custom<string | undefined>(
			(tui, theme, _kb, done) => (coverImagesUnderOverlays(tui), new DirPickerComponent(tui, theme, done, opts)),
			{ overlay: true, overlayOptions: overlayOpts() },
		);
	}

	async function manageQueue(
		ctx: ExtensionContext,
		explicitId?: string,
		explicitTitle?: string,
	): Promise<QueueManagerResult | undefined> {
		if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
		const id = explicitId ?? queueTargetId(ctx);
		const agent = id ? getAgent(id) : undefined;
		if (!agent) {
			ctx.ui.notify(
				"Open an attached background-agent session to manage its queue.",
				"info",
			);
			return undefined;
		}
		const global = globalThis as any;
		if (global[QUEUE_MANAGER_KEY]) return undefined;
		global[QUEUE_MANAGER_KEY] = agent.id;
		try {
			const result = await ctx.ui.custom<QueueManagerResult>(
				(tui, theme, _kb, done) => {
					coverImagesUnderOverlays(tui);
					return new QueueManagerComponent(
						tui,
						theme,
						done,
						agent.id,
						explicitTitle ?? agent.title,
					);
				},
				{ overlay: true, overlayOptions: overlayOpts("86%") },
			);
			showLiveStream(ctx);
			showModeWidget(ctx);
			return result;
		} finally {
			if (global[QUEUE_MANAGER_KEY] === agent.id) {
				global[QUEUE_MANAGER_KEY] = undefined;
			}
			// A run may have ended while the manager owned the overlay. Reload
			// only after it closes, preserving both the manager and its lock.
			const latest = G.__piInboxAgentsCtx as
				| ExtensionContext
				| undefined;
			if (
				latest?.hasUI &&
				latest.sessionManager.getSessionId() === agent.id &&
				modeState().stale.has(agent.id) &&
				!modeState().inLoop
			) {
				scheduleRefresh(agent.id);
			}
		}
	}

	async function showHelp(ctx: ExtensionCommandContext, markdown = readReadme(), heading = "help") {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(markdown, "info");
			return;
		}
		await ctx.ui.custom<void>((tui, theme, _kb, done) => (coverImagesUnderOverlays(tui), new HelpComponent(tui, theme, () => done(), markdown, heading)), {
			overlay: true,
			overlayOptions: overlayOpts("80%"),
		});
	}

	/** Confirm that stays full-screen in orchestrator mode. */
	async function ask(ctx: ExtensionCommandContext, title: string, body: string): Promise<boolean> {
		if (!orchestrating() || ctx.mode !== "tui") return ctx.ui.confirm(title, body);
		const ok = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => (coverImagesUnderOverlays(tui), new ConfirmComponent(tui, theme, done, title, body)), {
			overlay: true,
			overlayOptions: overlayOpts(),
		});
		return ok === true;
	}

	/** Orchestrator: full-screen prompt (new agent / reply). undefined = cancelled. */
	async function promptFullScreen(ctx: ExtensionCommandContext, info: { heading: string; detail: string; action: string }) {
		const text = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => (coverImagesUnderOverlays(tui), new NewAgentPromptComponent(tui, theme, done, info)), {
			overlay: true,
			overlayOptions: overlayOpts(),
		});
		return text?.trim() ? text.trim() : undefined;
	}

	/**
	 * Stop a running background agent so it can be taken over in the foreground. Returns the
	 * messages that were still queued for it (cancelAgent drops them), or undefined if it didn't exit.
	 */
	async function stopForTakeover(id: string): Promise<string[] | undefined> {
		const pending = [...(getAgent(id)?.pending ?? [])];
		cancelAgent(id);
		const until = Date.now() + 6000;
		while (getAgent(id)?.proc && Date.now() < until) await sleep(100);
		return getAgent(id)?.proc ? undefined : pending;
	}

	/**
	 * Orchestrator: get ready to leave the current session. Attached sessions run in the background
	 * already, so there's nothing to do. A taken-over session that's mid-run is stopped here and
	 * handed to a background agent; the returned function starts that agent (call it after the
	 * switch, once this window no longer holds the session).
	 */
	async function prepareLeave(ctx: ExtensionCommandContext): Promise<(() => void) | undefined> {
		const ms = modeState();
		const id = ctx.sessionManager.getSessionId();
		const wasTakenOver = ms.takenOver.delete(id);
		ms.takeoverWhenDone.delete(id);
		ms.stale.delete(id);
		// Sticky takeover: ending the main's takeover while a visit is open — restore the main's
		// chat first so the abort/handoff below acts on the real foreground tree, not the visit view.
		if (wasTakenOver && isVisiting()) {
			const tui = activeInboxTui(ctx);
			if (tui) closeVisit(tui);
		}
		if (!orchestrating() || !wasTakenOver || isHome(ctx) || (ctx.isIdle() && !ctx.hasPendingMessages())) return undefined;
		const file = ctx.sessionManager.getSessionFile();
		const cwd = ctx.cwd;
		const title = pi.getSessionName() ?? cleanTitle(String(rowCache.find((r) => r.info.id === id)?.title ?? "session")).slice(0, 120);
		const model = currentModel(ctx);
		const dropped = ctx.hasPendingMessages();
		ctx.abort();
		await ctx.waitForIdle();
		return () => {
			sendToAgent({ id, cwd, sessionFile: file, title, text: CONTINUE_MSG, model });
			const c = G.__piInboxAgentsCtx as ExtensionContext | undefined;
			try {
				c?.ui.notify(
					`"${title.slice(0, 50)}" was mid-run: it continues in the background${dropped ? " (its queued messages were dropped)" : ""}.`,
					"info",
				);
			} catch {
				// stale context
			}
		};
	}

	/**
	 * Orchestrator: reload the attached session from disk so pi's chat view shows what the background
	 * agent did. Also completes a pending takeover (`t` on a working agent) once its run has ended.
	 */
	async function refreshCurrent(ctx: ExtensionCommandContext) {
		const ms = modeState();
		const id = ctx.sessionManager.getSessionId();
		const file = ctx.sessionManager.getSessionFile();
		// Between two queued runs: the agent has no process (its next run is held for us), so the
		// file is complete and safe to reload even though the agent still counts as running.
		const between = ms.betweenRuns.delete(id) && !getAgent(id)?.proc;
		try {
			if (!orchestrating() || isHome(ctx) || !file || ms.takenOver.has(id)) return;
			// Never reload-switch while a visit is mounted: the chat area shows the visit;
			// the main's transcript is stashed and its runs keep going.
			if (isVisiting()) return;
			if (isRunning(getAgent(id)) && !between) {
				ms.wasRunning.add(id); // reloads when it finishes
				return;
			}
			if (!ctx.isIdle()) return;
			ms.stale.delete(id);
			const takeover = !between && ms.takeoverWhenDone.delete(id);
			if (takeover) {
				ms.takenOver.add(id);
				releaseAgent(id); // a foreground session from now on
			}
			const draft = ctx.ui.getEditorText();
			await ctx.switchSession(file, {
				withSession: async (c) => {
					if (draft) c.ui.setEditorText(draft);
					if (takeover) c.ui.notify("🎮 Taken over: this session now runs here, like plain pi. ctrl+q: orchestrator · ctrl+q → h: hand back.", "info");
				},
			});
		} finally {
			if (between) releaseHold(id); // start the queued run now that the chat shows the last one
		}
	}

	/** A new session is safe to open once its initial user prompt is on disk. */
	function sessionReadyToOpen(file: string): boolean {
		try {
			return SessionManager.open(file)
				.getBranch()
				.some(
					(e: any) =>
						e?.type === "message" && e.message?.role === "user",
				);
		} catch {
			return false;
		}
	}

	/**
	 * Orchestrator: show the submitted prompt immediately, wait for that prompt
	 * to reach disk, then open the session and start its assistant stream.
	 * Streaming assistant output before the switch would remain in regular
	 * terminal scrollback and be replayed below "Resumed session".
	 */
	function watchStarted(id: string, ctx: ExtensionContext) {
		const ms = modeState();
		ms.openWhenReady = id;
		showStartingPrompt(ctx, getAgent(id));
		const until = Date.now() + 10 * 60_000;
		const timer = setInterval(() => {
			if (ms.openWhenReady !== id) return clearInterval(timer);
			const a = getAgent(id);
			const file = a?.sessionFile ?? findSessionFile(id);
			if (a && file && !a.sessionFile) a.sessionFile = file;
			const p = (G.__piInboxPi ?? pi) as ExtensionAPI;
			if (file && sessionReadyToOpen(file)) {
				clearInterval(timer);
				const c =
					(G.__piInboxAgentsCtx as ExtensionContext | undefined) ?? ctx;
				// A taken-over main remains the real foreground session. The new agent is
				// already a background process; mount it as a visit directly instead of
				// sending /orchestrator open (which historically switched sessions).
				if (isStickyMain(c)) {
					ms.openWhenReady = undefined;
					const tui = activeInboxTui(c);
					const live = getAgent(id);
					if (
						tui &&
						live &&
						openVisit(tui, c, {
							mainId: c.sessionManager.getSessionId(),
							id,
							file,
							cwd: live.cwd,
							title: live.title,
							modelRegistry: (c as any).modelRegistry,
							recordedModel: sessionModel(file),
						})
					) {
						uiState.selectedId = id;
						markRead(id);
						showModeWidget(c);
						showLiveStream(c);
					} else if (c.hasUI) {
						c.ui.notify(
							"The new agent is running in the background, but its visit view couldn't open. The taken-over main was left untouched.",
							"error",
						);
					}
					return;
				}
				void Promise.resolve(
					p.sendUserMessage(`/orchestrator open ${id}`, {
						expandPromptTemplates: true,
					}),
				).catch(() => {});
				return;
			}
			if (!a || !isRunning(a) || Date.now() > until) {
				// Ended (failed / cancelled) before writing a session: back to the list, which shows why.
				clearInterval(timer);
				ms.openWhenReady = undefined;
				const c = G.__piInboxAgentsCtx as ExtensionContext | undefined;
				if (c?.hasUI) showLiveStream(c);
				if (orchestrating() && !ms.inLoop) reopenInbox((s, o) => p.sendUserMessage(s, o));
			}
		}, 750);
	}

	/** `/orchestrator open <id>` (internal): open a just-started agent attached, if you're still waiting at home. */
	async function openStarted(ctx: ExtensionCommandContext, id: string) {
		const ms = modeState();
		if (ms.openWhenReady !== id) return;
		ms.openWhenReady = undefined;
		showLiveStream(ctx);
		if (!orchestrating()) return;
		const a = getAgent(id);
		const file = a?.sessionFile ?? findSessionFile(id);
		if (!file) return;
		uiState.selectedId = id;
		// Safety fallback for a delayed /orchestrator open command: a sticky main
		// visits the new background agent and never switches/prepareLeaves.
		if (isStickyMain(ctx)) {
			const tui = activeInboxTui(ctx);
			if (
				tui &&
				a &&
				openVisit(tui, ctx, {
					mainId: ctx.sessionManager.getSessionId(),
					id,
					file,
					cwd: a.cwd,
					title: a.title,
					modelRegistry: (ctx as any).modelRegistry,
					recordedModel: sessionModel(file),
				})
			) {
				markRead(id);
				showModeWidget(ctx);
				showLiveStream(ctx);
			}
			return;
		}
		if (!isHome(ctx)) return;
		const draft = ctx.ui.getEditorText();
		await ctx.switchSession(file, {
			withSession: async (c) => {
				if (draft) c.ui.setEditorText(draft);
			},
		});
	}

	/** `/orchestrator movedir <json>` (internal, from ctrl+w inside a session): move it to another working directory. */
	async function moveSessionCommand(ctx: ExtensionCommandContext, arg: string) {
		let o: { id?: string; dir?: string; file?: string };
		try {
			o = JSON.parse(arg);
		} catch {
			return;
		}
		const id = typeof o.id === "string" ? o.id : undefined;
		const dir = typeof o.dir === "string" ? o.dir : undefined;
		if (!id || !dir) return;
		if (isRunning(getAgent(id)))
			return ctx.ui.notify("That agent is working: wait for it to finish or stop it (c) before moving it.", "warning");
		const live = readLive().get(id);
		const ours = live && (live.pid === process.pid || live.pid === getAgent(id)?.pid || live.bgParent === process.pid);
		if (live && !ours) {
			return ctx.ui.notify(
				live.bgParent
					? `It's a background agent of another pi (pid ${live.bgParent}) — stop it there first.`
					: `It's open in another pi window (pid ${live.pid}) — close it there first.`,
				"warning",
			);
		}
		const file = (typeof o.file === "string" && fs.existsSync(o.file) ? o.file : undefined) ?? getAgent(id)?.sessionFile ?? findSessionFile(id);
		if (!file || !fs.existsSync(file)) return ctx.ui.notify("That session isn't saved yet — nothing to move.", "warning");
		try {
			const moved = moveSessionDir(file, dir);
			const a = getAgent(id);
			if (a) setAgentDir(a.id, dir, moved);
			if (ctx.sessionManager.getSessionId() === id) {
				// This window holds it (attached / taken over): reopen at the new path, keeping the draft.
				const draft = ctx.ui.getEditorText();
				await ctx.switchSession(moved, {
					withSession: async (c) => {
						if (draft) c.ui.setEditorText(draft);
						c.ui.notify(`📁 Session moved to ${prettyDir(dir)} — it now runs there.`, "info");
					},
				});
			} else {
				ctx.ui.notify(`📁 Session moved to ${prettyDir(dir)} — replies to it now run there.`, "info");
			}
			rowCache = [];
			(globalThis as any)[ROWS_KEY] = [];
		} catch (e) {
			ctx.ui.notify(`Move failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	}

	/** Orchestrator: make the current attached session run in this window (waits for a background run to finish). */
	async function takeOverCurrent(ctx: ExtensionCommandContext) {
		const ms = modeState();
		const id = ctx.sessionManager.getSessionId();
		if (!orchestrating()) return ctx.ui.notify("/takeover is for orchestrator mode (/orchestrator).", "info");
		if (isHome(ctx)) return ctx.ui.notify("Pick a session first (ctrl+q, then t on it).", "info");
		// While visiting, the current foreground session IS the taken-over main: /takeover
		// would target the visited view. Close the visit instead — the main is already taken over.
		if (isVisiting()) {
			const tui = activeInboxTui(ctx);
			if (tui) closeVisit(tui);
			showModeWidget(ctx);
			showLiveStream(ctx);
			return ctx.ui.notify("Already taken over — you're back on it. The visited session keeps running in the background.", "info");
		}
		if (ms.takenOver.has(id)) return ctx.ui.notify("Already taken over: this session runs here.", "info");
		ms.takeoverWhenDone.add(id);
		if (isRunning(getAgent(id))) {
			showModeWidget(ctx);
			return ctx.ui.notify("⏳ It's working in the background. It takes over here as soon as this run finishes.", "info");
		}
		await refreshCurrent(ctx);
	}

	/** Orchestrator: leave the current session (it stays saved) and return to the blank home session. */
	async function goHome(ctx: ExtensionCommandContext, opts: { reopen?: boolean } = {}): Promise<boolean> {
		if (isHome(ctx)) return true;
		const ms = modeState();
		// End a visit first: the visited session goes back to being a pure background
		// agent; the main (taken-over) session's tree is restored live.
		if (isVisiting()) {
			const tui = activeInboxTui(ctx);
			if (tui) closeVisit(tui);
		}
		const resume = await prepareLeave(ctx);
		// session_start on the new blank session reopens the orchestrator (unless reopen: false).
		ms.skipReopen = opts.reopen === false;
		const r = await ctx.newSession();
		if (r.cancelled) ms.skipReopen = false;
		else resume?.();
		return !r.cancelled;
	}

	async function setOrchestrator(ctx: ExtensionCommandContext, on: boolean) {
		const ms = modeState();
		if (!on) {
			ms.on = false;
			showModeWidget(ctx);
			ctx.ui.notify("Orchestrator mode off: this window is a normal session again.", "info");
			return;
		}
		ms.on = true;
		if (isHome(ctx)) return openInbox(ctx);
		// The current session stays saved and listed; the window moves to a blank home.
		if (!(await goHome(ctx))) ms.on = false;
	}

	async function openInbox(ctx: ExtensionCommandContext) {
		if (ctx.mode !== "tui") {
			// Plain-text fallback for non-interactive modes.
			const rows = await loadRows(viewedSession(ctx).id);
			const lines = rows
				.filter((r) => !r.meta.archivedAt && !r.filtered)
				.sort((a, b) => Number(!!b.meta.pinnedAt) - Number(!!a.meta.pinnedAt) || b.info.modified.getTime() - a.info.modified.getTime())
				.map((r) => `${r.meta.pinnedAt ? "★" : " "} ${r.live?.state === "working" ? "working" : r.tail.status}  ${r.title}  (${shortCwd(r.info.cwd)}, ${relTime(r.info.modified)})`);
			ctx.ui.notify(lines.join("\n") || "Inbox zero", "info");
			return;
		}
		const ms = modeState();
		// Never stack two inboxes (e.g. ctrl+q racing the orchestrator's own reopen).
		for (let i = 0; i < 20 && ms.inLoop; i++) await sleep(25);
		if (ms.inLoop) return;
		ms.inLoop = true;
		ms.openWhenReady = undefined; // you came back to the list: don't yank you into a just-started agent
		showLiveStream(ctx);
		try {
			await inboxLoop(ctx);
		} finally {
			ms.inLoop = false;
			// Inline images are blanked while the inbox is up (see coverImagesUnderOverlays);
			// redraw now so they come back without waiting for the next keystroke.
			((globalThis as any)[INBOX_TUI_KEY] as TUI | undefined)?.requestRender();
		}
	}

	async function inboxLoop(ctx: ExtensionCommandContext) {
		const foregroundId = ctx.sessionManager.getSessionId();
		const foregroundFile = ctx.sessionManager.getSessionFile();
		const viewed = viewedSession(ctx);
		// Selection and the current-row marker follow the screen, not the
		// foreground runtime kept alive behind a sticky-takeover visit.
		if (orchestrating() && !isHome(ctx)) uiState.selectedId = viewed.id;
		// Refresh stale row identity before the first paint, not on the timer.
		if (
			rowCache.length === 0 ||
			(uiState.selectedId &&
				!rowCache.some((r) => r.info.id === uiState.selectedId)) ||
			rowCache.some((r) => r.isCurrent !== (r.info.id === viewed.id))
		) {
			rowCache = await loadRows(viewed.id);
			(globalThis as any)[ROWS_KEY] = rowCache;
		}

		for (;;) {
			const atHome = orchestrating() && isHome(ctx);
			let result = await ctx.ui.custom<InboxResult>(
				(tui, theme, kb, done) => {
					(globalThis as any)[INBOX_TUI_KEY] = tui;
					coverImagesUnderOverlays(tui);
					return new InboxComponent(
						tui,
						theme,
						kb,
						done,
						uiState,
						viewed.id,
						rowCache,
						(rows) => {
							rowCache = rows;
							(globalThis as any)[ROWS_KEY] = rows; // feeds the dir picker's "recent" suggestions
						},
						atHome,
						(row, name) => {
							// Working (or not saved yet) background agent: its process applies the name itself.
							if (row.bg && (isRunning(row.bg) || !row.info.path)) renameAgent(row.bg.id, name);
							else if (row.info.id === foregroundId) pi.setSessionName(name);
							else if (!row.info.path) throw new Error("session isn't saved yet, try again in a moment");
							else SessionManager.open(row.info.path).appendSessionInfo(name);
						},
					);
				},
				{ overlay: true, overlayOptions: overlayOpts() },
			);
			refreshFooter(ctx);

			if (!result || result.action === "close") {
				// Back to an attached session whose run ended while the orchestrator was up: reload it.
				const ms = modeState();
				if (
					orchestrating() &&
					(ms.stale.has(foregroundId) ||
						ms.takeoverWhenDone.has(foregroundId))
				) await refreshCurrent(ctx);
				return;
			}

			if (result.action === "home") {
				// Visiting: h means "back to the main (taken-over) session", not to the blank home —
				// the main is the window's foreground session; end the visit and show it live.
				if (isVisiting()) {
					const tui = activeInboxTui(ctx);
					if (tui) {
						closeVisit(tui);
						showModeWidget(ctx);
						showLiveStream(ctx);
					}
					return;
				}
				await goHome(ctx);
				return;
			}

			if (result.action === "exitMode") {
				await setOrchestrator(ctx, false);
				return;
			}

			if (result.action === "quit") {
				ctx.shutdown();
				return;
			}

			if (result.action === "help") {
				await showHelp(ctx);
				continue;
			}

			if (result.action === "new") {
				let model = isVisiting()
					? nextSessionModel(viewed.id, viewed.file)
					: currentModel(ctx);
				if (result.pickModel) {
					const picked = await pickModel(ctx, model);
					if (!picked) continue;
					model = picked;
				}
				// Sticky main: composing/starting a new background agent is NOT a handback.
				// Keep the foreground AgentSession untouched, type in its editor under a one-shot
				// new-agent target, then visit the new session when its file appears.
				if (isStickyMain(ctx)) {
					if (isVisiting()) {
						const tui = activeInboxTui(ctx);
						if (tui) closeVisit(tui);
						showLiveStream(ctx);
					}
					setReplyTarget({ kind: "new", cwd: viewed.cwd, model }, ctx);
					return;
				}
				// No sticky main: retain the existing blank-home compose flow.
				setReplyTarget({ kind: "new", cwd: viewed.cwd, model }, ctx);
				if (orchestrating() && !isHome(ctx) && !(await goHome(ctx, { reopen: false }))) {
					setReplyTarget(undefined, ctx);
					continue;
				}
				return;
			}

			if (result.action === "cancel") {
				const row = result.row;
				if (await ask(ctx, "Cancel background agent?", `Stop "${row.title.slice(0, 80)}"? Completed steps stay saved; you can reply later to continue.`))
					cancelAgent(row.info.id);
				continue;
			}

			if (result.action === "queue") {
				await manageQueue(
					ctx,
					result.row.info.id,
					result.row.title,
				);
				rowCache = await loadRows(viewed.id);
				(globalThis as any)[ROWS_KEY] = rowCache;
				continue;
			}

			if (result.action === "movedir") {
				const row = result.row;
				// Live guards: the file mustn't move while someone holds it (this window included).
				const live = readLive().get(row.info.id);
				const ours = live && (live.pid === process.pid || live.pid === getAgent(row.info.id)?.pid || live.bgParent === process.pid);
				if (isRunning(getAgent(row.info.id))) {
					ctx.ui.notify("That agent is working: wait for it to finish or cancel it (c) before moving it.", "warning");
					continue;
				}
				if (live && !ours) {
					ctx.ui.notify(
						live.bgParent
							? `It's a background agent of another pi (pid ${live.bgParent}) — stop it there first.`
							: `It's open in another pi window (pid ${live.pid}) — close it there first.`,
						"warning",
					);
					continue;
				}
				if (!row.info.path || !fs.existsSync(row.info.path)) {
					ctx.ui.notify("That session isn't saved yet — nothing to move.", "warning");
					continue;
				}
				const pick = await pickDir(ctx, {
					title: `move "${row.title.slice(0, 50)}" to directory`,
					base: row.info.cwd,
					initial: row.info.cwd,
					hint: "rewrites the session's cwd and re-files it; the next reply runs there",
				});
				if (!pick || pick === row.info.cwd) continue;
				try {
					const moved = moveSessionDir(row.info.path, pick);
					const a = getAgent(row.info.id);
					if (a) setAgentDir(a.id, pick, moved);
					if (row.info.id === foregroundId && !isHome(ctx)) {
						// Only the real foreground runtime needs a native reopen.
						// The viewed-row marker does not imply foreground ownership.
						await ctx.switchSession(moved, {
							withSession: async (c) => {
								c.ui.notify(`📁 Session moved to ${prettyDir(pick)} — it now runs there.`, "info");
							},
						});
					} else {
						ctx.ui.notify(`📁 Session moved to ${prettyDir(pick)} — replies to it now run there.`, "info");
					}
					rowCache = [];
					(globalThis as any)[ROWS_KEY] = [];
				} catch (e) {
					ctx.ui.notify(`Move failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				}
				continue;
			}

			if (result.action === "view") {
				const row = result.row;
				// peeking counts as looking — except the session you're in: its manual unread (blue ») is intentional
				if (!row.isCurrent) markRead(row.info.id);
				const r: AgentViewResult = await ctx.ui.custom<AgentViewResult>(
					(tui, theme, kb, done) =>
						new AgentViewComponent(tui, theme, kb, done, {
							id: row.info.id,
							title: row.title,
							cwd: row.info.cwd,
							sessionFile: row.info.path || undefined,
							fullHeight: orchestrating(),
						}),
					{ overlay: true, overlayOptions: overlayOpts() },
				);
				rowCache = await loadRows(viewed.id);
				(globalThis as any)[ROWS_KEY] = rowCache;
				if (r?.action === "cancel") cancelAgent(row.info.id);
				if (r?.action === "reply") {
					const blocked = sendBlockedReason(row.info.id, row.info.path || undefined, ctx);
					if (blocked) {
						ctx.ui.notify(blocked, "warning");
						continue;
					}
					const file = row.info.path || getAgent(row.info.id)?.sessionFile;
					if (orchestrating()) {
						const wasRunning = isRunning(getAgent(row.info.id));
						const text = await promptFullScreen(ctx, {
							heading: `reply · ${row.title.slice(0, 60)}`,
							detail: `${shortCwd(row.info.cwd)} · ${wasRunning ? "agent is working, so this is queued for its next run" : "runs in the background"}`,
							action: "send",
						});
						if (!text) continue;
						sendToAgent({ id: row.info.id, cwd: row.info.cwd, sessionFile: file, title: row.title, text });
						uiState.selectedId = row.info.id;
						rowCache = await loadRows(viewed.id);
						continue;
					}
					setReplyTarget(
						{ kind: "agent", id: row.info.id, title: row.title, cwd: row.info.cwd, sessionFile: file, agentModel: sessionModel(file) },
						ctx,
					);
					return;
				}
				if (r?.action !== "takeover") continue;
				result = { action: "open", row, takeover: true };
			}

			// Orchestrator: open a session in pi's own chat view without stopping anything. enter =
			// attached (what you send runs in the background), t = taken over (runs here).
			if (result.action === "open" && orchestrating()) {
				const row = result.row;
				const id = row.info.id;
				const ms = modeState();
				if (
					id === foregroundId ||
					(foregroundFile && row.info.path === foregroundFile)
				) {
					if (isHome(ctx)) continue;
					markRead(id); // going back into it from the inbox: a manual unread (blue ») clears
					// Opening the main's own row while a visit is showing: end the visit, show the main live.
					if (isVisiting()) {
						const tui = activeInboxTui(ctx);
						if (tui) {
							closeVisit(tui);
							showModeWidget(ctx);
							showLiveStream(ctx);
						}
						return;
					}
					if (result.takeover) return takeOverCurrent(ctx);
					if (ms.stale.has(id) || ms.takeoverWhenDone.has(id)) await refreshCurrent(ctx);
					return;
				}
				const file = row.info.path || getAgent(id)?.sessionFile;
				if (!file) {
					ctx.ui.notify("That agent hasn't written its session yet. Try again in a moment.", "warning");
					continue;
				}
				// Sticky takeover: a taken-over session is the window's main session. Opening any
				// OTHER session visits it (a view over its file + background agent) — the main keeps
				// running untouched, nothing is aborted, and no prepareLeave handoff happens.
				const sticky = ms.takenOver.size > 0 || ms.takeoverWhenDone.size > 0
					? (ms.takenOver.values().next().value ?? ms.takeoverWhenDone.values().next().value)
					: undefined;
				if (sticky && sticky !== id && !result.takeover) {
					const tui = activeInboxTui(ctx);
					if (tui && openVisit(tui, ctx, {
						mainId: String(sticky),
						id,
						file,
						cwd: row.info.cwd,
						title: row.title,
						modelRegistry: (ctx as any).modelRegistry,
						recordedModel: sessionModel(file),
					})) {
						markRead(id); // visiting counts as looking
						showModeWidget(ctx);
						showLiveStream(ctx);
						return; // stay in orchestrator: the visit replaced the chat view
					}
					// Sticky means sticky: never fall through to the real switch, because that
					// calls prepareLeave(), aborts the main, and appends CONTINUE_MSG. If Pi's
					// TUI internals changed, refuse the visit and preserve the takeover.
					ctx.ui.notify(
						"Couldn't open the visit view without interrupting the taken-over session. The main is still running; run /compat for details.",
						"error",
					);
					continue;
				}
				const live = readLive().get(id);
				const ours = live && (live.pid === process.pid || live.pid === getAgent(id)?.pid || live.bgParent === process.pid);
				if (live && !ours) {
					const ok = await ask(ctx,
						"Session is open elsewhere",
						live.stuckMin
							? `Pi process ${live.pid} still holds this session but looks stuck (no activity for ${live.stuckMin}m, likely an orphan from a closed tab; \`kill -9 ${live.pid}\` clears it). Open here anyway?`
							: `This session is ${live.state === "working" ? "WORKING" : "open"} in another pi process (pid ${live.pid}). Driving it from here too can create diverging branches. Open anyway?`,
					);
					if (!ok) continue;
				}
				const working = isRunning(getAgent(id));
				const resume = await prepareLeave(ctx);
				if (result.takeover) {
					if (working) ms.takeoverWhenDone.add(id);
					else {
						ms.takenOver.add(id);
						releaseAgent(id);
					}
				}
				const takeover = !!result.takeover;
				const r = await ctx.switchSession(file, {
					withSession: async (c) => {
						if (takeover && !working) c.ui.notify("🎮 Taken over: runs here, like plain pi. ctrl+q: orchestrator · ctrl+q → h: hand back.", "info");
						else if (takeover) c.ui.notify("⏳ Still working in the background: it takes over here as soon as this run finishes.", "info");
					},
				});
				if (!r.cancelled) resume?.();
				return;
			}

			if (result.action === "open") {
				const row = result.row;
				if (
					row.info.id === foregroundId ||
					(foregroundFile && row.info.path === foregroundFile)
				) {
					if (orchestrating() && isHome(ctx)) continue; // home itself isn't listed, but be safe
					markRead(row.info.id); // going back into it from the inbox: a manual unread (blue ») clears
					ctx.ui.notify("Already in this session", "info");
					return;
				}
				let carried: string[] = [];
				let stopped = false;
				if (isRunning(getAgent(row.info.id))) {
					if (!orchestrating()) {
						ctx.ui.notify("That agent is still working: wait for it to finish, or cancel it (c), then open it here.", "warning");
						continue;
					}
					const queued = getAgent(row.info.id)?.pending.length ?? 0;
					const ok = await ask(ctx,
						"Take over a working agent?",
						`"${row.title.slice(0, 80)}" is still working. Taking it over stops the background run (completed steps are saved) and opens it here.${queued ? ` Its ${queued} queued message(s) are moved to the editor.` : ""} Send "continue" to resume. Take over?`,
					);
					if (!ok) continue;
					const pending = await stopForTakeover(row.info.id);
					if (!pending) {
						ctx.ui.notify("The agent didn't stop in time. Try again in a moment.", "warning");
						continue;
					}
					carried = pending;
					stopped = true;
				}
				const file = row.info.path || getAgent(row.info.id)?.sessionFile;
				if (!file) {
					ctx.ui.notify("That agent hasn't written its session yet.", "warning");
					continue;
				}
				if (!ctx.isIdle() || ctx.hasPendingMessages()) {
					const ok = await ask(ctx,
						"Current session is working",
						"The current session is still working. Switching will abort the in-flight run (completed steps are saved and it can be resumed later) and drop any queued messages. Switch anyway?",
					);
					if (!ok) continue;
				}
				const live = readLive().get(row.info.id);
				if (live && live.pid !== process.pid) {
					const ok = await ask(ctx,
						"Session is open elsewhere",
						live.stuckMin
							? `Pi process ${live.pid} still holds this session but looks stuck (claims working, no activity for ${live.stuckMin}m — likely an orphan from a closed tab; if so, \`kill -9 ${live.pid}\` clears it). Open here anyway?`
							: `This session is ${live.state === "working" ? "WORKING" : "open"} in another Pi process (pid ${live.pid}). Opening it here too can create diverging branches. Open anyway?`,
					);
					if (!ok) continue;
				}
				releaseAgent(row.info.id); // it's a foreground session from now on
				await ctx.switchSession(file, {
					withSession: async (c) => {
						if (carried.length) c.ui.setEditorText(carried.join("\n\n"));
						if (orchestrating())
							c.ui.notify(
								`📥 Taken over${stopped ? " (background run stopped, send \"continue\" to resume)" : ""}. ctrl+q: orchestrator · ctrl+q → h: hand back.`,
								"info",
							);
					},
				});
				return;
			}
		}
	}

	pi.registerCommand("inbox", {
		description: "Visual todo-box of all sessions: status, pin, archive (ctrl+q)",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim();
			const items = [
				{ value: "help", label: "help", description: "Show the Inbox README" },
				{ value: "filters", label: "filters", description: "Show the session filter rules and what they hide" },
			].filter((i) => i.value.startsWith(p));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (["help", "?", "docs", "readme"].includes(a)) return showHelp(ctx);
			if (["filters", "filter", "blocklist"].includes(a)) {
				const rows = await loadRows(viewedSession(ctx).id);
				return showHelp(ctx, filtersReport(rows), "filters");
			}
			return openInbox(ctx);
		},
	});

	pi.registerCommand("orchestrator", {
		description: "Inbox orchestrator mode: this window becomes a full-screen agent control panel (toggle | on | off | home)",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim();
			const items = [
				{ value: "on", label: "on", description: "Turn orchestrator mode on" },
				{ value: "off", label: "off", description: "Turn orchestrator mode off (this window becomes a normal session)" },
				{ value: "home", label: "home", description: "Leave this session (it keeps running in the background) and return to the orchestrator" },
				{ value: "takeover", label: "takeover", description: "Run this session here, like plain pi (same as /takeover)" },
			].filter((i) => i.value.startsWith(p));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			// movedir is matched on raw args (it carries a JSON payload with case-sensitive paths).
			if (raw.startsWith("movedir ")) return moveSessionCommand(ctx, raw.slice(8).trim()); // internal: ctrl+w on an open session
			const a = raw.toLowerCase();
			if (a === "" || a === "toggle") return setOrchestrator(ctx, !orchestrating());
			if (a === "on") return setOrchestrator(ctx, true);
			if (a === "off") return setOrchestrator(ctx, false);
			if (a === "refresh") return refreshCurrent(ctx); // internal: reload an attached session after its run
			if (a.startsWith("open ")) return openStarted(ctx, args.trim().slice(5).trim()); // internal: a new agent's session is on disk
			if (a === "clone") return cloneLatest(ctx); // internal: /clone on an attached session that's working
			if (a === "takeover") return takeOverCurrent(ctx);
			if (a === "home") {
				if (!orchestrating()) return ctx.ui.notify("Orchestrator mode is off. /orchestrator turns it on.", "info");
				if (isHome(ctx)) return openInbox(ctx);
				await goHome(ctx);
				return;
			}
			ctx.ui.notify("Usage: /orchestrator [on|off|home]", "warning");
		},
	});

	// Last-resort sticky guard for ANY session-switch path, not just the orchestrator list.
	// Pi's native switch aborts/disposes the current AgentSession. If the current session is the
	// taken-over main, turn a resume/open into a visit and cancel the native switch. Explicit
	// handback/takeover paths call prepareLeave first, which removes `takenOver`, so they pass.
	pi.on("session_before_switch", async (e: any, ctx: ExtensionContext) => {
		if (!orchestrating()) return undefined;
		const ms = modeState();
		const mainId = ctx.sessionManager.getSessionId();
		if (!ms.takenOver.has(mainId)) return undefined;
		const file = typeof e?.targetSessionFile === "string"
			? e.targetSessionFile
			: undefined;
		if (!file) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"The taken-over session is still the main. Hand it back before starting a new foreground session.",
					"warning",
				);
			}
			return { cancel: true };
		}
		let target: SessionManager;
		try {
			target = SessionManager.open(file);
		} catch {
			if (ctx.hasUI) ctx.ui.notify("Couldn't open that session; the taken-over main was left untouched.", "error");
			return { cancel: true };
		}
		const id = target.getSessionId();
		if (id === mainId) {
			// Re-selecting the main is only a reveal, never a teardown/reload. A move to
			// a new file path is allowed only while idle (moveSessionDir's own guard).
			if (isVisiting()) {
				const tui = activeInboxTui(ctx);
				if (tui) closeVisit(tui);
				showModeWidget(ctx);
				showLiveStream(ctx);
			}
			if (file === ctx.sessionManager.getSessionFile()) return { cancel: true };
			if (!ctx.isIdle()) {
				ctx.ui.notify("The taken-over session is still running; it was not reloaded.", "warning");
				return { cancel: true };
			}
			return undefined;
		}
		const tui = activeInboxTui(ctx);
		if (!tui) {
			if (ctx.hasUI) ctx.ui.notify("Couldn't open the visit view; the taken-over main is still running.", "error");
			return { cancel: true };
		}
		if (isVisiting()) closeVisit(tui);
		const branch = target.getBranch() as any[];
		const firstUser = branch.find(
			(entry: any) =>
				entry?.type === "message" && entry.message?.role === "user",
		) as any;
		const title =
			target.getSessionName?.() ??
			cleanTitle(messageText(firstUser?.message?.content) || "session").slice(0, 120);
		if (!openVisit(tui, ctx, {
			mainId,
			id,
			file,
			cwd: target.getCwd(),
			title,
			modelRegistry: (ctx as any).modelRegistry,
			recordedModel: sessionModel(file),
		})) {
			ctx.ui.notify("Couldn't open the visit view; the taken-over main is still running.", "error");
			return { cancel: true };
		}
		markRead(id);
		showModeWidget(ctx);
		showLiveStream(ctx);
		return { cancel: true };
	});

	// Attached session with a background run going: pi's on-screen copy is a snapshot, and these
	// would write to the session file at the same time as the agent. Fine once the run finishes.
	const busyGuard = (what: string) => async (_e: any, ctx: ExtensionContext) => {
		// A visited session is never this window's session; compaction/tree here act on the
		// main, which is exactly why they're guarded: /compact and /tree target the hidden
		// main while you look at the visit. Guard them so nothing writes behind your back.
		if (isVisiting()) {
			if (ctx.hasUI) ctx.ui.notify(`Can't ${what} while visiting another session. esc returns to your taken-over session first.`, "warning");
			return { cancel: true };
		}
		if (!attachedBusy(ctx)) return undefined;
		if (ctx.hasUI) ctx.ui.notify(`Can't ${what} while this session is working in the background. Wait for it (or ctrl+shift+s to stop it).`, "warning");
		return { cancel: true };
	};
	pi.on("session_before_compact", busyGuard("compact"));
	pi.on("session_before_tree", busyGuard("navigate the tree"));
	// /fork and /clone only create a new session file, so they're allowed mid-run. /fork branches from an
	// earlier user message, which is already in the on-screen snapshot. /clone copies "the current
	// position", but the snapshot is behind the background agent, so we take over: clone from disk up to
	// the last completed step instead (the in-flight step is left out).
	pi.on("session_before_fork", async (e: any, ctx: ExtensionContext) => {
		if (!attachedBusy(ctx) || e?.position !== "at") return undefined;
		const p = (G.__piInboxPi ?? pi) as ExtensionAPI;
		setTimeout(() => void Promise.resolve(p.sendUserMessage("/orchestrator clone", { expandPromptTemplates: true })).catch(() => {}), 50);
		return { cancel: true };
	});

	/** Orchestrator: clone an attached session that's working in the background, from disk, up to its last completed step. */
	async function cloneLatest(ctx: ExtensionCommandContext) {
		const file = ctx.sessionManager.getSessionFile();
		if (!file || !fs.existsSync(file)) return ctx.ui.notify("Nothing to clone yet.", "info");
		const sm = SessionManager.open(file, ctx.sessionManager.getSessionDir());
		// Last point on the branch with no unanswered tool calls, after the agent has said something.
		// A trailing user message is the prompt still being worked on, so it's left out too.
		const pending = new Set<string>();
		let leaf: string | undefined;
		let sawAssistant = false;
		for (const entry of sm.getBranch() as any[]) {
			const m = entry?.type === "message" ? entry.message : undefined;
			if (m?.role === "assistant") {
				sawAssistant = true;
				for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === "toolCall" && b.id) pending.add(b.id);
			} else if (m?.role === "toolResult") pending.delete(m.toolCallId);
			if (sawAssistant && pending.size === 0 && m?.role !== "user") leaf = entry.id;
		}
		if (!leaf) return ctx.ui.notify("Nothing to clone yet: the background agent hasn't completed a step.", "info");
		const behind = sm.getLeafId() !== leaf;
		const cloned = sm.createBranchedSession(leaf);
		if (!cloned || !fs.existsSync(cloned)) return ctx.ui.notify("Clone failed: couldn't write the new session.", "error");
		await ctx.switchSession(cloned, {
			withSession: async (c) => {
				c.ui.notify(
					behind
						? "Cloned to new session, up to the agent's last completed step (the step in flight isn't included)."
						: "Cloned to new session.",
					"info",
				);
			},
		});
	}

	/** Orchestrator: stop the attached session's background run (completed steps stay saved). */
	function stopCurrent(ctx: ExtensionContext) {
		// Visiting: stop the visited session's background run (the main keeps going).
		if (isVisiting()) {
			const vid = visitState().visit!.id;
			if (!isRunning(getAgent(vid)))
				return ctx.ui.notify("Nothing running in the background for the visited session.", "info");
			cancelAgent(vid);
			showModeWidget(ctx);
			return ctx.ui.notify("■ Stopped the visited session's background run. Completed steps are saved; send a message to continue.", "info");
		}
		const id = ctx.sessionManager.getSessionId();
		if (!isAttached(ctx) || !isRunning(getAgent(id)))
			return ctx.ui.notify(isAttached(ctx) ? "Nothing running in the background for this session." : "Use esc to interrupt a session running here.", "info");
		cancelAgent(id);
		ctx.ui.notify("■ Stopped the background run. Completed steps are saved; send a message to continue.", "info");
	}
	pi.registerCommand("queue", {
		description: "Orchestrator: manage this session's queued messages",
		handler: async (_args, ctx) => {
			await manageQueue(ctx);
		},
	});
	pi.registerCommand("stop", {
		description: "Orchestrator: stop this session's background run (ctrl+shift+s)",
		handler: async (_args, ctx) => stopCurrent(ctx),
	});
	pi.registerShortcut("ctrl+shift+s", {
		description: "Orchestrator: stop this session's background run",
		handler: async (ctx) => stopCurrent(ctx),
	});
	pi.registerCommand("takeover", {
		description: "Orchestrator: run this session here, like plain pi (waits for a background run to finish)",
		handler: async (_args, ctx) => takeOverCurrent(ctx),
	});

	pi.registerShortcut("ctrl+q", {
		description: "Open session inbox (the orchestrator, in orchestrator mode)",
		handler: async () => {
			// Shortcuts don't get a command context (needed to switch sessions), so route through the command.
			pi.sendUserMessage("/inbox", { expandPromptTemplates: true });
		},
	});

	// ctrl+w while a new agent's prompt is pending (or on orchestrator home): pick the
	// directory that agent will run in. Not registered as a plain extension shortcut: ctrl+w is the
	// editor's delete-word-backward, so it's consumed contextually in the onTerminalInput handler
	// below (same pattern as esc-cancel) and passes through to the editor everywhere else.
	// (alt+backspace still deletes a word while typing the prompt.)
	async function pickNewAgentDir(ctx: ExtensionContext) {
		const t = getReplyTarget();
		const home = orchestrating() && isHome(ctx);
		if (!t && !home) return;
		const base = t?.kind === "new" ? t.cwd : ctx.cwd;
		const dir = await pickDir(ctx, {
			title: "directory for the new agent",
			base,
			initial: getNextAgentDir() ?? base,
			hint: "agent runs here; its session, skills and AGENTS.md load from this directory",
		});
		if (!dir) return;
		setNextAgentDir(dir);
		showReplyWidget(ctx);
	}

	/**
	 * ctrl+w inside an existing session (attached or taken over): pick a new working directory for
	 * it, then route the move through the internal /orchestrator movedir command — commands own
	 * session switching (switchSession needs a command context; this handler only gets the base one).
	 */
	async function moveCurrentSessionDir(c: ExtensionContext) {
		const id = c.sessionManager.getSessionId();
		if (isRunning(getAgent(id)))
			return c.ui.notify("This session's background run is still going — wait for it or stop it (ctrl+shift+s) before moving it.", "warning");
		const cwd = c.cwd;
		const pick = await pickDir(c, {
			title: "move this session to directory",
			base: cwd,
			initial: cwd,
			hint: "rewrites the session's cwd and re-files it; it keeps running from there",
		});
		if (!pick || pick === cwd) return;
		const file = c.sessionManager.getSessionFile()!;
		const p = (G.__piInboxPi ?? pi) as ExtensionAPI;
		setTimeout(
			() => void Promise.resolve(p.sendUserMessage(`/orchestrator movedir ${JSON.stringify({ id, dir: pick, file })}`, { expandPromptTemplates: true })).catch(() => {}),
			50,
		);
	}

	// ── Reply routing: when a reply target is set, the next message typed in pi's own editor
	// goes to that background agent (or starts a new one) instead of the foreground session.
	// Extension and built-in slash commands run before this hook, so they are never captured.
	pi.on("input", async (event: any, ctx) => {
		let t = getReplyTarget();
		if (event.source !== "interactive") return { action: "continue" };
		// A one-shot new-agent target is valid at blank home OR over the sticky main.
		// Every other stale target is dropped when a real session is on screen.
		const composingNewOverMain =
			t?.kind === "new" && isStickyMain(ctx);
		if (
			t &&
			orchestrating() &&
			!composingNewOverMain &&
			(!isHome(ctx) || t.kind !== "new")
		) {
			setReplyTarget(undefined, ctx);
			t = undefined;
		}
		// Orchestrator home (normally covered by the orchestrator): every message starts a background
		// agent, so home never gets a conversation.
		const text = String(event.text ?? "").trim();
		// Visiting a session (sticky takeover active): the prompt goes to the visited session's
		// background agent — queued if it's working, a new background run if it's idle — never to
		// the hidden main session.
		if (!t && text && isVisiting()) {
			const v = visitState().visit!;
			if (event.images?.length) ctx.ui.notify("Images can't be sent to background agents yet: sent the text only.", "warning");
			// The visit's model comes from its own saved/pending choice, never
			// from the hidden foreground runtime used to host this view.
			sendToAgent({
				id: v.id, cwd: v.cwd, sessionFile: v.file, title: v.title, text,
			});
			showModeWidget(ctx);
			showLiveStream(ctx); // queued count / running state may have changed
			return { action: "handled" };
		}
		// Waiting for a just-started agent to open: more messages queue for it. A sticky main
		// stays foreground throughout, so it has the same pending-agent routing as blank home.
		const pendingId =
			orchestrating() && (isHome(ctx) || isStickyMain(ctx))
				? modeState().openWhenReady
				: undefined;
		const pending = pendingId ? getAgent(pendingId) : undefined;
		if (!t && text && pending) {
			if (event.images?.length) ctx.ui.notify("Images can't be sent to background agents yet: sent the text only.", "warning");
			sendToAgent({
				id: pending.id,
				cwd: pending.cwd,
				title: pending.title,
				text,
			});
			showStartingPrompt(ctx, pending);
			return { action: "handled" };
		}
		if (!t && orchestrating() && isHome(ctx)) t = { kind: "new", cwd: ctx.cwd, model: currentModel(ctx) };
		// Orchestrator, attached session: the message runs as a background agent on this session, so
		// you can switch away mid-run. The chat view reloads from disk when the run finishes.
		if (!t && text && isAttached(ctx)) {
			const id = ctx.sessionManager.getSessionId();
			const wasRunning = isRunning(getAgent(id));
			const firstUser = ctx.sessionManager
				.getBranch()
				.find((e: any) => e?.type === "message" && e.message?.role === "user") as any;
			const title = getAgent(id)?.title ?? pi.getSessionName() ?? cleanTitle(messageText(firstUser?.message?.content) || text).slice(0, 120);
			if (event.images?.length) ctx.ui.notify("Images can't be sent to background agents yet: sent the text only.", "warning");
			sendToAgent({ id, cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile(), title, text, model: currentModel(ctx) });
			modeState().wasRunning.add(id);
			// No notify() here: in pi that's a permanent chat line, so "Queued" outlived the delivery.
			// The live panel lists queued messages instead and drops them once a run picks them up.
			void wasRunning;
			showLiveStream(ctx);
			showModeWidget(ctx);
			return { action: "handled" };
		}
		if (!t) return { action: "continue" };
		if (!text) return { action: "continue" };

		if (t.kind === "agent") {
			const blocked = sendBlockedReason(t.id, t.sessionFile, ctx);
			if (blocked) {
				setReplyTarget(undefined, ctx);
				ctx.ui.notify(`Not sent: ${blocked}`, "warning");
				ctx.ui.setEditorText(event.text);
				return { action: "handled" };
			}
		}
		const preName = t.kind === "new" ? getNextAgentName() : undefined;
		const preDir = t.kind === "new" ? getNextAgentDir() : undefined; // ctrl+w pick; captured before the target drops
		setReplyTarget(undefined, ctx); // one message per target (also drops the pre-name/pre-dir)
		if (event.images?.length) ctx.ui.notify("Images can't be sent to background agents yet — sent the text only.", "warning");

		if (t.kind === "new") {
			const a = spawnAgent({ prompt: text, cwd: preDir ?? t.cwd, model: t.model, title: preName ?? cleanTitle(text).slice(0, 120) });
			// ctrl+r pre-name: the child applies it as its session name (works before the file exists).
			if (preName) renameAgent(a.id, preName);
			uiState.view = "inbox";
			uiState.selectedId = a.id; // the inbox opens on it next time
			ctx.ui.notify(`＋ Started background agent: ${coloredName(ctx.ui.theme, a.id, a.title.slice(0, 60))}`, "info");
		} else {
			const wasRunning = isRunning(getAgent(t.id));
			sendToAgent({ id: t.id, cwd: t.cwd, sessionFile: t.sessionFile, title: t.title, text, model: t.model });
			uiState.view = "inbox";
			uiState.selectedId = t.id;
			ctx.ui.notify(
				wasRunning
					? `⏳ Queued for ${coloredName(ctx.ui.theme, t.id, t.title.slice(0, 50))} — delivered when its current run finishes`
					: `↪ Sent to ${coloredName(ctx.ui.theme, t.id, t.title.slice(0, 50))}`,
				"info",
			);
		}
		// Stay in pi's chat view. At blank home, or over a sticky main, the new agent
		// opens as soon as its session file is ready. Sticky mode opens a visit; it
		// never switches or interrupts the main.
		if (
			orchestrating() &&
			(isHome(ctx) || isStickyMain(ctx))
		) {
			if (t.kind === "new") watchStarted(uiState.selectedId!, ctx);
			else if (isHome(ctx)) reopenInbox((s, o) => pi.sendUserMessage(s, o));
		}
		return { action: "handled" };
	});

	// Changing the model (ctrl+p, ctrl+l, /model) or thinking level (shift+tab) while a reply is
	// pending applies to that reply too. Note: it also changes this session's model, as usual.
	const withLevel = (model: string, level: string | undefined) => `${model.replace(/:[a-z]+$/, "")}${level ? `:${level}` : ""}`;
	pi.on("model_select", async (e: any, ctx) => {
		const t = getReplyTarget();
		if (!t || e.source === "restore" || !e.model) return;
		let level: string | undefined = ctx.thinkingLevel;
		try {
			level ??= pi.getThinkingLevel();
		} catch {
			// not available
		}
		t.model = withLevel(`${e.model.provider}/${e.model.id}`, level);
		showReplyWidget(ctx);
	});
	pi.on("thinking_level_select", async (e: any, ctx) => {
		const t = getReplyTarget();
		if (!t || !e.level) return;
		const base = t.model ?? (t.kind === "agent" ? t.agentModel : undefined) ?? currentModel(ctx);
		if (base) t.model = withLevel(base, e.level);
		showReplyWidget(ctx);
	});

	// esc in pi's editor cancels a pending background-agent reply. Only when the editor has focus
	// and this session is idle, so esc still closes dialogs/autocomplete and interrupts a run.
	pi.on("session_start", async (_e, ctx) => {
		if (!ctx.hasUI) return;
		// A new-agent compose/wait target is valid at blank home OR over the sticky main.
		// Other targets do not survive a real session start/switch.
		const rt = getReplyTarget();
		const sticky = isStickyMain(ctx);
		if (
			rt &&
			orchestrating() &&
			!(rt.kind === "new" && (isHome(ctx) || sticky))
		) {
			setReplyTarget(undefined, ctx);
		}
		// A new-agent pre-name / pre-dir never follows a real switch, but /reload on
		// the sticky main must not cancel an in-progress compose.
		if (!isHome(ctx) && !sticky && (getNextAgentName() || getNextAgentDir())) {
			setNextAgentName(undefined);
			setNextAgentDir(undefined);
			showReplyWidget(ctx);
		}
		// A real switch away cancels auto-open. Remaining on the sticky main does not.
		if (
			orchestrating() &&
			!isHome(ctx) &&
			!sticky &&
			modeState().openWhenReady
		) {
			modeState().openWhenReady = undefined;
			showLiveStream(ctx);
		}
		G.__piInboxEscUnsub?.();
		G.__piInboxEscUnsub = ctx.ui.onTerminalInput((data) => {
			const current =
				(G.__piInboxAgentsCtx as ExtensionContext | undefined) ?? ctx;
			const visit = visitState().visit;
			const tui = activeInboxTui(current);
			if (
				visit && tui && !modeState().inLoop && focusedEditor(true) &&
				handleVisitModelInput(data, current, tui,
					() => sendBlockedReason(visit.id, visit.file, current))
			) return { consume: true };
			// Pi's dequeue key opens our queue manager for an attached
			// background agent. Everywhere else it keeps its built-in meaning.
			if (getKeybindings().matches(data, "app.message.dequeue")) {
				const c =
					(G.__piInboxAgentsCtx as ExtensionContext | undefined) ?? ctx;
				const id = queueTargetId(c);
				if (
					editorFocused() &&
					!modeState().inLoop &&
					!!id &&
					(isVisiting() || !!getAgent(id))
				) {
					void manageQueue(c);
					return { consume: true };
				}
				return undefined;
			}
			// ctrl+w opens the directory picker — for the pending new agent's prompt (or at orchestrator
			// home), and inside an existing session (attached / taken over), where it moves that session
			// to another directory. Everywhere else it's the editor's delete-word-backward, so it passes
			// through untouched. editorFocused() keeps it off menus/pickers/autocomplete, and while the
			// picker itself is up the reply-target check fails (the overlay holds focus), so the
			// picker's own keys always win.
			if (matchesKey(data, "ctrl+w")) {
				const c = (G.__piInboxAgentsCtx as ExtensionContext | undefined) ?? ctx;
				const t = getReplyTarget();
				const home = orchestrating() && isHome(c);
				const composingNewOverMain =
					t?.kind === "new" && isStickyMain(c);
				if (
					editorFocused() &&
					(c.isIdle() || composingNewOverMain) &&
					!modeState().inLoop
				) {
					if (t?.kind === "new" || home) {
						// New agent pending (or about to type one at home): pick its directory.
						void pickNewAgentDir(c);
						return { consume: true };
					}
					if (orchestrating() && c.sessionManager.getSessionFile()) {
						// Inside an existing session: move it to another directory.
						void moveCurrentSessionDir(c);
						return { consume: true };
					}
				}
				return undefined;
			}
			if (matchesKey(data, "escape")) {
				const c =
					(G.__piInboxAgentsCtx as ExtensionContext | undefined) ?? ctx;
				// Visiting a session: esc returns to the main (taken-over) session. The
				// visited one keeps running as a background agent. Don't consume when a
				// dialog/overlay is up (esc closes that first) or the orchestrator list is open.
				if (isVisiting() && editorFocused() && !modeState().inLoop) {
					const tui = activeInboxTui(c);
					if (tui) {
						closeVisit(tui);
						showModeWidget(c);
						showLiveStream(c);
						return { consume: true };
					}
				}
			}
			const target = getReplyTarget();
			if (!target || !matchesKey(data, "escape")) return undefined;
			const c = (G.__piInboxAgentsCtx as ExtensionContext | undefined) ?? ctx;
			const composingNewOverMain =
				target.kind === "new" && isStickyMain(c);
			if (!editorFocused() || (!c.isIdle() && !composingNewOverMain)) return undefined;
			setReplyTarget(undefined, c);
			// Orchestrator home: cancelling a new agent goes back to the list.
			if (orchestrating() && isHome(c)) reopenInbox((s, o) => ((G.__piInboxPi ?? pi) as ExtensionAPI).sendUserMessage(s, o));
			else c.ui.notify("Reply cancelled — messages go to this session again.", "info");
			return { consume: true };
		});
	});

	pi.registerCommand("pin", {
		description: "Toggle pin on the current session",
		handler: async (_args, ctx) => {
				const meta = updateMeta(viewedSession(ctx).id, (m) => {
				m.pinnedAt = m.pinnedAt ? undefined : Date.now();
			});
			ctx.ui.notify(meta.pinnedAt ? "★ Session pinned" : "Session unpinned", "info");
			refreshFooter(ctx);
		},
	});

	pi.registerCommand("archive", {
		description: "Toggle archive (done) on the current session",
		handler: async (_args, ctx) => {
			const meta = updateMeta(viewedSession(ctx).id, (m) => {
				m.archivedAt = m.archivedAt ? undefined : Date.now();
			});
			ctx.ui.notify(meta.archivedAt ? "✓ Session archived — find it under /inbox → Archived" : "↩ Session moved back to inbox", "info");
			refreshFooter(ctx);
		},
	});
}
