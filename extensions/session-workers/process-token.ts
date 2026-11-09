/**
 * Identity of this pi process, stable for its lifetime.
 *
 * A pid alone cannot answer "is the process that recorded this still the same
 * process": pids are recycled, and macOS wraps in the low tens of thousands. A
 * recycled pid belonging to another pi would match an `ownerPid ===
 * process.pid` check and let it claim and wake an unrelated parent. Pairing the
 * pid with a value generated once per process makes a recycled pid fail the
 * match, because the new process has its own token.
 *
 * Kept in its own module because `wake.ts` imports `workers.ts` for types only;
 * sharing this through either of them would create a cycle.
 */
/**
 * Anchored on `globalThis`, not a module-level constant: the extension loader
 * re-evaluates modules on `/reload` (`moduleCache: false`), so a plain const
 * would be regenerated and an in-flight team's arm would suddenly name a token
 * this process no longer matches -- losing ownership of its own team until a
 * new spawn rewrote it.
 */
const KEY = Symbol.for("pi.session-workers.processToken");

function token(): string {
	const g = globalThis as unknown as Record<symbol, string | undefined>;
	g[KEY] ??= `${process.pid}-${Math.random().toString(36).slice(2)}`;
	return g[KEY];
}

export const PROCESS_TOKEN = token();

/**
 * True when a recorded owner names THIS process.
 *
 * A record carrying a token must match it exactly. One with no token predates
 * the field and falls back to the pid alone.
 */
export function isOwnProcess(
	pid: number | undefined,
	token: string | undefined,
): boolean {
	if (pid !== process.pid) return false;
	return token === undefined || token === PROCESS_TOKEN;
}
