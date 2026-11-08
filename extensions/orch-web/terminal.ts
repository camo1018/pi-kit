/**
 * orch-web terminals: a real PTY on the Mac, driven from the phone.
 *
 * The session list can already start pi runs, but a run is not a prompt: things
 * that need a *human at a terminal* — a provider re-auth, `sudo`, a TUI you want
 * to nudge, an OAuth handshake — have nowhere to happen.
 * This module is that missing prompt. It is deliberately small and opt-in:
 *
 *   transport   POST open/input/resize/close, SSE out. The daemon already has an
 *               authenticated HTTP surface and no websocket library, and PTY
 *               output is a byte stream that SSE carries fine as base64 chunks.
 *   resume      a ring buffer with sequence numbers, so a phone that slept,
 *               switched apps, or reconnected replays exactly what it missed.
 *   lifecycle    one terminal at a time, reaped when no viewer is attached.
 *
 * Security posture. The bearer token already *is* a shell on this Mac in every
 * way that matters (it can spawn pi runs), but a PTY makes that literal, so it
 * is gated behind ORCH_WEB_ALLOW_TERM=1 and never enabled by default. Every
 * open/close is logged with the remote address.
 *
 * node-pty is a native module. It is imported lazily so the daemon still boots
 * (and the rest of orch-web keeps working) when it is missing or built for
 * another architecture; `available()` then reports why.
 */

import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/** What we need from a PTY; kept narrow so tests can stand in for node-pty. */
export interface PtyLike {
	pid: number;
	onData(cb: (data: string) => void): void;
	onExit(cb: (e: { exitCode: number }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
}

export type PtySpawn = (
	file: string,
	args: string[],
	opts: {
		name: string;
		cols: number;
		rows: number;
		cwd: string;
		env: Record<string, string | undefined>;
	},
) => PtyLike;

/** 512 KB of scrollback is more than a phone will ever scroll back through, and
 *  it is the ceiling on what a reconnect after a long sleep can replay. */
export const RING_BYTES = 512 * 1024;
/** Detached this long, the shell is killed. A PTY is not a daemon. */
export const IDLE_REAP_MS = 10 * 60_000;
/** Hard cap regardless of viewers: a shell started at breakfast should not be
 *  answering at midnight. */
export const MAX_LIFETIME_MS = 8 * 60 * 60_000;
const REAP_TICK_MS = 30_000;
const HEARTBEAT_MS = 20_000;

// ───────────────────────────── ring buffer ─────────────────────────────

export interface Chunk {
	/** 1-based; a viewer resumes by asking for everything after what it has. */
	seq: number;
	b64: string;
	bytes: number;
}

/**
 * PTY output, kept as ordered base64 chunks. Chunk boundaries never split a
 * UTF-8 character, because the client decodes to bytes and hands them to the
 * terminal, which copes with a partial sequence on its own.
 */
export class Ring {
	private chunks: Chunk[] = [];
	private bytes = 0;
	private next = 1;

	get lastSeq(): number {
		return this.next - 1;
	}

	/** Sequence number of the oldest chunk still held (0 when empty). */
	get firstSeq(): number {
		return this.chunks[0]?.seq ?? 0;
	}

	get size(): number {
		return this.bytes;
	}

	push(data: Buffer): Chunk {
		const chunk: Chunk = {
			seq: this.next++,
			b64: data.toString("base64"),
			bytes: data.length,
		};
		this.chunks.push(chunk);
		this.bytes += chunk.bytes;
		while (this.bytes > RING_BYTES && this.chunks.length > 1) {
			const dropped = this.chunks.shift()!;
			this.bytes -= dropped.bytes;
		}
		return chunk;
	}

	/** Everything after `since`, plus whether the request fell off the front. */
	since(since: number): { chunks: Chunk[]; truncated: boolean } {
		// The value arrives from a query string: NaN, negative and absurdly
		// large numbers all mean "give me what you have". Without this a client
		// could force a full replay on every reconnect by sending garbage.
		if (!Number.isFinite(since) || since <= 0)
			return { chunks: [...this.chunks], truncated: false };
		if (since >= this.lastSeq) return { chunks: [], truncated: false };
		if (since < this.firstSeq - 1)
			return { chunks: [...this.chunks], truncated: true };
		return { chunks: this.chunks.filter((c) => c.seq > since), truncated: false };
	}
}

// ───────────────────────────── loading node-pty ─────────────────────────────

let spawnFn: PtySpawn | undefined;
let loadError: string | undefined;

/**
 * Where an out-of-tree `node-pty` lives.
 *
 * pi-kit's own `node_modules` is a set of symlinks into the pi install, and
 * running `npm install` there would fight with them. So the native module is
 * installed separately and resolved by path:
 *
 *   npm install --prefix ~/.pi/agent/orch-web-deps node-pty
 *
 * ESM `import()` ignores NODE_PATH, so this cannot be a path tweak.
 */
export function depsDir(): string {
	const fromEnv = process.env.ORCH_WEB_DEPS?.trim();
	if (fromEnv) return fromEnv;
	return path.join(
		process.env.HOME || os.homedir(),
		".pi",
		"agent",
		"orch-web-deps",
	);
}

/** Resolve node-pty once. Failure is remembered, not thrown: the rest of
 *  orch-web must keep working on a machine that never installed it. */
export async function loadPty(): Promise<PtySpawn | undefined> {
	if (spawnFn || loadError) return spawnFn;
	const tried: string[] = [];
	try {
		const mod: any = await import("node-pty");
		const spawn = mod?.spawn ?? mod?.default?.spawn;
		if (typeof spawn !== "function") throw new Error("node-pty has no spawn()");
		spawnFn = spawn as PtySpawn;
		return spawnFn;
	} catch (e) {
		tried.push(e instanceof Error ? e.message : String(e));
	}
	// Second chance: the out-of-tree deps directory.
	try {
		const { createRequire } = await import("node:module");
		const { pathToFileURL } = await import("node:url");
		const dir = depsDir();
		const req = createRequire(path.join(dir, "noop.js"));
		const entry = req.resolve("node-pty");
		const mod: any = await import(pathToFileURL(entry).href);
		const spawn = mod?.spawn ?? mod?.default?.spawn;
		if (typeof spawn !== "function") throw new Error("node-pty has no spawn()");
		spawnFn = spawn as PtySpawn;
		return spawnFn;
	} catch (e) {
		tried.push(`${depsDir()}: ${e instanceof Error ? e.message : String(e)}`);
	}
	loadError = condense(tried);
	return undefined;
}

/**
 * The raw ESM error for a missing module is three lines of Require stack. What
 * the phone shows is one line, so keep only the sentence that names the cause.
 */
function condense(tried: string[]): string {
	const first = tried[0]?.split("\n")[0] ?? "unknown error";
	if (/Cannot find package|Cannot find module/.test(first))
		return first.replace(/^Cannot find (package|module) /, "missing ");
	return first;
}

/** Non-blocking readiness, for a client that wants to hide the menu entry. */
export function ptyStatus(): { ready: boolean; error?: string } {
	return { ready: !!spawnFn, error: loadError };
}

// ───────────────────────────── the terminal ─────────────────────────────

export interface TermInfo {
	id: string;
	pid: number;
	cols: number;
	rows: number;
	command: string;
	startedAt: number;
	exited?: { code: number; at: number };
	viewers: number;
	lastSeq: number;
}

interface Term {
	info: TermInfo;
	pty: PtyLike;
	ring: Ring;
	viewers: Set<http.ServerResponse>;
	/** Timers for this terminal's viewers, so shutdown can clear them too. */
	beats: Set<ReturnType<typeof setInterval>>;
	lastInput: number;
	lastViewer: number;
	closed: boolean;
}

export interface TermOptions {
	/** Structured log line, wired to the daemon's `say` in server.ts. */
	audit: (event: string, detail?: Record<string, unknown>) => void;
	spawn?: PtySpawn;
	enabled?: boolean;
	ringBytes?: number;
	idleMs?: number;
	maxLifetimeMs?: number;
	now?: () => number;
}

export class TerminalHost {
	private terms = new Map<string, Term>();
	private timer?: ReturnType<typeof setInterval>;
	private readonly audit: (event: string, detail?: Record<string, unknown>) => void;
	private spawnFn: PtySpawn | undefined;
	private readonly enabled: boolean;
	private readonly idleMs: number;
	private readonly maxLifetimeMs: number;
	private readonly now: () => number;
	private nextId = 1;

	constructor(opts: TermOptions) {
		this.audit = opts.audit;
		this.spawnFn = opts.spawn;
		this.enabled = opts.enabled ?? false;
		this.idleMs = opts.idleMs ?? IDLE_REAP_MS;
		this.maxLifetimeMs = opts.maxLifetimeMs ?? MAX_LIFETIME_MS;
		this.now = opts.now ?? Date.now;
	}

	/** Terminals are off unless the operator opted in. */
	get allowed(): boolean {
		return this.enabled;
	}

	/**
	 * The single *live* terminal, if any: the phone attaches instead of opening
	 * a second one. A shell that already exited is deliberately not "current" —
	 * a reload should start a new one rather than replay a dead prompt.
	 */
	current(): TermInfo | undefined {
		for (const t of this.terms.values()) if (!t.info.exited) return t.info;
		return undefined;
	}

	/**
	 * Start a shell — or hand back the one already running, so a phone that
	 * reloads the page does not leave a trail of orphaned shells behind.
	 */
	async open(opts: {
		cols?: number;
		rows?: number;
		fresh?: boolean;
		remote?: string;
	}): Promise<TermInfo> {
		if (!this.enabled)
			throw new TermError(403, "terminals are off; set ORCH_WEB_ALLOW_TERM=1");
		// The boot-time load is fire-and-forget; a phone can get here first.
		if (!this.spawnFn) this.spawnFn = await loadPty();
		if (!this.spawnFn)
			throw new TermError(
				503,
				`node-pty is not installed (${loadError ?? "unknown"}). Install it with ` +
					`npm install --prefix ${depsDir()} node-pty, then restart the daemon.`,
			);
		if (!opts.fresh) {
			const held = this.current();
			if (held && !held.exited) return held;
		}
		// One at a time: a fresh open replaces whatever was there.
		for (const t of [...this.terms.values()]) this.close(t.info.id, "replaced");

		const cols = clamp(opts.cols, 20, 400, 80);
		const rows = clamp(opts.rows, 5, 200, 24);
		const { file, args, command } = shellCommand();
		const id = `t${this.nextId++}-${Math.random().toString(36).slice(2, 8)}`;
		const env: Record<string, string | undefined> = { ...process.env };
		// A shell is not a background agent: a stray marker would make pi think
		// it was spawned by the inbox supervisor.
		delete env.PI_INBOX_BG_AGENT;
		delete env.PI_INBOX_BG_PARENT;
		// Never hand the shell the credential that authenticates this daemon.
		// It would otherwise be readable at any prompt (`echo $ORCH_WEB_TOKEN`,
		// `env`, a build script that dumps its environment), which turns a
		// revocable token into one that survives rotating the token file.
		delete env.ORCH_WEB_TOKEN;

		const pty = this.spawnFn(file, args, {
			name: "xterm-256color",
			cols,
			rows,
			cwd: path.resolve(process.env.ORCH_WEB_TERM_CWD || os.homedir()),
			env,
		});

		const now = this.now();
		const term: Term = {
			info: {
				id,
				pid: pty.pid,
				cols,
				rows,
				command,
				startedAt: now,
				viewers: 0,
				lastSeq: 0,
			},
			pty,
			ring: new Ring(),
			viewers: new Set(),
			beats: new Set(),
			lastInput: now,
			lastViewer: now,
			closed: false,
		};
		this.terms.set(id, term);

		pty.onData((data) => {
			if (term.closed) return;
			const chunk = term.ring.push(Buffer.from(data, "utf-8"));
			term.info.lastSeq = chunk.seq;
			const frame = `data: ${JSON.stringify({ seq: chunk.seq, data: chunk.b64 })}\n\n`;
			for (const res of term.viewers) {
				if (!write(res, frame)) continue;
			}
		});
		pty.onExit(({ exitCode }) => {
			if (term.closed) return;
			term.info.exited = { code: exitCode, at: this.now() };
			for (const res of term.viewers) write(res, exitEvent(exitCode));
			this.audit("term-exit", { id, pid: pty.pid, code: exitCode });
			// Keep the record (and its ring) so the final output can still be
			// read; the next open replaces it.
			for (const res of term.viewers) res.end();
			term.viewers.clear();
			term.info.viewers = 0;
			term.lastViewer = this.now();
		});

		this.audit("term-open", {
			id,
			pid: pty.pid,
			command,
			cols,
			rows,
			remote: opts.remote,
		});
		this.ensureTimer();
		return term.info;
	}

	/**
	 * Stream a terminal as SSE. `since` is the highest sequence the client has
	 * already rendered; a resume that fell off the ring replays from the front
	 * with a `reset` first, so the client clears rather than gluing two disjoint
	 * pieces of scrollback together.
	 */
	attach(
		res: http.ServerResponse,
		id: string,
		since: number,
		remote?: string,
	): boolean {
		const term = this.terms.get(id);
		if (!term) return false;
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		res.write("retry: 2000\n\n");

		const replay = term.ring.since(since);
		if (replay.truncated) res.write("event: reset\ndata: {}\n\n");
		for (const c of replay.chunks)
			res.write(`data: ${JSON.stringify({ seq: c.seq, data: c.b64 })}\n\n`);
		if (term.info.exited) res.write(exitEvent(term.info.exited.code));

		if (term.info.exited) {
			res.end();
			return true;
		}

		term.viewers.add(res);
		term.info.viewers = term.viewers.size;
		term.lastViewer = this.now();
		this.audit("term-attach", { id, since, remote, viewers: term.viewers.size });

		const beat = setInterval(() => {
			if (!write(res, ": keep-alive\n\n")) clearInterval(beat);
		}, HEARTBEAT_MS);
		term.beats.add(beat);
		const cleanup = () => {
			clearInterval(beat);
			term.beats.delete(beat);
			term.viewers.delete(res);
			term.info.viewers = term.viewers.size;
			term.lastViewer = this.now();
		};
		res.on("close", cleanup);
		res.on("error", cleanup);
		res.on("finish", cleanup);
		return true;
	}

	input(id: string, data: string): void {
		const term = this.live(id);
		if (!term) throw new TermError(404, "no such terminal");
		term.lastInput = this.now();
		term.pty.write(data);
	}

	resize(id: string, cols: number, rows: number): TermInfo {
		const term = this.live(id);
		if (!term) throw new TermError(404, "no such terminal");
		const c = clamp(cols, 20, 400, term.info.cols);
		const r = clamp(rows, 5, 200, term.info.rows);
		term.pty.resize(c, r);
		term.info.cols = c;
		term.info.rows = r;
		return term.info;
	}

	close(id: string, reason = "requested"): void {
		const term = this.terms.get(id);
		if (!term) return;
		term.closed = true;
		killTerm(term);
		for (const res of term.viewers) {
			write(res, `event: close\ndata: ${JSON.stringify({ reason })}\n\n`);
			res.end();
		}
		term.viewers.clear();
		for (const beat of term.beats) clearInterval(beat);
		term.beats.clear();
		term.info.viewers = 0;
		this.terms.delete(id);
		this.audit("term-close", { id, pid: term.info.pid, reason });
	}

	/** Reap detached or over-age shells; called on a timer, and by tests. */
	sweep(): void {
		const now = this.now();
		for (const [id, term] of this.terms) {
			if (now - term.info.startedAt > this.maxLifetimeMs) {
				this.close(id, "max-lifetime");
				continue;
			}
			if (term.info.exited) {
				// Keep a finished shell's output for a while, then forget it.
				if (now - (term.info.exited.at ?? now) > this.idleMs) this.forget(id);
				continue;
			}
			if (term.viewers.size === 0 && now - term.lastViewer > this.idleMs) {
				this.close(id, "idle");
			}
		}
	}

	private forget(id: string): void {
		const term = this.terms.get(id);
		if (!term) return;
		term.closed = true;
		for (const beat of term.beats) clearInterval(beat);
		term.beats.clear();
		this.terms.delete(id);
	}

	private live(id: string): Term | undefined {
		const term = this.terms.get(id);
		if (!term || term.info.exited) return undefined;
		return term;
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.sweep(), REAP_TICK_MS);
		// A reaper must never hold the process open on its own.
		this.timer.unref?.();
	}

	/**
	 * Shut every shell down; used when the daemon stops.
	 *
	 * Ending the viewer responses matters as much as killing the PTYs: an open
	 * SSE stream keeps `server.close()` from ever completing, so a restart
	 * would hang until launchd's SIGKILL, and the child shells would be
	 * re-parented to init rather than dying with us.
	 */
	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const id of [...this.terms.keys()]) this.close(id, "shutdown");
	}
}

export class TermError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Which program a terminal runs. `ORCH_WEB_TERM_CMD` lets an operator pin it
 *  to something narrower (a login shell is the point, but not everyone's). */
export function shellCommand(): {
	file: string;
	args: string[];
	command: string;
} {
	const pinned = process.env.ORCH_WEB_TERM_CMD?.trim();
	const shell = process.env.SHELL?.trim() || "/bin/zsh";
	if (pinned) return { file: shell, args: ["-lc", pinned], command: pinned };
	// Login shell: the same PATH a Terminal window gets, which is what makes
	// `pi` and brew tools resolve.
	return { file: shell, args: ["-l"], command: `${path.basename(shell)} -l` };
}

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
	const v = Math.round(Number(n));
	if (!Number.isFinite(v)) return fallback;
	return Math.min(hi, Math.max(lo, v));
}

function exitEvent(code: number): string {
	return `event: exit\ndata: ${JSON.stringify({ code })}\n\n`;
}

/**
 * End a shell, and anything it started.
 *
 * node-pty's `kill()` signals the leader only; the kernel's SIGHUP to the pty
 * session covers ordinary children, but a grandchild that calls `setsid` (a
 * daemonized helper) would slip out of the session and survive. Signalling the
 * process group first closes that hole; it is belt-and-braces, not the fix for
 * any observed leak.
 */
function killTerm(term: { info: TermInfo; pty: PtyLike }): void {
	try {
		// node-pty makes the child a session leader, so its pgid is its pid.
		process.kill(-term.info.pid, "SIGHUP");
	} catch {
		// no such group (already gone, or not a group leader)
	}
	try {
		term.pty.kill();
	} catch {
		// already gone
	}
}

/** Write, reporting failure instead of throwing into a timer or a data handler. */
function write(res: http.ServerResponse, chunk: string): boolean {
	if (res.writableEnded || res.destroyed) return false;
	try {
		res.write(chunk);
		return true;
	} catch {
		return false;
	}
}
