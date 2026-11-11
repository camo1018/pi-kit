import * as fs from "node:fs";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isRunning,
	onAgentEvent,
	sessionCwd,
	type AgentEvent,
	type BgAgent,
} from "../../lib/inbox-agents.ts";
import type { WorkerTeam } from "./workers.ts";
import { PROCESS_TOKEN } from "./process-token.ts";
import { trace } from "./trace.ts";
import {
	clearWakeArm,
	clearWakeRequest,
	claimEpisodeWake,
	readReported,
	readWakeArm,
	readWakeRequest,
	clearReported,
	consumeWakeRequest,
	releaseAllEpisodeClaims,
	releaseEpisodeClaim,
	writeReported,
	writeWakeArm,
	writeWakeRequest,
} from "./wake-queue.ts";

export const WAKE_CUSTOM_TYPE = "pi-kit:worker-wake";

/**
 * Fixed prefix on every wake prompt. A background wake reaches the parent as a
 * queued run whose prompt pi reports as ordinary `input` with source
 * "interactive", so without a marker the wake would look like a user reply:
 * it would reset its own wake budget and re-arm itself, looping forever.
 */
export const WAKE_MARKER = "[pi-kit wake]";

/** True when this input text is a wake this extension queued. */
export function isWakeInput(text: unknown): boolean {
	return typeof text === "string" && text.startsWith(WAKE_MARKER);
}

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
	/** True when this process keeps the session alive after the turn ends. */
	persistent: boolean;
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
	g[GLOBALS] ??= { persistent: false };
	return g[GLOBALS];
}

/**
 * How settled one worker is, from this process's point of view.
 *
 * `undefined` used to mean "quiet", on the reasoning that a worker missing
 * from this process's registry had been released after settling. That is true
 * for a worker this process released, and false for a worker another process is
 * running right now. The wake hook sweeps EVERY team on disk
 * (`team.parents()`), so a foreign team's running workers all looked absent --
 * and therefore settled. One fan-out then woke its parent repeatedly while the
 * work was still in progress, which is what happened in production.
 */
type Quiescence = "settled" | "running";

function quiescence(agent: BgAgent | undefined): Quiescence {
	if (!agent) return "settled";
	const quiet =
		!agent.proc &&
		!agent.hold &&
		agent.pending.length === 0 &&
		(agent.state === "idle" ||
			agent.state === "error" ||
			agent.state === "cancelled");
	return quiet ? "settled" : "running";
}


/** One durable line: the model must act, but at the smallest context cost. */
export function wakeContent(
	parentId: string,
	agents: { id: string; agent?: BgAgent }[],
): string {
	const errored = agents.filter(
		({ agent }) => agent?.state === "error",
	);
	const note = errored.length
		? ` ${errored.length} errored.`
		: "";
	// An episode that named nobody is not "0 workers": the fan-out is unknown
	// (typically an arm written before `episodeWorkers` existed). Say only what
	// is true -- the team settled -- instead of asserting a count we do not have.
	const what = agents.length === 0
		? "The delegated team has settled."
		: `All ${agents.length} delegated ` +
			`${agents.length === 1 ? "worker has" : "workers have"} settled.`;
	return (
		`${WAKE_MARKER} ${what}${note} ` +
		'Read them with session_workers {action:"list"} before replying. ' +
		"Do not spawn more workers unless the user asked."
	);
}

function teamAgents(
	team: WorkerTeam,
	parentId: string,
): { id: string; agent?: BgAgent; disposition?: Quiescence }[] | undefined {
	// Identities, not full records: this only ever reads `worker.id`. Reading the
	// bodies made every sweep parse every record for every team, which is what
	// the identity index exists to avoid.
	const workers = team.identities(parentId);
	if (workers.length === 0) return undefined;
	// A worker missing from this registry is either released after settling or
	// running in another process. Only the live session records can tell those
	// apart, so resolve through them instead of assuming either one.
	return workers.map((worker) => {
		const agent = team.runner.get(worker.id);
		if (agent) return { id: worker.id, agent };
		return {
			id: worker.id,
			disposition: team.foregroundDisposition(worker.id),
		};
	});
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
	// A TUI process keeps the session alive after a turn; a background run is a
	// one-shot `--mode json` child that exits. Only the former can be woken
	// in-process.
	current.persistent = ctx.mode === "tui";

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
			if (!live) return;
			const parentId = live.sessionManager.getSessionId();
			// Sweep, not just this session: a settle is often observed by a
			// different process than the parent's, and the sweep is the one rule
			// both entry points share.
			sweepWakeRequests(team, team.parent(parentId) === parentId ? parentId : "");
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
 * Record a newly spawned worker against its parent's pending fan-out.
 *
 * Called from `spawn`, before the worker's first run, so the wake message can
 * describe exactly the workers this parent started -- not every worker record
 * on disk, which is never pruned. Kept separate from the arming record because
 * a user reply deletes that, and the fan-out list must outlive it.
 */
export function registerWakeWorker(
	agentsDir: string,
	parentId: string,
	workerId: string,
): void {
	// Recorded unconditionally, creating the arm if needed. The directory is
	// owned by this subsystem, the same way the other sidecar writers treat it.
	// Recording at spawn is what makes the fan-out exact: a sweep can miss a
	// worker that ran between ticks, and a follow-up `send` creates no record.
	// The arming branch unions this into the episode's fan-out later.
	const current = readWakeArm(agentsDir, parentId);
	const pending = new Set(current?.pendingWorkers ?? []);
	pending.add(workerId);
	writeWakeArm(agentsDir, parentId, {
		pendingWorkers: [...pending],
		// Record the spawning process as this team's owner. `spawn` runs inside
		// the process that will be responsible for waking the parent, and the
		// arm outlives the parent's idle state, which the inbox's own `owner`
		// record does not.
		ownerPid: process.pid,
		ownerToken: PROCESS_TOKEN,
	});
}

/**
 * Evaluate every team this process can see, not just the session the listener
 * belongs to.
 *
 * This is the fix for the failure mode that made the wake never fire: a
 * background parent's workers are adopted by whichever process is alive, and
 * that process (not the parent) owns the settle event. Scoping evaluation to
 * the listener's own session meant the settle was observed somewhere that was
 * not allowed to act on it, leaving `armed` set on disk forever.
 *
 * A process that holds the parent's runtime delivers in-process; otherwise the
 * wake is queued onto the parent's own queue for its next run.
 */
export function sweepWakeRequests(team: WorkerTeam, callerId: string): boolean {
	if (process.env.BIGBRAIN_MAINT === "1") return false;
	// One read of the worker directory for the whole sweep. `workers()` parses
	// EVERY record per call, so asking once per parent made this quadratic:
	// 150 records over 35 teams was 5,250 parses and ~345ms of synchronous work
	// on the TUI event loop -- paid twice over, since `ownsWake` asks again.
	return team.batch(() => sweepTeams(team, callerId));
}

function sweepTeams(team: WorkerTeam, callerId: string): boolean {
	const current = state();
	let acted = false;
	const parents = team.parents();
	for (const parentId of parents) {
		try {
			// Only the process responsible for this parent evaluates it, and the
			// check comes FIRST: `teamAgents` parses every worker record and reads
			// every live record, so gating after it burned that work every tick for
			// every historical team on disk -- 34 of them here -- only to discard
			// the result. The tick now costs one ownership lookup per team it does
			// not own.
			//
			// Iterating every team at all was the older bug: an unrelated
			// session's process could arm and wake a parent it had no relationship
			// with, giving two observers per team, duplicate wakes, and a wake
			// whose forced run aborted an in-flight turn. One observer suffices
			// because the wake is durable on disk -- whoever owns the parent next
			// delivers it.
			if (!team.ownsWake(parentId)) continue;
			// Arm from what this process observes right now, so a settle is
			// never dependent on having seen the busy window ourselves.
			const agents = teamAgents(team, parentId);
			if (!agents) continue;
			// `disposition` is the whole point of teamAgents: a worker absent from
			// this registry is either released or running elsewhere, and only the
			// live session records can tell those apart. Reading `agent` alone
			// collapsed both to `settled` through quiescence(undefined), so every
			// historical team on disk looked finished at once and woke in a burst.
			//
			// The tri-state now has three jobs, not two. `running` is the only
			// evidence of a live fan-out, so it alone opens an episode. `unknown`
			// (a live record this process cannot parse, or a durable `working`
			// record left by a run that is long gone) proves nothing about a
			// fan-out: it is a reason to withhold a settle, never a reason to
			// invent one. Treating it as busy armed every historical team that had
			// a stray live file, and the next sweep then woke its parent days
			// later.
			const running = agents.some(({ agent, disposition }) =>
				agent ? quiescence(agent) === "running" : disposition === "running",
			);
			const unknown = agents.some(
				({ agent, disposition }) =>
					!agent && (disposition ?? "unknown") === "unknown",
			);
			// The workers that are affirmatively running right now: only these can
			// opt this episode in.
			const observedIds = agents
				.filter(({ agent, disposition }) =>
					agent
						? quiescence(agent) === "running"
						: disposition === "running",
				)
				.map(({ id }) => id);
			// The wake is opt-in, per team. Delegation normally happens while the
			// parent is the one driving the workers, so it already knows when they
			// stop; waking it then is noise. With follow-up `send` calls it is
			// worse than noise: every parent-initiated run reads as a fresh
			// fan-out, so the parent woke itself once per follow-up. Only a team
			// whose parent asked to be woken is armed or delivered to at all.
			const arm = readWakeArm(team.stateDir, parentId);
			if (running) {
				// Opening an episode: this fan-out has not been woken for yet.
				// `episode === 0` also has to open one, even while `armed` is set:
				// an armed team with no episode can never settle into a wake (the
				// settle branch skips `episode === 0`), so leaving it would strand
				// the team silently. Records in that shape exist on disk from the
				// reply-while-busy write that used to arm without an episode.
				// The fan-out this episode is responsible for: workers seen
				// running, plus any spawned since the last emitted wake. The
				// durable sidecar is the boundary, because the arm is deleted by
				// an ordinary reply and a follow-up `send` creates no record at
				// all -- so neither the arm nor a clock alone can carry this.
				const opening = !arm?.armed || (arm.episode ?? 0) === 0;
				// The fan-out is exactly what the parent spawned and has not yet
				// been told about, plus anything observed running. `spawn` records
				// each worker as it is created, so this survives a sweep that missed
				// a short-lived worker and a follow-up `send` that creates no record.
				const reporter = readReported(team.stateDir, parentId);
				const reported = new Set(reporter?.reportedWorkers ?? []);
				// Workers spawned since the last *reported* wake that nobody has
				// registered or observed yet. This is the bootstrap path: a fresh
				// team has no arming record, and a sweep can miss a worker that ran
				// between ticks, so neither `pendingWorkers` nor `observedIds`
				// necessarily names every worker in the fan-out.
				// Guard against the legacy-bootstrap over-report: a parent with no
				// durable record has no boundary, and worker records are never
				// pruned, so "everything unreported" is its entire history. Until a
				// first wake has been recorded, trust only what this episode
				// actually observed plus what `spawn` registered.
				const unregistered = reporter?.lastWakeAt
					? team
						.workers(parentId)
						.filter((worker) =>
							!reported.has(worker.id) &&
							worker.createdAt >= reporter.lastWakeAt!,
						)
						.map((worker) => worker.id)
					: [];
				const pending = new Set([
					...(opening ? [] : (arm?.episodeWorkers ?? [])),
					...(arm?.pendingWorkers ?? []),
					...observedIds,
					...unregistered,
				]);
				for (const id of pending) if (reported.has(id)) pending.delete(id);
				const fanOut = pending;
				if (opening) {
					writeWakeArm(team.stateDir, parentId, {
						armed: true,
						episode: (arm?.episode ?? 0) + 1,
						signature: null,
						// Pin the opt-in to THIS episode, from the workers seen
						// running now. Asking again at settle time would let a
						// never-pruned `wake: true` record opt the parent in
						// permanently, and a time cutoff would break a follow-up
						// that reuses an already-opted-in worker.
						// Only the workers observed running in THIS episode can
						// opt in. Asking `team.wakeOptIn` here would consult every
						// never-pruned record for the parent, including ones from
						// an older fan-out that opted in and was already answered.
						wakeOptIn: team.wakeOptIn(observedIds),
						episodeWorkers: [...fanOut],
					});
				} else if (fanOut.size > (arm.episodeWorkers?.length ?? 0)) {
					writeWakeArm(team.stateDir, parentId, {
						episodeWorkers: [...fanOut],
					});
				}
				continue;
			}
			// Nothing is affirmatively running. If any worker cannot be placed, the
			// team is unresolved, not settled: leave an open episode exactly as it
			// is (no wake, no rewrite) and re-evaluate on a later sweep. Erasing it
			// would lose a wake the fan-out is owed.
			if (unknown) continue;
			if (!arm?.armed) continue;
			// The episode carries the opt-in it was armed with. A team that never
			// asked is left alone even if a stale record says otherwise.
			if (arm.wakeOptIn !== true) continue;
			// One wake per episode. A state-derived signature cannot do this:
			// released workers leave the registry, so it becomes constant.
			if (arm.signature === String(arm.episode)) continue;
			// Never wake for an episode that never ran: a team of already-
			// released records must not produce a wake merely because the
			// arming file exists. Only a busy observation opens an episode.
			if (arm.episode === 0) continue;
			// A spent budget must still disarm. Continuing here leaves the arm
			// `armed: true` forever, which makes every later sweep re-enter the
			// settle branch and freeze the episode at its current number. Disarm
			// and record the signature so this episode is answered even though no
			// wake is emitted; a real user reply refills the budget and the next
			// fan-out starts a fresh episode.
			if (arm.wakes >= MAX_CONSECUTIVE_WAKES) {
				writeWakeArm(team.stateDir, parentId, {
					armed: false,
					signature: String(arm.episode),
				});
				releaseEpisodeClaim(team.stateDir, parentId, arm.episode);
				continue;
			}
			// Only one process may emit for this episode. The arm test above is a
			// read, not a claim: concurrent sweeps all see the same unclaimed state
			// and would all deliver.
			if (!claimEpisodeWake(team.stateDir, parentId, arm.episode)) continue;
			const next = String(arm.episode);
			// Describe only the workers this episode is responsible for. Everything
			// else is history the parent has already been told about: worker
			// records are never pruned, so `agents` covers every worker this parent
			// ever spawned and the message overstated the fan-out ("all 10
			// delegated workers" for a run of two). Display only -- every gate
			// above is unaffected.
			// No fallback to the full team. `agents` is every worker this parent
			// ever spawned, so falling back to it is the over-report this scoping
			// exists to remove: a legacy arm written before `episodeWorkers`
			// existed printed "all 12 delegated workers" for a run of two. When the
			// episode named nobody, report nobody rather than inventing a count.
			const recorded = new Set(arm.episodeWorkers ?? []);
			const episodeAgents = agents.filter(({ id }) => recorded.has(id));
			if (!readWakeRequest(team.stateDir, parentId)) {
				writeWakeRequest(team.stateDir, {
					parentId,
					content: wakeContent(parentId, episodeAgents),
					workers: episodeAgents.map(({ id, agent }) => ({
						id,
						title: agent?.title ?? id,
						state: agent?.state ?? "released",
						pending: agent?.pending.length ?? 0,
						error: agent?.error,
					})),
				});
			}
			writeWakeArm(team.stateDir, parentId, {
				armed: false,
				signature: next,
				wakes: arm.wakes + 1,
				lastWakeAt: Date.now(),
				// Reported now: a later episode must not count them again. The
				// durable sidecar below is what survives a reply deleting this arm.
				pendingWorkers: null,
			});
			// Durable copy: survives a reply deleting the arm, and is the boundary
			// the NEXT fan-out uses to tell its own workers from history.
			writeReported(team.stateDir, parentId, {
				lastWakeAt: Date.now(),
				reportedWorkers: episodeAgents.map(({ id }) => id),
			});
			// Records described to the parent and long since idle carry nothing
			// further, and unused ones accumulated forever -- which is what let a
			// wake report "all 12 delegated workers" for a run of two. Bounded by
			// age because a worker record is also what `send` resolves to resume a
			// session, so a recent one must survive.
			team.pruneReportedWorkers(
				parentId,
				new Set(readReported(team.stateDir, parentId)?.reportedWorkers ?? []),
			);
			releaseEpisodeClaim(team.stateDir, parentId, arm.episode);
			// The request was just written, so this sweep acted. `deliverWake`
			// only attempts the handoff; its result does not change that.
			acted = true;
			deliverWake(team, parentId, current);
		} catch {
			// One bad team must not stop the sweep.
		}
	}
	// Drop arming state for teams that no longer exist. Worker records are never
	// pruned, so every parent a session has ever delegated for leaves an arm
	// behind; here that was 7 of 8 arms with zero workers. The arm is what
	// `parents()` discovers, so the residue is also what makes the sweep iterate
	// teams that cannot possibly wake.
	//
	// Deliberately conservative -- a wrong prune would strand a real fan-out, so
	// only a team that is disarmed, has no worker records, no recorded fan-out
	// and no request on disk is removed. Anything that could still wake is kept.
	pruneDeadArms(team);

	// A request can outlive its worker records (all released, or a crashed run),
	// so it is invisible to the team loop above. Deliver those too, for the
	// current session and for any parent still holding a pending request.
	for (const parentId of new Set([callerId, ...pendingParents(team)])) {
		if (!parentId) continue;
		// One bad team must not take down the whole sweep. The team loop above is
		// already guarded; this one was not, and `ownsWake` can throw on a
		// malformed worker record (`ownerGone` reads them), which surfaced as an
		// unhandled throw from a supervisor tick.
		try {
			// Same opt-in gate as the sweep loop: a request left on disk by a team
			// that never opted in must not be delivered either. The arm's recorded
			// answer is authoritative -- the workers may all be released by now, and
			// falling back to the unscoped team check would let a never-pruned
			// `wake: true` record resurrect the sticky behaviour this scoping exists
			// to remove.
			const arm = readWakeArm(team.stateDir, parentId);
			if (arm?.wakeOptIn !== true) continue;
			// Ownership applies here too. Without it any process may queue a run for
			// a parent it has no relationship with, and `runningElsewhere` cannot
			// catch the case that matters: live records are keyed by pid and hold
			// only the session that process is currently *showing*, so a window
			// holding this parent in a background tab has no live record for it.
			// The result was a second `pi --session-id <parent>` beside the live
			// window -- two writers on one session file.
			//
			// A dead or absent owner must still be delivered to, or a team whose
			// window closed would never be woken; `ownsWake` already treats a held
			// session as ownership, so only a live foreign claim is refused here.
			if (!team.ownsWake(parentId) && ownerAlive(arm?.ownerPid)) continue;
			if (deliverWake(team, parentId, current)) acted = true;
		} catch {
			// Skip this team; a later tick retries it.
		}
	}
	return acted;
}

/**
 * Forget arming state for parents that have no workers left.
 *
 * Safe by construction: a team with no worker records can never settle (the
 * sweep's `teamAgents` returns undefined for it), so its arm cannot produce a
 * wake. Everything that could still wake is kept -- see the guards below.
 */
function pruneDeadArms(team: WorkerTeam): void {
	// Scan the arm directory directly. `parents()` is derived from WORKER records,
	// so a team whose workers are gone -- exactly what this prunes -- never
	// appears in it. Using it here would be circular and prune nothing.
	let entries: string[];
	try {
		entries = fs.readdirSync(team.stateDir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".wake-state")) continue;
		const parentId = entry.slice(0, -".wake-state".length);
		try {
			if (team.workers(parentId).length > 0) continue;
			// Only the owner may delete a team's arming state: otherwise every
			// process sweeping here could clear a `.wake-state` that still carries
			// the wake budget for a team merely between spawns. An arm naming NO
			// owner is the exception -- it belongs to nobody, which is exactly the
			// case this prune exists for.
			const owner = team.claimedOwner(parentId);
			if (owner !== undefined && !team.ownsWake(parentId)) continue;
			const arm = readWakeArm(team.stateDir, parentId);
			if (!arm) continue;
			if (arm.armed) continue;
			if (arm.pendingWorkers?.length) continue;
			if (readWakeRequest(team.stateDir, parentId)) continue;
			clearWakeArm(team.stateDir, parentId);
			// The arm carried the episode number, and the claims are named after it.
			// Dropping the arm restarts numbering at 1, so a leftover claim for a
			// reused episode would suppress a real wake.
			releaseAllEpisodeClaims(team.stateDir, parentId);
			// The reported-workers sidecar describes the same fan-out and nothing
			// else prunes it: `removeAgentFiles` deliberately ignores this
			// directory's wake sidecars, so without this it accumulates forever.
			clearReported(team.stateDir, parentId);
		} catch {
			// One unreadable team must not stop the others.
		}
	}
}

/**
 * True when this pid is a live process other than us.
 *
 * Used to decide whether a wake request belongs to a process that is still
 * responsible for it. A stale pid -- dead, or never set on a legacy arm -- must
 * not block delivery, because nobody else is going to pick the work up.
 */
function ownerAlive(pid: number | undefined): boolean {
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
		return false;
	}
	if (pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: alive, just not ours.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Parents with a wake request still on disk. */
function pendingParents(team: WorkerTeam): string[] {
	let names: string[] = [];
	try {
		names = fs.readdirSync(team.stateDir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".wake"))
		.map((name) => name.slice(0, -5));
}

/** True when this process is itself running the given session. */
function isOwnSession(current: WakeState, sessionId: string): boolean {
	const live = current.ctx;
	if (!live) return false;
	try {
		return live.sessionManager.getSessionId() === sessionId;
	} catch {
		return false;
	}
}

/**
 * Deliver a pending request. Three outcomes, in order of preference:
 *
 * 1. This process holds the parent's runtime and keeps it alive -> send a
 *    custom message so exactly one turn runs here.
 * 2. This process runs the parent session as a one-shot run -> do nothing and
 *    leave the request queued. Spawning a background run here would open a
 *    second `pi --session-id <parent>` beside the live one: two writers on one
 *    session file. The next turn of this session consumes it.
 * 3. Anyone else -> queue one run on the parent's own queue.
 */
function deliverWake(
	team: WorkerTeam,
	parentId: string,
	current: WakeState,
): boolean {
	const request = readWakeRequest(team.stateDir, parentId);
	if (!request) return false;
	const owns = isOwnSession(current, parentId);
	// Already running: it will see this wake as the next queued turn, and pushing
	// a `triggerTurn` now would interleave a second turn with the one in flight.
	// Leave the request on disk; the sweep after that run ends delivers it. This
	// is what the module always claimed ("wake an idle parent") without checking.
	// A live child is a writer even when it is not "running": a settled child
	// keeps its `proc` until it actually exits, and a queued message means a run
	// is about to start. Checking only `state` let the in-process path push a
	// turn while the runner still held the session, which is two writers on one
	// session file -- the abort this was traced from.
	const held = team.runner.get(parentId);
	const busy =
		isRunning(held) || !!held?.proc || (held?.pending.length ?? 0) > 0;
	trace("wake_deliver_eval", {
		parentId,
		owns,
		busy,
		inRegistry: !!held,
		pid: held?.pid,
		nonce: request.nonce,
	});
	if (owns && busy) {
		trace("wake_deferred_busy", { parentId });
		return false;
	}

	if (owns && current.persistent && current.pi) {
		if (!consumeWakeRequest(team.stateDir, parentId, request.nonce)) {
			// A newer request replaced this one mid-flight.
			return true;
		}
		try {
			trace("wake_sent", {
				parentId,
				nonce: request.nonce,
				workers: request.workers.length,
			});
			current.pi.sendMessage(
				{
					customType: WAKE_CUSTOM_TYPE,
					content: request.content,
					display: false,
					details: {
						parentId,
						at: Date.now(),
						workers: request.workers,
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return true;
		} catch {
			// Runtime went away mid-send; leave it queued for the next turn.
			return false;
		}
	}
	// Case 2: our own one-shot session. Never spawn a second writer.
	if (owns) return false;
	// Case 2b: a writer holds this session right now. Queueing a background run
	// would race it for the same session file, and the request is better left for
	// the sweep after that run ends.
	//
	// `writerElsewhere` rather than `runningElsewhere`: the latter skips records
	// whose pid is ours, so a session this very process is running under another
	// entry looked free and a duplicate writer was spawned beside it.
	if (team.runner.writerElsewhere(parentId)) return false;

	const saved = team.worker(parentId);
	const agent = team.runner.get(parentId);
	const sessionFile = agent?.sessionFile ?? team.runner.find(parentId);
	// Nobody can ever receive this: drop it rather than leave it on disk.
	if (!agent && !sessionFile) {
		clearWakeRequest(team.stateDir, parentId);
		return false;
	}
	// Claim BEFORE sending. Consuming after the send left a window where another
	// process could read the same still-present request and queue a second run:
	// several concurrent sweeps of one request produced six runs for one wake.
	// The rename is atomic, so exactly one process gets here.
	if (!consumeWakeRequest(team.stateDir, parentId, request.nonce)) {
		// Another process already delivered it, or a newer request replaced it.
		return false;
	}
	team.runner.send({
		id: parentId,
		cwd:
			saved?.cwd ?? agent?.cwd ?? sessionCwd(sessionFile) ?? process.cwd(),
		title: saved?.title ?? agent?.title ?? "delegated workers",
		sessionFile,
		text: request.content,
	});
	return true;
}

/** Supervisor-tick entry point: evaluate every visible team, then deliver. */
export function pumpWakeRequest(
	team: WorkerTeam,
	callerId: string,
): boolean {
	return sweepWakeRequests(team, callerId);
}

/** Drop the armed team and any pending evaluation on session end. */
export function uninstallWorkerWake(): void {
	const current = state();
	if (current.timer) clearTimeout(current.timer);
	current.timer = undefined;
}

/** Real user input reopens the wake budget; stored durably with the arming. */
export function resetWakeBudget(team: WorkerTeam, parentId: string): void {
	// `null`, not `0`: the arm write floors `wakes` against disk so a stale
	// concurrent writer cannot rewind the consecutive-wake cap, which makes a
	// plain 0 indistinguishable from "no change" and leaves the budget spent.
	writeWakeArm(team.stateDir, parentId, { wakes: null });
}

/** A user reply supersedes any wake still waiting to be delivered. */
export function dropPendingWake(team: WorkerTeam, callerId: string): void {
	const workers = team.workers(callerId);
	const running = workers.some((worker) => {
		const agent = team.runner.get(worker.id);
		if (agent) return quiescence(agent) !== "settled";
		// A worker this process does not hold may still be running elsewhere.
		return team.foregroundDisposition(worker.id) !== "settled";
	});
	if (running) {
		// A reply while the team still works must NOT cancel the wake it is
		// owed: clear only the stored signature so the next settle is not
		// suppressed by the previous fan-out's, and leave any queued request and
		// the `armed` flag alone.
		//
		// `signature: null` is the clear sentinel; `undefined` means "leave it
		// alone" and would keep the old signature. Do NOT pass `armed: true`
		// here either: after an idle reply cleared the file, arming with
		// `episode` still 0 makes the busy sweep skip the episode bump and the
		// settle skip on `episode === 0`, so that fan-out never wakes at all.
		// Only touch the file if there is something to clear; otherwise this
		// would create an arming record for a team that has not run yet.
		if (readWakeArm(team.stateDir, callerId)) {
			writeWakeArm(team.stateDir, callerId, { signature: null });
		}
		return;
	}
	clearWakeRequest(team.stateDir, callerId);
	clearWakeArm(team.stateDir, callerId);
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
