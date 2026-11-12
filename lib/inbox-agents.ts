/**
 * Background agents for the Inbox.
 *
 * Every background agent is a short-lived child pi process:
 *   pi --mode json --session-id <id>
 * with the message piped on stdin (NOT as a positional argument: pi's startup
 * parser turns any argument beginning with `@` into a file mention, so a
 * prompt like "@foo fix this" would kill the child with "File not found"
 * before it ever runs — and a bare "@" makes it try to read the cwd as a
 * file). Stdin content is prepended to the prompt, which is equivalent here
 * since each run sends exactly one message.
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
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
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
	/** Explicit extensions needed by a delegated worker on every run. */
	extensionPaths?: string[];
	/** Model override for the next run (set when you change the model while replying). */
	nextModel?: string;
	sessionFile?: string;
	state: AgentState;
	/** Messages waiting to be delivered, one per subsequent run. */
	pending: string[];
	/** Set while a run is in flight (our own child, or an adopted orphan). */
	proc?: AgentProc;
	pid?: number;
	/**
	 * The child emitted agent_settled, so the run's user-visible state is final.
	 * Keep proc until the one-shot child exits to prevent a second writer.
	 */
	settledAt?: number;
	/** Prompt of the in-flight run (persisted so an adopter can show it). */
	runPrompt?: string;
	runStartedAt?: number;
	/** Exact pre-prompt checkpoint, captured before launching the child. */
	runBaseLeafId?: string | null;
	/**
	 * Leaf the caller was viewing when it sent the next message.
	 *
	 * The spawn is `pi --session <path>` and there is no leaf argument, so a
	 * child resumes on the file's LAST line. In an attached view that is not
	 * the branch on screen: `/tree` to an older point and type, and the prompt
	 * lands on the newest branch instead. `run()` pins this leaf with a
	 * `pi-kit.tree-position` marker before spawning so the child resumes here.
	 * Captured at SEND time, not spawn time -- "the branch I was looking at when
	 * I typed" -- which is also correct for a message that waits in `pending`.
	 */
	nextRunLeaf?: string;
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

export type RunItem = {
	kind: "prompt" | "tool" | "text" | "error";
	text: string;
	/**
	 * Identity of the thing this item stands for, so a reader that also shows
	 * the session file can draw a step once instead of twice.
	 *
	 * `ts` is the assistant message's own timestamp and `id` the provider's tool
	 * call id -- both the same values the file entry carries. Text matching is
	 * never used: the same command legitimately runs twice.
	 */
	ts?: number;
	id?: string;
};
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
	/** Raw wire message, including the timestamp shared with persisted history. */
	message?: any;
	/** Display text for users (the wire message may contain expanded skills). */
	text?: string;
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
function liveUser(a: BgAgent, text: string | undefined, message?: any) {
	const run = a.liveRun ??= newLiveRun();
	if (!text) return;
	run.msgs.push({ role: "user", text, message, rev: ++run.rev });
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
export const MAX_CONCURRENT = Math.max(1, Number(process.env.PI_INBOX_MAX_AGENTS) || 20);

// ───────────────────────────── child process ─────────────────────────────

/** How to re-invoke this same pi binary (compiled binary, or node/bun + script). */
function piCommand(): { cmd: string; pre: string[] } {
	// A host that embeds this lib without being pi (e.g. a separate daemon) points
	// PI_INBOX_AGENT_CMD at the pi launcher; otherwise every child would re-run the host.
	const override = process.env.PI_INBOX_AGENT_CMD?.trim();
	if (override) return { cmd: override, pre: [] };
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
/**
 * How long a run whose owning pi is gone may keep its writer slot before the
 * live record stops counting as a writer.
 *
 * A background child is deliberately `detached` so it outlives its parent: a
 * closed tab must not kill an agent mid-task. That is the point of adoption. But
 * when no live pi adopts it, nothing is left to stop it either, and a run blocked
 * forever inside one tool call (a `bash` that never returns) keeps a LIVE pid and
 * a FRESH heartbeat -- so every clause of `isWriting` is satisfied and the
 * session reads as "another pi is running it" indefinitely. Observed: a run left
 * 3h40m past its parent's exit, blocking the session it shared.
 *
 * Adoption rescues the normal case well inside this window: `mayAdopt` only
 * requires the owner to be 20s stale, and an adoptee then heartbeats again. So a
 * run still orphaned after two minutes is not being rescued, it is stuck. Wide
 * enough that adoption always wins the race; narrow enough that a wedged run
 * cannot block a session for an afternoon.
 */
export const ORPHANED_RUN_GRACE_MS = 2 * 60_000;
/** Child heartbeat staleness (after a startup grace) that means the child died without a word. */
export const CHILD_STALE_MS = 45_000;
export const CHILD_GRACE_MS = 90_000;
/** A JSON-mode child should exit immediately after agent_settled. */
const SETTLED_EXIT_GRACE_MS = 5_000;

interface SavedAgent {
	v: 1;
	id: string;
	cwd: string;
	title: string;
	model?: string;
	extensionPaths?: string[];
	nextModel?: string;
	sessionFile?: string;
	state: AgentState;
	pending: string[];
	pid?: number;
	settledAt?: number;
	runPrompt?: string;
	runStartedAt?: number;
	runBaseLeafId?: string | null;
	/** Leaf the next run must resume on; see `BgAgent.nextRunLeaf`. */
	nextRunLeaf?: string;
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

/** Keep undelivered messages and model choices durable across restarts. */
function needsPersist(a: BgAgent): boolean {
	return !!a.proc || !!a.nextModel || a.pending.length > 0 ||
		a.state === "working" || a.state === "queued";
}

function writeAtomic(file: string, data: string) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data, "utf-8");
	fs.renameSync(tmp, file);
}

/**
 * Sidecar files this module owns for one agent. `removeAgentFiles` must touch
 * only these: `AGENTS_DIR` is shared, and a blanket `${id}.*` glob deleted
 * state written by other subsystems that happen to live beside it (notably
 * session-workers' `<id>.wake` / `<id>.wake-state`, so finishing a parent run
 * silently destroyed its own undelivered wake).
 */
const AGENT_SIDECARS = [
	"json", "out", "err", "exit", "stop", "beat", "runlock",
] as const;

function isAgentSidecar(id: string, name: string): boolean {
	const suffix = name.slice(id.length + 1);
	for (const ext of AGENT_SIDECARS) {
		// `<id>.json`, plus the `<id>.json.<pid>.tmp` written by writeAtomic.
		if (suffix === ext || suffix.startsWith(`${ext}.`)) return true;
	}
	// Adoption claim directories: `<id>.adopt-<owner>-<ownerBeat>`.
	return suffix.startsWith("adopt-");
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
		if (!isAgentSidecar(id, n)) continue;
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
		extensionPaths: a.extensionPaths,
		nextModel: a.nextModel,
		sessionFile: a.sessionFile,
		state: a.state,
		pending: a.pending,
		pid: a.pid,
		settledAt: a.settledAt,
		runPrompt: a.runPrompt,
		runStartedAt: a.runStartedAt,
		runBaseLeafId: a.runBaseLeafId,
		nextRunLeaf: a.nextRunLeaf,
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
export function readExit(a: BgAgent): number | undefined {
	try {
		const m = JSON.parse(fs.readFileSync(agentFile(a.id, "exit"), "utf-8"));
		if (a.pid && m.pid && m.pid !== a.pid) return undefined;
		// The stop path writes this marker BEFORE signalling itself (`writeExit`
		// then SIGTERM, SIGKILL after 3s). Treating the marker as proof of exit
		// let the supervisor finish the run -- and `pump()` the next one -- while
		// the old child was still alive, so two runs could overlap on one session
		// file. Only trust it once the pid is gone.
		if (a.pid && pidAlive(a.pid)) return undefined;
		return typeof m.code === "number" ? m.code : 1;
	} catch {
		return undefined;
	}
}

/**
 * True when a long-silent adopted run should be treated as exited.
 *
 * Silence alone is not proof: a process suspended by GC or the OS stops beating
 * while still running its child, and concluding "gone" finished the run and
 * pumped the next one while the original was still alive. The recorded pid must
 * also be gone. Exported so this can be tested without waiting out the grace
 * windows on a real adopted run.
 */
export function silenceMeansGone(a: {
	id: string;
	runStartedAt?: number;
	pid?: number;
}): boolean {
	const age = Date.now() - (a.runStartedAt ?? 0);
	if (age <= CHILD_GRACE_MS) return false;
	if (childBeatAge(a.id) <= CHILD_STALE_MS) return false;
	return !a.pid || !pidAlive(a.pid);
}

/** True when this pid names a live process we can see. */
function pidAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: alive, just not ours.
		return (error as NodeJS.ErrnoException).code === "EPERM";
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

export interface AgentSupervisorOptions {
	/** Background parents must restrict adoption to their delegated team. */
	allowBackground?: boolean;
	adoptSessionIds?: ReadonlySet<string>;
	/**
	 * Called on every supervisor tick, before orphan adoption. Extensions use it
	 * to apply durable cross-process work (e.g. a queued wake) that must be
	 * picked up by whichever process holds the session, not by the writer.
	 *
	 * Anything a hook does is work the tick did not do before, so keep it
	 * proportional to live state rather than to the session archive. The sibling
	 * of this interface is where the foreign-run watcher's scan was measured
	 * (~0.05ms at 2 live records, ~0.96ms at 50); use that as the budget.
	 */
	onTick?: () => void;
}

/**
 * The hooks riding the one supervisor interval, keyed by the subsystem that owns
 * them.
 *
 * There is deliberately only ONE interval: it heartbeats every owned run and
 * adopts orphans, which must happen once, not once per extension. It used to
 * also hold a single `onTick`, and every caller did `clearInterval(previous)`
 * before installing its own -- so the last extension to register silently deleted
 * the others' work. That is what stopped the inbox from ever noticing a run the
 * phone finished: `session-workers` registers on the same `session_start` and
 * took the hook away. Hooks are additive now, and an idempotent key per caller
 * means a re-registration (a session switch, a `/reload`) replaces its own hook
 * rather than stacking up.
 */
const SUPERVISOR_HOOKS_KEY = Symbol.for("pi.inbox.agentSupervisorHooks");

interface SupervisorState {
	hooks: Map<string, AgentSupervisorOptions>;
}

function supervisorState(): SupervisorState {
	const G = globalThis as any;
	return (G[SUPERVISOR_HOOKS_KEY] ??= { hooks: new Map() });
}

/**
 * Heartbeat owned runs, run every subsystem's tick hook, and adopt orphans.
 *
 * Safe across session reloads. Callers pass a stable `id` so re-registering from
 * an extension that is re-instantiated per session replaces its own hook; several
 * callers coexist on the single interval.
 */
export function startAgentSupervisor(
	options: AgentSupervisorOptions = {},
	id = "default",
) {
	const state = supervisorState();
	const G = globalThis as any;
	const key = Symbol.for("pi.inbox.agentSupervisor");
	// A background parent may only supervise its own delegated team, so a caller
	// that does not scope its adoption installs nothing. Drop any hook it left
	// behind rather than letting a stale one keep adopting.
	if (
		isAgentChild() &&
		!(options.allowBackground && options.adoptSessionIds)
	) {
		state.hooks.delete(id);
		if (state.hooks.size === 0 && G[key]) {
			clearInterval(G[key]);
			G[key] = undefined;
		}
		return;
	}
	state.hooks.set(id, options);
	if (!G[key]) {
		G[key] = setInterval(runSupervisorTick, OWNER_BEAT_MS);
		G[key].unref?.();
	}
	runSupervisorTick();
}

/**
 * The adoptable set for however many hooks are registered.
 *
 * A background parent's hooks are all scoped sets, and adopting the union of them
 * is exactly what each would have adopted alone. A hook with no set adopts
 * everything, which only an interactive pi can register.
 */
function supervisorAdoptScope(
	state: SupervisorState,
): ReadonlySet<string> | undefined {
	const union = new Set<string>();
	for (const options of state.hooks.values()) {
		if (!options.adoptSessionIds) return undefined;
		for (const id of options.adoptSessionIds) union.add(id);
	}
	return union;
}

function runSupervisorTick(): void {
	const state = supervisorState();
	for (const a of listAgents()) if (needsPersist(a)) persist(a);
	// One failing hook must not cost the others their tick, and adoption (which
	// keeps queues draining) must never be skipped because a hook threw.
	for (const options of state.hooks.values()) {
		try {
			options.onTick?.();
		} catch {
			// best effort: the next tick tries again
		}
	}
	adoptOrphans(supervisorAdoptScope(state));
}

function adoptOrphans(allowedIds?: ReadonlySet<string>) {
	let names: string[] = [];
	try {
		names = fs.readdirSync(AGENTS_DIR);
	} catch {
		return;
	}
	for (const n of names) {
		if (!n.endsWith(".json")) continue;
		const id = n.slice(0, -5);
		if (allowedIds && !allowedIds.has(id)) continue;
		if (registry().agents.has(id)) continue;
		let s: SavedAgent;
		try {
			s = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, n), "utf-8"));
		} catch {
			continue;
		}
		if (!mayAdopt(s)) continue;
		// Atomic claim: only one pi can adopt from this particular (owner, beat).
		try {
			fs.mkdirSync(path.join(AGENTS_DIR, `${id}.adopt-${s.owner}-${s.ownerBeat}`));
		} catch {
			continue;
		}
		adopt(s);
	}
}

/**
 * True when this process may take over a saved agent record.
 *
 * A stale heartbeat is NOT proof the owner died: a process suspended by GC or
 * the OS stops beating while still running its child. Adopting then pumping puts
 * a second writer on that session, which is the two-writer shape this whole
 * area keeps rediscovering. So the recorded pids must also be gone; a live pid
 * we cannot signal (EPERM) still counts as "theirs".
 *
 * Exported so the rule can be tested without a real foreign process.
 */
export function mayAdopt(s: {
	owner: number;
	ownerBeat: number;
	pid?: number;
}): boolean {
	const mine = s.owner === process.pid;
	if (!mine && Date.now() - s.ownerBeat < OWNER_STALE_MS) return false;
	if (!mine && s.owner > 0 && pidAlive(s.owner)) return false;
	if (s.pid && pidAlive(s.pid)) return false;
	return true;
}

function adopt(s: SavedAgent) {
	const a: BgAgent = {
		id: s.id,
		cwd: s.cwd,
		title: s.title,
		model: s.model,
		extensionPaths: s.extensionPaths,
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
	const inFlight =
		s.pid &&
		(s.state === "working" ||
			s.state === "cancelled" ||
			s.settledAt !== undefined);
	if (inFlight) {
		a.pid = s.pid;
		a.settledAt = s.settledAt;
		a.runPrompt = s.runPrompt;
		a.runStartedAt = s.runStartedAt;
		a.runBaseLeafId = s.runBaseLeafId;
		a.nextRunLeaf = s.nextRunLeaf;
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

/**
 * The cwd recorded in a session file's header, i.e. the directory that session
 * belongs to. `--session-id` only searches the current process cwd's project
 * directory, so a run started from the wrong cwd silently creates a brand-new
 * file for the same id instead of reopening the existing one.
 */
export function sessionCwd(file: string | undefined): string | undefined {
	if (!file) return undefined;
	try {
		const cwd = SessionManager.open(file).getHeader()?.cwd;
		return typeof cwd === "string" && cwd ? cwd : undefined;
	} catch {
		return undefined;
	}
}

/**
 * One process's claim about one session, written to `inbox-live/<pid>.json`.
 *
 * The file is written on `session_start`, so it means "this process has this
 * session open" -- `open: true`. `state` is the separate, narrower claim:
 * `working` only while a run is actually in flight. Several processes may hold
 * a session open; only one may write it.
 *
 * Those two facts used to be conflated, and each reader invented its own rule
 * for telling them apart. That drift is what parked messages behind "queued
 * (after this run)" and what let a frozen orphan block a session forever. They
 * are one function now: `isWriting`.
 */
export interface LiveRecord {
	pid: number;
	sessionId: string;
	sessionFile: string;
	state: "working" | "idle";
	updated: number;
	/** Set when this process is a background agent: pid of the pi that runs it. */
	bgParent?: number;
	/**
	 * How long this claim has failed to count as a writer, in minutes, once it has
	 * stopped counting.
	 *
	 * Two different things produce it, and the UI says "no progress" rather than
	 * "silent" because of the second: a process frozen mid-turn (orphaned tab,
	 * suspended laptop) stops refreshing `updated` entirely, while a background
	 * run whose owning pi is gone keeps pulsing happily inside one tool call that
	 * never returns. Only `isWriting` decides; this is display state.
	 */
	stuckMin?: number;
	/**
	 * When this run began, written once when the record is created and preserved
	 * by the heartbeat, which only rewrites `updated`.
	 *
	 * The staleness cutoff cannot see a run wedged inside one tool call: the pulse
	 * keeps `updated` fresh, so it looks maximally busy while making no progress.
	 * This is the clock that catches that.
	 * Absent on records written before it existed; `liveRecordBirthMs` is the
	 * fallback, and an unknown start keeps the conservative "still a writer".
	 */
	startedAt?: number;
}

/**
 * A `working` claim older than this no longer counts as a writer.
 *
 * This is a safety margin against a process that is ALIVE but has stopped
 * refreshing -- a frozen tab, a suspended laptop, a SIGSTOPped run. It is not a
 * cooldown after finishing, and a normal finish does not wait it out:
 *
 *   - `agent_settled` writes `state: "idle"` immediately, so a finished run
 *     stops counting on the very next read (0s).
 *   - a crash or SIGKILL leaves the pid gone, which `isWriting` rejects on the
 *     first read (0s).
 *   - only a live pid that stopped stamping `updated` waits, and only because it
 *     might still be mid-write; releasing it early is how two writers end up on
 *     one session file.
 *
 * The writer refreshes every `LIVE_STALE_MS / 5`, so real work is never near the
 * edge -- five missed pulses is the margin for a long GC pause or a tool call
 * that blocks the event loop.
 */
export const LIVE_STALE_MS = 5 * 60_000;

/**
 * The single reading rule for a live record: is this process WRITING `id`
 * right now?
 *
 * A record is "open" on `session_start`, which is a much weaker claim than
 * "writing", and a pid can be alive while frozen mid-turn. So a writer is all
 * three of: it says `working`, its pid is alive, and that claim is fresh. Every
 * gate that asks "may I spawn / move / answer this" uses this, so the three
 * answers cannot drift apart again.
 *
 * The freshness clause only matters for a live-but-silent process: a finished
 * run has already flipped to `idle`, and a crashed one has no pid left.
 */
export function isWriting(
	rec: Pick<LiveRecord, "pid" | "state" | "updated" | "bgParent" | "startedAt">,
	since: number = Date.now(),
): boolean {
	if (rec.state !== "working") return false;
	if (!pidAlive(rec.pid)) return false;
	if (since - (Number(rec.updated) || 0) > LIVE_STALE_MS) return false;
	return !ownerGone(rec, since);
}

/**
 * Which of two live records for ONE session better describes it, when a reader
 * has to collapse several records into one.
 *
 * More than one record can name a session: a window holds it open (`idle`)
 * while the run it is watching holds it too (`working`). The window's record
 * pulses `updated` every minute; the run's is stamped once at `agent_start`.
 * Ranking by recency alone therefore picks the idle window and reports the
 * session idle while it is being worked -- which hides the foreign-run badge
 * and makes a row fall through to its transcript tail and read as "stalled".
 *
 * A `working` claim always wins; recency only breaks ties within a state.
 * Callers that must not lose a foreign writer entirely should ask
 * `foreignWorkingFor` over every record instead of collapsing to one.
 */
export function freshestLive<
	T extends { state: string; updated?: number },
>(a: T, b: T): boolean {
	const aw = a.state === "working";
	const bw = b.state === "working";
	if (aw !== bw) return aw;
	return (Number(a.updated) || 0) > (Number(b.updated) || 0);
}

/**
 * True when a background run has outlived the pi that started it, long enough
 * that it is stuck rather than merely waiting to be adopted.
 *
 * Deliberately asks about the RUN'S AGE, not only about `bgParent` being dead.
 * Those are different questions, and the difference is what keeps this safe:
 *
 *   - The parent being gone is NORMAL and expected. The child is spawned
 *     `detached` precisely so a closed tab does not kill an agent mid-task, and
 *     a live pi picks it up through `adoptOrphans`. Releasing the writer slot on
 *     "parent is dead" alone would let a second writer start beside a perfectly
 *     healthy orphan during the ~20s before adoption -- the exact two-writer
 *     bug (`zero-token aborts`) this area has been fixed for twice.
 *   - A run still unadopted after `ORPHANED_RUN_GRACE_MS` is not being rescued.
 *     Either no pi is running, or the one that could has already had ample time.
 *     It is then stuck, and must stop owning the session.
 *
 * A run with no `bgParent` is an interactive pi's own turn: its user is sitting
 * in front of it, so a live pid with a fresh heartbeat really is a writer.
 *
 * Age comes from the live file's CREATION time, not from `updated`: the pulse
 * rewrites `updated` every second, so a run wedged inside one tool call looks
 * maximally fresh forever. That freshness is exactly what a plain staleness
 * cutoff cannot catch, and why this needed its own clock.
 */
function ownerGone(
	rec: Pick<LiveRecord, "updated" | "bgParent" | "pid" | "startedAt">,
	now: number,
): boolean {
	if (!rec.bgParent) return false;
	if (pidAlive(rec.bgParent)) return false;
	// The record's own `startedAt` is the clock; a file creation time is only a
	// fallback for records written before that field existed. An unknown start
	// keeps the safe answer (still a writer) rather than guessing.
	const started = Number(rec.startedAt) > 0
		? Number(rec.startedAt)
		: liveRecordBirthMs(rec);
	if (started === undefined) return false;
	return now - started > ORPHANED_RUN_GRACE_MS;
}

/**
 * When this live record was created, or undefined when that cannot be known.
 *
 * The file is named by pid and written once at `session_start`, so its creation
 * time is the run's start. An unknowable age is reported as undefined so callers
 * keep the conservative "still a writer" answer rather than guessing.
 */
function liveRecordBirthMs(rec: Pick<LiveRecord, "pid" | "updated">): number | undefined {
	const file = path.join(getAgentDir(), "inbox-live", `${rec.pid}.json`);
	try {
		const st = fs.statSync(file);
		// birthtime can be 0 on filesystems that do not record it; the mtime is a
		// LOWER bound on age (the pulse only moves it forward), so using it can only
		// make a run look YOUNGER than it is -- the safe direction, since younger
		// means "still a writer".
		return Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0
			? st.birthtimeMs
			: st.mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * True when `pid` holds a writer slot it can no longer justify: a background run
 * whose owning pi is gone and that no other pi picked up in time.
 *
 * `pidAlive` alone cannot answer this. A wedged run keeps a live pid and a fresh
 * heartbeat while sitting inside one tool call that never returns, so every
 * cheap liveness check says "busy" forever. This is where a run that `isWriting`
 * has already stopped counting must also give up its `runlock`, or the lock keeps
 * enforcing the stale claim the read path just rejected.
 *
 * An unreadable or missing live record means "cannot prove it is abandoned", so
 * the lock is left alone.
 */
export function abandonedWriter(pid: number, now: number = Date.now()): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	let rec: LiveRecord;
	try {
		rec = JSON.parse(
			fs.readFileSync(path.join(getAgentDir(), "inbox-live", `${pid}.json`), "utf-8"),
		);
	} catch {
		return false;
	}
	if (rec.pid !== pid) return false;
	return ownerGone(rec, now);
}

/**
 * True when some OTHER process is already running this session.
 *
 * The single chokepoint every spawn path shares. `a.proc` only guards within
 * one process's registry, so a second pi -- an adopted orphan, a window that
 * reopened the session, the orch-web daemon -- could start a second
 * `pi --session <path>` beside a live one. Two writers on one session file is
 * what produced the zero-token aborts this was traced from, and patching one
 * caller at a time left the others open (the wake path, `sendToAgent`, and
 * orphan adoption each had their own check, or none).
 *
 * Consults the live records by session id -- NOT by pid, which is what the
 * older `runningElsewhere` helpers do, and why they miss a writer held by this
 * very process under a different session.
 *
 * Uses `isWriting`, which is why a session merely held OPEN (an attached view,
 * a taken-over window, the phone) does not block, and why a frozen orphan does
 * not block forever.
 */
export function writerElsewhere(id: string): boolean {
	return liveRecordsFor(id).some((rec) => isWriting(rec));
}

/**
 * The live records naming `id`.
 *
 * A record is written on `session_start`, so it means "this process has the
 * session open" — which is NOT the same claim as "this process is writing it".
 * Ask `isWriting` for the narrow question; use these directly only when the
 * distinction is what you are displaying.
 */
/**
 * Every live record naming `id`, unfiltered.
 *
 * Unlike `readLive()`'s map, this keeps ALL pids: several processes can hold one
 * session at once (a window that just reloaded writes its own `idle`, which would
 * otherwise mask a foreign `working`). Callers apply their own rule.
 */
export function liveRecordsFor(id: string): LiveRecord[] {
	// Resolved at call time, not from the module-level AGENTS_DIR: that constant
	// is captured at import, so a test (or any caller with a redirected agent
	// dir) would read the wrong directory entirely -- and silently report "no
	// writer" because the folder is missing.
	const dir = path.join(getAgentDir(), "inbox-live");
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: LiveRecord[] = [];
	for (const name of names) {
		let rec: LiveRecord;
		try {
			rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
		} catch {
			continue;
		}
		if (rec.sessionId !== id) continue;
		if (!rec.pid || !Number.isSafeInteger(rec.pid) || rec.pid <= 0) continue;
		out.push(rec);
	}
	return out;
}

/**
 * Why a pending message has not started yet.
 *
 * "queued" used to be one word for three unrelated situations, and the UI
 * reported all of them as "waiting for a free agent slot". Only `slot` is that.
 * `writer` is the one-writer gate: another process is actively writing this
 * session, and no amount of capacity would help. "running" is simply this
 * agent's own run still being in flight.
 */
export type QueueReason = "running" | "slot" | "writer";

/**
 * True when a live record for `id` names a process other than this one that is
 * actually WORKING on it.
 *
 * `writerElsewhere` deliberately counts our own pid too: from `run()`'s point of
 * view a run this process holds here is exactly the writer it must not spawn
 * beside. That is right for the gate and wrong for the label, which then told
 * the user "another pi is running it" about the window they were typing in.
 *
 * So the label asks the narrower question. Same records, same rule, but our own
 * pid is this session, not a stranger. Note both questions now exclude an `idle`
 * record: having a session OPEN is not writing it.
 */
function writerIsForeign(id: string): boolean {
	return liveRecordsFor(id).some(
		(rec) => rec.pid !== process.pid && isWriting(rec),
	);
}

/**
 * Why `id`'s queued messages are not running, or undefined when they can.
 *
 * `writerElsewhere` is checked before the cap because it is the reason that
 * looks identical in the UI but is not capacity at all -- a stale live record
 * for a session whose process is gone used to read as "working" until the
 * 5-minute silence cutoff, which is what made an idle session look busy.
 */
export function queueReason(id: string): QueueReason | undefined {
	const a = getAgent(id);
	if (a?.proc) return "running";
	if (a && a.hold) return "running";
	// Our own live record means our own run is in flight, which is "running".
	// Only a record naming a DIFFERENT live process is a foreign writer.
	if (writerIsForeign(id)) return "writer";
	if (writerElsewhere(id)) return "running";
	if (runningCount() >= MAX_CONCURRENT) return "slot";
	return undefined;
}

/**
 * Exclusive cross-process lock for one session's writer slot.
 *
 * `writerElsewhere` closes the common case (a live record already exists)
 * but it is a READ: two processes calling `run()` at the same instant both
 * observe no writer and both spawn. `a.proc` cannot help -- it is one
 * process's registry. `O_EXCL` create is the atomic primitive, the same one
 * `claimEpisodeWake` uses for the wake side. The lock records the pid that
 * holds it, so one left behind by a process that crashed between acquire and
 * release is reclaimed rather than wedging the session forever.
 */
function runLockFile(id: string): string {
	return path.join(getAgentDir(), "inbox-agents", `${id}.runlock`);
}

export function acquireRunLock(id: string): boolean {
	const file = runLockFile(id);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, String(process.pid), { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
	}
	let holder = NaN;
	try {
		holder = Number(fs.readFileSync(file, "utf-8").trim());
	} catch {
		return false;
	}
	if (!Number.isSafeInteger(holder) || holder <= 0) return false;
	// Our own pid: a later run in this process implies the earlier one ended,
	// and two runs of one session cannot coexist here anyway (`a.proc`). So this
	// is a release we missed on an error path, not a competitor.
	//
	// A live holder is normally a competitor. The exception is an abandoned
	// background run: its pid is alive and its heartbeat is fresh, but its owning
	// pi is gone and nobody adopted it, so it is wedged rather than working. It
	// kept this session unwritable indefinitely (observed: 3h40m past its
	// parent's exit). `isWriting` already stopped counting it; the lock must not
	// go on enforcing the claim the read path rejected.
	if (holder !== process.pid && pidAlive(holder) && !abandonedWriter(holder)) return false;
	try {
		fs.writeFileSync(file, String(process.pid));
		return true;
	} catch {
		return false;
	}
}

/** Drop the run lock, but only when this process holds it. */
export function releaseRunLock(id: string): void {
	const file = runLockFile(id);
	try {
		if (Number(fs.readFileSync(file, "utf-8").trim()) !== process.pid) return;
	} catch {
		return;
	}
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// Best effort: a dead-pid lock is reclaimed by the next acquire.
	}
}

function run(a: BgAgent) {
	// One writer per session, enforced here so every caller is covered: `pump()`,
	// `sendToAgent`, wake delivery, and orphan adoption all funnel through this.
	// Leave the message queued rather than racing the live writer; the next pump
	// after that run ends picks it up.
	// The registry's own `proc` is the authoritative "this session is running
	// here" check, so only a writer OUTSIDE this process blocks -- and only an
	// ACTIVE one: a `writerElsewhere` hit means some process is working this
	// session right now. A session merely held OPEN (an attached view, a
	// taken-over window, the phone) is not writing it, and blocking on that made
	// an ordinary open session read as unwritable forever.
	if (writerElsewhere(a.id) && !a.proc) {
		a.state = a.pending.length ? "queued" : a.state;
		persist(a);
		return;
	}
	// `writerElsewhere` is a READ of the live records: two processes calling run()
	// in the same instant both see no writer and both spawn. Take an exclusive
	// lock so the guarantee is mutual exclusion rather than a likely-correct
	// glance. Ordered after the advisory check so the common case (a writer
	// already visible) does not touch the filesystem twice.
	if (!acquireRunLock(a.id)) {
		a.state = a.pending.length ? "queued" : a.state;
		persist(a);
		return;
	}
	// Capture before the child can append its prompt or any tool steps.
	a.runStartedAt = Date.now();
	const resumeLeaf = a.nextRunLeaf;
	a.nextRunLeaf = undefined;
	a.runBaseLeafId = a.sessionFile && fs.existsSync(a.sessionFile)
		? SessionManager.open(a.sessionFile).getLeafId() : null;
	// Pin the caller's view before spawning. There is no leaf argument on the
	// command line, so a child always resumes on the file's LAST line; without
	// this a `/tree` position is silently discarded and the prompt continues the
	// newest branch instead. The marker is the same mechanism `tree-position`
	// uses, and the last line of the file then IS the chosen leaf.
	if (resumeLeaf && a.sessionFile && fs.existsSync(a.sessionFile)) {
		try {
			const sm = SessionManager.open(a.sessionFile);
			// Only when it would otherwise resume somewhere else: an ordinary
			// send already lands on the tip and does not need another marker.
			if (sm.getLeafId() !== resumeLeaf && sm.getEntry(resumeLeaf)) {
				sm.branch(resumeLeaf);
				sm.appendCustomEntry("pi-kit.tree-position", {});
			}
		} catch {
			// A marker we could not write is not worth failing the run over; the
			// child falls back to its normal resume point.
		}
	}
	// Reopen the session by PATH, not by id. `--session-id` is resolved against
	// the cwd's project directory only, so a run whose cwd differs from where
	// the session was created does not find it and pi quietly starts a new,
	// blank session under the same id ("No project session found with id ...,
	// creating a new session"), orphaning the real transcript. A path is
	// unambiguous, and the header supplies the cwd the session actually belongs
	// to, so the child reopens the same conversation wherever it was started.
	const existing = a.sessionFile && fs.existsSync(a.sessionFile)
		? a.sessionFile
		: findSessionFile(a.id);
	const cwd = sessionCwd(existing) ?? a.cwd;
	// Keep the durable record pointing at the directory the session lives in.
	a.cwd = cwd;
	const message = a.pending.shift()!;
	a.log = [];
	a.liveText = "";
	a.items = [{ kind: "prompt", text: message }];
	logLine(a, `› ${message}`);
	a.liveRun = newLiveRun();
	liveUser(a, cleanUserText(message));
	const { cmd, pre } = piCommand();
	const target = existing
		? ["--session", existing]
		: ["--session-id", a.id];
	const args = [...pre, "--mode", "json", ...target, ...extensionArgs()];
	for (const extension of a.extensionPaths ?? []) {
		args.push("--extension", extension);
	}
	// --model wins over the model the session would restore, and is saved in the session.
	const model = a.nextModel ?? (a.runs === 0 ? a.model : undefined);
	a.nextModel = undefined;
	if (model) args.push("--model", model);

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
		// stdin is a pipe we write the message to (see spawn below).
		child = spawn(cmd, args, {
			cwd,
			env: {
				...process.env,
				PI_INBOX_BG_PARENT: String(process.pid),
				PI_INBOX_BG_AGENT: a.id,
				[BACKGROUND_MCP_AUTO_APPROVE_ENV]: "1",
				// The daemon's bearer credential is not a child agent's
				// business: an agent can read its environment, and a run that
				// leaks it would defeat rotating the token file. Undefined
				// deletes the key from the child's environment.
				ORCH_WEB_TOKEN: undefined,
			},
			stdio: ["pipe", outFd, errFd],
			detached: true,
		});
		child.unref();
		// Deliver the prompt on stdin. detached children must not inherit our tty's
		// stdin, and a pipe lets the message start with any character (incl. '@')
		// without tripping pi's `@file` argument expansion.
		child.stdin!.on("error", () => {}); // EPIPE if the child dies early
		child.stdin!.end(message);
	} catch (e) {
		a.state = "error";
		a.error = `spawn failed: ${e instanceof Error ? e.message : String(e)}`;
		a.needsYou = true;
		// Nothing is running, so the session must not stay locked: a lock held by a
		// failed spawn would block every later run of this session.
		releaseRunLock(a.id);
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
	a.settledAt = undefined;
	a.runPrompt = message;
	a.outOffset = 0;
	a.runs++;
	a.state = "working";
	a.error = undefined;
	a.activity = "starting…";
	persist(a);
	touch(a);
	traceRun("run_start", a, { pid: child.pid, runs: a.runs });
	monitor(a, child);
}

/**
 * Wake-path tracing, gated behind `PI_WAKE_TRACE=1`.
 *
 * Lives here rather than in the extension because the question is about RUN
 * lifecycle: a follow-up can be aborted at zero tokens before a model call, and
 * that is only answerable by correlating run start/end with the delivery
 * decision. Imported lazily so the extension stays optional.
 */
function traceRun(
	event: string,
	a: BgAgent,
	extra: Record<string, unknown> = {},
): void {
	void import("../../extensions/session-workers/trace.ts")
		.then((m) => m.trace(event, { sessionId: a.id, ...extra }))
		.catch(() => {
			// Tracing is strictly optional.
		});
}

/** Tail the agent's event file and notice when its run ends (child exit, exit marker, or silence). */
function monitor(a: BgAgent, child?: ChildProcess) {
	let exited: number | undefined;
	let exitSignal: string | undefined;
	let settledStopRequested = false;
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
			//
			// Silence is not proof of death. A process suspended by GC or the OS
			// stops beating while still running, and concluding "-1" here finished
			// the run and pumped the next one while the original was alive -- the
			// same two-writer shape the exit-marker fix closed. Require the pid to
			// be gone before treating silence as an exit.
			if (silenceMeansGone(a)) code = -1;
		}
		if (
			code === undefined &&
			a.settledAt &&
			!settledStopRequested &&
			Date.now() - a.settledAt > SETTLED_EXIT_GRACE_MS
		) {
			// agent_settled is definitive. Do not leave a JSON-mode process that
			// failed to exit holding the agent in a half-finished state forever.
			settledStopRequested = true;
			a.proc?.kill("SIGTERM");
		}
		if (code === undefined) return;
		clearInterval(timer);
		drain();
		finishRun(a, code, exitSignal);
	}, 300);
	timer.unref?.();
}

function finishRun(a: BgAgent, code: number, signal?: string) {
	traceRun("run_end", a, {
		code,
		signal,
		settled: a.settledAt !== undefined,
		pending: a.pending.length,
	});
	const wasSettled = a.settledAt !== undefined;
	// Same boundary as settleRun: the run is over, so its live items are stale.
	// A session that went straight to an error or a cancel never settled.
	a.items = [];
	a.proc = undefined;
	// The run's writer slot is free again. Released before any pump can be
	// triggered below, so the next run of this session can take it.
	releaseRunLock(a.id);
	a.pid = undefined;
	a.settledAt = undefined;
	flushPendingModel(a);
	a.runPrompt = undefined;
	a.runStartedAt = undefined;
	a.runBaseLeafId = undefined;
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
	} else if ((code !== 0 && !wasSettled) || a.error) {
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
			addItem(a, {
				kind: "tool",
				text: a.activity,
				id: typeof ev.toolCallId === "string" ? ev.toolCallId : undefined,
			});
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
				addItem(a, {
					kind: "error",
					text: `${ev.toolName ?? "tool"} failed`,
					id: typeof ev.toolCallId === "string" ? ev.toolCallId : undefined,
				});
			}
			break;
		case "message_start":
			if (ev.message?.role === "assistant") liveStartAssistant(a, ev);
			else if (ev.message?.role === "user") {
				const t = textOf(ev.message.content).trim();
				if (!t) break;
				// Bind only the first echo to the locally seeded prompt. Later
				// identical steering prompts are distinct messages. Keep the raw
				// timestamp: Pi's wire messages have no session-entry id.
				const first = a.liveRun?.msgs[0];
				const seeded = comparableUserText(a.runPrompt ?? "");
				if (
					first?.role === "user" &&
					!first.message &&
					comparableUserText(t) === seeded
				) {
					first.message = ev.message;
					liveTouch(a, first);
				} else {
					liveUser(a, cleanUserText(t), ev.message);
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
				addItem(a, {
					kind: "text",
					text,
					ts: typeof m.timestamp === "number" ? m.timestamp : undefined,
				});
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
			// A provider error that pi retried successfully isn't a run failure.
			// Preserve the explicit final error even if no message_end carried it.
			if (ev.success) a.error = undefined;
			else if (typeof ev.finalError === "string" && ev.finalError) {
				a.error = ev.finalError;
			}
			touch(a);
			break;
		case "agent_settled":
			settleRun(a);
			break;
		case "compaction_start":
			a.activity = "compacting…";
			touch(a);
			break;
	}
}

/**
 * Reflect Pi's definitive run boundary immediately. The process handle stays
 * attached until the one-shot child exits, preventing concurrent session
 * writes.
 */
function settleRun(a: BgAgent) {
	if (a.settledAt) return;
	a.settledAt = Date.now();
	a.activity = undefined;
	// The run's items describe work IN FLIGHT. Every finished message is already
	// in the session file by the time `agent_settled` arrives, so keeping them
	// made `items` replay the completed run as if it were still happening -- the
	// phone drew the final answer twice, once from the transcript and again in
	// its live box below it. Nothing else reads `items`; it is reset in `run()`.
	a.items = [];
	if (a.restartAfterInterrupt) {
		a.state = a.pending.length ? "queued" : "idle";
	} else if (a.state !== "cancelled" && a.error) {
		a.state = "error";
	} else if (a.state !== "cancelled") {
		a.state = a.pending.length ? "queued" : "idle";
	}
	a.needsYou = a.state === "error" ||
		(a.state === "idle" && a.pending.length === 0);
	persist(a);
	touch(a);
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
export function spawnAgent(opts: {
	id?: string; prompt: string; cwd: string; model?: string; title: string;
	extensionPaths?: string[];
}): BgAgent {
	const a: BgAgent = {
		// Callers can reserve an id to persist group membership before launch.
		id: opts.id ?? randomUUID(),
		cwd: opts.cwd,
		title: opts.title,
		model: opts.model,
		extensionPaths: opts.extensionPaths,
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
export function sendToAgent(opts: {
	id: string; cwd: string; sessionFile?: string; title: string;
	text: string; model?: string; extensionPaths?: string[];
	/**
	 * Leaf the sender was viewing. Pins where the child resumes, so a `/tree`
	 * position survives the delegated spawn instead of the prompt landing on the
	 * file's newest line. Omit for a background worker with no branch on screen.
	 */
	leaf?: string;
}): BgAgent {
	let a = getAgent(opts.id);
	if (!a) {
		a = {
			id: opts.id,
			cwd: opts.cwd,
			title: opts.title,
			extensionPaths: opts.extensionPaths,
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
	if (opts.leaf) a.nextRunLeaf = opts.leaf;
	if (opts.extensionPaths) a.extensionPaths = opts.extensionPaths;
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
	if (!flushPendingModel(a)) {
		throw new Error("Could not save the selected model before takeover.");
	}
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

/**
 * Memo for `sessionModel`, keyed on (mtime, size) like the inbox's parse cache.
 *
 * Opening a session parses the WHOLE file, and a session list asks for this
 * once per row. On a real machine that was 1.0 GB across 799 files: 2,171ms per
 * call. orch-web's SSE tick called it for every row every 1.2s, which is a
 * 2.2s rebuild on a 1.2s timer.
 */
const sessionModelCache = new Map<
	string,
	{ mtimeMs: number; size: number; value?: string }
>();

/** The model a session will use next: "provider/model:thinking", as pi restores it from the active branch. */
export function sessionModel(file: string | undefined): string | undefined {
	if (!file) return undefined;
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return undefined;
	}
	const cached = sessionModelCache.get(file);
	if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size)
		return cached.value;
	let branch: any[];
	try {
		branch = SessionManager.open(file).getBranch() as any[];
	} catch {
		return undefined;
	}
	const { model, level } = branchSettings(branch);
	const value = model ? `${model}${level ? `:${level}` : ""}` : undefined;
	sessionModelCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
	return value;
}

/** Split provider/model[:thinking] without breaking slash/colon model IDs. */
export function parseAgentModel(value: string | undefined): {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
} | undefined {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	const tail = value.slice(slash + 1);
	const level = tail.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
	return {
		provider: value.slice(0, slash),
		id: level ? tail.slice(0, level.index) : tail,
		thinkingLevel: level?.[1] as ThinkingLevel | undefined,
	};
}

/** A pending choice wins over the model still used by the in-flight run. */
export function nextSessionModel(id: string, file?: string): string | undefined {
	const a = getAgent(id);
	return a?.nextModel ?? sessionModel(file ?? a?.sessionFile) ?? a?.model;
}

function writeSessionModel(file: string, value: string): void {
	const choice = parseAgentModel(value);
	if (!choice) throw new Error(`Invalid model reference: ${value}`);
	const sm = SessionManager.open(file);
	const current = branchSettings(sm.getBranch());
	if (current.model !== `${choice.provider}/${choice.id}`) {
		sm.appendModelChange(choice.provider, choice.id);
	}
	if (choice.thinkingLevel && choice.thinkingLevel !== current.level) {
		sm.appendThinkingLevelChange(choice.thinkingLevel);
	}
}

/** Select a model without sending a prompt or touching a running transcript. */
export function setAgentModel(id: string, file: string, value: string): void {
	if (!parseAgentModel(value)) throw new Error("Invalid model reference");
	const a = getAgent(id);
	if (a && (a.proc || isRunning(a))) {
		a.nextModel = value;
		a.model = value;
		persist(a);
		touch(a);
		return;
	}
	writeSessionModel(file, value);
	if (a) {
		a.model = value;
		a.nextModel = undefined;
		persist(a);
		touch(a);
	}
}

/** Apply a deferred choice only after the child has stopped writing. */
function flushPendingModel(a: BgAgent): boolean {
	if (!a.nextModel) return true;
	const file = a.sessionFile ?? findSessionFile(a.id);
	if (!file) return false;
	try {
		writeSessionModel(file, a.nextModel);
		a.nextModel = undefined;
		return true;
	} catch {
		// Keep nextModel in the durable agent record for the next run to use.
		return false;
	}
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
		if (ch === "C") {
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
			...(isRunning(a) ? [k("C", "cancel")] : []),
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
