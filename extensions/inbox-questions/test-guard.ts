/**
 * Refuse to run against real state.
 *
 * Ad-hoc scripts that import this module without a scratch `JIRA_AUTOPILOT_STATE`
 * write into the user's live question queue. That already happened twice: an
 * inline test marked real questions answered with a throwaway value, and the
 * queue silently lost them.
 *
 * Tests import this FIRST; it points every source at a throwaway directory.
 * Outside tests nothing changes, because this module is only imported by tests.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function isolateState(): { home: string; restore: () => void } {
	const home = mkdtempSync(join(tmpdir(), "pi-questions-guard-"));
	const keys = [
		"JIRA_AUTOPILOT_STATE",
		"PR_AUTOPILOT_STATE",
		"PI_QUESTIONS_DIRS",
	] as const;
	const saved = new Map<string, string | undefined>();
	for (const k of keys) {
		saved.set(k, process.env[k]);
		delete process.env[k];
	}
	// Point BOTH producers at the scratch dir. Leaving PR_AUTOPILOT_STATE unset
	// meant a live pr-review question leaked into test counts.
	process.env.JIRA_AUTOPILOT_STATE = home;
	process.env.PR_AUTOPILOT_STATE = join(home, "pr");
	return {
		home,
		restore() {
			for (const k of keys) {
				const v = saved.get(k);
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		},
	};
}

/** True when the resolved state dir is inside the system temp dir. */
export function stateIsIsolated(): boolean {
	const dir = process.env.JIRA_AUTOPILOT_STATE ?? "";
	return dir.startsWith(tmpdir());
}
