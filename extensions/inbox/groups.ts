import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface InboxGroup {
	id: string;
	name: string;
	templateEnabled: boolean;
	template: string;
}

export interface GroupStore {
	version: 1;
	groups: InboxGroup[];
	sessions: Record<string, string>;
	/** Persistent fallback used when viewing All groups. */
	defaultGroupId?: string;
	/** Persisted All-groups list layout: grouped sections ("groups") or flat ("flat"). */
	layout?: "flat" | "groups";
}

export type GroupScope = "all" | "ungrouped" | string;

export interface GroupCounts {
	active: number;
	total: number;
}

export function emptyGroups(): GroupStore {
	return { version: 1, groups: [], sessions: {} };
}

export function sessionGroup(store: GroupStore, id: string) {
	const groupId = Object.hasOwn(store.sessions, id)
		? store.sessions[id]
		: undefined;
	return store.groups.find((group) => group.id === groupId);
}

export function defaultGroup(store: GroupStore) {
	return store.groups.find((group) => group.id === store.defaultGroupId);
}

export function newAgentGroupForScope(store: GroupStore, scope: GroupScope) {
	if (scope === "all") return defaultGroup(store)?.id;
	if (scope === "ungrouped") return undefined;
	return store.groups.find((group) => group.id === scope)?.id;
}

export function inGroup(store: GroupStore, scope: GroupScope, id: string) {
	const group = sessionGroup(store, id);
	return scope === "all" || (scope === "ungrouped"
		? !group
		: group?.id === scope);
}

export function groupLabel(store: GroupStore, scope: GroupScope) {
	if (scope === "all") return "All groups";
	return store.groups.find((group) => group.id === scope)?.name
		?? "Ungrouped";
}

export function countGroupSessions(
	groups: InboxGroup[],
	groupSessions: Record<string, string>,
	activeIds: Set<string>,
	allExistingIds: Set<string>,
): Map<string, GroupCounts> {
	const counts = new Map<string, GroupCounts>();
	for (const g of groups) {
		counts.set(g.id, { active: 0, total: 0 });
	}
	for (const [sessionId, groupId] of Object.entries(groupSessions)) {
		const c = counts.get(groupId);
		if (!c) continue;
		if (allExistingIds.has(sessionId)) {
			c.total++;
			if (activeIds.has(sessionId)) {
				c.active++;
			}
		}
	}
	return counts;
}

/** Only replace an empty draft or the exact, untouched previous prefill. */
export function templateDraft(
	draft: string,
	previous: string | undefined,
	template: string,
) {
	return !draft || (previous !== undefined && draft === previous)
		? template
		: draft;
}

/** Separate from inbox.json so older Pi windows cannot discard group data. */
export class InboxGroups {
	readonly file: string;

	constructor(agentDir: string) {
		this.file = path.join(agentDir, "inbox-groups.json");
	}

	load(): GroupStore {
		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return emptyGroups();
			}
			throw error;
		}
		const data = JSON.parse(raw);
		if (
			data?.version !== 1 || !Array.isArray(data.groups) ||
			!data.sessions || typeof data.sessions !== "object" ||
			Array.isArray(data.sessions)
		) throw new Error("Invalid inbox-groups.json; refusing to overwrite it");
		const ids = new Set<string>();
		const names = new Set<string>();
		for (const group of data.groups) {
			if (
				!group || typeof group.id !== "string" || !group.id ||
				["all", "ungrouped"].includes(group.id) || ids.has(group.id) ||
				typeof group.name !== "string" || !group.name.trim() ||
				typeof group.template !== "string" ||
				typeof group.templateEnabled !== "boolean"
			) throw new Error("Invalid group in inbox-groups.json");
			this.checkName(group.name, names);
			ids.add(group.id);
			names.add(group.name.trim().toLowerCase());
		}
		if (Object.values(data.sessions).some((id) => typeof id !== "string")) {
			throw new Error("Invalid membership in inbox-groups.json");
		}
		if (data.defaultGroupId !== undefined &&
			(typeof data.defaultGroupId !== "string" || !data.defaultGroupId)) {
			throw new Error("Invalid default group in inbox-groups.json");
		}
		if (data.layout !== undefined &&
			data.layout !== "flat" && data.layout !== "groups") {
			throw new Error("Invalid layout in inbox-groups.json");
		}
		// Older windows may delete a group without clearing its default id.
		// defaultGroup() treats a stale id as Ungrouped rather than failing.
		return data;
	}

	private checkName(name: string, names: Set<string>) {
		const key = name.trim().toLowerCase();
		if (!key || /[\r\n\x00-\x1f\x7f]/.test(name)) {
			throw new Error("Group names must be nonempty, single-line text");
		}
		if (["all groups", "ungrouped"].includes(key) || names.has(key)) {
			throw new Error("That group name is already in use or reserved");
		}
	}

	private required(store: GroupStore, id: string) {
		const group = store.groups.find((group) => group.id === id);
		if (!group) throw new Error("That group no longer exists");
		return group;
	}

	private recoverStaleLock(lock: string) {
		const recovery = `${lock}.recover`;
		try {
			fs.mkdirSync(recovery);
		} catch {
			return;
		}
		try {
			// Serialize reclaimers, then re-check age/owner under that guard.
			// Otherwise two reclaimers could delete a freshly acquired lock.
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
			// A competing writer may already have released the lock.
		} finally {
			fs.rmSync(recovery, { recursive: true, force: true });
		}
	}

	/** Serialize cross-window RMWs; atomic rename alone doesn't prevent loss. */
	private async mutate<T>(change: (store: GroupStore) => T): Promise<T> {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const lock = `${this.file}.lock`;
		const deadline = Date.now() + 2500;
		for (;;) {
			try {
				fs.mkdirSync(lock);
				try {
					fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
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
					throw new Error("Groups are busy in another window; try again");
				}
				await delay(20);
			}
		}
		const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const store = this.load();
			const result = change(store);
			fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
			fs.renameSync(tmp, this.file);
			return result;
		} finally {
			fs.rmSync(tmp, { force: true });
			fs.rmSync(lock, { recursive: true, force: true });
		}
	}

	create(name: string) {
		return this.mutate((store) => {
			this.checkName(name, new Set(store.groups.map(
				(group) => group.name.toLowerCase(),
			)));
			const group: InboxGroup = {
				id: randomUUID(), name: name.trim(),
				templateEnabled: false, template: "",
			};
			store.groups.push(group);
			return group;
		});
	}

	rename(id: string, name: string) {
		return this.mutate((store) => {
			const group = this.required(store, id);
			this.checkName(name, new Set(store.groups
				.filter((item) => item.id !== id)
				.map((item) => item.name.toLowerCase())));
			group.name = name.trim();
		});
	}

	setTemplate(id: string, template: string, enabled: boolean) {
		return this.mutate((store) => {
			const group = this.required(store, id);
			group.template = template;
			group.templateEnabled = enabled;
		});
	}

	setLayout(layout: "flat" | "groups") {
		return this.mutate((store) => {
			store.layout = layout;
		});
	}

	setDefaultGroup(id?: string) {
		return this.mutate((store) => {
			if (id) {
				this.required(store, id);
				store.defaultGroupId = id;
			} else delete store.defaultGroupId;
			return id;
		});
	}

	toggleTemplate(id: string) {
		return this.mutate((store) => {
			const group = this.required(store, id);
			group.templateEnabled = !group.templateEnabled;
			return { ...group };
		});
	}

	saveTemplate(id: string, template: string) {
		return this.mutate((store) => {
			const group = this.required(store, id);
			group.template = template;
			return { ...group };
		});
	}

	remove(id: string) {
		return this.mutate((store) => {
			this.required(store, id);
			store.groups = store.groups.filter((group) => group.id !== id);
			if (store.defaultGroupId === id) delete store.defaultGroupId;
			for (const [session, group] of Object.entries(store.sessions)) {
				if (group === id) delete store.sessions[session];
			}
		});
	}

	assign(sessionId: string, groupId?: string) {
		return this.mutate((store) => {
			if (groupId) {
				this.required(store, groupId);
				Object.defineProperty(store.sessions, sessionId, {
					value: groupId, enumerable: true, configurable: true,
					writable: true,
				});
			} else delete store.sessions[sessionId];
		});
	}
}
