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

/**
 * One directory's worth of cached links, validated on the directory's own stamp.
 *
 * Every write to `session-workers/workers` goes through `writeJson`, which writes
 * a temp file and renames it into place. A rename creates a new directory entry,
 * which bumps the directory's mtime — verified for the hard case too (rewriting
 * the same file with identical-length content still moves it). That is what makes
 * the directory stamp a sound invalidation key here, and it is the reason this
 * does not need to stat the records themselves: an in-place rewrite, which would
 * slip past a directory stamp, is exactly what `writeJson` never does.
 */
interface LinkCacheEntry {
	mtimeMs: number;
	entries: number;
	links: WorkerLink[];
}

/** Keyed by `agentDir`: tests and the preview run against temporary agent dirs. */
const linkCache = new Map<string, LinkCacheEntry>();

/**
 * Read-only metadata: never import the worker runner or start supervisors.
 *
 * Cached on the directory stamp. These records only change when a worker is
 * spawned, renamed, or settled, but the inbox re-read and re-parsed all of them
 * on every 2.5s refresh — `loadRows` and `refresh` each called this separately,
 * so ~150 files were parsed twice per tick, ~3ms a time, 44% of a warm refresh.
 * Replacing it with a `statSync` of the directory plus a `readdirSync` for the
 * entry count costs ~0.07ms.
 *
 * The entry count is checked as well as the mtime because the two failure modes
 * differ: adding or removing a record changes the count, while rewriting an
 * existing one changes only the mtime.
 *
 * Returns the cached array directly rather than a copy: it is shared by every
 * caller in this process, so treat it as read-only. (`projectFamilies` sorts a
 * `.filter()` of it, which is a fresh array, so nothing mutates it today.)
 */
export function readWorkerLinks(agentDir: string): WorkerLink[] {
	const dir = path.join(agentDir, "session-workers", "workers");
	let names: string[];
	let dirStat: fs.Stats;
	// Stat BEFORE listing, not after. Two writers racing this read could otherwise
	// leave us caching a stamp taken after a change whose records we listed before
	// it — the cache would then look valid while holding the pre-change listing.
	// Statting first can only cost a redundant re-read, never a stale hit.
	try {
		dirStat = fs.statSync(dir);
		names = fs.readdirSync(dir);
	} catch {
		linkCache.delete(agentDir);
		return [];
	}
	const cached = linkCache.get(agentDir);
	if (
		cached &&
		cached.mtimeMs === dirStat.mtimeMs &&
		cached.entries === names.length
	)
		return cached.links;
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
	const sorted = links.sort(compareLinks);
	linkCache.set(agentDir, {
		mtimeMs: dirStat.mtimeMs,
		entries: names.length,
		links: sorted,
	});
	return sorted;
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
