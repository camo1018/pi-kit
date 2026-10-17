import { sessionGroup, type GroupStore } from "./groups.ts";

export interface GroupSection<T> {
	name: string;
	groupId?: string;
	rows: T[];
}

/** Group a filtered/sorted list, preserving order within each group. */
export function sectionByGroup<T>(
	rows: T[],
	store: GroupStore,
	sessionId: (row: T) => string,
): GroupSection<T>[] {
	const buckets = new Map<string | undefined, T[]>();
	for (const row of rows) {
		const id = sessionGroup(store, sessionId(row))?.id;
		const bucket = buckets.get(id);
		if (bucket) bucket.push(row);
		else buckets.set(id, [row]);
	}
	const sections: GroupSection<T>[] = [];
	for (const group of store.groups.slice().sort(
		(a, b) => a.name.localeCompare(b.name),
	)) {
		const rows = buckets.get(group.id);
		if (rows?.length) {
			sections.push({ groupId: group.id, name: group.name, rows });
		}
	}
	const ungrouped = buckets.get(undefined);
	if (ungrouped?.length) {
		sections.push({ name: "Ungrouped", rows: ungrouped });
	}
	return sections;
}
