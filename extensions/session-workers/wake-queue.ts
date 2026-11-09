import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Durable cross-process wake delivery.
 *
 * A background parent runs as a one-shot `--mode json` child: the process that
 * owns its turn exits as soon as the turn ends, so it cannot deliver its own
 * wake when workers settle minutes later. The wake is therefore left as a
 * request file next to the parent's agent record, and whichever process holds
 * that session next consumes it and enqueues one run on the parent's queue.
 *
 * This mirrors the existing `<id>.name` / `<id>.stop` files: same directory,
 * same atomic-write convention, same "whoever is alive applies it" semantics.
 */

export interface WakeWorker {
	id: string;
	title: string;
	state: string;
	pending: number;
	error?: string;
}

export interface WakeRequest {
	v: 1;
	parentId: string;
	content: string;
	workers: WakeWorker[];
	/** Bumped by every writer so a consumer can tell a newer request exists. */
	nonce: string;
}

/** Same-pid writes in the same millisecond would otherwise collide. */
let writes = 0;

function requestFile(agentsDir: string, parentId: string): string {
	return path.join(agentsDir, `${parentId}.wake`);
}

/**
 * Record a pending wake for a parent whose owning process may already be gone.
 * Last writer wins: the newest signature is the one worth delivering.
 */
export function writeWakeRequest(
	agentsDir: string,
	request: {
		parentId: string;
		content: string;
		workers: WakeWorker[];
	},
): void {
	const value: WakeRequest = {
		v: 1,
		parentId: request.parentId,
		content: request.content,
		workers: request.workers,
		nonce: `${process.pid}-${Date.now()}-${++writes}`,
	};
	try {
		fs.mkdirSync(agentsDir, { recursive: true });
		const file = requestFile(agentsDir, request.parentId);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(value), "utf-8");
		fs.renameSync(tmp, file);
	} catch {
		// Best effort, matching persist(): a lost wake just means the parent
		// polls `wait` the old way.
	}
}

/** Read a pending request without consuming it. */
export function readWakeRequest(
	agentsDir: string,
	parentId: string,
): WakeRequest | undefined {
	try {
		const raw = JSON.parse(
			fs.readFileSync(requestFile(agentsDir, parentId), "utf-8"),
		) as WakeRequest;
		if (raw?.v !== 1 || raw.parentId !== parentId) return;
		if (!Array.isArray(raw.workers)) raw.workers = [];
		return raw;
	} catch {
		return undefined;
	}
}

/**
 * Consume a request only if it is still the one we read. A concurrent writer
 * replaces the file wholesale, so a nonce mismatch means newer work exists and
 * this consumer must leave it alone.
 */
export function consumeWakeRequest(
	agentsDir: string,
	parentId: string,
	expected: string,
): boolean {
	const file = requestFile(agentsDir, parentId);
	const current = readWakeRequest(agentsDir, parentId);
	if (!current || current.nonce !== expected) return false;
	// Claim by RENAME, not by read-then-rm. Two processes reading the same nonce
	// could both pass the check above and both "consume", delivering the same
	// wake twice: several concurrent sweeps of one settled episode produced six
	// runs for one wake. A rename is atomic, so exactly one claimant wins and the
	// loser's rename fails because the source is gone.
	const claimed = `${file}.${process.pid}.${Date.now()}.claim`;
	try {
		fs.renameSync(file, claimed);
	} catch {
		return false;
	}
	try {
		fs.rmSync(claimed, { force: true });
		return true;
	} catch {
		return true;
	}
}

/** Forget any pending request, e.g. when real user input supersedes it. */
export function clearWakeRequest(agentsDir: string, parentId: string): void {
	try {
		fs.rmSync(requestFile(agentsDir, parentId), { force: true });
	} catch {
		// ignore
	}
}

/**
 * Durable arming state.
 *
 * This cannot live in module memory: a background parent runs a fresh process
 * per turn, so `armed` set while workers were busy is gone by the turn in which
 * they settle, and every evaluation starts unarmed. Persisted next to the wake
 * request for the same reason.
 */
export interface WakeArm {
	v: 1;
	parentId: string;
	/** True once this team has been observed running since the last wake. */
	armed: boolean;
	/** Signature of the last state a wake was written for. */
	signature?: string | null;
	/**
	 * Monotonic counter of observed busy->settle episodes. This, not the worker
	 * states, is the identity of a fan-out: released workers leave the registry,
	 * so a state-derived signature becomes constant and suppresses later wakes.
	 */
	episode?: number;
	/** Consecutive automatic wakes, to stop wake -> spawn -> wake loops. */
	wakes: number;
	/**
	 * Whether the fan-out that opened this episode asked to be woken.
	 *
	 * Captured when the episode is ARMED, from the workers observed running then,
	 * and consumed when that episode settles. Worker records are never pruned, so
	 * asking at settle time instead made the opt-in permanent: one opted-in
	 * fan-out left `wake: true` on disk and every later default-`false` spawn for
	 * that parent inherited it. Pinning it to the episode answers the question
	 * that matters -- did *this* fan-out ask? -- and it also survives a follow-up
	 * `send` reusing an already-opted-in worker, which a time cutoff broke.
	 */
	wakeOptIn?: boolean;
	/**
	 * The worker ids this episode is responsible for, recorded when it arms.
	 *
	 * Worker records are never pruned, so counting `team.workers(parentId)`
	 * reports every worker the parent EVER spawned: a parent that ran five
	 * orchestrations was told "all 10 delegated workers have settled" when the
	 * run being reported had two.
	 *
	 * A timestamp cutoff cannot fix this. A follow-up `send` creates no new
	 * worker record at all, and a real reply clears this arm, so any clock-based
	 * "since" collapses to 0 and reports full history again. Recording the ids
	 * keeps the answer with the episode it belongs to.
	 */
	episodeWorkers?: string[];
	/**
	 * Workers spawned by the parent that have not yet been reported in a wake.
	 * Written at spawn time, so it is the exact fan-out of the current run.
	 */
	pendingWorkers?: string[];
	/**
	 * When this episode first armed. Used only to bootstrap the fan-out when no
	 * durable boundary exists yet: a worker created after the episode opened
	 * belongs to it even if no sweep caught it mid-run.
	 */
	/**
	 * When a wake was last emitted. Kept on the arm for the common case, but the
	 * durable copy lives in the reported sidecar because a user reply deletes
	 * this file. See `readReported`.
	 */
	lastWakeAt?: number;
	/**
	 * The pid that spawned this team, recorded at spawn time.
	 *
	 * `ownsWake` needs to know who is responsible for waking a parent, and the
	 * inbox's own `owner` field cannot answer it: that record is deleted as soon
	 * as the parent goes idle with nothing pending, which is exactly the state a
	 * parent sits in while its workers finish. Without a durable answer no
	 * process considers itself the owner and the wake never fires. The arm
	 * survives idle, so the claim lives here.
	 */
	ownerPid?: number;
	/** Paired with `ownerPid` so a recycled pid cannot impersonate the owner. */
	ownerToken?: string;
}

function armFile(agentsDir: string, parentId: string): string {
	return path.join(agentsDir, `${parentId}.wake-state`);
}

/**
 * A patch to the arming state. `wakes: null` is the explicit "reset to zero"
 * sentinel and `signature: null` the explicit "clear"; `undefined` always means
 * "leave what is on disk alone".
 */
type WakeArmPatch = Partial<
	Omit<
		WakeArm,
		| "v"
		| "parentId"
		| "wakes"
		| "signature"
		| "wakeOptIn"
		| "episodeWorkers"
		| "pendingWorkers"
		| "lastWakeAt"
		| "ownerPid"
		| "ownerToken"
	>
> & {
	wakes?: number | null;
	signature?: string | null;
	/** `null` clears it for a new episode; `undefined` leaves it alone. */
	wakeOptIn?: boolean | null;
	/** `null` clears it; `undefined` leaves it alone. */
	episodeWorkers?: string[] | null;
	pendingWorkers?: string[] | null;
	lastWakeAt?: number;
	ownerPid?: number;
	ownerToken?: string;
};

export function readWakeArm(
	agentsDir: string,
	parentId: string,
): WakeArm | undefined {
	try {
		const raw = JSON.parse(
			fs.readFileSync(armFile(agentsDir, parentId), "utf-8"),
		) as WakeArm;
		if (raw?.v !== 1 || raw.parentId !== parentId) return;
		return raw;
	} catch {
		return undefined;
	}
}

/** Merge-write the arming state so concurrent writers cannot lose a field. */
export function writeWakeArm(
	agentsDir: string,
	parentId: string,
	patch: WakeArmPatch,
): WakeArm {
	const previous = readWakeArm(agentsDir, parentId);
	// `episode` and `wakes` only ever move forward. Both are read-modify-written
	// from disk with no lock, so two processes sweeping the same team (an
	// adopting TUI and the parent's own run, say) used to be able to write a
	// value read before the other's update. A wake count that goes backwards
	// defeats the consecutive-wake cap entirely: the loop observed in production
	// produced eight wakes against a cap of three because each writer restored a
	// stale count. Fields are still merged as before; only regression is refused.
	//
	// `null` is the deliberate reset, matching `signature`. A bare floor is not
	// enough: `resetWakeBudget` is a real user reply reopening the budget, and it
	// was silently a no-op under `Math.max(0, previous)`, leaving the cap
	// permanently spent once a session had used its three wakes.
	const episode = Math.max(
		patch.episode ?? 0,
		previous?.episode ?? 0,
	);
	const wakes = patch.wakes === null
		? 0
		: Math.max(patch.wakes ?? 0, previous?.wakes ?? 0);
	// `armed` cannot simply take the patch value. The settle branch disarms with
	// `armed: false`, carrying an episode read before a concurrent busy-branch
	// write armed a NEWER one. Applying that stale disarm would stomp the fresh
	// arming, emitting a spurious wake and spending budget mid-fan-out.
	//
	// So a disarm naming an OLDER episode than the one on disk is refused, and
	// the on-disk arming stands. Note this is the reverse of "newer wins": the
	// patch loses here precisely because it is stale.
	const staleDisarm =
		patch.armed === false &&
		typeof patch.episode === "number" &&
		previous?.armed === true &&
		patch.episode < (previous.episode ?? 0);
	const armed = staleDisarm
		? true
		: (patch.armed ?? previous?.armed ?? false);
	const value: WakeArm = {
		v: 1,
		parentId,
		armed,
		// `null` means "clear it" (a new episode has no signature yet); `undefined`
		// means "leave it alone". Without this, `??` swallowed the clear and a new
		// fan-out inherited the previous episode's signature and was suppressed.
		signature:
			patch.signature === null
				? undefined
				: (patch.signature ?? previous?.signature),
		episode,
		wakes,
		wakeOptIn: patch.wakeOptIn ?? previous?.wakeOptIn,
		// `null` clears for a new episode, matching `signature`/`wakeOptIn`.
		episodeWorkers: patch.episodeWorkers ?? previous?.episodeWorkers,
		// `null` clears when the fan-out is reported; `undefined` leaves it.
		pendingWorkers: patch.pendingWorkers === null
			? undefined
			: (patch.pendingWorkers ?? previous?.pendingWorkers),
		// Forward-only: a stale writer must not rewind the boundary.
		lastWakeAt: Math.max(
			patch.lastWakeAt ?? 0,
			previous?.lastWakeAt ?? 0,
		) || undefined,
		// Last spawner wins: it is the process that just took responsibility.
		ownerPid: patch.ownerPid ?? previous?.ownerPid,
		ownerToken: patch.ownerToken ?? previous?.ownerToken,
	};
	try {
		fs.mkdirSync(agentsDir, { recursive: true });
		const file = armFile(agentsDir, parentId);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(value), "utf-8");
		fs.renameSync(tmp, file);
	} catch {
		// Best effort: without the file the hook degrades to polling `wait`.
	}
	return value;
}

/** Drop arming state, e.g. when the team is gone or the user replied. */
export function clearWakeArm(agentsDir: string, parentId: string): void {
	try {
		fs.rmSync(armFile(agentsDir, parentId), { force: true });
	} catch {
		// ignore
	}
}

/**
 * Durable record of what this parent has already been told about.
 *
 * The arming record is per-episode and is deleted by a user reply
 * (`dropPendingWake`), which is correct for runaway-loop state but wrong for
 * "which workers has this parent already been told about". Losing it made the
 * next fan-out report every worker the parent ever spawned, because worker
 * records are never pruned.
 *
 * A follow-up `send` also creates no new worker record, so a timestamp cutoff
 * alone cannot tell current from historical either. This sidecar is the durable
 * boundary both cases need, kept separate so no arming-lifecycle rule can drop
 * it by accident.
 */
export interface WakeReported {
	v: 1;
	parentId: string;
	/** When a wake was last emitted for this parent. */
	lastWakeAt?: number;
	/** Worker ids already described to the parent. */
	reportedWorkers?: string[];
}

function reportedFile(agentsDir: string, parentId: string): string {
	return path.join(agentsDir, `${parentId}.wake-reported`);
}

/** Drop the reported-workers sidecar for a parent that no longer exists. */
export function clearReported(agentsDir: string, parentId: string): void {
	try {
		fs.rmSync(reportedFile(agentsDir, parentId), { force: true });
	} catch {
		// ignore
	}
}

export function readReported(
	agentsDir: string,
	parentId: string,
): WakeReported | undefined {
	try {
		const raw = JSON.parse(
			fs.readFileSync(reportedFile(agentsDir, parentId), "utf-8"),
		) as WakeReported;
		if (raw?.v !== 1 || raw.parentId !== parentId) return;
		return raw;
	} catch {
		return undefined;
	}
}

/** Merge-write the reported sidecar. Counters only ever move forward. */
export function writeReported(
	agentsDir: string,
	parentId: string,
	patch: { lastWakeAt?: number; reportedWorkers?: readonly string[] },
): void {
	const previous = readReported(agentsDir, parentId);
	const ids = new Set(previous?.reportedWorkers ?? []);
	for (const id of patch.reportedWorkers ?? []) ids.add(id);
	const value: WakeReported = {
		v: 1,
		parentId,
		lastWakeAt: Math.max(
			patch.lastWakeAt ?? 0,
			previous?.lastWakeAt ?? 0,
		) || undefined,
		reportedWorkers: [...ids],
		updatedAt: Date.now(),
	};
	try {
		fs.mkdirSync(agentsDir, { recursive: true });
		const file = reportedFile(agentsDir, parentId);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(value), "utf-8");
		fs.renameSync(tmp, file);
	} catch {
		// Best effort, like the other sidecars.
	}
}

/**
 * Claim the right to emit ONE wake for an episode, atomically.
 *
 * The settle branch is read-test-write on the arm with no lock: several
 * processes sweeping the same settled episode all saw `armed:true,
 * signature:null`, all passed that test, and all emitted -- six concurrent
 * sweeps produced eight runs for a single wake, while the arm still recorded
 * `wakes: 1`.
 *
 * `O_EXCL` creation is the atomic primitive: exactly one caller creates the
 * claim file per episode, so exactly one emits. Stale claims are bounded by
 * removing the file once its episode has been recorded in the arm.
 */
export function claimEpisodeWake(
	agentsDir: string,
	parentId: string,
	episode: number,
): boolean {
	const file = path.join(agentsDir, `${parentId}.wake-claim-${episode}`);
	try {
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(file, String(process.pid), { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		// A claim from a process that is gone is a leak, not a competing emit:
		// nothing released it (crash or throw between claim and release), and
		// leaving it would block this episode number forever. Take it over, but
		// only when its owner is provably dead, so a slow live emitter keeps its
		// claim.
		let holder = NaN;
		try {
			holder = Number(fs.readFileSync(file, "utf-8").trim());
		} catch {
			return false;
		}
		if (!Number.isSafeInteger(holder) || holder <= 0) return false;
		// Holding it ourselves is not a leak: we already emitted for this
		// episode, so a second attempt must be refused.
		if (holder === process.pid) return false;
		// A live holder keeps its claim; only a provably dead one is reclaimed.
		if (pidAlive(holder)) return false;
		try {
			fs.writeFileSync(file, String(process.pid));
			return true;
		} catch {
			return false;
		}
	}
}

/** True when this pid names a live process. */
function pidAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Release the claim once the arm records the episode as answered. */
export function releaseEpisodeClaim(
	agentsDir: string,
	parentId: string,
	episode: number,
): void {
	try {
		fs.rmSync(
			path.join(agentsDir, `${parentId}.wake-claim-${episode}`),
			{ force: true },
		);
	} catch {
		// ignore
	}
}

/**
 * Release every episode claim belonging to a parent.
 *
 * Called when the arming record itself is pruned: the arm is what carries the
 * episode number, so once it is gone the numbering restarts at 1 and a claim
 * naming an already-used number would silently suppress a real wake. A crash
 * between claim and release can also leave a claim behind with no arm to ever
 * clear it, since `releaseEpisodeClaim` is only reached from the emit path.
 */
export function releaseAllEpisodeClaims(
	agentsDir: string,
	parentId: string,
): void {
	const prefix = `${parentId}.wake-claim-`;
	let names: string[] = [];
	try {
		names = fs.readdirSync(agentsDir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		try {
			fs.rmSync(path.join(agentsDir, name), { force: true });
		} catch {
			// Best effort: a stale claim is reclaimed by a dead owner.
		}
	}
}
