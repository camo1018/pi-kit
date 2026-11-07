import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isAgentChild,
	onAgentEvent,
	type AgentEvent,
	type BgAgent,
} from "../../lib/inbox-agents.ts";
import type { WorkerTeam } from "./workers.ts";

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
	g[GLOBALS] ??= { armed: false, wakes: 0 };
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

function wakeContent(
	parentId: string,
	agents: { id: string; agent: BgAgent }[],
): string {
	const lines = agents.map(({ id, agent }) => {
		const title = agent.title.replace(/\s+/g, " ").trim();
		const error = agent.error ? ` error=${agent.error}` : "";
		return `- ${id} "${title}" state=${agent.state}${error}`;
	});
	return [
		`All delegated workers of session ${parentId} have settled.`,
		...lines,
		'Read them with session_workers {action:"list"} before replying.',
		"Do not spawn more workers unless the user asked.",
	].join("\n");
}

/**
 * Wake an idle parent once, after its whole worker team settles. Without this
 * the parent has to poll `wait`, and every poll return costs a full model
 * turn. A parent that spawns workers and ends its turn spends nothing until
 * this message starts exactly one new turn.
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
	// A fresh session never inherits an armed team or a stale wake budget.
	current.armed = false;
	current.signature = undefined;
	current.wakes = 0;

	if (isAgentChild()) return;
	if (process.env.BIGBRAIN_MAINT === "1") return;

	const g = globalThis as unknown as Record<symbol, unknown>;
	if ((g[LISTENER_VERSION_KEY] as number) === LISTENER_VERSION) return;
	const previous = g[LISTENER_KEY];
	if (typeof previous === "function") (previous as () => void)();
	g[LISTENER_VERSION_KEY] = LISTENER_VERSION;

	const subscribe = options.subscribe ?? onAgentEvent;
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

	const evaluate = () => {
		current.timer = undefined;
		try {
			// Read lazily: a stale ctx throws on every getter after a switch.
			const live = current.ctx;
			const livePi = current.pi;
			if (!live || !livePi) return;
			const parentId = live.sessionManager.getSessionId();
			if (team.parent(parentId) !== parentId) return;
			// Only workers this process owns emit events; a team member owned by
			// another Pi process can settle unnoticed, so never wake past one.
			const members = team.workers(parentId);
			const agents = members.map((worker) => ({
				id: worker.id,
				agent: team.runner.get(worker.id),
			}));
			if (agents.length === 0) return;
			if (agents.some((entry) => !entry.agent)) return;
			const owned = agents as { id: string; agent: BgAgent }[];
			if (owned.some(({ agent }) => !quiet(agent))) {
				current.armed = true;
				return;
			}
			if (!current.armed) return;
			const next = signature(owned);
			if (next === current.signature) return;
			if (current.wakes >= MAX_CONSECUTIVE_WAKES) return;
			// Commit only after a successful send: a stale context throws and
			// must not consume the wake this fan-out was owed.
			livePi.sendMessage(
				{
					customType: WAKE_CUSTOM_TYPE,
					content: wakeContent(parentId, owned),
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

/** Test seam: drop process-global listener bookkeeping between test cases. */
export function resetWakeListeners(): void {
	const g = globalThis as unknown as Record<symbol, unknown>;
	const previous = g[LISTENER_KEY];
	if (typeof previous === "function") (previous as () => void)();
	delete g[LISTENER_KEY];
	delete g[LISTENER_VERSION_KEY];
	delete g[GLOBALS];
}
