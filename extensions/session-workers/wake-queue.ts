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

interface WakeRequest {
	v: 1;
	parentId: string;
	signature: string;
	content: string;
	createdAt: number;
	/** Bumped by every writer so a consumer can tell a newer request exists. */
	nonce: string;
}

function requestFile(agentsDir: string, parentId: string): string {
	return path.join(agentsDir, `${parentId}.wake`);
}

/**
 * Record a pending wake for a parent whose owning process may already be gone.
 * Last writer wins: the newest signature is the one worth delivering.
 */
export function writeWakeRequest(
	agentsDir: string,
	request: { parentId: string; signature: string; content: string },
): void {
	const value: WakeRequest = {
		v: 1,
		parentId: request.parentId,
		signature: request.signature,
		content: request.content,
		createdAt: Date.now(),
		nonce: `${process.pid}-${Date.now()}`,
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
	try {
		fs.rmSync(file, { force: true });
		return true;
	} catch {
		return false;
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
