import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkerLink {
	id: string;
	parentId: string;
	createdAt: number;
}

function validId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[a-z0-9](?:[a-z0-9_.-]{0,126}[a-z0-9])?$/i.test(value)
	);
}

function validLink(value: unknown): value is WorkerLink {
	if (!value || typeof value !== "object") return false;
	const link = value as WorkerLink;
	return (
		validId(link.id) &&
		validId(link.parentId) &&
		link.id !== link.parentId &&
		Number.isFinite(link.createdAt) &&
		link.createdAt >= 0
	);
}

function compareLinks(a: WorkerLink, b: WorkerLink): number {
	return (
		a.createdAt - b.createdAt ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
		(a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0)
	);
}

/** Read-only metadata: never import the worker runner or start supervisors. */
export function readWorkerLinks(agentDir: string): WorkerLink[] {
	const dir = path.join(agentDir, "session-workers", "workers");
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const links: WorkerLink[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const value: unknown = JSON.parse(
				fs.readFileSync(path.join(dir, name), "utf8"),
			);
			if (validLink(value) && value.id === name.slice(0, -5)) {
				links.push({
					id: value.id,
					parentId: value.parentId,
					createdAt: value.createdAt,
				});
			}
		} catch {
			// A missing, partial, or malformed record must not break the inbox.
		}
	}
	return links.sort(compareLinks);
}

export interface FamilyItem<T> {
	row: T;
	parentId?: string;
	child: boolean;
	lastChild: boolean;
	children: T[];
	expanded: boolean;
	contextOnly: boolean;
}

/** Project a one-level hierarchy without changing rows or saved fold state. */
export function projectFamilies<T>(
	allRows: T[],
	eligibleRows: T[],
	links: WorkerLink[],
	options: {
		id: (row: T) => string;
		expanded: ReadonlySet<string>;
		forceExpand?: boolean;
	},
): FamilyItem<T>[] {
	const rows = new Map(allRows.map((row) => [options.id(row), row]));
	const eligible = new Map<string, T>();
	for (const row of eligibleRows) {
		const id = options.id(row);
		if (!eligible.has(id)) {
			eligible.set(id, row);
			rows.set(id, row);
		}
	}
	const relations = new Map<string, WorkerLink>();
	for (const link of links.filter(validLink).sort(compareLinks)) {
		if (
			rows.has(link.id) &&
			rows.has(link.parentId) &&
			!relations.has(link.id)
		)
			relations.set(link.id, link);
	}
	const parentOf = new Map<string, string>();
	const children = new Map<string, T[]>();
	for (const [id, link] of relations) {
		// Refuse deeper nesting and cycles rather than inventing an ancestor.
		if (relations.has(link.parentId) || !eligible.has(id)) continue;
		parentOf.set(id, link.parentId);
		const siblings = children.get(link.parentId) ?? [];
		siblings.push(eligible.get(id) as T);
		children.set(link.parentId, siblings);
	}
	const result: FamilyItem<T>[] = [];
	const emitted = new Set<string>();
	const emitRoot = (id: string) => {
		if (emitted.has(id)) return;
		emitted.add(id);
		const family = children.get(id) ?? [];
		const expanded =
			family.length > 0 &&
			(!!options.forceExpand || options.expanded.has(id));
		result.push({
			row: rows.get(id) as T,
			child: false,
			lastChild: false,
			children: family,
			expanded,
			contextOnly: !eligible.has(id),
		});
		if (!expanded) return;
		for (const [index, row] of family.entries()) {
			emitted.add(options.id(row));
			result.push({
				row,
				parentId: id,
				child: true,
				lastChild: index === family.length - 1,
				children: [],
				expanded: false,
				contextOnly: false,
			});
		}
	};
	for (const id of eligible.keys()) {
		const parent = parentOf.get(id);
		if (!parent) emitRoot(id);
		else if (!eligible.has(parent)) emitRoot(parent);
	}
	return result;
}

/** Separate preferences prevent legacy inbox writers from dropping folds. */
export class WorkerFolds {
	readonly file: string;

	constructor(agentDir: string) {
		this.file = path.join(agentDir, "inbox-worker-folds.json");
	}

	load(): Set<string> {
		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return new Set();
			}
			throw error;
		}
		const data = JSON.parse(raw);
		if (
			data?.version !== 1 ||
			!Array.isArray(data.expanded) ||
			!data.expanded.every(validId)
		) {
			throw new Error("Invalid inbox-worker-folds.json");
		}
		return new Set(data.expanded);
	}

	private recoverStaleLock(lock: string): void {
		const recovery = `${lock}.recover`;
		try {
			fs.mkdirSync(recovery);
		} catch {
			return;
		}
		try {
			if (Date.now() - fs.statSync(lock).mtimeMs <= 30_000) return;
			const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
			if (!Number.isSafeInteger(pid) || pid <= 0) return;
			try {
				process.kill(pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					fs.rmSync(lock, { recursive: true, force: true });
				}
			}
		} catch {
			// Another writer may have released the lock during recovery.
		} finally {
			fs.rmSync(recovery, { recursive: true, force: true });
		}
	}

	/** Lock the full read/modify/write, not just the atomic file replacement. */
	setExpanded(id: string, expanded: boolean): void {
		if (!validId(id)) throw new Error("Expected a session id");
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const lock = `${this.file}.lock`;
		const deadline = Date.now() + 2500;
		const sleeper = new Int32Array(new SharedArrayBuffer(4));
		for (;;) {
			try {
				fs.mkdirSync(lock);
				try {
					fs.writeFileSync(
						path.join(lock, "pid"),
						String(process.pid),
					);
				} catch (error) {
					fs.rmSync(lock, { recursive: true, force: true });
					throw error;
				}
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw error;
				}
				this.recoverStaleLock(lock);
				if (Date.now() >= deadline) {
					throw new Error("Worker folds are busy; try again");
				}
				Atomics.wait(sleeper, 0, 0, 20);
			}
		}
		const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const ids = this.load();
			if (expanded) ids.add(id);
			else ids.delete(id);
			fs.writeFileSync(
				tmp,
				`${JSON.stringify({
					version: 1,
					expanded: [...ids].sort(),
				})}\n`,
				{ flag: "wx", mode: 0o600 },
			);
			fs.renameSync(tmp, this.file);
		} finally {
			fs.rmSync(tmp, { force: true });
			fs.rmSync(lock, { recursive: true, force: true });
		}
	}
}
