/**
 * Which pi-kit extensions are actually loaded in this pi process.
 *
 * Selective installs (install.sh --extensions …, or pi config) can exclude
 * individual extensions. compat-check must not warn about Pi internals
 * breakage for extensions that were deliberately not loaded, so every pi-kit
 * extension reports itself here when its factory runs.
 *
 * Mechanics: pi's loader imports each extension with moduleCache:false, so
 * every importer gets a fresh evaluation of this file — a module-level Set
 * would not be shared. State therefore lives on globalThis (same convention
 * as the other pi-kit symbols), with a monotonically increasing version tag
 * per evaluation. Registrations made after the last finalized pass make up
 * the current pass. finalizeLoadPass() is idempotent within a load and is
 * order-safe: any extension may call it and see every extension that has
 * registered so far in this pass (factories all run before any event fires,
 * so by the time compat-check's session_start / /compat runs, the set is
 * complete). On /reload every module re-evaluates: tags bump, excluded
 * extensions never register again, and their stale entries age out of the
 * pass.
 *
 * If compat-check itself is excluded, nothing reads the registry; the
 * shared state is harmless.
 */

interface LoadState {
	/** extension name -> version tag of the module instance that last registered it */
	reg: Map<string, number>;
	/** monotonic counter; bumped once per evaluation of this file */
	version: number;
	/** value of `version` when the pass was last finalized */
	passEnd: number;
	/** result of the most recent finalizeLoadPass() */
	currentPass: Set<string>;
}

const KEY = Symbol.for("pi-kit.loaded-extensions");
const G = globalThis as Record<symbol, LoadState | undefined>;
const S = (G[KEY] ??= { reg: new Map(), version: 0, passEnd: 0, currentPass: new Set() });
const MY_VERSION = ++S.version;

export function registerLoadedExtension(name: string): void {
	S.reg.set(name, MY_VERSION);
}

/**
 * Collect registrations made since the previous pass. Safe to call any time
 * after extension factories have run (session_start, slash commands);
 * repeated calls within one load return the same set.
 */
export function finalizeLoadPass(): ReadonlySet<string> {
	if (S.version > S.passEnd) {
		const pass = new Set<string>();
		for (const [name, tag] of S.reg) {
			if (tag > S.passEnd) pass.add(name);
		}
		S.passEnd = S.version;
		S.currentPass = pass;
	}
	return S.currentPass;
}

export function getLoadedExtensions(): ReadonlySet<string> {
	return S.currentPass;
}
