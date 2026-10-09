/**
 * Background agents for the Inbox.
 *
 * Every background agent is a short-lived child pi process:
 *   pi --mode json --session-id <id> -- "<message>"
 * with the same settings, skills and extensions as a normal pi (nothing is trimmed).
 * It runs one prompt against its session file, streams JSON events to us on stdout,
 * and exits. Follow-up messages re-run pi on the same session id, so the agent keeps
 * its full context. Messages sent while an agent is working are queued and delivered
 * as the next run when the current one finishes.
 *
 * Children are detached (own session/process group, no tty) and write their JSON events to
 * files under ~/.pi/agent/inbox-agents/ instead of a pipe, so they OUTLIVE the pi that started
 * them: quitting pi, closing the tab, or a shell watchdog killing pi leaves them running.
 * Each agent's state (incl. queued messages) is persisted to <id>.json with an owner heartbeat;
 * any interactive pi that finds an agent whose owner stopped heartbeating adopts it (replays its
 * event file, keeps tailing it, delivers its queue). Stopping goes through a <id>.stop file the
 * child polls (the sandbox only lets a process signal its own children, so an adopter can't kill).
 *
 * The registry lives on globalThis so it survives the inbox extension being
 * re-instantiated when the foreground pi switches sessions.
 *
 * This file lives outside ~/.pi/agent/extensions so pi doesn't load it as an extension.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	BACKGROUND_MCP_AUTO_APPROVE_ENV,
} from "./background-mcp-approval.ts";
import { getAgentDir, getMarkdownTheme, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ───────────────────────────── registry ─────────────────────────────

export type AgentState = "queued" | "working" | "idle" | "error" | "cancelled";

export interface BgAgent {
	id: string;
	cwd: string;
	title: string;
	/** provider/model[:thinking] used for the first run; later runs keep the session's model. */
	model?: string;
	/** Model override for the next run (set when you change the model while replying). */
	nextModel?: string;
	sessionFile?: string;
	state: AgentState;
	/** Messages waiting to be delivered, one per subsequent run. */
	pending: string[];
	/** Set while a run is in flight (our own child, or an adopted orphan). */
	proc?: AgentProc;
	pid?: number;
	/** Prompt of the in-flight run (persisted so an adopter can show it). */
	runPrompt?: string;
	runStartedAt?: number;
	/** Bytes of the event file consumed so far. */
	outOffset?: number;
	createdAt: number;
	updatedAt: number;
	/** Last thing the agent did, e.g. "bash: npm test" or "writing…". */
	activity?: string;
	/** Final text of the last run. */
	lastText?: string;
	error?: string;
	/** Finished and not looked at yet. */
	needsYou: boolean;
	runs: number;
	/** Rolling log of the current run (prompt, tool calls, replies), for the orchestrator's live panel. */
	log: string[];
	/** Assistant text streaming right now (reset at each message end). */
	liveText: string;
	/** Structured transcript of the current run (prompt, tool calls, finished replies), for the live panel. */
	items?: RunItem[];
	/** Reconstructed live transcript of the in-flight run (drives the streaming chat view). */
	liveRun?: LiveRun;
	/** Don't start the next queued run yet (the UI is reloading the transcript between runs). */
	hold?: boolean;
	/** This run is stopping so a selected queued message can run next. */
	restartAfterInterrupt?: boolean;
}

/** Handle to a running agent. kill() always also drops a stop file (works across sandboxes). */
export interface AgentProc {
	pid?: number;
	kill(sig?: NodeJS.Signals): void;
}

export type RunItem = { kind: "prompt" | "tool" | "text" | "error"; text: string };
const ITEMS_MAX = 60;
function addItem(a: BgAgent, item: RunItem) {
	(a.items ??= []).push(item);
	if (a.items.length > ITEMS_MAX) a.items.splice(0, a.items.length - ITEMS_MAX);
}

// ─────────────────── live run (streaming transcript state) ───────────────────
//
// Reconstructs the in-flight run as the same shapes pi's interactive chat view uses,
// from the child's JSON event stream: the user prompt, then assistant messages with
// thinking/text/toolCall blocks (streamed block by block), then tool results. The UI
// renders this with pi's own message components, so the streaming transcript looks
// exactly like a foreground one. Kept bounded: only the last LIVE_MSGS_MAX messages
// are retained (older ones are dropped once rendered; the session file has them).

export interface LiveTool {
	id: string;
	name: string;
	args: any;
	/** Partial or final result content (what ToolExecutionComponent.updateResult takes). */
	result?: { content: any[]; isError: boolean };
}

export interface LiveMsg {
	role: "user" | "assistant";
	/** User text, or an assistant message in pi's wire shape (content blocks, stopReason, …). */
	message?: any;
	text?: string;
	/** Wire message id (user echoes) — the id the child persisted, for transcript dedupe. */
	id?: string;
	/** Live tools (assistant messages render their calls; results update in place). */
	tools?: LiveTool[];
	/** Update counter, bumped whenever this message changed (for UI re-render diffing). */
	rev: number;
}

export interface LiveRun {
	/** prompt + finished messages, oldest first; last may be the streaming one. */
	msgs: LiveMsg[];
	/** Monotonic counter for rev bumps. */
	rev: number;
}

const LIVE_MSGS_MAX = 150;
/** Cap on retained tool-result text per call (results render collapsed by default anyway). */
const LIVE_RESULT_MAX = 24_000;

const newLiveRun = (): LiveRun => ({ msgs: [], rev: 0 });

function liveMsg(a: BgAgent): LiveMsg | undefined {
	const run = a.liveRun;
	if (!run) return undefined;
	const last = run.msgs[run.msgs.length - 1];
	return last?.role === "assistant" ? last : undefined;
}

/** Clamp a tool result so a huge read/output can't balloon the retained run. */
function clampResult(result: { content: any[]; isError: boolean }) {
	const content = result.content.map((b: any) => {
		if (typeof b?.text === "string" && b.text.length > LIVE_RESULT_MAX) {
			const cut = b.text.length - LIVE_RESULT_MAX;
			return { ...b, text: `${b.text.slice(0, LIVE_RESULT_MAX)}\n… (${cut} more bytes; full output is in the transcript after the run)` };
		}
		return b;
	});
	return { content, isError: result.isError };
}

/** Wire assistant message start: begin a new streaming assistant message. */
function liveStartAssistant(a: BgAgent, ev: any) {
	const run = a.liveRun ??= newLiveRun();
	run.msgs.push({ role: "assistant", message: { ...ev.message, content: [] }, tools: [], rev: ++run.rev });
	trimLive(run);
}

function trimLive(run: LiveRun) {
	if (run.msgs.length <= LIVE_MSGS_MAX) return;
	// Never drop the streaming message at the tail.
	run.msgs.splice(0, run.msgs.length - LIVE_MSGS_MAX);
}

/** Apply one streamed content block delta to the live message (thinking/text deltas). */
function liveDelta(a: BgAgent, d: any) {
	const m = liveMsg(a);
	if (!m || !m.message) return;
	if (d.type === "text_delta" && typeof d.delta === "string") {
		const blocks = (m.message.content ??= []);
		let block = blocks.find((b: any) => b.type === "text" && b._live);
		if (!block) {
			block = { type: "text", text: "", _live: true };
			blocks.push(block);
		}
		block.text = (block.text + d.delta).slice(-32000);
	} else if (d.type === "thinking_delta" && typeof d.delta === "string") {
		const blocks = (m.message.content ??= []);
		let block = blocks.find((b: any) => b.type === "thinking" && b._live);
		if (!block) {
			block = { type: "thinking", thinking: "", _live: true };
			blocks.push(block);
		}
		block.thinking = (block.thinking + d.delta).slice(-32000);
	}
	m.rev = (a.liveRun!.rev += 1);
}

/** A tool call's arguments finished streaming (toolcall_end): pin the call into the live message. */
function liveToolCallEnd(a: BgAgent, d: any) {
	const m = liveMsg(a);
	const tc = d?.toolCall;
	if (!m || !tc?.id) return;
	const tools = (m.tools ??= []);
	let t = tools.find((x) => x.id === tc.id);
	if (!t) tools.push((t = { id: tc.id, name: tc.name ?? "tool", args: tc.arguments ?? {} }));
	else {
		t.args = tc.arguments ?? t.args;
		t.name = tc.name ?? t.name;
	}
	const blocks = (m.message.content ??= []);
	let block = blocks.find((b: any) => b.type === "toolCall" && b.id === tc.id);
	if (block) block.arguments = tc.arguments ?? block.arguments;
	else blocks.push({ type: "toolCall", id: tc.id, name: tc.name ?? "tool", arguments: tc.arguments ?? {} });
	m.rev = (a.liveRun!.rev += 1);
}

/** Tool execution started: make sure the tool exists in the live message (and sync its args). */
function liveToolStart(a: BgAgent, ev: any) {
	const m = liveMsg(a);
	if (!m || !ev.toolCallId) return;
	if (!m.message) m.message = { role: "assistant", content: [] };
	const blocks = (m.message.content ??= []);
	let block = blocks.find((b: any) => b.type === "toolCall" && b.id === ev.toolCallId);
	// Normal flow pins the call at toolcall_end; if execution started before that (e.g. replay of
	// an adopted run where we missed the deltas), synthesize the block so it still renders.
	if (!block) {
		block = { type: "toolCall", id: ev.toolCallId, name: ev.toolName ?? "tool", arguments: ev.args ?? {} };
		blocks.push(block);
	}
	let t = (m.tools ??= []).find((x) => x.id === ev.toolCallId);
	if (!t) (m.tools ??= []).push((t = { id: ev.toolCallId, name: ev.toolName ?? block.name, args: ev.args ?? block.arguments ?? {} }));
	t.args = ev.args ?? t.args;
	t.name = ev.toolName ?? t.name;
	m.rev = (a.liveRun!.rev += 1);
}

/** The streamed assistant message is final: adopt the authoritative message shape. */
function liveEndAssistant(a: BgAgent, ev: any) {
	const run = a.liveRun;
	const m = run && liveMsg(a);
	if (!m) return;
	if (ev.message?.role === "assistant") m.message = ev.message; // final content + stopReason
	m.rev = (run!.rev += 1);
}

/** Wire user prompt (the run's prompt, or a steering prompt mid-run). */
function liveUser(a: BgAgent, text: string | undefined, id?: string) {
	const run = a.liveRun ??= newLiveRun();
	if (!text) return;
	run.msgs.push({ role: "user", text, id, rev: ++run.rev });
	trimLive(run);
}

function liveTouch(a: BgAgent, m: LiveMsg | undefined) {
	if (m && a.liveRun) m.rev = (a.liveRun.rev += 1);
}

const LOG_MAX = 40;
function logLine(a: BgAgent, line: string) {
	a.log.push(line.replace(/\s+/g, " ").slice(0, 300));
	if (a.log.length > LOG_MAX) a.log.splice(0, a.log.length - LOG_MAX);
}

export type AgentEvent =
	| { type: "changed" }
	| { type: "finished"; agent: BgAgent }
	/** A run ended but queued messages remain (the next run starts right after, unless held). */
	| { type: "run_end"; agent: BgAgent };

interface Registry {
	agents: Map<string, BgAgent>;
	listeners: Set<(e: AgentEvent) => void>;
}

const REG_KEY = Symbol.for("pi.inbox.bg-agents");

export function registry(): Registry {
	const g = globalThis as any;
	if (!g[REG_KEY]) g[REG_KEY] = { agents: new Map(), listeners: new Set() } satisfies Registry;
	return g[REG_KEY] as Registry;
}

export function getAgent(id: string): BgAgent | undefined {
	return registry().agents.get(id);
}

export function listAgents(): BgAgent[] {
	return [...registry().agents.values()];
}

export function isRunning(a: BgAgent | undefined): boolean {
	return !!a && (a.state === "working" || a.state === "queued");
}

export function onAgentEvent(fn: (e: AgentEvent) => void): () => void {
	registry().listeners.add(fn);
	return () => registry().listeners.delete(fn);
}

function emit(e: AgentEvent) {
	for (const fn of registry().listeners) {
		try {
			fn(e);
		} catch {
			// a stale listener must not break the runner
		}
	}
}

/** Max agents running at once; extra ones wait as "queued". */
export const MAX_CONCURRENT = Math.max(1, Number(process.env.PI_INBOX_MAX_AGENTS) || 6);

// ───────────────────────────── child process ─────────────────────────────

/** How to re-invoke this same pi binary (compiled binary, or node/bun + script). */
function piCommand(): { cmd: string; pre: string[] } {
	const exe = process.execPath;
	if (/^(node|bun)(\.exe)?$/i.test(path.basename(exe)) && process.argv[1]) return { cmd: exe, pre: [process.argv[1]] };
	return { cmd: exe, pre: [] };
}

/**
 * Children load the same extensions, packages, skills and settings as a normal pi, so an
 * agent behaves exactly like a session you'd run yourself. Set PI_INBOX_AGENT_ARGS to add
 * extra CLI flags (space-separated), e.g. "--no-extensions -e /path/ext.ts".
 */
function extensionArgs(): string[] {
	const extra = process.env.PI_INBOX_AGENT_ARGS?.trim();
	return extra ? extra.split(/\s+/) : [];
}

/** Locate the session file for an id (the child creates it; we don't know the timestamped name). */
export function findSessionFile(id: string): string | undefined {
	const root = path.join(getAgentDir(), "sessions");
	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(root);
	} catch {
		return undefined;
	}
	const suffix = `_${id}.jsonl`;
	for (const d of dirs) {
		let files: string[] = [];
		try {
			files = fs.readdirSync(path.join(root, d));
		} catch {
			continue;
		}
		const hit = files.find((f) => f.endsWith(suffix));
		if (hit) return path.join(root, d, hit);
	}
	return undefined;
}

function summarizeArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	const v = args.command ?? args.path ?? args.file_path ?? args.query ?? args.pattern ?? args.url ?? args.tool ?? args.search;
	const s = typeof v === "string" ? v : JSON.stringify(args);
	return s.replace(/\s+/g, " ").slice(0, 80);
}

function touch(a: BgAgent) {
	a.updatedAt = Date.now();
	emit({ type: "changed" });
}

function runningCount(): number {
	return listAgents().filter((a) => a.proc).length;
}

/** Start runs for agents with pending messages, up to the concurrency cap. */
function pump() {
	for (const a of listAgents()) {
		if (runningCount() >= MAX_CONCURRENT) break;
		if (a.proc || a.hold || a.pending.length === 0 || a.state === "cancelled") continue;
		run(a);
	}
}

// ───────────────────────── persistence / survival ─────────────────────────

export const AGENTS_DIR = path.join(getAgentDir(), "inbox-agents");
const agentFile = (id: string, ext: "json" | "out" | "err" | "exit" | "stop" | "beat" | "name") => path.join(AGENTS_DIR, `${id}.${ext}`);
/** Owner heartbeat cadence / how stale before another pi adopts the agent. */
const OWNER_BEAT_MS = 5_000;
const OWNER_STALE_MS = 20_000;
/** Child heartbeat staleness (after a startup grace) that means the child died without a word. */
const CHILD_STALE_MS = 45_000;
const CHILD_GRACE_MS = 90_000;

interface SavedAgent {
	v: 1;
	id: string;
	cwd: string;
	title: string;
	model?: string;
	nextModel?: string;
	sessionFile?: string;
	state: AgentState;
	pending: string[];
	pid?: number;
	runPrompt?: string;
	runStartedAt?: number;
	createdAt: number;
	updatedAt: number;
	runs: number;
	error?: string;
	lastText?: string;
	needsYou: boolean;
	restartAfterInterrupt?: boolean;
	owner: number;
	ownerBeat: number;
}

/** Worth keeping on disk: something is running or still has to be delivered. */
function needsPersist(a: BgAgent): boolean {
	return !!a.proc || a.pending.length > 0 || a.state === "working" || a.state === "queued";
}

function writeAtomic(file: string, data: string) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data, "utf-8");
	fs.renameSync(tmp, file);
}

function removeAgentFiles(id: string, keepName = false) {
	let names: string[] = [];
	try {
		names = fs.readdirSync(AGENTS_DIR);
	} catch {
		return;
	}
	for (const n of names) {
		if (!n.startsWith(`${id}.`)) continue;
		if (keepName && n === `${id}.name`) continue;
		try {
			fs.rmSync(path.join(AGENTS_DIR, n), { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}

/** Save (or forget) an agent's durable state. Called on transitions and by the owner heartbeat. */
function persist(a: BgAgent) {
	// A rename not yet saved (no session file yet) outlives the agent's other files, so a later
	// run on this session id still picks it up.
	if (!needsPersist(a)) return removeAgentFiles(a.id, true);
	const s: SavedAgent = {
		v: 1,
		id: a.id,
		cwd: a.cwd,
		title: a.title,
		model: a.model,
		nextModel: a.nextModel,
		sessionFile: a.sessionFile,
		state: a.state,
		pending: a.pending,
		pid: a.pid,
		runPrompt: a.runPrompt,
		runStartedAt: a.runStartedAt,
		createdAt: a.createdAt,
		updatedAt: a.updatedAt,
		runs: a.runs,
		error: a.error,
		lastText: a.lastText,
		needsYou: a.needsYou,
		restartAfterInterrupt: a.restartAfterInterrupt,
		owner: process.pid,
		ownerBeat: Date.now(),
	};
	try {
		fs.mkdirSync(AGENTS_DIR, { recursive: true });
		writeAtomic(agentFile(a.id, "json"), JSON.stringify(s));
	} catch {
		// best effort
	}
}

function readPendingName(id: string): string | undefined {
	try {
		const n = JSON.parse(fs.readFileSync(agentFile(id, "name"), "utf-8"))?.name;
		return typeof n === "string" && n.trim() ? n.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Remove the pending-name file, unless a newer rename replaced it meanwhile. */
function clearPendingName(id: string, applied: string) {
	if (readPendingName(id) !== applied) return;
	try {
		fs.rmSync(agentFile(id, "name"), { force: true });
	} catch {
		// ignore
	}
}

/** Owner side: the run ended before the child applied the name; the file is ours alone now. */
function flushPendingName(a: BgAgent) {
	const name = readPendingName(a.id);
	if (!name) return;
	const file = a.sessionFile ?? findSessionFile(a.id);
	if (!file || !fs.existsSync(file)) return; // nothing saved yet: next run's child applies it
	try {
		SessionManager.open(file).appendSessionInfo(name);
		clearPendingName(a.id, name);
	} catch {
		// leave it for the next run
	}
}

/**
 * Rename a background agent's session deterministically, without writing its session file from
 * this process. The running child picks it up within ~1s (pi.setSessionName); if the run ends
 * first, the owner applies it in finishRun. Safe before the session file exists.
 */
export function renameAgent(id: string, name: string) {
	const a = getAgent(id);
	if (a) a.title = name;
	fs.mkdirSync(AGENTS_DIR, { recursive: true });
	writeAtomic(agentFile(id, "name"), JSON.stringify({ name, at: Date.now() }));
	if (a && !a.proc && !isRunning(a)) flushPendingName(a);
}

/**
 * Re-point a background agent at a different working directory (used when its session is moved
 * to another directory, or before a queued agent's first run). Safe only when it isn't running.
 */
export function setAgentDir(id: string, cwd: string, sessionFile?: string) {
	const a = getAgent(id);
	if (!a) return;
	a.cwd = cwd;
	if (sessionFile) a.sessionFile = sessionFile;
	touch(a);
	persist(a);
}

function requestStop(id: string) {
	try {
		fs.mkdirSync(AGENTS_DIR, { recursive: true });
		fs.writeFileSync(agentFile(id, "stop"), String(Date.now()), "utf-8");
	} catch {
		// ignore
	}
}

/** Exit marker written by the child itself ({pid, code}); only trusted for the expected pid. */
function readExit(a: BgAgent): number | undefined {
	try {
		const m = JSON.parse(fs.readFileSync(agentFile(a.id, "exit"), "utf-8"));
		if (a.pid && m.pid && m.pid !== a.pid) return undefined;
		return typeof m.code === "number" ? m.code : 1;
	} catch {
		return undefined;
	}
}

function childBeatAge(id: string): number {
	try {
		return Date.now() - fs.statSync(agentFile(id, "beat")).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function errTail(id: string): string {
	try {
		const fd = fs.openSync(agentFile(id, "err"), "r");
		try {
			const size = fs.fstatSync(fd).size;
			const n = Math.min(size, 2000);
			const b = Buffer.alloc(n);
			fs.readSync(fd, b, 0, n, size - n);
			return b.toString("utf-8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

/**
 * Child side: called when this pi process IS a background agent (PI_INBOX_BG_AGENT set).
 * Heartbeats, honours <id>.stop, and writes an exit marker so whoever owns it next knows how it
 * ended. The env var is removed so tools / nested pi runs don't impersonate the agent.
 */
export function installAgentChildHooks(applyName?: (name: string) => void) {
	const id = process.env.PI_INBOX_BG_AGENT;
	if (!id) return;
	delete process.env.PI_INBOX_BG_AGENT;
	const G = globalThis as any;
	const key = Symbol.for("pi.inbox.agentChild");
	if (G[key]) return;
	G[key] = id;
	const writeExit = (code: number, why?: string) => {
		try {
			if (!fs.existsSync(agentFile(id, "exit")))
				fs.writeFileSync(agentFile(id, "exit"), JSON.stringify({ pid: process.pid, code, why }), "utf-8");
		} catch {
			// ignore
		}
	};
	const beat = () => {
		try {
			fs.writeFileSync(agentFile(id, "beat"), String(Date.now()), "utf-8");
		} catch {
			// ignore
		}
	};
	beat();
	let n = 0;
	let stopping = false;
	let appliedName: string | undefined;
	setInterval(() => {
		if (++n % 5 === 0) beat();
		// Rename requested from a pi window: apply it here so only this process writes the session file.
		// Kept on failure (e.g. session not set up yet) and retried next tick.
		// The file is only cleared once the session file exists: pi keeps entries in memory until the
		// first response, so a crash before then would otherwise lose the name.
		if (applyName) {
			const name = readPendingName(id);
			if (name && name !== appliedName) {
				try {
					applyName(name);
					appliedName = name;
				} catch {
					// retry next tick
				}
			}
			if (name && name === appliedName && findSessionFile(id)) clearPendingName(id, name);
		}
		if (!stopping && fs.existsSync(agentFile(id, "stop"))) {
			stopping = true;
			writeExit(143, "stopped");
			setTimeout(() => process.kill(process.pid, "SIGKILL"), 3000).unref?.();
			process.kill(process.pid, "SIGTERM");
		}
	}, 1000).unref?.();
	process.on("exit", (code) => writeExit(typeof code === "number" ? code : (process.exitCode as number) ?? 0));
}

export function isAgentChild(): boolean {
	return !!(globalThis as any)[Symbol.for("pi.inbox.agentChild")] || !!process.env.PI_INBOX_BG_AGENT;
}

/**
 * Owner side: heartbeat the agents we own and adopt orphans (owner gone quiet). Only for
 * interactive pi windows; call once per session_start (idempotent, survives /reload).
 */
export function startAgentSupervisor() {
	if (isAgentChild()) return;
	const G = globalThis as any;
	const key = Symbol.for("pi.inbox.agentSupervisor");
	if (G[key]) clearInterval(G[key]);
	const tick = () => {
		for (const a of listAgents()) if (needsPersist(a)) persist(a);
		adoptOrphans();
	};
	G[key] = setInterval(tick, OWNER_BEAT_MS);
	G[key].unref?.();
	tick();
}

function adoptOrphans() {
	let names: string[] = [];
	try {
		names = fs.readdirSync(AGENTS_DIR);
	} catch {
		return;
	}
	for (const n of names) {
		if (!n.endsWith(".json")) continue;
		const id = n.slice(0, -5);
		if (registry().agents.has(id)) continue;
		let s: SavedAgent;
		try {
			s = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, n), "utf-8"));
		} catch {
			continue;
		}
		if (s.owner !== process.pid && Date.now() - s.ownerBeat < OWNER_STALE_MS) continue; // someone else has it
		// Atomic claim: only one pi can adopt from this particular (owner, beat).
		try {
			fs.mkdirSync(path.join(AGENTS_DIR, `${id}.adopt-${s.owner}-${s.ownerBeat}`));
		} catch {
			continue;
		}
		adopt(s);
	}
}

function adopt(s: SavedAgent) {
	const a: BgAgent = {
		id: s.id,
		cwd: s.cwd,
		title: s.title,
		model: s.model,
		nextModel: s.nextModel,
		sessionFile: s.sessionFile ?? findSessionFile(s.id),
		state: s.state,
		pending: s.pending ?? [],
		createdAt: s.createdAt,
		updatedAt: Date.now(),
		error: s.error,
		lastText: s.lastText,
		needsYou: s.needsYou,
		runs: s.runs,
		log: [],
		liveText: "",
		items: [],
		restartAfterInterrupt: s.restartAfterInterrupt,
	};
	registry().agents.set(a.id, a);
	const inFlight = s.pid && (s.state === "working" || s.state === "cancelled");
	if (inFlight) {
		a.pid = s.pid;
		a.runPrompt = s.runPrompt;
		a.runStartedAt = s.runStartedAt;
		a.outOffset = 0; // replay the run so far
		a.liveRun = newLiveRun();
		if (s.runPrompt) {
			a.items = [{ kind: "prompt", text: s.runPrompt }];
			logLine(a, `› ${s.runPrompt}`);
			liveUser(a, cleanUserText(s.runPrompt));
		}
		const id = a.id;
		a.proc = { pid: s.pid, kill: () => requestStop(id) };
		monitor(a);
	} else if (s.state === "working") {
		a.state = a.pending.length ? "queued" : "idle";
	}
	persist(a);
	touch(a);
	pump();
}

function run(a: BgAgent) {
	const message = a.pending.shift()!;
	a.log = [];
	a.liveText = "";
	a.items = [{ kind: "prompt", text: message }];
	logLine(a, `› ${message}`);
	a.liveRun = newLiveRun();
	liveUser(a, cleanUserText(message));
	const { cmd, pre } = piCommand();
	const args = [...pre, "--mode", "json", "--session-id", a.id, ...extensionArgs()];
	// --model wins over the model the session would restore, and is saved in the session.
	const model = a.nextModel ?? (a.runs === 0 ? a.model : undefined);
	a.nextModel = undefined;
	if (model) args.push("--model", model);
	args.push("--", message);

	let child: ChildProcess;
	let outFd: number | undefined;
	let errFd: number | undefined;
	try {
		fs.mkdirSync(AGENTS_DIR, { recursive: true });
		for (const ext of ["exit", "stop", "beat"] as const) fs.rmSync(agentFile(a.id, ext), { force: true });
		outFd = fs.openSync(agentFile(a.id, "out"), "w");
		errFd = fs.openSync(agentFile(a.id, "err"), "w");
		// detached: own session + process group, no controlling tty → no SIGHUP when the tab closes,
		// and not in pi's process group. Output goes to files, so nothing breaks when we're gone.
		child = spawn(cmd, args, {
			cwd: a.cwd,
			env: {
				...process.env,
				PI_INBOX_BG_PARENT: String(process.pid),
				PI_INBOX_BG_AGENT: a.id,
				[BACKGROUND_MCP_AUTO_APPROVE_ENV]: "1",
			},
			stdio: ["ignore", outFd, errFd],
			detached: true,
		});
		child.unref();
	} catch (e) {
		a.state = "error";
		a.error = `spawn failed: ${e instanceof Error ? e.message : String(e)}`;
		a.needsYou = true;
		touch(a);
		persist(a);
		return;
	} finally {
		if (outFd !== undefined) fs.closeSync(outFd);
		if (errFd !== undefined) fs.closeSync(errFd);
	}

	const id = a.id;
	a.proc = {
		pid: child.pid,
		kill: (sig = "SIGTERM") => {
			requestStop(id);
			try {
				child.kill(sig);
			} catch {
				// ignore
			}
		},
	};
	a.pid = child.pid;
	a.runPrompt = message;
	a.runStartedAt = Date.now();
	a.outOffset = 0;
	a.runs++;
	a.state = "working";
	a.error = undefined;
	a.activity = "starting…";
	persist(a);
	touch(a);
	monitor(a, child);
}

/** Tail the agent's event file and notice when its run ends (child exit, exit marker, or silence). */
function monitor(a: BgAgent, child?: ChildProcess) {
	let exited: number | undefined;
	let exitSignal: string | undefined;
	child?.on("exit", (code, signal) => {
		exited = code ?? 1;
		exitSignal = signal ?? undefined;
	});
	child?.on("error", (e) => {
		a.error = `pi failed to start: ${e.message}`;
		exited ??= 1;
	});
	const decoder = new StringDecoder("utf-8");
	let buf = "";
	let lastDelta = 0;
	const gate = () => {
		const now = Date.now();
		if (now - lastDelta < 500) return false;
		lastDelta = now;
		return true;
	};
	const drain = () => {
		let fd: number;
		try {
			fd = fs.openSync(agentFile(a.id, "out"), "r");
		} catch {
			return;
		}
		try {
			const size = fs.fstatSync(fd).size;
			let off = a.outOffset ?? 0;
			while (off < size) {
				const b = Buffer.alloc(Math.min(size - off, 1 << 20));
				const r = fs.readSync(fd, b, 0, b.length, off);
				if (r <= 0) break;
				off += r;
				buf += decoder.write(b.subarray(0, r));
			}
			a.outOffset = off;
		} finally {
			fs.closeSync(fd);
		}
		let nl: number;
		let pendingDelta: any;
		const flushDelta = () => {
			if (!pendingDelta) return;
			handleEvent(a, pendingDelta, gate);
			pendingDelta = undefined;
		};
		// Split on LF only (JSON strings may contain U+2028/9). Coalesce
		// consecutive text/reasoning deltas so one poll performs one string
		// append and revision bump instead of hundreds.
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).replace(/\r$/, "");
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				continue;
			}
			const delta = ev?.assistantMessageEvent;
			const streamDelta =
				ev?.type === "message_update" &&
				(delta?.type === "text_delta" ||
					delta?.type === "thinking_delta") &&
				typeof delta.delta === "string";
			if (streamDelta) {
				const previous = pendingDelta?.assistantMessageEvent;
				if (previous?.type === delta.type) {
					previous.delta += delta.delta;
				} else {
					flushDelta();
					pendingDelta = ev;
				}
				continue;
			}
			flushDelta();
			handleEvent(a, ev, gate);
		}
		flushDelta();
	};
	const timer = setInterval(() => {
		if (getAgent(a.id) !== a) return clearInterval(timer); // forgotten / replaced
		drain();
		let code = exited ?? readExit(a);
		if (code === undefined && !child) {
			// adopted: no exit event to wait for. A child that died hard (SIGKILL, crash) leaves no
			// marker, so a long-silent heartbeat means it's gone.
			const age = Date.now() - (a.runStartedAt ?? 0);
			if (age > CHILD_GRACE_MS && childBeatAge(a.id) > CHILD_STALE_MS) code = -1;
		}
		if (code === undefined) return;
		clearInterval(timer);
		drain();
		finishRun(a, code, exitSignal);
	}, 300);
	timer.unref?.();
}

function finishRun(a: BgAgent, code: number, signal?: string) {
	a.proc = undefined;
	a.pid = undefined;
	a.runPrompt = undefined;
	a.runStartedAt = undefined;
	if (!a.sessionFile) a.sessionFile = findSessionFile(a.id);
	flushPendingName(a);
	if (a.restartAfterInterrupt) {
		a.restartAfterInterrupt = undefined;
		a.error = undefined;
		a.activity = undefined;
		if (a.pending.length) {
			a.state = "queued";
			persist(a);
			// Let the UI reload the interrupted run before the selected message.
			emit({ type: "run_end", agent: a });
		} else {
			a.state = "idle";
			a.needsYou = true;
			persist(a);
		}
	} else if (a.state === "cancelled") {
		a.activity = "cancelled";
		persist(a);
	} else if (code !== 0 || a.error) {
		a.state = "error";
		const lastLine = errTail(a.id)
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("Warning: No project session found"))
			.pop();
		a.error =
			a.error ??
			(code === -1
				? "agent process vanished without an exit status (killed or crashed); send \"continue\" to resume"
				: lastLine || `pi exited with ${signal ?? `code ${code}`}`);
		a.needsYou = true;
		a.activity = undefined;
		persist(a);
		emit({ type: "finished", agent: a });
	} else if (a.pending.length === 0) {
		a.state = "idle";
		a.needsYou = true;
		a.activity = undefined;
		persist(a);
		emit({ type: "finished", agent: a });
	} else {
		a.state = "queued";
		persist(a);
		// Listeners may hold the next run (synchronously) to reload the transcript first.
		emit({ type: "run_end", agent: a });
	}
	touch(a);
	pump();
}

/** Apply one JSON wire event to the agent (public for tests; monitor() drives it). */
export function applyEvent(a: BgAgent, ev: any, deltaGate: () => boolean = () => true) {
	handleEvent(a, ev, deltaGate);
}

function handleEvent(a: BgAgent, ev: any, deltaGate: () => boolean) {
	switch (ev.type) {
		case "session":
			if (!a.sessionFile) a.sessionFile = findSessionFile(a.id);
			if (typeof ev.cwd === "string") a.cwd = ev.cwd;
			touch(a);
			break;
		case "agent_start":
			a.state = "working";
			touch(a);
			break;
		case "turn_start":
			// A steering prompt may arrive mid-run; the run's own prompt is added in run().
			touch(a);
			break;
		case "tool_execution_start":
			a.activity = `${ev.toolName ?? "tool"}${ev.args ? `: ${summarizeArgs(ev.toolName, ev.args)}` : ""}`;
			logLine(a, `▸ ${a.activity}`);
			addItem(a, { kind: "tool", text: a.activity });
			liveToolStart(a, ev);
			touch(a);
			break;
		case "tool_execution_update":
			if (ev.partialResult) {
				const m = liveMsg(a);
				const t = m?.tools?.find((x) => x.id === ev.toolCallId);
				if (t && m) {
					t.result = clampResult({ content: ev.partialResult.content ?? [], isError: false });
					liveTouch(a, m);
				}
			}
			break;
		case "tool_execution_end":
			{
				const m = liveMsg(a);
				const t = m?.tools?.find((x) => x.id === ev.toolCallId);
				if (t && m && ev.result) {
					t.result = clampResult({ content: ev.result.content ?? [], isError: !!ev.isError });
					liveTouch(a, m);
				}
			}
			if (ev.isError) {
				logLine(a, `  ✗ ${ev.toolName ?? "tool"} failed`);
				addItem(a, { kind: "error", text: `${ev.toolName ?? "tool"} failed` });
			}
			break;
		case "message_start":
			if (ev.message?.role === "assistant") liveStartAssistant(a, ev);
			else if (ev.message?.role === "user") {
				const t = textOf(ev.message.content).trim();
				// The run's prompt is already seeded into the live view. The child
				// may prepend an expanded skill block while preserving the original
				// inline $skill mention, so compare only the user-authored portion.
				// A later steering prompt still renders normally.
				const seeded = comparableUserText(a.runPrompt ?? "");
				if (t && comparableUserText(t) !== seeded) {
					liveUser(a, cleanUserText(t), ev.message.id);
				} else if (t && ev.message.id) {
					// The run prompt's own echo: record its persisted wire id on the
					// seeded message so transcript dedupe (visit view) can match it
					// exactly — the seeded text is cleaned, which never equals a
					// skill-expanded persist.
					const first = a.liveRun?.msgs.find((m) => m.role === "user");
					if (first && !first.id) first.id = ev.message.id;
				}
			}
			break;
		case "message_update": {
			const d = ev.assistantMessageEvent;
			if (d?.type === "text_delta" || d?.type === "thinking_delta") liveDelta(a, d);
			if (d?.type === "toolcall_end") liveToolCallEnd(a, d);
			if (d?.type !== "text_delta" || typeof d.delta !== "string") break;
			a.liveText = (a.liveText + d.delta).slice(-8000);
			if (deltaGate()) {
				a.activity = "writing…";
				touch(a);
			}
			break;
		}
		case "message_end": {
			const m = ev.message;
			if (m?.role !== "assistant") break;
			const text = textOf(m.content).trim();
			a.liveText = "";
			liveEndAssistant(a, ev);
			if (text) {
				a.lastText = text;
				logLine(a, `💬 ${text}`);
				addItem(a, { kind: "text", text });
			}
			if (m.stopReason === "error") {
				a.error = m.errorMessage || "provider error";
				addItem(a, { kind: "error", text: a.error! });
			}
			touch(a);
			break;
		}
		case "auto_retry_start":
			a.activity = "retrying…";
			touch(a);
			break;
		case "auto_retry_end":
			// A provider error that pi retried successfully isn't a run failure; exhausted
			// retries (success: false) keep the error from the failed message_end.
			if (ev.success) a.error = undefined;
			touch(a);
			break;
		case "compaction_start":
			a.activity = "compacting…";
			touch(a);
			break;
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

// ───────────────────────────── public actions ─────────────────────────────

/** Start a new background agent. */
export function spawnAgent(opts: { prompt: string; cwd: string; model?: string; title: string }): BgAgent {
	const a: BgAgent = {
		id: randomUUID(),
		cwd: opts.cwd,
		title: opts.title,
		model: opts.model,
		state: "queued",
		pending: [opts.prompt],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		needsYou: false,
		runs: 0,
		log: [],
		liveText: "",
	};
	registry().agents.set(a.id, a);
	touch(a);
	persist(a);
	pump();
	return a;
}

/**
 * Send a message to a session in the background. Existing (non-agent) sessions are adopted
 * as background agents. If the agent is working, the message is queued for its next run.
 */
export function sendToAgent(opts: { id: string; cwd: string; sessionFile?: string; title: string; text: string; model?: string }): BgAgent {
	let a = getAgent(opts.id);
	if (!a) {
		a = {
			id: opts.id,
			cwd: opts.cwd,
			title: opts.title,
			sessionFile: opts.sessionFile,
			state: "idle",
			pending: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			needsYou: false,
			runs: 1, // existing session: keep its own model
			log: [],
			liveText: "",
		};
		registry().agents.set(a.id, a);
	}
	a.pending.push(opts.text);
	if (opts.model) {
		a.nextModel = opts.model;
		a.model = opts.model;
	}
	if (!a.proc) a.state = "queued";
	a.needsYou = false;
	touch(a);
	persist(a);
	pump();
	return a;
}

export function cancelAgent(id: string) {
	const a = getAgent(id);
	if (!a) return;
	a.pending = [];
	a.restartAfterInterrupt = undefined;
	a.state = "cancelled";
	const p = a.proc;
	if (p) {
		p.kill("SIGTERM");
		setTimeout(() => {
			if (a.proc === p) p.kill("SIGKILL");
		}, 3000).unref?.();
	}
	persist(a);
	touch(a);
}

function findQueuedIndex(
	a: BgAgent,
	index: number,
	expected?: string,
): number {
	if (index >= 0 && index < a.pending.length) {
		if (expected === undefined || a.pending[index] === expected) return index;
	}
	return expected === undefined ? -1 : a.pending.indexOf(expected);
}

/** Remove one queued message without affecting the run in flight. */
export function removeQueuedMessage(
	id: string,
	index: number,
	expected?: string,
): string | undefined {
	const a = getAgent(id);
	if (!a) return undefined;
	const found = findQueuedIndex(a, index, expected);
	if (found < 0) return undefined;
	const [removed] = a.pending.splice(found, 1);
	if (!a.proc && a.pending.length === 0) {
		a.hold = false;
		a.state = "idle";
		a.activity = undefined;
	}
	persist(a);
	touch(a);
	pump();
	return removed;
}

/**
 * Move one queued message to the front. If a run is in flight, stop it at
 * the next safe process boundary, then run the selected message and resume
 * from the completed session history.
 */
export function sendQueuedMessageNow(
	id: string,
	index: number,
	expected?: string,
): { message: string; interrupted: boolean } | undefined {
	const a = getAgent(id);
	if (!a) return undefined;
	const found = findQueuedIndex(a, index, expected);
	if (found < 0) return undefined;
	const [message] = a.pending.splice(found, 1);
	a.pending.unshift(message!);
	a.needsYou = false;
	const p = a.proc;
	if (!p) {
		a.state = "queued";
		persist(a);
		touch(a);
		pump();
		return { message: message!, interrupted: false };
	}
	const firstInterrupt = !a.restartAfterInterrupt;
	a.restartAfterInterrupt = true;
	a.activity = "interrupting…";
	persist(a);
	touch(a);
	if (firstInterrupt) {
		p.kill("SIGTERM");
		setTimeout(() => {
			if (a.proc === p) p.kill("SIGKILL");
		}, 3000).unref?.();
	}
	return { message: message!, interrupted: true };
}

/**
 * Hold an agent's next queued run (call synchronously from a `run_end` listener). Released by
 * releaseHold(), or automatically after `ms` so a failed reload can never stall the queue.
 */
export function holdAgent(id: string, ms = 5000) {
	const a = getAgent(id);
	if (!a || a.proc) return;
	a.hold = true;
	setTimeout(() => releaseHold(id), ms).unref?.();
}

export function releaseHold(id: string) {
	const a = getAgent(id);
	if (!a?.hold) return;
	a.hold = false;
	touch(a);
	pump();
}

/** Forget an agent (e.g. once it's been taken over in the foreground). */
export function releaseAgent(id: string) {
	const a = getAgent(id);
	if (!a || a.proc) return;
	flushPendingName(a);
	registry().agents.delete(id);
	removeAgentFiles(id, true);
	emit({ type: "changed" });
}

export function markSeen(id: string) {
	const a = getAgent(id);
	if (a && a.needsYou) {
		a.needsYou = false;
		touch(a);
	}
}

/** Stop every running agent. Not called on quit any more: agents outlive the pi that started them. */
export function killAllAgents() {
	for (const a of listAgents()) if (a.proc) cancelAgent(a.id);
}

/** e.g. "agents: 2 working · 1 needs you", or undefined when there's nothing to show. */
export function agentsSummary(): string | undefined {
	const all = listAgents();
	const working = all.filter((a) => a.state === "working").length;
	const queued = all.filter((a) => a.state === "queued").length;
	const needs = all.filter((a) => a.needsYou && !a.proc).length;
	const parts: string[] = [];
	if (working) parts.push(`${working} working`);
	if (queued) parts.push(`${queued} queued`);
	if (needs) parts.push(`${needs} need${needs === 1 ? "s" : ""} you`);
	return parts.length ? `agents: ${parts.join(" · ")}` : undefined;
}

/**
 * What pi restores from a session branch, mirroring pi's getSessionContextSettings: the model
 * comes from the last model_change OR assistant message, the thinking level only from the last
 * thinking_level_change. Those can disagree: pi doesn't record a `--model x:level` override on a
 * resumed session, so after such a run the model is right (assistant messages) but the level is
 * whatever was recorded last (e.g. a stale `off` from cycling past glm).
 */
export function branchSettings(branch: any[]): { model?: string; level?: string } {
	let model: string | undefined;
	let level: string | undefined;
	for (const e of branch) {
		if (e?.type === "thinking_level_change" && e.thinkingLevel) level = e.thinkingLevel;
		else if (e?.type === "model_change" && e.provider && e.modelId) model = `${e.provider}/${e.modelId}`;
		else if (e?.type === "message" && e.message?.role === "assistant" && e.message.provider && e.message.model)
			model = `${e.message.provider}/${e.message.model}`;
	}
	return { model, level };
}

/** The model a session will use next: "provider/model:thinking", as pi restores it from the active branch. */
export function sessionModel(file: string | undefined): string | undefined {
	if (!file) return undefined;
	let branch: any[];
	try {
		branch = SessionManager.open(file).getBranch() as any[];
	} catch {
		return undefined;
	}
	const { model, level } = branchSettings(branch);
	return model ? `${model}${level ? `:${level}` : ""}` : undefined;
}

/**
 * Background agent child: make the session file record the thinking level this run actually uses.
 * A run started with `--model provider/model:level` on an existing session applies the level but
 * pi writes no thinking_level_change for it, so later runs (and any pi window opening the session)
 * restore the old recorded level instead. Call on session_start; we're the only writer then.
 */
export function recordActualThinkingLevel(sessionManager: any, actual: string | undefined) {
	if (!actual || typeof sessionManager?.appendThinkingLevelChange !== "function") return;
	let branch: any[];
	try {
		branch = sessionManager.getBranch() as any[];
	} catch {
		return;
	}
	if (branchSettings(branch).level === actual) return;
	sessionManager.appendThinkingLevelChange(actual);
}

// ───────────────────────────── transcript ─────────────────────────────

/** Display text: collapse expanded skill blocks and `$skill` tokens. */
function cleanUserText(s: string): string {
	return s
		.replace(/<skill\s+name="([^"]+)"[\s\S]*?<\/skill>\s*/g, (_m, n) => `⚡${n} `)
		.replace(/(^|\s)\$([\w-]+)/g, (_m, pre, n) => `${pre}⚡${n}`)
		.trim();
}

/**
 * Canonical user-authored text for matching a run prompt with the child's echo.
 * Inline-skills prepends one or more expanded blocks but deliberately keeps the
 * original `$skill` token in the message, so those metadata blocks must be
 * removed rather than converted into an additional visible skill marker.
 */
export function comparableUserText(s: string): string {
	let text = s;
	for (;;) {
		const withoutBlock = text.replace(
			/^\s*<skill\b[^>]*>[\s\S]*?<\/skill>\s*/,
			"",
		);
		if (withoutBlock === text) break;
		text = withoutBlock;
	}
	return text
		.replace(/^\s*\/skill:[\w.-]+(?:\s+|$)/i, "")
		.replace(/(^|\s)\$([\w-]+)/g, (_m, pre, n) => `${pre}⚡${n}`)
		.replace(/\s+/g, " ")
		.trim();
}

/** Render a session's active branch as markdown for the agent view. */
export function transcriptMarkdown(file: string): string {
	let branch: any[] = [];
	try {
		branch = SessionManager.open(file).getBranch() as any[];
	} catch (e) {
		return `_Could not read session: ${e instanceof Error ? e.message : String(e)}_`;
	}
	const out: string[] = [];
	for (const e of branch) {
		if (e?.type !== "message") continue;
		const m = e.message;
		if (m?.role === "user") {
			const t = cleanUserText(textOf(m.content));
			if (t) out.push(...(out.length ? ["---", ""] : []), "**🧑 You**", "", t, "");
		} else if (m?.role === "assistant") {
			let said = false;
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b?.type === "text" && b.text?.trim()) {
					if (!said) out.push("**Agent**", "");
					said = true;
					out.push(b.text.trim(), "");
				} else if (b?.type === "toolCall") {
					const arg = summarizeArgs(b.name, b.arguments);
					out.push(`> 🔧 \`${b.name}\`${arg ? ` ${arg.replace(/`/g, "'")}` : ""}`, "");
				}
			}
			if (m.stopReason === "error") out.push(`> ✗ **error:** ${m.errorMessage ?? "provider error"}`, "");
			if (m.stopReason === "aborted") out.push("> ⏸ _aborted_", "");
		} else if (m?.role === "toolResult" && m.isError) {
			const first = textOf(m.content).split("\n").find((l) => l.trim()) ?? "";
			out.push(`> ↳ ✗ ${first.slice(0, 160)}`, "");
		}
	}
	return out.length ? out.join("\n") : "_No messages yet._";
}

// ───────────────────────────── agent view (overlay) ─────────────────────────────

export type AgentViewResult = { action: "close" } | { action: "reply" } | { action: "takeover" } | { action: "cancel" };

export interface AgentViewTarget {
	id: string;
	title: string;
	cwd: string;
	sessionFile?: string;
	/** Fill the whole terminal height (orchestrator mode renders it full-screen). */
	fullHeight?: boolean;
}

/**
 * Read-only, live-updating transcript of one session. Replies are typed in pi's own
 * editor (same keys, autocomplete and settings), not here. Only plain keys are used,
 * since pi reserves most ctrl combos for itself.
 *   enter / r      reply in the main editor     o  open here (take over)     c  cancel agent
 *   ↑↓ j k PgUp PgDn space g G  scroll           esc / q  close
 */
export class AgentViewComponent {
	private md?: Markdown;
	private mdKey = "";
	private lines: string[] = [];
	private linesWidth = -1;
	private scroll = 0;
	private follow = true;
	private timer?: ReturnType<typeof setInterval>;
	private flash?: { text: string; until: number; kind: "ok" | "err" };

	constructor(
		private tui: TUI,
		private theme: Theme,
		private kb: KeybindingsManager,
		private done: (r: AgentViewResult) => void,
		private target: AgentViewTarget,
	) {
		markSeen(target.id);
		this.reload();
		this.timer = setInterval(() => {
			if (this.reload()) this.tui.requestRender();
			else if (isRunning(getAgent(this.target.id))) this.tui.requestRender(); // activity line
		}, 800);
	}

	dispose() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate() {
		this.linesWidth = -1;
		this.md?.invalidate();
	}

	private file(): string | undefined {
		const a = getAgent(this.target.id);
		const f = a?.sessionFile ?? this.target.sessionFile ?? findSessionFile(this.target.id);
		if (f && a && !a.sessionFile) a.sessionFile = f;
		return f;
	}

	/** Re-read the transcript if the session file changed. Returns true when it did. */
	private reload(): boolean {
		const f = this.file();
		let key = "none";
		if (f) {
			try {
				const st = fs.statSync(f);
				key = `${f}:${st.mtimeMs}:${st.size}`;
			} catch {
				// not written yet
			}
		}
		if (key === this.mdKey && this.md) return false;
		this.mdKey = key;
		const text = f && key !== "none" ? transcriptMarkdown(f) : "_Starting… the transcript appears once the agent writes its session._";
		this.md = new Markdown(text, 1, 0, getMarkdownTheme());
		this.linesWidth = -1;
		return true;
	}

	private viewH(): number {
		const rows = this.tui.terminal?.rows ?? 30;
		return Math.max(6, (this.target.fullHeight ? rows : Math.floor(rows * 0.9)) - 6);
	}

	private say(text: string, kind: "ok" | "err" = "ok") {
		this.flash = { text, until: Date.now() + 3000, kind };
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const max = Math.max(0, this.lines.length - this.viewH());
		const scrollBy = (d: number) => {
			this.scroll = Math.max(0, Math.min(max, this.scroll + d));
			this.follow = this.scroll >= max;
		};

		const ch = data.length === 1 ? data : undefined;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || ch === "q") return this.done({ action: "close" });
		if (this.kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter") || ch === "r") return this.done({ action: "reply" });
		if (ch === "o") return this.done({ action: "takeover" });
		if (ch === "c") {
			if (isRunning(getAgent(this.target.id))) return this.done({ action: "cancel" });
			this.say("agent isn't running", "err");
		} else if (matchesKey(data, "up") || ch === "k") scrollBy(-1);
		else if (matchesKey(data, "down") || ch === "j") scrollBy(1);
		else if (matchesKey(data, "pageUp")) scrollBy(-this.viewH());
		else if (matchesKey(data, "pageDown") || ch === " ") scrollBy(this.viewH());
		else if (matchesKey(data, "home") || ch === "g") scrollBy(-1e9);
		else if (matchesKey(data, "end") || ch === "G") scrollBy(1e9);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const b = (s: string) => th.fg("borderMuted", s);
		const line = (s: string) => b("│") + fitTo(s, innerW) + b("│");
		const sep = () => b(`├${"─".repeat(innerW)}┤`);

		if (this.linesWidth !== innerW && this.md) {
			this.lines = this.md.render(innerW);
			this.linesWidth = innerW;
		}
		const a = getAgent(this.target.id);
		// The session file only gets whole messages; show what the run is doing right now.
		// With a live run (our child or an adopted one we replayed), render its messages: tool
		// calls as one-liners, assistant text (streamed or finished) as markdown.
		let live: string[] = [];
		if (a?.liveRun?.msgs.length) {
			const th2 = this.theme;
			for (const m of a.liveRun.msgs) {
				if (m.role === "user") {
					live.push(th2.fg("accent", `› ${((m.text ?? "").split("\n")[0] ?? "").slice(0, 160)}`), "");
				} else {
					for (const t of m.tools ?? []) {
						const arg = summarizeArgs(t.name, t.args);
						live.push(th2.fg("dim", `  ▸ ${t.name}${arg ? ` ${arg}` : ""}${t.result ? (t.result.isError ? " ✗" : "") : " …"}`));
					}
					const text = textOf(m.message?.content).trim();
					if (text) live.push(th2.fg("dim", "  ") + text.split("\n")[0]!.slice(0, 160), "");
				}
			}
		} else if (a?.proc && a.liveText.trim()) {
			live = [th.fg("dim", " writing…"), ...a.liveText.trimEnd().split("\n").slice(-10)];
		}
		const all = live.length ? [...this.lines, "", ...live] : this.lines;
		const H = this.viewH();
		const max = Math.max(0, all.length - H);
		if (this.follow) this.scroll = max;
		this.scroll = Math.max(0, Math.min(this.scroll, max));

		const title = ` ${th.bold(th.fg("accent", this.target.title))} `;
		const out = [b("╭─") + title + b("─".repeat(Math.max(0, innerW - 1 - visibleWidth(title)))) + b("╮")];

		// status line
		const st: string[] = [];
		if (!a) st.push(th.fg("dim", "not a background agent — replying runs it in the background"));
		else if (a.state === "working") st.push(th.fg("warning", `● working`) + th.fg("dim", a.activity ? ` · ${a.activity}` : ""));
		else if (a.state === "queued") st.push(th.fg("warning", "⏳ queued"));
		else if (a.state === "error") st.push(th.fg("error", `✗ ${a.error ?? "error"}`));
		else if (a.state === "cancelled") st.push(th.fg("muted", "⏸ cancelled"));
		else st.push(th.fg("accent", "◆ your turn"));
		if (a?.pending.length) st.push(th.fg("dim", `${a.pending.length} message(s) queued`));
		st.push(th.fg("dim", this.target.cwd.replace(process.env.HOME ?? "~", "~")));
		out.push(line(` ${st.join(th.fg("dim", " · "))}`));
		out.push(sep());

		for (let i = 0; i < H; i++) out.push(line(all[this.scroll + i] ?? ""));
		out.push(sep());

		const flash = this.flash && this.flash.until > Date.now() ? this.flash : undefined;
		const pos = all.length > H ? th.fg("dim", `  ${Math.round(((this.scroll + H) / all.length) * 100)}%`) : "";
		const k = (key: string, label: string) => `${th.fg("accent", key)} ${th.fg("dim", label)}`;
		const help = [
			k("enter/r", "reply"),
			k("o", "open here"),
			...(isRunning(a) ? [k("c", "cancel")] : []),
			k("↑↓ PgUp PgDn", "scroll"),
			k("esc", "close"),
		].join(
			th.fg("dim", " · "),
		);
		out.push(line(` ${flash ? th.fg(flash.kind === "ok" ? "success" : "error", flash.text) : help}${pos}`));
		out.push(b(`╰${"─".repeat(innerW)}╯`));
		return out.map((l) => truncateToWidth(l, width));
	}
}

function fitTo(s: string, w: number): string {
	const t = truncateToWidth(s, w, "…");
	return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}
