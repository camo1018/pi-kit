import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	onAgentEvent,
	type AgentEvent,
	type BgAgent,
} from "../../lib/inbox-agents.ts";
import type { WorkerTeam } from "./workers.ts";
import {
	clearWakeRequest,
	readWakeRequest,
	consumeWakeRequest,
	writeWakeRequest,
} from "./wake-queue.ts";

export const WAKE_CUSTOM_TYPE = "pi-kit:worker-wake";

/** Stop runaway wake -> spawn -> wake cycles without new user input. */
const MAX_CONSECUTIVE_WAKES = 3;
const DEFAULT_DEBOUNCE_MS = 400;

export interface WakeOptions {
	/** Event source; injectable so tests never touch the process registry. */
	subscribe?: (fn: (event: AgentEvent) => void) => () => void;
	/** Trailing delay that coalesces near-simultaneous settles. */
	debounceMs?: number;
}

interface WakeState {
	ctx?: ExtensionContext;
	pi?: ExtensionAPI;
	/** True when this process owns the session (TUI), so it can be woken. */
	interactive: boolean;
	armed: boolean;
	signature?: string;
	wakes: number;
	timer?: ReturnType<typeof setTimeout>;
}

const GLOBALS = Symbol.for("pi.session-workers.wake");
const LISTENER_KEY = Symbol.for("pi.session-workers.wake.listener");
const LISTENER_VERSION_KEY = Symbol.for(
	"pi.session-workers.wake.listener.version",
);
const LISTENER_VERSION = 1;

function state(): WakeState {
	const g = globalThis as unknown as Record<symbol, WakeState | undefined>;
	g[GLOBALS] ??= { armed: false, wakes: 0, interactive: false };
	return g[GLOBALS];
}

/**
 * A worker is quiet once its own run is finished and nothing queued will start
 * another one. `proc` survives `agent_settled`, and `run_end` means queued
 * messages remain, so both are checked explicitly.
 */
function quiet(agent: BgAgent): boolean {
	return (
		!agent.proc &&
		!agent.hold &&
		agent.pending.length === 0 &&
		(agent.state === "idle" ||
			agent.state === "error" ||
			agent.state === "cancelled")
	);
}

function signature(agents: { id: string; agent: BgAgent }[]): string {
	return agents
		.map(({ id, agent }) => `${id}:${agent.state}:${agent.runs}`)
		.sort()
		.join(",");
}

/** One durable line: the model must act, but at the smallest context cost. */
function wakeContent(
	parentId: string,
	agents: { id: string; agent: BgAgent }[],
): string {
	const settled = agents.length === 1 ? "worker has" : "workers have";
	const errored = agents.filter(({ agent }) => agent.state === "error");
	const note = errored.length
		? ` ${errored.length} errored.`
		: "";
	return (
		`All ${agents.length} delegated ${settled} settled.${note} ` +
		'Read them with session_workers {action:"list"} before replying. ' +
		"Do not spawn more workers unless the user asked."
	);
}

function teamAgents(
	team: WorkerTeam,
	parentId: string,
): { id: string; agent: BgAgent }[] | undefined {
	const workers = team.workers(parentId);
	if (workers.length === 0) return undefined;
	// Adoption is expected: a background parent's workers outlive the run
	// process that spawned them, so most settles arrive from the registry.
	const agents = workers.map((worker) => ({
		id: worker.id,
		agent: team.runner.get(worker.id),
	}));
	if (agents.some((entry) => !entry.agent)) return undefined;
	return agents as { id: string; agent: BgAgent }[];
}

/**
 * Wake an idle parent once, after its whole worker team settles. Without this
 * the parent has to poll `wait`, and every poll return costs a full model
 * turn.
 *
 * Two delivery paths, because a parent is one of two very different things:
 * an interactive session that stays alive, or a background run whose process
 * exits the moment its turn ends.
 */
export function installWorkerWake(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	team: WorkerTeam,
	options: WakeOptions = {},
): void {
	const current = state();
	current.ctx = ctx;
	current.pi = pi;
	// A background run dies with its turn, so it can only leave a durable
	// request behind. A TUI session owns the runtime and can wake itself.
	current.interactive = ctx.mode === "tui";
	// A fresh session never inherits an armed team or a stale wake budget.
	current.armed = false;
	current.signature = undefined;
	current.wakes = 0;

	if (process.env.BIGBRAIN_MAINT === "1") return;

	const g = globalThis as unknown as Record<symbol, unknown>;
	if ((g[LISTENER_VERSION_KEY] as number) === LISTENER_VERSION) return;
	const previous = g[LISTENER_KEY];
	if (typeof previous === "function") (previous as () => void)();
	g[LISTENER_VERSION_KEY] = LISTENER_VERSION;

	const subscribe = options.subscribe ?? onAgentEvent;
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const agentsDir = team.agentDir;

	const deliver = (
		parentId: string,
		owned: { id: string; agent: BgAgent }[],
		next: string,
	) => {
		const content = wakeContent(parentId, owned);
		if (current.interactive && current.pi) {
			// Interactive: the runtime is alive, so send a real custom message.
			current.pi.sendMessage(
				{
					customType: WAKE_CUSTOM_TYPE,
					content,
					display: false,
					details: {
						parentId,
						at: Date.now(),
						workers: owned.map(({ id, agent }) => ({
							id,
							title: agent.title,
							state: agent.state,
							pending: agent.pending.length,
							error: agent.error,
						})),
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return;
		}
		// Background: queue a durable run on the parent's own agent queue. It
		// survives this process exiting and is pumped by whoever holds the
		// session next, exactly like a queued user reply.
		writeWakeRequest(agentsDir, { parentId, signature: next, content });
	};

	const evaluate = () => {
		current.timer = undefined;
		try {
			// Read lazily: a stale ctx throws on every getter after a switch.
			const live = current.ctx;
			if (!live) return;
			const parentId = live.sessionManager.getSessionId();
			if (team.parent(parentId) !== parentId) return;
			const agents = teamAgents(team, parentId);
			if (!agents) return;
			if (agents.some(({ agent }) => !quiet(agent))) {
				current.armed = true;
				return;
			}
			if (!current.armed) return;
			const next = signature(agents);
			if (next === current.signature) return;
			// A request left by an earlier run process is still pending; the
			// consumer will deliver it, so do not stack a second one.
			if (readWakeRequest(agentsDir, parentId)) return;
			if (current.wakes >= MAX_CONSECUTIVE_WAKES) return;
			deliver(parentId, agents, next);
			current.armed = false;
			current.signature = next;
			current.wakes += 1;
		} catch {
			// A stale context during a session switch must never break the
			// runner's emit loop.
		}
	};

	const schedule = () => {
		if (current.timer) return;
		const timer = setTimeout(evaluate, debounceMs);
		timer.unref?.();
		current.timer = timer;
	};

	// `changed` matters: a cancelled worker emits nothing else.
	const unsubscribe = subscribe(() => schedule());
	g[LISTENER_KEY] = unsubscribe;
}

/**
 * Turn a pending durable wake into a run on the parent's own queue. Called
 * from the supervisor tick of whichever process holds the session, so it works
 * whether that is the run process or a long-lived window.
 */
export function pumpWakeRequest(
	team: WorkerTeam,
	callerId: string,
): boolean {
	if (process.env.BIGBRAIN_MAINT === "1") return false;
	if (team.parent(callerId) !== callerId) return false;
	const request = readWakeRequest(team.agentDir, callerId);
	if (!request) return false;
	const saved = team.worker(callerId);
	const agent = team.runner.get(callerId);
	const sessionFile = team.runner.find(callerId);
	// Nobody can ever receive this: drop it rather than leave it on disk.
	if (!agent && !sessionFile) {
		clearWakeRequest(team.agentDir, callerId);
		return false;
	}
	// Route through the team's runner so the run is queued in the same durable
	// record every other parent message uses; needsPersist() then keeps it on
	// disk, which is what survives this process exiting.
	team.runner.send({
		id: callerId,
		cwd: saved?.cwd ?? process.cwd(),
		title: saved?.title ?? "delegated workers",
		sessionFile,
		text: request.content,
	});
	if (!consumeWakeRequest(team.agentDir, callerId, request.nonce)) {
		// A newer request replaced this one mid-flight; it stays for next tick.
		return true;
	}
	return true;
}

/** Drop the armed team and any pending evaluation on session end. */
export function uninstallWorkerWake(): void {
	const current = state();
	if (current.timer) clearTimeout(current.timer);
	current.timer = undefined;
	current.armed = false;
	current.signature = undefined;
	current.wakes = 0;
}

/** Test seam: the wake budget is reset by real user input and new sessions. */
export function resetWakeBudget(): void {
	state().wakes = 0;
}

/** A user reply supersedes any wake still waiting to be delivered. */
export function dropPendingWake(team: WorkerTeam, callerId: string): void {
	clearWakeRequest(team.agentDir, callerId);
}

/** Test seam: drop process-global listener bookkeeping between test cases. */
export function resetWakeListeners(): void {
	const g = globalThis as unknown as Record<symbol, unknown>;
	const previous = g[LISTENER_KEY];
	if (typeof previous === "function") (previous as () => void)();
	delete g[LISTENER_KEY];
	delete g[LISTENER_VERSION_KEY];
	delete g[GLOBALS];
}
