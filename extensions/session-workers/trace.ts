import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Flag file that turns tracing on. Created by hand; see `tracing()`. */
export const TRACE_FLAG = ".wake-trace-on";

/**
 * Opt-in tracing for the wake path, off unless a flag FILE exists.
 *
 * File, not an env var, because a launcher wrapper may not carry the shell's
 * exports into the process, so `PI_WAKE_TRACE=1` in a terminal is not something
 * the running pi would see. A file is reachable however the process was started.
 *
 * The failure this exists to explain: a follow-up run can be killed with zero
 * tokens before any model call happens, and the only way to tell whether wake
 * caused it is to see run start/end timestamps next to the delivery decision.
 * Reasoning about that from transcripts alone has already produced two wrong
 * diagnoses, so record it instead.
 *
 * Enable:  touch ~/.pi/agent/.wake-trace-on
 * Disable: rm ~/.pi/agent/.wake-trace-on
 *
 * One JSON line per event, appended to `<agent dir>/wake-trace.jsonl`. Writes are
 * best-effort and never throw: tracing must not be able to break the wake path.
 */
export function tracing(): boolean {
	try {
		return fs.existsSync(path.join(getAgentDir(), TRACE_FLAG));
	} catch {
		return false;
	}
}


const MAX_BYTES = 4 * 1024 * 1024;

function traceFile(): string {
	return path.join(getAgentDir(), "wake-trace.jsonl");
}

export function trace(
	event: string,
	fields: Record<string, unknown> = {},
): void {
	if (!tracing()) return;
	try {
		const file = traceFile();
		// Keep it bounded: this is a debugging aid, not a log sink.
		try {
			if (fs.statSync(file).size > MAX_BYTES) {
				fs.renameSync(file, `${file}.1`);
			}
		} catch {
			// Missing file on first write is the normal case.
		}
		fs.appendFileSync(
			file,
			`${JSON.stringify({
				at: new Date().toISOString(),
				pid: process.pid,
				event,
				...fields,
			})}\n`,
			"utf-8",
		);
	} catch {
		// Never let tracing break the caller.
	}
}
